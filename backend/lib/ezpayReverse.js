// lib/ezpayReverse.js
// 交易異動：取消銷貨／退費折讓時，解析發票上下文並呼叫 ezPay 作廢或折讓
// 軟拆後：各子單（SAL／TYK／CRS／私教）各自開票，異動只動自己那張
// 舊版合併單一發票：有存活兄弟單時禁止作廢整張，僅准折讓
import prisma from './prisma.js';
import { reverseIssuedInvoice, sanitizeMerchantOrderNo } from './ezpay.js';
import { isLegacySharedCheckoutInvoice } from './checkoutInvoice.js';

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * @typedef {object} InvoiceReverseCtx
 * @property {string|null} invoiceNumber
 * @property {string} merchantOrderNo  開立時 MerchantOrderNo（軟拆＝子單號；舊合併＝CHK）
 * @property {number} amount           此次應反向的含稅金額
 * @property {string} itemDesc
 * @property {'void'|'allowance'} prefer
 * @property {string|null} checkoutSessionId
 * @property {boolean} sharedInvoice   舊版合併發票且仍有其他存活子單
 */

/**
 * 列出 CHK 下仍 PAID 的兄弟子單（排除自身）
 */
export async function listAliveCheckoutSiblings(
  session,
  { excludeSaleId = null, excludeOrderId = null, tx = null } = {},
) {
  if (!session?.id) return [];
  const db = tx || prisma;
  const alive = [];

  if (session.saleOrderId && session.saleOrderId !== excludeSaleId) {
    const sale = await db.saleOrder.findUnique({
      where: { id: session.saleOrderId },
      select: { id: true, status: true, amount: true },
    });
    if (sale?.status === 'PAID') {
      alive.push({ type: 'sale', id: sale.id, amount: sale.amount });
    }
  }

  if (session.orderId && session.orderId !== excludeOrderId) {
    const order = await db.order.findUnique({
      where: { id: session.orderId },
      select: { id: true, status: true, amount: true, itemDesc: true },
    });
    if (order?.status === 'PAID') {
      alive.push({
        type: String(order.itemDesc || '').includes('私教') ? 'pt' : 'promo',
        id: order.id,
        amount: order.amount,
      });
    }
  }

  const ptOrders = await db.order.findMany({
    where: {
      checkoutSessionId: session.id,
      itemDesc: { contains: '私教' },
      status: 'PAID',
      ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      ...(session.orderId ? { id: { not: session.orderId } } : {}),
    },
    select: { id: true, amount: true },
  });
  for (const o of ptOrders) {
    if (excludeOrderId && o.id === excludeOrderId) continue;
    alive.push({ type: 'pt', id: o.id, amount: o.amount });
  }

  return alive;
}

/**
 * 取消商品銷售：決定如何反向發票
 */
export async function resolveSaleInvoiceReverse(sale, { tx } = {}) {
  const db = tx || prisma;
  const saleAmount = roundMoney(sale.amount);
  const childInv = sale.invoiceNumber || null;

  if (!sale.checkoutSessionId) {
    if (!childInv) {
      return {
        invoiceNumber: null,
        merchantOrderNo: sanitizeMerchantOrderNo(sale.id),
        amount: saleAmount,
        itemDesc: sale.itemDesc || '商品銷售',
        prefer: 'void',
        checkoutSessionId: null,
        sharedInvoice: false,
        skip: true,
      };
    }
    return {
      invoiceNumber: childInv,
      merchantOrderNo: sanitizeMerchantOrderNo(sale.id),
      amount: saleAmount,
      itemDesc: sale.itemDesc || '商品銷售',
      prefer: 'void',
      checkoutSessionId: null,
      sharedInvoice: false,
      skip: false,
    };
  }

  const session = await db.checkoutSession.findUnique({
    where: { id: sale.checkoutSessionId },
  });
  if (!session) {
    return {
      invoiceNumber: childInv,
      merchantOrderNo: sanitizeMerchantOrderNo(sale.id),
      amount: saleAmount,
      itemDesc: sale.itemDesc || '商品銷售',
      prefer: childInv ? 'void' : 'void',
      checkoutSessionId: sale.checkoutSessionId,
      sharedInvoice: false,
      skip: !childInv,
    };
  }

  const legacyShared = isLegacySharedCheckoutInvoice(session.invoiceNumber, childInv);

  // 軟拆／獨立子單發票：只動 SAL 自己
  if (!legacyShared) {
    if (!childInv) {
      return {
        invoiceNumber: null,
        merchantOrderNo: sanitizeMerchantOrderNo(sale.id),
        amount: saleAmount,
        itemDesc: sale.itemDesc || '商品銷售',
        prefer: 'void',
        checkoutSessionId: session.id,
        sharedInvoice: false,
        skip: true,
      };
    }
    return {
      invoiceNumber: childInv,
      merchantOrderNo: sanitizeMerchantOrderNo(sale.id),
      amount: saleAmount,
      itemDesc: sale.itemDesc || '商品銷售',
      prefer: 'void',
      checkoutSessionId: session.id,
      sharedInvoice: false,
      skip: false,
    };
  }

  // 舊版合併單一發票
  const siblings = await listAliveCheckoutSiblings(session, {
    excludeSaleId: sale.id,
    tx: db,
  });
  const invoiceNumber = session.invoiceNumber || childInv;
  const merchantOrderNo = sanitizeMerchantOrderNo(session.id);

  if (siblings.length > 0 && invoiceNumber) {
    return {
      invoiceNumber,
      merchantOrderNo,
      amount: saleAmount,
      itemDesc: sale.itemDesc || '商品銷售折讓',
      prefer: 'allowance',
      checkoutSessionId: session.id,
      sharedInvoice: true,
      skip: false,
    };
  }

  return {
    invoiceNumber,
    merchantOrderNo,
    amount: roundMoney(session.amount || saleAmount),
    itemDesc: session.itemDesc || sale.itemDesc || '合併結帳',
    prefer: 'void',
    checkoutSessionId: session.id,
    sharedInvoice: false,
    skip: !invoiceNumber,
  };
}

/**
 * 儲值／購案／私教 Order 退費或取消：決定如何反向發票
 */
export async function resolveOrderInvoiceReverse(order, { refundCash, tx } = {}) {
  const db = tx || prisma;
  const orderAmount = roundMoney(order.amount);
  const cash = roundMoney(refundCash);
  const childInv = order.invoiceNumber || null;

  let session = null;
  if (order.checkoutSessionId) {
    session = await db.checkoutSession.findUnique({
      where: { id: order.checkoutSessionId },
    });
  }

  if (!childInv && !session?.invoiceNumber) {
    return {
      invoiceNumber: null,
      merchantOrderNo: sanitizeMerchantOrderNo(order.id),
      amount: 0,
      itemDesc: order.itemDesc || '訂單',
      prefer: 'allowance',
      checkoutSessionId: session?.id || null,
      sharedInvoice: false,
      skip: true,
      skipReason: '無發票',
    };
  }

  if (cash <= 0) {
    // 勿回傳 SPLIT:／逗號複合標記，以免上游誤當真實發票號強制折讓
    const safeInv =
      childInv && !String(childInv).startsWith('SPLIT:') && !String(childInv).includes(',')
        ? childInv
        : null;
    return {
      invoiceNumber: safeInv,
      merchantOrderNo: sanitizeMerchantOrderNo(order.id),
      amount: 0,
      itemDesc: order.itemDesc || '訂單',
      prefer: 'allowance',
      checkoutSessionId: session?.id || null,
      sharedInvoice: false,
      skip: true,
      skipReason: '應退現金為 0，無需折讓／作廢',
    };
  }

  const legacyShared = session
    ? isLegacySharedCheckoutInvoice(session.invoiceNumber, childInv)
    : false;

  // 軟拆／獨立：MerchantOrderNo = 訂單號
  if (!legacyShared) {
    const invoiceNumber = childInv;
    if (!invoiceNumber) {
      return {
        invoiceNumber: null,
        merchantOrderNo: sanitizeMerchantOrderNo(order.id),
        amount: Math.min(cash, orderAmount),
        itemDesc: order.itemDesc || '訂單',
        prefer: 'allowance',
        checkoutSessionId: session?.id || null,
        sharedInvoice: false,
        skip: true,
        skipReason: '無子單發票',
      };
    }
    if (cash >= orderAmount) {
      return {
        invoiceNumber,
        merchantOrderNo: sanitizeMerchantOrderNo(order.id),
        amount: orderAmount,
        itemDesc: order.itemDesc || '訂單',
        prefer: 'void',
        checkoutSessionId: session?.id || null,
        sharedInvoice: false,
        skip: false,
      };
    }
    return {
      invoiceNumber,
      merchantOrderNo: sanitizeMerchantOrderNo(order.id),
      amount: Math.min(cash, orderAmount),
      itemDesc: order.itemDesc || '退費折讓',
      prefer: 'allowance',
      checkoutSessionId: session?.id || null,
      sharedInvoice: false,
      skip: false,
    };
  }

  // 舊版合併單一發票
  const siblings = await listAliveCheckoutSiblings(session, {
    excludeOrderId: order.id,
    tx: db,
  });
  const invoiceNumber = session.invoiceNumber || childInv;
  const merchantOrderNo = sanitizeMerchantOrderNo(session.id);

  if (siblings.length > 0) {
    return {
      invoiceNumber,
      merchantOrderNo,
      amount: Math.min(cash, orderAmount),
      itemDesc: order.itemDesc || '退費折讓',
      prefer: 'allowance',
      checkoutSessionId: session.id,
      sharedInvoice: true,
      skip: false,
    };
  }

  if (cash >= orderAmount && cash >= roundMoney(session.amount || orderAmount)) {
    return {
      invoiceNumber,
      merchantOrderNo,
      amount: roundMoney(session.amount || orderAmount),
      itemDesc: session.itemDesc || order.itemDesc || '合併結帳',
      prefer: 'void',
      checkoutSessionId: session.id,
      sharedInvoice: false,
      skip: false,
    };
  }

  return {
    invoiceNumber,
    merchantOrderNo,
    amount: Math.min(cash, orderAmount),
    itemDesc: order.itemDesc || '退費折讓',
    prefer: 'allowance',
    checkoutSessionId: session.id,
    sharedInvoice: false,
    skip: false,
  };
}

/**
 * 執行 ezPay 反向；成功時可選擇回寫 CheckoutSession／關聯單據註記
 */
export async function executeInvoiceReverse(ctx, { reason, buyerEmail, prefer } = {}) {
  if (!ctx?.invoiceNumber || ctx.skip) {
    return { action: 'none', invoiceNumber: null };
  }
  const mode = prefer || ctx.prefer || 'void';
  return reverseIssuedInvoice({
    invoiceNumber: ctx.invoiceNumber,
    merchantOrderNo: ctx.merchantOrderNo,
    itemDesc: ctx.itemDesc,
    amount: ctx.amount,
    reason,
    prefer: mode,
    buyerEmail,
  });
}

/**
 * 將反向結果附註寫入 itemDesc 後綴
 */
export function appendInvoiceReverseNote(itemDesc, reverseResult) {
  const base = String(itemDesc || '').trim();
  if (!reverseResult || reverseResult.action === 'none') {
    return base;
  }
  if (reverseResult.action === 'void') {
    return `${base}｜發票已作廢 ${reverseResult.invoiceNumber}`.trim();
  }
  if (reverseResult.action === 'allowance') {
    return `${base}｜發票折讓 ${reverseResult.invoiceNumber} 折讓號 ${reverseResult.allowanceNo} $${reverseResult.allowanceAmt}`.trim();
  }
  return base;
}

/**
 * 合併結帳：反向成功後於 CheckoutSession.itemDesc 留下稽核註記
 */
export async function syncCheckoutInvoiceAfterReverse(tx, checkoutSessionId, reverseResult) {
  if (!checkoutSessionId || !reverseResult) return;
  if (reverseResult.action !== 'void' && reverseResult.action !== 'allowance') return;
  const session = await tx.checkoutSession.findUnique({
    where: { id: checkoutSessionId },
  });
  if (!session) return;
  await tx.checkoutSession.update({
    where: { id: checkoutSessionId },
    data: {
      itemDesc: appendInvoiceReverseNote(session.itemDesc, reverseResult),
    },
  });
}

/**
 * 子單全部沖回／退費後，將 CHK 標為 CANCELLED（避免報表仍顯示「成功」）
 * @returns {Promise<'PAID'|'CANCELLED'|null>} 更新後狀態；無 session 則 null
 */
export async function reevaluateCheckoutSessionStatus(tx, checkoutSessionId) {
  if (!checkoutSessionId) return null;
  const db = tx || prisma;
  const session = await db.checkoutSession.findUnique({
    where: { id: checkoutSessionId },
  });
  if (!session) return null;
  if (session.status !== 'PAID' && session.status !== 'CANCELLED') {
    return session.status;
  }

  const statuses = [];

  if (session.saleOrderId) {
    const sale = await db.saleOrder.findUnique({
      where: { id: session.saleOrderId },
      select: { status: true },
    });
    if (sale) statuses.push(String(sale.status || '').toUpperCase());
  }

  if (session.orderId) {
    const order = await db.order.findUnique({
      where: { id: session.orderId },
      select: { status: true },
    });
    if (order) statuses.push(String(order.status || '').toUpperCase());
  }

  const ptOrders = await db.order.findMany({
    where: {
      checkoutSessionId: session.id,
      itemDesc: { contains: '私教' },
      ...(session.orderId ? { id: { not: session.orderId } } : {}),
    },
    select: { status: true },
  });
  for (const o of ptOrders) {
    statuses.push(String(o.status || '').toUpperCase());
  }

  // 有 ptItems 卻尚無 Order（舊路徑）時，若 session 仍標 ptFulfilled，視為仍存活
  if (
    !ptOrders.length &&
    session.ptFulfilled &&
    Array.isArray(session.ptItems) &&
    session.ptItems.length
  ) {
    statuses.push('PAID');
  }

  if (!statuses.length) {
    if (session.status === 'PAID') {
      await db.checkoutSession.update({
        where: { id: session.id },
        data: { status: 'CANCELLED' },
      });
      return 'CANCELLED';
    }
    return session.status;
  }

  const hasPaid = statuses.some((s) => s === 'PAID' || s === 'PENDING');
  if (hasPaid) {
    if (session.status !== 'PAID') {
      await db.checkoutSession.update({
        where: { id: session.id },
        data: { status: 'PAID' },
      });
    }
    return 'PAID';
  }

  const allClosed = statuses.every(
    (s) => s === 'CANCELLED' || s === 'REFUNDED' || s === 'FAILED',
  );
  if (allClosed && session.status !== 'CANCELLED') {
    await db.checkoutSession.update({
      where: { id: session.id },
      data: { status: 'CANCELLED' },
    });
    return 'CANCELLED';
  }
  return session.status;
}

/**
 * 合併結帳零錢包按子單金額比例退回（避免整車 breakdown 重複退）
 */
export function prorateCheckoutWalletCash({
  payBreakdown,
  legAmount,
  sessionAmount,
}) {
  const breakdown =
    payBreakdown && typeof payBreakdown === 'object' ? payBreakdown : {};
  const walletCash = roundMoney(Number(breakdown.WALLET_CASH) || 0);
  if (!(walletCash > 0)) return 0;
  const leg = roundMoney(legAmount);
  const total = roundMoney(sessionAmount);
  if (!(total > 0) || !(leg > 0)) return walletCash;
  if (leg >= total) return walletCash;
  return roundMoney(walletCash * (leg / total));
}
