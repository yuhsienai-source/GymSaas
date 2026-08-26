// lib/cardSubscription.js — 信用卡定期定額：建訂閱、排程續扣、履約
import prisma from './prisma.js';
import { chargeWithCreditHash } from './payuni.js';
import {
  buildTopupItemDesc,
  fulfillPromotionPurchase,
  isUnlimitedPromotion,
  resolveRecurringPeriodDays,
  buildRecurringInvoiceItemDesc,
} from './promotion.js';
import { issueInvoice } from './ezpay.js';
import { generateSubscriptionOrderId } from './orderIds.js';

const MAX_FAILS = 3;
const DEFAULT_TICK_MS = 60_000;
/** 排程 claim 鎖定時間（毫秒），避免多實例／重疊 tick 雙扣 */
const CLAIM_LOCK_MS = 5 * 60 * 1000;

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
  const base = new Date(from);
  const pt = String(periodType || 'M').toUpperCase();
  const days = pt === 'W' ? 7 : pt === 'Y' ? 365 : 30;
  base.setDate(base.getDate() + days);
  return base;
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

/**
 * 首期 UPP 成功後建立訂閱（idempotent：同 originOrderId 不重複）
 * promotion 與 coursePlan 擇一
 */
export async function createSubscriptionFromPaidOrder(order, {
  promotion = null,
  coursePlan = null,
  creditHash,
  amountFinal: amountFinalOverride = undefined,
  now = new Date(),
} = {}) {
  if (!order || order.cardMode !== 'RECURRING') return null;
  const hash = String(creditHash || order.creditHash || '').trim();
  if (!hash) {
    console.warn(`⚠️ 訂單 ${order.id} 為定期定額但缺少 CreditHash，無法建立續扣訂閱`);
    return null;
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
  if (existing) return existing;

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
  // 儲值方案：每期金額權威＝方案費用
  if (promotion?.id) {
    const price = Number(promotion.price);
    if (Number.isFinite(price) && price > 0) amount = price;
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

  const nextChargeAt = computeNextChargeAt(periodType, now);

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
    `🔁 已建立定期定額訂閱 ${sub.id}（會員#${sub.memberId} · ${targetLabel} · 共${periodTimes || '不限'}期 · 下次 ${nextChargeAt.toISOString()}）`,
  );
  return sub;
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

export async function cancelCardSubscription(id, { reason } = {}) {
  const sub = await prisma.cardSubscription.findUnique({ where: { id } });
  if (!sub) {
    const err = new Error('找不到訂閱');
    err.statusCode = 404;
    throw err;
  }
  if (sub.status === 'CANCELLED' || sub.status === 'COMPLETED') {
    return sub;
  }
  return prisma.cardSubscription.update({
    where: { id },
    data: {
      status: 'CANCELLED',
      lastError: reason ? String(reason).slice(0, 200) : '手動取消',
    },
  });
}

export async function pauseCardSubscription(id) {
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
  return prisma.cardSubscription.update({
    where: { id },
    data: { status: 'PAUSED' },
  });
}

export async function resumeCardSubscription(id, { now = new Date() } = {}) {
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
    return prisma.cardSubscription.update({
      where: { id },
      data: { status: 'COMPLETED' },
    });
  }
  const next =
    sub.nextChargeAt > now ? sub.nextChargeAt : computeNextChargeAt(sub.periodType, now);
  return prisma.cardSubscription.update({
    where: { id },
    data: { status: 'ACTIVE', nextChargeAt: next, failCount: 0, lastError: null },
  });
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
