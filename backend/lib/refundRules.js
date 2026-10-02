// lib/refundRules.js — 交易取消／退費金額與退款管道（純函式，唯一定義）
// 金額一律由後端依 DB 快照反算（新台幣整數元）；前端只送子單號／品項 id／數量／原因

import { allocateInteger } from './einvoiceRules.js';

export const REFUND_STATUSES = Object.freeze([
  'PAYMENT_PENDING',
  'AWAITING_TERMINAL',
  'PAYMENT_FAILED',
  'INVOICE_PENDING',
  'INVOICE_FAILED',
  'SIGNATURE_PENDING',
  'GATEWAY_RETRYING',
  'COMPLETED',
  'ABORTED',
]);
export const OPEN_REFUND_STATUSES = REFUND_STATUSES.filter((s) => s !== 'COMPLETED' && s !== 'ABORTED');
export const REFUND_SCOPES = Object.freeze(['FULL', 'UNUSED', 'ITEMS']);

/** 付款分攤鍵 → 退款管道（CARD＝PayUNi） */
const BREAKDOWN_TO_METHOD = Object.freeze({
  CASH: 'CASH',
  WALLET_CASH: 'WALLET_CASH',
  LINEPAY: 'LINEPAY',
  CARD: 'PAYUNI',
  YIPAY: 'YIPAY',
  VOUCHER: 'VOUCHER',
});
/** 溢出重分配順序：先回原線上管道，現金最後 */
const SPILL_ORDER = ['WALLET_CASH', 'LINEPAY', 'PAYUNI', 'YIPAY', 'CASH'];

/** 消保法定型化契約違約手續費上限 */
export const CONTRACT_FEE_RATE = 0.2;
export const CONTRACT_FEE_CAP = 5000;
/** 7 日無條件解約 */
export const COOLING_OFF_DAYS = 7;

function ruleError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const ntd = (n) => Math.round(Number(n) || 0);
const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function contractFee(unfulfilled) {
  return Math.min(Math.max(0, ntd(unfulfilled * CONTRACT_FEE_RATE)), CONTRACT_FEE_CAP);
}

export function withinCoolingOff(paidAt, now = new Date()) {
  return now.getTime() - new Date(paidAt).getTime() <= COOLING_OFF_DAYS * 24 * 3600 * 1000;
}

/**
 * 計時儲值退費（消保法，scope=UNUSED）：
 * 應退 = 實付 − 實際使用（已用本金＋已消耗運動金）− Math.min(未履約 × 20%, 5000)
 * 贈送運動金全數註銷；已消耗者自應退現金等額扣除，不足則為 0（不倒貼）
 */
export function computeTimedTopupRefund({ cashWallet, bonusWallet, originalPrice, originalBonus }) {
  const paidAmount = roundMoney(originalPrice);
  const recoveredBonus = roundMoney(Math.min(Number(bonusWallet) || 0, originalBonus));
  const shortfall = roundMoney(originalBonus - recoveredBonus);
  const remainingPrincipal = roundMoney(Math.min(Number(cashWallet) || 0, originalPrice));
  const usedPrincipal = roundMoney(originalPrice - remainingPrincipal);
  const usedAmount = roundMoney(usedPrincipal + shortfall);
  const beforeFee = roundMoney(paidAmount - usedAmount);
  const refundFee = roundMoney(Math.min(beforeFee > 0 ? beforeFee * CONTRACT_FEE_RATE : 0, CONTRACT_FEE_CAP));
  const refundCash = roundMoney(beforeFee - refundFee);
  return { paidAmount, recoveredBonus, shortfall, remainingPrincipal, usedPrincipal, usedAmount, beforeFee, refundFee, refundCash };
}

/**
 * 計時儲值原單取消（A）：本金與運動金須仍完整留存
 * @returns {{ deductBonus: number, deductCash: number }}
 */
export function assertTopupVoidable({ cashWallet, bonusWallet, grantedCash, grantedBonus }) {
  if (grantedCash == null || grantedBonus == null) {
    throw ruleError(409, 'TOPUP_GRANT_UNKNOWN', '此儲值單缺少入帳快照，無法原單取消，請洽總部人工處理');
  }
  if ((Number(cashWallet) || 0) < grantedCash || (Number(bonusWallet) || 0) < grantedBonus) {
    throw ruleError(409, 'WALLET_INSUFFICIENT_FOR_VOID', '會員已動用儲值本金或贈送運動金，餘額不足無法原單取消');
  }
  return { deductBonus: grantedBonus, deductCash: grantedCash };
}

/**
 * 私教合約退費
 * - FULL：未使用任何堂數，全額退
 * - UNUSED：實付 − 已上堂數 × 單堂價 − Math.min(未履約 × 20%, 5000)；7 日內且未使用免手續費
 */
export function computePtRefund({ pricePaid, totalSessions, usedSessions, scope, coolingOff = false }) {
  const paid = ntd(pricePaid);
  const total = Math.max(1, Number(totalSessions) || 1);
  const used = Math.max(0, Number(usedSessions) || 0);
  if (scope === 'FULL') {
    if (used > 0) throw ruleError(409, 'SERVICE_ALREADY_USED', `已使用 ${used} 堂，不可全額退費，請改用未履約退費`);
    return { gross: paid, consumedValue: 0, fee: 0, unitPrice: ntd(paid / total), used, note: `未使用，全額退 $${paid}` };
  }
  const unitPrice = paid / total;
  const consumedValue = Math.min(paid, ntd(unitPrice * used));
  const unfulfilled = paid - consumedValue;
  const fee = coolingOff && used === 0 ? 0 : contractFee(unfulfilled);
  const gross = Math.max(0, unfulfilled - fee);
  return {
    gross,
    consumedValue,
    fee,
    unitPrice: ntd(unitPrice),
    used,
    note: `實付$${paid} − 已上 ${used} 堂×$${ntd(unitPrice)} − 手續費$${fee} = $${gross}`,
  };
}

/**
 * 銷貨退貨品項（後端依 SaleItem 反算含稅金額）
 * @param {Array<{ id, name, qty, unitPrice, refundedQty, taxType, productId }>} saleItems
 * @param {Array<{ orderItemId: number, qty: number }>|null} requested null＝全部未退品項
 */
export function computeSaleReturnLines(saleItems, requested) {
  const byId = new Map(saleItems.map((s) => [s.id, s]));
  const wanted = requested
    ? requested
    : saleItems.filter((s) => s.qty - (s.refundedQty || 0) > 0).map((s) => ({ orderItemId: s.id, qty: s.qty - (s.refundedQty || 0) }));
  if (!wanted.length) throw ruleError(409, 'NOTHING_TO_REFUND', '此銷貨單已無可退品項');
  const seen = new Set();
  const lines = wanted.map((w) => {
    const id = parseInt(w.orderItemId, 10);
    const qty = parseInt(w.qty, 10);
    const item = byId.get(id);
    if (!item) throw ruleError(400, 'ORDER_ITEM_INVALID', `品項 #${w.orderItemId} 不屬於此銷貨單`);
    if (seen.has(id)) throw ruleError(400, 'ORDER_ITEM_DUPLICATE', `品項 #${id} 重複`);
    seen.add(id);
    const left = item.qty - (item.refundedQty || 0);
    if (!Number.isInteger(qty) || qty <= 0 || qty > left) {
      throw ruleError(409, 'REFUND_QTY_EXCEEDED', `「${item.name}」可退數量為 ${left}`);
    }
    return {
      orderItemId: id,
      name: item.name,
      qty,
      unitPrice: ntd(item.unitPrice),
      gross: ntd(item.unitPrice) * qty,
      taxType: item.taxType,
      productId: item.productId ?? null,
    };
  });
  const remainingAfter = saleItems.reduce((s, it) => {
    const line = lines.find((l) => l.orderItemId === it.id);
    return s + (it.qty - (it.refundedQty || 0) - (line?.qty || 0));
  }, 0);
  return { lines, gross: lines.reduce((s, l) => s + l.gross, 0), exhausts: remainingAfter === 0 };
}

/** 正規化付款分攤；無分攤之舊單以單一 payMethod 視為全額 */
export function normalizeBreakdown(payBreakdown, { payMethod, amount }) {
  const bd = payBreakdown && typeof payBreakdown === 'object' && !Array.isArray(payBreakdown) ? payBreakdown : null;
  const out = {};
  if (bd) {
    for (const [k, v] of Object.entries(bd)) {
      const method = BREAKDOWN_TO_METHOD[String(k).toUpperCase()];
      const amt = ntd(v);
      if (method && amt > 0) out[method] = (out[method] || 0) + amt;
    }
    if (Object.keys(out).length) return out;
  }
  const single = BREAKDOWN_TO_METHOD[String(payMethod || '').toUpperCase()];
  if (!single) {
    throw ruleError(409, 'PAY_CHANNEL_UNKNOWN', `無法判定原付款管道（${payMethod || '未記錄'}），請洽總部人工處理`);
  }
  return { [single]: ntd(amount) };
}

/**
 * 依原付款比例拆退款管道（最大餘數法）；VOUCHER 份額不退現（FORFEITED）
 * @param {{ breakdown: Record<string, number>, refundAmount: number, available?: Record<string, number> }} input
 *   available＝各管道尚可退額度（合併結帳扣除兄弟子單已退），超出者溢往其他管道
 * @returns {Array<{ method: string, amount: number, forfeited: boolean }>}
 */
export function splitRefundLegs({ breakdown, refundAmount, available = null }) {
  const refund = ntd(refundAmount);
  if (!(refund > 0)) return [];
  const methods = Object.keys(breakdown).filter((m) => breakdown[m] > 0);
  if (!methods.length) throw ruleError(409, 'PAY_CHANNEL_UNKNOWN', '原單無付款分攤，無法拆退款管道');
  const alloc = allocateInteger(refund, methods.map((m) => breakdown[m]));
  const legs = Object.fromEntries(methods.map((m, i) => [m, alloc[i]]));

  if (available) {
    let spill = 0;
    for (const m of methods) {
      const cap = Math.max(0, ntd(available[m] ?? breakdown[m]));
      if (legs[m] > cap) {
        spill += legs[m] - cap;
        legs[m] = cap;
      }
    }
    for (const m of [...SPILL_ORDER, 'VOUCHER']) {
      if (!spill || !(m in legs)) continue;
      const room = Math.max(0, ntd(available[m] ?? breakdown[m]) - legs[m]);
      const add = Math.min(room, spill);
      legs[m] += add;
      spill -= add;
    }
    if (spill > 0) throw ruleError(409, 'REFUND_EXCEEDS_PAID', `退款金額超過原付款可退額度（差 $${spill}）`);
  }

  return methods
    .filter((m) => legs[m] > 0)
    .map((m) => ({ method: m, amount: legs[m], forfeited: m === 'VOUCHER' }));
}

/**
 * 依退款管道狀態推導退費單狀態（付款階段）
 * @param {Array<{ status: string }>} payments
 */
export function paymentPhaseStatus(payments) {
  const live = payments.filter((p) => p.status !== 'FORFEITED');
  if (live.some((p) => p.status === 'FAILED')) return 'PAYMENT_FAILED';
  if (live.some((p) => p.status === 'AWAITING_TERMINAL')) return 'AWAITING_TERMINAL';
  if (live.some((p) => p.status === 'PENDING' || p.status === 'PROCESSING')) return 'PAYMENT_PENDING';
  return 'INVOICE_PENDING';
}

/** 退費單可否中止：任一外部管道已退款即不可（避免吞款） */
export function canAbortRefund(payments) {
  return !payments.some(
    (p) => ['LINEPAY', 'PAYUNI', 'YIPAY'].includes(p.method) && (p.status === 'REFUNDED' || p.status === 'PROCESSING'),
  );
}
