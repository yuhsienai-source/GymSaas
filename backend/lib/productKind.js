// lib/productKind.js — 實體商品 vs 服務類（不控庫存）

export const PRODUCT_KIND_PHYSICAL = 'PHYSICAL';
export const PRODUCT_KIND_SERVICE = 'SERVICE';

export function normalizeProductKind(value, { fallback = PRODUCT_KIND_PHYSICAL } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toUpperCase();
  if (v === PRODUCT_KIND_SERVICE || v === 'NON_INVENTORY' || v === 'SERVICE_ONLY') {
    return PRODUCT_KIND_SERVICE;
  }
  if (v === PRODUCT_KIND_PHYSICAL || v === 'INVENTORY' || v === 'GOODS') {
    return PRODUCT_KIND_PHYSICAL;
  }
  const err = new Error('productKind 必須為 PHYSICAL（實體）或 SERVICE（服務類／不控庫存）');
  err.statusCode = 400;
  throw err;
}

/** 是否控管庫存（進貨／盤點／安全庫存預警／銷售扣庫） */
export function tracksInventory(productOrKind) {
  const kind =
    typeof productOrKind === 'string'
      ? normalizeProductKind(productOrKind)
      : normalizeProductKind(productOrKind?.productKind);
  return kind === PRODUCT_KIND_PHYSICAL;
}

export function assertTracksInventory(product, actionLabel = '此操作') {
  if (!tracksInventory(product)) {
    const err = new Error(
      `服務類商品 [${product?.name || product?.id || ''}] 不控管庫存，無法${actionLabel}`,
    );
    err.statusCode = 400;
    throw err;
  }
}

/**
 * 解析安全庫存：SERVICE 一律 null；PHYSICAL 可為 null（關閉預警）或非負整數
 */
export function resolveSafetyStock(raw, productKind) {
  if (!tracksInventory(productKind)) {
    if (raw !== undefined && raw !== null && raw !== '') {
      const err = new Error('服務類商品不可設定安全庫存');
      err.statusCode = 400;
      throw err;
    }
    return null;
  }
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    const err = new Error('safetyStock 必須為非負整數，或留空關閉預警');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

/** @param {{ onHand, safetyStock }} stock BranchStock；@param product 商品主檔 */
export function isLowStock(stock, product) {
  if (!tracksInventory(product)) return false;
  if (stock?.safetyStock == null) return false;
  return Number(stock.onHand) <= Number(stock.safetyStock);
}
