// lib/checkout.js — 臨櫃合併結帳：商品 + 購案 + 私教同一購物車／一次付款；發票軟拆分腿開立
import prisma from './prisma.js';
import { coercePaymentsFromBody, CHECKOUT_PAY_METHODS } from './compositePay.js';
import {
  assertPromotionSellable,
  buildTopupItemDesc,
  computeTopupAmount,
  fulfillPromotionPurchase,
  isUnlimitedPromotion,
  parseTopupQtyFromItemDesc,
  resolveRecurringPeriodDays,
} from './promotion.js';
import { assertMemberSignedPromotionContracts } from './memberContract.js';
import { assertBranchAccess } from './staffAccess.js';
import {
  buildCardCheckoutRequest,
  parseCardPayOptions,
} from './payuni.js';
import { normalizeInvoiceOptions } from './ezpay.js';
import {
  buildPosLines,
  deductSaleStock,
  fulfillCardSaleOrder,
  generateSaleId,
} from './inventory.js';
import { createSubscriptionFromPaidOrder } from './cardSubscription.js';
import { buildPtCheckoutLines, fulfillPtCheckoutLines } from './ptPurchase.js';
import { resolveTopupOrderId, generateSubscriptionOrderId } from './orderIds.js';
import { issueSplitCheckoutInvoices } from './checkoutInvoice.js';
import { resolveCourseRecurringSchedule } from './coursePlan.js';

export function generateCheckoutId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `CHK${dateStr}${randomStr}`;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * 解析購物車：products + 可選單一 promotion + 私教課程列
 */
export async function resolveCheckoutCart(body, req) {
  const {
    branchId,
    memberId,
    items,
    promotionId,
    qty,
    courseItems,
    trainerId,
  } = body || {};

  const productDraft = [];
  if (Array.isArray(items)) {
    for (const row of items) {
      const productId = parseInt(row.productId, 10);
      const lineQty = parseInt(row.qty, 10);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw httpError('productId 無效');
      }
      if (!Number.isInteger(lineQty) || lineQty <= 0) {
        throw httpError('商品 qty 必須為正整數');
      }
      productDraft.push({ productId, qty: lineQty });
    }
  }

  const courseDraft = [];
  if (Array.isArray(courseItems)) {
    for (const row of courseItems) {
      const coursePlanId = parseInt(row.coursePlanId, 10);
      const lineQty = parseInt(row.qty, 10);
      if (!Number.isInteger(coursePlanId) || coursePlanId <= 0) {
        throw httpError('coursePlanId 無效');
      }
      if (!Number.isInteger(lineQty) || lineQty <= 0) {
        throw httpError('課程 qty 必須為正整數');
      }
      const secondPersonOnSite =
        row.secondPersonOnSite === true ||
        row.secondPersonOnSite === 1 ||
        String(row.secondPersonOnSite || '').toLowerCase() === 'true';
      courseDraft.push({ coursePlanId, qty: lineQty, secondPersonOnSite });
    }
  }

  const hasPromo =
    promotionId !== undefined && promotionId !== null && promotionId !== '';
  const parsedPromotionId = hasPromo ? parseInt(promotionId, 10) : null;
  if (hasPromo && !Number.isInteger(parsedPromotionId)) {
    throw httpError('promotionId 必須為整數');
  }

  if (productDraft.length === 0 && !hasPromo && courseDraft.length === 0) {
    throw httpError('購物車不可為空：請加入商品、購案或課程');
  }

  let parsedBranchId = null;
  if (productDraft.length > 0) {
    parsedBranchId = parseInt(branchId, 10);
    if (!Number.isInteger(parsedBranchId) || parsedBranchId <= 0) {
      throw httpError('有商品時必須提供有效 branchId');
    }
    assertBranchAccess(req, parsedBranchId);
  }

  let promotion = null;
  let promoQty = 1;
  if (hasPromo) {
    promotion = await prisma.promotion.findUnique({ where: { id: parsedPromotionId } });
    if (!promotion) throw httpError('找不到此促銷方案', 404);
    assertBranchAccess(req, promotion.branchId);
    assertPromotionSellable(promotion);
    if (!parsedBranchId) parsedBranchId = promotion.branchId;

    promoQty = qty === undefined || qty === null || qty === '' ? 1 : parseInt(qty, 10);
    if (!Number.isInteger(promoQty) || promoQty <= 0) {
      throw httpError('購案 qty 必須為正整數');
    }
    if (isUnlimitedPromotion(promotion) && promoQty !== 1) {
      throw httpError('無限使用方案不支援數量，每次僅能購買 1 份');
    }
  }

  let parsedTrainerId = null;
  if (courseDraft.length > 0) {
    parsedTrainerId = parseInt(trainerId, 10);
    if (!Number.isInteger(parsedTrainerId) || parsedTrainerId <= 0) {
      throw httpError('購買課程必須指定教練 trainerId');
    }
  }

  let parsedMemberId = null;
  if (memberId !== undefined && memberId !== null && memberId !== '') {
    parsedMemberId = parseInt(memberId, 10);
    if (!Number.isInteger(parsedMemberId)) throw httpError('memberId 無效');
  }
  if ((hasPromo || courseDraft.length > 0) && !parsedMemberId) {
    throw httpError('購案／課程必須指定會員 memberId');
  }

  if (hasPromo && promotion.requiresMemberContract) {
    await assertMemberSignedPromotionContracts(parsedMemberId, promotion.id);
  }

  return {
    productDraft,
    courseDraft,
    promotion,
    promoQty,
    parsedBranchId,
    parsedMemberId,
    parsedTrainerId,
  };
}

/**
 * 後端查價購物車合計
 */
export async function priceCheckoutCart(tx, cart) {
  const {
    productDraft,
    courseDraft,
    parsedBranchId,
    parsedMemberId,
    parsedTrainerId,
    promotion,
    promoQty,
  } = cart;

  let posAmount = 0;
  let posLines = [];
  let posItemDesc = '';
  if (productDraft.length > 0) {
    const built = await buildPosLines(tx, parsedBranchId, productDraft);
    posAmount = built.amount;
    posLines = built.lines;
    posItemDesc = built.itemDesc;
  }

  let promoAmount = 0;
  let promoItemDesc = '';
  if (promotion) {
    promoAmount = computeTopupAmount(promotion, promoQty);
    promoItemDesc = buildTopupItemDesc(promotion, '臨櫃', promoQty);
  }

  let ptAmount = 0;
  let ptLines = [];
  let ptItemDesc = '';
  let trainer = null;
  if (courseDraft.length > 0) {
    const member = parsedMemberId
      ? await tx.member.findUnique({
          where: { id: parsedMemberId },
          select: { name: true },
        })
      : null;
    const built = await buildPtCheckoutLines(tx, {
      memberId: parsedMemberId,
      trainerId: parsedTrainerId,
      courseDraft,
      memberName: member?.name,
    });
    ptAmount = built.amount;
    ptLines = built.lines;
    ptItemDesc = built.itemDesc;
    trainer = built.trainer;
  }

  const amount = posAmount + promoAmount + ptAmount;
  const descParts = [posItemDesc, promoItemDesc, ptItemDesc].filter(Boolean);
  const itemDesc = descParts.join(' + ').slice(0, 200);

  return {
    amount,
    itemDesc,
    posAmount,
    posLines,
    posItemDesc,
    promoAmount,
    promoItemDesc,
    ptAmount,
    ptLines,
    ptItemDesc,
    trainer,
    promotion: promotion || null,
  };
}

/**
 * 找出購物車內可定期定額的課程方案（一次僅支援單一方案）
 */
async function resolveRecurringCourseTarget(cart) {
  if (!cart?.courseDraft?.length) return null;
  const ids = [...new Set(cart.courseDraft.map((r) => r.coursePlanId))];
  const plans = await prisma.coursePlan.findMany({
    where: { id: { in: ids } },
  });
  const enabled = plans.filter((p) => p.enableCardRecurring);
  if (enabled.length === 0) return null;
  if (enabled.length > 1) {
    throw httpError('定期定額一次僅能購買一個已啟用定期定額的課程方案');
  }
  const plan = enabled[0];
  const qty = cart.courseDraft
    .filter((r) => r.coursePlanId === plan.id)
    .reduce((s, r) => s + r.qty, 0);
  return { plan, qty };
}

/**
 * 執行合併結帳
 */
export async function runOpsCheckout(req, body) {
  const {
    payments,
    payMethod,
    voucherCode,
    carrierNum,
    buyerUbn,
    loveCode,
    cardMode,
    cardInst,
    periodType,
    periodTimes,
    recurringAmount: _recurringAmountRaw,
    branchId: _b,
    memberId: _m,
    items: _i,
    promotionId: _p,
    qty: _q,
    courseItems: _c,
    trainerId: _t,
    amount: illegalAmount,
    ...rest
  } = body || {};

  if (illegalAmount !== undefined || Object.keys(rest).length > 0) {
    throw httpError(
      '⛔ 非法參數：結帳只允許 branchId、memberId、items、promotionId、qty、courseItems、trainerId、payments、payMethod、voucherCode、carrierNum、buyerUbn、loveCode、cardMode、cardInst、periodType、periodTimes、recurringAmount；金額由後端查價',
    );
  }

  const cart = await resolveCheckoutCart(body, req);
  const invoiceOpts = normalizeInvoiceOptions({ carrierNum, buyerUbn, loveCode });
  const staffId = req.user?.id || null;

  const priced = await prisma.$transaction(async (tx) => priceCheckoutCart(tx, cart));

  if (priced.amount <= 0) {
    throw httpError('應付金額無效');
  }

  const recurringCourse = await resolveRecurringCourseTarget(cart);
  const promoRecurring = Boolean(cart.promotion?.enableCardRecurring && cart.promotion);
  if (promoRecurring && recurringCourse) {
    throw httpError('儲值方案與課程方案不可同時使用定期定額，請分開結帳');
  }
  const allowRecurring = promoRecurring || Boolean(recurringCourse);

  let cardOpts = { cardMode: 'LUMP', cardInst: null, periodType: null, periodTimes: null };
  let recurringAmount = null;
  let recurringAmountFinal = null;
  let courseSchedule = null;
  let chargeAmount = priced.amount;

  const paymentMethods = Array.isArray(payments)
    ? payments.map((p) => String(p?.method || '').toUpperCase())
    : [];
  const needsCardHint =
    paymentMethods.includes('CARD') ||
    String(payMethod || '')
      .toUpperCase()
      .split('+')
      .map((s) => s.trim())
      .includes('CARD');

  if (needsCardHint) {
    cardOpts = parseCardPayOptions(
      { cardMode, cardInst, periodType, periodTimes },
      { allowRecurring },
    );
    if (cardOpts.cardMode === 'RECURRING') {
      if (promoRecurring) {
        const periodCount = parseInt(cart.promotion.periodCount, 10);
        if (!Number.isInteger(periodCount) || periodCount <= 0) {
          throw httpError('此儲值方案未設定有效期期數，無法使用定期定額');
        }
        // 每期金額＝方案費用；總期數＝有效期期數（忽略前端覆寫）
        recurringAmount = computeTopupAmount(cart.promotion, cart.promoQty);
        cardOpts.periodTimes = periodCount;
      } else if (recurringCourse) {
        courseSchedule = resolveCourseRecurringSchedule(
          recurringCourse.plan,
          cardOpts.periodTimes,
        );
        cardOpts.periodTimes = courseSchedule.periodTimes;
        const firstPt =
          Math.round(courseSchedule.firstAmount * recurringCourse.qty * 100) / 100;
        const otherPt =
          Math.round(
            (priced.ptAmount - recurringCourse.plan.price * recurringCourse.qty) * 100,
          ) / 100;
        chargeAmount =
          Math.round(
            (priced.posAmount + priced.promoAmount + Math.max(0, otherPt) + firstPt) * 100,
          ) / 100;
        recurringAmount = courseSchedule.recurringAmount;
        recurringAmountFinal = courseSchedule.amountFinal;
        // 續扣金額依方案排程（忽略前端覆寫，與儲值定期定額一致）
      } else {
        throw httpError('定期定額僅限購物車含已啟用儲值或課程方案時使用');
      }
    }
  }

  if (!(chargeAmount > 0)) {
    throw httpError('應付金額無效');
  }

  const pay = coercePaymentsFromBody(
    { payments, payMethod, voucherCode },
    chargeAmount,
    CHECKOUT_PAY_METHODS,
  );

  if (pay.walletAmount > 0 && !cart.parsedMemberId) {
    throw httpError('零錢包付款必須指定會員 memberId');
  }

  const status = pay.needsCard ? 'PENDING' : 'PAID';
  const checkoutId = generateCheckoutId();
  const isCourseRecurring =
    pay.needsCard && cardOpts.cardMode === 'RECURRING' && Boolean(courseSchedule);

  const created = await prisma.$transaction(async (tx) => {
    let member = null;
    if (cart.parsedMemberId) {
      member = await tx.member.findUnique({ where: { id: cart.parsedMemberId } });
      if (!member) throw httpError('找不到會員', 404);
    }

    if (pay.walletAmount > 0) {
      if (!member || member.cashWallet < pay.walletAmount) {
        throw httpError(
          `零錢包（本金）不足（餘額 $${member?.cashWallet ?? 0}，應付 $${pay.walletAmount}）；運動金不可折抵`,
        );
      }
      await tx.member.update({
        where: { id: member.id },
        data: { cashWallet: { decrement: pay.walletAmount } },
      });
    }

    const pricedTx = await priceCheckoutCart(tx, cart);
    let saleOrderId = null;
    let orderId = null;

    if (pricedTx.posLines.length > 0) {
      saleOrderId = generateSaleId();
      await tx.saleOrder.create({
        data: {
          id: saleOrderId,
          branchId: cart.parsedBranchId,
          memberId: cart.parsedMemberId,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          cardAmount: 0,
          cardMode: pay.needsCard ? cardOpts.cardMode : 'LUMP',
          cardInst: pay.needsCard ? cardOpts.cardInst : null,
          periodType: null,
          periodTimes: null,
          status,
          amount: pricedTx.posAmount,
          itemDesc: pricedTx.posItemDesc,
          carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
          staffId,
          checkoutSessionId: checkoutId,
          items: {
            create: pricedTx.posLines.map((l) => ({
              productId: l.productId,
              name: l.name,
              unitPrice: l.unitPrice,
              qty: l.qty,
              lineTotal: l.lineTotal,
            })),
          },
        },
      });

      if (!pay.needsCard) {
        const sale = await tx.saleOrder.findUnique({
          where: { id: saleOrderId },
          include: { items: true },
        });
        await deductSaleStock(tx, sale, staffId);
      }
    }

    if (cart.promotion) {
      orderId = resolveTopupOrderId({
        cardMode: cardOpts.cardMode,
        promotion: cart.promotion,
      });
      await tx.order.create({
        data: {
          id: orderId,
          memberId: cart.parsedMemberId,
          amount: pricedTx.promoAmount,
          itemDesc: pricedTx.promoItemDesc,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          cardAmount: 0,
          cardMode: pay.needsCard ? cardOpts.cardMode : 'LUMP',
          cardInst: pay.needsCard ? cardOpts.cardInst : null,
          periodType: pay.needsCard ? cardOpts.periodType : null,
          periodTimes: pay.needsCard ? cardOpts.periodTimes : null,
          recurringAmount,
          recurringAmountFinal,
          carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
          status,
          checkoutSessionId: checkoutId,
        },
      });

      if (!pay.needsCard) {
        await fulfillPromotionPurchase(tx, cart.parsedMemberId, cart.promotion, {
          qty: cart.promoQty,
        });
      }
    } else if (isCourseRecurring) {
      const firstPt =
        Math.round(courseSchedule.firstAmount * recurringCourse.qty * 100) / 100;
      orderId = generateSubscriptionOrderId();
      await tx.order.create({
        data: {
          id: orderId,
          memberId: cart.parsedMemberId,
          amount: firstPt,
          itemDesc:
            `課程定期定額首期 | ${recurringCourse.plan.name} ×${recurringCourse.qty}` +
            ` | 課程方案#${recurringCourse.plan.id} | ${courseSchedule.periodTimes}期`,
          payMethod: pay.payMethodLabel,
          payBreakdown: pay.breakdown,
          voucherCode: pay.voucherCode,
          cardAmount: 0,
          cardMode: 'RECURRING',
          cardInst: null,
          periodType: cardOpts.periodType,
          periodTimes: courseSchedule.periodTimes,
          recurringAmount,
          recurringAmountFinal,
          carrierNum: invoiceOpts.carrierNum,
          buyerUbn: invoiceOpts.buyerUbn,
          loveCode: invoiceOpts.loveCode,
          status,
          checkoutSessionId: checkoutId,
        },
      });
    }

    let ptFulfilled = false;
    if (pricedTx.ptLines.length > 0 && !pay.needsCard) {
      await fulfillPtCheckoutLines(tx, {
        memberId: cart.parsedMemberId,
        trainerId: cart.parsedTrainerId,
        lines: pricedTx.ptLines,
        memberName: member?.name,
        trainerName: pricedTx.trainer?.name,
        opts: {
          checkoutSessionId: checkoutId,
          payMethod: pay.payMethodLabel,
          status: 'PAID',
        },
      });
      ptFulfilled = true;
    }

    const session = await tx.checkoutSession.create({
      data: {
        id: checkoutId,
        branchId: cart.parsedBranchId,
        memberId: cart.parsedMemberId,
        amount: isCourseRecurring ? chargeAmount : pricedTx.amount,
        itemDesc: pricedTx.itemDesc,
        payMethod: pay.payMethodLabel,
        payBreakdown: pay.breakdown,
        voucherCode: pay.voucherCode,
        cardAmount: pay.cardAmount,
        cardMode: pay.needsCard ? cardOpts.cardMode : 'LUMP',
        cardInst: pay.needsCard ? cardOpts.cardInst : null,
        periodType: pay.needsCard ? cardOpts.periodType : null,
        periodTimes: pay.needsCard ? cardOpts.periodTimes : null,
        recurringAmount,
        recurringAmountFinal,
        carrierNum: invoiceOpts.carrierNum,
        buyerUbn: invoiceOpts.buyerUbn,
        loveCode: invoiceOpts.loveCode,
        status,
        saleOrderId,
        orderId,
        trainerId: cart.parsedTrainerId,
        ptItems: pricedTx.ptLines.length ? pricedTx.ptLines : null,
        ptFulfilled,
        staffId,
      },
    });

    return {
      session,
      saleOrderId,
      orderId,
      memberName: member?.name || null,
      priced: pricedTx,
    };
  });

  if (pay.needsCard) {
    const { actionUrl, payload: payuniPayload } = buildCardCheckoutRequest({
      id: created.session.id,
      amount: pay.cardAmount,
      itemDesc: created.session.itemDesc,
      cardMode: cardOpts.cardMode,
      cardInst: cardOpts.cardInst,
      periodType: cardOpts.periodType,
      periodTimes: cardOpts.periodTimes,
      periodAmt: recurringAmount,
      recurringAmount,
    });

    return {
      kind: 'card',
      message: `合併結帳已建立（${pay.payMethodLabel}），請完成刷卡 $${pay.cardAmount}`,
      data: {
        checkoutId: created.session.id,
        saleId: created.saleOrderId,
        orderId: created.orderId,
        amount: created.session.amount,
        payMethod: pay.payMethodLabel,
        payBreakdown: pay.breakdown,
        cardAmount: pay.cardAmount,
        cardMode: cardOpts.cardMode,
        cardInst: cardOpts.cardInst,
        periodType: cardOpts.periodType,
        periodTimes: cardOpts.periodTimes,
        recurringAmount,
        recurringAmountFinal,
        voucherCode: pay.voucherCode,
        carrierNum: invoiceOpts.carrierNum,
        buyerUbn: invoiceOpts.buyerUbn,
        loveCode: invoiceOpts.loveCode,
        actionUrl,
        payload: payuniPayload,
      },
    };
  }

  let invoiceNumber = null;
  let invoices = [];
  try {
    const issued = await issueSplitCheckoutInvoices({
      checkoutId: created.session.id,
      buyerName: created.memberName || '臨櫃客戶',
      carrierNum: invoiceOpts.carrierNum,
      buyerUbn: invoiceOpts.buyerUbn,
      loveCode: invoiceOpts.loveCode,
    });
    invoices = issued.invoices || [];
    invoiceNumber = issued.invoiceNumber;
  } catch (invoiceErr) {
    console.error(`❌ 合併結帳 ${created.session.id} 軟拆開票例外:`, invoiceErr.message);
  }

  return {
    kind: 'paid',
    message: `結帳成功（${pay.payMethodLabel}）`,
    data: {
      checkoutId: created.session.id,
      saleId: created.saleOrderId,
      orderId: created.orderId,
      amount: created.session.amount,
      payMethod: pay.payMethodLabel,
      payBreakdown: pay.breakdown,
      voucherCode: pay.voucherCode,
      invoiceNumber,
      invoices,
      carrierNum: invoiceOpts.carrierNum,
      buyerUbn: invoiceOpts.buyerUbn,
      loveCode: invoiceOpts.loveCode,
      recurringAmount,
    },
  };
}

/**
 * PayUNi Webhook：CHK… → 履約 SAL + TYK + 私教，軟拆分腿開票
 * 以 updateMany 搶佔 PENDING→PAID，避免並發 webhook 雙重履約
 */
export async function fulfillCheckoutSession(checkoutId, merchantNo, cardMeta = null) {
  const claim = await prisma.checkoutSession.updateMany({
    where: { id: checkoutId, status: 'PENDING' },
    data: {
      status: 'PAID',
      merchantNo: merchantNo || null,
      ...(cardMeta?.creditHash ? { creditHash: cardMeta.creditHash } : {}),
      ...(cardMeta?.cardInst ? { cardInst: cardMeta.cardInst } : {}),
    },
  });

  if (claim.count === 0) {
    const existing = await prisma.checkoutSession.findUnique({
      where: { id: checkoutId },
      include: { member: { select: { id: true, name: true } } },
    });
    if (existing?.status === 'PAID') {
      return { session: existing, invoiceNumber: existing.invoiceNumber, invoices: [] };
    }
    return null;
  }

  const session = await prisma.checkoutSession.findUnique({
    where: { id: checkoutId },
    include: { member: { select: { id: true, name: true } } },
  });
  if (!session) return null;

  const isRecurring = String(session.cardMode || '').toUpperCase() === 'RECURRING';
  let promotionForSub = null;
  let coursePlanForSub = null;
  let paidOrderId = session.orderId;

  await prisma.$transaction(async (tx) => {
    if (session.orderId) {
      const orderUpdated = await tx.order.updateMany({
        where: { id: session.orderId, status: 'PENDING' },
        data: {
          status: 'PAID',
          merchantNo: merchantNo || null,
          ...(cardMeta?.creditHash ? { creditHash: cardMeta.creditHash } : {}),
          ...(cardMeta?.cardInst ? { cardInst: cardMeta.cardInst } : {}),
        },
      });

      if (orderUpdated.count > 0) {
        const order = await tx.order.findUnique({ where: { id: session.orderId } });
        const promoMatch = (order?.itemDesc || '').match(/商品#(\d+)/);
        const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
        if (promotionId && order) {
          const promotion = await tx.promotion.findUnique({ where: { id: promotionId } });
          if (promotion) {
            promotionForSub = promotion;
            const qty = parseTopupQtyFromItemDesc(order.itemDesc);
            const durationDaysOverride =
              isRecurring && isUnlimitedPromotion(promotion)
                ? resolveRecurringPeriodDays(promotion)
                : undefined;
            await fulfillPromotionPurchase(tx, order.memberId, promotion, {
              qty,
              durationDaysOverride: durationDaysOverride ?? undefined,
            });
          }
        } else if (isRecurring && order) {
          const courseMatch = (order.itemDesc || '').match(/課程方案#(\d+)/);
          const coursePlanId = courseMatch ? parseInt(courseMatch[1], 10) : null;
          if (coursePlanId) {
            coursePlanForSub = await tx.coursePlan.findUnique({ where: { id: coursePlanId } });
          }
        }
      }
    }

    if (Array.isArray(session.ptItems) && session.ptItems.length > 0) {
      const ptClaim = await tx.checkoutSession.updateMany({
        where: { id: checkoutId, ptFulfilled: false },
        data: { ptFulfilled: true },
      });
      if (ptClaim.count > 0) {
        const trainer = session.trainerId
          ? await tx.trainer.findUnique({
              where: { id: session.trainerId },
              select: { name: true },
            })
          : null;
        // 課程定期定額：首期訂單已存在，略過再開私教全額 Order（合約仍給滿堂數）
        const skipPtOrders = isRecurring && Boolean(coursePlanForSub || session.recurringAmount != null);
        await fulfillPtCheckoutLines(tx, {
          memberId: session.memberId,
          trainerId: session.trainerId,
          lines: session.ptItems,
          memberName: session.member?.name,
          trainerName: trainer?.name,
          opts: {
            checkoutSessionId: session.id,
            payMethod: session.payMethod || 'CARD',
            status: 'PAID',
            skipOrders: skipPtOrders,
          },
        });
      }
    }
  });

  // 若交易外才解析到課程（order 早已 PAID 的重入），再補一次
  if (isRecurring && !promotionForSub && !coursePlanForSub && paidOrderId) {
    const order = await prisma.order.findUnique({ where: { id: paidOrderId } });
    const courseMatch = (order?.itemDesc || '').match(/課程方案#(\d+)/);
    const coursePlanId = courseMatch ? parseInt(courseMatch[1], 10) : null;
    if (coursePlanId) {
      coursePlanForSub = await prisma.coursePlan.findUnique({ where: { id: coursePlanId } });
    }
  }

  if (session.saleOrderId) {
    await fulfillCardSaleOrder(session.saleOrderId, merchantNo, session.staffId, cardMeta, {
      skipInvoice: true,
    });
  }

  let invoiceNumber = null;
  let invoices = [];
  try {
    const issued = await issueSplitCheckoutInvoices({
      checkoutId: session.id,
      buyerName: session.member?.name || '臨櫃客戶',
      carrierNum: session.carrierNum || null,
      buyerUbn: session.buyerUbn || null,
      loveCode: session.loveCode || null,
    });
    invoices = issued.invoices || [];
    invoiceNumber = issued.invoiceNumber;
    if (invoiceNumber) {
      console.log(
        `🧾 合併結帳 ${session.id} 軟拆開票 ${invoices.filter((i) => i.ok).length}/${invoices.length} 張`,
      );
    }
  } catch (err) {
    console.error(`❌ 合併結帳 ${session.id} 軟拆開票例外:`, err.message);
  }

  if (isRecurring && paidOrderId && (promotionForSub || coursePlanForSub)) {
    try {
      const paidOrder = await prisma.order.findUnique({ where: { id: paidOrderId } });
      await createSubscriptionFromPaidOrder(paidOrder, {
        promotion: promotionForSub || null,
        coursePlan: coursePlanForSub || null,
        creditHash: cardMeta?.creditHash || paidOrder?.creditHash,
        amountFinal:
          paidOrder?.recurringAmountFinal ??
          session.recurringAmountFinal ??
          coursePlanForSub?.recurringAmountFinal ??
          undefined,
      });
    } catch (subErr) {
      console.error(`❌ 合併結帳 ${session.id} 建立定期定額失敗:`, subErr.message);
    }
  }

  return { session, invoiceNumber, invoices };
}
