// lib/productCatalog.js — 商品主檔（全公司共用 SKU）與分店上架設定；庫存數量只能經 inventory.applyStockDelta 異動
import prisma from './prisma.js';
import { normalizeProductKind, resolveSafetyStock, tracksInventory, isLowStock } from './productKind.js';
import { normalizeTaxType } from './einvoiceRules.js';
import { effectivePrice } from './inventory.js';

function httpError(statusCode, message, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

const PRODUCT_FIELDS = ['sku', 'barcode', 'name', 'invoiceName', 'unit', 'productKind', 'taxType', 'listPrice', 'isActive'];
const FORBIDDEN_STOCK_FIELDS = ['onHand', 'stockQty', 'avgCost', 'cost', 'branchId'];

function nonNegInt(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw httpError(400, `${label} 必須為非負整數（元）`);
  return n;
}

/** 主檔輸入正規化；禁止夾帶庫存／成本（成本由驗收移動平均產生） */
export function normalizeProductInput(body = {}, { partial = false } = {}) {
  const forbidden = FORBIDDEN_STOCK_FIELDS.filter((k) => body[k] !== undefined);
  if (forbidden.length) {
    throw httpError(400, `⛔ 禁止直接指定 ${forbidden.join('、')}：庫存走進貨／盤點，成本由驗收移動平均計算`);
  }
  const illegal = Object.keys(body).filter((k) => !PRODUCT_FIELDS.includes(k));
  if (illegal.length) throw httpError(400, `⛔ 非法參數：${illegal.join(', ')}`);

  const data = {};
  if (!partial || body.sku !== undefined) {
    const sku = String(body.sku || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(sku)) throw httpError(400, 'SKU 須為 2～40 碼英數（可含 - _）');
    data.sku = sku;
  }
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, '商品名稱必填');
    data.name = name.slice(0, 100);
  }
  if (body.barcode !== undefined) {
    const bc = String(body.barcode || '').replace(/\s/g, '');
    if (bc && !/^[0-9A-Za-z-]{4,32}$/.test(bc)) throw httpError(400, '條碼格式無效');
    data.barcode = bc || null;
  }
  if (body.invoiceName !== undefined) {
    data.invoiceName = String(body.invoiceName || '').trim().slice(0, 30) || null;
  }
  if (body.unit !== undefined) data.unit = String(body.unit || '').trim().slice(0, 6) || '個';
  if (!partial || body.productKind !== undefined) data.productKind = normalizeProductKind(body.productKind);
  if (!partial || body.taxType !== undefined) data.taxType = normalizeTaxType(body.taxType);
  if (!partial || body.listPrice !== undefined) data.listPrice = nonNegInt(body.listPrice ?? 0, 'listPrice');
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw httpError(400, 'isActive 必須為 boolean');
    data.isActive = body.isActive;
  }
  return data;
}

export async function createProduct(body) {
  const data = normalizeProductInput(body);
  return prisma.product.create({ data });
}

export async function updateProduct(id, body) {
  const data = normalizeProductInput(body, { partial: true });
  if (!Object.keys(data).length) throw httpError(400, '沒有可更新的欄位');
  return prisma.$transaction(async (tx) => {
    const current = await tx.product.findUnique({ where: { id } });
    if (!current) throw httpError(404, '找不到此商品');
    if (data.productKind && data.productKind !== current.productKind) {
      const agg = await tx.branchStock.aggregate({ where: { productId: id }, _sum: { onHand: true } });
      if ((agg._sum.onHand || 0) !== 0) {
        throw httpError(409, '仍有分店庫存，不可變更商品類型（請先盤點歸零）', 'PRODUCT_HAS_STOCK');
      }
      if (!tracksInventory(data.productKind)) {
        await tx.branchStock.updateMany({ where: { productId: id }, data: { safetyStock: null } });
      }
    }
    return tx.product.update({ where: { id }, data });
  });
}

/**
 * 分店上架設定（售價／安全庫存／上架）；首次設定即建立 BranchStock（onHand 0）
 * 禁止調整 onHand
 */
export async function upsertBranchStockSettings({ branchId, productId, salePrice, safetyStock, isListed }) {
  const [branch, product] = await Promise.all([
    prisma.branch.findUnique({ where: { id: branchId }, select: { id: true, isActive: true } }),
    prisma.product.findUnique({ where: { id: productId } }),
  ]);
  if (!branch?.isActive) throw httpError(404, '分店不存在或已停用');
  if (!product) throw httpError(404, '商品不存在');
  const data = {};
  if (salePrice !== undefined) data.salePrice = salePrice === null || salePrice === '' ? null : nonNegInt(salePrice, 'salePrice');
  if (safetyStock !== undefined) data.safetyStock = resolveSafetyStock(safetyStock, product.productKind);
  if (isListed !== undefined) {
    if (typeof isListed !== 'boolean') throw httpError(400, 'isListed 必須為 boolean');
    data.isListed = isListed;
  }
  if (!Object.keys(data).length) throw httpError(400, '沒有可更新的欄位');
  const row = await prisma.branchStock.upsert({
    where: { branchId_productId: { branchId, productId } },
    create: { branchId, productId, ...data },
    update: data,
    include: { product: true, branch: { select: { id: true, name: true, code: true } } },
  });
  return serializeStock(row);
}

/** 分店庫存列（avgCost 僅供 DUTY+／HQ 檢視；不含任何金流資料） */
export function serializeStock(row) {
  const p = row.product;
  return {
    id: row.id,
    branchId: row.branchId,
    branch: row.branch || null,
    productId: row.productId,
    sku: p?.sku,
    barcode: p?.barcode || null,
    name: p?.name,
    unit: p?.unit,
    productKind: p?.productKind,
    taxType: p?.taxType,
    listPrice: p?.listPrice ?? 0,
    salePrice: row.salePrice,
    price: effectivePrice(row, p),
    onHand: row.onHand,
    avgCost: Number(row.avgCost),
    stockValue: Math.round(row.onHand * Number(row.avgCost)),
    safetyStock: row.safetyStock,
    lowStock: isLowStock(row, p),
    isListed: row.isListed,
    productActive: p?.isActive ?? true,
    updatedAt: row.updatedAt,
  };
}

export async function listBranchStocks({ branchIds = null, branchId = null, productId = null, q = '' } = {}) {
  const term = String(q || '').trim();
  const rows = await prisma.branchStock.findMany({
    where: {
      ...(branchId ? { branchId } : Array.isArray(branchIds) ? { branchId: { in: branchIds } } : {}),
      ...(productId ? { productId } : {}),
      ...(term
        ? {
            product: {
              OR: [
                { sku: { contains: term, mode: 'insensitive' } },
                { name: { contains: term, mode: 'insensitive' } },
                { barcode: { contains: term } },
              ],
            },
          }
        : {}),
    },
    include: { product: true, branch: { select: { id: true, name: true, code: true } } },
    orderBy: [{ branchId: 'asc' }, { productId: 'asc' }],
  });
  return rows.map(serializeStock);
}

export async function listProducts({ q = '', includeInactive = true } = {}) {
  const term = String(q || '').trim();
  const rows = await prisma.product.findMany({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      ...(term
        ? {
            OR: [
              { sku: { contains: term, mode: 'insensitive' } },
              { name: { contains: term, mode: 'insensitive' } },
              { barcode: { contains: term } },
            ],
          }
        : {}),
    },
    include: { stocks: { select: { branchId: true, onHand: true, isListed: true } } },
    orderBy: { id: 'asc' },
  });
  return rows.map(({ stocks, ...p }) => ({
    ...p,
    totalOnHand: stocks.reduce((s, x) => s + x.onHand, 0),
    listedBranchIds: stocks.filter((x) => x.isListed).map((x) => x.branchId),
  }));
}
