// lib/legalEntity.js — 營業人（獨立統編／ezPay 商店）解析與憑證組裝
// 憑證只讀 env：EZPAY_{CODE}_HASH_KEY／EZPAY_{CODE}_HASH_IV（MerchantID 存 DB，可被 EZPAY_{CODE}_MERCHANT_ID 覆寫）
// 相容：營業人 MerchantID 等於舊 EZPAY_MERCHANT_ID 時，可沿用 EZPAY_HASH_KEY／EZPAY_HASH_IV
import prisma from './prisma.js';
import { isValidTaiwanUbn } from './ezpay.js';

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const env = (k) => (process.env[k] || '').trim();

export function normalizeEntityCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(s)) {
    throw httpError(400, 'LEGAL_ENTITY_CODE_INVALID', '營業人代碼須為 2～10 碼大寫英數（英文開頭），用於 env 前綴');
  }
  return s;
}

/**
 * 組 ezPay 憑證（不回傳給前端）
 * @returns {{ merchantId, hashKey, hashIv, invoiceUrl, entityCode, entityId }}
 */
export function resolveMerchant(entity) {
  const code = String(entity?.code || '').toUpperCase();
  const merchantId = env(`EZPAY_${code}_MERCHANT_ID`) || entity?.ezpayMerchantId || '';
  let hashKey = env(`EZPAY_${code}_HASH_KEY`);
  let hashIv = env(`EZPAY_${code}_HASH_IV`);
  const legacyMerchant = env('EZPAY_MERCHANT_ID');
  if ((!hashKey || !hashIv) && merchantId && legacyMerchant && merchantId === legacyMerchant) {
    hashKey = env('EZPAY_HASH_KEY');
    hashIv = env('EZPAY_HASH_IV');
  }
  return {
    merchantId,
    hashKey,
    hashIv,
    invoiceUrl: env(`EZPAY_${code}_INVOICE_URL`) || env('EZPAY_INVOICE_URL'),
    entityCode: code,
    entityId: entity?.id ?? null,
  };
}

/** 供 HQ 顯示：只回傳是否設定完整與缺漏項名稱，禁止回傳密鑰 */
export function merchantStatus(entity) {
  const m = resolveMerchant(entity);
  const missing = [];
  if (!m.merchantId) missing.push('MerchantID');
  if (!m.hashKey) missing.push(`EZPAY_${m.entityCode}_HASH_KEY`);
  if (!m.hashIv) missing.push(`EZPAY_${m.entityCode}_HASH_IV`);
  if (!m.invoiceUrl) missing.push('EZPAY_INVOICE_URL');
  return { configured: missing.length === 0, missing, merchantId: m.merchantId || null };
}

/**
 * 分店 → 營業人（提供服務／出貨之分店決定開立營業人）
 * @returns {Promise<object>} LegalEntity
 */
export async function resolveBranchLegalEntity(branchId, db = prisma) {
  const bid = Number(branchId);
  if (!Number.isInteger(bid) || bid <= 0) {
    throw httpError(409, 'LEGAL_ENTITY_REQUIRED', '無法判定提供服務分店，不能決定發票開立營業人');
  }
  const branch = await db.branch.findUnique({
    where: { id: bid },
    select: { id: true, name: true, legalEntity: true },
  });
  if (!branch?.legalEntity) {
    throw httpError(409, 'LEGAL_ENTITY_REQUIRED', `分店「${branch?.name || bid}」尚未綁定營業人（統編），請總部設定`);
  }
  if (!branch.legalEntity.isActive) {
    throw httpError(409, 'LEGAL_ENTITY_INACTIVE', `營業人「${branch.legalEntity.name}」已停用`);
  }
  return branch.legalEntity;
}

/** 庫存調撥／跨店單據：兩店必須同一營業人（跨統編須走進銷貨，本期禁止） */
export async function assertSameLegalEntity(fromBranchId, toBranchId, db = prisma) {
  const [a, b] = await Promise.all([
    db.branch.findUnique({ where: { id: Number(fromBranchId) }, select: { name: true, legalEntityId: true } }),
    db.branch.findUnique({ where: { id: Number(toBranchId) }, select: { name: true, legalEntityId: true } }),
  ]);
  if (!a || !b) throw httpError(404, 'BRANCH_NOT_FOUND', '分店不存在');
  if (!a.legalEntityId || a.legalEntityId !== b.legalEntityId) {
    throw httpError(
      409,
      'CROSS_ENTITY_TRANSFER',
      `「${a.name}」與「${b.name}」屬不同營業人（統編），禁止直接調撥庫存`,
    );
  }
  return a.legalEntityId;
}

/** 折讓單／列印抬頭 */
export function sellerHeaderOf(entity) {
  if (!entity) return null;
  return {
    sellerName: entity.name,
    sellerUbn: entity.ubn,
    sellerAddress: entity.address || null,
    merchantId: entity.ezpayMerchantId || null,
  };
}

/** HQ 建立／修改營業人；只收非機密欄位（HashKey／IV 一律放 env） */
export function normalizeLegalEntityInput(body = {}, { partial = false } = {}) {
  const allowed = ['code', 'name', 'ubn', 'address', 'phone', 'ezpayMerchantId', 'isActive'];
  const illegal = Object.keys(body).filter((k) => !allowed.includes(k));
  if (illegal.length) {
    throw httpError(400, 'ILLEGAL_FIELDS', `⛔ 非法參數：${illegal.join(', ')}（ezPay HashKey／IV 只能設定於後端環境變數）`);
  }
  const data = {};
  if (!partial || body.code !== undefined) data.code = normalizeEntityCode(body.code);
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'LEGAL_ENTITY_NAME_REQUIRED', '營業人名稱必填');
    data.name = name.slice(0, 60);
  }
  if (!partial || body.ubn !== undefined) {
    const ubn = String(body.ubn || '').replace(/\D/g, '');
    if (!isValidTaiwanUbn(ubn)) throw httpError(400, 'UBN_INVALID', '統一編號格式或檢查碼錯誤');
    data.ubn = ubn;
  }
  for (const k of ['address', 'phone']) {
    if (body[k] !== undefined) data[k] = String(body[k] || '').trim().slice(0, 120) || null;
  }
  if (body.ezpayMerchantId !== undefined) {
    const mid = String(body.ezpayMerchantId || '').trim();
    if (mid && !/^[A-Za-z0-9]{6,20}$/.test(mid)) throw httpError(400, 'MERCHANT_ID_INVALID', 'ezPay MerchantID 格式無效');
    data.ezpayMerchantId = mid || null;
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') throw httpError(400, 'IS_ACTIVE_INVALID', 'isActive 必須為 boolean');
    data.isActive = body.isActive;
  }
  return data;
}

/** 分店改綁營業人：仍有庫存不得改（庫存屬原營業人資產，須先盤點歸零或調出） */
export async function assertBranchEntityChangeAllowed(branchId, nextEntityId, db = prisma) {
  const branch = await db.branch.findUnique({ where: { id: branchId }, select: { legalEntityId: true } });
  if (!branch || branch.legalEntityId === nextEntityId || !branch.legalEntityId) return;
  const agg = await db.branchStock.aggregate({ where: { branchId, onHand: { not: 0 } }, _count: { _all: true } });
  if (agg._count._all > 0) {
    throw httpError(409, 'BRANCH_HAS_STOCK', '此分店仍有庫存，不可改綁營業人（請先盤點歸零）');
  }
}

/** 公開給前端的營業人欄位（不含任何憑證） */
export function serializeLegalEntity(entity, extra = {}) {
  if (!entity) return null;
  return {
    id: entity.id,
    code: entity.code,
    name: entity.name,
    ubn: entity.ubn,
    address: entity.address || null,
    phone: entity.phone || null,
    ezpayMerchantId: entity.ezpayMerchantId || null,
    isActive: entity.isActive,
    ezpay: merchantStatus(entity),
    ...extra,
  };
}
