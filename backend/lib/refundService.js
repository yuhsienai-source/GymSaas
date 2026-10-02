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
  assertTopupVoidable,
  canAbortRefund,
  computePtRefund,
  computeSaleReturnLines,
  computeTimedTopupRefund,
  normalizeBreakdown,
  paymentPhaseStatus,
  splitRefundLegs,
  withinCoolingOff,
} from './refundRules.js';
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
  if (order.ptContract || desc.startsWith('私教購案')) return 'PT';
  if (desc.includes('課程定期定額')) return 'COURSE_SUB';
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

async function computeMembership(db, target, scope, now) {
  const order = target.row;
  const member = await db.member.findUnique({
    where: { id: order.memberId },
    select: { id: true, expireDate: true, plan: true, leaveUntil: true },
  });
  const sub = await findLinkedSubscription(db, order.id);
  const { periodDays, contractDays } = await resolveUnlimitedOrderPeriodDays(order);
  const grantedDays = sub ? periodDays : contractDays;
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
  };
  if (scope === 'FULL') {
    if (!withinCoolingOff(order.createdAt, now)) {
      throw httpError(409, 'COOLING_OFF_EXPIRED', '已逾 7 日無條件解約期，請改用未履約退費（UNUSED）');
    }
    const used = await db.checkInLog.count({
      where: { memberId: order.memberId, checkInAt: { gte: order.createdAt }, status: { not: 'CANCELLED' } },
    });
    if (used > 0) throw httpError(409, 'SERVICE_ALREADY_USED', `購案後已進場 ${used} 次，不可全額退費，請改用未履約退費`);
    return { gross: target.amount, fee: 0, consumedValue: 0, calc: { ...calc, note: `7 日內未使用，全額退 $${target.amount}` } };
  }
  const detail = computeMonthlyCardRefundDetail({
    orderAmount: target.amount,
    unusedDays: remainingExpireDays(member?.expireDate, now),
    periodDays,
    contractDays: sub ? periodDays : contractDays,
  });
  if (!detail.eligible) throw httpError(409, 'REFUND_NOT_ELIGIBLE', detail.note);
  const gross = ntd(detail.amount);
  return { gross, fee: ntd(detail.fee), consumedValue: Math.max(0, target.amount - gross - ntd(detail.fee)), calc: { ...calc, detail, note: detail.note } };
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

async function buildPlan(db, target, { scope: scopeRaw, items, mode, now = new Date() }) {
  assertPaid(target);
  let scope = String(scopeRaw || '').toUpperCase();
  let gross;
  let fee = 0;
  let consumedValue = 0;
  let lines = null;
  let calc;
  let fullRefund = false;
  let kind = 'ORDER_REFUND';

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
      case 'COURSE_SUB':
        throw httpError(409, 'USE_SUBSCRIPTION_CANCEL', '課程定期定額請改用月卡訂閱取消結算');
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
        });
        if (r.beforeFee < 0 || r.refundCash < 0) {
          throw httpError(409, 'REFUND_BLOCKED', `運動金已消耗且本金殘值不足：實付 $${r.paidAmount} − 實際使用 $${r.usedAmount} − 手續費 $${r.refundFee}`);
        }
        gross = ntd(r.refundCash);
        if (!(gross > 0)) throw httpError(409, 'REFUND_AMOUNT_ZERO', '依公式應退金額為 0，無可退費');
        fee = ntd(r.refundFee);
        consumedValue = ntd(r.usedAmount);
        calc = {
          orderKind: 'TOPUP',
          ...r,
          deductCash: r.remainingPrincipal,
          deductBonus: r.recoveredBonus,
          note: `實付$${r.paidAmount} − 實際使用$${r.usedAmount} − 手續費$${r.refundFee} = $${r.refundCash}`,
        };
        break;
      }
      case 'MEMBERSHIP': {
        if (!['FULL', 'UNUSED'].includes(scope)) throw httpError(400, 'SCOPE_INVALID', '月卡退費 scope 須為 FULL 或 UNUSED');
        const m = await computeMembership(db, target, scope, now);
        gross = m.gross;
        fee = m.fee;
        consumedValue = m.consumedValue;
        calc = m.calc;
        fullRefund = scope === 'FULL';
        break;
      }
      case 'PT': {
        if (!['FULL', 'UNUSED'].includes(scope)) throw httpError(400, 'SCOPE_INVALID', '私教退費 scope 須為 FULL 或 UNUSED');
        const contract = target.row.ptContract;
        if (!contract) throw httpError(409, 'PT_CONTRACT_UNLINKED', '此私教訂單未連結合約，請洽總部人工處理');
        if (!contract.isActive) throw httpError(409, 'ALREADY_REFUNDED', '此私教合約已停用');
        const r = computePtRefund({
          pricePaid: target.amount,
          totalSessions: contract.totalSessions,
          usedSessions: contract.usedSessions,
          scope,
          coolingOff: withinCoolingOff(target.row.createdAt, now),
        });
        if (!(r.gross > 0)) throw httpError(409, 'REFUND_AMOUNT_ZERO', `依公式應退金額為 0（${r.note}）`);
        gross = r.gross;
        fee = r.fee;
        consumedValue = r.consumedValue;
        const futureBookings = await db.reservation.count({
          where: {
            memberId: target.memberId,
            status: { notIn: ['CANCELLED', 'CANCELED'] },
            class: { trainerId: contract.trainerId, type: 'PRIVATE', startAt: { gt: now } },
          },
        });
        calc = { orderKind: 'PT', contractId: contract.id, ...r, futureBookings };
        fullRefund = scope === 'FULL';
        break;
      }
      default:
        throw httpError(409, 'REFUND_KIND_UNSUPPORTED', '此訂單類型不支援自動退費');
    }
  }

  if (!(gross > 0)) throw httpError(409, 'REFUND_AMOUNT_ZERO', '應退金額為 0');
  if (gross > target.amount - target.refundedAmount) {
    throw httpError(409, 'REFUND_EXCEEDS_PAID', `應退 $${gross} 超過單據可退餘額 $${target.amount - target.refundedAmount}`);
  }

  const { breakdown, merchantNos } = paymentSource(target);
  const prior = await priorRefundedByMethod(db, target);
  const available = Object.fromEntries(Object.entries(breakdown).map(([m, v]) => [m, v - (prior[m] || 0)]));
  const legs = splitRefundLegs({ breakdown, refundAmount: gross, available });
  if (legs.some((l) => l.method === 'WALLET_CASH') && !target.memberId) {
    throw httpError(409, 'MEMBER_REQUIRED', '原單含零錢包付款但無會員，無法退回零錢包');
  }
  const refs = await resolveProviderRefs(db, target, merchantNos);

  const { invoices, shared } = await loadRefInvoices(db, target);
  const relevant = relevantInvoices(target, invoices, lines, shared);
  const invoicePlan = decideInvoiceActions({ invoices: relevant, fullRefund, sharedInvoice: shared, now });
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
    calc: { ...calc, payuniPaid: breakdown.PAYUNI ?? null },
    grossAmount: gross,
    feeAmount: fee,
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
      c: plan.consumedValue,
      p: plan.payoutAmount,
      full: plan.fullRefund,
      w: [plan.calc.deductCash ?? null, plan.calc.deductBonus ?? null],
      legs: plan.legs.map((l) => [l.method, l.amount, Boolean(l.forfeited)]),
      inv: [plan.invoicePlan.action, plan.invoicePlan.invoices.map((i) => [i.id, i.action])],
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
    grossAmount: plan.grossAmount,
    feeAmount: plan.feeAmount,
    consumedValue: plan.consumedValue,
    payoutAmount: plan.payoutAmount,
    fullRefund: plan.fullRefund,
    legs: plan.legs.map((l) => ({
      ...l,
      ready:
        l.method === 'LINEPAY' ? Boolean(plan.refs.linePayTxId) : l.method === 'PAYUNI' ? Boolean(plan.refs.payuniTradeNo) : true,
      needsTerminal: l.method === 'YIPAY',
    })),
    invoicePlan: plan.invoicePlan,
    signatureRequired: plan.signatureLikely,
    warnings: [
      ...(plan.calc.subscriptionActive ? ['將同步終止定期定額（PayUNi 續期）；中止退費不會恢復訂閱'] : []),
      ...(plan.calc.futureBookings > 0 ? [`會員尚有 ${plan.calc.futureBookings} 堂未來私教預約，請另行取消`] : []),
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

export async function previewSubOrderRefund(user, subOrderId, { scope, items } = {}) {
  const target = await loadTarget(prisma, subOrderId);
  assertTargetAccess(user, target);
  const plan = await buildPlan(prisma, target, { scope, items });
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
  } else if (plan.calc.orderKind === 'PT') {
    await tx.$queryRaw`SELECT id FROM "PTContract" WHERE id = ${plan.calc.contractId} FOR UPDATE`;
    const contract = await tx.pTContract.findUnique({ where: { id: plan.calc.contractId } });
    if (!contract?.isActive || contract.usedSessions !== plan.calc.used) {
      throw httpError(409, 'STATE_CHANGED', '私教合約已異動（堂數或狀態），請重新試算');
    }
    await tx.pTContract.update({ where: { id: contract.id }, data: { isActive: false, refundedAt: now } });
    before.contract = { id: contract.id, isActive: true, usedSessions: contract.usedSessions };
    after.contract = { id: contract.id, isActive: false };
    await closeOrder();
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

async function executePlan(user, target, opts, req) {
  const idempotencyKey = normalizeIdempotencyKey(opts.idempotencyKey);
  const replay = await findIdempotentReplay(user, idempotencyKey, target, opts.mode);
  if (replay) return replay;

  const quoteDigest = verifyQuote(user, opts.quoteToken, target, opts.mode);
  const reason = normalizeRefundReason(opts.reason);
  const buyerEmail = normalizeBuyerEmail(opts.buyerEmail);
  const now = new Date();

  // 預先檢核（含發票作法）；有 ERROR 或與試算不符即不動任何資料（含終止訂閱）
  const pre = await buildPlan(prisma, target, { scope: opts.scope, items: opts.items, mode: opts.mode, now });
  assertQuoteMatches(pre, quoteDigest);

  if (pre.legs.some((l) => l.method === 'CASH') && !(pre.branchId && (await getOpenShift(pre.branchId)))) {
    throw httpError(409, 'SHIFT_NOT_OPEN', SHIFT_NOT_OPEN_MESSAGE);
  }

  // 月卡定期定額：先終止 PayUNi 續期（失敗即中止，不動帳）
  let subscriptionCancelled = null;
  if (pre.calc.subscriptionActive && pre.calc.subscriptionId) {
    const sub = await prisma.cardSubscription.findUnique({ where: { id: pre.calc.subscriptionId } });
    const latest = await findLatestPaidOrderForSubscription(sub);
    if (latest.order && latest.order.id !== target.id) {
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

        const plan = await buildPlan(tx, fresh, { scope: opts.scope, items: opts.items, mode: opts.mode, now });
        assertQuoteMatches(plan, quoteDigest);
        const rollback = await applyEntitlementRollback(tx, plan, fresh, { refundId, user, now });

        let shiftId = null;
        let walletCashCredited = 0;
        const payments = [];
        for (const leg of plan.legs) {
          const base = { id: genId('RFP'), method: leg.method, amount: leg.amount, staffId: user?.id ?? null };
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
            const ref = plan.refs.linePayTxId;
            payments.push({ ...base, status: ref ? 'PENDING' : 'FAILED', originalRef: ref, lastError: ref ? null : '缺少 LINE Pay 交易序號，請改臨櫃現金退款' });
          } else if (leg.method === 'PAYUNI') {
            const ref = plan.refs.payuniTradeNo;
            payments.push({ ...base, status: ref ? 'PENDING' : 'FAILED', originalRef: ref, lastError: ref ? null : '缺少 PayUNi 交易序號，請改臨櫃現金退款' });
          } else if (leg.method === 'YIPAY') {
            payments.push({ ...base, status: 'AWAITING_TERMINAL', origCaptureId: plan.refs.yipayCapture?.id ?? null });
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
            calc: { ...plan.calc, invoicePlan: plan.invoicePlan.action, subscriptionCancelled, rollback: rollback.after },
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
          after: { ...rollback.after, grossAmount: plan.grossAmount, legs: plan.legs, status: refund.status },
        });
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

  return withRefundLock(created.id, () => advance(created.id, { user, req }));
}

/** A：計時儲值原單取消（本金／運動金須完整留存） */
export async function executeTopupCancel(user, orderId, { reason, buyerEmail, quoteToken, idempotencyKey } = {}, req = null) {
  const target = await loadTarget(prisma, orderId);
  assertTargetAccess(user, target);
  return executePlan(user, target, { mode: 'TOPUP_VOID', reason, buyerEmail, quoteToken, idempotencyKey }, req);
}

/** B：子單退費（SAL 退貨／TYK 未履約／CRS 月卡／私教） */
export async function executeSubOrderRefund(user, subOrderId, { scope, items, reason, buyerEmail, quoteToken, idempotencyKey } = {}, req = null) {
  const target = await loadTarget(prisma, subOrderId);
  assertTargetAccess(user, target);
  return executePlan(user, target, { scope, items, reason, buyerEmail, quoteToken, idempotencyKey }, req);
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
        const res = await refundPayuniTrade({ tradeNo: leg.originalRef, amount: leg.amount, fullAmount: refund.calc?.payuniPaid ?? null });
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

function allowanceItemsFor(refund, inv, shared, target) {
  if (shared || refund.refType === 'ORDER') {
    const name = shared ? `子單${refund.refId}退費` : inv.items[0]?.name || target.row.itemDesc || refund.refId;
    return [{ name, qty: 1, unit: '式', gross: refund.grossAmount }];
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
  const { invoices, shared } = await loadRefInvoices(prisma, target);
  const done = new Map(prevResults.filter((x) => x.done).map((x) => [x.einvoiceId, x]));
  const pending = relevantInvoices(target, invoices, refund.lines, shared).filter((inv) => !done.has(inv.id));

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
      action = decideInvoiceActions({ invoices: pending, fullRefund: refund.fullRefund, sharedInvoice: shared }).action;
    }
    const allowanceCtx = allowanceContextOf(refund);
    for (const inv of pending) {
      if (inv.status === 'ISSUING') throw httpError(409, 'INVOICE_ISSUING', `發票 ${inv.id} 開立中，請稍候重試`);
      if (inv.status === 'PENDING' || inv.status === 'FAILED') {
        if (!refund.fullRefund) throw httpError(409, 'INVOICE_NOT_ISSUED', '發票尚未開立，不得部分退費（請先補開發票）');
        const c = await prisma.eInvoice.updateMany({
          where: { id: inv.id, status: { in: ['PENDING', 'FAILED'] } },
          data: { status: 'CANCELLED', voidReason: `退費 ${refund.id}`.slice(0, 100), voidedAt: new Date(), nextRetryAt: null },
        });
        if (!c.count) throw httpError(409, 'INVOICE_ISSUING', `發票 ${inv.id} 狀態已變更，請重試`);
        results.push({ einvoiceId: inv.id, invoiceNumber: null, action: 'CANCEL', category: inv.category, done: true });
        continue;
      }
      let doAllowance = action !== 'VOID';
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
        const items = allowanceItemsFor(refund, inv, shared, target);
        if (!items.length) {
          results.push({ einvoiceId: inv.id, invoiceNumber: inv.invoiceNumber, action: 'NONE', category: inv.category, done: true });
          continue;
        }
        try {
          const a = await allowanceEInvoice(inv.invoiceNumber, {
            items,
            itemDesc: `${refund.refId} 退費`,
            buyerEmail: refund.buyerEmail,
            staffId: user?.id ?? null,
            holdOnAmbiguous: true,
            context: allowanceCtx,
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
        if (calc.orderKind === 'PT' && calc.contractId) {
          await tx.pTContract.update({ where: { id: calc.contractId }, data: { isActive: true, refundedAt: null } });
        }
        await tx.order.update({
          where: { id: target.row.id },
          data: { status: 'PAID', refundedAmount: { decrement: fresh.grossAmount } },
        });
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
        after: { status: 'ABORTED', subscriptionNotRestored: Boolean(calc.subscriptionCancelled) },
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
