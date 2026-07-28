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
export function resolveMaxPeriodTimes(order, promotion) {
  const fromOrder = parseInt(order?.periodTimes, 10);
  if (Number.isInteger(fromOrder) && fromOrder > 0) return fromOrder;
  if (Number.isInteger(fromOrder) && fromOrder === 0) {
    const fromPromo = parseInt(promotion?.periodCount, 10);
    if (Number.isInteger(fromPromo) && fromPromo > 0) return fromPromo;
    return 0;
  }
  const fromPromo = parseInt(promotion?.periodCount, 10);
  if (Number.isInteger(fromPromo) && fromPromo > 0) return fromPromo;
  return 0;
}

/**
 * 首期 UPP 成功後建立訂閱（idempotent：同 originOrderId 不重複）
 */
export async function createSubscriptionFromPaidOrder(order, {
  promotion,
  creditHash,
  now = new Date(),
} = {}) {
  if (!order || order.cardMode !== 'RECURRING') return null;
  const hash = String(creditHash || order.creditHash || '').trim();
  if (!hash) {
    console.warn(`⚠️ 訂單 ${order.id} 為定期定額但缺少 CreditHash，無法建立續扣訂閱`);
    return null;
  }
  if (!promotion?.id) {
    console.warn(`⚠️ 訂單 ${order.id} 無法解析方案，略過訂閱建立`);
    return null;
  }

  const existing = await prisma.cardSubscription.findFirst({
    where: { originOrderId: order.id },
  });
  if (existing) return existing;

  const periodType = String(order.periodType || 'M').toUpperCase();
  const periodTimes = resolveMaxPeriodTimes(order, promotion);
  const recurringOverride = Number(order.recurringAmount);
  const amount =
    Number.isFinite(recurringOverride) && recurringOverride > 0
      ? recurringOverride
      : Number(order.cardAmount > 0 ? order.cardAmount : order.amount);
  const nextChargeAt = computeNextChargeAt(periodType, now);

  const status =
    periodTimes > 0 && periodTimes <= 1 ? 'COMPLETED' : 'ACTIVE';

  let sub;
  try {
    sub = await prisma.cardSubscription.create({
      data: {
        id: generateSubscriptionId(),
        memberId: order.memberId,
        promotionId: promotion.id,
        originOrderId: order.id,
        creditHash: hash,
        amount,
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

  console.log(
    `🔁 已建立定期定額訂閱 ${sub.id}（會員#${sub.memberId} · 方案#${sub.promotionId} · 下次 ${nextChargeAt.toISOString()}）`,
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
  const itemDesc = `${buildTopupItemDesc(sub.promotion, '定期定額續扣', 1)} | 訂閱#${sub.id} | 期${periodIndex}`;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.order.create({
        data: {
          id: orderId,
          memberId: sub.memberId,
          amount: sub.amount,
          itemDesc,
          payMethod: 'CARD',
          cardAmount: sub.amount,
          cardMode: 'RECURRING',
          periodType: sub.periodType,
          periodTimes: sub.periodTimes,
          creditHash: sub.creditHash,
          status: 'PENDING',
        },
      });
      await tx.cardSubscriptionCharge.create({
        data: {
          id: chargeId,
          subscriptionId: sub.id,
          orderId,
          amount: sub.amount,
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
    amount: sub.amount,
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

  const durationOverride = isUnlimitedPromotion(sub.promotion)
    ? resolveRecurringPeriodDays(sub.promotion)
    : undefined;

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

    await fulfillPromotionPurchase(tx, sub.memberId, sub.promotion, {
      qty: 1,
      durationDaysOverride: durationOverride ?? undefined,
    });

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

  // 續扣發票（失敗不擋主流程）；品名含「代為處理折讓」
  try {
    const invoiceResult = await issueInvoice({
      id: orderId,
      amount: sub.amount,
      itemDesc: buildRecurringInvoiceItemDesc(sub.promotion?.name, { periodIndex }),
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

  console.log(`✅ 訂閱 ${sub.id} 第 ${periodIndex} 期扣款成功 → 訂單 ${orderId}`);
  return { ok: true, orderId, chargeId, periodIndex };
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
