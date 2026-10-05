// lib/refundService.js — 交易取消／子單退費 分段狀態機（唯一入口）
// 第一段交易：鎖列重驗 → 回收權益（錢包／庫存／效期／合約）→ 建 RefundRequest＋退款腿（現金／零錢包當場完成）→ 稽核
// 交易外：LINE Pay／PayUNi 退款 → 乙禾端末退貨確認 → ezPay 作廢／折讓 →（B2B 顧客簽名）→ 結案
// 外部金流一律不在 DB 交易內呼叫；任一外部管道已退款即不可中止（避免吞款）
import crypto from 'node:crypto';
import prisma from './prisma.js';
import { assertBranchAccess, canAccessBranch, hasDutyRankOrAbove, isCrossBranchUser, staffBranchIds } from './staffAccess.js';
import { isUniqueViolation, lockMemberRow } from './dbLocks.js';
import { WALLET_MODE, WALLET_TX, mutateMemberWallet } from './walletMutation.js';
import { applyStockDelta } from './inventory.js';
import { tracksInventory } from './productKind.js';
import { SHIFT_NOT_OPEN_MESSAGE, getOpenShift, lockOpenShiftForSale } from './shiftHandover.js';
import { refundLinePayPayment } from './linepay.js';
import { refundPayuniTrade } from './payuni.js';
import { allowanceEInvoice, releaseHeldAllowance, settleHeldAllowance, voidEInvoice, writeEInvoiceLog } from './einvoice.js';
import { allocateInteger, decideInvoiceActions, normalizeTaxType } from './einvoiceRules.js';
import {
  OPEN_REFUND_STATUSES,
  allocateInstallmentRefund,
  assertTopupVoidable,
  canAbortRefund,
  computeCourseInstallmentRefund,
  computePtRefund,
  computeSaleReturnLines,
  computeTimedTopupRefund,
  normalizeBreakdown,
  hasPendingYipayTerminal,
  normalizeOverrideFee,
  normalizeTerminationClause,
  paymentPhaseStatus,
  ptContractExpiresAt,
  splitRefundLegs,
  withinCoolingOff,
} from './refundRules.js';
import { addPaymentDebt } from './paymentDebt.js';
import { buildCutExpireNow, isUnlimitedTopupOrder, remainingExpireDays, shiftDateByDays } from './promotion.js';
import {
  computeMonthlyCardRefundDetail,
  findLatestPaidOrderForSubscription,
  resolveUnlimitedOrderPeriodDays,
} from './subscriptionSettle.js';
import { cancelCardSubscription } from './cardSubscription.js';
import { normalizeBuyerEmail } from './invoiceAllowance.js';
import { clientIp } from './memberDeviceAudit.js';
import { readToken, sha256Hex, signToken } from './signedToken.js';

const AMBIGUOUS_TAG = '[待確認]';
const ONLINE_METHODS = ['LINEPAY', 'PAYUNI'];

const YIPAY_TERMINAL_BLOCK = '乙禾端末尚未刷退回填 RRN／授權碼，不可開立折讓或結案';

async function assertYipayTerminalSettled(db, refundId) {
  const legs = await db.refundPayment.findMany({
    where: { refundId },
    select: { method: true, status: true, rrn: true, authCode: true },
  });
  if (hasPendingYipayTerminal(legs)) throw httpError(409, 'YIPAY_TERMINAL_VOUCHER_REQUIRED', YIPAY_TERMINAL_BLOCK);
}

const twDateLabel = (iso) => new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function genId(prefix) {
  const d = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  return `${prefix}${d}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

const ntd = (n) => Math.round(Number(n) || 0);

export function normalizeRefundReason(raw) {
  const s = String(raw ?? '').trim();
  if (s.length < 2) throw httpError(400, 'REASON_REQUIRED', '請填寫退費原因（至少 2 字）');
  return s.slice(0, 200);
}

/** 同一退費單同時只允許一個推進流程（外部呼叫冪等另靠退款腿條件式搶占） */
const inFlight = new Set();
async function withRefundLock(id, fn, { busyCode = 'REFUND_IN_PROGRESS', busyMessage = '此退費單處理中，請稍候再試' } = {}) {
  if (inFlight.has(id)) throw httpError(409, busyCode, busyMessage);
  inFlight.add(id);
  try {
    return await fn();
  } finally {
    inFlight.delete(id);
  }
}

const RETRYABLE_STATUSES = ['PAYMENT_PENDING', 'PAYMENT_FAILED', 'INVOICE_PENDING', 'INVOICE_FAILED', 'SIGNATURE_PENDING'];
/** 認領後若行程死亡，超過此時間才允許下一個人接手（期間第二個請求 409） */
const GATEWAY_CLAIM_STALE_MS = 90_000;
const RETRY_BUSY = '該筆退費單正在執行重試同步中，請勿重複點擊';

function isPgLockBusy(err) {
  const codes = [err?.code, err?.meta?.code, err?.meta?.driverAdapterError?.cause?.originalCode, err?.meta?.driverAdapterError?.cause?.code];
  const msg = `${err?.message || ''} ${err?.meta?.message || ''}`;
  return codes.includes('55P03') || /could not obtain lock|lock not available/i.test(msg);
}

/** 短交易鎖退費單。NOWAIT：第二個請求不等待、立刻 409。呼叫端必須在交易結束後才打外部 API。 */
async function lockRefundRow(tx, id) {
  try {
    const rows = await tx.$queryRaw`
      SELECT id, status, reason, "updatedAt"
      FROM "RefundRequest"
      WHERE id = ${id}
      FOR UPDATE NOWAIT
    `;
    return rows[0] ?? null;
  } catch (err) {
    if (isPgLockBusy(err)) throw httpError(409, 'REFUND_RETRY_IN_PROGRESS', RETRY_BUSY);
    throw err;
  }
}

async function assertRefundIdle(tx, id) {
  const row = await lockRefundRow(tx, id);
  if (row?.status === 'GATEWAY_RETRYING') throw httpError(409, 'REFUND_RETRY_IN_PROGRESS', RETRY_BUSY);
  return row;
}

async function writeAudit(db, { action, refund = null, refType = null, refId = null, user, req, reason = null, before = null, after = null }) {
  await db.transactionAuditLog.create({
    data: {
      action,
      refundId: refund?.id ?? null,
      refType: refund?.refType ?? refType,
      refId: refund?.refId ?? refId,
      staffId: user?.id ?? null,
      staffRole: user?.role ?? null,
      branchId: refund?.branchId ?? null,
      reason,
      before: before ?? undefined,
      after: after ?? undefined,
      clientIp: req ? clientIp(req) : null,
    },
  });
}

// ─────────────────────────────────────────────────────────────
// 子單載入與分類
// ─────────────────────────────────────────────────────────────

/** TOPUP 計時儲值｜MEMBERSHIP 月卡／訂閱｜PT 私教｜GROUP 團課｜COURSE_SUB 課程定期定額｜OTHER */
export function classifyOrder(order) {
  const desc = String(order.itemDesc || '');
  if (String(order.id).startsWith('GRP')) return 'GROUP';
  // 課程分期首期訂單亦連結合約，須先於 PT 判定
  if (desc.includes('課程定期定額')) return 'COURSE_SUB';
  if (order.ptContract || desc.startsWith('私教購案')) return 'PT';
  if (isUnlimitedTopupOrder(desc)) return 'MEMBERSHIP';
  if (desc.includes('| TIMED |')) return 'TOPUP';
  return 'OTHER';
}

async function resolveRefundBranchId(db, order, session) {
  if (order.branchId) return order.branchId;
  if (session?.branchId) return session.branchId;
  const promo = String(order.itemDesc || '').match(/商品#(\d+)/);
  if (promo) {
    const p = await db.promotion.findUnique({ where: { id: parseInt(promo[1], 10) }, select: { branchId: true } });
    if (p?.branchId) return p.branchId;
  }
  return null;
}

function normalizeSubOrderId(raw) {
  const id = String(raw || '').trim().toUpperCase();
  if (!id) throw httpError(400, 'SUB_ORDER_REQUIRED', '請提供子單號（SAL／TYK／CRS…）');
  if (id.startsWith('CHK')) {
    throw httpError(400, 'USE_SUB_ORDER', '合併結帳不可整筆退費，請指定子單號（SAL／TYK／CRS…）');
  }
  return id;
}

async function loadTarget(db, subOrderId) {
  const id = normalizeSubOrderId(subOrderId);
  if (id.startsWith('SAL')) {
    const sale = await db.saleOrder.findUnique({
      where: { id },
      include: {
        items: { orderBy: { id: 'asc' }, include: { product: { select: { productKind: true } } } },
        member: { select: { id: true, name: true } },
      },
    });
    if (!sale) throw httpError(404, 'SUB_ORDER_NOT_FOUND', '找不到此銷貨單');
    const session = sale.checkoutSessionId
      ? await db.checkoutSession.findUnique({ where: { id: sale.checkoutSessionId } })
      : null;
    return {
      refType: 'SALE',
      id,
      kind: 'SALE',
      row: sale,
      session,
      branchId: sale.branchId,
      memberId: sale.memberId ?? null,
      memberName: sale.member?.name || null,
      amount: ntd(sale.amount),
      refundedAmount: sale.refundedAmount || 0,
      status: sale.status,
    };
  }
  const order = await db.order.findUnique({
    where: { id },
    include: { member: { select: { id: true, name: true } }, ptContract: true },
  });
  if (!order) throw httpError(404, 'SUB_ORDER_NOT_FOUND', '找不到此訂單');
  const session = order.checkoutSessionId
    ? await db.checkoutSession.findUnique({ where: { id: order.checkoutSessionId } })
    : null;
  return {
    refType: 'ORDER',
    id,
    kind: classifyOrder(order),
    row: order,
    session,
    branchId: await resolveRefundBranchId(db, order, session),
    memberId: order.memberId,
    memberName: order.member?.name || null,
    amount: ntd(order.amount),
    refundedAmount: order.refundedAmount || 0,
    status: order.status,
  };
}

function assertTargetAccess(user, target) {
  if (target.branchId == null) {
    if (isCrossBranchUser(user)) return;
    throw httpError(403, 'BRANCH_UNKNOWN', '⛔ 無法判定單據所屬分店，請洽總部處理');
  }
  assertBranchAccess({ user }, target.branchId);
}

function assertPaid(target) {
  if (target.status === 'PAID') return;
  if (['REFUNDED', 'CANCELLED'].includes(target.status)) {
    throw httpError(409, 'ALREADY_REFUNDED', `單據 ${target.id} 已退費／取消（${target.status}）`);
  }
  throw httpError(409, 'NOT_PAID', `單據 ${target.id} 狀態為 ${target.status}，僅已付款單據可退費`);
}

// ─────────────────────────────────────────────────────────────
// 發票、付款來源
// ─────────────────────────────────────────────────────────────

async function loadRefInvoices(db, target) {
  const closed = ['VOIDED', 'CANCELLED'];
  const own = await db.eInvoice.findMany({
    where: { refType: target.refType, refId: target.id, status: { notIn: closed } },
    include: { items: { orderBy: { lineNo: 'asc' } } },
    orderBy: { leg: 'asc' },
  });
  if (own.length || !target.session) return { invoices: own, shared: false };
  const legacy = await db.eInvoice.findMany({
    where: { refType: 'CHECKOUT', refId: target.session.id, status: { notIn: closed } },
    include: { items: { orderBy: { lineNo: 'asc' } } },
  });
  return { invoices: legacy, shared: legacy.length > 0 };
}

/** 部分退貨僅涉及有退貨品項之稅別分張 */
function relevantInvoices(target, invoices, lines, shared) {
  if (shared || target.refType !== 'SALE' || !lines) return invoices;
  const hasFree = lines.some((l) => normalizeTaxType(l.taxType) === 'TAX_FREE');
  const hasTaxable = lines.some((l) => normalizeTaxType(l.taxType) !== 'TAX_FREE');
  return invoices.filter((inv) => (inv.taxType === '3' ? hasFree : hasTaxable));
}

function paymentSource(target) {
  const src = target.session || target.row;
  return {
    breakdown: normalizeBreakdown(src.payBreakdown, { payMethod: src.payMethod, amount: src.amount }),
    merchantNos: [target.row.merchantNo, target.session?.merchantNo].filter(Boolean).map(String),
  };
}

async function priorRefundedByMethod(db, target) {
  const scope = target.session ? { checkoutSessionId: target.session.id } : { refType: target.refType, refId: target.id };
  const rows = await db.refundPayment.findMany({
    where: { refund: { ...scope, status: { not: 'ABORTED' } }, status: { notIn: ['CANCELLED', 'REVERSED'] } },
    select: { method: true, amount: true },
  });
  const out = {};
  for (const r of rows) out[r.method] = (out[r.method] || 0) + r.amount;
  return out;
}

async function resolveProviderRefs(db, target, merchantNos) {
  const lp = merchantNos.find((n) => n.startsWith('LP:'));
  const payuni = merchantNos.find((n) => !n.startsWith('LP:') && !n.startsWith('YIPAY:'));
  const capture = await db.yipayTerminalCapture.findFirst({
    where: { targetId: { in: [target.id, target.session?.id].filter(Boolean) }, status: 'CONFIRMED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, cardLast4: true },
  });
  return { linePayTxId: lp ? lp.slice(3) : null, payuniTradeNo: payuni || null, yipayCapture: capture };
}

// ─────────────────────────────────────────────────────────────
// 試算（預覽與第一段交易共用；db 可為交易）
// ─────────────────────────────────────────────────────────────

async function findLinkedSubscription(db, orderId) {
  const charge = await db.cardSubscriptionCharge.findFirst({ where: { orderId }, select: { subscriptionId: true } });
  return db.cardSubscription.findFirst({
    where: charge ? { id: charge.subscriptionId } : { originOrderId: orderId },
  });
}

/** 會籍退費前會員須已出場（任何計費模式）：避免退掉會籍後出場無效或逃避計時扣款 */
async function assertNotCheckedIn(db, memberId) {
  const active = await db.checkInLog.findFirst({
    where: { memberId, status: 'ACTIVE', checkOutAt: null },
    select: { id: true },
  });
  if (active) {
    throw httpError(409, 'MEMBER_CHECKED_IN', '會員目前在館內（尚未刷出閘機），請待出場後再辦理會籍退費');
  }
}

/**
 * 月卡退費（契約第八條、第九條第二款）
 * - 始期未屆至（排在現有效期之後）或生效 7 日內未進場 → 全額退（UNUSED 自動升為 FULL）
 * - 其餘依半月制：月均價 × 剩餘期數 − 手續費 $500；已核准請假已延長效期，剩餘天數即扣除暫停天數
 */
async function computeMembership(db, target, scope, now, feePolicy) {
  const order = target.row;
  await assertNotCheckedIn(db, order.memberId);
  const newer = await db.order.findFirst({
    where: {
      memberId: order.memberId,
      status: 'PAID',
      createdAt: { gt: order.createdAt },
      itemDesc: { contains: '| UNLIMITED |' },
    },
    select: { id: true },
  });
  if (newer) throw httpError(409, 'NOT_LATEST_MEMBERSHIP', `會員另有較新之會籍購案 ${newer.id}，請先辦理較新之單據`);

  const member = await db.member.findUnique({
    where: { id: order.memberId },
    select: { id: true, expireDate: true, plan: true, leaveUntil: true },
  });
  const sub = await findLinkedSubscription(db, order.id);
  const { periodDays, contractDays } = await resolveUnlimitedOrderPeriodDays(order);
  const grantedDays = sub ? periodDays : contractDays;
  const unusedDays = remainingExpireDays(member?.expireDate, now);
  const calc = {
    orderKind: 'MEMBERSHIP',
    subscriptionId: sub?.id ?? null,
    subscriptionActive: Boolean(sub && !['CANCELLED', 'COMPLETED'].includes(sub.status)),
    memberBefore: {
      expireDate: member?.expireDate ?? null,
      plan: member?.plan ?? null,
      leaveUntil: member?.leaveUntil ?? null,
    },
    periodDays,
    contractDays,
    grantedDays,
    unusedDays,
  };

  const notStarted = unusedDays > grantedDays;
  let unusedGrace = false;
  if (!notStarted && withinCoolingOff(order.createdAt, now)) {
    const used = await db.checkInLog.count({
      where: { memberId: order.memberId, checkInAt: { gte: order.createdAt }, status: { not: 'CANCELLED' } },
    });
    unusedGrace = used === 0;
    if (scope === 'FULL' && used > 0) {
      throw httpError(409, 'SERVICE_ALREADY_USED', `購案後已進場 ${used} 次，不可全額退費，請改用未履約退費`);
    }
  }
  if (notStarted || unusedGrace) {
    const note = notStarted
      ? `契約第八條：始期尚未屆至，全額退 $${target.amount}`
      : `契約第八條：生效 7 日內未進場，全額退 $${target.amount}`;
    return { full: true, gross: target.amount, fee: 0, feeMax: 0, consumedValue: 0, calc: { ...calc, note, allowanceNote: '未使用全額退' } };
  }
  if (scope === 'FULL') {
    throw httpError(409, 'COOLING_OFF_EXPIRED', '已逾 7 日無條件解約期，請改用未履約退費（UNUSED）');
  }

  const detail = computeMonthlyCardRefundDetail({
    orderAmount: target.amount,
    unusedDays,
    periodDays,
    contractDays: grantedDays,
    feePolicy,
  });
  if (!detail.eligible) throw httpError(409, 'REFUND_NOT_ELIGIBLE', detail.note);
  const gross = ntd(detail.amount);
  const fee = ntd(detail.fee);
  return {
    full: false,
    gross,
    fee,
    feeMax: ntd(detail.feeMax),
    consumedValue: Math.max(0, target.amount - ntd(detail.base)),
    calc: {
      ...calc,
      detail,
      note: detail.note,
      allowanceNote: `解約:已用${detail.consumedPeriods}/${detail.totalPeriods}期,扣手續費$${fee}`,
    },
  };
}

/**
 * @returns {Promise<object>} plan：{ kind, refType, refId, scope, lines, calc, grossAmount, feeAmount, consumedValue, fullRefund, legs, payoutAmount, ... }
 */
/** 計時進場未出場結算前禁止回收儲值：否則出場扣款落空（取消後錢包不足），逃避計時費 */
async function assertNoTimedCheckIn(db, memberId) {
  const active = await db.checkInLog.findFirst({
    where: { memberId, status: 'ACTIVE', checkOutAt: null, billingMode: { not: '月費通行' } },
    select: { id: true },
  });
  if (active) {
    throw httpError(409, 'MEMBER_CHECKED_IN', '會員目前在館內（計時進場尚未出場結算），請待出場扣款完成後再取消／退費儲值');
  }
}

/** 私教：上課中禁止退費；已預約（預約時已扣堂）之未來課堂於退費交易中刪除並還堂 */
async function loadPtBookings(db, contract, now) {
  const live = { status: { in: ['PENDING', 'CONFIRMED'] } };
  const inProgress = await db.class.findFirst({
    where: { ptContractId: contract.id, startAt: { lte: now }, endAt: { gt: now }, reservations: { some: live } },
    select: { id: true },
  });
  if (inProgress) {
    throw httpError(409, 'COURSE_SESSION_IN_PROGRESS', '此私教合約目前有課程進行中，請待下課後再辦理退費');
  }
  const future = await db.class.findMany({
    where: { ptContractId: contract.id, startAt: { gt: now }, reservations: { some: live } },
    select: { id: true, startAt: true, endAt: true, venueId: true, stationId: true, trainerId: true },
    orderBy: { startAt: 'asc' },
  });
  const otherFuture = await db.reservation.count({
    where: {
      memberId: contract.memberId,
      ...live,
      class: { trainerId: contract.trainerId, type: 'PRIVATE', startAt: { gt: now }, ptContractId: null },
    },
  });
  const lateLeave = await db.classLeave.aggregate({
    where: { ptContractId: contract.id, withinPolicy: false },
    _sum: { compensationFee: true },
    _count: { _all: true },
  });
  return {
    futureClasses: future.map((c) => ({ ...c, startAt: c.startAt.toISOString(), endAt: c.endAt.toISOString() })),
    otherFuture,
    lateLeaveFees: lateLeave._sum.compensationFee || 0,
    lateLeaveCount: lateLeave._count._all,
  };
}

/** 合約之可用性檢查（私教／課程分期共用）；回傳未來預約與實際已上堂數 */
async function loadContractForRefund(db, contract, now) {
  if (contract.refundedAt) throw httpError(409, 'ALREADY_REFUNDED', '此私教合約已退費停用');
  const bookings = await loadPtBookings(db, contract, now);
  const releasedSessions = bookings.futureClasses.length;
  // 預約排滿時合約會被標為停用；還有未來預約可釋放者仍可退
  if (!contract.isActive && !(releasedSessions > 0 && contract.usedSessions >= contract.totalSessions)) {
    throw httpError(409, 'ALREADY_REFUNDED', '此私教合約已停用');
  }
  // 逾效期不封死退費（消保仍須依第九條退餘額），由 executePlan 要求 DUTY+ 專案核准
  const expiresAt = contract.expiresAt ? new Date(contract.expiresAt) : ptContractExpiresAt(contract.totalSessions, contract.createdAt);
  return {
    bookings,
    releasedSessions,
    usedSessions: Math.max(0, contract.usedSessions - releasedSessions),
    expiry: { isContractExpired: now > expiresAt, contractExpiresAt: expiresAt.toISOString() },
  };
}

function orderAsTarget(order, session) {
  return { refType: 'ORDER', id: order.id, row: order, session, amount: ntd(order.amount), refundedAmount: order.refundedAmount || 0 };
}

/**
 * 課程分期解約：只能以首期訂單辦理；契約公式扣未繳期數，應退由最新一期往前分攤（各期各自退款管道與發票）
 */
async function computeCourseInstallment(db, target, scope, now, feePolicy) {
  const asRenewal = await db.cardSubscriptionCharge.findFirst({
    where: { orderId: target.id },
    select: { subscription: { select: { originOrderId: true } } },
  });
  if (asRenewal) {
    throw httpError(409, 'USE_COURSE_ORIGIN_ORDER', `課程分期續扣單不可單獨退費，請以首期訂單 ${asRenewal.subscription?.originOrderId || ''} 辦理解約`.trim());
  }
  const sub = await db.cardSubscription.findFirst({ where: { originOrderId: target.id } });
  const contract = target.row.ptContract || (await db.pTContract.findFirst({ where: { orderId: target.id } }));
  if (!sub || !contract) throw httpError(409, 'PT_CONTRACT_UNLINKED', '此課程分期訂單未連結訂閱或合約，請洽總部人工處理');
  const { bookings, releasedSessions, usedSessions, expiry } = await loadContractForRefund(db, contract, now);

  const charges = await db.cardSubscriptionCharge.findMany({
    where: { subscriptionId: sub.id, status: 'PAID', orderId: { not: null } },
    select: { orderId: true, periodIndex: true },
  });
  const renewals = charges.length
    ? await db.order.findMany({ where: { id: { in: charges.map((c) => c.orderId) }, status: 'PAID' } })
    : [];
  const indexOf = new Map(charges.map((c) => [c.orderId, c.periodIndex]));
  const periods = [{ order: target.row, periodIndex: 1 }, ...renewals.map((o) => ({ order: o, periodIndex: indexOf.get(o.id) }))]
    .sort((a, b) => b.periodIndex - a.periodIndex)
    .map((p) => ({ ...p, refundable: ntd(p.order.amount) - (p.order.refundedAmount || 0) }));
  const paidAmount = periods.reduce((s, p) => s + p.refundable, 0);

  const r = computeCourseInstallmentRefund({
    contractPrice: contract.pricePaid,
    paidAmount,
    totalSessions: contract.totalSessions,
    usedSessions,
    lateLeaveFees: bookings.lateLeaveFees,
    scope,
    coolingOff: withinCoolingOff(target.row.createdAt, now),
    feePolicy,
  });
  const allocations = allocateInstallmentRefund(
    periods.map((p) => ({ orderId: p.order.id, refundable: p.refundable, amount: ntd(p.order.amount) })),
    r.gross,
  );
  return {
    r,
    orders: new Map(periods.map((p) => [p.order.id, p.order])),
    calc: {
      orderKind: 'COURSE_SUB',
      contractId: contract.id,
      subscriptionId: sub.id,
      subscriptionActive: !['CANCELLED', 'COMPLETED'].includes(sub.status),
      ...r,
      contractUsedSessions: contract.usedSessions,
      totalSessions: contract.totalSessions,
      releasedSessions,
      futureClasses: bookings.futureClasses,
      futureBookings: bookings.otherFuture,
      lateLeaveCount: bookings.lateLeaveCount,
      ...expiry,
      allocations,
      allowanceNote: r.unusedGrace ? '未上課全額退' : `解約:已上${usedSessions}/${contract.totalSessions}堂,扣違約金$${r.fee}`,
    },
  };
}

/** 課程分期：各期訂單之退款腿（依該期原付款比例拆分） */
async function installmentLegs(db, allocations, orders) {
  const legs = [];
  const payuniPaidByOrder = {};
  for (const a of allocations) {
    const order = orders.get(a.orderId);
    const session = order.checkoutSessionId ? await db.checkoutSession.findUnique({ where: { id: order.checkoutSessionId } }) : null;
    const t = orderAsTarget(order, session);
    const { breakdown, merchantNos } = paymentSource(t);
    const prior = await priorRefundedByMethod(db, t);
    const available = Object.fromEntries(Object.entries(breakdown).map(([m, v]) => [m, v - (prior[m] || 0)]));
    const refs = await resolveProviderRefs(db, t, merchantNos);
    payuniPaidByOrder[order.id] = breakdown.PAYUNI ?? null;
    for (const leg of splitRefundLegs({ breakdown, refundAmount: a.amount, available })) {
      legs.push({ ...leg, refOrderId: order.id, refs });
    }
  }
  return { legs, payuniPaidByOrder };
}

/**
 * 課程分期：各期訂單之發票作法（作廢／折讓判定仍經 decideInvoiceActions，全額＝該期整筆退回）
 * @returns {Promise<Array<{ inv, orderId, gross, full, shared, action }>>}
 */
async function installmentInvoiceJobs(db, allocations, now = new Date()) {
  const jobs = [];
  for (const a of allocations || []) {
    const order = await db.order.findUnique({ where: { id: a.orderId } });
    if (!order) continue;
    const session = order.checkoutSessionId ? await db.checkoutSession.findUnique({ where: { id: order.checkoutSessionId } }) : null;
    const { invoices, shared } = await loadRefInvoices(db, orderAsTarget(order, session));
    const decided = decideInvoiceActions({ invoices, fullRefund: a.full, sharedInvoice: shared, now });
    const issued = invoices.filter((inv) => inv.status === 'ISSUED');
    const split = issued.length ? allocateInteger(a.amount, issued.map((inv) => inv.totalAmount)) : [];
    for (const inv of invoices) {
      const action = decided.perInvoice.find((p) => p.id === inv.id)?.action;
      if (!action) continue;
      const i = issued.indexOf(inv);
      jobs.push({ inv, orderId: a.orderId, gross: i >= 0 ? split[i] : 0, full: a.full, shared, action });
    }
  }
  return jobs;
}

function aggregateInvoiceAction(jobs) {
  const acts = new Set(jobs.map((j) => j.action));
  if (acts.has('ALLOWANCE')) return 'ALLOWANCE';
  if (acts.has('VOID')) return 'VOID';
  if (acts.has('CANCEL')) return 'CANCEL_UNISSUED';
  return 'NONE';
}

async function buildPlan(db, target, { scope: scopeRaw, items, mode, clause = 'VOLUNTARY', overrideFeeAmount = null, now = new Date() }) {
  assertPaid(target);
  let scope = String(scopeRaw || '').toUpperCase();
  let gross;
  let fee = 0;
  let feeMax = 0;
  let consumedValue = 0;
  let lines = null;
  let calc;
  let fullRefund;
  let kind = 'ORDER_REFUND';
  let installment = null;
  const feePolicy = { clause, overrideFeeAmount };
  const customFee = clause !== 'VOLUNTARY' || overrideFeeAmount != null;
  if (customFee && (mode === 'TOPUP_VOID' || target.refType === 'SALE')) {
    throw httpError(400, 'FEE_POLICY_NOT_APPLICABLE', '原單取消與商品退貨不收手續費，不可指定終止條款或調整手續費');
  }

  if (mode === 'TOPUP_VOID') {
    if (target.refType !== 'ORDER' || target.kind !== 'TOPUP') {
      throw httpError(409, 'NOT_TOPUP_ORDER', '此單據不是計時儲值，請改用子單退費');
    }
    await assertNoTimedCheckIn(db, target.memberId);
    const member = await db.member.findUnique({ where: { id: target.memberId }, select: { cashWallet: true, bonusWallet: true } });
    const deduct = assertTopupVoidable({
      cashWallet: member?.cashWallet,
      bonusWallet: member?.bonusWallet,
      grantedCash: target.row.grantedCash,
      grantedBonus: target.row.grantedBonus,
    });
    kind = 'TOPUP_VOID';
    scope = 'FULL';
    gross = target.amount;
    fullRefund = true;
    calc = { orderKind: 'TOPUP', deductCash: deduct.deductCash, deductBonus: deduct.deductBonus, note: `原單取消：回收本金 $${deduct.deductCash}／運動金 $${deduct.deductBonus}` };
  } else if (target.refType === 'SALE') {
    if (!['FULL', 'ITEMS'].includes(scope)) scope = items?.length ? 'ITEMS' : 'FULL';
    if (scope === 'ITEMS' && !items?.length) throw httpError(400, 'ITEMS_REQUIRED', '請指定退貨品項 items[{ orderItemId, qty }]');
    const ret = computeSaleReturnLines(target.row.items, scope === 'ITEMS' ? items : null);
    lines = ret.lines;
    gross = ret.gross;
    if (ret.exhausts) {
      const rest = target.amount - target.refundedAmount;
      if (rest !== gross && rest > 0) {
        const adj = allocateInteger(rest, lines.map((l) => l.gross));
        lines = lines.map((l, i) => ({ ...l, gross: adj[i] }));
        gross = rest;
      }
    }
    kind = 'SALE_RETURN';
    fullRefund = ret.exhausts && target.refundedAmount === 0;
    calc = { orderKind: 'SALE', exhausts: ret.exhausts, note: `退貨 ${lines.map((l) => `${l.name}×${l.qty}`).join('、')}` };
  } else {
    switch (target.kind) {
      case 'GROUP':
        throw httpError(409, 'USE_GROUP_REFUND', '團課報名請改用團課退費（/api/ops/group/enrollments/:id/refund）');
      case 'COURSE_SUB': {
        if (!['FULL', 'UNUSED'].includes(scope)) throw httpError(400, 'SCOPE_INVALID', '課程分期解約 scope 須為 FULL 或 UNUSED');
        installment = await computeCourseInstallment(db, target, scope, now, feePolicy);
        const { r } = installment;
        gross = r.gross;
        fee = r.fee;
        feeMax = r.feeMax;
        consumedValue = r.consumedValue + r.lateLeaveFees;
        if (r.unusedGrace) scope = 'FULL';
        calc = installment.calc;
        fullRefund = scope === 'FULL';
        break;
      }
      case 'OTHER':
        throw httpError(409, 'REFUND_KIND_UNSUPPORTED', '此訂單類型不支援自動退費，請洽總部人工處理');
      case 'TOPUP': {
        if (scope !== 'UNUSED') {
          throw httpError(409, 'USE_TOPUP_CANCEL', '計時儲值全額退請改用儲值原單取消（/api/ops/topups/:id/cancel）；子單退費僅支援 scope=UNUSED');
        }
        if (target.row.grantedCash == null || target.row.grantedBonus == null) {
          throw httpError(409, 'TOPUP_GRANT_UNKNOWN', '此儲值單缺少入帳快照，無法自動退費，請洽總部人工處理');
        }
        await assertNoTimedCheckIn(db, target.memberId);
        const member = await db.member.findUnique({ where: { id: target.memberId }, select: { cashWallet: true, bonusWallet: true } });
        const r = computeTimedTopupRefund({
          cashWallet: member?.cashWallet,
          bonusWallet: member?.bonusWallet,
          originalPrice: target.row.grantedCash,
          originalBonus: target.row.grantedBonus,
          coolingOff: withinCoolingOff(target.row.createdAt, now),
          feePolicy,
        });
        if (r.beforeFee < 0 || r.refundCash < 0) {
          throw httpError(409, 'REFUND_BLOCKED', `運動金已消耗且本金殘值不足：實付 $${r.paidAmount} − 實際使用 $${r.usedAmount} − 手續費 $${r.refundFee}`);
        }
        gross = ntd(r.refundCash);
        if (!(gross > 0)) throw httpError(409, 'REFUND_AMOUNT_ZERO', '依公式應退金額為 0，無可退費');
        fee = ntd(r.refundFee);
        feeMax = ntd(r.feeMax);
        consumedValue = ntd(r.usedAmount);
        fullRefund = r.unusedGrace && gross === target.amount;
        calc = {
          orderKind: 'TOPUP',
          ...r,
          deductCash: r.remainingPrincipal,
          deductBonus: r.recoveredBonus,
          note: r.unusedGrace
            ? `契約第八條：7 日內未使用，全額退 $${r.refundCash}（贈送運動金 $${r.recoveredBonus} 註銷）`
            : `實付$${r.paidAmount} − 實際使用$${r.usedAmount} − 手續費$${r.refundFee} = $${r.refundCash}`,
          allowanceNote: r.unusedGrace ? '未使用全額退' : `解約:已用$${ntd(r.usedAmount)},扣手續費$${fee}`,
        };
        break;
      }
      case 'MEMBERSHIP': {
        if (!['FULL', 'UNUSED'].includes(scope)) throw httpError(400, 'SCOPE_INVALID', '月卡退費 scope 須為 FULL 或 UNUSED');
        const m = await computeMembership(db, target, scope, now, feePolicy);
        gross = m.gross;
        fee = m.fee;
        feeMax = m.feeMax;
        consumedValue = m.consumedValue;
        calc = m.calc;
        if (m.full) scope = 'FULL';
        fullRefund = scope === 'FULL';
        break;
      }
      case 'PT': {
        if (!['FULL', 'UNUSED'].includes(scope)) throw httpError(400, 'SCOPE_INVALID', '私教退費 scope 須為 FULL 或 UNUSED');
        const contract = target.row.ptContract;
        if (!contract) throw httpError(409, 'PT_CONTRACT_UNLINKED', '此私教訂單未連結合約，請洽總部人工處理');
        const { bookings, releasedSessions, usedSessions, expiry } = await loadContractForRefund(db, contract, now);
        const r = computePtRefund({
          pricePaid: target.amount,
          totalSessions: contract.totalSessions,
          usedSessions,
          lateLeaveFees: bookings.lateLeaveFees,
          scope,
          coolingOff: withinCoolingOff(target.row.createdAt, now),
          feePolicy,
        });
        if (!(r.gross > 0)) throw httpError(409, 'REFUND_AMOUNT_ZERO', `依公式應退金額為 0（${r.note}）`);
        gross = r.gross;
        fee = r.fee;
        feeMax = r.feeMax;
        consumedValue = r.consumedValue + r.lateLeaveFees;
        if (r.unusedGrace) scope = 'FULL';
        calc = {
          orderKind: 'PT',
          contractId: contract.id,
          ...r,
          contractUsedSessions: contract.usedSessions,
          totalSessions: contract.totalSessions,
          releasedSessions,
          futureClasses: bookings.futureClasses,
          futureBookings: bookings.otherFuture,
          lateLeaveCount: bookings.lateLeaveCount,
          ...expiry,
          allowanceNote: r.unusedGrace
            ? '未上課全額退'
            : `解約:已上${usedSessions}/${contract.totalSessions}堂,扣違約金$${r.fee}`,
        };
        fullRefund = scope === 'FULL';
        break;
      }
      default:
        throw httpError(409, 'REFUND_KIND_UNSUPPORTED', '此訂單類型不支援自動退費');
    }
  }

  let legs;
  let refs;
  let relevant;
  let shared;
  let invoicePlan;
  if (installment) {
    // 未繳期數大於契約可退時應退為 0：仍須解約（終止合約與續扣），差額列應補繳
    const out = await installmentLegs(db, calc.allocations, installment.orders);
    legs = out.legs;
    refs = {};
    calc = { ...calc, payuniPaidByOrder: out.payuniPaidByOrder };
    const jobs = await installmentInvoiceJobs(db, calc.allocations, now);
    relevant = jobs.map((j) => ({ ...j.inv, orderId: j.orderId, gross: j.gross }));
    shared = jobs.some((j) => j.shared);
    invoicePlan = { action: aggregateInvoiceAction(jobs), perInvoice: jobs.map((j) => ({ id: j.inv.id, action: j.action })) };
  } else {
    if (!(gross > 0)) throw httpError(409, 'REFUND_AMOUNT_ZERO', '應退金額為 0');
    if (gross > target.amount - target.refundedAmount) {
      throw httpError(409, 'REFUND_EXCEEDS_PAID', `應退 $${gross} 超過單據可退餘額 $${target.amount - target.refundedAmount}`);
    }
    const { breakdown, merchantNos } = paymentSource(target);
    const prior = await priorRefundedByMethod(db, target);
    const available = Object.fromEntries(Object.entries(breakdown).map(([m, v]) => [m, v - (prior[m] || 0)]));
    legs = splitRefundLegs({ breakdown, refundAmount: gross, available });
    refs = await resolveProviderRefs(db, target, merchantNos);
    calc = { ...calc, payuniPaid: breakdown.PAYUNI ?? null };
    const loaded = await loadRefInvoices(db, target);
    shared = loaded.shared;
    relevant = relevantInvoices(target, loaded.invoices, lines, shared);
    invoicePlan = decideInvoiceActions({ invoices: relevant, fullRefund, sharedInvoice: shared, now });
  }
  if (legs.some((l) => l.method === 'WALLET_CASH') && !target.memberId) {
    throw httpError(409, 'MEMBER_REQUIRED', '原單含零錢包付款但無會員，無法退回零錢包');
  }
  const signatureLikely =
    invoicePlan.action === 'ALLOWANCE' && relevant.some((inv) => inv.category === 'B2B' && inv.status === 'ISSUED');

  return {
    kind,
    refType: target.refType,
    refId: target.id,
    checkoutSessionId: target.session?.id ?? null,
    branchId: target.branchId,
    memberId: target.memberId,
    memberName: target.memberName,
    scope,
    lines,
    calc,
    clause,
    overrideFeeAmount,
    grossAmount: gross,
    feeAmount: fee,
    feeMax,
    consumedValue,
    fullRefund,
    legs,
    payoutAmount: legs.filter((l) => !l.forfeited).reduce((s, l) => s + l.amount, 0),
    refs,
    invoicePlan: {
      action: invoicePlan.action,
      sharedInvoice: shared,
      invoices: relevant.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        category: inv.category,
        taxType: inv.taxType,
        periodKey: inv.periodKey,
        totalAmount: inv.totalAmount,
        allowanceTotal: inv.allowanceTotal,
        action: invoicePlan.perInvoice.find((p) => p.id === inv.id)?.action || null,
        ...(inv.orderId ? { orderId: inv.orderId, gross: inv.gross } : {}),
      })),
    },
    signatureLikely,
  };
}

// ─────────────────────────────────────────────────────────────
// 報價鎖：試算簽發 quoteToken（綁子單＋作法＋經辦＋計畫摘要），送出時重算比對；不符即拒，不以舊快照執行
// ─────────────────────────────────────────────────────────────

const QUOTE_TOKEN_PURPOSE = 'refund-quote';
const QUOTE_TTL_MS = 10 * 60 * 1000;

/** 經辦所見之可執行內容：品項、金額、權益回收、退款管道、發票作法；任一變動即需重新試算 */
function planDigest(plan) {
  return sha256Hex(
    JSON.stringify({
      k: plan.kind,
      t: plan.refType,
      id: plan.refId,
      s: plan.scope,
      l: (plan.lines || []).map((l) => [l.orderItemId, l.qty, l.gross]),
      g: plan.grossAmount,
      f: plan.feeAmount,
      fm: plan.feeMax,
      cl: plan.clause,
      c: plan.consumedValue,
      rel: (plan.calc.futureClasses || []).map((x) => x.id),
      p: plan.payoutAmount,
      full: plan.fullRefund,
      w: [plan.calc.deductCash ?? null, plan.calc.deductBonus ?? null],
      legs: plan.legs.map((l) => [l.method, l.amount, Boolean(l.forfeited), l.refOrderId ?? null]),
      inv: [plan.invoicePlan.action, plan.invoicePlan.invoices.map((i) => [i.id, i.action, i.gross ?? null])],
      due: plan.calc.shortfall ?? null,
      exp: plan.calc.isContractExpired ?? null,
      sub: Boolean(plan.calc.subscriptionActive),
    }),
  );
}

function issueQuote(user, plan, mode) {
  const exp = Date.now() + QUOTE_TTL_MS;
  const quoteToken = signToken(QUOTE_TOKEN_PURPOSE, {
    v: 1,
    ref: plan.refId,
    m: mode === 'TOPUP_VOID' ? 'TOPUP_VOID' : 'SUB_ORDER',
    sid: user?.id ?? null,
    dg: planDigest(plan),
    exp,
  });
  return { quoteToken, quoteExpiresAt: new Date(exp).toISOString() };
}

/** 驗 quoteToken 並回傳試算當下之計畫摘要 */
function verifyQuote(user, token, target, mode) {
  if (!String(token || '').trim()) throw httpError(400, 'QUOTE_TOKEN_REQUIRED', '缺少試算憑證，請重新試算後送出');
  const read = readToken(QUOTE_TOKEN_PURPOSE, token);
  const m = mode === 'TOPUP_VOID' ? 'TOPUP_VOID' : 'SUB_ORDER';
  if (!read || read.payload.ref !== target.id || read.payload.m !== m || read.payload.sid !== (user?.id ?? null)) {
    throw httpError(400, 'QUOTE_TOKEN_INVALID', '試算憑證無效，請重新試算後送出');
  }
  if (read.expired) throw httpError(409, 'QUOTE_EXPIRED', '試算已逾時（10 分鐘），請重新試算後送出');
  return read.payload.dg;
}

function assertQuoteMatches(plan, digest) {
  if (planDigest(plan) !== digest) {
    throw httpError(409, 'QUOTE_STALE', '單據或會員餘額已變動，退費內容與試算不同，請核對新試算後再送出');
  }
}

function publicPlan(plan, target, user, mode) {
  return {
    ...issueQuote(user, plan, mode),
    kind: plan.kind,
    subOrderId: plan.refId,
    refType: plan.refType,
    orderKind: target.kind,
    checkoutSessionId: plan.checkoutSessionId,
    memberId: plan.memberId,
    memberName: plan.memberName,
    branchId: plan.branchId,
    scope: plan.scope,
    lines: plan.lines,
    calc: plan.calc,
    clause: plan.clause,
    grossAmount: plan.grossAmount,
    feeAmount: plan.feeAmount,
    feeMax: plan.feeMax,
    consumedValue: plan.consumedValue,
    payoutAmount: plan.payoutAmount,
    fullRefund: plan.fullRefund,
    legs: plan.legs.map(({ refs: legRefs, ...l }) => {
      const refs = legRefs || plan.refs;
      return {
        ...l,
        ready: l.method === 'LINEPAY' ? Boolean(refs.linePayTxId) : l.method === 'PAYUNI' ? Boolean(refs.payuniTradeNo) : true,
        needsTerminal: l.method === 'YIPAY',
      };
    }),
    invoicePlan: plan.invoicePlan,
    signatureRequired: plan.signatureLikely,
    isContractExpired: Boolean(plan.calc.isContractExpired),
    contractExpiresAt: plan.calc.contractExpiresAt ?? null,
    shortfall: plan.calc.shortfall ?? 0,
    warnings: [
      ...(plan.calc.isContractExpired
        ? [`本課程已逾契約效期（單堂 10 日，到期日 ${twDateLabel(plan.calc.contractExpiresAt)}）。依紙本契約原則不予退費，若需專案退費須由值班主管（DUTY+）核准`]
        : []),
      ...(plan.calc.shortfall > 0
        ? [`學員上課進度超前，扣除已繳分期款後尚須臨櫃補繳差額 $${plan.calc.shortfall}；須確認收訖（或經主管核准立案追償）後才可終止合約與續扣`]
        : []),
      ...(plan.calc.subscriptionActive ? ['將同步終止定期定額（PayUNi 續期）；中止退費不會恢復訂閱'] : []),
      ...(plan.calc.releasedSessions > 0
        ? [`將一併取消此合約 ${plan.calc.releasedSessions} 堂未來預約並釋放教練時段／場地（中止退費不會恢復預約）`]
        : []),
      ...(plan.calc.futureBookings > 0 ? [`會員另有 ${plan.calc.futureBookings} 堂未綁合約之未來私教預約，請確認是否另行取消`] : []),
      ...(plan.legs.some((l) => l.method === 'VOUCHER') ? ['抵用券份額不退現（註銷）'] : []),
      ...(plan.legs.some((l) => l.method === 'YIPAY') ? ['乙禾刷卡須於端末機執行退貨後，回填 RRN／授權碼／卡號末四碼'] : []),
    ],
  };
}

// ─────────────────────────────────────────────────────────────
// 預覽／執行
// ─────────────────────────────────────────────────────────────

export async function previewTopupCancel(user, orderId) {
  const target = await loadTarget(prisma, orderId);
  assertTargetAccess(user, target);
  const plan = await buildPlan(prisma, target, { mode: 'TOPUP_VOID' });
  return publicPlan(plan, target, user, 'TOPUP_VOID');
}

/** 第十四條免手續費或調降手續費：限 DUTY+（路由亦限 DUTY+，此為服務層防線） */
function normalizeFeePolicy(user, { clause, overrideFeeAmount }) {
  const policy = { clause: normalizeTerminationClause(clause), overrideFeeAmount: normalizeOverrideFee(overrideFeeAmount) };
  if ((policy.clause !== 'VOLUNTARY' || policy.overrideFeeAmount != null) && !hasDutyRankOrAbove(user)) {
    throw httpError(403, 'DUTY_ROLE_REQUIRED_FOR_FEE_WAIVER', '免收或調降契約手續費／違約金，須由值班主管（DUTY+）執行');
  }
  return policy;
}

export async function previewSubOrderRefund(user, subOrderId, { scope, items, clause, overrideFeeAmount } = {}) {
  const policy = normalizeFeePolicy(user, { clause, overrideFeeAmount });
  const target = await loadTarget(prisma, subOrderId);
  assertTargetAccess(user, target);
  const plan = await buildPlan(prisma, target, { scope, items, ...policy });
  return publicPlan(plan, target, user);
}

async function lockTargetRow(tx, target) {
  if (target.refType === 'SALE') {
    await tx.$queryRaw`SELECT id FROM "SaleOrder" WHERE id = ${target.id} FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${target.id} FOR UPDATE`;
  }
}

/** 第一段交易：權益回收（回傳稽核快照） */
async function applyEntitlementRollback(tx, plan, target, { refundId, user, now }) {
  const staffId = user?.id ?? null;
  const before = { status: target.status, refundedAmount: target.refundedAmount };
  const after = {};
  let walletCashReversed = 0;
  let walletBonusReversed = 0;
  const refMeta = { refType: target.refType, refId: target.id, refundId, staffId };

  const reverseWallets = async (deductBonus, deductCash, reasonCode) => {
    await lockMemberRow(tx, target.memberId);
    await assertNoTimedCheckIn(tx, target.memberId);
    const r = await mutateMemberWallet(tx, {
      memberId: target.memberId,
      txType: reasonCode,
      mode: WALLET_MODE.EXACT_BUCKETS_DEDUCT,
      cashDeduct: deductCash,
      bonusDeduct: deductBonus,
      reason: `${reasonCode === WALLET_TX.TOPUP_VOID ? '儲值原單取消' : '子單退費'}回收本金 $${deductCash}／運動金 $${deductBonus}`,
      branchId: target.branchId,
      insufficient: { message: '會員已動用儲值本金或贈送運動金，餘額不足無法原單取消' },
      ...refMeta,
    });
    walletBonusReversed = deductBonus;
    walletCashReversed = deductCash;
    after.wallet = { cashWallet: r.after.cash, bonusWallet: r.after.bonus };
  };

  const closeOrder = async () => {
    const done = await tx.order.updateMany({
      where: { id: target.id, status: 'PAID' },
      data: { status: 'REFUNDED', refundedAmount: { increment: plan.grossAmount } },
    });
    if (!done.count) throw httpError(409, 'STATE_CHANGED', '訂單狀態已變更，請重新查詢');
    after.status = 'REFUNDED';
  };

  if (plan.kind === 'TOPUP_VOID' || plan.calc.orderKind === 'TOPUP') {
    await reverseWallets(plan.calc.deductBonus, plan.calc.deductCash, plan.kind === 'TOPUP_VOID' ? 'TOPUP_VOID' : 'REFUND_REVERSE');
    await closeOrder();
  } else if (plan.kind === 'SALE_RETURN') {
    const sale = target.row;
    for (const line of plan.lines) {
      const item = sale.items.find((i) => i.id === line.orderItemId);
      const ok = await tx.saleItem.updateMany({
        where: { id: item.id, refundedQty: { lte: item.qty - line.qty } },
        data: { refundedQty: { increment: line.qty } },
      });
      if (!ok.count) throw httpError(409, 'REFUND_QTY_EXCEEDED', `「${item.name}」可退數量已變更，請重新查詢`);
      if (tracksInventory(item.product)) {
        await applyStockDelta(tx, {
          branchId: sale.branchId,
          productId: item.productId,
          delta: line.qty,
          refType: 'SALE_RETURN',
          refId: sale.id,
          refLineId: item.id,
          reason: `退貨回補 ${refundId}`,
          staffId,
          unitCost: item.unitCost != null ? Number(item.unitCost) : null,
        });
      }
    }
    const updated = await tx.saleOrder.update({
      where: { id: sale.id },
      data: { refundedAmount: { increment: plan.grossAmount }, ...(plan.calc.exhausts ? { status: 'CANCELLED' } : {}) },
      select: { status: true, refundedAmount: true },
    });
    after.status = updated.status;
    after.refundedAmount = updated.refundedAmount;
  } else if (plan.calc.orderKind === 'MEMBERSHIP') {
    await lockMemberRow(tx, target.memberId);
    const m = await tx.member.findUnique({ where: { id: target.memberId }, select: { expireDate: true, plan: true } });
    // 全額退：只扣回本單天數（保留其他已付效期）；未履約退：依月卡規則截斷效期
    const shifted =
      plan.scope === 'FULL' && m?.expireDate && plan.calc.grantedDays > 0
        ? shiftDateByDays(m.expireDate, -plan.calc.grantedDays)
        : null;
    let data;
    if (shifted && shifted > now) {
      data = { expireDate: shifted };
    } else {
      const cut = buildCutExpireNow(m, now);
      data = { expireDate: cut.expireDate, plan: cut.plan };
    }
    await tx.member.update({ where: { id: target.memberId }, data: { ...data, leaveUntil: null } });
    const leaves = await tx.memberLeave.findMany({ where: { memberId: target.memberId, status: 'ACTIVE' }, select: { id: true } });
    if (leaves.length) {
      await tx.memberLeave.updateMany({
        where: { id: { in: leaves.map((l) => l.id) } },
        data: { status: 'ENDED', endedAt: now, reason: `退費 ${refundId} 截斷效期` },
      });
    }
    before.member = plan.calc.memberBefore;
    after.member = data;
    after.endedLeaveIds = leaves.map((l) => l.id);
    await closeOrder();
  } else if (plan.calc.orderKind === 'PT' || plan.calc.orderKind === 'COURSE_SUB') {
    await tx.$queryRaw`SELECT id FROM "PTContract" WHERE id = ${plan.calc.contractId} FOR UPDATE`;
    const contract = await tx.pTContract.findUnique({ where: { id: plan.calc.contractId } });
    if (!contract || contract.refundedAt || contract.usedSessions !== plan.calc.contractUsedSessions) {
      throw httpError(409, 'STATE_CHANGED', '私教合約已異動（堂數或狀態），請重新試算');
    }
    // 未來預約（預約時已扣堂）：刪除課堂以釋放教練時段與場地，並還堂
    const classIds = (plan.calc.futureClasses || []).map((c) => c.id);
    if (classIds.length) {
      const removed = await tx.class.deleteMany({ where: { id: { in: classIds }, ptContractId: contract.id, startAt: { gt: now } } });
      if (removed.count !== classIds.length) throw httpError(409, 'STATE_CHANGED', '私教預約已異動，請重新試算');
    }
    await tx.pTContract.update({
      where: { id: contract.id },
      data: { isActive: false, refundedAt: now, usedSessions: plan.calc.used },
    });
    before.contract = { id: contract.id, isActive: contract.isActive, usedSessions: contract.usedSessions };
    before.cancelledClasses = plan.calc.futureClasses || [];
    after.contract = { id: contract.id, isActive: false, usedSessions: plan.calc.used };
    if (plan.calc.orderKind === 'PT') {
      await closeOrder();
    } else {
      // 各期訂單依分攤累加已退；整期退回者改 REFUNDED，首期未分攤者維持 PAID（合約已停用即不可再退）
      after.periods = [];
      for (const a of plan.calc.allocations) {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${a.orderId} FOR UPDATE`;
        const o = await tx.order.findUnique({ where: { id: a.orderId }, select: { status: true, amount: true, refundedAmount: true } });
        if (!o || o.status !== 'PAID' || ntd(o.amount) - (o.refundedAmount || 0) < a.amount) {
          throw httpError(409, 'STATE_CHANGED', `分期訂單 ${a.orderId} 已異動，請重新試算`);
        }
        await tx.order.update({
          where: { id: a.orderId },
          data: { refundedAmount: { increment: a.amount }, ...(a.full ? { status: 'REFUNDED' } : {}) },
        });
        after.periods.push({ orderId: a.orderId, amount: a.amount, status: a.full ? 'REFUNDED' : 'PAID' });
      }
    }
  }
  return { before, after, walletCashReversed, walletBonusReversed };
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function normalizeIdempotencyKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw httpError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 Idempotency-Key，請重新開啟退費視窗後送出');
  if (!IDEMPOTENCY_KEY_RE.test(s)) {
    throw httpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 格式錯誤（16～64 字英數、- 或 _）');
  }
  return s;
}

/** 同鍵重送：回傳既有退費單（不再推進；後續一律走重試端點） */
async function findIdempotentReplay(user, key, target, mode) {
  const r = await prisma.refundRequest.findUnique({
    where: { idempotencyKey: key },
    include: { payments: { orderBy: { createdAt: 'asc' } } },
  });
  if (!r) return null;
  const sameKind = (mode === 'TOPUP_VOID') === (r.kind === 'TOPUP_VOID');
  if (r.refType !== target.refType || r.refId !== target.id || !sameKind || r.staffId !== user?.id) {
    throw httpError(409, 'IDEMPOTENCY_KEY_REUSED', '此冪等鍵已用於其他單據，請重新開啟退費視窗');
  }
  return { ...serializeRefund(r), replayed: true };
}

/**
 * 定期定額已於交易前終止（PayUNi 必須先停，避免退費後仍續扣），但退費交易失敗：
 * 留稽核供追查，並以專屬 code 指示櫃檯重新試算（新試算之 sub 已為 false，不會再次終止）
 */
async function subscriptionOrphanError(user, target, subscriptionCancelled, reason, cause, req) {
  await writeAudit(prisma, {
    action: 'REFUND_SUBSCRIPTION_ORPHANED',
    refType: target.refType,
    refId: target.id,
    user,
    req,
    reason,
    after: {
      subscriptionId: subscriptionCancelled.id,
      payuniStop: subscriptionCancelled.payuniStop,
      refundError: { code: cause.code ?? null, message: String(cause.message || '').slice(0, 300) },
    },
  }).catch((e) => console.error(`退費 ${target.id} 定期定額孤兒稽核寫入失敗:`, e.message));
  const err = httpError(
    409,
    'SUBSCRIPTION_CANCELLED_REFUND_INCOMPLETE',
    `定期定額（${subscriptionCancelled.id}）已終止，但退費未完成：${cause.message}。請重新試算後再送出退費`,
  );
  err.cause = cause;
  return err;
}

/**
 * 合約例外之執行前核准（試算只提示，不擋）：
 * - 課程逾效期：專案退費限 DUTY+
 * - 課程分期應補繳（shortfall）：須擇定已臨櫃收訖或立案追償＋DUTY+，否則不得停扣與終止合約（防呆帳）
 */
export const SHORTFALL_RESOLUTIONS = ['PAID_AT_POS', 'FLAG_ALERT_FOR_RECOVERY'];
const SHORTFALL_NOTE_MAX = 200;
const SHORTFALL_NOTE_MIN = 2;

function assertContractApprovals(user, plan, { shortfallResolution, shortfallNote } = {}, now = new Date()) {
  const approvals = {};
  if (plan.calc.isContractExpired) {
    if (!hasDutyRankOrAbove(user)) {
      throw httpError(403, 'DUTY_APPROVAL_REQUIRED_FOR_EXPIRED_COURSE', '課程已逾契約效期，專案退費須由值班主管（DUTY+）核准');
    }
    approvals.expiredCourse = { contractExpiresAt: plan.calc.contractExpiresAt, approvedByStaffId: user.id, approvedAt: now.toISOString() };
  }
  if (plan.calc.shortfall > 0) {
    const resolution = typeof shortfallResolution === 'string' ? shortfallResolution.trim().toUpperCase() : '';
    if (!resolution) {
      throw httpError(
        409,
        'SHORTFALL_SETTLEMENT_REQUIRED',
        `學員上課進度超前，尚須臨櫃補繳差額 $${plan.calc.shortfall}；請選擇「已臨櫃收訖」或「主管核准立案追償」後再送出`,
      );
    }
    if (!SHORTFALL_RESOLUTIONS.includes(resolution)) {
      throw httpError(400, 'SHORTFALL_RESOLUTION_INVALID', 'shortfallResolution 須為 PAID_AT_POS 或 FLAG_ALERT_FOR_RECOVERY');
    }
    if (!hasDutyRankOrAbove(user)) {
      throw httpError(403, 'DUTY_APPROVAL_REQUIRED_FOR_SHORTFALL', '應補繳差額之解約須由值班主管（DUTY+）確認');
    }
    const note = shortfallNote == null ? '' : String(shortfallNote).trim();
    if (resolution === 'PAID_AT_POS' && note.length < SHORTFALL_NOTE_MIN) {
      throw httpError(400, 'SHORTFALL_NOTE_REQUIRED', '已臨櫃收訖須填寫 POS 收款單號或收訖說明');
    }
    if (note.length > SHORTFALL_NOTE_MAX) {
      throw httpError(400, 'SHORTFALL_NOTE_TOO_LONG', `補繳備註最多 ${SHORTFALL_NOTE_MAX} 字`);
    }
    approvals.shortfall = {
      amount: plan.calc.shortfall,
      resolution,
      note: note || null,
      confirmedByStaffId: user.id,
      confirmedAt: now.toISOString(),
    };
  }
  return approvals;
}

/**
 * 欠繳立案追償：同交易寫欠款黑名單（同會員既有有效紀錄則累加事由）。
 * 不設 isAlert：欠款屬課程契約之債權，不得據以停止已收費之入場服務；清償後門市以黑名單解除結案。
 */
async function recordShortfallRecovery(tx, { memberId, refundId, contractId, amount, note, staffId }) {
  await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${memberId} FOR UPDATE`;
  const line = `課程分期解約欠繳 $${amount}（退費單 ${refundId}${contractId ? `、合約 #${contractId}` : ''}）`;
  const { row, before } = await addPaymentDebt(tx, { memberId, reason: line, note, staffId });
  return { before, after: { blacklistActive: true, blacklistReason: row.reason, amount } };
}

async function executePlan(user, target, opts, req) {
  const idempotencyKey = normalizeIdempotencyKey(opts.idempotencyKey);
  const replay = await findIdempotentReplay(user, idempotencyKey, target, opts.mode);
  if (replay) return replay;

  const quoteDigest = verifyQuote(user, opts.quoteToken, target, opts.mode);
  const reason = normalizeRefundReason(opts.reason);
  const buyerEmail = normalizeBuyerEmail(opts.buyerEmail);
  const policy = normalizeFeePolicy(user, opts);
  const now = new Date();
  const planInput = { scope: opts.scope, items: opts.items, mode: opts.mode, ...policy, now };

  // 預先檢核（含發票作法）；有 ERROR 或與試算不符即不動任何資料（含終止訂閱）
  const pre = await buildPlan(prisma, target, planInput);
  assertQuoteMatches(pre, quoteDigest);
  // 須在終止 PayUNi 續扣之前：未確認應補繳不得停扣
  const approvals = assertContractApprovals(user, pre, opts, now);

  if (pre.legs.some((l) => l.method === 'CASH') && !(pre.branchId && (await getOpenShift(pre.branchId)))) {
    throw httpError(409, 'SHIFT_NOT_OPEN', SHIFT_NOT_OPEN_MESSAGE);
  }

  // 月卡／課程分期定期定額：先終止 PayUNi 續期（失敗即中止，不動帳）
  let subscriptionCancelled = null;
  if (pre.calc.subscriptionActive && pre.calc.subscriptionId) {
    const sub = await prisma.cardSubscription.findUnique({ where: { id: pre.calc.subscriptionId } });
    const latest = pre.calc.orderKind === 'COURSE_SUB' ? null : await findLatestPaidOrderForSubscription(sub);
    if (latest?.order && latest.order.id !== target.id) {
      throw httpError(409, 'NOT_LATEST_PERIOD', `僅可退訂閱最近一期（${latest.order.id}）`);
    }
    const out = await cancelCardSubscription(sub.id, { reason: `退費 ${target.id}：${reason}`.slice(0, 160), stopPayuni: true });
    subscriptionCancelled = { id: sub.id, payuniStop: out.payuniStop?.ok ?? null };
  }

  const refundId = genId('RFD');
  let created;
  try {
    created = await prisma.$transaction(
      async (tx) => {
        await lockTargetRow(tx, target);
        const fresh = await loadTarget(tx, target.id);
        const open = await tx.refundRequest.findFirst({
          where: { refType: fresh.refType, refId: fresh.id, status: { in: OPEN_REFUND_STATUSES } },
          select: { id: true },
        });
        if (open) throw httpError(409, 'REFUND_IN_PROGRESS', `此子單已有處理中之退費單 ${open.id}`);

        const plan = await buildPlan(tx, fresh, planInput);
        assertQuoteMatches(plan, quoteDigest);
        const rollback = await applyEntitlementRollback(tx, plan, fresh, { refundId, user, now });

        let shiftId = null;
        let walletCashCredited = 0;
        const payments = [];
        for (const leg of plan.legs) {
          const refs = leg.refs || plan.refs;
          const base = { id: genId('RFP'), method: leg.method, amount: leg.amount, staffId: user?.id ?? null, refOrderId: leg.refOrderId ?? null };
          if (leg.method === 'CASH') {
            shiftId = shiftId || (await lockOpenShiftForSale(tx, plan.branchId));
            payments.push({ ...base, status: 'REFUNDED', refundedAt: now, shiftHandoverId: shiftId });
          } else if (leg.method === 'WALLET_CASH') {
            await mutateMemberWallet(tx, {
              memberId: plan.memberId,
              txType: WALLET_TX.REFUND_CREDIT,
              mode: WALLET_MODE.CREDIT_BUCKETS,
              cashDelta: leg.amount,
              bonusDelta: 0,
              reason: `退費退回零錢包（原以零錢包付款）`,
              branchId: plan.branchId,
              refType: plan.refType,
              refId: plan.refId,
              refundId,
              staffId: user?.id,
            });
            walletCashCredited += leg.amount;
            payments.push({ ...base, status: 'REFUNDED', refundedAt: now });
          } else if (leg.method === 'VOUCHER') {
            payments.push({ ...base, status: 'FORFEITED', lastError: '抵用券份額不退現' });
          } else if (leg.method === 'LINEPAY') {
            const ref = refs.linePayTxId;
            payments.push({ ...base, status: ref ? 'PENDING' : 'FAILED', originalRef: ref, lastError: ref ? null : '缺少 LINE Pay 交易序號，請改臨櫃現金退款' });
          } else if (leg.method === 'PAYUNI') {
            const ref = refs.payuniTradeNo;
            payments.push({ ...base, status: ref ? 'PENDING' : 'FAILED', originalRef: ref, lastError: ref ? null : '缺少 PayUNi 交易序號，請改臨櫃現金退款' });
          } else if (leg.method === 'YIPAY') {
            payments.push({ ...base, status: 'AWAITING_TERMINAL', origCaptureId: refs.yipayCapture?.id ?? null });
          }
        }

        const refund = await tx.refundRequest.create({
          data: {
            id: refundId,
            kind: plan.kind,
            refType: plan.refType,
            refId: plan.refId,
            checkoutSessionId: plan.checkoutSessionId,
            branchId: plan.branchId,
            memberId: plan.memberId,
            scope: plan.scope,
            lines: plan.lines ?? undefined,
            calc: {
              ...plan.calc,
              clause: plan.clause,
              feeMax: plan.feeMax,
              overrideFeeAmount: plan.overrideFeeAmount,
              invoicePlan: plan.invoicePlan.action,
              subscriptionCancelled,
              rollback: rollback.after,
              ...(Object.keys(approvals).length ? { approvals } : {}),
            },
            grossAmount: plan.grossAmount,
            feeAmount: plan.feeAmount,
            consumedValue: plan.consumedValue,
            payoutAmount: plan.payoutAmount,
            fullRefund: plan.fullRefund,
            signatureRequired: plan.signatureLikely,
            walletCashReversed: rollback.walletCashReversed,
            walletBonusReversed: rollback.walletBonusReversed,
            walletCashCredited,
            reason,
            buyerEmail,
            staffId: user.id,
            idempotencyKey,
            status: paymentPhaseStatus(payments),
            payments: { create: payments },
          },
          include: { payments: true },
        });
        await writeAudit(tx, {
          action: plan.kind === 'TOPUP_VOID' ? 'TOPUP_CANCEL' : 'SUB_ORDER_REFUND',
          refund,
          user,
          req,
          reason,
          before: rollback.before,
          after: {
            ...rollback.after,
            grossAmount: plan.grossAmount,
            feeAmount: plan.feeAmount,
            feeMax: plan.feeMax,
            clause: plan.clause,
            legs: plan.legs.map(({ refs: _refs, ...l }) => l),
            status: refund.status,
          },
        });
        if (approvals.expiredCourse) {
          await writeAudit(tx, { action: 'REFUND_EXPIRED_COURSE_APPROVAL', refund, user, req, reason, after: approvals.expiredCourse });
        }
        if (approvals.shortfall) {
          await writeAudit(tx, { action: 'REFUND_SHORTFALL_CONFIRM', refund, user, req, reason, after: approvals.shortfall });
          if (approvals.shortfall.resolution === 'FLAG_ALERT_FOR_RECOVERY') {
            const recovery = await recordShortfallRecovery(tx, {
              memberId: plan.memberId,
              refundId,
              contractId: plan.calc.contractId,
              amount: approvals.shortfall.amount,
              note: approvals.shortfall.note,
              staffId: user.id,
            });
            await writeAudit(tx, { action: 'REFUND_SHORTFALL_RECOVERY', refund, user, req, reason, ...recovery });
          }
        }
        return refund;
      },
      { timeout: 20000 },
    );
  } catch (err) {
    // 同鍵並發：落敗者等勝者提交後回傳同一張退費單
    const raced = await findIdempotentReplay(user, idempotencyKey, target, opts.mode);
    if (raced) return raced;
    const mapped =
      isUniqueViolation(err) && !err.statusCode ? httpError(409, 'REFUND_IN_PROGRESS', '此子單已有處理中之退費單') : err;
    if (subscriptionCancelled) throw await subscriptionOrphanError(user, target, subscriptionCancelled, reason, mapped, req);
    throw mapped;
  }

  // 乙禾腿待端末退貨：建單即回傳，由櫃檯於退費單回填 RRN／授權碼後再推進
  if (created.status === 'AWAITING_TERMINAL') return serializeRefund(created);
  return withRefundLock(created.id, () => advance(created.id, { user, req }));
}

/** A：計時儲值原單取消（本金／運動金須完整留存） */
export async function executeTopupCancel(user, orderId, { reason, buyerEmail, quoteToken, idempotencyKey } = {}, req = null) {
  const target = await loadTarget(prisma, orderId);
  assertTargetAccess(user, target);
  return executePlan(user, target, { mode: 'TOPUP_VOID', reason, buyerEmail, quoteToken, idempotencyKey }, req);
}

/** B：子單退費（SAL 退貨／TYK 未履約／CRS 月卡／私教） */
export async function executeSubOrderRefund(
  user,
  subOrderId,
  { scope, items, reason, buyerEmail, quoteToken, idempotencyKey, clause, overrideFeeAmount, shortfallResolution, shortfallNote } = {},
  req = null,
) {
  const target = await loadTarget(prisma, subOrderId);
  assertTargetAccess(user, target);
  return executePlan(
    user,
    target,
    { scope, items, reason, buyerEmail, quoteToken, idempotencyKey, clause, overrideFeeAmount, shortfallResolution, shortfallNote },
    req,
  );
}

// ─────────────────────────────────────────────────────────────
// 推進：外部金流 → 發票 → 簽名 → 結案
// ─────────────────────────────────────────────────────────────

async function loadRefund(id, db = prisma) {
  const r = await db.refundRequest.findUnique({ where: { id }, include: { payments: { orderBy: { createdAt: 'asc' } } } });
  if (!r) throw httpError(404, 'REFUND_NOT_FOUND', '找不到退費單');
  return r;
}

async function runProviderLegs(refund, { user, req, checked = false, steps = null }) {
  let sawOnline = false;
  let executed = false;
  let healed = false;
  for (const leg of refund.payments) {
    if (!ONLINE_METHODS.includes(leg.method)) continue;
    sawOnline = true;
    // 檢查點：已退成或已有金流退款序號，禁止再打 LINE Pay／PayUNi（金流成功、發票逾時的二次退刷）
    if (leg.status === 'REFUNDED' || leg.providerRef) {
      if (leg.status !== 'REFUNDED') {
        await prisma.refundPayment.update({
          where: { id: leg.id },
          data: { status: 'REFUNDED', lastError: null, refundedAt: leg.refundedAt || new Date() },
        });
        healed = true;
      }
      continue;
    }
    // 已搶占但沒寫回序號：結果不明。未勾「已確認」不得重打。
    if (leg.status === 'PROCESSING' && !checked) continue;
    if (!['PENDING', 'FAILED', 'PROCESSING'].includes(leg.status) || !leg.originalRef) continue;
    const claimed = await prisma.refundPayment.updateMany({
      where: { id: leg.id, status: { in: checked ? ['PENDING', 'FAILED', 'PROCESSING'] : ['PENDING', 'FAILED'] } },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, lastError: null },
    });
    if (!claimed.count) continue;
    let data;
    try {
      if (leg.method === 'LINEPAY') {
        const res = await refundLinePayPayment({ transactionId: leg.originalRef, refundAmount: leg.amount });
        data = { status: 'REFUNDED', refundedAt: new Date(), providerRef: res?.info?.refundTransactionId ? String(res.info.refundTransactionId) : null };
      } else {
        const fullAmount = leg.refOrderId ? refund.calc?.payuniPaidByOrder?.[leg.refOrderId] : refund.calc?.payuniPaid;
        const res = await refundPayuniTrade({ tradeNo: leg.originalRef, amount: leg.amount, fullAmount: fullAmount ?? null });
        data = res.ok
          ? { status: 'REFUNDED', refundedAt: new Date(), providerRef: res.data?.TradeNo ? String(res.data.TradeNo) : null }
          : { status: 'FAILED', lastError: `${res.ambiguous ? `${AMBIGUOUS_TAG}請先至 PayUNi 後台確認是否已退款｜` : ''}${res.message || 'PayUNi 退款失敗'}`.slice(0, 300) };
      }
    } catch (err) {
      const ambiguous = !err.linePay;
      data = { status: 'FAILED', lastError: `${ambiguous ? `${AMBIGUOUS_TAG}請先至 LINE Pay 後台確認是否已退款｜` : ''}${err.message}`.slice(0, 300) };
    }
    await prisma.refundPayment.update({ where: { id: leg.id }, data });
    if (data.status === 'REFUNDED') executed = true;
    await writeAudit(prisma, {
      action: 'REFUND_PAYMENT',
      refund,
      user,
      req,
      after: { paymentId: leg.id, method: leg.method, amount: leg.amount, status: data.status, error: data.lastError || null },
    });
  }
  if (steps && sawOnline) {
    steps.paymentGatewayStep = executed
      ? 'EXECUTED_AND_COMPLETED'
      : healed
        ? 'HEALED_FROM_EXISTING_TRADE_NO'
        : 'SKIPPED_ALREADY_COMPLETED';
  }
}

async function syncPaymentStatus(id) {
  const r = await loadRefund(id);
  if (!['PAYMENT_PENDING', 'PAYMENT_FAILED', 'AWAITING_TERMINAL', 'GATEWAY_RETRYING'].includes(r.status)) return r;
  const next = paymentPhaseStatus(r.payments);
  if (next === r.status) return r;
  await prisma.refundRequest.updateMany({ where: { id, status: r.status }, data: { status: next } });
  return loadRefund(id);
}

/** ezPay 品名上限 30 字：截短原品名、保留退費依據標註（已用期數／堂數、手續費） */
function annotateItemName(name, note) {
  if (!note) return name;
  const tag = `(${note})`;
  const room = Math.max(4, 30 - [...tag].length);
  return `${[...String(name)].slice(0, room).join('')}${tag}`;
}

function allowanceItemsFor(refund, inv, shared, target, gross = refund.grossAmount) {
  if (shared || refund.refType === 'ORDER') {
    const base = shared ? `子單${refund.refId}退費` : inv.items[0]?.name || target.row.itemDesc || refund.refId;
    const name = annotateItemName(base, refund.calc?.allowanceNote);
    return gross > 0 ? [{ name, qty: 1, unit: '式', gross }] : [];
  }
  const free = inv.taxType === '3';
  return (refund.lines || [])
    .filter((l) => (normalizeTaxType(l.taxType) === 'TAX_FREE') === free)
    .map((l) => {
      const ei = inv.items.find((i) => i.saleItemId === l.orderItemId);
      return {
        name: ei?.name || l.name,
        qty: l.qty,
        unit: ei && ei.qty > 1 ? ei.unit : '個',
        gross: l.gross,
        einvoiceItemId: ei?.id ?? null,
        saleItemId: l.orderItemId,
      };
    });
}

function allowanceContextOf(refund) {
  return {
    source: refund.kind === 'TOPUP_VOID' ? 'TOPUP_VOID' : 'SUB_ORDER_REFUND',
    refundId: refund.id,
    subOrderId: refund.refId,
    reason: refund.reason,
    memberId: refund.memberId,
    ...(refund.refType === 'SALE' ? { saleOrderId: refund.refId } : { orderId: refund.refId }),
  };
}

/** 發票階段最近一次失敗（結果不明之折讓帶 held 預占；作廢帶 op='VOID'） */
function invoiceFailureOf(refund) {
  const list = Array.isArray(refund.invoiceResults) ? refund.invoiceResults : [];
  return list.find((x) => !x.done) || null;
}

/** 線上腿沒有退款序號，且前次仍在處理中或被標成結果不明：重打前必須收到 confirmGatewayNotRefunded */
function gatewayRecallUnsafe(payments) {
  return (payments || []).some(
    (p) =>
      ONLINE_METHODS.includes(p.method) &&
      !p.providerRef &&
      (p.status === 'PROCESSING' || (p.status === 'FAILED' && String(p.lastError || '').startsWith(AMBIGUOUS_TAG))),
  );
}

async function runInvoicePhase(refund, { user, req, checked = false, steps = null }) {
  await assertYipayTerminalSettled(prisma, refund.id);
  const prevResults = Array.isArray(refund.invoiceResults) ? refund.invoiceResults : [];
  const lastFailure = invoiceFailureOf(refund);
  if (lastFailure?.held) {
    // invoice_search 不回折讓號，也不保證 RemainAmt。比對餘額後把本地單號當成 ezPay 折讓號會做假帳。
    // 預占保留，禁止重送 allowance_issue；由 DUTY+ 核對後台折讓號再結案。
    throw httpError(
      409,
      'INVOICE_RESULT_UNKNOWN',
      `發票 ${lastFailure.invoiceNumber} 折讓結果不明：請至 ezPay 後台核對後，以「核對藍新結果」補登折讓號或確認未開立`,
    );
  }
  const recheckVoidId = lastFailure?.ambiguous && lastFailure.op === 'VOID' ? lastFailure.einvoiceId : null;
  if (lastFailure?.ambiguous && !recheckVoidId && !checked) {
    throw httpError(409, 'RETRY_NEEDS_CHECK', '上次 ezPay 呼叫結果不明，請先至 ezPay 後台確認是否已開立折讓，再勾選「已確認」重試');
  }
  const target = await loadTarget(prisma, refund.refId);
  let invoices;
  let shared;
  /** 課程分期：einvoiceId → 該期 { orderId, gross, full, action } */
  let jobMeta = null;
  if (refund.calc?.orderKind === 'COURSE_SUB') {
    let jobs;
    try {
      jobs = await installmentInvoiceJobs(prisma, refund.calc.allocations);
    } catch (err) {
      await prisma.refundRequest.update({ where: { id: refund.id }, data: { status: 'INVOICE_FAILED', lastError: String(err.message).slice(0, 500) } });
      await writeAudit(prisma, { action: 'REFUND_INVOICE', refund, user, req, after: { status: 'INVOICE_FAILED', error: err.message } });
      return loadRefund(refund.id);
    }
    invoices = jobs.map((j) => j.inv);
    shared = false;
    jobMeta = new Map(jobs.map((j) => [j.inv.id, j]));
  } else {
    ({ invoices, shared } = await loadRefInvoices(prisma, target));
  }
  const done = new Map(prevResults.filter((x) => x.done).map((x) => [x.einvoiceId, x]));
  const pending = (jobMeta ? invoices : relevantInvoices(target, invoices, refund.lines, shared)).filter((inv) => !done.has(inv.id));

  // 不明結果之折讓：若 ezPay 實已開立且已寫入紀錄，直接視為完成
  for (const inv of [...pending]) {
    const rec = await prisma.invoiceAllowance.findFirst({ where: { refundId: refund.id, einvoiceId: inv.id }, select: { id: true, allowanceNo: true } });
    if (rec) {
      done.set(inv.id, { einvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, action: 'ALLOWANCE', allowanceId: rec.id, allowanceNo: rec.allowanceNo, category: inv.category, done: true });
      pending.splice(pending.indexOf(inv), 1);
    }
  }

  let action = refund.invoiceAction;
  const results = [...done.values()];
  if (!pending.length && steps && steps.ezPayInvoiceStep === 'NOT_APPLICABLE') {
    if (action === 'VOID' || refund.invoiceAction === 'VOID') steps.ezPayInvoiceStep = 'SKIPPED_INVOICE_ALREADY_VOIDED';
    else if (action === 'ALLOWANCE' || refund.invoiceAction === 'ALLOWANCE') steps.ezPayInvoiceStep = 'SKIPPED_ALLOWANCE_ALREADY_ISSUED';
  }
  let failure = null;
  try {
    if (!action) {
      action = jobMeta
        ? aggregateInvoiceAction([...jobMeta.values()])
        : decideInvoiceActions({ invoices: pending, fullRefund: refund.fullRefund, sharedInvoice: shared }).action;
    }
    const allowanceCtx = allowanceContextOf(refund);
    for (const inv of pending) {
      const job = jobMeta?.get(inv.id) ?? null;
      if (inv.status === 'ISSUING') throw httpError(409, 'INVOICE_ISSUING', `發票 ${inv.id} 開立中，請稍候重試`);
      if (inv.status === 'PENDING' || inv.status === 'FAILED') {
        if (!(job ? job.full : refund.fullRefund)) throw httpError(409, 'INVOICE_NOT_ISSUED', '發票尚未開立，不得部分退費（請先補開發票）');
        const c = await prisma.eInvoice.updateMany({
          where: { id: inv.id, status: { in: ['PENDING', 'FAILED'] } },
          data: { status: 'CANCELLED', voidReason: `退費 ${refund.id}`.slice(0, 100), voidedAt: new Date(), nextRetryAt: null },
        });
        if (!c.count) throw httpError(409, 'INVOICE_ISSUING', `發票 ${inv.id} 狀態已變更，請重試`);
        results.push({ einvoiceId: inv.id, invoiceNumber: null, action: 'CANCEL', category: inv.category, done: true });
        continue;
      }
      let doAllowance = (job ? job.action : action) !== 'VOID';
      if (!doAllowance) {
        try {
          const v = await voidEInvoice(inv.invoiceNumber, {
            reason: refund.reason,
            staffId: user?.id ?? null,
            checkRemoteFirst: inv.id === recheckVoidId,
          });
          results.push({
            einvoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            action: 'VOID',
            category: inv.category,
            done: true,
            ...(v.remoteAlreadyVoided ? { remoteAlreadyVoided: true } : {}),
          });
          if (steps) steps.ezPayInvoiceStep = v.remoteAlreadyVoided ? 'HEALED_VOID_FROM_EZPAY_REMOTE_QUERY' : 'EXECUTED_EZPAY_VOID';
        } catch (e) {
          if (e.code !== 'INVOICE_CROSS_PERIOD' && e.code !== 'INVOICE_HAS_ALLOWANCE') {
            e.einvoiceId = inv.id;
            e.invoiceNumber = inv.invoiceNumber;
            e.op = 'VOID';
            throw e;
          }
          doAllowance = true;
        }
      }
      if (doAllowance) {
        const items = allowanceItemsFor(refund, inv, shared, target, job ? job.gross : refund.grossAmount);
        if (!items.length) {
          results.push({ einvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, action: 'NONE', category: inv.category, done: true });
          continue;
        }
        try {
          const a = await allowanceEInvoice(inv.invoiceNumber, {
            items,
            itemDesc: `${job?.orderId ?? refund.refId} 退費`,
            buyerEmail: refund.buyerEmail,
            staffId: user?.id ?? null,
            holdOnAmbiguous: true,
            context: job ? { ...allowanceCtx, orderId: job.orderId } : allowanceCtx,
          });
          results.push({
            einvoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            action: 'ALLOWANCE',
            allowanceId: a.record?.id ?? null,
            allowanceNo: a.allowanceNo,
            amount: a.allowanceAmt,
            category: inv.category,
            done: true,
          });
          if (steps) steps.ezPayInvoiceStep = 'EXECUTED_EZPAY_ALLOWANCE';
        } catch (e) {
          e.einvoiceId = inv.id;
          e.invoiceNumber = inv.invoiceNumber;
          e.op = 'ALLOWANCE';
          throw e;
        }
      }
    }
  } catch (err) {
    failure = err;
    results.push({
      einvoiceId: err.einvoiceId ?? null,
      invoiceNumber: err.invoiceNumber ?? null,
      action: action || null,
      op: err.op ?? null,
      done: false,
      ambiguous: Boolean(err.ambiguous),
      ...(err.heldAllowance ? { held: err.heldAllowance, category: invoices.find((i) => i.id === err.einvoiceId)?.category ?? null } : {}),
      error: String(err.message).slice(0, 300),
    });
  }

  const finalResults = results.filter((x, i, arr) => x.done || i === arr.length - 1);
  if (failure) {
    await prisma.refundRequest.update({
      where: { id: refund.id },
      data: {
        status: 'INVOICE_FAILED',
        invoiceAction: action || null,
        invoiceResults: finalResults,
        lastError: `${failure.ambiguous ? AMBIGUOUS_TAG : ''}${failure.message}`.slice(0, 500),
      },
    });
    await writeAudit(prisma, { action: 'REFUND_INVOICE', refund, user, req, after: { status: 'INVOICE_FAILED', error: failure.message } });
    return loadRefund(refund.id);
  }

  const signatureRequired = finalResults.some((x) => x.action === 'ALLOWANCE' && x.category === 'B2B');
  await prisma.refundRequest.update({
    where: { id: refund.id },
    data: {
      status: signatureRequired && !refund.signatureId ? 'SIGNATURE_PENDING' : 'INVOICE_PENDING',
      invoiceAction: action || 'NONE',
      invoiceResults: finalResults,
      signatureRequired,
      lastError: null,
    },
  });
  await writeAudit(prisma, { action: 'REFUND_INVOICE', refund, user, req, after: { invoiceAction: action || 'NONE', results: finalResults } });
  const r = await loadRefund(refund.id);
  if (r.status === 'SIGNATURE_PENDING') return r;
  return finalizeRefund(r, { user, req });
}

async function finalizeRefund(refund, { user, req }) {
  await prisma.$transaction(async (tx) => {
    await assertYipayTerminalSettled(tx, refund.id);
    const done = await tx.refundRequest.updateMany({
      where: { id: refund.id, status: { in: ['INVOICE_PENDING', 'SIGNATURE_PENDING'] } },
      data: { status: 'COMPLETED', completedAt: new Date(), lastError: null },
    });
    if (!done.count) return;
    if (refund.signatureId) {
      await tx.invoiceAllowance.updateMany({ where: { refundId: refund.id }, data: { signatureId: refund.signatureId } });
    }
    await writeAudit(tx, { action: 'REFUND_COMPLETE', refund, user, req, after: { status: 'COMPLETED' } });
  });
  return loadRefund(refund.id);
}

function inferGatewayPhase(r) {
  const pays = (r.payments || []).filter((p) => !['FORFEITED', 'CANCELLED', 'REVERSED'].includes(p.status));
  const onlineOpen = pays.some(
    (p) => ONLINE_METHODS.includes(p.method) && ['PENDING', 'FAILED', 'PROCESSING'].includes(p.status) && !p.providerRef,
  );
  if (onlineOpen) return pays.some((p) => p.status === 'FAILED') ? 'PAYMENT_FAILED' : 'PAYMENT_PENDING';
  if (pays.some((p) => p.method === 'YIPAY' && p.status === 'AWAITING_TERMINAL')) return 'AWAITING_TERMINAL';
  const results = Array.isArray(r.invoiceResults) ? r.invoiceResults : [];
  const invoiceDone = results.length > 0 && results.every((x) => x.done) && !invoiceFailureOf(r);
  if (invoiceDone && r.signatureRequired && !r.signatureId) return 'SIGNATURE_PENDING';
  return invoiceDone ? 'INVOICE_PENDING' : 'INVOICE_FAILED';
}

async function advance(id, { user, req, checked = false, confirmGatewayNotRefunded = false, steps = null }) {
  let r = await loadRefund(id);
  const phase = r.status === 'GATEWAY_RETRYING' ? inferGatewayPhase(r) : r.status;
  if (phase === 'AWAITING_TERMINAL') {
    await prisma.refundRequest.updateMany({
      where: { id, status: 'GATEWAY_RETRYING' },
      data: { status: 'AWAITING_TERMINAL' },
    });
    throw httpError(409, 'YIPAY_TERMINAL_VOUCHER_REQUIRED', '此筆為乙禾實體刷卡機交易且尚未登錄退貨 RRN／授權碼，請先於端末完成退貨後回填');
  }
  const online = (r.payments || []).filter((p) => ONLINE_METHODS.includes(p.method));
  const recallUnsafe = gatewayRecallUnsafe(r.payments);
  if (['PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(phase) || online.some((p) => p.status !== 'REFUNDED')) {
    if (recallUnsafe && confirmGatewayNotRefunded !== true) {
      throw httpError(409, 'RETRY_NEEDS_CHECK', '上次退款結果不明且沒有退款序號。須由值班主管確認金流後台未完成退刷後才可重試，避免雙重退刷');
    }
    await runProviderLegs(r, { user, req, checked: confirmGatewayNotRefunded === true || checked, steps });
    r = await syncPaymentStatus(id);
  } else if (online.length && steps) {
    steps.paymentGatewayStep = 'SKIPPED_ALREADY_COMPLETED';
  }
  if (['INVOICE_PENDING', 'INVOICE_FAILED'].includes(r.status) || (r.status === 'GATEWAY_RETRYING' && ['INVOICE_PENDING', 'INVOICE_FAILED'].includes(phase))) {
    r = await runInvoicePhase(r, { user, req, checked, steps });
  }
  if ((r.status === 'SIGNATURE_PENDING' || phase === 'SIGNATURE_PENDING') && r.signatureId) {
    if (r.status === 'GATEWAY_RETRYING') {
      await prisma.refundRequest.updateMany({ where: { id, status: 'GATEWAY_RETRYING' }, data: { status: 'SIGNATURE_PENDING' } });
      r = await loadRefund(id);
    }
    r = await finalizeRefund(r, { user, req });
  } else if (r.status === 'GATEWAY_RETRYING' && phase === 'SIGNATURE_PENDING') {
    await prisma.refundRequest.updateMany({ where: { id, status: 'GATEWAY_RETRYING' }, data: { status: 'SIGNATURE_PENDING' } });
    r = await loadRefund(id);
  }
  return serializeRefund(r);
}

// ─────────────────────────────────────────────────────────────
// 人工操作：乙禾確認、改臨櫃現金、重試、中止
// ─────────────────────────────────────────────────────────────

async function loadRefundForStaff(user, id) {
  const r = await loadRefund(String(id || '').trim().toUpperCase());
  if (r.branchId == null) {
    if (!isCrossBranchUser(user)) throw httpError(404, 'REFUND_NOT_FOUND', '找不到退費單');
  } else if (!canAccessBranch(user, r.branchId)) {
    throw httpError(404, 'REFUND_NOT_FOUND', '找不到退費單');
  }
  return r;
}

async function claimGatewayRetry(id, { retryNote } = {}) {
  return prisma.$transaction(async (tx) => {
    const target = await lockRefundRow(tx, id);
    if (!target) throw httpError(404, 'REFUND_NOT_FOUND', '找不到退費單');
    if (target.status === 'COMPLETED') return { alreadyCompleted: true };
    if (target.status === 'AWAITING_TERMINAL') {
      throw httpError(409, 'YIPAY_TERMINAL_VOUCHER_REQUIRED', '此筆為乙禾實體刷卡機交易且尚未登錄退貨 RRN／授權碼，請先於端末完成退貨後回填');
    }
    const age = Date.now() - new Date(target.updatedAt).getTime();
    const staleClaim = target.status === 'GATEWAY_RETRYING' && age >= GATEWAY_CLAIM_STALE_MS;
    if (target.status === 'GATEWAY_RETRYING' && !staleClaim) {
      throw httpError(409, 'REFUND_RETRY_IN_PROGRESS', RETRY_BUSY);
    }
    if (!RETRYABLE_STATUSES.includes(target.status) && !staleClaim) {
      throw httpError(409, 'REFUND_NOT_RETRYABLE', `退費單狀態 ${target.status} 不可重試`);
    }
    const data = { status: 'GATEWAY_RETRYING' };
    const note = String(retryNote || '').trim().slice(0, 50);
    if (note) data.reason = `${target.reason || ''} [重試備註: ${note}]`.slice(0, 200);
    await tx.refundRequest.update({ where: { id }, data });
    return { alreadyCompleted: false, previousStatus: staleClaim ? null : target.status };
  });
}

async function restoreGatewayClaim(id, previousStatus) {
  const fallback = RETRYABLE_STATUSES.includes(previousStatus) ? previousStatus : 'INVOICE_FAILED';
  await prisma.refundRequest.updateMany({
    where: { id, status: 'GATEWAY_RETRYING' },
    data: { status: fallback },
  });
}

async function runGatewayRetry(user, id, { checked = false, retryNote, confirmGatewayNotRefunded = false } = {}, req = null) {
  if (!hasDutyRankOrAbove(user)) {
    throw httpError(403, 'DUTY_ROLE_REQUIRED_FOR_RETRY', '僅限值班主管（DUTY+）以上權限可執行異常退費單同步重試');
  }
  const r = await loadRefundForStaff(user, id);
  const gatewayConfirmed = confirmGatewayNotRefunded === true;
  if (gatewayRecallUnsafe(r.payments) && !gatewayConfirmed) {
    throw httpError(409, 'RETRY_NEEDS_CHECK', '上次退款結果不明且沒有退款序號。須由值班主管確認金流後台未完成退刷後才可重試，避免雙重退刷');
  }
  return withRefundLock(r.id, async () => {
    const claimed = await claimGatewayRetry(r.id, { retryNote });
    if (claimed.alreadyCompleted) {
      const done = serializeRefund(await loadRefund(r.id));
      return { reconciledAction: 'ALREADY_COMPLETED', stepSummary: null, refund: done };
    }
    if (gatewayConfirmed && gatewayRecallUnsafe(r.payments)) {
      const confirmedAt = new Date().toISOString();
      await writeAudit(prisma, {
        action: 'REFUND_GATEWAY_CONFIRM',
        refund: r,
        user,
        req,
        after: {
          confirmGatewayNotRefunded: true,
          confirmedByStaffId: user?.id ?? null,
          confirmedAt,
        },
      });
    }
    await writeAudit(prisma, { action: 'REFUND_RETRY', refund: r, user, req, before: { status: r.status }, reason: retryNote || null });
    const steps = { paymentGatewayStep: 'NOT_APPLICABLE', ezPayInvoiceStep: 'NOT_APPLICABLE' };
    try {
      let refund = await advance(r.id, { user, req, checked: Boolean(checked), confirmGatewayNotRefunded: gatewayConfirmed, steps });
      if (refund.status === 'GATEWAY_RETRYING') {
        await restoreGatewayClaim(r.id, claimed.previousStatus);
        refund = serializeRefund(await loadRefund(r.id));
      }
      return {
        reconciledAction: refund.status === 'COMPLETED' || refund.status === 'SIGNATURE_PENDING' ? 'RETRIED_AND_COMPLETED' : 'RETRIED',
        stepSummary: steps,
        refund,
      };
    } catch (err) {
      await restoreGatewayClaim(r.id, claimed.previousStatus);
      throw err;
    }
  }, { busyCode: 'REFUND_RETRY_IN_PROGRESS', busyMessage: RETRY_BUSY });
}

export async function retryRefund(user, id, { checked = false, confirmGatewayNotRefunded = false } = {}, req = null) {
  const out = await runGatewayRetry(user, id, { checked, confirmGatewayNotRefunded }, req);
  return out.refund;
}

/**
 * FAILED／待補發票退費單的分段重試。
 * 短交易 FOR UPDATE NOWAIT 把狀態切成 GATEWAY_RETRYING 後立刻提交，外部 API 不在鎖內。
 * 已完成的金流腿直接跳過；作廢先查 invoice_search。折讓結果不明不重送（見 runInvoicePhase）。
 */
export async function retryGateway(user, id, { checked = false, retryNote, confirmGatewayNotRefunded = false } = {}, req = null) {
  return runGatewayRetry(user, id, { checked, retryNote, confirmGatewayNotRefunded }, req);
}

/** C：乙禾端末退貨完成後回填憑證（兩段式；未確認前退費單不結案） */
export async function confirmYipayRefund(user, id, paymentId, { rrn, authCode, cardLast4, terminalRef } = {}, req = null) {
  const r = await loadRefundForStaff(user, id);
  const leg = r.payments.find((p) => p.id === String(paymentId || '').trim());
  if (!leg || leg.method !== 'YIPAY') throw httpError(404, 'REFUND_PAYMENT_NOT_FOUND', '找不到乙禾退款腿');
  if (leg.status !== 'AWAITING_TERMINAL') throw httpError(409, 'REFUND_PAYMENT_STATE', `此退款腿狀態為 ${leg.status}`);
  const rrnS = String(rrn || '').trim();
  const authS = String(authCode || '').trim().toUpperCase();
  const last4 = String(cardLast4 || '').trim();
  if (!/^[0-9A-Za-z]{6,12}$/.test(rrnS)) throw httpError(400, 'YIPAY_RRN_INVALID', 'RRN（調閱編號）須為 6～12 碼英數字');
  if (!/^[0-9A-Z]{6}$/.test(authS)) throw httpError(400, 'YIPAY_AUTH_INVALID', '授權碼須為 6 碼英數字');
  if (!/^\d{4}$/.test(last4)) throw httpError(400, 'YIPAY_CARD_INVALID', '卡號末四碼須為 4 位數字');
  if (leg.origCaptureId) {
    const cap = await prisma.yipayTerminalCapture.findUnique({ where: { id: leg.origCaptureId }, select: { cardLast4: true } });
    if (cap?.cardLast4 && cap.cardLast4 !== last4) {
      throw httpError(409, 'CARD_MISMATCH', '退貨卡號末四碼與原交易不符，須退回原刷卡');
    }
  }
  const dup = await prisma.refundPayment.findFirst({ where: { method: 'YIPAY', rrn: rrnS, status: 'REFUNDED' }, select: { id: true } });
  if (dup) throw httpError(409, 'YIPAY_RRN_DUPLICATE', `RRN ${rrnS} 已用於其他退款`);

  await prisma.$transaction(async (tx) => {
    await assertRefundIdle(tx, r.id);
    const ok = await tx.refundPayment.updateMany({
      where: { id: leg.id, status: 'AWAITING_TERMINAL' },
      data: {
        status: 'REFUNDED',
        rrn: rrnS,
        authCode: authS,
        cardLast4: last4,
        terminalRef: terminalRef ? String(terminalRef).trim().slice(0, 40) : null,
        refundedAt: new Date(),
        staffId: user?.id ?? null,
      },
    });
    if (!ok.count) throw httpError(409, 'REFUND_PAYMENT_STATE', '此退款腿已處理');
    await writeAudit(tx, { action: 'REFUND_YIPAY_CONFIRM', refund: r, user, req, after: { paymentId: leg.id, amount: leg.amount, rrn: rrnS, cardLast4: last4 } });
  }).catch((e) => {
    if (e?.code === 'P2002') throw httpError(409, 'YIPAY_RRN_DUPLICATE', `RRN ${rrnS} 已用於其他退款`);
    throw e;
  });
  return withRefundLock(r.id, async () => {
    await syncPaymentStatus(r.id);
    return advance(r.id, { user, req });
  });
}

/** 線上退款失敗／端末無法退貨：改臨櫃現金退款（須開班、附原因） */
export async function fallbackRefundToCash(user, id, paymentId, { reason, confirmGatewayNotRefunded = false } = {}, req = null) {
  const why = normalizeRefundReason(reason);
  const r = await loadRefundForStaff(user, id);
  const leg = r.payments.find((p) => p.id === String(paymentId || '').trim());
  if (!leg) throw httpError(404, 'REFUND_PAYMENT_NOT_FOUND', '找不到退款腿');
  const allowed =
    (ONLINE_METHODS.includes(leg.method) && leg.status === 'FAILED') || (leg.method === 'YIPAY' && leg.status === 'AWAITING_TERMINAL');
  if (!allowed) throw httpError(409, 'REFUND_PAYMENT_STATE', '僅失敗之線上退款或待端末確認之乙禾退款可改臨櫃現金');
  const gatewayConfirmed = confirmGatewayNotRefunded === true;
  const ambiguous = !leg.providerRef && String(leg.lastError || '').startsWith(AMBIGUOUS_TAG);
  if (ambiguous && !gatewayConfirmed) {
    throw httpError(409, 'RETRY_NEEDS_CHECK', '上次退款結果不明且沒有退款序號。須確認金流後台未完成退刷後才可改臨櫃現金');
  }
  await prisma.$transaction(async (tx) => {
    await assertRefundIdle(tx, r.id);
    const shiftId = await lockOpenShiftForSale(tx, r.branchId);
    const ok = await tx.refundPayment.updateMany({
      where: { id: leg.id, status: leg.status },
      data: { status: 'CANCELLED', lastError: `改臨櫃現金：${why}`.slice(0, 300) },
    });
    if (!ok.count) throw httpError(409, 'REFUND_PAYMENT_STATE', '此退款腿已處理');
    const cash = await tx.refundPayment.create({
      data: {
        id: genId('RFP'),
        refundId: r.id,
        method: 'CASH',
        amount: leg.amount,
        status: 'REFUNDED',
        refundedAt: new Date(),
        shiftHandoverId: shiftId,
        staffId: user?.id ?? null,
        lastError: `由 ${leg.method} 改臨櫃現金`,
      },
    });
    await writeAudit(tx, {
      action: 'REFUND_PAYMENT',
      refund: r,
      user,
      req,
      reason: why,
      before: { paymentId: leg.id, method: leg.method, status: leg.status },
      after: {
        paymentId: cash.id,
        method: 'CASH',
        amount: cash.amount,
        ...(gatewayConfirmed
          ? { confirmGatewayNotRefunded: true, confirmedByStaffId: user?.id ?? null, confirmedAt: new Date().toISOString() }
          : {}),
      },
    });
  });
  return withRefundLock(r.id, async () => {
    await syncPaymentStatus(r.id);
    return advance(r.id, { user, req });
  });
}

/**
 * 折讓結果不明（預占保留中）之人工處置，限 DUTY+、必填原因：
 * - ISSUED：已於 ezPay 後台查得折讓號 → 以預占內容補登折讓單，接續簽名／結案
 * - NOT_ISSUED：確認 ezPay 未開立 → 釋放預占，接續重開折讓
 */
export async function resolveInvoiceOutcome(user, id, { einvoiceId, outcome, allowanceNo, ezPayAllowanceNo, reason, confirmEzPayNotIssued = false } = {}, req = null) {
  const why = normalizeRefundReason(reason);
  const kind = String(outcome || '').trim().toUpperCase();
  if (!['ISSUED', 'NOT_ISSUED'].includes(kind)) throw httpError(400, 'OUTCOME_INVALID', 'outcome 須為 ISSUED（已開立）或 NOT_ISSUED（未開立）');
  const allowanceNoInput = String(ezPayAllowanceNo || allowanceNo || '').trim();
  if (kind === 'ISSUED' && !allowanceNoInput) {
    throw httpError(400, 'ALLOWANCE_NO_REQUIRED', '已開立須填寫 ezPay 後台所示之折讓號（ezPayAllowanceNo）');
  }
  const r0 = await loadRefundForStaff(user, id);

  return withRefundLock(r0.id, async () => {
    const r = await loadRefund(r0.id);
    const fail = invoiceFailureOf(r);
    if (r.status !== 'INVOICE_FAILED' || !fail?.held) {
      throw httpError(409, 'NO_UNRESOLVED_INVOICE', '此退費單沒有待核對之折讓結果');
    }
    if (String(einvoiceId || '') !== fail.einvoiceId) {
      throw httpError(409, 'INVOICE_MISMATCH', `待核對之發票為 ${fail.invoiceNumber}，請重新整理`);
    }
    if (kind === 'NOT_ISSUED' && confirmEzPayNotIssued !== true) {
      throw httpError(409, 'EZPAY_NOT_ISSUED_UNCONFIRMED', '確認藍新未開立必須帶 confirmEzPayNotIssued=true。未收到主管確認，不得釋放預占或重開折讓');
    }
    const held = fail.held;
    const confirmedAt = new Date().toISOString();
    const kept = (Array.isArray(r.invoiceResults) ? r.invoiceResults : []).filter((x) => x.done);
    const before = { einvoiceId: held.einvoiceId, invoiceNumber: held.invoiceNumber, heldTotal: held.total, error: fail.error };

    if (kind === 'ISSUED') {
      const no = allowanceNoInput.toUpperCase();
      const existing = await prisma.invoiceAllowance.findUnique({ where: { allowanceNo: no }, select: { id: true, refundId: true, einvoiceId: true } });
      const record =
        existing && existing.refundId === r.id && existing.einvoiceId === held.einvoiceId
          ? existing
          : (await settleHeldAllowance(held, { allowanceNo: no, staffId: user?.id ?? null, context: allowanceContextOf(r) })).record;
      const entry = {
        einvoiceId: held.einvoiceId,
        invoiceNumber: held.invoiceNumber,
        action: 'ALLOWANCE',
        allowanceId: record?.id ?? null,
        allowanceNo: no,
        amount: held.total,
        category: fail.category ?? null,
        done: true,
        resolvedManually: true,
      };
      await prisma.$transaction(async (tx) => {
        const ok = await tx.refundRequest.updateMany({
          where: { id: r.id, status: 'INVOICE_FAILED' },
          data: { invoiceResults: [...kept, entry], lastError: null },
        });
        if (!ok.count) throw httpError(409, 'REFUND_STATE_CHANGED', '退費單狀態已變更，請重新整理');
        await writeAudit(tx, {
          action: 'REFUND_INVOICE_RESOLVE',
          refund: r,
          user,
          req,
          reason: why,
          before,
          after: { outcome: kind, ezPayAllowanceNo: no, allowanceNo: no, confirmedByStaffId: user?.id ?? null, confirmedAt },
        });
      });
    } else {
      await prisma.$transaction(async (tx) => {
        const ok = await tx.refundRequest.updateMany({
          where: { id: r.id, status: 'INVOICE_FAILED' },
          data: { invoiceResults: kept, lastError: null },
        });
        if (!ok.count) throw httpError(409, 'REFUND_STATE_CHANGED', '退費單狀態已變更，請重新整理');
        await releaseHeldAllowance(tx, held);
        await writeAudit(tx, {
          action: 'REFUND_INVOICE_RESOLVE',
          refund: r,
          user,
          req,
          reason: why,
          before,
          after: {
            outcome: kind,
            released: held.total,
            confirmEzPayNotIssued: true,
            confirmedByStaffId: user?.id ?? null,
            confirmedAt,
          },
        });
      });
      await writeEInvoiceLog({
        einvoiceId: held.einvoiceId,
        action: 'ALLOWANCE',
        result: 'FAILED',
        manual: true,
        staffId: user?.id ?? null,
        errorCode: 'CONFIRMED_NOT_ISSUED',
        invoiceNumber: held.invoiceNumber,
        message: `人工確認 ezPay 未開立折讓，釋放預占 $${held.total}`,
      });
    }
    return advance(r.id, { user, req });
  });
}

/** 中止：僅限尚無外部管道退款且發票未處理；第一段交易之權益回收與現金／零錢包全數沖回 */
export async function abortRefund(user, id, { reason } = {}, req = null) {
  const why = normalizeRefundReason(reason);
  const r = await loadRefundForStaff(user, id);
  if (['COMPLETED', 'ABORTED'].includes(r.status)) throw httpError(409, 'REFUND_NOT_ABORTABLE', `退費單狀態 ${r.status} 不可中止`);
  if (!canAbortRefund(r.payments)) throw httpError(409, 'ABORT_FORBIDDEN', '已有線上／乙禾退款完成，不可中止（請改重試或改臨櫃現金）');
  if ((Array.isArray(r.invoiceResults) ? r.invoiceResults : []).some((x) => x.done && x.action !== 'NONE')) {
    throw httpError(409, 'ABORT_FORBIDDEN', '發票已作廢／折讓，不可中止');
  }
  const invoiceFailure = invoiceFailureOf(r);
  if (invoiceFailure?.held || invoiceFailure?.ambiguous) {
    throw httpError(409, 'INVOICE_RESULT_UNKNOWN', 'ezPay 作廢／折讓結果不明（可能已成立），不可中止；請先核對藍新結果或重試');
  }

  return withRefundLock(r.id, async () => {
    await prisma.$transaction(async (tx) => {
      await assertRefundIdle(tx, r.id);
      const fresh = await loadRefund(r.id, tx);
      if (['COMPLETED', 'ABORTED'].includes(fresh.status)) throw httpError(409, 'REFUND_NOT_ABORTABLE', '退費單狀態已變更');
      const target = await loadTarget(tx, fresh.refId);
      await lockTargetRow(tx, target);
      const meta = { refType: fresh.refType, refId: fresh.refId, refundId: fresh.id, staffId: user?.id };
      const calc = fresh.calc || {};

      // 退款腿沖回
      for (const p of fresh.payments) {
        if (p.method === 'CASH' && p.status === 'REFUNDED') {
          const shift = p.shiftHandoverId
            ? await tx.shiftHandover.findUnique({ where: { id: p.shiftHandoverId }, select: { status: true } })
            : null;
          if (shift && shift.status !== 'OPEN') throw httpError(409, 'ABORT_FORBIDDEN', '現金退款之班次已交班，不可中止');
          await tx.refundPayment.update({ where: { id: p.id }, data: { status: 'REVERSED', lastError: `中止：${why}`.slice(0, 300) } });
        } else if (p.method === 'WALLET_CASH' && p.status === 'REFUNDED') {
          await mutateMemberWallet(tx, {
            memberId: fresh.memberId,
            txType: WALLET_TX.REFUND_ABORT,
            mode: WALLET_MODE.EXACT_BUCKETS_DEDUCT,
            cashDeduct: p.amount,
            bonusDeduct: 0,
            reason: `退費中止沖回零錢包退款：${why}`,
            branchId: fresh.branchId,
            insufficient: { code: 'ABORT_FORBIDDEN', message: '退回零錢包之金額已被動用，不可中止' },
            ...meta,
          });
          await tx.refundPayment.update({ where: { id: p.id }, data: { status: 'REVERSED', lastError: `中止：${why}`.slice(0, 300) } });
        } else if (!['REFUNDED', 'REVERSED', 'CANCELLED'].includes(p.status)) {
          await tx.refundPayment.update({ where: { id: p.id }, data: { status: 'CANCELLED', lastError: `中止：${why}`.slice(0, 300) } });
        }
      }

      // 權益回補
      if (fresh.walletCashReversed > 0 || fresh.walletBonusReversed > 0) {
        await mutateMemberWallet(tx, {
          memberId: fresh.memberId,
          txType: WALLET_TX.REFUND_ABORT,
          mode: WALLET_MODE.CREDIT_BUCKETS,
          cashDelta: fresh.walletCashReversed,
          bonusDelta: fresh.walletBonusReversed,
          reason: `退費中止回補已回收之儲值：${why}`,
          branchId: fresh.branchId,
          ...meta,
        });
      }
      if (fresh.refType === 'SALE') {
        for (const line of fresh.lines || []) {
          const item = target.row.items.find((i) => i.id === line.orderItemId);
          await tx.saleItem.update({ where: { id: item.id }, data: { refundedQty: { decrement: line.qty } } });
          if (tracksInventory(item.product)) {
            await applyStockDelta(tx, {
              branchId: target.row.branchId,
              productId: item.productId,
              delta: -line.qty,
              refType: 'SALE_RETURN_ABORT',
              refId: target.row.id,
              refLineId: item.id,
              reason: `退貨中止 ${fresh.id}`,
              staffId: user?.id ?? null,
            });
          }
        }
        await tx.saleOrder.update({
          where: { id: target.row.id },
          data: { refundedAmount: { decrement: fresh.grossAmount }, status: 'PAID' },
        });
      } else {
        if (calc.orderKind === 'MEMBERSHIP' && calc.memberBefore) {
          await lockMemberRow(tx, fresh.memberId);
          await tx.member.update({
            where: { id: fresh.memberId },
            data: {
              expireDate: calc.memberBefore.expireDate ? new Date(calc.memberBefore.expireDate) : null,
              plan: calc.memberBefore.plan,
              leaveUntil: calc.memberBefore.leaveUntil ? new Date(calc.memberBefore.leaveUntil) : null,
            },
          });
          const leaveIds = calc.rollback?.endedLeaveIds || [];
          if (leaveIds.length) {
            await tx.memberLeave.updateMany({ where: { id: { in: leaveIds }, status: 'ENDED' }, data: { status: 'ACTIVE', endedAt: null } });
          }
        }
        if ((calc.orderKind === 'PT' || calc.orderKind === 'COURSE_SUB') && calc.contractId) {
          await tx.pTContract.update({ where: { id: calc.contractId }, data: { isActive: true, refundedAt: null } });
        }
        if (calc.orderKind === 'COURSE_SUB') {
          for (const a of calc.allocations || []) {
            await tx.order.update({ where: { id: a.orderId }, data: { status: 'PAID', refundedAmount: { decrement: a.amount } } });
          }
        } else {
          await tx.order.update({
            where: { id: target.row.id },
            data: { status: 'PAID', refundedAmount: { decrement: fresh.grossAmount } },
          });
        }
      }

      await tx.refundRequest.update({
        where: { id: fresh.id },
        data: { status: 'ABORTED', abortedAt: new Date(), abortReason: why },
      });
      await writeAudit(tx, {
        action: 'REFUND_ABORT',
        refund: fresh,
        user,
        req,
        reason: why,
        before: { status: fresh.status },
        after: {
          status: 'ABORTED',
          subscriptionNotRestored: Boolean(calc.subscriptionCancelled),
          bookingsNotRestored: (calc.futureClasses || []).map((c) => c.id),
        },
      });
    }, { timeout: 20000 });
    return serializeRefund(await loadRefund(r.id));
  });
}

// ─────────────────────────────────────────────────────────────
// 查詢
// ─────────────────────────────────────────────────────────────

export function serializeRefund(r) {
  if (!r) return null;
  const calc = r.calc && typeof r.calc === 'object' ? { ...r.calc } : {};
  delete calc.rollback;
  delete calc.memberBefore;
  const invoiceFailure = invoiceFailureOf(r);
  const invoiceResults = Array.isArray(r.invoiceResults)
    ? r.invoiceResults.map(({ held, ...x }) => (held ? { ...x, heldAmount: held.total } : x))
    : r.invoiceResults;
  return {
    id: r.id,
    kind: r.kind,
    refType: r.refType,
    subOrderId: r.refId,
    checkoutSessionId: r.checkoutSessionId,
    branchId: r.branchId,
    memberId: r.memberId,
    scope: r.scope,
    lines: r.lines,
    calc,
    grossAmount: r.grossAmount,
    feeAmount: r.feeAmount,
    consumedValue: r.consumedValue,
    payoutAmount: r.payoutAmount,
    fullRefund: r.fullRefund,
    invoiceAction: r.invoiceAction,
    invoiceResults,
    invoiceResolve: invoiceFailure?.held
      ? {
          einvoiceId: invoiceFailure.einvoiceId,
          invoiceNumber: invoiceFailure.invoiceNumber,
          amount: invoiceFailure.held.total,
          untaxed: invoiceFailure.held.untaxed,
          tax: invoiceFailure.held.tax,
          category: invoiceFailure.category ?? null,
        }
      : null,
    signatureRequired: r.signatureRequired,
    signed: Boolean(r.signatureId),
    walletCashReversed: r.walletCashReversed,
    walletBonusReversed: r.walletBonusReversed,
    walletCashCredited: r.walletCashCredited,
    reason: r.reason,
    staffId: r.staffId,
    status: r.status,
    lastError: r.lastError,
    needsCheck: String(r.lastError || '').startsWith(AMBIGUOUS_TAG) ||
      (r.payments || []).some((p) => p.status === 'FAILED' && String(p.lastError || '').startsWith(AMBIGUOUS_TAG)),
    completedAt: r.completedAt,
    abortedAt: r.abortedAt,
    abortReason: r.abortReason,
    createdAt: r.createdAt,
    payments: (r.payments || []).map((p) => ({
      id: p.id,
      method: p.method,
      amount: p.amount,
      status: p.status,
      providerRef: p.providerRef,
      rrn: p.rrn,
      authCode: p.authCode,
      cardLast4: p.cardLast4,
      attempts: p.attempts,
      lastError: p.lastError,
      refundedAt: p.refundedAt,
      origCaptureId: p.origCaptureId ?? null,
    })),
  };
}

/** 乙禾退款腿附原刷卡憑證（RRN／授權碼／末四碼／金額），供櫃檯於端末退貨前核對；不含完整卡號 */
export async function attachYipayOriginals(data) {
  const list = (Array.isArray(data) ? data : [data]).filter(Boolean);
  const ids = [...new Set(list.flatMap((r) => r.payments || []).map((p) => p.origCaptureId).filter(Boolean))];
  const caps = ids.length
    ? await prisma.yipayTerminalCapture.findMany({
        where: { id: { in: ids } },
        select: { id: true, rrn: true, authCode: true, cardLast4: true, amount: true, confirmedAt: true, createdAt: true },
      })
    : [];
  const byId = new Map(caps.map((c) => [c.id, c]));
  for (const r of list) {
    for (const p of r.payments || []) {
      const c = p.origCaptureId ? byId.get(p.origCaptureId) : null;
      p.original = c
        ? {
            rrn: c.rrn,
            authCode: c.authCode,
            cardLast4: c.cardLast4,
            amount: Math.round(Number(c.amount) || 0),
            capturedAt: c.confirmedAt || c.createdAt,
          }
        : null;
      delete p.origCaptureId;
    }
  }
  return data;
}

export async function getRefundForStaff(user, id) {
  return serializeRefund(await loadRefundForStaff(user, id));
}

export async function listRefundsForStaff(user, query = {}) {
  const where = {};
  if (query.branchId && query.branchId !== 'all') {
    const bid = parseInt(query.branchId, 10);
    if (!canAccessBranch(user, bid)) throw httpError(403, 'BRANCH_FORBIDDEN', '⛔ 無權查詢其他分店退費單');
    where.branchId = bid;
  } else if (!isCrossBranchUser(user)) {
    where.branchId = { in: staffBranchIds(user).length ? staffBranchIds(user) : [-1] };
  }
  if (query.status) {
    const list = String(query.status).toUpperCase().split(',').filter(Boolean);
    if (list.includes('OPEN')) where.status = { in: OPEN_REFUND_STATUSES };
    else where.status = { in: list };
  }
  if (query.subOrderId) where.refId = String(query.subOrderId).trim().toUpperCase();
  if (query.memberId) where.memberId = parseInt(query.memberId, 10) || -1;
  const take = Math.min(200, Math.max(1, parseInt(query.take, 10) || 30));
  const rows = await prisma.refundRequest.findMany({
    where,
    include: { payments: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return rows.map(serializeRefund);
}

export { loadRefundForStaff, writeAudit, finalizeRefund, withRefundLock };
