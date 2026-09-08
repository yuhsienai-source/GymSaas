// lib/invoiceQueue.js — ezPay 開票非同步佇列（分腿 InvoiceIssueJob；無 Redis）
import prisma from './prisma.js';
import { issueInvoice } from './ezpay.js';
import { issueSplitCheckoutInvoices } from './checkoutInvoice.js';

const MAX_RETRY = 8;
const RETRY_BASE_MS = 2_000;

/** @type {Set<string>} */
const inFlight = new Set();

function newJobId() {
  return `invj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 開票失敗寫入／更新佇列（status=FAILED，隨後排程重試）
 */
export async function upsertFailedInvoiceJob({
  refType,
  refId,
  leg,
  amount,
  itemDesc,
  buyerName = null,
  carrierNum = null,
  buyerUbn = null,
  loveCode = null,
  checkoutId = null,
  lastError = null,
}) {
  const type = String(refType || '').toUpperCase();
  const id = String(refId || '').trim();
  const L = String(leg || 'ALL').toUpperCase();
  if (!id) throw new Error('invoice job refId required');

  return prisma.invoiceIssueJob.upsert({
    where: { refId_leg: { refId: id, leg: L } },
    create: {
      id: newJobId(),
      refType: type || 'ORDER',
      refId: id,
      leg: L,
      amount: Number(amount) || 0,
      itemDesc: String(itemDesc || L).slice(0, 500),
      buyerName,
      carrierNum,
      buyerUbn,
      loveCode,
      checkoutId: checkoutId ? String(checkoutId) : null,
      status: 'FAILED',
      retryCount: 0,
      lastError: lastError ? String(lastError).slice(0, 500) : null,
    },
    update: {
      refType: type || 'ORDER',
      amount: Number(amount) || 0,
      itemDesc: String(itemDesc || L).slice(0, 500),
      buyerName,
      carrierNum,
      buyerUbn,
      loveCode,
      checkoutId: checkoutId ? String(checkoutId) : null,
      status: 'FAILED',
      lastError: lastError ? String(lastError).slice(0, 500) : null,
    },
  });
}

export function scheduleInvoiceJob(jobId, delayMs = 1500) {
  if (!jobId) return;
  setTimeout(() => {
    processInvoiceJob(jobId).catch((err) => {
      console.error('[invoiceQueue]', jobId, err.message);
    });
  }, Math.max(0, delayMs));
}

/**
 * 相容舊呼叫：依目標建立／重開任務
 */
export async function enqueueInvoiceJob({
  targetType,
  targetId,
  buyerName = null,
  leg = null,
  amount = null,
  itemDesc = null,
  carrierNum = null,
  buyerUbn = null,
  loveCode = null,
  checkoutId = null,
} = {}) {
  const type = String(targetType || '').toUpperCase();
  const id = String(targetId || '').trim();
  if (!id) throw new Error('invalid invoice job target');

  if (type === 'CHECKOUT') {
    // 重跑整張 CHK 軟拆（失敗腿會再寫入 job）
    const split = await issueSplitCheckoutInvoices({
      checkoutId: id,
      buyerName: buyerName || undefined,
      carrierNum,
      buyerUbn,
      loveCode,
    });
    return { kind: 'checkout-resplit', ...split };
  }

  const inferredLeg =
    String(leg || (type === 'SALE' ? 'SALE' : 'PROMO')).toUpperCase();

  let amt = amount;
  let desc = itemDesc;
  let buyer = buyerName;
  let carrier = carrierNum;
  let ubn = buyerUbn;
  let love = loveCode;
  let chk = checkoutId;

  if (type === 'SALE') {
    const sale = await prisma.saleOrder.findUnique({
      where: { id },
      include: { member: { select: { name: true } } },
    });
    if (!sale) throw new Error('sale not found');
    if (sale.invoiceNumber) {
      return { alreadyIssued: true, invoiceNumber: sale.invoiceNumber };
    }
    amt = amt ?? sale.amount;
    desc = desc || sale.itemDesc || '零售';
    buyer = buyer || sale.member?.name;
    carrier = carrier ?? sale.carrierNum;
    ubn = ubn ?? sale.buyerUbn;
    love = love ?? sale.loveCode;
    chk = chk || sale.checkoutSessionId;
  } else {
    const order = await prisma.order.findUnique({
      where: { id },
      include: { member: { select: { name: true } } },
    });
    if (!order) throw new Error('order not found');
    if (order.invoiceNumber) {
      return { alreadyIssued: true, invoiceNumber: order.invoiceNumber };
    }
    amt = amt ?? order.amount;
    desc = desc || order.itemDesc || '購案';
    buyer = buyer || order.member?.name;
    carrier = carrier ?? order.carrierNum;
    ubn = ubn ?? order.buyerUbn;
    love = love ?? order.loveCode;
    chk = chk || order.checkoutSessionId;
  }

  const job = await upsertFailedInvoiceJob({
    refType: type === 'SALE' ? 'SALE' : 'ORDER',
    refId: id,
    leg: inferredLeg,
    amount: amt,
    itemDesc: desc,
    buyerName: buyer,
    carrierNum: carrier,
    buyerUbn: ubn,
    loveCode: love,
    checkoutId: chk,
    lastError: 'enqueued for retry',
  });
  // 立即改 PENDING 並處理
  await prisma.invoiceIssueJob.update({
    where: { id: job.id },
    data: { status: 'PENDING', lastError: null },
  });
  scheduleInvoiceJob(job.id, 50);
  return job;
}

async function stampChildSuccess(job, invoiceNumber) {
  const data = { invoiceNumber, invoiceStatus: 'ISSUED' };
  if (job.refType === 'SALE' || job.leg === 'SALE') {
    await prisma.saleOrder.update({ where: { id: job.refId }, data }).catch(() => {});
  } else {
    await prisma.order.update({ where: { id: job.refId }, data }).catch(() => {});
  }
  if (job.checkoutId) {
    const session = await prisma.checkoutSession.findUnique({
      where: { id: job.checkoutId },
    });
    if (session) {
      const parts = String(session.invoiceNumber || '')
        .replace(/^SPLIT:/, '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      if (!parts.includes(invoiceNumber)) parts.push(invoiceNumber);
      const pending = await prisma.invoiceIssueJob.count({
        where: {
          checkoutId: job.checkoutId,
          status: { in: ['PENDING', 'FAILED'] },
          id: { not: job.id },
        },
      });
      await prisma.checkoutSession.update({
        where: { id: job.checkoutId },
        data: {
          invoiceNumber: parts.length ? `SPLIT:${parts.join(',')}` : null,
          invoiceStatus: pending > 0 ? 'FAILED' : 'ISSUED',
        },
      });
    }
  }
}

export async function processInvoiceJob(jobId) {
  const key = `job:${jobId}`;
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  try {
    const job = await prisma.invoiceIssueJob.findUnique({ where: { id: String(jobId) } });
    if (!job) return null;
    if (job.status === 'SUCCESS' && job.invoiceNumber) return job;
    if (job.retryCount >= MAX_RETRY && job.status === 'FAILED') return job;

    // 子單已有發票 → 直接標成功
    if (job.refType === 'SALE' || job.leg === 'SALE') {
      const sale = await prisma.saleOrder.findUnique({ where: { id: job.refId } });
      if (sale?.invoiceNumber) {
        return prisma.invoiceIssueJob.update({
          where: { id: job.id },
          data: {
            status: 'SUCCESS',
            invoiceNumber: sale.invoiceNumber,
            lastError: null,
          },
        });
      }
    } else {
      const order = await prisma.order.findUnique({ where: { id: job.refId } });
      if (order?.invoiceNumber) {
        return prisma.invoiceIssueJob.update({
          where: { id: job.id },
          data: {
            status: 'SUCCESS',
            invoiceNumber: order.invoiceNumber,
            lastError: null,
          },
        });
      }
    }

    await prisma.invoiceIssueJob.update({
      where: { id: job.id },
      data: { status: 'PENDING', retryCount: { increment: 1 } },
    });

    try {
      const inv = await issueInvoice({
        id: job.refId,
        amount: job.amount,
        itemDesc: job.itemDesc,
        buyerName: job.buyerName || '體育客顧客',
        carrierNum: job.carrierNum,
        buyerUbn: job.buyerUbn,
        loveCode: job.loveCode,
      });
      if (inv.Status !== 'SUCCESS') {
        throw new Error(inv.Message || 'issue failed');
      }
      const data = JSON.parse(inv.Result);
      const invoiceNumber = data.InvoiceNumber;
      await stampChildSuccess(job, invoiceNumber);
      return prisma.invoiceIssueJob.update({
        where: { id: job.id },
        data: {
          status: 'SUCCESS',
          invoiceNumber,
          lastError: null,
        },
      });
    } catch (err) {
      const nextCount = job.retryCount + 1;
      const giveUp = nextCount >= MAX_RETRY;
      const delay = RETRY_BASE_MS * 2 ** Math.min(nextCount, 6);
      const updated = await prisma.invoiceIssueJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          lastError: String(err.message || err).slice(0, 500),
        },
      });
      if (!giveUp) scheduleInvoiceJob(job.id, delay);
      return updated;
    }
  } finally {
    inFlight.delete(key);
  }
}

/** 啟動時掃 PENDING／FAILED（未達上限） */
export async function bootInvoiceQueue() {
  try {
    const due = await prisma.invoiceIssueJob.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        retryCount: { lt: MAX_RETRY },
        invoiceNumber: null,
      },
      take: 50,
      orderBy: { updatedAt: 'asc' },
    });
    for (const j of due) scheduleInvoiceJob(j.id, 100);
    if (due.length) console.log(`[invoiceQueue] resumed ${due.length} job(s)`);
  } catch (err) {
    console.warn('[invoiceQueue] boot skip:', err.message);
  }
}

export async function listInvoiceJobs({ status, take = 50, checkoutId = null } = {}) {
  return prisma.invoiceIssueJob.findMany({
    where: {
      ...(status ? { status: String(status).toUpperCase() } : {}),
      ...(checkoutId ? { checkoutId: String(checkoutId) } : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: Math.min(200, Number(take) || 50),
  });
}

export async function retryInvoiceJob(jobId) {
  const job = await prisma.invoiceIssueJob.findUnique({ where: { id: String(jobId) } });
  if (!job) {
    const err = new Error('找不到開票任務');
    err.statusCode = 404;
    throw err;
  }
  if (job.status === 'SUCCESS' && job.invoiceNumber) return job;

  await prisma.invoiceIssueJob.update({
    where: { id: job.id },
    data: { status: 'PENDING', lastError: null },
  });
  scheduleInvoiceJob(job.id, 50);
  return prisma.invoiceIssueJob.findUnique({ where: { id: job.id } });
}
