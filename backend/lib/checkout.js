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
  TOPUP_NO_WALLET_MESSAGE,
  resolvePromotionRecurringAmount,
  resolveRecurringPeriodDays,
} from './promotion.js';
import { assertMemberSignedPromotionContracts } from './memberContract.js';
import { assertNoPaymentDebt } from './paymentDebt.js';
import { assertBranchAccess } from './staffAccess.js';
import {
  buildCardCheckoutRequest,
  parseCardPayOptions,
  resolvePayuniPeriodHash,
  resolveBindCreditHash,
} from './payuni.js';
import { payLinePayPosWithOneTimeKey } from './linepay.js';
import { normalizeInvoiceOptions } from './ezpay.js';
import {
  buildPosLines,
  deductSaleStock,
  fulfillCardSaleOrder,
  generateSaleId,
} from './inventory.js';
import {
  createSubscriptionFromPaidOrder,
  ensureSubscriptionForPaidRecurringOrder,
  isPlaceholderNextChargeAt,
  resolveExpectedNextChargeAt,
  applyCardSubscriptionCreditUpdate,
  syncNextChargeAtFromPayuni,
} from './cardSubscription.js';
import { buildPtCheckoutLines, fulfillPtCheckoutLines } from './ptPurchase.js';
import { resolveTopupOrderId, generateSubscriptionOrderId } from './orderIds.js';
import { issueCheckoutInvoices, saveInvoiceRequest } from './einvoice.js';
import { resolveBranchLegalEntity } from './legalEntity.js';
import { lockOpenShiftForSale } from './shiftHandover.js';
import { payWithCashWallet, restoreHeldCashWallet } from './walletMutation.js';
import { resolveCourseRecurringSchedule } from './coursePlan.js';
import {
  quoteGroupItem,
  createEnrollmentHold,
  activateEnrollment,
  activateEnrollmentsForCheckout,
  releaseHoldsForCheckout,
} from './groupClassService.js';
import { normalizeEnrollKind } from './groupClassRules.js';

/** 已收款不因開票失敗沖回：失敗腿留 EInvoice FAILED 由佇列補開，回 PARTIAL_INVOICE */
function failCheckoutIfInvoiceBroken({ checkoutId, invoices }) {
  const list = Array.isArray(invoices) ? invoices : [];
  if (!list.some((i) => i && i.ok === false)) {
    return null;
  }
  const detail =
    list
      .filter((i) => i && i.ok === false)
      .map((i) => i.message || i.lastError || `${i.leg || 'leg'} 開票失敗`)
      .join('；') || '電子發票開立失敗';
  console.warn(
    `[PARTIAL_INVOICE] ${checkoutId} 部分開票失敗已入佇列（不沖回收款）: ${detail}`,
  );
  return {
    code: 'PARTIAL_INVOICE',
    message: `結帳已完成，但部分電子發票開立失敗，已排入自動補開：${detail}`,
    payHints: [],
  };
}

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
    groupItems,
  } = body || {};

  const groupDraft = [];
  if (Array.isArray(groupItems)) {
    for (const row of groupItems) {
      const seriesId = parseInt(row?.seriesId, 10);
      if (!Number.isInteger(seriesId) || seriesId <= 0) throw httpError('團課 seriesId 無效');
      const kind = normalizeEnrollKind(row?.kind);
      const classId = kind === 'DROP_IN' ? parseInt(row?.classId, 10) : null;
      if (kind === 'DROP_IN' && (!Number.isInteger(classId) || classId <= 0)) {
        throw httpError('團課單堂須指定 classId');
      }
      const dupKey = `${seriesId}:${kind}:${classId || ''}`;
      if (groupDraft.some((g) => `${g.seriesId}:${g.kind}:${g.classId || ''}` === dupKey)) {
        throw httpError('購物車內團課項目重複');
      }
      groupDraft.push({ seriesId, kind, classId });
    }
  }

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

  if (productDraft.length === 0 && !hasPromo && courseDraft.length === 0 && groupDraft.length === 0) {
    throw httpError('購物車不可為空：請加入商品、購案、課程或團課');
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
  if ((hasPromo || courseDraft.length > 0 || groupDraft.length > 0) && !parsedMemberId) {
    throw httpError('購案／課程／團課必須指定會員 memberId');
  }
  if (courseDraft.length > 0) await assertNoPaymentDebt(prisma, parsedMemberId);

  if (hasPromo && promotion.requiresMemberContract) {
    await assertMemberSignedPromotionContracts(parsedMemberId, promotion.id);
  }

  if (groupDraft.length > 0) {
    const series = await prisma.classSeries.findMany({
      where: { id: { in: groupDraft.map((g) => g.seriesId) } },
      select: { id: true, venue: { select: { branchId: true } } },
    });
    for (const g of groupDraft) {
      const s = series.find((x) => x.id === g.seriesId);
      if (!s) throw httpError('找不到團課期班', 404);
      assertBranchAccess(req, s.venue.branchId);
      if (!parsedBranchId) parsedBranchId = s.venue.branchId;
    }
  }

  return {
    productDraft,
    courseDraft,
    groupDraft,
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

  let groupAmount = 0;
  const groupLines = [];
  for (const g of cart.groupDraft || []) {
    const q = await quoteGroupItem(tx, g);
    groupLines.push({
      seriesId: g.seriesId,
      kind: q.kind,
      classId: q.cls?.id ?? null,
      price: q.quote.price,
      sessions: q.quote.sessions,
      prorated: q.quote.prorated,
      itemDesc: q.itemDesc,
    });
    groupAmount += q.quote.price;
  }
  const groupItemDesc = groupLines.map((l) => l.itemDesc.split(' | ').slice(0, 2).join(' ')).join('、');

  const amount = posAmount + promoAmount + ptAmount + groupAmount;
  const descParts = [posItemDesc, promoItemDesc, ptItemDesc, groupItemDesc].filter(Boolean);
  const itemDesc = descParts.join(' + ').slice(0, 200);

  return {
    amount,
    itemDesc,
    groupAmount,
    groupLines,
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
/** 臨櫃收款歸屬班次之分店：購物車已判定之分店 → 櫃檯選擇之分店 → 員工本店 */
function resolveShiftBranchId(req, cart, rawBranchId) {
  if (cart.parsedBranchId) return cart.parsedBranchId;
  const bid = parseInt(rawBranchId, 10);
  if (Number.isInteger(bid) && bid > 0) {
    assertBranchAccess(req, bid);
    return bid;
  }
  return req.user?.branchId ?? null;
}

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
    linePayOneTimeKey,
    branchId: _b,
    memberId: _m,
    items: _i,
    promotionId: _p,
    qty: _q,
    courseItems: _c,
    trainerId: _t,
    groupItems: _g,
    amount: illegalAmount,
    ...rest
  } = body || {};

  if (illegalAmount !== undefined || Object.keys(rest).length > 0) {
    throw httpError(
      '⛔ 非法參數：結帳只允許 branchId、memberId、items、promotionId、qty、courseItems、trainerId、groupItems、payments、payMethod、voucherCode、carrierNum、buyerUbn、loveCode、cardMode、cardInst、periodType、periodTimes、recurringAmount、linePayOneTimeKey；金額由後端查價',
    );
  }

  const cart = await resolveCheckoutCart(body, req);
  const shiftBranchId = resolveShiftBranchId(req, cart, body?.branchId);
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
  let payuniPeriodHash = null;
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
  const wantsRecurring =
    String(cardMode || '').toUpperCase() === 'RECURRING' || needsCardHint;

  if (wantsRecurring && cart.groupDraft.length > 0) {
    throw httpError('團課報名不支援定期定額，請與定期定額項目分開結帳');
  }

  if (wantsRecurring) {
    cardOpts = parseCardPayOptions(
      { cardMode: cardMode || 'RECURRING', cardInst, periodType, periodTimes },
      { allowRecurring },
    );
    // 臨櫃一次／分期請走乙禾；PayUNi CARD 金額線僅定期定額（月卡則首期改乙禾）
    if (cardOpts.cardMode !== 'RECURRING') {
      throw httpError(
        '臨櫃一次付清／分期請使用「乙禾現場刷卡」（YIPAY）；PayUNi（CARD）僅用於定期定額',
      );
    }
    if (promoRecurring) {
      const periodCount = parseInt(cart.promotion.periodCount, 10);
      if (!Number.isInteger(periodCount) || periodCount <= 0) {
        throw httpError('此儲值方案未設定有效期期數，無法使用定期定額');
      }
      recurringAmount = resolvePromotionRecurringAmount(cart.promotion);
      if (!recurringAmount) {
        throw httpError('此儲值方案未設定定期定額扣款金額');
      }
      cardOpts.periodTimes = periodCount;
      payuniPeriodHash = resolvePayuniPeriodHash({
        channel: 'counter',
        promotion: cart.promotion,
      });
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
      payuniPeriodHash = resolvePayuniPeriodHash({
        channel: 'counter',
        coursePlan: recurringCourse.plan,
      });
    } else {
      throw httpError('定期定額僅限購物車含已啟用儲值或課程方案時使用');
    }
  }

  if (!(chargeAmount > 0)) {
    throw httpError('應付金額無效');
  }

  const pay = coercePaymentsFromBody(
    { payments, payMethod, voucherCode },
    chargeAmount,
    CHECKOUT_PAY_METHODS,
    {
      // 月卡／課程定期定額：允許 CARD:0 作為 PayUNi 約定標記（首期金額走乙禾）
      allowYipayPayuniRecurring:
        cardOpts.cardMode === 'RECURRING' && Boolean(promoRecurring || recurringCourse),
    },
  );

  // 月卡（或課程）定期定額臨櫃：首期必須乙禾；PayUNi 於確認後再開約定頁
  if (cardOpts.cardMode === 'RECURRING' && (promoRecurring || recurringCourse)) {
    if (!pay.needsYipay) {
      throw httpError(
        '月卡／課程定期定額臨櫃：首期請使用「乙禾現場刷卡」（YIPAY），確認後再開 PayUNi 約定續期',
      );
    }
    if (pay.needsCard) {
      throw httpError(
        '首期金額請全部放在乙禾現場刷卡；PayUNi（CARD）請用金額 0 僅作約定標記，或只選乙禾並帶 cardMode=RECURRING',
      );
    }
  }

  if (pay.walletAmount > 0 && !cart.parsedMemberId) {
    throw httpError('零錢包付款必須指定會員 memberId');
  }
  if (pay.walletAmount > 0 && cart.groupDraft.length > 0) {
    const err = httpError('團課報名不可使用錢包扣款，請改用現金／乙禾刷卡／LinePay，或與錢包付款項目分開結帳');
    err.code = 'GROUP_NO_WALLET';
    throw err;
  }
  if (pay.walletAmount > 0 && cart.promotion && !isUnlimitedPromotion(cart.promotion)) {
    const err = httpError(TOPUP_NO_WALLET_MESSAGE);
    err.code = 'TOPUP_NO_WALLET';
    throw err;
  }

  const status = pay.needsOnlinePay ? 'PENDING' : 'PAID';
  const checkoutId = generateCheckoutId();
  const isRecurringCheckout = cardOpts.cardMode === 'RECURRING';
  const isCourseRecurring = isRecurringCheckout && Boolean(courseSchedule);

  const created = await prisma.$transaction(async (tx) => {
    await lockOpenShiftForSale(tx, shiftBranchId);
    let member = null;
    if (cart.parsedMemberId) {
      member = await tx.member.findUnique({ where: { id: cart.parsedMemberId } });
      if (!member) throw httpError('找不到會員', 404);
    }

    if (pay.walletAmount > 0) {
      if (!member) throw httpError('零錢包付款必須指定會員');
      await payWithCashWallet(tx, {
        memberId: member.id,
        amount: pay.walletAmount,
        refType: 'CHECKOUT',
        refId: checkoutId,
        staffId: staffId ?? null,
        branchId: shiftBranchId,
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
          cardMode: isRecurringCheckout ? 'RECURRING' : pay.needsCard ? cardOpts.cardMode : 'LUMP',
          cardInst: pay.needsCard ? cardOpts.cardInst : null,
          periodType: null,
          periodTimes: null,
          status,
          amount: pricedTx.posAmount,
          itemDesc: pricedTx.posItemDesc,
          legalEntityId: (await resolveBranchLegalEntity(cart.parsedBranchId, tx)).id,
          staffId,
          checkoutSessionId: checkoutId,
          items: {
            create: pricedTx.posLines.map((l) => ({
              productId: l.productId,
              name: l.name,
              unitPrice: l.unitPrice,
              qty: l.qty,
              lineTotal: l.lineTotal,
              taxType: l.taxType,
            })),
          },
        },
      });

      if (!pay.needsOnlinePay) {
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
          cardMode: isRecurringCheckout ? 'RECURRING' : pay.needsCard ? cardOpts.cardMode : 'LUMP',
          cardInst: pay.needsCard ? cardOpts.cardInst : null,
          periodType: isRecurringCheckout ? cardOpts.periodType : null,
          periodTimes: isRecurringCheckout ? cardOpts.periodTimes : null,
          recurringAmount,
          recurringAmountFinal,
          branchId: cart.promotion.branchId || cart.parsedBranchId || null,
          status,
          checkoutSessionId: checkoutId,
        },
      });

      if (!pay.needsOnlinePay) {
        await fulfillPromotionPurchase(tx, cart.parsedMemberId, cart.promotion, {
          qty: cart.promoQty,
          orderId,
          staffId,
          branchId: shiftBranchId,
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
          branchId: recurringCourse.plan.branchId || cart.parsedBranchId || null,
          status,
          checkoutSessionId: checkoutId,
        },
      });
    }

    let ptFulfilled = false;
    if (pricedTx.ptLines.length > 0 && !pay.needsOnlinePay) {
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

    const groupEnrollmentIds = [];
    for (const line of pricedTx.groupLines) {
      const hold = await createEnrollmentHold(tx, {
        memberId: cart.parsedMemberId,
        seriesId: line.seriesId,
        kind: line.kind,
        classId: line.classId,
        source: 'POS',
        staffId,
        checkoutSessionId: checkoutId,
        payMethod: pay.payMethodLabel,
        payBreakdown: pay.breakdown,
        voucherCode: pay.voucherCode,
        invoiceOpts,
        expectedPrice: line.price,
      });
      if (!pay.needsOnlinePay) {
        await activateEnrollment(tx, hold.enrollment);
      }
      groupEnrollmentIds.push(hold.enrollment.id);
    }

    const session = await tx.checkoutSession.create({
      data: {
        id: checkoutId,
        branchId: cart.parsedBranchId ?? shiftBranchId,
        memberId: cart.parsedMemberId,
        amount: isCourseRecurring ? chargeAmount : pricedTx.amount,
        itemDesc: pricedTx.itemDesc,
        payMethod: pay.payMethodLabel,
        payBreakdown: pay.breakdown,
        voucherCode: pay.voucherCode,
        cardAmount: pay.cardAmount || pay.yipayAmount || 0,
        cardMode: isRecurringCheckout ? 'RECURRING' : pay.needsCard ? cardOpts.cardMode : 'LUMP',
        cardInst: pay.needsCard ? cardOpts.cardInst : null,
        periodType: isRecurringCheckout ? cardOpts.periodType : pay.needsCard ? cardOpts.periodType : null,
        periodTimes: isRecurringCheckout
          ? cardOpts.periodTimes
          : pay.needsCard
            ? cardOpts.periodTimes
            : null,
        recurringAmount,
        recurringAmountFinal,
        payuniPeriodHash: isRecurringCheckout ? payuniPeriodHash : null,
        status,
        saleOrderId,
        orderId,
        trainerId: cart.parsedTrainerId,
        ptItems: pricedTx.ptLines.length ? pricedTx.ptLines : null,
        ptFulfilled,
        staffId,
      },
    });
    await saveInvoiceRequest(tx, {
      refType: 'CHECKOUT',
      refId: checkoutId,
      buyerName: member?.name || null,
      ...invoiceOpts,
    });

    return {
      session,
      saleOrderId,
      orderId,
      memberName: member?.name || null,
      priced: pricedTx,
      groupEnrollmentIds,
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
      payuniPeriodHash,
      channel: 'counter',
    });

    return {
      kind: 'card',
      message: `合併結帳已建立（${pay.payMethodLabel}），請完成刷卡 $${pay.cardAmount}`,
      data: {
        checkoutId: created.session.id,
        saleId: created.saleOrderId,
        orderId: created.orderId,
        groupEnrollmentIds: created.groupEnrollmentIds,
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

  if (pay.needsYipay) {
    const needsPeriodBind =
      isRecurringCheckout && Boolean(promoRecurring || recurringCourse);
    return {
      kind: 'yipay',
      message: needsPeriodBind
        ? `請於乙禾完成首期 $${pay.yipayAmount}，確認後開 PayUNi 續期頁（$1 驗證授權後取消、不請款；第 2 期起 PeriodAmt $${recurringAmount || ''}）`
        : `請於乙禾／凱基固定式刷卡機完成收款 $${pay.yipayAmount}，完成後按「確認刷卡成功」`,
      data: {
        checkoutId: created.session.id,
        saleId: created.saleOrderId,
        orderId: created.orderId,
        groupEnrollmentIds: created.groupEnrollmentIds,
        amount: created.session.amount,
        yipayAmount: pay.yipayAmount,
        payMethod: pay.payMethodLabel,
        payBreakdown: pay.breakdown,
        voucherCode: pay.voucherCode,
        carrierNum: invoiceOpts.carrierNum,
        buyerUbn: invoiceOpts.buyerUbn,
        loveCode: invoiceOpts.loveCode,
        channel: 'YIPAY',
        terminalHint: '乙禾凱基固定式刷卡機',
        cardMode: isRecurringCheckout ? 'RECURRING' : 'LUMP',
        needsPeriodBind,
        recurringAmount,
        periodTimes: cardOpts.periodTimes,
      },
    };
  }

  if (pay.needsLinePay) {
    if (cardOpts.cardMode === 'RECURRING') {
      throw httpError('定期定額請使用刷卡（PayUNi），LinePay 僅支援一次付清');
    }
    const oneTimeKey = String(linePayOneTimeKey || '').trim();
    if (!oneTimeKey) {
      throw httpError(
        '臨櫃 LinePay 為 POS 掃碼模式：請掃描會員 LinePay 付款碼（My Code）後再結帳',
      );
    }

    let branchName = null;
    if (created.session.branchId) {
      const br = await prisma.branch.findUnique({
        where: { id: created.session.branchId },
        select: { name: true, code: true },
      });
      branchName = br?.name || br?.code || null;
    }

    const lp = await payLinePayPosWithOneTimeKey({
      orderId: created.session.id,
      amount: pay.linePayAmount,
      productName: created.session.itemDesc,
      oneTimeKey,
      branchId: created.session.branchId,
      branchName,
    }).catch(async (err) => {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.checkoutSession.updateMany({
          where: { id: created.session.id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
        if (!claimed.count) return;
        if (created.saleOrderId) {
          await tx.saleOrder.updateMany({
            where: { id: created.saleOrderId, status: 'PENDING' },
            data: { status: 'CANCELLED' },
          });
        }
        if (created.orderId) {
          await tx.order.updateMany({
            where: { id: created.orderId, status: 'PENDING' },
            data: { status: 'CANCELLED' },
          });
        }
        await releaseHoldsForCheckout(tx, created.session.id, 'CANCELLED');
        if (pay.walletAmount > 0 && cart.parsedMemberId) {
          await restoreHeldCashWallet(tx, {
            memberId: cart.parsedMemberId,
            refType: 'CHECKOUT',
            refId: created.session.id,
            staffId: staffId ?? null,
            branchId: created.session.branchId ?? null,
            reason: `合併結帳 LINE Pay 扣款失敗，退回零錢包 ${created.session.id}`,
          });
        }
      });
      throw err;
    });

    const fulfilled = await fulfillCheckoutSession(
      created.session.id,
      `LP:${lp.transactionId}`,
      null,
    );

    // fulfill 內開票失敗已入佇列；標 PARTIAL_INVOICE（不沖回／不退 LinePay）
    const partial = failCheckoutIfInvoiceBroken({
      checkoutId: created.session.id,
      invoices: fulfilled?.invoices || [],
    });

    return {
      kind: 'paid',
      message: partial?.message || `LinePay POS 收款成功（${pay.payMethodLabel}）`,
      code: partial?.code || undefined,
      data: {
        checkoutId: created.session.id,
        saleId: created.saleOrderId,
        orderId: created.orderId,
        groupEnrollmentIds: created.groupEnrollmentIds,
        amount: created.session.amount,
        payMethod: pay.payMethodLabel,
        payBreakdown: pay.breakdown,
        linePayAmount: pay.linePayAmount,
        linePayMode: 'POS',
        transactionId: lp.transactionId,
        invoiceNumber: fulfilled?.invoiceNumber || null,
        invoices: fulfilled?.invoices || [],
        invoiceJobs: fulfilled?.invoiceJobs || [],
        invoiceOutcome: partial?.code || fulfilled?.code || 'OK',
        carrierNum: invoiceOpts.carrierNum,
        buyerUbn: invoiceOpts.buyerUbn,
        loveCode: invoiceOpts.loveCode,
      },
    };
  }

  const issuedMeta = await issueCheckoutInvoices(created.session.id);
  const { invoices, invoiceNumber, invoiceJobs } = issuedMeta;

  const partial = failCheckoutIfInvoiceBroken({
    checkoutId: created.session.id,
    invoices,
  });

  return {
    kind: 'paid',
    message: partial?.message || `結帳成功（${pay.payMethodLabel}）`,
    code: partial?.code || undefined,
    data: {
      checkoutId: created.session.id,
      saleId: created.saleOrderId,
      orderId: created.orderId,
      groupEnrollmentIds: created.groupEnrollmentIds,
      amount: created.session.amount,
      payMethod: pay.payMethodLabel,
      payBreakdown: pay.breakdown,
      voucherCode: pay.voucherCode,
      invoiceNumber,
      invoices,
      invoiceJobs,
      invoiceOutcome: partial?.code || issuedMeta?.code || 'OK',
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
      // 重入 Notify：乙禾首期後的 PayUNi 約定頁 → 回寫 CreditHash／PeriodTradeNo；並確保訂閱列存在
      const bindHash = resolveBindCreditHash(cardMeta || {}, {});
      if (bindHash) {
        try {
          if (existing.orderId) {
            await prisma.order.updateMany({
              where: { id: existing.orderId },
              data: { creditHash: bindHash },
            });
            const subs = await prisma.cardSubscription.findMany({
              where: { originOrderId: existing.orderId },
              select: {
                id: true,
                nextChargeAt: true,
                lastChargeAt: true,
                periodType: true,
                creditHash: true,
              },
            });
            for (const s of subs) {
              await applyCardSubscriptionCreditUpdate(s.id, {
                creditHash: bindHash,
                periodTradeNo: cardMeta?.periodTradeNo || null,
                dateList: cardMeta?.dateList || null,
              });
            }
            // 舊資料若仍是 2099 佔位且無 DateList，改寫為可顯示的預期日後再對齊 PayUNi
            for (const s of subs) {
              const fresh = await prisma.cardSubscription.findUnique({ where: { id: s.id } });
              if (fresh && isPlaceholderNextChargeAt(fresh.nextChargeAt)) {
                await prisma.cardSubscription.update({
                  where: { id: s.id },
                  data: { nextChargeAt: resolveExpectedNextChargeAt(fresh) },
                });
              }
              if (fresh) await syncNextChargeAtFromPayuni(fresh);
            }
          }
          await prisma.checkoutSession.updateMany({
            where: { id: checkoutId },
            data: { creditHash: bindHash },
          });
          console.log(`✅ 合併結帳 ${checkoutId} 約定回寫 ${bindHash.startsWith('PERIOD:') ? 'PeriodTradeNo' : 'CreditHash'}`);
        } catch (hashErr) {
          console.error(`❌ 合併結帳 ${checkoutId} 回寫約定失敗:`, hashErr.message);
        }
      }
      if (
        String(existing.cardMode || '').toUpperCase() === 'RECURRING' &&
        existing.orderId
      ) {
        try {
          const paidOrder = await prisma.order.findUnique({ where: { id: existing.orderId } });
          await ensureSubscriptionForPaidRecurringOrder(paidOrder, {
            creditHash: bindHash || cardMeta?.creditHash || paidOrder?.creditHash,
            periodTradeNo: cardMeta?.periodTradeNo || null,
            dateList: cardMeta?.dateList || null,
          });
        } catch (subErr) {
          console.error(`❌ 合併結帳 ${checkoutId} 補建定期定額失敗:`, subErr.message);
        }
      }
      const refreshed = await prisma.checkoutSession.findUnique({
        where: { id: checkoutId },
        include: { member: { select: { id: true, name: true } } },
      });
      return {
        session: refreshed || existing,
        invoiceNumber: null,
        invoices: [],
      };
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
              orderId: order.id,
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
            linkOrder:
              skipPtOrders && session.orderId && coursePlanForSub
                ? { id: session.orderId, coursePlanId: coursePlanForSub.id }
                : null,
          },
        });
      }
    }

    await activateEnrollmentsForCheckout(tx, checkoutId, { merchantNo });
  });

  // 若交易外才解析到方案／課程（order 早已 PAID 的重入），再補一次
  if (isRecurring && !promotionForSub && !coursePlanForSub && paidOrderId) {
    const order = await prisma.order.findUnique({ where: { id: paidOrderId } });
    const promoMatch = (order?.itemDesc || '').match(/商品#(\d+)/);
    const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
    if (promotionId) {
      promotionForSub = await prisma.promotion.findUnique({ where: { id: promotionId } });
    }
    if (!promotionForSub) {
      const courseMatch = (order?.itemDesc || '').match(/課程方案#(\d+)/);
      const coursePlanId = courseMatch ? parseInt(courseMatch[1], 10) : null;
      if (coursePlanId) {
        coursePlanForSub = await prisma.coursePlan.findUnique({ where: { id: coursePlanId } });
      }
    }
  }

  if (session.saleOrderId) {
    await fulfillCardSaleOrder(session.saleOrderId, merchantNo, session.staffId, cardMeta, {
      skipInvoice: true,
    });
  }

  const issued = await issueCheckoutInvoices(session.id);
  const { invoices, invoiceNumber, invoiceJobs } = issued;
  const invoiceCode = issued.code;
  const partial = failCheckoutIfInvoiceBroken({ checkoutId: session.id, invoices });

  if (isRecurring && paidOrderId && (promotionForSub || coursePlanForSub)) {
    try {
      const paidOrder = await prisma.order.findUnique({ where: { id: paidOrderId } });
      await createSubscriptionFromPaidOrder(paidOrder, {
        promotion: promotionForSub || null,
        coursePlan: coursePlanForSub || null,
        creditHash: cardMeta?.creditHash || paidOrder?.creditHash,
        periodTradeNo: cardMeta?.periodTradeNo || null,
        dateList: cardMeta?.dateList || null,
        amountFinal:
          paidOrder?.recurringAmountFinal ??
          session.recurringAmountFinal ??
          coursePlanForSub?.recurringAmountFinal ??
          undefined,
      });
    } catch (subErr) {
      console.error(`❌ 合併結帳 ${session.id} 建立定期定額失敗:`, subErr.message);
    }
  } else if (isRecurring && paidOrderId) {
    try {
      const paidOrder = await prisma.order.findUnique({ where: { id: paidOrderId } });
      await ensureSubscriptionForPaidRecurringOrder(paidOrder, {
        creditHash: cardMeta?.creditHash || paidOrder?.creditHash,
        periodTradeNo: cardMeta?.periodTradeNo || null,
        dateList: cardMeta?.dateList || null,
      });
    } catch (subErr) {
      console.error(`❌ 合併結帳 ${session.id} 補建定期定額失敗:`, subErr.message);
    }
  }

  return {
    session,
    invoiceNumber,
    invoices,
    invoiceJobs,
    code: partial?.code || invoiceCode || null,
    partial: Boolean(partial),
  };
}
