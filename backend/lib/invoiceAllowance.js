// lib/invoiceAllowance.js — 折讓單持久化與列印 payload
import prisma from './prisma.js';
import { splitTaxIncludedAmount, isValidTaiwanUbn } from './ezpay.js';

function generateAllowanceRecordId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `IAL${dateStr}${randomStr}`;
}

export function normalizeBuyerEmail(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().slice(0, 50);
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    const err = new Error('消費者 Email 格式無效');
    err.statusCode = 400;
    throw err;
  }
  return s;
}

export function normalizeInvoiceNumberInput(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  if (!/^[A-Z]{2}\d{8}$/.test(s)) {
    const err = new Error('發票號碼格式無效（須為 2 碼英文＋8 碼數字，如 AB12345678）');
    err.statusCode = 400;
    throw err;
  }
  return s;
}

/** 正規化分店發票抬頭統編（空＝清除；接受全形數字與夾雜符號） */
export function normalizeBranchSellerUbn(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw)
    .trim()
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/\D/g, '');
  if (!s) return null;
  if (s.length !== 8) {
    const err = new Error('發票抬頭統編須為完整 8 碼，或不填以清除');
    err.statusCode = 400;
    throw err;
  }
  if (!isValidTaiwanUbn(s)) {
    const err = new Error('發票抬頭統編檢查碼錯誤（請填真實統編；12345678 等範例數字無效）');
    err.statusCode = 400;
    throw err;
  }
  return s;
}

function envSellerFallback() {
  return {
    sellerName: (process.env.INVOICE_SELLER_NAME || process.env.SELLER_NAME || '體育客').trim(),
    sellerUbn: (process.env.INVOICE_SELLER_UBN || '').trim() || null,
    sellerAddress: null,
    merchantId: (process.env.EZPAY_MERCHANT_ID || '').trim() || null,
  };
}

/**
 * 依分店設定解析折讓單抬頭（優先分店欄位，再回退環境變數）
 */
export async function resolveInvoiceSellerHeader(branchId) {
  const fallback = envSellerFallback();
  const bid = Number(branchId);
  if (!Number.isInteger(bid) || bid <= 0) return fallback;

  const branch = await prisma.branch.findUnique({
    where: { id: bid },
    select: {
      name: true,
      address: true,
      invoiceSellerName: true,
      invoiceSellerUbn: true,
    },
  });
  if (!branch) return fallback;

  return {
    sellerName: (branch.invoiceSellerName || fallback.sellerName || branch.name || '體育客').trim(),
    sellerUbn: branch.invoiceSellerUbn || fallback.sellerUbn,
    sellerAddress: branch.address || null,
    merchantId: fallback.merchantId,
    branchId: bid,
    branchName: branch.name,
  };
}

/** 由訂單推斷分店（合併結帳 → session.branchId） */
export async function resolveBranchIdForOrder(order) {
  if (!order) return null;
  if (order.checkoutSessionId) {
    const session = await prisma.checkoutSession.findUnique({
      where: { id: order.checkoutSessionId },
      select: { branchId: true },
    });
    if (session?.branchId) return session.branchId;
  }
  return null;
}

/**
 * 由 ezPay reverse 結果組出可列印折讓單資料
 * @param {{ sellerHeader?: { sellerName, sellerUbn, sellerAddress?, merchantId? } }} opts
 */
export function buildAllowanceSlip({
  reverseResult,
  orderId,
  saleOrderId,
  memberId,
  memberName,
  itemDesc,
  buyerEmail,
  merchantOrderNo,
  amount,
  source = 'REFUND',
  staffId,
  sellerHeader,
} = {}) {
  if (!reverseResult || reverseResult.action !== 'allowance' || !reverseResult.allowanceNo) {
    return null;
  }
  const total = Number(reverseResult.allowanceAmt ?? amount) || 0;
  let untaxedAmt;
  let taxAmt;
  try {
    const split = splitTaxIncludedAmount(total);
    untaxedAmt = split.amt;
    taxAmt = split.taxAmt;
  } catch {
    untaxedAmt = Math.round(total / 1.05);
    taxAmt = total - untaxedAmt;
  }

  const fallback = envSellerFallback();
  const sellerName = (sellerHeader?.sellerName || fallback.sellerName).trim();
  const sellerUbn = sellerHeader?.sellerUbn || fallback.sellerUbn;
  const sellerAddress = sellerHeader?.sellerAddress || null;
  const merchantId = sellerHeader?.merchantId || fallback.merchantId;

  return {
    allowanceNo: reverseResult.allowanceNo,
    invoiceNumber: reverseResult.invoiceNumber,
    merchantOrderNo: reverseResult.merchantOrderNo || merchantOrderNo || null,
    orderId: orderId || null,
    saleOrderId: saleOrderId || null,
    memberId: memberId ?? null,
    memberName: memberName || null,
    itemDesc: itemDesc || null,
    untaxedAmt,
    taxAmt,
    totalAmt: total,
    remainAmt: reverseResult.remainAmt ?? null,
    buyerEmail: buyerEmail || null,
    source,
    staffId: staffId ?? null,
    sellerName,
    sellerUbn,
    sellerAddress,
    merchantId,
    issuedAt: new Date().toISOString(),
  };
}

export async function persistAllowanceSlip(slip) {
  if (!slip?.allowanceNo) return null;
  const existing = await prisma.invoiceAllowance.findUnique({
    where: { allowanceNo: slip.allowanceNo },
  });
  if (existing) return existing;

  return prisma.invoiceAllowance.create({
    data: {
      id: generateAllowanceRecordId(),
      allowanceNo: slip.allowanceNo,
      invoiceNumber: slip.invoiceNumber,
      merchantOrderNo: String(slip.merchantOrderNo || ''),
      orderId: slip.orderId || null,
      saleOrderId: slip.saleOrderId || null,
      memberId: slip.memberId ?? null,
      memberName: slip.memberName || null,
      itemDesc: slip.itemDesc ? String(slip.itemDesc).slice(0, 500) : null,
      untaxedAmt: slip.untaxedAmt,
      taxAmt: slip.taxAmt,
      totalAmt: slip.totalAmt,
      remainAmt: slip.remainAmt ?? null,
      buyerEmail: slip.buyerEmail || null,
      source: slip.source || 'REFUND',
      staffId: slip.staffId ?? null,
      sellerName: slip.sellerName || null,
      sellerUbn: slip.sellerUbn || null,
      sellerAddress: slip.sellerAddress || null,
    },
  });
}

/**
 * 組折讓單並寫入 DB，回傳可列印 payload（存檔失敗仍回傳列印資料）
 */
export async function savePrintableAllowanceSlip(opts) {
  const slip = buildAllowanceSlip(opts);
  if (!slip) return null;
  try {
    const saved = await persistAllowanceSlip(slip);
    return toPrintableAllowance({
      ...slip,
      id: saved?.id,
      createdAt: saved?.createdAt || saved?.issuedAt,
    });
  } catch (saveErr) {
    console.error('折讓單存檔失敗（仍回傳列印資料）:', saveErr.message);
    return toPrintableAllowance(slip);
  }
}

export function toPrintableAllowance(rowOrSlip) {
  if (!rowOrSlip) return null;
  const fallback = envSellerFallback();
  return {
    id: rowOrSlip.id || null,
    allowanceNo: rowOrSlip.allowanceNo,
    invoiceNumber: rowOrSlip.invoiceNumber,
    merchantOrderNo: rowOrSlip.merchantOrderNo,
    orderId: rowOrSlip.orderId || null,
    saleOrderId: rowOrSlip.saleOrderId || null,
    memberId: rowOrSlip.memberId ?? null,
    memberName: rowOrSlip.memberName || null,
    itemDesc: rowOrSlip.itemDesc || null,
    untaxedAmt: rowOrSlip.untaxedAmt,
    taxAmt: rowOrSlip.taxAmt,
    totalAmt: rowOrSlip.totalAmt,
    remainAmt: rowOrSlip.remainAmt ?? null,
    buyerEmail: rowOrSlip.buyerEmail || null,
    source: rowOrSlip.source || 'REFUND',
    issuedAt: rowOrSlip.createdAt
      ? new Date(rowOrSlip.createdAt).toISOString()
      : rowOrSlip.issuedAt || new Date().toISOString(),
    sellerName: rowOrSlip.sellerName || fallback.sellerName,
    sellerUbn: rowOrSlip.sellerUbn || fallback.sellerUbn,
    sellerAddress: rowOrSlip.sellerAddress || null,
    merchantId: rowOrSlip.merchantId || fallback.merchantId,
  };
}
