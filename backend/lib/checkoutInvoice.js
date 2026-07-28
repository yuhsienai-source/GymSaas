// lib/checkoutInvoice.js — 合併結帳軟拆：一次付款、分腿開票（SAL／購案／私教各一張）
import prisma from './prisma.js';
import { issueInvoice } from './ezpay.js';

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseSplitInvoiceParts(sessionInvoiceNumber) {
  const s = String(sessionInvoiceNumber || '').trim();
  if (!s) return [];
  const body = s.startsWith('SPLIT:') ? s.slice('SPLIT:'.length) : s;
  return body.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * 對 CHK 子單據分別開立 ezPay 發票（MerchantOrderNo = 子單號）
 * CheckoutSession.invoiceNumber 改存 SPLIT:逗號串接（僅顯示／稽核，不作廢依據）
 * 已開票子單會略過（冪等重試安全）
 *
 * @returns {{ invoices: Array<{ leg: string, id: string, invoiceNumber: string|null, amount: number, ok: boolean, skipped?: boolean, message?: string }>, invoiceNumber: string|null }}
 */
export async function issueSplitCheckoutInvoices({
  checkoutId,
  buyerName = '臨櫃客戶',
  carrierNum = null,
  buyerUbn = null,
  loveCode = null,
} = {}) {
  const session = await prisma.checkoutSession.findUnique({
    where: { id: String(checkoutId || '').trim() },
  });
  if (!session) {
    return { invoices: [], invoiceNumber: null };
  }

  const opts = {
    buyerName: buyerName || session.memberName || '臨櫃客戶',
    carrierNum: carrierNum ?? session.carrierNum,
    buyerUbn: buyerUbn ?? session.buyerUbn,
    loveCode: loveCode ?? session.loveCode,
  };

  const invoices = [];

  async function issueOne({ leg, id, amount, itemDesc, stamp, existingInvoiceNumber }) {
    const amt = roundMoney(amount);
    if (!id || !(amt > 0)) return;

    const existing = String(existingInvoiceNumber || '').trim();
    if (existing) {
      invoices.push({
        leg,
        id,
        invoiceNumber: existing,
        amount: amt,
        ok: true,
        skipped: true,
      });
      console.log(`🧾 軟拆略過 ${leg} ${id}（已有 ${existing}）`);
      return;
    }

    try {
      const invoiceResult = await issueInvoice({
        id,
        amount: amt,
        itemDesc: itemDesc || leg,
        ...opts,
      });
      if (invoiceResult.Status === 'SUCCESS') {
        const invoiceData = JSON.parse(invoiceResult.Result);
        const invoiceNumber = invoiceData.InvoiceNumber;
        await stamp(invoiceNumber);
        invoices.push({ leg, id, invoiceNumber, amount: amt, ok: true });
        console.log(`🧾 軟拆開票 ${leg} ${id} → ${invoiceNumber} $${amt}`);
      } else {
        const message = invoiceResult.Message || String(invoiceResult);
        invoices.push({ leg, id, invoiceNumber: null, amount: amt, ok: false, message });
        console.error(`❌ 軟拆開票失敗 ${leg} ${id}:`, message);
      }
    } catch (err) {
      invoices.push({
        leg,
        id,
        invoiceNumber: null,
        amount: amt,
        ok: false,
        message: err.message,
      });
      console.error(`❌ 軟拆開票例外 ${leg} ${id}:`, err.message);
    }
  }

  if (session.saleOrderId) {
    const sale = await prisma.saleOrder.findUnique({ where: { id: session.saleOrderId } });
    if (sale && sale.status === 'PAID') {
      await issueOne({
        leg: 'SALE',
        id: sale.id,
        amount: sale.amount,
        itemDesc: sale.itemDesc || '商品銷售',
        existingInvoiceNumber: sale.invoiceNumber,
        stamp: async (invoiceNumber) => {
          await prisma.saleOrder.update({
            where: { id: sale.id },
            data: { invoiceNumber },
          });
        },
      });
    }
  }

  if (session.orderId) {
    const order = await prisma.order.findUnique({ where: { id: session.orderId } });
    if (order && order.status === 'PAID') {
      await issueOne({
        leg: 'PROMO',
        id: order.id,
        amount: order.amount,
        itemDesc: order.itemDesc || '購案',
        existingInvoiceNumber: order.invoiceNumber,
        stamp: async (invoiceNumber) => {
          await prisma.order.update({
            where: { id: order.id },
            data: { invoiceNumber },
          });
        },
      });
    }
  }

  const ptOrders = await prisma.order.findMany({
    where: {
      checkoutSessionId: session.id,
      itemDesc: { contains: '私教' },
      status: 'PAID',
      ...(session.orderId ? { id: { not: session.orderId } } : {}),
    },
  });
  for (const order of ptOrders) {
    await issueOne({
      leg: 'PT',
      id: order.id,
      amount: order.amount,
      itemDesc: order.itemDesc || '私教購案',
      existingInvoiceNumber: order.invoiceNumber,
      stamp: async (invoiceNumber) => {
        await prisma.order.update({
          where: { id: order.id },
          data: { invoiceNumber },
        });
      },
    });
  }

  const mergedParts = [
    ...new Set([
      ...parseSplitInvoiceParts(session.invoiceNumber),
      ...invoices.map((r) => r.invoiceNumber).filter(Boolean),
    ]),
  ];
  const joined = mergedParts.join(',');

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      invoiceNumber: joined ? `SPLIT:${joined}` : null,
    },
  });

  return {
    invoices,
    invoiceNumber: mergedParts[0] || null,
  };
}

/**
 * 判斷是否為「舊版合併單一發票」（子單與 session 同號、且非軟拆標記）
 */
export function isLegacySharedCheckoutInvoice(sessionInvoiceNumber, childInvoiceNumber) {
  const s = String(sessionInvoiceNumber || '').trim();
  const c = String(childInvoiceNumber || '').trim();
  if (!s || !c) return false;
  if (s.startsWith('SPLIT:') || s.includes(',')) return false;
  return s === c;
}

/** 顯示用：拿掉 SPLIT: 前綴 */
export function formatCheckoutInvoiceDisplay(sessionInvoiceNumber) {
  const s = String(sessionInvoiceNumber || '').trim();
  if (s.startsWith('SPLIT:')) return s.slice('SPLIT:'.length);
  return s || null;
}
