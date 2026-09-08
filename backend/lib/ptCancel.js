// lib/ptCancel.js — 取消私教課程購買（CHK 合併或獨立私教 Order）
import prisma from './prisma.js';
import {
  assertRealInvoiceForAllowance,
  executeInvoiceReverse,
  resolveOrderInvoiceReverse,
  syncCheckoutInvoiceAfterReverse,
  reevaluateCheckoutSessionStatus,
  prorateCheckoutWalletCash,
} from './ezpayReverse.js';

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * 依 checkout 關聯的私教 Order，找出尚未使用的 PTContract
 */
async function findUnusedContractsForPtOrders(tx, { memberId, trainerId, orders, sessionCreatedAt }) {
  const windowMs = 10 * 60 * 1000;
  const base = sessionCreatedAt ? new Date(sessionCreatedAt).getTime() : Date.now();
  const from = new Date(base - windowMs);
  const to = new Date(base + windowMs);

  const candidates = await tx.pTContract.findMany({
    where: {
      memberId,
      ...(trainerId ? { trainerId } : {}),
      isActive: true,
      createdAt: { gte: from, lte: to },
    },
    orderBy: { createdAt: 'asc' },
  });

  const used = new Set();
  const matched = [];
  for (const order of orders) {
    const amount = roundMoney(order.amount);
    const sessionsMatch = String(order.itemDesc || '').match(/[×x]\s*(\d+)\s*堂/);
    const totalSessions = sessionsMatch ? parseInt(sessionsMatch[1], 10) : null;
    const hit = candidates.find((c) => {
      if (used.has(c.id)) return false;
      if (roundMoney(c.pricePaid) !== amount) return false;
      if (totalSessions != null && c.totalSessions !== totalSessions) return false;
      if (c.usedSessions > 0) return false;
      return true;
    });
    if (!hit) {
      const anyUsed = candidates.find((c) => {
        if (used.has(c.id)) return false;
        if (roundMoney(c.pricePaid) !== amount) return false;
        if (totalSessions != null && c.totalSessions !== totalSessions) return false;
        return c.usedSessions > 0;
      });
      if (anyUsed) {
        throw httpError(
          `私教合約 #${anyUsed.id} 已使用 ${anyUsed.usedSessions} 堂，無法取消沖回`,
          400,
        );
      }
      throw httpError('找不到對應且未使用的私教合約，無法取消', 404);
    }
    used.add(hit.id);
    matched.push(hit);
  }
  return matched;
}

/**
 * 取消私教課程購買
 * @param {{ checkoutId?: string, orderId?: string, reason?: string, prefer?: 'void'|'allowance', staffId?: number|null }} opts
 */
export async function cancelPtPurchase({
  checkoutId,
  orderId,
  reason,
  prefer = 'void',
  staffId = null,
} = {}) {
  const chk = checkoutId ? String(checkoutId).trim().toUpperCase() : '';
  const oid = orderId ? String(orderId).trim().toUpperCase() : '';
  if (!chk && !oid) {
    throw httpError('請提供 checkoutId（CHK…）或 orderId');
  }

  let session = null;
  let ptOrders = [];

  if (chk) {
    session = await prisma.checkoutSession.findUnique({ where: { id: chk } });
    if (!session) throw httpError('找不到此結帳編號', 404);
    if (session.status === 'CANCELLED') throw httpError('此結帳已取消');
    if (session.status !== 'PAID' && session.status !== 'PENDING') {
      throw httpError(`⛔ 狀態 [${session.status}] 不可取消`);
    }
    ptOrders = await prisma.order.findMany({
      where: {
        checkoutSessionId: session.id,
        itemDesc: { contains: '私教' },
        status: { in: ['PAID', 'PENDING'] },
      },
    });
    if (!ptOrders.length && Array.isArray(session.ptItems) && session.ptItems.length) {
      // 舊資料可能 skipOrders，仍允許依 session 取消合約
      ptOrders = [];
    } else if (!ptOrders.length && (!session.ptItems || !session.ptItems.length)) {
      throw httpError('此結帳沒有私教課程項目');
    }
  } else {
    const order = await prisma.order.findUnique({ where: { id: oid } });
    if (!order) throw httpError('找不到此訂單', 404);
    if (!String(order.itemDesc || '').includes('私教')) {
      throw httpError('此訂單不是私教購案');
    }
    if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
      throw httpError(`訂單狀態為 [${order.status}]，不可再取消`);
    }
    if (order.status !== 'PAID' && order.status !== 'PENDING') {
      throw httpError(`⛔ 狀態 [${order.status}] 不可取消`);
    }
    ptOrders = [order];
    if (order.checkoutSessionId) {
      session = await prisma.checkoutSession.findUnique({
        where: { id: order.checkoutSessionId },
      });
    }
  }

  const wasPaid =
    (session && session.status === 'PAID') ||
    ptOrders.some((o) => o.status === 'PAID');

  const ptAmount = roundMoney(
    ptOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0) ||
      (Array.isArray(session?.ptItems)
        ? session.ptItems.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0)
        : 0),
  );

  const memberId = session?.memberId || ptOrders[0]?.memberId;
  const trainerId = session?.trainerId || null;
  if (!memberId) throw httpError('缺少會員，無法取消私教購案');

  let invoiceReverse = { action: 'none', invoiceNumber: null };
  let sharedInvoice = false;
  if (wasPaid) {
    for (const o of ptOrders.filter((x) => x.status === 'PAID')) {
      const ctx = await resolveOrderInvoiceReverse(o, {
        refundCash: roundMoney(o.amount),
      });
      if (prefer === 'allowance') {
        assertRealInvoiceForAllowance(ctx.invoiceNumber || o.invoiceNumber, '私教退費折讓');
        ctx.prefer = 'allowance';
        ctx.skip = false;
      } else if (!ctx.sharedInvoice) {
        ctx.prefer = 'void';
      } else {
        ctx.prefer = 'allowance';
        assertRealInvoiceForAllowance(ctx.invoiceNumber || o.invoiceNumber, '私教退費折讓');
        ctx.skip = false;
      }
      if (ctx.sharedInvoice) sharedInvoice = true;
      if (ctx.invoiceNumber && !ctx.skip) {
        try {
          const r = await executeInvoiceReverse(ctx, {
            reason: reason || (prefer === 'allowance' ? '私教退費折讓' : '取消私教購案'),
            prefer: ctx.prefer,
          });
          if (r.action !== 'none') invoiceReverse = r;
        } catch (ezErr) {
          const err = new Error(
            ezErr.message || 'ezPay 發票反向失敗，取消已中止（合約／訂單未異動）',
          );
          err.statusCode = ezErr.statusCode || 502;
          throw err;
        }
      }
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const contracts =
      ptOrders.length > 0
        ? await findUnusedContractsForPtOrders(tx, {
            memberId,
            trainerId,
            orders: ptOrders,
            sessionCreatedAt: session?.createdAt || ptOrders[0]?.createdAt,
          })
        : await findUnusedContractsFromPtItems(tx, session);

    for (const c of contracts) {
      if (c.usedSessions > 0) {
        throw httpError(`私教合約 #${c.id} 已使用 ${c.usedSessions} 堂，無法取消`, 400);
      }
      await tx.pTContract.update({
        where: { id: c.id },
        data: { isActive: false },
      });
    }

    for (const o of ptOrders) {
      await tx.order.update({
        where: { id: o.id },
        data: {
          status: prefer === 'allowance' ? 'REFUNDED' : 'CANCELLED',
        },
      });
    }

    let walletRefunded = 0;
    const paySource = session || ptOrders[0];
    if (wasPaid && paySource) {
      const refundWallet = prorateCheckoutWalletCash({
        payBreakdown: paySource.payBreakdown,
        legAmount: ptAmount,
        sessionAmount: session?.amount || ptAmount,
      });
      if (refundWallet > 0) {
        await tx.member.update({
          where: { id: memberId },
          data: { cashWallet: { increment: refundWallet } },
        });
        walletRefunded = refundWallet;
      }
    }

    if (session) {
      const note = `[私教已取消${staffId ? ` by#${staffId}` : ''}${reason ? `: ${reason}` : ''}]`;
      const nextSessionStatus = await reevaluateCheckoutSessionStatus(tx, session.id);
      const alivePt = await tx.order.count({
        where: {
          checkoutSessionId: session.id,
          itemDesc: { contains: '私教' },
          status: 'PAID',
        },
      });
      await tx.checkoutSession.update({
        where: { id: session.id },
        data: {
          itemDesc: `${session.itemDesc || ''} ${note}`.trim().slice(0, 240),
          ptFulfilled: alivePt > 0,
          ...(nextSessionStatus === 'CANCELLED' ? { status: 'CANCELLED' } : {}),
        },
      });
      await syncCheckoutInvoiceAfterReverse(tx, session.id, invoiceReverse);
    }

    return {
      checkoutId: session?.id || null,
      orderIds: ptOrders.map((o) => o.id),
      contractIds: contracts.map((c) => c.id),
      walletRefunded,
      invoice: invoiceReverse,
      sharedInvoice,
      amount: ptAmount,
    };
  });

  return result;
}

async function findUnusedContractsFromPtItems(tx, session) {
  if (!session?.memberId || !Array.isArray(session.ptItems) || !session.ptItems.length) {
    throw httpError('無法解析私教項目', 400);
  }
  const windowMs = 10 * 60 * 1000;
  const base = new Date(session.createdAt).getTime();
  const candidates = await tx.pTContract.findMany({
    where: {
      memberId: session.memberId,
      ...(session.trainerId ? { trainerId: session.trainerId } : {}),
      isActive: true,
      createdAt: {
        gte: new Date(base - windowMs),
        lte: new Date(base + windowMs),
      },
    },
  });
  const used = new Set();
  const matched = [];
  for (const line of session.ptItems) {
    const amount = roundMoney(line.lineTotal);
    const totalSessions = Number(line.totalSessions) || 0;
    const hit = candidates.find(
      (c) =>
        !used.has(c.id) &&
        roundMoney(c.pricePaid) === amount &&
        c.totalSessions === totalSessions &&
        c.usedSessions === 0,
    );
    if (!hit) {
      throw httpError('找不到對應且未使用的私教合約，無法取消', 404);
    }
    used.add(hit.id);
    matched.push(hit);
  }
  return matched;
}
