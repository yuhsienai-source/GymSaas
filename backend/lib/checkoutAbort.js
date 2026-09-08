// lib/checkoutAbort.js — 開票失敗時整筆交易視為失敗並沖回
import prisma from './prisma.js';
import { voidInvoice } from './ezpay.js';
import { restockSaleStock } from './inventory.js';
import {
  isUnlimitedPromotion,
  parseTopupQtyFromItemDesc,
  UNLIMITED_MEMBER_PLAN,
} from './promotion.js';

function parsePayBreakdown(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 任一腿開票失敗，或有開票嘗試卻完全沒開出任何票（空陣列＝未判定，不當失敗） */
export function splitInvoicesHaveFailure(invoices) {
  const list = Array.isArray(invoices) ? invoices : [];
  if (!list.length) return false;
  if (list.some((i) => i && i.ok === false)) return true;
  const issued = list.filter((i) => i && i.ok && i.invoiceNumber);
  return issued.length === 0;
}

export function summarizeInvoiceFailures(invoices) {
  const list = Array.isArray(invoices) ? invoices : [];
  const msgs = list
    .filter((i) => i && i.ok === false)
    .map((i) => i.message || `${i.leg || 'leg'} 開票失敗`)
    .filter(Boolean);
  if (msgs.length) return msgs.join('；');
  if (list.length && !list.some((i) => i?.invoiceNumber)) {
    return '未開立任何電子發票';
  }
  return '電子發票開立失敗';
}

/** 作廢此次軟拆已成功開出的發票（部分成功時必做） */
export async function voidSplitIssuedInvoices(invoices, reason = '開票失敗整筆取消') {
  const list = Array.isArray(invoices) ? invoices : [];
  const voids = [];
  for (const row of list) {
    if (!row?.ok || !row.invoiceNumber || row.skipped) continue;
    try {
      await voidInvoice({ invoiceNumber: row.invoiceNumber, reason });
      voids.push({ id: row.id, invoiceNumber: row.invoiceNumber, ok: true });
    } catch (err) {
      console.error(`作廢發票 ${row.invoiceNumber} 失敗:`, err.message);
      voids.push({
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        ok: false,
        message: err.message,
      });
    }
  }
  return voids;
}

/**
 * 沖回剛入帳的購案（開票失敗緊接呼叫；無法完美還原歷史效期時採最佳努力）
 */
async function reversePromotionFromOrder(tx, order) {
  if (!order?.memberId) return;
  const promoMatch = String(order.itemDesc || '').match(/商品#(\d+)/);
  const promotionId = promoMatch ? parseInt(promoMatch[1], 10) : null;
  if (!promotionId) return;
  const promotion = await tx.promotion.findUnique({ where: { id: promotionId } });
  if (!promotion) return;

  const member = await tx.member.findUnique({ where: { id: order.memberId } });
  if (!member) return;

  if (isUnlimitedPromotion(promotion)) {
    const days = promotion.durationDays || 0;
    let nextExpire = member.expireDate ? new Date(member.expireDate) : null;
    if (nextExpire && days > 0) {
      nextExpire.setDate(nextExpire.getDate() - days);
    }
    const stillValid = nextExpire && nextExpire.getTime() > Date.now();
    await tx.member.update({
      where: { id: member.id },
      data: {
        expireDate: stillValid ? nextExpire : null,
        plan: stillValid ? member.plan || UNLIMITED_MEMBER_PLAN : '計時會員',
      },
    });
    return;
  }

  const qty = parseTopupQtyFromItemDesc(order.itemDesc) || 1;
  const cash = roundMoney(promotion.price * qty);
  const bonus = roundMoney(promotion.bonusGiven * qty);
  await tx.member.update({
    where: { id: member.id },
    data: {
      cashWallet: { decrement: Math.min(cash, Number(member.cashWallet) || 0) },
      bonusWallet: { decrement: Math.min(bonus, Number(member.bonusWallet) || 0) },
    },
  });
}

/**
 * 開票失敗後：作廢已開票、沖回庫存／購案／私教、退零錢包、單據標 FAILED
 * @returns {{ checkoutId: string, payHints: string[] }}
 */
export async function abortPaidCheckoutForInvoiceFailure({
  checkoutId,
  invoices = [],
  reason = '電子發票開立失敗，交易取消',
} = {}) {
  const id = String(checkoutId || '').trim();
  if (!id) throw httpError('缺少 checkoutId', 400);

  await voidSplitIssuedInvoices(invoices, '開票失敗取消');

  const payHints = [];

  await prisma.$transaction(async (tx) => {
    const session = await tx.checkoutSession.findUnique({ where: { id } });
    if (!session) throw httpError('找不到結帳紀錄', 404);

    // 商品：回補庫存並標失敗
    if (session.saleOrderId) {
      const sale = await tx.saleOrder.findUnique({
        where: { id: session.saleOrderId },
        include: { items: true },
      });
      if (sale && sale.status === 'PAID') {
        await restockSaleStock(tx, sale, session.staffId || null);
        await tx.saleOrder.update({
          where: { id: sale.id },
          data: {
            status: 'FAILED',
            invoiceNumber: null,
            itemDesc: `${sale.itemDesc || ''}｜${reason}`.slice(0, 500),
          },
        });
      } else if (sale && sale.status === 'PENDING') {
        await tx.saleOrder.update({
          where: { id: sale.id },
          data: { status: 'FAILED', invoiceNumber: null },
        });
      }
    }

    // 儲值／購案
    if (session.orderId) {
      const order = await tx.order.findUnique({ where: { id: session.orderId } });
      if (order && order.status === 'PAID') {
        await reversePromotionFromOrder(tx, order);
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'FAILED',
            invoiceNumber: null,
            itemDesc: `${order.itemDesc || ''}｜${reason}`.slice(0, 500),
          },
        });
      } else if (order && order.status === 'PENDING') {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'FAILED', invoiceNumber: null },
        });
      }
    }

    // 私教：取消同場訂單、停用剛建立合約（依本場 session 的 PAID 私教單）
    const ptOrders = await tx.order.findMany({
      where: {
        checkoutSessionId: id,
        itemDesc: { contains: '私教' },
        status: { in: ['PAID', 'PENDING'] },
        ...(session.orderId ? { id: { not: session.orderId } } : {}),
      },
    });
    for (const o of ptOrders) {
      await tx.order.update({
        where: { id: o.id },
        data: {
          status: 'FAILED',
          invoiceNumber: null,
          itemDesc: `${o.itemDesc || ''}｜${reason}`.slice(0, 500),
        },
      });
    }
    if (session.memberId && session.ptFulfilled && Array.isArray(session.ptItems)) {
      // 停用最近建立、尚未使用的同場私教合約（最佳努力）
      const contracts = await tx.pTContract.findMany({
        where: {
          memberId: session.memberId,
          isActive: true,
          usedSessions: 0,
          source: 'PURCHASE',
        },
        orderBy: { id: 'desc' },
        take: Math.max(1, session.ptItems.length || 1),
      });
      for (const c of contracts) {
        await tx.pTContract.update({
          where: { id: c.id },
          data: { isActive: false },
        });
      }
    }

    // 複合付款中的零錢包退回
    const breakdown = parsePayBreakdown(session.payBreakdown);
    const walletCash = roundMoney(breakdown.WALLET_CASH || 0);
    if (walletCash > 0 && session.memberId) {
      await tx.member.update({
        where: { id: session.memberId },
        data: { cashWallet: { increment: walletCash } },
      });
      payHints.push(`已退回零錢包 $${walletCash}`);
    }

    const payMethod = String(session.payMethod || '').toUpperCase();
    if (payMethod.includes('CASH') || breakdown.CASH > 0) {
      payHints.push(`請退回現金 $${roundMoney(breakdown.CASH || session.amount)}`);
    }
    if (payMethod.includes('CARD') || breakdown.CARD > 0) {
      payHints.push('刷卡款項請至 PayUNi 後台人工退款／取消授權');
    }
    if (payMethod.includes('LINEPAY') || breakdown.LINEPAY > 0) {
      payHints.push('LinePay 將嘗試自動退款');
    }
    if (payMethod.includes('VOUCHER') || breakdown.VOUCHER > 0) {
      payHints.push('抵用券請人工確認是否需補發');
    }

    await tx.checkoutSession.update({
      where: { id },
      data: {
        status: 'FAILED',
        invoiceNumber: null,
        ptFulfilled: false,
        itemDesc: `${session.itemDesc || ''}｜${reason}`.slice(0, 500),
      },
    });
  });

  return { checkoutId: id, payHints };
}
