// lib/transactionChanges.js — 櫃檯交易異動：退費前查詢（發票／子單反查）、取消進出場
// 退費／折讓一律走 lib/refundService.js（POST /ops/topups/:id/cancel、/ops/sub-orders/:subOrderId/refund）
import prisma from './prisma.js';
import { assertBranchAccess, hasDutyRankOrAbove, isCrossBranchUser } from './staffAccess.js';
import { attachInvoiceSummary, findInvoiceByNumber } from './einvoice.js';
import { listAllowancesForRef, normalizeInvoiceNumberInput } from './invoiceAllowance.js';
import { formatGateAccessNo, resolveGateLogId } from './gateAccessNo.js';
import { broadcastOccupancy } from './occupancy.js';
import { classifyOrder } from './refundService.js';
import { OPEN_REFUND_STATUSES } from './refundRules.js';
import { WALLET_MODE, WALLET_TX, mutateMemberWallet } from './walletMutation.js';

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────
// 分店權限
// ─────────────────────────────────────────────────────────────

/** 訂單分店：Order.branchId → 合併結帳分店 → 購案方案分店（舊資料） */
async function resolveOrderBranchId(order, db = prisma) {
  if (order.branchId) return order.branchId;
  if (order.checkoutSessionId) {
    const session = await db.checkoutSession.findUnique({
      where: { id: order.checkoutSessionId },
      select: { branchId: true },
    });
    if (session?.branchId) return session.branchId;
  }
  const promoMatch = String(order.itemDesc || '').match(/商品#(\d+)/);
  if (promoMatch) {
    const promotion = await db.promotion.findUnique({
      where: { id: parseInt(promoMatch[1], 10) },
      select: { branchId: true },
    });
    if (promotion?.branchId) return promotion.branchId;
  }
  return null;
}

async function assertOrderBranchAccess(user, order, db = prisma) {
  if (isCrossBranchUser(user)) return;
  const branchId = await resolveOrderBranchId(order, db);
  if (branchId == null) throw httpError('⛔ 無法判定訂單所屬分店，請洽總部處理', 403);
  assertBranchAccess({ user }, branchId);
}

function assertSessionAccess(user, session) {
  if (session.branchId != null) assertBranchAccess({ user }, session.branchId);
  else if (!isCrossBranchUser(user)) throw httpError('⛔ 無法判定結帳所屬分店，請洽總部處理', 403);
}

// ─────────────────────────────────────────────────────────────
// 退費前查詢
// ─────────────────────────────────────────────────────────────

/** 依發票號反查訂單（獨立開票之 ORDER，或舊合併發票所屬 CHK 之子訂單） */
export async function findOrderByInvoiceNumber(invoiceNumber, statuses, db = prisma) {
  const inv = await findInvoiceByNumber(invoiceNumber, db);
  if (!inv) return null;
  if (inv.refType === 'ORDER') {
    return db.order.findFirst({ where: { id: inv.refId, status: { in: statuses } } });
  }
  const chkId = inv.checkoutSessionId || (inv.refType === 'CHECKOUT' ? inv.refId : null);
  if (!chkId) return null;
  return db.order.findFirst({
    where: { checkoutSessionId: chkId, status: { in: statuses } },
    orderBy: { createdAt: 'desc' },
  });
}

/** 子單可用之退費端點（前端據此導向；實際可否退仍由後端試算判定） */
function refundActionsOf(kind, status) {
  if (status !== 'PAID') return [];
  if (kind === 'TOPUP') return ['TOPUP_CANCEL', 'SUB_ORDER_REFUND'];
  if (['SALE', 'MEMBERSHIP', 'PT'].includes(kind)) return ['SUB_ORDER_REFUND'];
  if (kind === 'GROUP') return ['GROUP_REFUND'];
  if (kind === 'COURSE_SUB') return ['SUBSCRIPTION_CANCEL'];
  return [];
}

function summarizeOrder(o) {
  const kind = classifyOrder(o);
  return {
    id: o.id,
    refType: 'ORDER',
    kind,
    status: o.status,
    amount: Number(o.amount) || 0,
    refundedAmount: o.refundedAmount || 0,
    itemDesc: o.itemDesc,
    checkoutSessionId: o.checkoutSessionId || null,
    createdAt: o.createdAt,
    actions: refundActionsOf(kind, o.status),
  };
}

function summarizeSale(s) {
  return {
    id: s.id,
    refType: 'SALE',
    kind: 'SALE',
    status: s.status,
    amount: s.amount,
    refundedAmount: s.refundedAmount || 0,
    itemDesc: s.itemDesc,
    checkoutSessionId: s.checkoutSessionId || null,
    createdAt: s.createdAt,
    actions: refundActionsOf('SALE', s.status),
    items: (s.items || []).map((it) => ({
      orderItemId: it.id,
      name: it.name,
      qty: it.qty,
      refundedQty: it.refundedQty || 0,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal,
      taxType: it.taxType,
    })),
  };
}

const MEMBER_SELECT = { select: { id: true, name: true, memberNo: true, phone: true } };

/**
 * 依發票號碼或單號（SAL／TYK／CRS／GRP／CHK）查詢可退費子單，帶出發票、既有折讓單與處理中退費單
 * 合併結帳（CHK 或舊合併發票）回傳所有子單，由櫃檯指定子單退費
 */
export async function lookupRefundOrder({ user, orderId: orderIdRaw, invoiceNumber: invoiceRaw }) {
  const invoiceNumber = normalizeInvoiceNumberInput(invoiceRaw);
  let refId = orderIdRaw ? String(orderIdRaw).trim().toUpperCase() : '';
  if (!invoiceNumber && !refId) throw httpError('請提供 invoiceNumber 或 orderId');

  let chkId = null;
  if (!refId) {
    const inv = await findInvoiceByNumber(invoiceNumber);
    if (!inv) throw httpError(`找不到發票 ${invoiceNumber}`, 404);
    if (inv.refType === 'ORDER' || inv.refType === 'SALE') refId = inv.refId;
    else chkId = inv.checkoutSessionId || inv.refId;
  } else if (refId.startsWith('CHK')) {
    chkId = refId;
    refId = '';
  }

  let subOrders;
  let member = null;
  if (chkId) {
    const session = await prisma.checkoutSession.findUnique({
      where: { id: chkId },
      select: { id: true, branchId: true, memberId: true },
    });
    if (!session) throw httpError('找不到此結帳編號', 404);
    assertSessionAccess(user, session);
    const [orders, sales] = await Promise.all([
      prisma.order.findMany({
        where: { checkoutSessionId: chkId },
        include: { ptContract: { select: { id: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.saleOrder.findMany({ where: { checkoutSessionId: chkId }, include: { items: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    subOrders = [...sales.map(summarizeSale), ...orders.map(summarizeOrder)];
    if (session.memberId) member = await prisma.member.findUnique({ where: { id: session.memberId }, ...MEMBER_SELECT });
  } else if (refId.startsWith('SAL')) {
    const sale = await prisma.saleOrder.findUnique({ where: { id: refId }, include: { items: true, member: MEMBER_SELECT } });
    if (!sale) throw httpError('找不到銷貨單', 404);
    assertBranchAccess({ user }, sale.branchId);
    subOrders = [summarizeSale(sale)];
    member = sale.member || null;
  } else {
    const order = await prisma.order.findUnique({
      where: { id: refId },
      include: { member: MEMBER_SELECT, ptContract: { select: { id: true } } },
    });
    if (!order) throw httpError('找不到訂單', 404);
    await assertOrderBranchAccess(user, order);
    subOrders = [summarizeOrder(order)];
    member = order.member || null;
  }

  const ids = subOrders.map((s) => s.id);
  const withInvoices = await attachInvoiceSummary(subOrders);
  const sessionId = chkId || subOrders[0]?.checkoutSessionId || null;
  const shared = sessionId ? (await attachInvoiceSummary({ id: sessionId })).invoices : [];
  const issuedNumbers = [...withInvoices.flatMap((s) => s.invoices), ...shared]
    .filter((i) => i.invoiceNumber)
    .map((i) => i.invoiceNumber);
  const [allowances, openRefunds] = await Promise.all([
    listAllowancesForRef({ orderId: ids[0], invoiceNumbers: issuedNumbers }, { take: 20 }),
    prisma.refundRequest.findMany({
      where: { refId: { in: ids }, status: { in: OPEN_REFUND_STATUSES } },
      select: { id: true, refId: true, status: true, payoutAmount: true, createdAt: true },
    }),
  ]);
  return {
    checkoutSessionId: sessionId,
    subOrders: withInvoices,
    sharedInvoices: shared,
    member,
    allowances,
    openRefunds,
  };
}

// ─────────────────────────────────────────────────────────────
// 取消進出場
// ─────────────────────────────────────────────────────────────

/**
 * 在場中：直接取消進場（不扣費）｜已出場：費用退回零錢包（限 DUTY+）
 * @param {{ user, logId: string|number, reason?: string }} input
 */
export async function cancelGateLog({ user, logId, reason }) {
  const id = await resolveGateLogId(logId, prisma);
  if (!id) throw httpError('請提供有效的進出場單號（ACC＋日期時間 或數字 id）');

  const result = await prisma.$transaction(async (tx) => {
    const log = await tx.checkInLog.findUnique({
      where: { id },
      include: { member: { select: { id: true, name: true } } },
    });
    if (!log) throw httpError('找不到此進出場紀錄', 404);
    if (log.status === 'CANCELLED') throw httpError('此進出場紀錄已取消');
    if (log.branchId) assertBranchAccess({ user }, log.branchId);

    const fee = roundMoney(Number(log.fee) || 0);
    const wasCheckedOut = Boolean(log.checkOutAt);
    if (wasCheckedOut && !hasDutyRankOrAbove(user)) {
      throw httpError('⛔ 已出場紀錄取消退費僅限 DUTY（值星）以上', 403);
    }

    const cancelled = await tx.checkInLog.updateMany({
      where: { id, status: { not: 'CANCELLED' } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: String(reason || '').trim() || null,
        cancelledByStaffId: user?.id ?? null,
        // 在場中取消：視同結束在場狀態，避免佔用防潛回
        checkOutAt: log.checkOutAt || new Date(),
        shortfallAmt: 0,
      },
    });
    if (cancelled.count === 0) throw httpError('此進出場紀錄已取消', 409);

    // 依出場實扣拆分原路退回（運動金／本金）：CheckInLog 拆分欄 → 扣款流水 → 無紀錄之舊資料才全額退本金
    let refundedFee = 0;
    let refundedSplit = null;
    let memberWallet = null;
    if (wasCheckedOut && fee > 0) {
      let split;
      let source = 'LOG';
      const logCash = roundMoney(log.deductedCash);
      const logBonus = roundMoney(log.deductedBonus);
      if (logCash > 0 || logBonus > 0) {
        split = { cash: logCash, bonus: logBonus };
      } else {
        const charges = await tx.walletLedger.findMany({
          where: { refType: 'CHECKIN', refId: String(log.id), reasonCode: WALLET_TX.GATE_CHECKOUT, cashBefore: { not: null } },
          select: { cashDelta: true, bonusDelta: true },
        });
        if (charges.length) {
          source = 'LEDGER';
          split = {
            cash: roundMoney(charges.reduce((s, c) => s - (c.cashDelta || 0), 0)),
            bonus: roundMoney(charges.reduce((s, c) => s - (c.bonusDelta || 0), 0)),
          };
        } else {
          source = 'LEGACY';
          split = { cash: fee, bonus: 0 };
        }
      }
      if (split.cash > 0 || split.bonus > 0) {
        const r = await mutateMemberWallet(tx, {
          memberId: log.memberId,
          txType: WALLET_TX.GATE_FEE_REFUND,
          mode: WALLET_MODE.CREDIT_BUCKETS,
          cashDelta: split.cash,
          bonusDelta: split.bonus,
          reason: `取消進出場退回出場費${source === 'LEGACY' ? '（舊紀錄無扣款拆分，全額退本金）' : ''}：${String(reason || '').trim() || '未填原因'}`,
          refType: 'CHECKIN',
          refId: log.id,
          staffId: user?.id ?? null,
          branchId: log.branchId,
        });
        refundedFee = roundMoney(split.cash + split.bonus);
        refundedSplit = split;
        memberWallet = r.after;
      }
    }

    return {
      logId: log.id,
      gateAccessNo: formatGateAccessNo(log.checkInAt),
      memberId: log.memberId,
      memberName: log.member?.name,
      wasCheckedOut,
      originalFee: fee,
      refundedFee,
      refundedSplit,
      memberWallet,
      billingMode: log.billingMode,
    };
  });

  broadcastOccupancy({ type: 'gate-cancel', memberId: result.memberId }).catch(() => {});

  const label = result.gateAccessNo || `#${result.logId}`;
  return {
    message: result.wasCheckedOut
      ? `進出場 ${label} 已取消${
          result.refundedFee > 0
            ? `，費用 $${result.refundedFee} 已退回（運動金 $${result.refundedSplit.bonus}／本金 $${result.refundedSplit.cash}）`
            : '（原無計費）'
        }`
      : `進出場 ${label} 進場已取消（會員改為離場）`,
    data: result,
  };
}
