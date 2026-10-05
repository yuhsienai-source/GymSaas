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

// 體育客定型化契約（20260416 版）第九條：各類方案終止退費之手續費／違約金
/** 第一款 彈性儲值：手續費定額 */
export const TOPUP_REFUND_FEE = 100;
/** 第三款 教練課／團課：違約金＝應退餘額 20%，上限 9,000 */
export const COURSE_FEE_RATE = 0.2;
export const COURSE_FEE_CAP = 9000;
/** 第六條第五款：私教未於上課 8 小時前請假，付課程單價 20%（不足 100 以 100 計）補償教練，不扣堂 */
export const PT_LEAVE_NOTICE_HOURS = 8;
export const LATE_LEAVE_COMP_RATE = 0.2;
export const LATE_LEAVE_COMP_MIN = 100;
/** 客製化教練課服務契約：臨時請假每期（每張合約）前 2 次免收，第 3 次起收補償 */
export const PT_FREE_LATE_LEAVES = 2;
/** 客製化教練課服務契約：單堂效期 10 日（10 堂 100 日、20 堂 200 日） */
export const PT_SESSION_VALID_DAYS = 10;
/** 第八條：生效 7 日內（台北日曆日，含第 7 日）未使用全額退 */
export const COOLING_OFF_DAYS = 7;
/** VOLUNTARY＝第九條會員自願終止（收手續費）｜EXEMPT＝第十四條不可歸責會員（免手續費） */
export const TERMINATION_CLAUSES = Object.freeze(['VOLUNTARY', 'EXEMPT']);

function ruleError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const ntd = (n) => Math.round(Number(n) || 0);
const roundMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;
const TW_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const twDayIndex = (d) => Math.floor((new Date(d).getTime() + TW_OFFSET_MS) / DAY_MS);

export function courseFee(refundable) {
  return Math.min(Math.max(0, ntd(refundable * COURSE_FEE_RATE)), COURSE_FEE_CAP);
}

export function withinCoolingOff(paidAt, now = new Date()) {
  return twDayIndex(now) - twDayIndex(paidAt) <= COOLING_OFF_DAYS;
}

/** 私教每堂費用＝總費用 ÷ 總堂數（含贈送堂數），小數無條件捨去 */
export function ptUnitPrice(pricePaid, totalSessions) {
  return Math.floor((Number(pricePaid) || 0) / Math.max(1, Number(totalSessions) || 1));
}

export function lateLeaveCompensation(unitPrice) {
  return Math.max(LATE_LEAVE_COMP_MIN, Math.floor((Number(unitPrice) || 0) * LATE_LEAVE_COMP_RATE));
}

/** @param {number} priorLateCount 本合約既有臨時請假次數（不含本次） */
export function lateLeaveChargeFor(priorLateCount, unitPrice) {
  return (Number(priorLateCount) || 0) >= PT_FREE_LATE_LEAVES ? lateLeaveCompensation(unitPrice) : 0;
}

export function ptContractExpiresAt(totalSessions, from = new Date()) {
  const n = Math.max(1, parseInt(totalSessions, 10) || 1);
  return new Date(new Date(from).getTime() + n * PT_SESSION_VALID_DAYS * DAY_MS);
}

export function normalizeTerminationClause(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return 'VOLUNTARY';
  if (!TERMINATION_CLAUSES.includes(s)) {
    throw ruleError(400, 'CLAUSE_INVALID', `終止條款僅支援 ${TERMINATION_CLAUSES.join('／')}`);
  }
  return s;
}

export function normalizeOverrideFee(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) throw ruleError(400, 'INVALID_FEE_AMOUNT', '手續費／違約金須為非負整數');
  return v;
}

/**
 * 契約第十二條末款：傷病暫停累計滿六個月（`medicalSuspensionSummary.exemptEligible`）後依第九條終止，
 * 不得收取手續費或任何名目之扣費 → 月卡手續費上限強制為 0（不依賴經辦選 EXEMPT）
 */
export function isMedicalSuspensionFeeWaived(medicalSuspension) {
  return Boolean(medicalSuspension?.exemptEligible);
}

/**
 * 實收手續費：EXEMPT 一律 0；主管調降須介於 0～契約上限
 * @param {number} feeMax 依契約第九條算出之上限
 * @param {{ clause?: string, overrideFeeAmount?: number|null }} policy
 */
export function resolveAppliedFee(feeMax, { clause = 'VOLUNTARY', overrideFeeAmount = null } = {}) {
  const max = Math.max(0, roundMoney(feeMax));
  if (clause === 'EXEMPT') return 0;
  if (overrideFeeAmount == null) return max;
  if (overrideFeeAmount > max) {
    throw ruleError(400, 'FEE_EXCEEDS_CONTRACT_LIMIT', `手續費／違約金 $${overrideFeeAmount} 超過契約第九條上限 $${max}`);
  }
  return overrideFeeAmount;
}

/**
 * 計時儲值退費（契約第九條第一款，scope=UNUSED）：
 * 應退 = 實付 − 實際使用（已用本金＋已消耗運動金）− 手續費 $100
 * 贈送運動金全數註銷；已消耗者自應退現金等額扣除，不足則為 0（不倒貼）
 * 第八條：7 日內且完全未使用 → 免手續費
 */
export function computeTimedTopupRefund({ cashWallet, bonusWallet, originalPrice, originalBonus, coolingOff = false, feePolicy }) {
  const paidAmount = roundMoney(originalPrice);
  const recoveredBonus = roundMoney(Math.min(Number(bonusWallet) || 0, originalBonus));
  const shortfall = roundMoney(originalBonus - recoveredBonus);
  const remainingPrincipal = roundMoney(Math.min(Number(cashWallet) || 0, originalPrice));
  const usedPrincipal = roundMoney(originalPrice - remainingPrincipal);
  const usedAmount = roundMoney(usedPrincipal + shortfall);
  const beforeFee = roundMoney(paidAmount - usedAmount);
  const unusedGrace = coolingOff && usedAmount === 0;
  const feeMax = unusedGrace || beforeFee <= 0 ? 0 : Math.min(TOPUP_REFUND_FEE, beforeFee);
  const refundFee = roundMoney(resolveAppliedFee(feeMax, feePolicy));
  const refundCash = roundMoney(beforeFee - refundFee);
  return { paidAmount, recoveredBonus, shortfall, remainingPrincipal, usedPrincipal, usedAmount, beforeFee, unusedGrace, feeMax, refundFee, refundCash };
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
 * 私教合約退費（契約第九條第三款、第六條第五款、第十條）
 * - 每堂費用＝floor(簽約金額 ÷ 總堂數)，總堂數含贈送堂數
 * - FULL：未上課且無臨時請假補償，全額退
 * - UNUSED：應退餘額＝簽約金額 − 已上堂數 × 每堂費用 − 臨時請假補償累計；違約金＝min(應退餘額 × 20%, 9000)
 *   第八條：7 日內且未上課、無臨時請假 → 全額退
 */
export function computePtRefund({ pricePaid, totalSessions, usedSessions, lateLeaveFees = 0, scope, coolingOff = false, feePolicy }) {
  const paid = ntd(pricePaid);
  const total = Math.max(1, Number(totalSessions) || 1);
  const used = Math.max(0, Number(usedSessions) || 0);
  const lateComp = Math.max(0, ntd(lateLeaveFees));
  const unitPrice = ptUnitPrice(paid, total);
  const untouched = used === 0 && lateComp === 0;
  const full = (note) => ({ gross: paid, consumedValue: 0, lateLeaveFees: 0, refundable: paid, feeMax: 0, fee: 0, unitPrice, used, unusedGrace: true, note });
  if (scope === 'FULL') {
    if (!untouched) {
      throw ruleError(409, 'SERVICE_ALREADY_USED', `已上 ${used} 堂${lateComp ? `、臨時請假補償 $${lateComp}` : ''}，不可全額退費，請改用未履約退費`);
    }
    return full(`未上課，全額退 $${paid}`);
  }
  if (used >= total) throw ruleError(409, 'COURSE_SESSIONS_EXHAUSTED', `課程 ${total} 堂已全數使用，無可退堂數`);
  if (coolingOff && untouched) return full(`契約第八條：7 日內未上課，全額退 $${paid}`);
  const consumedValue = Math.min(paid, unitPrice * used);
  const refundable = Math.max(0, paid - consumedValue - lateComp);
  const feeMax = courseFee(refundable);
  const fee = resolveAppliedFee(feeMax, feePolicy);
  const gross = Math.max(0, refundable - fee);
  return {
    gross,
    consumedValue,
    lateLeaveFees: lateComp,
    refundable,
    feeMax,
    fee,
    unitPrice,
    used,
    unusedGrace: false,
    note:
      `簽約$${paid} − 已上 ${used}/${total} 堂×$${unitPrice}` +
      `${lateComp ? ` − 臨時請假補償$${lateComp}` : ''} − 違約金$${fee} = $${gross}`,
  };
}

/**
 * 課程分期解約（客製化教練課服務契約退費機制＋定型化契約第九條第三款）：
 * 應退＝（契約總價 − 已上 × 單價 − 臨時請假補償）− 違約金 min(20%, 9000) −（契約總價 − 已繳）
 * 負數不退、差額列 shortfall（應補繳）；第八條未使用 → 退已繳全額
 */
export function computeCourseInstallmentRefund({ contractPrice, paidAmount, ...rest }) {
  const price = ntd(contractPrice);
  const paid = Math.min(Math.max(0, ntd(paidAmount)), price);
  const unpaid = price - paid;
  const r = computePtRefund({ pricePaid: price, ...rest });
  if (r.unusedGrace) {
    return { ...r, contractRefund: r.gross, paid, unpaid, gross: paid, shortfall: 0, note: `契約第八條：未上課，退已繳全額 $${paid}` };
  }
  const net = r.gross - unpaid;
  return {
    ...r,
    contractRefund: r.gross,
    paid,
    unpaid,
    gross: Math.max(0, net),
    shortfall: Math.max(0, -net),
    note: `${r.note} − 未繳$${unpaid} = ${net >= 0 ? `$${net}` : `應補繳 $${-net}`}`,
  };
}

/**
 * 課程分期退款分攤：由最新一期往前，每期以該期可退餘額為上限
 * @param {Array<{ orderId: string, refundable: number, amount: number }>} periodsNewestFirst
 */
export function allocateInstallmentRefund(periodsNewestFirst, gross) {
  let left = ntd(gross);
  const out = [];
  for (const p of periodsNewestFirst) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, ntd(p.refundable)));
    if (take <= 0) continue;
    out.push({ orderId: p.orderId, amount: take, full: take === ntd(p.amount) });
    left -= take;
  }
  if (left > 0) throw ruleError(409, 'REFUND_EXCEEDS_PAID', `退款金額超過各期已繳可退額度（差 $${left}）`);
  return out;
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

/**
 * 乙禾退刷尚未回填 RRN／授權碼。此狀態禁止向 ezPay 開折讓、禁止結案。
 * @param {Array<{ method?: string, status?: string, rrn?: string | null, authCode?: string | null }>} payments
 */
export function hasPendingYipayTerminal(payments) {
  return (payments || []).some((p) => {
    if (p.method !== 'YIPAY') return false;
    if (['FORFEITED', 'CANCELLED', 'REVERSED'].includes(p.status)) return false;
    if (p.status === 'AWAITING_TERMINAL') return true;
    return !(p.rrn && p.authCode);
  });
}

/** 退費單可否中止：任一外部管道已退款即不可（避免吞款） */
export function canAbortRefund(payments) {
  return !payments.some(
    (p) => ['LINEPAY', 'PAYUNI', 'YIPAY'].includes(p.method) && (p.status === 'REFUNDED' || p.status === 'PROCESSING'),
  );
}
