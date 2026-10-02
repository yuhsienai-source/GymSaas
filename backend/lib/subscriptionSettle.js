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
  assertRealInvoiceForAllowance,
  executeInvoiceReverse,
  resolveOrderInvoiceReverse,
  syncCheckoutInvoiceAfterReverse,
  reevaluateCheckoutSessionStatus,
} from './ezpayReverse.js';
import { issuedInvoiceFor } from './einvoice.js';

/**
 * 效期政策：
 * - KEEP：只停續扣，已付效期保留（預設）
 * - CUT_UNUSED：立刻截斷效期並降為計時；可搭配 doAllowance 對最近一期訂單折讓（30 日月卡退費基準）
 * - CUT_NO_ALLOWANCE：立刻截斷效期，不呼叫 ezPay（人工退款）
 */
export const EXPIRE_POLICIES = ['KEEP', 'CUT_UNUSED', 'CUT_NO_ALLOWANCE'];

/** 30 日月卡／訂閱終止退費手續費（新台幣） */
export const MONTHLY_CARD_REFUND_FEE = 500;
/**
 * 本期已使用天數門檻：未滿十五日可退；滿／逾十五日以一期計、無法退費
 * （不以每 15 日為半期）
 */
export const MONTHLY_CARD_MID_PERIOD_DAYS = 15;

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 訂單目前有效發票號（EInvoice ISSUED）；直接掛在 order 物件供退費流程使用 */
async function withIssuedInvoice(order) {
  if (!order) return order;
  const inv = await issuedInvoiceFor(order.id);
  return { ...order, invoiceNumber: inv?.invoiceNumber || null };
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
    const order = await withIssuedInvoice(await prisma.order.findUnique({ where: { id: lastCharge.orderId } }));
    if (order?.status === 'PAID') {
      return { order, periodIndex: lastCharge.periodIndex, source: 'charge' };
    }
  }
  if (sub.originOrderId) {
    const order = await withIssuedInvoice(await prisma.order.findUnique({ where: { id: sub.originOrderId } }));
    if (order?.status === 'PAID') {
      return { order, periodIndex: 1, source: 'origin' };
    }
  }
  return { order: null, periodIndex: null, source: null };
}

/**
 * 30 日月卡／訂閱制終止契約退費基準：
 * - 30 日為一期；不每 15 日以半期計，逾 15 日以一期計
 * - 未滿十五日：退費 =（已繳金額）×（契約存續比例）− 手續費 $500
 * - 逾／滿十五日：以一個月計，無法辦理退費
 * 契約存續比例 = min(剩餘天數, 契約總天數) / 契約總天數
 * （訂閱每期請款：契約總天數＝本期天數；一次付清多期：契約總天數＝durationDays）
 *
 * @returns {{
 *   amount: number,
 *   usedDays: number,
 *   unusedInPeriod: number,
 *   periodDays: number,
 *   contractDays: number,
 *   ratio: number,
 *   fee: number,
 *   eligible: boolean,
 *   note: string,
 * }}
 */
export function computeMonthlyCardRefundDetail({
  orderAmount,
  unusedDays,
  periodDays,
  contractDays,
  fee = MONTHLY_CARD_REFUND_FEE,
}) {
  const paid = roundMoney(orderAmount);
  const period = Math.max(1, Number(periodDays) || 30);
  const contract = Math.max(period, Number(contractDays) || period);
  const unused = Math.max(0, Number(unusedDays) || 0);
  const unusedCapped = Math.min(unused, contract);
  const usedTotal = Math.max(0, contract - unusedCapped);
  const usedDays = usedTotal % period; // 本期已使用天數（0～period-1；恰滿整期時為 0）
  const refundFee = Math.max(0, Number(fee) || 0);

  if (paid <= 0) {
    return {
      amount: 0,
      usedDays,
      unusedInPeriod: Math.min(unusedCapped, period),
      periodDays: period,
      contractDays: contract,
      ratio: 0,
      fee: refundFee,
      eligible: false,
      note: '訂單金額無效',
    };
  }
  if (unusedCapped <= 0) {
    return {
      amount: 0,
      usedDays: period,
      unusedInPeriod: 0,
      periodDays: period,
      contractDays: contract,
      ratio: 0,
      fee: refundFee,
      eligible: false,
      note: '未使用天數為 0，無可退費',
    };
  }
  // 滿／逾十五日：本期以一期計，無法辦理退費
  if (usedDays >= MONTHLY_CARD_MID_PERIOD_DAYS) {
    return {
      amount: 0,
      usedDays,
      unusedInPeriod: period - usedDays,
      periodDays: period,
      contractDays: contract,
      ratio: 0,
      fee: refundFee,
      eligible: false,
      note: `本期已使用 ${usedDays} 日（≥${MONTHLY_CARD_MID_PERIOD_DAYS} 日），以一期計，無法辦理退費`,
    };
  }

  const ratio = unusedCapped / contract;
  const gross = roundMoney(paid * ratio);
  const amount = Math.max(0, roundMoney(gross - refundFee));
  return {
    amount,
    usedDays,
    unusedInPeriod: period - usedDays,
    periodDays: period,
    contractDays: contract,
    ratio: Math.round(ratio * 10000) / 10000,
    fee: refundFee,
    eligible: amount > 0,
    note:
      amount > 0
        ? `未滿十五日：$${paid} × ${(ratio * 100).toFixed(1)}% − 手續費$${refundFee} = $${amount}`
        : `折讓計算後 ≤ 0（$${paid} × 存續比例 − 手續費$${refundFee}）`,
  };
}

/** @deprecated 請優先用 computeMonthlyCardRefundDetail；此函式僅回傳金額 */
export function computeUnusedAllowanceAmount(opts) {
  return computeMonthlyCardRefundDetail(opts).amount;
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
 *   staffId?: number|null,
 * }} opts
 * doAllowance 僅在 CUT_UNUSED 時有效（預設 true）
 */
export async function settleCancelSubscription(
  subscriptionId,
  { reason, expirePolicy = 'KEEP', doAllowance, now = new Date(), forceLocalOnly = false, staffId = null } = {},
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

  // 訂閱已停（例如報表先按「取消沖回 KEEP」）但訂單仍 PAID：允許接續截斷效期／退費折讓
  if (sub.status === 'CANCELLED' || sub.status === 'COMPLETED') {
    if (policy === 'KEEP') {
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
    if (sub.originOrderId) {
      return settleCancelUnlimitedOrder(sub.originOrderId, {
        reason: reason || `訂閱已停後結算（${policy}）`,
        expirePolicy: policy,
        doAllowance,
        now,
        staffId,
        // 避免再轉回本函式造成迴圈
        skipLinkedSubRedirect: true,
      });
    }
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
      // 非無限方案：取消訂閱通常不走此折讓；仍允許依月卡退費基準計算
    }
    const refundDetail = computeMonthlyCardRefundDetail({
      orderAmount: latest.order.amount,
      unusedDays,
      periodDays,
    });
    const allowanceAmt = refundDetail.amount;
    allowanceMeta = {
      orderId: latest.order.id,
      periodIndex: latest.periodIndex,
      periodDays,
      contractDays: refundDetail.contractDays,
      unusedDays,
      usedDays: refundDetail.usedDays,
      unusedInPeriod: refundDetail.unusedInPeriod,
      ratio: refundDetail.ratio,
      fee: refundDetail.fee,
      allowanceAmt,
      invoiceNumber: latest.order.invoiceNumber || null,
      note: refundDetail.note,
    };

    if (allowanceAmt > 0 && latest.order.invoiceNumber) {
      assertRealInvoiceForAllowance(latest.order.invoiceNumber, '取消訂閱退費折讓');
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
        itemDesc: `${latest.order.itemDesc || '月卡'}｜取消訂閱退費折讓`,
        invoiceNumber: latest.order.invoiceNumber,
        merchantOrderNo: ctx.merchantOrderNo,
      };
      try {
        invoiceReverse = await executeInvoiceReverse(forceCtx, {
          reason: reason || '取消訂閱',
          staffId,
          allowance: { source: 'SUB_CANCEL', orderId: latest.order.id, memberId: sub.memberId },
        });
      } catch (ezErr) {
        const err = new Error(
          ezErr.message || 'ezPay 折讓失敗，取消訂閱已中止（效期／訂閱未異動）',
        );
        err.statusCode = ezErr.statusCode || 502;
        throw err;
      }
    } else if (allowanceAmt > 0 && !latest.order.invoiceNumber) {
      const err = new Error(
        '取消訂閱退費折讓須在開票成功後才能辦理（最近一期訂單尚無發票號碼）',
      );
      err.statusCode = 400;
      throw err;
    }
  }

  // 先取消訂閱（停本機續扣＋驗證／終止 PayUNi 續期排程；失敗則整筆中止）
  const { subscription: cancelled, payuniStop } = await cancelCardSubscription(sub.id, {
    reason: reason || `取消訂閱（${policy}）`,
    forceLocalOnly,
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
  } else if (policy === 'KEEP' && latest.order) {
    // 停續扣但保留效期：訂單維持 PAID，註記方便報表辨識
    const note = '｜定期定額已停續扣（效期保留）';
    if (!String(latest.order.itemDesc || '').includes('定期定額已停續扣')) {
      await prisma.order.update({
        where: { id: latest.order.id },
        data: { itemDesc: `${latest.order.itemDesc || ''}${note}` },
      });
    }
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
    payuniStop: payuniStop || null,
    alreadyCancelled: false,
  };
}

/**
 * 解析月卡訂單的方案天數（一次付清／現金無訂閱）
 * periodDays＝每期天數（15 日門檻用）；contractDays＝整約天數（存續比例分母）
 */
export async function resolveUnlimitedOrderPeriodDays(order) {
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
    (daysFromDesc && promotion?.periodCount > 1
      ? null
      : daysFromDesc
        ? parseInt(daysFromDesc[1], 10)
        : null) ||
    30;
  const contractDays =
    promotion?.durationDays ||
    (daysFromDesc ? parseInt(daysFromDesc[1], 10) : null) ||
    periodDays;
  return { promotion, periodDays, contractDays };
}

/**
 * 預覽：一次付清／現金月卡（無 CardSubscription）取消結算
 */
export async function previewCancelUnlimitedOrder(orderId, { now = new Date() } = {}) {
  const order = await withIssuedInvoice(await prisma.order.findUnique({
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
  }));
  if (!order) throw httpError('找不到此訂單', 404);
  if (!isUnlimitedTopupOrder(order.itemDesc)) {
    throw httpError('此訂單不是訂閱制月卡購案');
  }
  if (order.status !== 'PAID') {
    throw httpError(`訂單狀態為 [${order.status}]，僅已付款可取消結算`);
  }

  const { promotion, periodDays, contractDays } = await resolveUnlimitedOrderPeriodDays(order);
  const unusedDays = remainingExpireDays(order.member?.expireDate, now);
  const refundDetail = computeMonthlyCardRefundDetail({
    orderAmount: order.amount,
    unusedDays,
    periodDays,
    contractDays,
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
    contractDays,
    usedDays: refundDetail.usedDays,
    refundDetail,
    latestOrder: {
      id: order.id,
      amount: order.amount,
      invoiceNumber: order.invoiceNumber,
      status: order.status,
      periodIndex: 1,
    },
    estimatedAllowance: refundDetail.amount,
  };
}

/**
 * 取消一次付清／現金月卡（無定期定額訂閱）
 * - KEEP：僅標記訂單 CANCELLED，效期保留
 * - CUT_UNUSED：截斷效期；可依月卡退費基準開立折讓，訂單 REFUNDED
 * - CUT_NO_ALLOWANCE：截斷效期，訂單 CANCELLED，不呼叫 ezPay
 */
export async function settleCancelUnlimitedOrder(
  orderId,
  { reason, expirePolicy = 'KEEP', doAllowance, now = new Date(), skipLinkedSubRedirect = false, staffId = null } = {},
) {
  const policy = String(expirePolicy || 'KEEP').toUpperCase();
  if (!EXPIRE_POLICIES.includes(policy)) {
    throw httpError(`expirePolicy 無效，允許：${EXPIRE_POLICIES.join(' / ')}`);
  }

  const order = await withIssuedInvoice(await prisma.order.findUnique({
    where: { id: String(orderId || '').trim() },
    include: { member: true },
  }));
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

  // 若其實已有「進行中」訂閱，應走訂閱結算；已停訂閱則繼續本函式做效期／折讓
  if (!skipLinkedSubRedirect) {
    const linkedSub = await prisma.cardSubscription.findFirst({
      where: { originOrderId: order.id },
    });
    if (
      linkedSub &&
      linkedSub.status !== 'CANCELLED' &&
      linkedSub.status !== 'COMPLETED'
    ) {
      return settleCancelSubscription(linkedSub.id, {
        reason,
        expirePolicy: policy,
        doAllowance,
        now,
        staffId,
      });
    }
  }

  const { periodDays, contractDays } = await resolveUnlimitedOrderPeriodDays(order);
  const unusedDays = remainingExpireDays(order.member?.expireDate, now);
  const wantAllowance =
    policy === 'CUT_UNUSED' && (doAllowance === undefined ? true : Boolean(doAllowance));

  let invoiceReverse = { action: 'none', invoiceNumber: null };
  let allowanceMeta = null;

  if (wantAllowance) {
    const refundDetail = computeMonthlyCardRefundDetail({
      orderAmount: order.amount,
      unusedDays,
      periodDays,
      contractDays,
    });
    const allowanceAmt = refundDetail.amount;
    allowanceMeta = {
      orderId: order.id,
      periodIndex: 1,
      periodDays,
      contractDays,
      unusedDays,
      usedDays: refundDetail.usedDays,
      unusedInPeriod: refundDetail.unusedInPeriod,
      ratio: refundDetail.ratio,
      fee: refundDetail.fee,
      allowanceAmt,
      invoiceNumber: order.invoiceNumber || null,
      note: refundDetail.note,
    };

    if (allowanceAmt > 0 && order.invoiceNumber) {
      assertRealInvoiceForAllowance(order.invoiceNumber, '取消月卡退費折讓');
      const ctx = await resolveOrderInvoiceReverse(order, { refundCash: allowanceAmt });
      const forceCtx = {
        ...ctx,
        skip: false,
        prefer: 'allowance',
        amount: allowanceAmt,
        itemDesc: `${order.itemDesc || '月卡'}｜取消月卡退費折讓`,
        invoiceNumber: order.invoiceNumber,
        merchantOrderNo: ctx.merchantOrderNo,
      };
      try {
        invoiceReverse = await executeInvoiceReverse(forceCtx, {
          reason: reason || '取消月卡購案',
          staffId,
          allowance: { source: 'SUB_CANCEL', orderId: order.id, memberId: order.memberId },
        });
      } catch (ezErr) {
        const err = new Error(
          ezErr.message || 'ezPay 折讓失敗，取消已中止（效期／訂單未異動）',
        );
        err.statusCode = ezErr.statusCode || 502;
        throw err;
      }
    } else if (allowanceAmt > 0 && !order.invoiceNumber) {
      const err = new Error(
        '取消月卡退費折讓須在開票成功後才能辦理（訂單尚無發票號碼）',
      );
      err.statusCode = 400;
      throw err;
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
            {
              reason: reason || '取消月卡購案沖回',
              staffId,
              allowance: { source: 'SUB_CANCEL', orderId: order.id, memberId: order.memberId },
            },
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
    contractDays,
    allowance: allowanceMeta,
    invoice: invoiceReverse,
    alreadyCancelled: false,
    subscriptionId: null,
  };
}
