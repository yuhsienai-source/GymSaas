// lib/yipay.js — 臨櫃乙禾／凱基固定式刷卡機（半自動確認入帳）
// 端末授權成功後由櫃檯呼叫 confirm；後續可改接 Webhook／API 自動入帳。
import prisma from './prisma.js';
import { fulfillCheckoutSession } from './checkout.js';
import {
  fulfillPromotionPurchase,
  isUnlimitedPromotion,
  parseTopupQtyFromItemDesc,
  resolveRecurringPeriodDays,
} from './promotion.js';
import { createSubscriptionFromPaidOrder } from './cardSubscription.js';
import { issueInvoice } from './ezpay.js';
import { enqueueInvoiceJob } from './invoiceQueue.js';
import { markYipayCaptureConfirmed } from './yipayCapture.js';
import { buildCardCheckoutRequest, resolveBindVerifyAmount } from './payuni.js';
import {
  deductSaleStock,
  tryIssueSaleInvoice,
} from './inventory.js';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sanitizeTerminalRef(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return s.slice(0, 80);
}

/** 乙禾首期入帳後：開 PayUNi 續期頁（臨櫃 FAmt＝$1 驗卡授權→取消；PeriodAmt＝第2期起原價） */
function tryBuildPeriodBind(session, checkoutId) {
  const periodAmt = Number(session.recurringAmount);
  const totalTimes = parseInt(session.periodTimes, 10);
  const remainTimes =
    Number.isInteger(totalTimes) && totalTimes > 1 ? totalTimes - 1 : totalTimes > 0 ? totalTimes : 0;
  if (!(Number.isFinite(periodAmt) && periodAmt > 0 && remainTimes > 0)) {
    return { needsPeriodBind: false };
  }
  try {
    // 綁定用獨立 MerTradeNo，避免與已履約 CHK 混淆；ProdDesc 仍以 CHK 開頭供 Notify 反查
    const bindMerTradeNo = `${checkoutId}B${String(Date.now()).slice(-6)}`.slice(0, 25);
    const bindOrder = {
      id: bindMerTradeNo,
      bindCheckoutId: checkoutId,
      bindOnly: true,
      itemDesc: session.itemDesc || '定期定額約定',
      cardMode: 'RECURRING',
      periodType: session.periodType || 'M',
      periodTimes: remainTimes,
      periodAmt,
      recurringAmount: periodAmt,
      payuniPeriodHash: session.payuniPeriodHash || null,
      channel: 'counter',
    };
    const verifyAmt = resolveBindVerifyAmount(bindOrder);
    const { actionUrl, payload } = buildCardCheckoutRequest({
      ...bindOrder,
      amount: verifyAmt,
    });
    return {
      needsPeriodBind: true,
      actionUrl,
      payload,
      periodAmt,
      periodTimes: remainTimes,
      bindOnly: true,
      tradeAmt: verifyAmt,
      fAmt: verifyAmt,
      verifyAmt,
      messageHint:
        verifyAmt > 0
          ? `首期已由乙禾入帳；請於 PayUNi 續期頁輸入卡號（將做 $${verifyAmt} 驗證授權確認卡片，隨後取消授權不實際扣款；第 2 期起依 PeriodAmt $${periodAmt} 原價排程）`
          : `首期已由乙禾入帳；請於 PayUNi 續期頁輸入卡號完成約定（本次不收款；後續依 PeriodAmt $${periodAmt} 排程扣款）`,
    };
  } catch (bindErr) {
    console.error(`乙禾 CHK ${checkoutId} 建立 PayUNi 約定頁失敗:`, bindErr.message);
    return { needsPeriodBind: false, bindError: bindErr.message };
  }
}

/** 獨立訂單開票（與 ops tryIssueOrderInvoice 對齊；lib 不可 import routes） */
async function tryIssueYipayOrderInvoice(order, buyerName) {
  const invoiceResult = await issueInvoice({
    id: order.id,
    amount: order.amount,
    itemDesc: order.itemDesc,
    buyerName: buyerName || '體育客顧客',
    carrierNum: order.carrierNum || null,
    buyerUbn: order.buyerUbn || null,
    loveCode: order.loveCode || null,
  });

  if (invoiceResult.Status === 'SUCCESS') {
    const invoiceData = JSON.parse(invoiceResult.Result);
    await prisma.order.update({
      where: { id: order.id },
      data: { invoiceNumber: invoiceData.InvoiceNumber },
    });
    console.log(`🧾 乙禾訂單 ${order.id} 發票：${invoiceData.InvoiceNumber}`);
    return invoiceData.InvoiceNumber;
  }
  const message = invoiceResult.Message || String(invoiceResult);
  console.error(`❌ 乙禾訂單 ${order.id} 發票失敗:`, message);
  const err = new Error(`電子發票開立失敗：${message}`);
  err.statusCode = 502;
  throw err;
}

/**
 * 合併結帳 CHK：乙禾現場刷卡確認 → 履約＋ezPay
 */
export async function confirmYipayCheckout(checkoutId, { terminalRef, staffId } = {}) {
  const id = String(checkoutId || '').trim();
  if (!id.startsWith('CHK')) {
    throw httpError('請提供合併結帳單號 CHK…');
  }

  const session = await prisma.checkoutSession.findUnique({ where: { id } });
  if (!session) throw httpError('找不到結帳單', 404);
  if (session.status === 'PAID') {
    const already = {
      alreadyPaid: true,
      checkoutId: id,
      saleId: session.saleOrderId,
      orderId: session.orderId,
      invoiceNumber: session.invoiceNumber,
      invoices: [],
    };
    // 已入帳但尚未約定續期：仍可重開 PayUNi 頁（補綁 CreditHash）
    if (String(session.cardMode || '').toUpperCase() === 'RECURRING' && !session.creditHash) {
      Object.assign(already, tryBuildPeriodBind(session, id));
    }
    return already;
  }
  if (session.status !== 'PENDING') {
    throw httpError(`結帳單狀態為 ${session.status}，無法確認乙禾刷卡`);
  }

  const breakdown =
    session.payBreakdown && typeof session.payBreakdown === 'object'
      ? session.payBreakdown
      : {};
  const yipayAmt = Number(breakdown.YIPAY) || 0;
  if (!(yipayAmt > 0) && !String(session.payMethod || '').toUpperCase().includes('YIPAY')) {
    throw httpError('此結帳單不是乙禾現場刷卡（YIPAY）');
  }

  const merchantNo = sanitizeTerminalRef(terminalRef)
    ? `YIPAY:${sanitizeTerminalRef(terminalRef)}`
    : `YIPAY:${id}`;

  const fulfilled = await fulfillCheckoutSession(id, merchantNo, null);
  if (!fulfilled) {
    throw httpError('入帳失敗（可能已被取消）', 409);
  }

  await markYipayCaptureConfirmed({
    targetType: 'CHECKOUT',
    targetId: id,
    terminalRef: sanitizeTerminalRef(terminalRef),
  }).catch(() => {});

  // 部分開票失敗：軟拆已寫 InvoiceIssueJob；若完全沒票則再觸發 CHK 重拆
  if (fulfilled.partial || !fulfilled.invoiceNumber) {
    await enqueueInvoiceJob({
      targetType: 'CHECKOUT',
      targetId: id,
      buyerName: session.memberName || null,
    }).catch((e) => console.error('enqueue invoice CHK', e.message));
  }

  const result = {
    alreadyPaid: false,
    checkoutId: id,
    saleId: session.saleOrderId,
    orderId: session.orderId,
    invoiceNumber: fulfilled.invoiceNumber || null,
    invoices: fulfilled.invoices || [],
    invoiceJobs: fulfilled.invoiceJobs || [],
    invoiceOutcome: fulfilled.code || (fulfilled.partial ? 'PARTIAL_INVOICE' : 'OK'),
    terminalRef: sanitizeTerminalRef(terminalRef),
    staffId: staffId || null,
    invoiceDeferred: Boolean(fulfilled.partial) || !fulfilled.invoiceNumber,
  };

  // 月卡／課程定期定額：乙禾收首期後，再開 PayUNi 續期頁約定後續（TradeAmt＝PeriodAmt，期數＝剩餘）
  if (String(session.cardMode || '').toUpperCase() === 'RECURRING') {
    Object.assign(result, tryBuildPeriodBind(session, id));
  }

  return result;
}

/**
 * 獨立銷貨 SAL：乙禾確認入帳
 */
export async function confirmYipaySale(saleId, { terminalRef, staffId } = {}) {
  const id = String(saleId || '').trim();
  if (!id.startsWith('SAL')) {
    throw httpError('請提供銷貨單號 SAL…');
  }

  const sale = await prisma.saleOrder.findUnique({
    where: { id },
    include: {
      items: true,
      member: { select: { id: true, name: true, cashWallet: true } },
    },
  });
  if (!sale) throw httpError('找不到銷貨單', 404);
  if (sale.status === 'PAID') {
    return {
      alreadyPaid: true,
      saleId: id,
      invoiceNumber: sale.invoiceNumber,
    };
  }
  if (sale.status !== 'PENDING') {
    throw httpError(`銷貨單狀態為 ${sale.status}，無法確認乙禾刷卡`);
  }

  const pay = String(sale.payMethod || '').toUpperCase();
  const breakdown =
    sale.payBreakdown && typeof sale.payBreakdown === 'object' ? sale.payBreakdown : {};
  if (!(Number(breakdown.YIPAY) > 0) && !pay.includes('YIPAY')) {
    throw httpError('此銷貨單不是乙禾現場刷卡（YIPAY）');
  }

  const merchantNo = sanitizeTerminalRef(terminalRef)
    ? `YIPAY:${sanitizeTerminalRef(terminalRef)}`
    : `YIPAY:${id}`;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.saleOrder.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PAID', merchantNo },
    });
    if (claimed.count !== 1) {
      throw httpError('入帳失敗（可能已被取消或已入帳）', 409);
    }
    const fresh = await tx.saleOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    await deductSaleStock(tx, fresh, staffId || sale.staffId);
  });

  const paidSale = await prisma.saleOrder.findUnique({
    where: { id },
    include: {
      items: true,
      member: { select: { id: true, name: true } },
    },
  });

  try {
    const invoiceNumber = await tryIssueSaleInvoice(paidSale, paidSale?.member?.name);
    await markYipayCaptureConfirmed({
      targetType: 'SALE',
      targetId: id,
      terminalRef: sanitizeTerminalRef(terminalRef),
    }).catch(() => {});
    return {
      alreadyPaid: false,
      saleId: id,
      invoiceNumber,
      terminalRef: sanitizeTerminalRef(terminalRef),
    };
  } catch (invoiceError) {
    // 乙禾已請款：保留 PAID，開票改非同步重試（避免沖回造成現金孤兒）
    await enqueueInvoiceJob({
      targetType: 'SALE',
      targetId: id,
      buyerName: paidSale?.member?.name || null,
    }).catch(() => {});
    await markYipayCaptureConfirmed({
      targetType: 'SALE',
      targetId: id,
      terminalRef: sanitizeTerminalRef(terminalRef),
    }).catch(() => {});
    console.error(`乙禾銷貨 ${id} 發票暫緩:`, invoiceError.message);
    return {
      alreadyPaid: false,
      saleId: id,
      invoiceNumber: null,
      invoiceDeferred: true,
      invoiceMessage: invoiceError.message,
      terminalRef: sanitizeTerminalRef(terminalRef),
    };
  }
}

/**
 * 獨立訂單（儲值等）：乙禾確認入帳
 */
export async function confirmYipayOrder(orderId, { terminalRef } = {}) {
  const id = String(orderId || '').trim();
  if (!id) throw httpError('請提供訂單號');

  const order = await prisma.order.findUnique({
    where: { id },
    include: { member: true },
  });
  if (!order) throw httpError('找不到訂單', 404);
  if (order.status === 'PAID') {
    return { alreadyPaid: true, orderId: id, invoiceNumber: order.invoiceNumber };
  }
  if (order.status !== 'PENDING') {
    throw httpError(`訂單狀態為 ${order.status}，無法確認乙禾刷卡`);
  }

  const pay = String(order.payMethod || '').toUpperCase();
  const breakdown =
    order.payBreakdown && typeof order.payBreakdown === 'object' ? order.payBreakdown : {};
  if (!(Number(breakdown.YIPAY) > 0) && !pay.includes('YIPAY')) {
    throw httpError('此訂單不是乙禾現場刷卡（YIPAY）');
  }

  const merchantNo = sanitizeTerminalRef(terminalRef)
    ? `YIPAY:${sanitizeTerminalRef(terminalRef)}`
    : `YIPAY:${id}`;

  const promoMatch = (order.itemDesc || '').match(/商品#(\d+)/);
  const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
  let promotionForSub = null;
  const isRecurring = String(order.cardMode || '').toUpperCase() === 'RECURRING';

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id },
      data: { status: 'PAID', merchantNo },
    });
    if (promotionId) {
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
    }
  });

  if (isRecurring && promotionForSub) {
    try {
      const paidOrder = await prisma.order.findUnique({ where: { id } });
      await createSubscriptionFromPaidOrder(paidOrder, {
        promotion: promotionForSub,
        creditHash: paidOrder?.creditHash,
      });
    } catch (subErr) {
      console.error(`乙禾訂單 ${id} 建立訂閱失敗:`, subErr.message);
    }
  }

  try {
    await tryIssueYipayOrderInvoice(order, order.member?.name);
    await markYipayCaptureConfirmed({
      targetType: 'ORDER',
      targetId: id,
      terminalRef: sanitizeTerminalRef(terminalRef),
    }).catch(() => {});
  } catch (invoiceError) {
    console.error(`乙禾訂單 ${id} 發票暫緩（保留入帳）:`, invoiceError.message);
    await enqueueInvoiceJob({
      targetType: 'ORDER',
      targetId: id,
      buyerName: order.member?.name || null,
    }).catch(() => {});
    await markYipayCaptureConfirmed({
      targetType: 'ORDER',
      targetId: id,
      terminalRef: sanitizeTerminalRef(terminalRef),
    }).catch(() => {});
  }

  const refreshed = await prisma.order.findUnique({
    where: { id },
    select: { invoiceNumber: true, status: true, invoiceStatus: true },
  });

  return {
    alreadyPaid: false,
    orderId: id,
    invoiceNumber: refreshed?.invoiceNumber || null,
    invoiceDeferred: !refreshed?.invoiceNumber,
    invoiceStatus: refreshed?.invoiceStatus || null,
    terminalRef: sanitizeTerminalRef(terminalRef),
  };
}
