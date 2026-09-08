// lib/cardSubscription.js — 信用卡定期定額：建訂閱、排程續扣、履約、換卡
import prisma from './prisma.js';
import {
  buildCardCheckoutRequest,
  chargeWithCreditHash,
  resolveBindVerifyAmount,
  resolvePayuniPeriodHash,
  stopPayuniRecurringForSubscription,
  resumePayuniRecurringForSubscription,
  resolveNextChargeAtFromDateList,
  resolveNextChargeAtFromPeriodSchedule,
  extractPeriodTradeNo,
  queryPayuniPeriod,
  summarizePayuniPeriodSchedule,
} from './payuni.js';
import {
  buildTopupItemDesc,
  fulfillPromotionPurchase,
  isUnlimitedPromotion,
  resolvePromotionRecurringAmount,
  resolveRecurringPeriodDays,
  buildRecurringInvoiceItemDesc,
} from './promotion.js';
import { issueInvoice } from './ezpay.js';
import { generateSubscriptionOrderId } from './orderIds.js';

const MAX_FAILS = 3;
const DEFAULT_TICK_MS = 60_000;
/** 排程 claim 鎖定時間（毫秒），避免多實例／重疊 tick 雙扣 */
const CLAIM_LOCK_MS = 5 * 60 * 1000;

/** lastError 標記：櫃檯／會員已開換卡頁，等待 PayUNi Notify */
export const REBIND_PENDING_MARKER = 'REBIND_PENDING';
export const REBIND_DONE_MARKER = '換卡約定完成；CreditHash 已更新';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function generateSubscriptionId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `CRS${dateStr}${randomStr}`;
}

function generateChargeId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `CRC${dateStr}${randomStr}`;
}

/**
 * 計算下次扣款時間（以天數遞延）
 * - W: +7 天
 * - M: +30 天
 * - Y: +365 天
 * @param {'W'|'M'|'Y'} periodType
 * @param {Date} from
 */
export function computeNextChargeAt(periodType, from = new Date()) {
  const pt = String(periodType || 'M').toUpperCase();
  const days = pt === 'W' ? 7 : pt === 'Y' ? 365 : 30;
  // 與效期一致：起始日算第 1 天 → 下期自「第 days+1 天」00:00 起扣
  const next = new Date(from);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

/** PayUNi 代扣時曾用的本機略過佔位日（勿再寫入；僅辨識舊資料） */
export const PLACEHOLDER_NEXT_CHARGE_AT = new Date('2099-01-01T00:00:00.000Z');

export function isPlaceholderNextChargeAt(value) {
  if (!value) return true;
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return true;
  return t >= Date.UTC(2090, 0, 1);
}

/**
 * 請假／顯示用的「預期下次扣款」：若 DB 仍是 2099 佔位，改以 lastChargeAt／現在推算
 * （PERIOD 訂閱應優先用 PayUNi DateList／period/query，見 syncNextChargeAtFromPayuni）
 */
export function resolveExpectedNextChargeAt(sub, now = new Date()) {
  if (sub?.nextChargeAt && !isPlaceholderNextChargeAt(sub.nextChargeAt)) {
    return new Date(sub.nextChargeAt);
  }
  const from = sub?.lastChargeAt ? new Date(sub.lastChargeAt) : new Date(now);
  return computeNextChargeAt(sub?.periodType || 'M', from);
}

function sameLocalYmd(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/**
 * 以 PayUNi period/query 的下一筆「排程中」日覆寫 nextChargeAt（僅 PERIOD: 訂閱）
 * @returns {Promise<object>} 更新後的訂閱列（未變則原列）
 */
export async function syncNextChargeAtFromPayuni(sub, { now = new Date() } = {}) {
  if (!sub?.id || !isExternalPeriodSubscription(sub)) return sub;
  const periodNo = extractPeriodTradeNo(sub);
  if (!periodNo) return sub;

  const query = await queryPayuniPeriod({ periodTradeNo: periodNo });
  if (!query.ok) return sub;
  const schedule = summarizePayuniPeriodSchedule(query.data);
  const next = resolveNextChargeAtFromPeriodSchedule(schedule, now);
  if (!next) return sub;
  if (sameLocalYmd(sub.nextChargeAt, next)) return sub;

  try {
    return await prisma.cardSubscription.update({
      where: { id: sub.id },
      data: { nextChargeAt: next },
    });
  } catch {
    return { ...sub, nextChargeAt: next };
  }
}

/** 列表用：對 ACTIVE 的 PERIOD 訂閱批次對齊 PayUNi 下次扣款日 */
export async function syncPeriodNextChargeAtsFromPayuni(rows = [], { now = new Date() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    if (
      row?.status === 'ACTIVE' &&
      isExternalPeriodSubscription(row) &&
      extractPeriodTradeNo(row)
    ) {
      out.push(await syncNextChargeAtFromPayuni(row, { now }));
    } else {
      out.push(row);
    }
  }
  return out;
}

/** 將列表中仍為 2099 佔位的 nextChargeAt 寫回真實預期日（顯示／請假用） */
export async function repairPlaceholderNextChargeAts(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    if (!row?.id || !isPlaceholderNextChargeAt(row.nextChargeAt)) {
      out.push(row);
      continue;
    }
    const hash = String(row.creditHash || '').trim();
    // 真實 CreditHash 用遠日防與金流雙扣：禁止「修復」成近期，否則本機排程會重扣
    if (hash && !hash.startsWith(EXTERNAL_PERIOD_HASH_PREFIX)) {
      out.push(row);
      continue;
    }
    const nextChargeAt = resolveExpectedNextChargeAt(row);
    try {
      await prisma.cardSubscription.update({
        where: { id: row.id },
        data: { nextChargeAt },
      });
      out.push({ ...row, nextChargeAt });
    } catch {
      out.push({ ...row, nextChargeAt });
    }
  }
  return out;
}

/**
 * 解析總期數：訂單 periodTimes 優先；0 則用方案 periodCount；仍無則 0（不限）
 */
export function resolveMaxPeriodTimes(order, promotion, coursePlan = null) {
  const fromOrder = parseInt(order?.periodTimes, 10);
  if (Number.isInteger(fromOrder) && fromOrder > 0) return fromOrder;
  if (Number.isInteger(fromOrder) && fromOrder === 0) {
    const fromPromo = parseInt(promotion?.periodCount, 10);
    if (Number.isInteger(fromPromo) && fromPromo > 0) return fromPromo;
    return 0;
  }
  const fromPromo = parseInt(promotion?.periodCount, 10);
  if (Number.isInteger(fromPromo) && fromPromo > 0) return fromPromo;
  const fromCourse = parseInt(coursePlan?.recurringPeriods, 10);
  // course bitmask 2/4/6 不是「總期數」；總期數應來自 order.periodTimes
  if (fromCourse === 2 || fromCourse === 4) return fromCourse;
  return 0;
}

/** 依期別決定本期扣款金額（最末期可用 amountFinal） */
export function resolvePeriodChargeAmount(sub, periodIndex) {
  const finalAmt = Number(sub?.amountFinal);
  const times = parseInt(sub?.periodTimes, 10);
  if (
    Number.isFinite(finalAmt) &&
    finalAmt > 0 &&
    Number.isInteger(times) &&
    times > 0 &&
    periodIndex === times
  ) {
    return Math.round(finalAmt * 100) / 100;
  }
  return Math.round((Number(sub?.amount) || 0) * 100) / 100;
}

const EXTERNAL_PERIOD_HASH_PREFIX = 'PERIOD:';

/** 是否為續期收款頁訂閱（無真實 CreditHash，本機不幕後扣） */
export function isExternalPeriodSubscription(subOrHash) {
  const h =
    typeof subOrHash === 'string'
      ? subOrHash
      : String(subOrHash?.creditHash || '');
  return h.startsWith(EXTERNAL_PERIOD_HASH_PREFIX) || !h.trim();
}

/**
 * 首期付款成功後建立訂閱（idempotent：同 originOrderId 不重複）
 * promotion 與 coursePlan 擇一。
 * 無 CreditHash（續期收款頁）時仍建訂閱，creditHash 存 PERIOD:… 佔位，本機排程略過。
 */
export async function createSubscriptionFromPaidOrder(order, {
  promotion = null,
  coursePlan = null,
  creditHash,
  periodTradeNo: periodTradeNoRaw,
  amountFinal: amountFinalOverride = undefined,
  dateList = null,
  nextChargeAt: nextChargeAtHint = null,
  now = new Date(),
} = {}) {
  if (!order || String(order.cardMode || '').toUpperCase() !== 'RECURRING') return null;
  const realHash = String(creditHash || order.creditHash || '').trim();
  const periodNo = String(periodTradeNoRaw || '').trim() || null;
  const hash =
    realHash ||
    `${EXTERNAL_PERIOD_HASH_PREFIX}${periodNo || order.id}`;

  if (!realHash) {
    console.warn(
      `⚠️ 訂單 ${order.id} 定期定額無 CreditHash（續期收款頁常見）→ 仍建立訂閱，續扣交由 PayUNi`,
    );
  }
  if (!promotion?.id && !coursePlan?.id) {
    console.warn(`⚠️ 訂單 ${order.id} 無法解析儲值／課程方案，略過訂閱建立`);
    return null;
  }
  if (promotion?.id && coursePlan?.id) {
    console.warn(`⚠️ 訂單 ${order.id} 同時帶入儲值與課程方案，略過訂閱建立`);
    return null;
  }

  const existing = await prisma.cardSubscription.findFirst({
    where: { originOrderId: order.id },
  });
  if (existing) {
    // 約定 Notify 晚到：補齊 PeriodTradeNo／下次扣款日（以 DateList 為準）
    if (periodNo || dateList || nextChargeAtHint || realHash) {
      return applyCardSubscriptionCreditUpdate(existing.id, {
        creditHash: realHash || existing.creditHash || hash,
        periodTradeNo: periodNo || extractPeriodTradeNo(existing),
        dateList,
        nextChargeAt: nextChargeAtHint,
      });
    }
    return existing;
  }

  const periodType = String(order.periodType || 'M').toUpperCase();
  let periodTimes = resolveMaxPeriodTimes(order, promotion, coursePlan);
  // 儲值方案：總期數權威＝方案有效期 periodCount
  if (promotion?.id) {
    const fromPromo = parseInt(promotion.periodCount, 10);
    if (Number.isInteger(fromPromo) && fromPromo > 0) {
      periodTimes = fromPromo;
    }
  }

  const recurringOverride = Number(order.recurringAmount);
  let amount =
    Number.isFinite(recurringOverride) && recurringOverride > 0
      ? recurringOverride
      : Number(order.cardAmount > 0 ? order.cardAmount : order.amount);
  // 儲值方案：續期金額＝recurringAmount（可與首期不同）
  if (promotion?.id) {
    const periodAmt = resolvePromotionRecurringAmount(promotion);
    if (periodAmt != null && periodAmt > 0) amount = periodAmt;
  }

  let amountFinal = null;
  if (amountFinalOverride !== undefined) {
    const v = Number(amountFinalOverride);
    amountFinal = Number.isFinite(v) && v > 0 ? v : null;
  } else {
    const fromOrder = Number(order.recurringAmountFinal);
    if (Number.isFinite(fromOrder) && fromOrder > 0) amountFinal = fromOrder;
    else if (coursePlan?.recurringAmountFinal != null) {
      const v = Number(coursePlan.recurringAmountFinal);
      if (Number.isFinite(v) && v > 0) amountFinal = v;
    }
  }

  // 下次扣款：PERIOD 優先 DateList／指定日；否則本機 +30 天推算（僅本機幕後續扣適用）
  const fromHint =
    nextChargeAtHint instanceof Date && !Number.isNaN(nextChargeAtHint.getTime())
      ? nextChargeAtHint
      : nextChargeAtHint
        ? new Date(nextChargeAtHint)
        : null;
  const fromList = resolveNextChargeAtFromDateList(dateList, now);
  const nextChargeAt =
    (fromHint && !Number.isNaN(fromHint.getTime()) ? fromHint : null) ||
    fromList ||
    computeNextChargeAt(periodType, now);

  const status =
    periodTimes > 0 && periodTimes <= 1 ? 'COMPLETED' : 'ACTIVE';

  let sub;
  try {
    sub = await prisma.cardSubscription.create({
      data: {
        id: generateSubscriptionId(),
        memberId: order.memberId,
        promotionId: promotion?.id || null,
        coursePlanId: coursePlan?.id || null,
        originOrderId: order.id,
        creditHash: hash,
        amount,
        amountFinal,
        periodType: ['W', 'M', 'Y'].includes(periodType) ? periodType : 'M',
        periodTimes,
        chargedCount: 1,
        status,
        nextChargeAt,
        lastChargeAt: now,
        failCount: 0,
        lastError: realHash ? null : '無 CreditHash：續扣由 PayUNi 續期收款排程',
      },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      sub = await prisma.cardSubscription.findFirst({ where: { originOrderId: order.id } });
    } else {
      throw err;
    }
  }
  if (!sub) return null;

  const targetLabel = promotion?.id
    ? `方案#${promotion.id}`
    : `課程方案#${coursePlan.id}`;
  console.log(
    `🔁 已建立定期定額訂閱 ${sub.id}（會員#${sub.memberId} · ${targetLabel} · 共${periodTimes || '不限'}期 · ${realHash ? `下次 ${nextChargeAt.toISOString()}` : 'PayUNi 排程／無本機續扣'}）`,
  );
  return sub;
}

/**
 * 已付款定期定額訂單若缺訂閱列則補建（Notify 舊版略過／CHK 與 CRS 分流不一致）
 * @returns {Promise<object|null>}
 */
export async function ensureSubscriptionForPaidRecurringOrder(order, {
  creditHash,
  periodTradeNo,
  dateList = null,
  promotion = null,
  coursePlan = null,
} = {}) {
  if (!order || String(order.status || '').toUpperCase() !== 'PAID') return null;
  if (String(order.cardMode || '').toUpperCase() !== 'RECURRING') return null;

  const existing = await prisma.cardSubscription.findFirst({
    where: { originOrderId: order.id },
  });
  if (existing) {
    const incoming = String(creditHash || order.creditHash || '').trim();
    if (incoming && incoming !== existing.creditHash) {
      return applyCardSubscriptionCreditUpdate(existing.id, {
        creditHash: incoming,
        periodTradeNo,
        dateList,
      });
    }
    if (dateList || periodTradeNo) {
      return applyCardSubscriptionCreditUpdate(existing.id, {
        creditHash: existing.creditHash,
        periodTradeNo: periodTradeNo || extractPeriodTradeNo(existing),
        dateList,
      });
    }
    return existing;
  }

  let promo = promotion;
  let course = coursePlan;
  if (!promo?.id && !course?.id) {
    const promoMatch = String(order.itemDesc || '').match(/商品#(\d+)/);
    const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
    if (promotionId) {
      promo = await prisma.promotion.findUnique({ where: { id: promotionId } });
    }
    if (!promo?.id) {
      const courseMatch = String(order.itemDesc || '').match(/課程方案#(\d+)/);
      const coursePlanId = courseMatch ? parseInt(courseMatch[1], 10) : null;
      if (coursePlanId) {
        course = await prisma.coursePlan.findUnique({ where: { id: coursePlanId } });
      }
    }
  }

  return createSubscriptionFromPaidOrder(order, {
    promotion: promo,
    coursePlan: course,
    creditHash: creditHash || order.creditHash,
    periodTradeNo: periodTradeNo || null,
    dateList,
    amountFinal: order.recurringAmountFinal ?? undefined,
  });
}

/**
 * Notify／人工：回寫訂閱 CreditHash（換卡或首約補綁）
 * @returns {Promise<object|null>}
 */
export async function applyCardSubscriptionCreditUpdate(
  subscriptionId,
  { creditHash, periodTradeNo, dateList = null, nextChargeAt: nextChargeAtHint = null, mode = 'notify' } = {},
) {
  const id = String(subscriptionId || '').trim();
  if (!id) return null;
  const realHash = String(creditHash || '').trim();
  const periodNo = String(periodTradeNo || '').trim();
  const hash =
    realHash ||
    (periodNo ? `${EXTERNAL_PERIOD_HASH_PREFIX}${periodNo}` : '');
  if (!hash) return null;

  const sub = await prisma.cardSubscription.findUnique({ where: { id } });
  if (!sub) return null;

  const becomesReal = Boolean(realHash) && !realHash.startsWith(EXTERNAL_PERIOD_HASH_PREFIX);
  const far = PLACEHOLDER_NEXT_CHARGE_AT;
  let nextChargeAt = sub.nextChargeAt;
  let lastError = sub.lastError;

  const fromHint =
    nextChargeAtHint instanceof Date && !Number.isNaN(nextChargeAtHint.getTime())
      ? nextChargeAtHint
      : nextChargeAtHint
        ? new Date(nextChargeAtHint)
        : null;
  const fromList = resolveNextChargeAtFromDateList(dateList, new Date());

  if (mode === 'manual') {
    if (becomesReal) {
      nextChargeAt = isPlaceholderNextChargeAt(sub.nextChargeAt)
        ? computeNextChargeAt(sub.periodType, new Date())
        : sub.nextChargeAt;
      lastError = '人工更新 CreditHash';
    }
  } else if (becomesReal) {
    // 續期頁若回真實 Token：本機置遠日，避免與 PayUNi 排程雙扣（顯示／請假另以 resolveExpectedNextChargeAt）
    nextChargeAt = far;
    lastError = REBIND_DONE_MARKER;
  } else if (periodNo || hash.startsWith(EXTERNAL_PERIOD_HASH_PREFIX)) {
    // PERIOD：下次扣款以 PayUNi DateList 為準（勿用 +30 天估算）
    if (fromHint && !Number.isNaN(fromHint.getTime())) {
      nextChargeAt = fromHint;
    } else if (fromList) {
      nextChargeAt = fromList;
    } else if (isPlaceholderNextChargeAt(sub.nextChargeAt)) {
      nextChargeAt = resolveExpectedNextChargeAt(sub);
    }
    lastError = `${REBIND_DONE_MARKER}（PERIOD:${periodNo || extractPeriodTradeNo(hash)}）`;
  } else {
    lastError = REBIND_DONE_MARKER;
  }

  const updated = await prisma.cardSubscription.update({
    where: { id },
    data: {
      creditHash: hash,
      failCount: 0,
      status: sub.status === 'FAILED' || mode === 'manual' ? 'ACTIVE' : sub.status,
      nextChargeAt,
      lastError,
    },
  });

  if (sub.originOrderId && realHash && !realHash.startsWith(EXTERNAL_PERIOD_HASH_PREFIX)) {
    await prisma.order.updateMany({
      where: { id: sub.originOrderId },
      data: { creditHash: realHash },
    });
  }

  // PERIOD 若 Notify 無 DateList，補查 period/query
  if (
    isExternalPeriodSubscription(updated) &&
    extractPeriodTradeNo(updated) &&
    !fromList &&
    !(fromHint && !Number.isNaN(fromHint.getTime()))
  ) {
    return syncNextChargeAtFromPayuni(updated);
  }

  console.log(`🔁 訂閱 ${id} CreditHash 已更新（${mode}）`);
  return updated;
}

/**
 * 計算換卡約定剩餘期數（至少 1）
 */
export function resolveRebindRemainTimes(sub, promotion = null) {
  const total = parseInt(sub?.periodTimes, 10);
  const charged = parseInt(sub?.chargedCount, 10);
  const used = Number.isInteger(charged) && charged > 0 ? charged : 0;
  if (Number.isInteger(total) && total > 0) {
    return Math.max(1, total - used);
  }
  const promoCount = parseInt(promotion?.periodCount, 10);
  if (Number.isInteger(promoCount) && promoCount > 0) {
    return Math.max(1, promoCount - used);
  }
  // 不限期：PayUNi 仍要 PeriodTimes；給足夠期數供約定
  return 36;
}

/**
 * 開 PayUNi 續期頁換卡：臨櫃 $1 驗證授權後取消（不請款）；線上預設不收款
 * @param {string} subscriptionId
 * @param {{ channel?: 'counter'|'online' }} [opts]
 */
export async function buildSubscriptionRebindRequest(
  subscriptionId,
  { channel = 'counter' } = {},
) {
  const id = String(subscriptionId || '').trim();
  if (!id) throw httpError('請提供訂閱編號');

  const sub = await prisma.cardSubscription.findUnique({
    where: { id },
    include: {
      promotion: true,
      coursePlan: true,
      member: { select: { id: true, name: true } },
    },
  });
  if (!sub) throw httpError('找不到訂閱', 404);
  if (!['ACTIVE', 'PAUSED', 'FAILED'].includes(String(sub.status))) {
    throw httpError('僅進行中／暫停／扣款失敗的訂閱可換卡');
  }

  const periodAmt = resolvePeriodChargeAmount(sub, (parseInt(sub.chargedCount, 10) || 0) + 1);
  if (!(periodAmt > 0)) {
    throw httpError('訂閱扣款金額無效，無法換卡');
  }
  const remainTimes = resolveRebindRemainTimes(sub, sub.promotion);
  const periodChannel = channel === 'online' ? 'online' : 'counter';
  const payuniPeriodHash = resolvePayuniPeriodHash({
    channel: periodChannel,
    promotion: sub.promotion,
    coursePlan: sub.coursePlan,
  });

  const bindMerTradeNo = `${id}R${String(Date.now()).slice(-6)}`.slice(0, 25);
  const itemDesc = sub.promotion?.name || sub.coursePlan?.name || '定期定額換卡';

  await prisma.cardSubscription.update({
    where: { id },
    data: { lastError: REBIND_PENDING_MARKER },
  });

  try {
    const bindOrder = {
      id: bindMerTradeNo,
      bindSubscriptionId: id,
      bindOnly: true,
      rebind: true,
      itemDesc,
      cardMode: 'RECURRING',
      periodType: sub.periodType || 'M',
      periodTimes: remainTimes,
      periodAmt,
      recurringAmount: periodAmt,
      payuniPeriodHash,
      channel: periodChannel,
      promotion: sub.promotion,
      coursePlan: sub.coursePlan,
    };
    const verifyAmt = resolveBindVerifyAmount(bindOrder);
    const { actionUrl, payload } = buildCardCheckoutRequest({
      ...bindOrder,
      amount: verifyAmt,
    });
    return {
      subscriptionId: id,
      memberId: sub.memberId,
      memberName: sub.member?.name || null,
      channel: periodChannel,
      needsPeriodBind: true,
      bindOnly: true,
      rebind: true,
      actionUrl,
      payload,
      periodAmt,
      periodTimes: remainTimes,
      tradeAmt: verifyAmt,
      fAmt: verifyAmt,
      verifyAmt,
      rebindPending: true,
      messageHint:
        periodChannel === 'online'
          ? verifyAmt > 0
            ? `請於 PayUNi 頁面輸入新卡（$${verifyAmt} 驗證授權，隨後取消不請款）；完成後自動更新扣款信用卡`
            : '請於 PayUNi 頁面輸入新卡完成約定（本次不收款）；完成後自動更新扣款信用卡'
          : verifyAmt > 0
            ? `請會員於 PayUNi 續期頁輸入新卡（$${verifyAmt} 驗證授權，隨後取消不請款；第 2 期起 PeriodAmt $${periodAmt}）`
            : '請會員於 PayUNi 續期頁輸入新卡完成約定（本次不收款）',
    };
  } catch (err) {
    await prisma.cardSubscription.update({
      where: { id },
      data: { lastError: err.message || '開換卡頁失敗' },
    });
    throw err;
  }
}

export function isRebindPending(sub) {
  return String(sub?.lastError || '') === REBIND_PENDING_MARKER;
}

/**
 * 訂閱換卡輪詢狀態（不回傳原始 CreditHash）
 */
export function toRebindStatusView(sub) {
  if (!sub) return null;
  return {
    subscriptionId: sub.id,
    status: sub.status,
    rebindPending: isRebindPending(sub),
    hasCreditHash: Boolean(String(sub.creditHash || '').trim()),
    creditUpdated:
      String(sub.lastError || '').startsWith('換卡約定完成') ||
      String(sub.lastError || '') === REBIND_DONE_MARKER,
    lastError: isRebindPending(sub) ? REBIND_PENDING_MARKER : sub.lastError || null,
    updatedAt: sub.updatedAt,
    nextChargeAt: sub.nextChargeAt,
  };
}

/**
 * 執行單筆到期訂閱的續扣（claim + 期別唯一）
 */
export async function processOneSubscription(subscriptionId, { now = new Date() } = {}) {
  const lockUntil = new Date(now.getTime() + CLAIM_LOCK_MS);

  const claimed = await prisma.cardSubscription.updateMany({
    where: {
      id: subscriptionId,
      status: 'ACTIVE',
      nextChargeAt: { lte: now },
    },
    data: { nextChargeAt: lockUntil },
  });
  if (claimed.count === 0) {
    return { ok: false, skipped: true, reason: 'claimed_or_not_due' };
  }

  const sub = await prisma.cardSubscription.findUnique({
    where: { id: subscriptionId },
    include: {
      promotion: true,
      coursePlan: true,
      member: { select: { id: true, name: true } },
    },
  });
  if (!sub || sub.status !== 'ACTIVE') {
    return { ok: false, skipped: true, reason: 'not_active' };
  }
  if (isExternalPeriodSubscription(sub)) {
    // 續期收款頁訂閱：本機不幕後扣；推進顯示用下次扣款，勿再寫 2099
    await prisma.cardSubscription.update({
      where: { id: sub.id },
      data: {
        nextChargeAt: computeNextChargeAt(sub.periodType, now),
        lastError: '無 CreditHash：續扣由 PayUNi 排程，本機略過',
      },
    });
    return { ok: false, skipped: true, reason: 'external_period_no_credit_hash' };
  }
  if (sub.periodTimes > 0 && sub.chargedCount >= sub.periodTimes) {
    await prisma.cardSubscription.update({
      where: { id: sub.id },
      data: { status: 'COMPLETED' },
    });
    return { ok: true, completed: true };
  }

  const periodIndex = sub.chargedCount + 1;
  const chargeAmount = resolvePeriodChargeAmount(sub, periodIndex);
  if (!(chargeAmount > 0)) {
    await prisma.cardSubscription.update({
      where: { id: sub.id },
      data: {
        status: 'FAILED',
        lastError: '續扣金額無效',
        nextChargeAt: sub.nextChargeAt,
      },
    });
    return { ok: false, message: '續扣金額無效' };
  }

  const existingCharge = await prisma.cardSubscriptionCharge.findUnique({
    where: {
      subscriptionId_periodIndex: {
        subscriptionId: sub.id,
        periodIndex,
      },
    },
  });
  if (existingCharge) {
    if (existingCharge.status === 'PAID') {
      return { ok: true, skipped: true, reason: 'already_paid', orderId: existingCharge.orderId };
    }
    if (existingCharge.status === 'PENDING' && existingCharge.orderId) {
      return { ok: false, skipped: true, reason: 'charge_in_progress', orderId: existingCharge.orderId };
    }
  }

  const orderId = generateSubscriptionOrderId();
  const chargeId = generateChargeId();
  const planName =
    sub.promotion?.name ||
    sub.coursePlan?.name ||
    (sub.coursePlanId ? `課程方案#${sub.coursePlanId}` : '定期定額');
  const itemDesc = sub.promotion
    ? `${buildTopupItemDesc(sub.promotion, '定期定額續扣', 1)} | 訂閱#${sub.id} | 期${periodIndex}`
    : `課程定期定額續扣 | ${planName} | 課程方案#${sub.coursePlanId} | 訂閱#${sub.id} | 期${periodIndex}`;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.order.create({
        data: {
          id: orderId,
          memberId: sub.memberId,
          amount: chargeAmount,
          itemDesc,
          payMethod: 'CARD',
          cardAmount: chargeAmount,
          cardMode: 'RECURRING',
          periodType: sub.periodType,
          periodTimes: sub.periodTimes,
          recurringAmount: sub.amount,
          recurringAmountFinal: sub.amountFinal,
          creditHash: sub.creditHash,
          status: 'PENDING',
        },
      });
      await tx.cardSubscriptionCharge.create({
        data: {
          id: chargeId,
          subscriptionId: sub.id,
          orderId,
          amount: chargeAmount,
          periodIndex,
          status: 'PENDING',
          attemptedAt: now,
        },
      });
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return { ok: false, skipped: true, reason: 'duplicate_period' };
    }
    await prisma.cardSubscription.update({
      where: { id: sub.id },
      data: { nextChargeAt: computeNextChargeAt(sub.periodType, now) },
    });
    throw err;
  }

  const chargeResult = await chargeWithCreditHash({
    merTradeNo: orderId,
    amount: chargeAmount,
    itemDesc,
    creditHash: sub.creditHash,
  });

  if (!chargeResult.ok) {
    const failCount = sub.failCount + 1;
    const giveUp = failCount >= MAX_FAILS;
    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'FAILED' },
      });
      await tx.cardSubscriptionCharge.update({
        where: { id: chargeId },
        data: {
          status: 'FAILED',
          errorMessage: chargeResult.message || '扣款失敗',
          merchantNo: chargeResult.tradeNo || null,
        },
      });
      await tx.cardSubscription.update({
        where: { id: sub.id },
        data: {
          failCount,
          lastError: chargeResult.message || '扣款失敗',
          status: giveUp ? 'FAILED' : 'ACTIVE',
          // 失敗後延後重試：明天同時間再試（未達上限）
          nextChargeAt: giveUp ? sub.nextChargeAt : new Date(now.getTime() + 24 * 60 * 60 * 1000),
        },
      });
    });
    console.error(
      `❌ 訂閱 ${sub.id} 第 ${periodIndex} 期扣款失敗（${failCount}/${MAX_FAILS}）：${chargeResult.message}`,
    );
    return { ok: false, orderId, chargeId, message: chargeResult.message, giveUp };
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'PAID',
        merchantNo: chargeResult.tradeNo || null,
        creditHash: sub.creditHash,
      },
    });
    await tx.cardSubscriptionCharge.update({
      where: { id: chargeId },
      data: {
        status: 'PAID',
        merchantNo: chargeResult.tradeNo || null,
        paidAt: now,
      },
    });

    // 儲值方案續扣才履約（延長效期／入帳）；課程首期已給滿堂數，續扣僅收款
    if (sub.promotion) {
      const durationOverride = isUnlimitedPromotion(sub.promotion)
        ? resolveRecurringPeriodDays(sub.promotion)
        : undefined;
      await fulfillPromotionPurchase(tx, sub.memberId, sub.promotion, {
        qty: 1,
        durationDaysOverride: durationOverride ?? undefined,
      });
    }

    const chargedCount = sub.chargedCount + 1;
    const completed = sub.periodTimes > 0 && chargedCount >= sub.periodTimes;
    await tx.cardSubscription.update({
      where: { id: sub.id },
      data: {
        chargedCount,
        failCount: 0,
        lastError: null,
        lastChargeAt: now,
        nextChargeAt: completed ? sub.nextChargeAt : computeNextChargeAt(sub.periodType, now),
        status: completed ? 'COMPLETED' : 'ACTIVE',
      },
    });
  });

  // 續扣發票（失敗不擋主流程）
  try {
    const invoiceResult = await issueInvoice({
      id: orderId,
      amount: chargeAmount,
      itemDesc: buildRecurringInvoiceItemDesc(planName, { periodIndex }),
      buyerName: sub.member?.name || '會員',
    });
    if (invoiceResult.Status === 'SUCCESS') {
      const invoiceData = JSON.parse(invoiceResult.Result);
      await prisma.order.update({
        where: { id: orderId },
        data: { invoiceNumber: invoiceData.InvoiceNumber },
      });
    }
  } catch (err) {
    console.error(`❌ 訂閱續扣 ${orderId} 發票失敗:`, err.message);
  }

  console.log(`✅ 訂閱 ${sub.id} 第 ${periodIndex} 期扣款成功 → 訂單 ${orderId} $${chargeAmount}`);
  return { ok: true, orderId, chargeId, periodIndex, amount: chargeAmount };
}

/**
 * 掃描並處理所有到期訂閱
 */
export async function processDueSubscriptions({ limit = 20, now = new Date() } = {}) {
  const due = await prisma.cardSubscription.findMany({
    where: {
      status: 'ACTIVE',
      nextChargeAt: { lte: now },
      // 略過 PERIOD: 佔位（續期收款頁／PayUNi 排程）
      NOT: { creditHash: { startsWith: EXTERNAL_PERIOD_HASH_PREFIX } },
    },
    orderBy: { nextChargeAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  const results = [];
  for (const row of due) {
    try {
      const r = await processOneSubscription(row.id, { now });
      results.push({ id: row.id, ...r });
    } catch (error) {
      console.error(`❌ 處理訂閱 ${row.id} 例外:`, error);
      results.push({ id: row.id, ok: false, message: error.message });
    }
  }
  return { processed: results.length, results };
}

export async function cancelCardSubscription(
  id,
  { reason, stopPayuni = true, forceLocalOnly = false } = {},
) {
  const sub = await prisma.cardSubscription.findUnique({ where: { id } });
  if (!sub) {
    const err = new Error('找不到訂閱');
    err.statusCode = 404;
    throw err;
  }
  if (sub.status === 'CANCELLED' || sub.status === 'COMPLETED') {
    return { subscription: sub, payuniStop: { ok: true, skipped: true, message: '訂閱已停' } };
  }

  let payuniStop = { ok: true, skipped: true };
  if (stopPayuni) {
    try {
      payuniStop = await stopPayuniRecurringForSubscription(sub, { mode: 'terminate' });
    } catch (e) {
      payuniStop = { ok: false, message: e.message || '停 PayUNi 續期失敗' };
    }
    if (!payuniStop.ok && !payuniStop.skipped && !forceLocalOnly) {
      console.error(
        `[取消訂閱] ${id} PayUNi 續期未停：${payuniStop.message}` +
          (payuniStop.periodTradeNo ? `（PeriodTradeNo=${payuniStop.periodTradeNo}）` : ''),
      );
      const err = new Error(
        payuniStop.message ||
          'PayUNi 續期排程尚未終止，本機訂閱未取消（避免顯示已停卻仍扣款）',
      );
      err.statusCode = 409;
      err.payuniStop = payuniStop;
      throw err;
    }
    if (!payuniStop.ok && !payuniStop.skipped) {
      console.error(
        `[取消訂閱] ${id} forceLocalOnly：本機將取消，但 PayUNi 未停：${payuniStop.message}`,
      );
    }
  }

  const noteParts = [reason ? String(reason).slice(0, 160) : '手動取消'];
  if (payuniStop?.ok && !payuniStop.skipped) {
    noteParts.push('PayUNi 續期已終止');
  } else if (payuniStop && !payuniStop.ok && !payuniStop.skipped) {
    noteParts.push(`PayUNi 續期未停：${String(payuniStop.message || '').slice(0, 80)}`);
  }

  const subscription = await prisma.cardSubscription.update({
    where: { id },
    data: {
      status: 'CANCELLED',
      lastError: noteParts.join('｜').slice(0, 200),
    },
  });
  return { subscription, payuniStop };
}

export async function pauseCardSubscription(id, { stopPayuni = true, forceLocalOnly = false } = {}) {
  const sub = await prisma.cardSubscription.findUnique({ where: { id } });
  if (!sub) {
    const err = new Error('找不到訂閱');
    err.statusCode = 404;
    throw err;
  }
  if (sub.status !== 'ACTIVE') {
    const err = new Error('僅 ACTIVE 訂閱可暫停');
    err.statusCode = 400;
    throw err;
  }

  let payuniStop = { ok: true, skipped: true };
  if (stopPayuni) {
    try {
      payuniStop = await stopPayuniRecurringForSubscription(sub, { mode: 'suspend' });
    } catch (e) {
      payuniStop = { ok: false, message: e.message || '暫停 PayUNi 續期失敗' };
    }
    if (!payuniStop.ok && !payuniStop.skipped && !forceLocalOnly) {
      const err = new Error(
        payuniStop.message ||
          'PayUNi 續期排程尚未暫停，本機訂閱未暫停（避免顯示已停卻仍扣款）',
      );
      err.statusCode = 409;
      err.payuniStop = payuniStop;
      throw err;
    }
  }

  const subscription = await prisma.cardSubscription.update({
    where: { id },
    data: {
      status: 'PAUSED',
      lastError:
        payuniStop?.ok && !payuniStop.skipped
          ? '已暫停（含 PayUNi 續期）'
          : payuniStop && !payuniStop.ok && !payuniStop.skipped
            ? `本機已暫停；PayUNi：${String(payuniStop.message || '').slice(0, 120)}`
            : null,
    },
  });
  return { subscription, payuniStop };
}

export async function resumeCardSubscription(
  id,
  { now = new Date(), resumePayuni = true, forceLocalOnly = false } = {},
) {
  const sub = await prisma.cardSubscription.findUnique({ where: { id } });
  if (!sub) {
    const err = new Error('找不到訂閱');
    err.statusCode = 404;
    throw err;
  }
  if (sub.status !== 'PAUSED') {
    const err = new Error('僅 PAUSED 訂閱可恢復');
    err.statusCode = 400;
    throw err;
  }
  if (sub.periodTimes > 0 && sub.chargedCount >= sub.periodTimes) {
    const subscription = await prisma.cardSubscription.update({
      where: { id },
      data: { status: 'COMPLETED' },
    });
    return { subscription, payuniResume: { ok: true, skipped: true, message: '期數已滿' } };
  }

  let payuniResume = { ok: true, skipped: true };
  if (resumePayuni) {
    try {
      payuniResume = await resumePayuniRecurringForSubscription(sub);
    } catch (e) {
      payuniResume = { ok: false, message: e.message || '恢復 PayUNi 續期失敗' };
    }
    if (!payuniResume.ok && !payuniResume.skipped && !forceLocalOnly) {
      const err = new Error(
        payuniResume.message ||
          'PayUNi 續期未能啟用，本機訂閱未恢復（避免顯示已恢復卻不扣款）',
      );
      err.statusCode = 409;
      err.payuniResume = payuniResume;
      throw err;
    }
  }

  const next =
    sub.nextChargeAt > now ? sub.nextChargeAt : computeNextChargeAt(sub.periodType, now);
  const subscription = await prisma.cardSubscription.update({
    where: { id },
    data: {
      status: 'ACTIVE',
      nextChargeAt: next,
      failCount: 0,
      lastError:
        payuniResume?.ok && !payuniResume.skipped
          ? '已恢復（含 PayUNi 續期）'
          : payuniResume && !payuniResume.ok && !payuniResume.skipped
            ? `本機已恢復；PayUNi：${String(payuniResume.message || '').slice(0, 120)}`
            : null,
    },
  });
  return { subscription, payuniResume };
}

let schedulerTimer = null;

/**
 * 啟動行程內排程（預設每 60 秒掃一次到期訂閱）
 */
export function startCardRecurringScheduler({ intervalMs } = {}) {
  if (schedulerTimer) return;
  const ms = Number(intervalMs) || Number(process.env.CARD_RECURRING_TICK_MS) || DEFAULT_TICK_MS;
  const enabled = String(process.env.CARD_RECURRING_SCHEDULER || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    console.log('[定期定額] 排程已關閉（CARD_RECURRING_SCHEDULER=false）');
    return;
  }

  console.log(`[定期定額] 排程啟動，每 ${ms}ms 掃描到期訂閱`);
  const tick = async () => {
    try {
      const { processed } = await processDueSubscriptions({ limit: 20 });
      if (processed > 0) {
        console.log(`[定期定額] 本輪處理 ${processed} 筆到期訂閱`);
      }
    } catch (error) {
      console.error('[定期定額] 排程例外:', error.message);
    }
  };
  // 延遲首輪，避免與啟動搶資源
  setTimeout(() => {
    void tick();
    schedulerTimer = setInterval(() => void tick(), ms);
    if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  }, Math.min(ms, 15_000));
}
