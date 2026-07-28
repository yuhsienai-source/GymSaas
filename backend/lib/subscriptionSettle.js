// lib/subscriptionSettle.js — 取消訂閱制月卡：效期結算 + ezPay 折讓
import prisma from './prisma.js';
import {
  buildCutExpireNow,
  isUnlimitedPromotion,
  isUnlimitedTopupOrder,
  remainingExpireDays,
  resolveRecurringPeriodDays,
} from './promotion.js';
import { cancelCardSubscription } from './cardSubscription.js';
import {
  appendInvoiceReverseNote,
  executeInvoiceReverse,
  resolveOrderInvoiceReverse,
  syncCheckoutInvoiceAfterReverse,
  reevaluateCheckoutSessionStatus,
} from './ezpayReverse.js';

/**
 * 效期政策：
 * - KEEP：只停續扣，已付效期保留（預設）
 * - CUT_UNUSED：立刻截斷效期並降為計時；可搭配 doAllowance 對最近一期訂單折讓未使用天數
 * - CUT_NO_ALLOWANCE：立刻截斷效期，不呼叫 ezPay（人工退款）
 */
export const EXPIRE_POLICIES = ['KEEP', 'CUT_UNUSED', 'CUT_NO_ALLOWANCE'];

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * 找出訂閱最近一筆已付款訂單（續扣 charge 優先，否則 originOrder）
 */
export async function findLatestPaidOrderForSubscription(sub) {
  const lastCharge = await prisma.cardSubscriptionCharge.findFirst({
    where: { subscriptionId: sub.id, status: 'PAID', orderId: { not: null } },
    orderBy: { periodIndex: 'desc' },
  });
  if (lastCharge?.orderId) {
    const order = await prisma.order.findUnique({ where: { id: lastCharge.orderId } });
    if (order?.status === 'PAID') {
      return { order, periodIndex: lastCharge.periodIndex, source: 'charge' };
    }
  }
  if (sub.originOrderId) {
    const order = await prisma.order.findUnique({ where: { id: sub.originOrderId } });
    if (order?.status === 'PAID') {
      return { order, periodIndex: 1, source: 'origin' };
    }
  }
  return { order: null, periodIndex: null, source: null };
}

/**
 * 依未使用天數比例計算應折讓金額（以本期天數為分母，上限為訂單金額）
 */
export function computeUnusedAllowanceAmount({
  orderAmount,
  unusedDays,
  periodDays,
}) {
  const amount = roundMoney(orderAmount);
  const unused = Math.max(0, Number(unusedDays) || 0);
  const period = Math.max(1, Number(periodDays) || 1);
  if (amount <= 0 || unused <= 0) return 0;
  const ratioDays = Math.min(unused, period);
  return roundMoney((amount * ratioDays) / period);
}

/**
 * 取消訂閱並依政策處理效期／折讓
 *
 * @param {string} subscriptionId
 * @param {{
 *   reason?: string,
 *   expirePolicy?: 'KEEP'|'CUT_UNUSED'|'CUT_NO_ALLOWANCE',
 *   doAllowance?: boolean,
 *   now?: Date,
 * }} opts
 * doAllowance 僅在 CUT_UNUSED 時有效（預設 true）
 */
export async function settleCancelSubscription(
  subscriptionId,
  { reason, expirePolicy = 'KEEP', doAllowance, now = new Date() } = {},
) {
  const policy = String(expirePolicy || 'KEEP').toUpperCase();
  if (!EXPIRE_POLICIES.includes(policy)) {
    throw httpError(`expirePolicy 無效，允許：${EXPIRE_POLICIES.join(' / ')}`);
  }

  const sub = await prisma.cardSubscription.findUnique({
    where: { id: subscriptionId },
    include: {
      promotion: true,
      member: true,
    },
  });
  if (!sub) throw httpError('找不到訂閱', 404);

  if (sub.status === 'CANCELLED') {
    return {
      subscription: sub,
      member: sub.member,
      expirePolicy: policy,
      unusedDays: remainingExpireDays(sub.member?.expireDate, now),
      allowance: null,
      invoice: { action: 'none' },
      alreadyCancelled: true,
    };
  }

  const wantAllowance =
    policy === 'CUT_UNUSED' && (doAllowance === undefined ? true : Boolean(doAllowance));

  const periodDays =
    resolveRecurringPeriodDays(sub.promotion) ||
    sub.promotion?.unitDays ||
    sub.promotion?.durationDays ||
    30;

  const unusedDays = remainingExpireDays(sub.member?.expireDate, now);
  const latest = await findLatestPaidOrderForSubscription(sub);

  let invoiceReverse = { action: 'none', invoiceNumber: null };
  let allowanceMeta = null;

  if (wantAllowance && latest.order) {
    if (!isUnlimitedPromotion(sub.promotion) && !String(latest.order.itemDesc || '').includes('UNLIMITED')) {
      // 非無限方案：取消訂閱通常不走此折讓；仍允許依未使用天數比例
    }
    const allowanceAmt = computeUnusedAllowanceAmount({
      orderAmount: latest.order.amount,
      unusedDays,
      periodDays,
    });
    allowanceMeta = {
      orderId: latest.order.id,
      periodIndex: latest.periodIndex,
      periodDays,
      unusedDays,
      allowanceAmt,
      invoiceNumber: latest.order.invoiceNumber || null,
    };

    if (allowanceAmt > 0 && latest.order.invoiceNumber) {
      // 強制走折讓（部分金額），不用作廢整張
      const ctx = await resolveOrderInvoiceReverse(latest.order, {
        refundCash: allowanceAmt,
      });
      // 覆蓋為 allowance + 指定金額
      const forceCtx = {
        ...ctx,
        skip: false,
        prefer: 'allowance',
        amount: allowanceAmt,
        itemDesc: `${latest.order.itemDesc || '月卡'}｜取消訂閱未使用折讓`,
        invoiceNumber: latest.order.invoiceNumber,
        merchantOrderNo: ctx.merchantOrderNo,
      };
      try {
        invoiceReverse = await executeInvoiceReverse(forceCtx, { reason: reason || '取消訂閱' });
      } catch (ezErr) {
        const err = new Error(
          ezErr.message || 'ezPay 折讓失敗，取消訂閱已中止（效期／訂閱未異動）',
        );
        err.statusCode = ezErr.statusCode || 502;
        throw err;
      }
    } else if (allowanceAmt > 0 && !latest.order.invoiceNumber) {
      allowanceMeta.note = '最近一期訂單無發票，略過 ezPay；請人工退款';
    } else {
      allowanceMeta.note = '未使用天數為 0 或無可折讓金額';
    }
  }

  // 先取消訂閱（停續扣）
  const cancelled = await cancelCardSubscription(sub.id, {
    reason: reason || `取消訂閱（${policy}）`,
  });

  let updatedMember = sub.member;
  if (policy === 'CUT_UNUSED' || policy === 'CUT_NO_ALLOWANCE') {
    const cut = buildCutExpireNow(sub.member, now);
    updatedMember = await prisma.$transaction(async (tx) => {
      const m = await tx.member.update({
        where: { id: sub.memberId },
        data: {
          expireDate: cut.expireDate,
          plan: cut.plan,
          leaveUntil: null,
        },
      });
      // 進行中請假一併結束
      await tx.memberLeave.updateMany({
        where: { memberId: sub.memberId, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: now, reason: '取消訂閱截斷效期' },
      });
      if (latest.order && invoiceReverse.action !== 'none') {
        await tx.order.update({
          where: { id: latest.order.id },
          data: {
            itemDesc: appendInvoiceReverseNote(
              `${latest.order.itemDesc || ''}｜取消訂閱折讓未使用 ${unusedDays} 天`,
              invoiceReverse,
            ),
          },
        });
        await syncCheckoutInvoiceAfterReverse(
          tx,
          latest.order.checkoutSessionId,
          invoiceReverse,
        );
        await reevaluateCheckoutSessionStatus(tx, latest.order.checkoutSessionId);
      }
      return m;
    });
  } else if (invoiceReverse.action !== 'none' && latest.order) {
    // KEEP 不應走到折讓；防禦
    await prisma.order.update({
      where: { id: latest.order.id },
      data: {
        itemDesc: appendInvoiceReverseNote(latest.order.itemDesc, invoiceReverse),
      },
    });
  }

  return {
    subscription: cancelled,
    member: updatedMember,
    expirePolicy: policy,
    unusedDays,
    periodDays,
    allowance: allowanceMeta,
    invoice: invoiceReverse,
    alreadyCancelled: false,
  };
}

/**
 * 解析月卡訂單的方案天數（一次付清／現金無訂閱）
 */
async function resolveUnlimitedOrderPeriodDays(order) {
  const promoMatch = String(order.itemDesc || '').match(/商品#(\d+)/);
  const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
  let promotion = null;
  if (promotionId) {
    promotion = await prisma.promotion.findUnique({ where: { id: promotionId } });
  }
  const daysFromDesc = String(order.itemDesc || '').match(/天數\+(\d+)/);
  const periodDays =
    resolveRecurringPeriodDays(promotion) ||
    promotion?.unitDays ||
    promotion?.durationDays ||
    (daysFromDesc ? parseInt(daysFromDesc[1], 10) : null) ||
    30;
  return { promotion, periodDays };
}

/**
 * 預覽：一次付清／現金月卡（無 CardSubscription）取消結算
 */
export async function previewCancelUnlimitedOrder(orderId, { now = new Date() } = {}) {
  const order = await prisma.order.findUnique({
    where: { id: String(orderId || '').trim() },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          memberNo: true,
          plan: true,
          expireDate: true,
          leaveUntil: true,
        },
      },
    },
  });
  if (!order) throw httpError('找不到此訂單', 404);
  if (!isUnlimitedTopupOrder(order.itemDesc)) {
    throw httpError('此訂單不是訂閱制月卡購案');
  }
  if (order.status !== 'PAID') {
    throw httpError(`訂單狀態為 [${order.status}]，僅已付款可取消結算`);
  }

  const { promotion, periodDays } = await resolveUnlimitedOrderPeriodDays(order);
  const unusedDays = remainingExpireDays(order.member?.expireDate, now);
  const estimatedAllowance = computeUnusedAllowanceAmount({
    orderAmount: order.amount,
    unusedDays,
    periodDays,
  });

  return {
    kind: 'UNLIMITED_ORDER',
    subscription: null,
    order: {
      id: order.id,
      amount: order.amount,
      invoiceNumber: order.invoiceNumber,
      status: order.status,
      cardMode: order.cardMode,
      payMethod: order.payMethod,
    },
    member: order.member,
    promotion: promotion
      ? {
          id: promotion.id,
          name: promotion.name,
          usageType: promotion.usageType,
          unitDays: promotion.unitDays,
          durationDays: promotion.durationDays,
          branchId: promotion.branchId,
        }
      : null,
    expirePolicies: EXPIRE_POLICIES,
    unusedDays,
    periodDays,
    latestOrder: {
      id: order.id,
      amount: order.amount,
      invoiceNumber: order.invoiceNumber,
      status: order.status,
      periodIndex: 1,
    },
    estimatedAllowance,
  };
}

/**
 * 取消一次付清／現金月卡（無定期定額訂閱）
 * - KEEP：僅標記訂單 CANCELLED，效期保留
 * - CUT_UNUSED：截斷效期；可對未使用天數開立折讓，訂單 REFUNDED
 * - CUT_NO_ALLOWANCE：截斷效期，訂單 CANCELLED，不呼叫 ezPay
 */
export async function settleCancelUnlimitedOrder(
  orderId,
  { reason, expirePolicy = 'KEEP', doAllowance, now = new Date() } = {},
) {
  const policy = String(expirePolicy || 'KEEP').toUpperCase();
  if (!EXPIRE_POLICIES.includes(policy)) {
    throw httpError(`expirePolicy 無效，允許：${EXPIRE_POLICIES.join(' / ')}`);
  }

  const order = await prisma.order.findUnique({
    where: { id: String(orderId || '').trim() },
    include: { member: true },
  });
  if (!order) throw httpError('找不到此訂單', 404);
  if (!isUnlimitedTopupOrder(order.itemDesc)) {
    throw httpError('此訂單不是訂閱制月卡購案');
  }
  if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
    return {
      kind: 'UNLIMITED_ORDER',
      order,
      member: order.member,
      expirePolicy: policy,
      unusedDays: remainingExpireDays(order.member?.expireDate, now),
      allowance: null,
      invoice: { action: 'none' },
      alreadyCancelled: true,
    };
  }
  if (order.status !== 'PAID') {
    throw httpError(`訂單狀態為 [${order.status}]，僅已付款可取消結算`);
  }

  // 若其實已有訂閱，應走訂閱結算
  const linkedSub = await prisma.cardSubscription.findFirst({
    where: { originOrderId: order.id },
  });
  if (linkedSub) {
    return settleCancelSubscription(linkedSub.id, {
      reason,
      expirePolicy: policy,
      doAllowance,
      now,
    });
  }

  const { periodDays } = await resolveUnlimitedOrderPeriodDays(order);
  const unusedDays = remainingExpireDays(order.member?.expireDate, now);
  const wantAllowance =
    policy === 'CUT_UNUSED' && (doAllowance === undefined ? true : Boolean(doAllowance));

  let invoiceReverse = { action: 'none', invoiceNumber: null };
  let allowanceMeta = null;

  if (wantAllowance) {
    const allowanceAmt = computeUnusedAllowanceAmount({
      orderAmount: order.amount,
      unusedDays,
      periodDays,
    });
    allowanceMeta = {
      orderId: order.id,
      periodIndex: 1,
      periodDays,
      unusedDays,
      allowanceAmt,
      invoiceNumber: order.invoiceNumber || null,
    };

    if (allowanceAmt > 0 && order.invoiceNumber) {
      const ctx = await resolveOrderInvoiceReverse(order, { refundCash: allowanceAmt });
      const forceCtx = {
        ...ctx,
        skip: false,
        prefer: 'allowance',
        amount: allowanceAmt,
        itemDesc: `${order.itemDesc || '月卡'}｜取消月卡未使用折讓`,
        invoiceNumber: order.invoiceNumber,
        merchantOrderNo: ctx.merchantOrderNo,
      };
      try {
        invoiceReverse = await executeInvoiceReverse(forceCtx, {
          reason: reason || '取消月卡購案',
        });
      } catch (ezErr) {
        const err = new Error(
          ezErr.message || 'ezPay 折讓失敗，取消已中止（效期／訂單未異動）',
        );
        err.statusCode = ezErr.statusCode || 502;
        throw err;
      }
    } else if (allowanceAmt > 0 && !order.invoiceNumber) {
      allowanceMeta.note = '訂單無發票，略過 ezPay；請人工退款';
    } else {
      allowanceMeta.note = '未使用天數為 0 或無可折讓金額';
    }
  } else if (policy === 'CUT_NO_ALLOWANCE' || policy === 'KEEP') {
    // 取消沖回：有整張發票且無合併存活子單時嘗試作廢
    if (policy !== 'KEEP' && order.invoiceNumber) {
      try {
        const ctx = await resolveOrderInvoiceReverse(order, {
          refundCash: roundMoney(order.amount),
        });
        if (!ctx.sharedInvoice && ctx.invoiceNumber) {
          invoiceReverse = await executeInvoiceReverse(
            { ...ctx, prefer: 'void', skip: false },
            { reason: reason || '取消月卡購案沖回' },
          );
        }
      } catch (ezErr) {
        console.warn(`月卡訂單 ${order.id} 發票作廢略過:`, ezErr.message);
      }
    }
  }

  const nextStatus =
    policy === 'CUT_UNUSED' && invoiceReverse.action === 'allowance'
      ? 'REFUNDED'
      : 'CANCELLED';

  const updated = await prisma.$transaction(async (tx) => {
    let member = order.member;
    if (policy === 'CUT_UNUSED' || policy === 'CUT_NO_ALLOWANCE') {
      const cut = buildCutExpireNow(order.member, now);
      member = await tx.member.update({
        where: { id: order.memberId },
        data: {
          expireDate: cut.expireDate,
          plan: cut.plan,
          leaveUntil: null,
        },
      });
      await tx.memberLeave.updateMany({
        where: { memberId: order.memberId, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: now, reason: '取消月卡截斷效期' },
      });
    }

    const note =
      policy === 'KEEP'
        ? `｜取消沖回（效期保留）`
        : `｜取消月卡截斷效期（原剩餘 ${unusedDays} 天）`;
    const updatedOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        status: nextStatus,
        itemDesc: appendInvoiceReverseNote(`${order.itemDesc || ''}${note}`, invoiceReverse),
      },
    });
    await syncCheckoutInvoiceAfterReverse(tx, order.checkoutSessionId, invoiceReverse);
    await reevaluateCheckoutSessionStatus(tx, order.checkoutSessionId);
    return { order: updatedOrder, member };
  });

  return {
    kind: 'UNLIMITED_ORDER',
    order: updated.order,
    member: updated.member,
    expirePolicy: policy,
    unusedDays,
    periodDays,
    allowance: allowanceMeta,
    invoice: invoiceReverse,
    alreadyCancelled: false,
    subscriptionId: null,
  };
}
