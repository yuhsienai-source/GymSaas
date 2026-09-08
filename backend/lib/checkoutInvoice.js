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

function mapLegToRefType(leg) {
  const L = String(leg || '').toUpperCase();
  if (L === 'SALE') return 'SALE';
  return 'ORDER';
}

/**
 * 對 CHK 子單據分別開立 ezPay 發票（MerchantOrderNo = 子單號）
 * 開票失敗 → 寫入 InvoiceIssueJob（不沖回已收款），回傳 partial
 *
 * @returns {{
 *   invoices: Array<object>,
 *   invoiceNumber: string|null,
 *   invoiceJobs: Array<object>,
 *   partial: boolean,
 *   code: 'OK'|'PARTIAL_INVOICE'|null
 * }}
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
    return {
      invoices: [],
      invoiceNumber: null,
      invoiceJobs: [],
      partial: false,
      code: null,
    };
  }

  const opts = {
    buyerName: buyerName || session.memberName || '臨櫃客戶',
    carrierNum: carrierNum ?? session.carrierNum,
    buyerUbn: buyerUbn ?? session.buyerUbn,
    loveCode: loveCode ?? session.loveCode,
  };

  const invoices = [];
  const invoiceJobs = [];

  async function stampInvoiceStatus(refType, refId, invoiceStatus, invoiceNumber) {
    const data = { invoiceStatus };
    if (invoiceNumber != null) data.invoiceNumber = invoiceNumber;
    if (refType === 'SALE') {
      await prisma.saleOrder.update({ where: { id: refId }, data }).catch(() => {});
    } else {
      await prisma.order.update({ where: { id: refId }, data }).catch(() => {});
    }
  }

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

    const failJob = async (message) => {
      const { upsertFailedInvoiceJob, scheduleInvoiceJob } = await import('./invoiceQueue.js');
      const job = await upsertFailedInvoiceJob({
        refType: mapLegToRefType(leg),
        refId: id,
        leg,
        amount: amt,
        itemDesc: itemDesc || leg,
        buyerName: opts.buyerName,
        carrierNum: opts.carrierNum,
        buyerUbn: opts.buyerUbn,
        loveCode: opts.loveCode,
        checkoutId: session.id,
        lastError: message,
      });
      invoiceJobs.push(job);
      await stampInvoiceStatus(mapLegToRefType(leg), id, 'FAILED');
      invoices.push({
        leg,
        id,
        invoiceNumber: null,
        amount: amt,
        ok: false,
        queued: true,
        jobId: job.id,
        message,
      });
      scheduleInvoiceJob(job.id);
      console.error(`❌ 軟拆開票失敗 ${leg} ${id} → 已入佇列 ${job.id}:`, message);
    };

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
        await stampInvoiceStatus(mapLegToRefType(leg), id, 'ISSUED', invoiceNumber);
        // 若先前有 FAILED 任務，標成功
        await prisma.invoiceIssueJob
          .updateMany({
            where: { refId: id, leg: String(leg).toUpperCase(), status: { not: 'SUCCESS' } },
            data: {
              status: 'SUCCESS',
              invoiceNumber,
              lastError: null,
            },
          })
          .catch(() => {});
        invoices.push({ leg, id, invoiceNumber, amount: amt, ok: true });
        console.log(`🧾 軟拆開票 ${leg} ${id} → ${invoiceNumber} $${amt}`);
      } else {
        await failJob(invoiceResult.Message || String(invoiceResult));
      }
    } catch (err) {
      await failJob(err.message || String(err));
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
            data: { invoiceNumber, invoiceStatus: 'ISSUED' },
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
            data: { invoiceNumber, invoiceStatus: 'ISSUED' },
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
          data: { invoiceNumber, invoiceStatus: 'ISSUED' },
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
  const partial = invoices.some((i) => i && i.ok === false);

  await prisma.checkoutSession.update({
    where: { id: session.id },
    data: {
      invoiceNumber: joined ? `SPLIT:${joined}` : session.invoiceNumber,
      invoiceStatus: partial ? 'FAILED' : joined ? 'ISSUED' : session.invoiceStatus,
    },
  });

  return {
    invoices,
    invoiceNumber: mergedParts[0] || null,
    invoiceJobs,
    partial,
    code: partial ? 'PARTIAL_INVOICE' : invoices.length ? 'OK' : null,
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
