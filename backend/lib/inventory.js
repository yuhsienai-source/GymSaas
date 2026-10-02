// lib/inventory.js — 進銷存核心：分店庫存異動（唯一入口）、POS 查價、銷貨扣庫／回補、盤點、調撥
// onHand 只能經 applyStockDelta 以條件式 SQL 異動（禁止負庫存），每筆必留 StockMovement
import prisma from './prisma.js';
import { assertTracksInventory, tracksInventory } from './productKind.js';
import { normalizeTaxType } from './einvoiceRules.js';
import { assertSameLegalEntity } from './legalEntity.js';
import { issueSaleInvoice } from './einvoice.js';

function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function genId(prefix) {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `${prefix}${dateStr}${randomStr}`;
}

export const generatePurchaseId = () => genId('POH');
export const generateSaleId = () => genId('SAL');
export const generateReceiptId = () => genId('PRC');
export const generatePayableId = () => genId('APY');
export const generateSupplierPaymentId = () => genId('APM');
export const generateTransferId = () => genId('TRF');

/** 分店售價（含稅）：分店未設採主檔建議售價 */
export function effectivePrice(stock, product) {
  return stock?.salePrice ?? product?.listPrice ?? 0;
}

/**
 * 庫存異動唯一入口（須在 transaction 內）
 * 入庫帶 unitCost 時同步更新移動平均成本；出庫條件式遞減，不足 400 INSUFFICIENT_STOCK
 * @returns {{ onHand: number, avgCost: number, movement: object }}
 */
export async function applyStockDelta(
  tx,
  { branchId, productId, delta, refType, refId = null, refLineId = null, reason = null, staffId = null, unitCost = null },
) {
  const d = parseInt(delta, 10);
  if (!Number.isInteger(d)) throw httpError(400, '庫存異動數量必須為整數');
  if (d > 0) {
    await tx.branchStock.upsert({
      where: { branchId_productId: { branchId, productId } },
      create: { branchId, productId },
      update: {},
    });
  }
  const cost = unitCost != null && Number.isFinite(Number(unitCost)) ? Number(unitCost) : null;
  const rows = await tx.$queryRaw`
    UPDATE "BranchStock"
       SET "avgCost" = CASE
             WHEN ${d}::int > 0 AND ${cost}::numeric IS NOT NULL AND "onHand" + ${d}::int > 0
               THEN ("onHand" * "avgCost" + ${d}::int * ${cost}::numeric) / ("onHand" + ${d}::int)
             ELSE "avgCost" END,
           "onHand" = "onHand" + ${d}::int,
           "updatedAt" = now()
     WHERE "branchId" = ${branchId} AND "productId" = ${productId} AND "onHand" + ${d}::int >= 0
     RETURNING "onHand", "avgCost"`;
  if (!rows.length) {
    const cur = await tx.branchStock.findUnique({
      where: { branchId_productId: { branchId, productId } },
      include: { product: { select: { name: true } } },
    });
    throw httpError(
      400,
      `商品 [${cur?.product?.name || productId}] 庫存不足（剩 ${cur?.onHand ?? 0}）`,
      'INSUFFICIENT_STOCK',
    );
  }
  const { onHand, avgCost } = rows[0];
  const movement = await tx.stockMovement.create({
    data: {
      branchId,
      productId,
      qtyDelta: d,
      balanceAfter: onHand,
      unitCost: cost != null ? cost : avgCost,
      refType,
      refId,
      refLineId,
      reason: reason ? String(reason).slice(0, 200) : null,
      staffId: staffId ?? null,
    },
  });
  return { onHand, avgCost: Number(avgCost), movement };
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
    const stock = await tx.branchStock.findUnique({
      where: { branchId_productId: { branchId, productId: row.productId } },
      include: { product: true },
    });
    if (!stock || !stock.isListed || !stock.product.isActive) {
      throw httpError(400, `商品 #${row.productId} 未於此分店上架`);
    }
    const product = stock.product;
    if (tracksInventory(product) && stock.onHand < row.qty) {
      throw httpError(400, `商品 [${product.name}] 庫存不足（剩 ${stock.onHand}）`, 'INSUFFICIENT_STOCK');
    }
    const unitPrice = effectivePrice(stock, product);
    if (!Number.isInteger(unitPrice) || unitPrice < 0) {
      throw httpError(409, `商品 [${product.name}] 售價未設定`);
    }
    const lineTotal = unitPrice * row.qty;
    amount += lineTotal;
    descParts.push(`${product.name}x${row.qty}`);
    lines.push({
      productId: product.id,
      name: product.name,
      unitPrice,
      qty: row.qty,
      lineTotal,
      taxType: normalizeTaxType(product.taxType),
      productKind: tracksInventory(product) ? 'PHYSICAL' : 'SERVICE',
    });
  }

  return {
    lines,
    amount,
    itemDesc: `POS | ${descParts.join(', ')}`.slice(0, 200),
  };
}

/** 銷貨成交：實體商品扣庫＋寫銷貨成本快照（服務類略過） */
export async function deductSaleStock(tx, saleOrder, staffId = null) {
  const items = saleOrder.items || [];
  for (const item of items) {
    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product) throw httpError(404, `商品 #${item.productId} 不存在`);
    if (!tracksInventory(product)) continue;
    const stock = await tx.branchStock.findUnique({
      where: { branchId_productId: { branchId: saleOrder.branchId, productId: item.productId } },
      select: { avgCost: true },
    });
    const { movement } = await applyStockDelta(tx, {
      branchId: saleOrder.branchId,
      productId: item.productId,
      delta: -item.qty,
      refType: 'SALE',
      refId: saleOrder.id,
      refLineId: item.id ?? null,
      reason: `銷貨 ${saleOrder.id}`,
      staffId,
      unitCost: stock ? Number(stock.avgCost) : null,
    });
    if (item.id) {
      await tx.saleItem.update({ where: { id: item.id }, data: { unitCost: movement.unitCost } });
    }
  }
}

/** 取消已成交銷貨：依原成本回補（服務類略過） */
export async function restockSaleStock(tx, saleOrder, staffId = null) {
  const items = saleOrder.items || [];
  for (const item of items) {
    const product = await tx.product.findUnique({ where: { id: item.productId } });
    if (!product) throw httpError(404, `商品 #${item.productId} 不存在，無法回補`);
    if (!tracksInventory(product)) continue;
    await applyStockDelta(tx, {
      branchId: saleOrder.branchId,
      productId: item.productId,
      delta: item.qty,
      refType: 'SALE_CANCEL',
      refId: saleOrder.id,
      refLineId: item.id ?? null,
      reason: `取消銷貨回補 ${saleOrder.id}`,
      staffId,
      unitCost: item.unitCost != null ? Number(item.unitCost) : null,
    });
  }
}

/**
 * 盤點／盤損／盤盈（僅 PHYSICAL）
 * @param {'LOSS'|'GAIN'|'COUNT'} reason  LOSS 扣減 qty｜GAIN 增加 qty｜COUNT 設為實盤數 qty
 */
export async function adjustBranchStock(tx, { branchId, productId, qty, reason = 'LOSS', note = null, staffId = null }) {
  const product = await tx.product.findUnique({ where: { id: productId } });
  if (!product) throw httpError(404, `商品 #${productId} 不存在`);
  assertTracksInventory(product, '盤點／盤損');
  const stock = await tx.branchStock.findUnique({
    where: { branchId_productId: { branchId, productId } },
  });
  const previousQty = stock?.onHand ?? 0;

  const raw = String(reason || 'LOSS').toUpperCase();
  const n = parseInt(qty, 10);
  let delta;
  let refType;
  let defaultNote;
  if (raw === 'LOSS' || raw === 'OUT' || raw === 'WRITEOFF') {
    if (!Number.isInteger(n) || n <= 0) throw httpError(400, '盤損數量必須為正整數');
    delta = -n;
    refType = 'LOSS';
    defaultNote = '盤損';
  } else if (raw === 'GAIN' || raw === 'IN' || raw === 'FOUND') {
    if (!Number.isInteger(n) || n <= 0) throw httpError(400, '盤盈數量必須為正整數');
    delta = n;
    refType = 'GAIN';
    defaultNote = '盤盈';
  } else if (raw === 'COUNT' || raw === 'STOCKTAKE' || raw === 'ADJUST') {
    if (!Number.isInteger(n) || n < 0) throw httpError(400, '實盤數量必須為非負整數');
    delta = n - previousQty;
    refType = 'STOCKTAKE';
    defaultNote = `盤點校正（帳面 ${previousQty} → 實盤 ${n}）`;
  } else {
    throw httpError(400, 'reason 必須為 LOSS（盤損）、GAIN（盤盈）或 COUNT（盤點校正）');
  }

  const result = await applyStockDelta(tx, {
    branchId,
    productId,
    delta,
    refType,
    reason: note ? String(note).trim().slice(0, 200) : defaultNote,
    staffId,
    unitCost: stock ? Number(stock.avgCost) : null,
  });
  return { product, onHand: result.onHand, movement: result.movement, previousQty, reason: refType };
}

/** 同營業人分店間調撥（跨統編 409 CROSS_ENTITY_TRANSFER） */
export async function transferStock(tx, { fromBranchId, toBranchId, items, staffId = null, note = null }) {
  if (fromBranchId === toBranchId) throw httpError(400, '調出與調入分店不可相同');
  await assertSameLegalEntity(fromBranchId, toBranchId, tx);
  const transferId = generateTransferId();
  const moved = [];
  for (const row of items) {
    const productId = parseInt(row.productId, 10);
    const qty = parseInt(row.qty, 10);
    if (!Number.isInteger(productId) || !Number.isInteger(qty) || qty <= 0) {
      throw httpError(400, '調撥明細須為正整數 productId／qty');
    }
    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw httpError(404, `商品 #${productId} 不存在`);
    assertTracksInventory(product, '調撥');
    const src = await tx.branchStock.findUnique({
      where: { branchId_productId: { branchId: fromBranchId, productId } },
    });
    const cost = src ? Number(src.avgCost) : 0;
    const reason = note ? String(note).slice(0, 200) : `調撥 ${transferId}`;
    await applyStockDelta(tx, {
      branchId: fromBranchId, productId, delta: -qty, refType: 'TRANSFER_OUT', refId: transferId, reason, staffId, unitCost: cost,
    });
    await applyStockDelta(tx, {
      branchId: toBranchId, productId, delta: qty, refType: 'TRANSFER_IN', refId: transferId, reason, staffId, unitCost: cost,
    });
    moved.push({ productId, qty, unitCost: cost });
  }
  return { transferId, items: moved };
}

/**
 * 線上付款回呼：PENDING SaleOrder → PAID + 扣庫存；開票失敗留佇列（不沖回已收款）
 * @param {{ skipInvoice?: boolean }} opts 合併結帳時由 issueCheckoutInvoices 統一開票
 */
export async function fulfillCardSaleOrder(saleOrderId, merchantNo, staffId = null, cardMeta = null, opts = {}) {
  const sale = await prisma.$transaction(async (tx) => {
    const claimed = await tx.saleOrder.updateMany({
      where: { id: saleOrderId, status: 'PENDING' },
      data: {
        status: 'PAID',
        merchantNo: merchantNo || null,
        ...(cardMeta?.creditHash ? { creditHash: cardMeta.creditHash } : {}),
        ...(cardMeta?.cardInst ? { cardInst: cardMeta.cardInst } : {}),
      },
    });
    if (!claimed.count) return null;
    const updated = await tx.saleOrder.findUnique({
      where: { id: saleOrderId },
      include: { items: true, member: { select: { name: true } } },
    });
    await deductSaleStock(tx, updated, staffId);
    return updated;
  });

  if (!sale) return null;
  if (opts.skipInvoice) return { ...sale, invoiceNumber: null };

  const inv = await issueSaleInvoice(sale.id);
  return { ...sale, invoiceNumber: inv.invoiceNumber, invoiceOutcome: inv.code };
}
