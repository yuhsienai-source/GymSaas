// lib/inventory.js — 進銷存共用：編號、扣庫存、成交入帳後扣庫＋發票輔助
import prisma from './prisma.js';
import { issueInvoice } from './ezpay.js';
import { assertTracksInventory, tracksInventory } from './productKind.js';

export function generatePurchaseId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `POH${dateStr}${randomStr}`;
}

export function generateSaleId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `SAL${dateStr}${randomStr}`;
}

/**
 * 依分店查價組 POS 明細（須在 transaction 或傳 prisma 當 tx）
 * @returns {{ lines, amount, itemDesc }}
 */
export async function buildPosLines(tx, branchId, lineDraft) {
  const lines = [];
  let amount = 0;
  const descParts = [];

  for (const row of lineDraft) {
    const product = await tx.product.findUnique({ where: { id: row.productId } });
    if (!product || product.branchId !== branchId || !product.isActive) {
      const err = new Error(`商品 #${row.productId} 不可售或不屬於此分店`);
      err.statusCode = 400;
      throw err;
    }
    if (tracksInventory(product) && product.stockQty < row.qty) {
      const err = new Error(`商品 [${product.name}] 庫存不足（剩 ${product.stockQty}）`);
      err.statusCode = 400;
      throw err;
    }
    const lineTotal = product.price * row.qty;
    amount += lineTotal;
    descParts.push(`${product.name}x${row.qty}`);
    lines.push({
      productId: product.id,
      name: product.name,
      unitPrice: product.price,
      qty: row.qty,
      lineTotal,
      productKind: tracksInventory(product) ? 'PHYSICAL' : 'SERVICE',
    });
  }

  return {
    lines,
    amount,
    itemDesc: `POS | ${descParts.join(', ')}`.slice(0, 200),
  };
}

/**
 * 銷貨成交後：扣庫存 + StockMovement OUT（服務類略過）
 */
export async function deductSaleStock(tx, saleOrder, staffId = null) {
  const items = saleOrder.items || [];
  for (const item of items) {
    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product) {
      const err = new Error(`商品 #${item.productId} 不存在`);
      err.statusCode = 404;
      throw err;
    }
    if (!tracksInventory(product)) continue;

    if (product.stockQty < item.qty) {
      const err = new Error(`商品 [${product.name}] 庫存不足（剩 ${product.stockQty}）`);
      err.statusCode = 400;
      throw err;
    }
    await tx.product.update({
      where: { id: item.productId },
      data: { stockQty: { decrement: item.qty } },
    });
    await tx.stockMovement.create({
      data: {
        productId: item.productId,
        type: 'OUT',
        qty: item.qty,
        unitCost: product.cost,
        refType: 'SALE',
        refId: saleOrder.id,
        note: `銷貨 ${saleOrder.id}`,
        staffId: staffId ?? null,
      },
    });
  }
}

/**
 * 取消已成交銷貨：回補庫存 + StockMovement IN（服務類略過）
 */
export async function restockSaleStock(tx, saleOrder, staffId = null) {
  const items = saleOrder.items || [];
  for (const item of items) {
    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product) {
      const err = new Error(`商品 #${item.productId} 不存在，無法回補`);
      err.statusCode = 404;
      throw err;
    }
    if (!tracksInventory(product)) continue;

    await tx.product.update({
      where: { id: item.productId },
      data: { stockQty: { increment: item.qty } },
    });
    await tx.stockMovement.create({
      data: {
        productId: item.productId,
        type: 'IN',
        qty: item.qty,
        unitCost: product.cost,
        refType: 'SALE_CANCEL',
        refId: saleOrder.id,
        note: `取消銷貨回補 ${saleOrder.id}`,
        staffId: staffId ?? null,
      },
    });
  }
}

/**
 * 盤點／盤損／盤盈（僅 PHYSICAL）。服務類呼叫會拋錯。
 * @param {'LOSS'|'GAIN'|'COUNT'} reason
 *   LOSS  盤損：扣減 qty
 *   GAIN  盤盈：增加 qty
 *   COUNT 盤點校正：將庫存設為實盤數 qty（可為 0）
 */
export async function adjustProductStock(tx, {
  productId,
  qty,
  reason = 'LOSS',
  note = null,
  staffId = null,
  unitCost = null,
}) {
  const product = await tx.product.findUnique({ where: { id: productId } });
  if (!product) {
    const err = new Error(`商品 #${productId} 不存在`);
    err.statusCode = 404;
    throw err;
  }
  assertTracksInventory(product, '盤點／盤損');

  const rawReason = String(reason || 'LOSS').toUpperCase();
  const n = parseInt(qty, 10);

  let moveType;
  let refType;
  let nextQty;
  let moveQty;
  let defaultNote;

  if (rawReason === 'LOSS' || rawReason === 'OUT' || rawReason === 'WRITEOFF') {
    if (!Number.isInteger(n) || n <= 0) {
      const err = new Error('盤損數量必須為正整數');
      err.statusCode = 400;
      throw err;
    }
    if (product.stockQty < n) {
      const err = new Error(`商品 [${product.name}] 庫存不足（剩 ${product.stockQty}），無法盤損`);
      err.statusCode = 400;
      throw err;
    }
    moveType = 'OUT';
    refType = 'LOSS';
    nextQty = product.stockQty - n;
    moveQty = n;
    defaultNote = '盤損';
  } else if (rawReason === 'GAIN' || rawReason === 'IN' || rawReason === 'FOUND') {
    if (!Number.isInteger(n) || n <= 0) {
      const err = new Error('盤盈數量必須為正整數');
      err.statusCode = 400;
      throw err;
    }
    moveType = 'IN';
    refType = 'GAIN';
    nextQty = product.stockQty + n;
    moveQty = n;
    defaultNote = '盤盈';
  } else if (rawReason === 'COUNT' || rawReason === 'STOCKTAKE' || rawReason === 'ADJUST') {
    if (!Number.isInteger(n) || n < 0) {
      const err = new Error('實盤數量必須為非負整數');
      err.statusCode = 400;
      throw err;
    }
    moveType = 'ADJUST';
    refType = 'STOCKTAKE';
    nextQty = n;
    moveQty = Math.abs(n - product.stockQty);
    defaultNote = `盤點校正（帳面 ${product.stockQty} → 實盤 ${n}）`;
  } else {
    const err = new Error('reason 必須為 LOSS（盤損）、GAIN（盤盈）或 COUNT（盤點校正）');
    err.statusCode = 400;
    throw err;
  }

  const updated = await tx.product.update({
    where: { id: productId },
    data: { stockQty: nextQty },
  });

  const movement =
    moveQty > 0 || refType === 'STOCKTAKE'
      ? await tx.stockMovement.create({
          data: {
            productId,
            type: moveType,
            qty: moveQty > 0 ? moveQty : 0,
            unitCost: unitCost != null ? Number(unitCost) : product.cost,
            refType,
            refId: null,
            note: note ? String(note).trim().slice(0, 200) : defaultNote,
            staffId: staffId ?? null,
          },
        })
      : null;

  return { product: updated, movement, previousQty: product.stockQty, reason: refType };
}

/**
 * 嘗試開立 ezPay 發票並回寫 SaleOrder.invoiceNumber
 */
export async function tryIssueSaleInvoice(saleOrder, buyerName) {
  try {
    const invoiceResult = await issueInvoice({
      id: saleOrder.id,
      amount: saleOrder.amount,
      itemDesc: saleOrder.itemDesc,
      buyerName: buyerName || '體育客顧客',
      carrierNum: saleOrder.carrierNum || null,
      buyerUbn: saleOrder.buyerUbn || null,
      loveCode: saleOrder.loveCode || null,
    });

    if (invoiceResult.Status === 'SUCCESS') {
      const invoiceData = JSON.parse(invoiceResult.Result);
      await prisma.saleOrder.update({
        where: { id: saleOrder.id },
        data: { invoiceNumber: invoiceData.InvoiceNumber },
      });
      console.log(`🧾 銷貨 ${saleOrder.id} 發票：${invoiceData.InvoiceNumber}`);
      return invoiceData.InvoiceNumber;
    }
    console.error(`❌ 銷貨 ${saleOrder.id} 發票失敗:`, invoiceResult.Message || invoiceResult);
    return null;
  } catch (error) {
    console.error(`❌ 銷貨 ${saleOrder.id} 發票例外:`, error.message);
    return null;
  }
}

/**
 * CARD Webhook：PENDING SaleOrder → PAID + 扣庫存
 * @param {object|null} cardMeta - extractCardTradeMeta 結果
 * @param {{ skipInvoice?: boolean }} opts - 合併結帳時略過此處開票（改由軟拆 issueSplitCheckoutInvoices）
 */
export async function fulfillCardSaleOrder(
  saleOrderId,
  merchantNo,
  staffId = null,
  cardMeta = null,
  opts = {},
) {
  const skipInvoice = Boolean(opts.skipInvoice);
  const sale = await prisma.$transaction(async (tx) => {
    const current = await tx.saleOrder.findUnique({
      where: { id: saleOrderId },
      include: { items: true, member: { select: { name: true } } },
    });
    if (!current || current.status !== 'PENDING') {
      return null;
    }

    const updated = await tx.saleOrder.update({
      where: { id: saleOrderId },
      data: {
        status: 'PAID',
        merchantNo: merchantNo || null,
        ...(cardMeta?.creditHash ? { creditHash: cardMeta.creditHash } : {}),
        ...(cardMeta?.cardInst ? { cardInst: cardMeta.cardInst } : {}),
      },
      include: { items: true, member: { select: { name: true } } },
    });

    await deductSaleStock(tx, updated, staffId);
    return updated;
  });

  if (!sale) return null;

  if (skipInvoice) {
    return { ...sale, invoiceNumber: null };
  }

  const invoiceNumber = await tryIssueSaleInvoice(sale, sale.member?.name);
  return { ...sale, invoiceNumber };
}
