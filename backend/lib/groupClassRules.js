// lib/groupClassRules.js — 付費期班團課：定價／插班比例／退費（消保）／名額／請假補課 純規則
export const TERM = 'TERM';
export const DROP_IN = 'DROP_IN';
export const ENROLL_KINDS = [TERM, DROP_IN];

/** 請假須於開課前 ≥24 小時，才取得補課權 */
export const LEAVE_MIN_HOURS = 24;
/** 單堂取消須於開課前 ≥24 小時，才全額退費 */
export const DROP_IN_REFUND_HOURS = 24;
/** 消保 7 日猶豫期（未使用任何服務全額退） */
export const COOLING_OFF_DAYS = 7;
export const REFUND_FEE_RATE = 0.2;
export const REFUND_FEE_CAP = 5000;
/** 補課權有效期：原期班結束後 N 日 */
export const MAKEUP_VALID_DAYS_AFTER_END = 30;
/** 待付款保留名額（臨櫃／線上） */
export const HOLD_MINUTES = 30;
/** 候補遞補後付款期限 */
export const WAITLIST_OFFER_HOURS = 24;
/** 開班人數判定截止：預設開課前 N 日（台北日界 23:59:59） */
export const DEFAULT_ENROLL_DEADLINE_DAYS = 2;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function roundNtd(n) {
  return Math.round(Number(n) || 0);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function normalizeEnrollKind(raw) {
  const k = String(raw || TERM).trim().toUpperCase();
  if (!ENROLL_KINDS.includes(k)) {
    const err = new Error('kind 僅支援 TERM（整期）或 DROP_IN（單堂）');
    err.statusCode = 400;
    throw err;
  }
  return k;
}

/**
 * 整期報價；開課後插班按剩餘堂數比例計價（後端唯一計價）
 * @returns {{ price:number, unitPrice:number, sessions:number, prorated:boolean }}
 */
export function quoteTermPrice({ termPrice, sessionCount, remainingSessions }) {
  const total = Number(sessionCount) || 0;
  const remaining = Number(remainingSessions) || 0;
  const base = Number(termPrice);
  if (!(total > 0) || !Number.isFinite(base) || base < 0) {
    const err = new Error('期班未設定有效價格／堂數，無法報名');
    err.statusCode = 409;
    err.code = 'SERIES_NOT_SELLABLE';
    throw err;
  }
  if (remaining <= 0) {
    const err = new Error('期班已無剩餘堂次，無法報名');
    err.statusCode = 409;
    err.code = 'SERIES_ENDED';
    throw err;
  }
  const sessions = Math.min(remaining, total);
  const prorated = sessions < total;
  const price = prorated ? roundNtd((base * sessions) / total) : roundNtd(base);
  return { price, unitPrice: round2(base / total), sessions, prorated };
}

export function quoteDropInPrice({ dropInPrice }) {
  const p = Number(dropInPrice);
  if (dropInPrice == null || !Number.isFinite(p) || p <= 0) {
    const err = new Error('此期班未開放單堂報名');
    err.statusCode = 409;
    err.code = 'DROP_IN_DISABLED';
    throw err;
  }
  return { price: roundNtd(p), unitPrice: roundNtd(p), sessions: 1, prorated: false };
}

/**
 * 名額：期班整體可用＝各剩餘堂最少空位；候補（已遞補＋等待中）優先保留
 * 單堂／補課只能用「超出候補保留」的空位
 */
export function computeSeatAvailability({ classFree, minFree, offersOthers = 0, waitingOthers = 0 }) {
  const reserved = Math.max(0, offersOthers) + Math.max(0, waitingOthers);
  const term = Math.max(0, minFree) - reserved;
  const single =
    classFree == null ? null : Math.max(0, classFree) - Math.min(Math.max(0, minFree), reserved);
  return { term, single, reserved };
}

export function hoursUntil(at, now = new Date()) {
  return (new Date(at).getTime() - now.getTime()) / HOUR_MS;
}

export function canLeaveWithMakeup(classStartAt, now = new Date()) {
  return hoursUntil(classStartAt, now) >= LEAVE_MIN_HOURS;
}

/** 補課權到期：期班結束日（台北）+ N 日之 23:59:59 */
export function makeupExpiresAt(seriesEndDate) {
  const d = new Date(seriesEndDate);
  const ymd = d.toISOString().slice(0, 10);
  const endOfDay = new Date(`${ymd}T23:59:59.999+08:00`);
  return new Date(endOfDay.getTime() + MAKEUP_VALID_DAYS_AFTER_END * DAY_MS);
}

/** 開班判定截止（YYYY-MM-DD 台北日 23:59:59）；未給則開課前 N 日 */
export function resolveEnrollDeadline({ startDate, enrollDeadline }) {
  const start = String(startDate || '').trim();
  let ymd = enrollDeadline ? String(enrollDeadline).trim() : '';
  if (!ymd) {
    const d = new Date(`${start}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - DEFAULT_ENROLL_DEADLINE_DAYS);
    ymd = d.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    const err = new Error('enrollDeadline 須為 YYYY-MM-DD');
    err.statusCode = 400;
    throw err;
  }
  if (ymd >= start) {
    const err = new Error('開班判定截止日必須早於期班開始日');
    err.statusCode = 400;
    throw err;
  }
  return new Date(`${ymd}T23:59:59.999+08:00`);
}

/**
 * 退費試算（消保法定型化契約）
 * - 期班遭取消：未履約部分全額退、無手續費
 * - 整期：7 日內且未使用 → 全額；否則 應退＝實付 − 已使用堂數×單堂價 − min(未履約×20%, 5000)
 * - 單堂：開課前 ≥24h 全額退；逾時或已開課不退
 */
export function computeGroupRefund({
  kind,
  price,
  unitPrice,
  consumedSessions = 0,
  paidAt,
  seriesCancelled = false,
  classStartAt = null,
  now = new Date(),
}) {
  const paid = roundNtd(price);
  if (kind === DROP_IN) {
    if (seriesCancelled) {
      return { refundable: true, kind: 'SERIES_CANCELLED', refundAmount: paid, fee: 0, consumedValue: 0, unfulfilled: paid };
    }
    if (classStartAt && new Date(classStartAt) <= now) {
      return { refundable: false, code: 'DROP_IN_STARTED', message: '單堂課程已開始，不予退費', refundAmount: 0, fee: 0 };
    }
    if (classStartAt && hoursUntil(classStartAt, now) < DROP_IN_REFUND_HOURS) {
      return {
        refundable: false,
        code: 'DROP_IN_TOO_LATE',
        message: `單堂須於開課前 ${DROP_IN_REFUND_HOURS} 小時取消才可退費`,
        refundAmount: 0,
        fee: 0,
      };
    }
    return { refundable: true, kind: 'DROP_IN', refundAmount: paid, fee: 0, consumedValue: 0, unfulfilled: paid };
  }

  const consumed = Math.max(0, Number(consumedSessions) || 0);
  const consumedValue = Math.min(paid, roundNtd(consumed * (Number(unitPrice) || 0)));
  const unfulfilled = Math.max(0, paid - consumedValue);

  if (seriesCancelled) {
    return { refundable: unfulfilled > 0, kind: 'SERIES_CANCELLED', refundAmount: unfulfilled, fee: 0, consumedValue, unfulfilled };
  }
  const paidMs = paidAt ? new Date(paidAt).getTime() : null;
  if (consumed === 0 && paidMs != null && now.getTime() - paidMs <= COOLING_OFF_DAYS * DAY_MS) {
    return { refundable: paid > 0, kind: 'COOLING_OFF', refundAmount: paid, fee: 0, consumedValue: 0, unfulfilled: paid };
  }
  const fee = Math.min(roundNtd(unfulfilled * REFUND_FEE_RATE), REFUND_FEE_CAP);
  const refundAmount = Math.max(0, unfulfilled - fee);
  return { refundable: refundAmount > 0, kind: 'STANDARD', refundAmount, fee, consumedValue, unfulfilled };
}

/**
 * 依原付款明細按比例拆出退款管道；零錢包退回本金、LinePay 可線上退、其餘臨櫃人工退
 */
export function splitRefundChannels({ payBreakdown, paymentTotal, refundAmount }) {
  const refund = roundNtd(refundAmount);
  const total = Number(paymentTotal) || 0;
  const bd = payBreakdown && typeof payBreakdown === 'object' ? payBreakdown : {};
  if (!(refund > 0)) return { WALLET_CASH: 0, LINEPAY: 0, MANUAL: 0 };
  if (!(total > 0)) return { WALLET_CASH: 0, LINEPAY: 0, MANUAL: refund };
  const ratio = Math.min(1, refund / total);
  const wallet = Math.min(refund, roundNtd((Number(bd.WALLET_CASH) || 0) * ratio));
  const linePay = Math.min(refund - wallet, roundNtd((Number(bd.LINEPAY) || 0) * ratio));
  return { WALLET_CASH: wallet, LINEPAY: linePay, MANUAL: refund - wallet - linePay };
}
