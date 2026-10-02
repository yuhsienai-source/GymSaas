// lib/ezpayReverse.js
// 交易異動：取消銷貨／退費折讓時，解析發票上下文並經 einvoice 閘道作廢或折讓（依發票營業人憑證）
// 軟拆後：各子單（SAL／TYK／CRS／私教／團課）各自開票，異動只動自己那張
// 舊版合併單一發票（EInvoice refType=CHECKOUT）：有存活兄弟單時禁止作廢整張，僅准折讓
import prisma from './prisma.js';
import { sanitizeMerchantOrderNo } from './ezpay.js';
import { reverseEInvoice } from './einvoice.js';

/** 單據目前已開立之發票（第一張為主；其餘如免稅分張另列） */
async function issuedInvoicesOf(refId, db) {
  return db.eInvoice.findMany({
    where: { refId: String(refId), status: 'ISSUED' },
    orderBy: { createdAt: 'asc' },
  });
}

async function legacySharedInvoiceOf(checkoutSessionId, db) {
  if (!checkoutSessionId) return null;
  return db.eInvoice.findFirst({
    where: { refType: 'CHECKOUT', refId: String(checkoutSessionId), status: 'ISSUED' },
  });
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * 折讓僅能對「已成功開立」的真實發票號碼；SPLIT:／複合標記／空值一律拒絕
 * @returns {string} 正規化後發票號
 */
export function assertRealInvoiceForAllowance(invoiceNumber, label = '退費折讓') {
  const s = String(invoiceNumber || '').trim().toUpperCase();
  if (!s || s.startsWith('SPLIT:') || s.includes(',')) {
    const err = new Error(
      `${label}須在開票成功後才能辦理（尚無有效發票號碼；未開票或開票失敗的交易不可折讓）`,
    );
    err.statusCode = 400;
    throw err;
  }
  return s;
}

/** 是否為可折讓的真實發票號（不作 throw） */
export function isRealInvoiceNumber(invoiceNumber) {
  const s = String(invoiceNumber || '').trim();
  return Boolean(s && !s.startsWith('SPLIT:') && !s.includes(','));
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
 * 軟拆／獨立子單發票只動 SAL 自己；舊版合併發票有存活兄弟單時僅准折讓
 */
export async function resolveSaleInvoiceReverse(sale, { tx } = {}) {
  const db = tx || prisma;
  const saleAmount = roundMoney(sale.amount);
  const childRows = await issuedInvoicesOf(sale.id, db);
  const childInv = childRows[0]?.invoiceNumber || null;
  const session = sale.checkoutSessionId
    ? await db.checkoutSession.findUnique({ where: { id: sale.checkoutSessionId } })
    : null;
  const legacyRow = !childInv && session ? await legacySharedInvoiceOf(session.id, db) : null;

  if (!legacyRow) {
    return {
      invoiceNumber: childInv,
      merchantOrderNo: sanitizeMerchantOrderNo(sale.id),
      amount: saleAmount,
      itemDesc: sale.itemDesc || '商品銷售',
      prefer: 'void',
      checkoutSessionId: session?.id || sale.checkoutSessionId || null,
      sharedInvoice: false,
      skip: !childInv,
      extraInvoiceNumbers: childRows.slice(1).map((r) => r.invoiceNumber),
    };
  }

  const siblings = await listAliveCheckoutSiblings(session, { excludeSaleId: sale.id, tx: db });
  const legacy = {
    invoiceNumber: legacyRow.invoiceNumber,
    merchantOrderNo: sanitizeMerchantOrderNo(session.id),
    checkoutSessionId: session.id,
  };
  if (siblings.length > 0 && legacy.invoiceNumber) {
    return {
      ...legacy,
      amount: saleAmount,
      itemDesc: sale.itemDesc || '商品銷售折讓',
      prefer: 'allowance',
      sharedInvoice: true,
      skip: false,
    };
  }
  return {
    ...legacy,
    amount: roundMoney(session.amount || saleAmount),
    itemDesc: session.itemDesc || sale.itemDesc || '合併結帳',
    prefer: 'void',
    sharedInvoice: false,
    skip: !legacy.invoiceNumber,
  };
}

/**
 * 儲值／購案／私教 Order 退費或取消：決定如何反向發票
 * 應退 ≥ 單據金額 → 作廢（連同分張）；部分 → 折讓；舊版合併發票有存活兄弟單時僅准折讓
 */
export async function resolveOrderInvoiceReverse(order, { refundCash, tx } = {}) {
  const db = tx || prisma;
  const orderAmount = roundMoney(order.amount);
  const cash = roundMoney(refundCash);
  const partial = Math.min(cash, orderAmount);
  const childRows = await issuedInvoicesOf(order.id, db);
  const childInv = childRows[0]?.invoiceNumber || null;
  const session = order.checkoutSessionId
    ? await db.checkoutSession.findUnique({ where: { id: order.checkoutSessionId } })
    : null;
  const legacyRow = !childInv && session ? await legacySharedInvoiceOf(session.id, db) : null;

  const base = {
    merchantOrderNo: sanitizeMerchantOrderNo(order.id),
    itemDesc: order.itemDesc || '訂單',
    checkoutSessionId: session?.id || null,
    sharedInvoice: false,
    skip: false,
  };

  if (!childInv && !legacyRow) {
    return { ...base, invoiceNumber: null, amount: 0, prefer: 'allowance', skip: true, skipReason: '無發票' };
  }
  if (cash <= 0) {
    return {
      ...base,
      invoiceNumber: childInv,
      amount: 0,
      prefer: 'allowance',
      skip: true,
      skipReason: '應退現金為 0，無需折讓／作廢',
    };
  }

  if (!legacyRow) {
    if (cash >= orderAmount) {
      return {
        ...base,
        invoiceNumber: childInv,
        amount: orderAmount,
        prefer: 'void',
        extraInvoiceNumbers: childRows.slice(1).map((r) => r.invoiceNumber),
      };
    }
    return { ...base, invoiceNumber: childInv, amount: partial, itemDesc: order.itemDesc || '退費折讓', prefer: 'allowance' };
  }

  const legacy = {
    ...base,
    invoiceNumber: legacyRow.invoiceNumber,
    merchantOrderNo: sanitizeMerchantOrderNo(session.id),
  };
  const siblings = await listAliveCheckoutSiblings(session, { excludeOrderId: order.id, tx: db });
  if (siblings.length > 0) {
    return { ...legacy, amount: partial, itemDesc: order.itemDesc || '退費折讓', prefer: 'allowance', sharedInvoice: true };
  }
  const sessionAmount = roundMoney(session.amount || orderAmount);
  if (cash >= orderAmount && cash >= sessionAmount) {
    return { ...legacy, amount: sessionAmount, itemDesc: session.itemDesc || order.itemDesc || '合併結帳', prefer: 'void' };
  }
  return { ...legacy, amount: partial, itemDesc: order.itemDesc || '退費折讓', prefer: 'allowance' };
}

/**
 * 執行 ezPay 反向；折讓成功時由 einvoice 寫入 InvoiceAllowance 並回傳 result.slip
 * @param {{ reason?, buyerEmail?, prefer?, staffId?,
 *   allowance?: { source: string, orderId?: string|null, saleOrderId?: string|null, memberId?: number|null } }} opts
 */
export async function executeInvoiceReverse(
  ctx,
  { reason, buyerEmail, prefer, staffId = null, allowance: allowanceContext = {} } = {},
) {
  const mode = prefer || ctx?.prefer || 'void';
  const amt = roundMoney(ctx?.amount);
  if (!ctx?.invoiceNumber || ctx.skip) {
    // 折讓且仍有應反向金額時不可略過（無發票不得「假裝成功」）
    if (mode === 'allowance' && amt > 0) {
      assertRealInvoiceForAllowance(ctx?.invoiceNumber, '退費折讓');
      const err = new Error('退費折讓須在開票成功後才能辦理（發票上下文已略過）');
      err.statusCode = 400;
      throw err;
    }
    return { action: 'none', invoiceNumber: null };
  }
  if (mode === 'allowance') {
    assertRealInvoiceForAllowance(ctx.invoiceNumber, '退費折讓');
  }
  const result = await reverseEInvoice({
    invoiceNumber: ctx.invoiceNumber,
    itemDesc: ctx.itemDesc,
    amount: ctx.amount,
    reason,
    prefer: mode,
    buyerEmail,
    staffId,
    allowanceContext,
  });
  // 全額作廢時，同單據其他分張（如免稅品）一併作廢
  if (result.action === 'void' && Array.isArray(ctx.extraInvoiceNumbers)) {
    result.extraVoided = [];
    for (const inv of ctx.extraInvoiceNumbers) {
      try {
        const r = await reverseEInvoice({ invoiceNumber: inv, prefer: 'void', reason, staffId, itemDesc: ctx.itemDesc });
        result.extraVoided.push({ invoiceNumber: inv, action: r.action });
      } catch (err) {
        console.error(`作廢分張發票 ${inv} 失敗:`, err.message);
        result.extraVoided.push({ invoiceNumber: inv, error: err.message });
      }
    }
  }
  return result;
}

/** 作廢結果之發票號清單（含同單據分張；分張失敗者標註） */
export function voidedInvoiceLabel(reverseResult) {
  const extra = (reverseResult?.extraVoided || []).map((x) =>
    x.error ? `${x.invoiceNumber}（作廢失敗，請人工處理）` : x.invoiceNumber,
  );
  return [reverseResult?.invoiceNumber, ...extra].filter(Boolean).join('、');
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
    return `${base}｜發票已作廢 ${voidedInvoiceLabel(reverseResult)}`.trim();
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
      OR: [{ itemDesc: { contains: '私教' } }, { id: { startsWith: 'GRP' } }],
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
