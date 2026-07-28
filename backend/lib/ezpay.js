// lib/ezpay.js
import crypto from 'crypto';
import querystring from 'querystring';

// 🚨 加上 .trim() 防範所有隱形空白
const HASH_KEY = (process.env.EZPAY_HASH_KEY || '').trim();
const HASH_IV = (process.env.EZPAY_HASH_IV || '').trim();
const MERCHANT_ID = (process.env.EZPAY_MERCHANT_ID || '').trim();
const INVOICE_URL = (process.env.EZPAY_INVOICE_URL || '').trim();

/** 手機條碼載具：/ + 7 碼（大寫英數與 . - +） */
const MOBILE_CARRIER_RE = /^\/[A-Z0-9.\-+]{7}$/;
/** 自然人憑證載具：2 碼大寫英文字母 + 14 碼數字 */
const CITIZEN_CARRIER_RE = /^[A-Z]{2}\d{14}$/;
/** 捐贈碼（愛心碼）：3～7 碼純數字 */
const LOVE_CODE_RE = /^\d{3,7}$/;

/** ezPay CarrierType：0=手機條碼、1=自然人憑證、2=ezPay 載具 */
export const EZPAY_CARRIER_TYPE = {
  MOBILE: '0',
  CITIZEN: '1',
};

/**
 * 正規化／驗證發票載具（手機條碼或自然人憑證）
 * @returns {string|null} 正規化後載具；空值回 null
 */
export function normalizeInvoiceCarrier(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let s = String(raw).trim().toUpperCase().replace(/\s+/g, '');

  // 掃碼槍偶發漏掉手機載具開頭 /
  if (!s.startsWith('/') && /^[A-Z0-9.\-+]{7}$/.test(s)) {
    s = `/${s}`;
  }

  if (MOBILE_CARRIER_RE.test(s) || CITIZEN_CARRIER_RE.test(s)) {
    return s;
  }

  const err = new Error(
    '載具格式無效：手機條碼為 /＋7 碼（如 /ABC+123）；自然人憑證為 2 碼大寫英文＋14 碼數字',
  );
  err.statusCode = 400;
  throw err;
}

/** @deprecated 請改用 normalizeInvoiceCarrier（已支援手機＋自然人憑證） */
export function normalizeMobileCarrier(raw) {
  return normalizeInvoiceCarrier(raw);
}

/**
 * 依載具號碼判斷 ezPay CarrierType
 * @returns {'0'|'1'|null}
 */
export function resolveCarrierType(carrierNum) {
  if (!carrierNum) return null;
  const s = String(carrierNum).trim().toUpperCase();
  if (MOBILE_CARRIER_RE.test(s)) return EZPAY_CARRIER_TYPE.MOBILE;
  if (CITIZEN_CARRIER_RE.test(s)) return EZPAY_CARRIER_TYPE.CITIZEN;
  return null;
}

/**
 * 台灣營利事業統一編號檢查碼（財政部）
 * 權重 1,2,1,2,1,2,4,1；乘積拆位加總後須被 5 整除（112 年起；相容舊號）。
 * 第 7 碼為 7 時允許 sum 或 sum+1。
 */
export function isValidTaiwanUbn(ubn) {
  if (!/^\d{8}$/.test(ubn)) return false;
  const weights = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const n = Number(ubn[i]) * weights[i];
    sum += Math.floor(n / 10) + (n % 10);
  }
  if (ubn[6] === '7') {
    return sum % 5 === 0 || (sum + 1) % 5 === 0;
  }
  return sum % 5 === 0;
}

/**
 * 正規化公司統編（8 碼）
 * @returns {string|null}
 */
export function normalizeBuyerUbn(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().replace(/\s+/g, '');
  if (!isValidTaiwanUbn(s)) {
    const err = new Error('公司統編無效（須為 8 碼數字且通過檢查碼）');
    err.statusCode = 400;
    throw err;
  }
  return s;
}

/**
 * 正規化捐贈碼（愛心碼 3～7 碼）
 * @returns {string|null}
 */
export function normalizeLoveCode(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim().replace(/\s+/g, '');
  if (!LOVE_CODE_RE.test(s)) {
    const err = new Error('捐贈碼無效（須為 3～7 碼純數字）');
    err.statusCode = 400;
    throw err;
  }
  return s;
}

/**
 * 正規化一組發票選項並檢查互斥
 * @returns {{ carrierNum: string|null, buyerUbn: string|null, loveCode: string|null }}
 */
export function normalizeInvoiceOptions({ carrierNum, buyerUbn, loveCode } = {}) {
  const carrier = normalizeInvoiceCarrier(carrierNum ?? '');
  const ubn = normalizeBuyerUbn(buyerUbn ?? '');
  const love = normalizeLoveCode(loveCode ?? '');

  if (love && carrier) {
    const err = new Error('發票捐贈與載具不可同時使用');
    err.statusCode = 400;
    throw err;
  }
  if (ubn && love) {
    const err = new Error('公司統編發票不可同時捐贈');
    err.statusCode = 400;
    throw err;
  }
  if (ubn && carrier) {
    const err = new Error('公司統編發票不可同時使用個人載具');
    err.statusCode = 400;
    throw err;
  }

  return { carrierNum: carrier, buyerUbn: ubn, loveCode: love };
}

function assertEzpayEnv() {
  if (!HASH_KEY || !HASH_IV || !MERCHANT_ID || !INVOICE_URL) {
    const err = new Error('ezPay 環境變數缺失，請檢查 .env（HASH_KEY／HASH_IV／MERCHANT_ID／INVOICE_URL）');
    err.statusCode = 500;
    throw err;
  }
}

/**
 * 由開立網址推導同主機其他 API（invoice_invalid / allowance_issue）
 * 例：…/Api/invoice_issue → …/Api/invoice_invalid
 */
export function resolveEzpayApiUrl(apiName) {
  assertEzpayEnv();
  const name = String(apiName || '').replace(/^\/+/, '');
  if (!name) {
    const err = new Error('ezPay API 名稱無效');
    err.statusCode = 500;
    throw err;
  }
  try {
    const u = new URL(INVOICE_URL);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) {
      u.pathname = `/${name}`;
    } else {
      parts[parts.length - 1] = name;
      u.pathname = `/${parts.join('/')}`;
    }
    return u.toString();
  } catch {
    const err = new Error('EZPAY_INVOICE_URL 格式無效');
    err.statusCode = 500;
    throw err;
  }
}

/**
 * 🛡️ ezPay AES-256-CBC 加密演算法
 */
function encryptData(postData) {
  const dataStr = querystring.stringify(postData);

  const cipher = crypto.createCipheriv('aes-256-cbc', HASH_KEY, HASH_IV);
  let encrypted = cipher.update(dataStr, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return encrypted;
}

/**
 * ezPay 欄位限制（INVI 手冊）：
 * - MerchantOrderNo：Varchar(20)，僅英數與 _
 * - ItemName：單項 Varchar(30)；多項以 | 分隔且須與 ItemCount 筆數一致
 * 本系統 itemDesc 常含「|」當業務快照分隔 → 開票時必須洗掉，否則 ezPay 回
 * 「請檢查商品資訊是否有對應筆數(商品名稱)」
 */
function truncateChars(str, max) {
  const chars = Array.from(String(str || ''));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('');
}

export function sanitizeMerchantOrderNo(raw) {
  const cleaned = String(raw || '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 20);
  if (!cleaned) {
    const err = new Error('發票自訂編號無效');
    err.statusCode = 500;
    throw err;
  }
  return cleaned;
}

function sanitizeItemName(raw) {
  const flat = String(raw || '商品')
    .replace(/\|/g, '／')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateChars(flat || '商品', 30);
}

function sanitizeBuyerName(raw, isB2B) {
  const name = String(raw || (isB2B ? '' : '體育客會員')).trim() || (isB2B ? '' : '體育客會員');
  return truncateChars(name, isB2B ? 60 : 30);
}

/** 作廢／折讓原因：手冊限中文 6 字或英文 20 字 */
export function sanitizeInvalidReason(raw, fallback = '交易取消') {
  const s = String(raw || fallback).trim().replace(/\s+/g, '') || fallback;
  // 含中日韓 → 以「字」計 6；否則英數 20
  if (/[\u3400-\u9FFF]/.test(s)) {
    return truncateChars(s, 6);
  }
  return truncateChars(s, 20);
}

export function splitTaxIncludedAmount(totalRaw) {
  const totalAmt = Math.round(Number(totalRaw));
  if (!Number.isFinite(totalAmt) || totalAmt <= 0) {
    const err = new Error('金額必須為正整數');
    err.statusCode = 400;
    throw err;
  }
  const amt = Math.round(totalAmt / 1.05);
  const taxAmt = totalAmt - amt;
  return { totalAmt, amt, taxAmt };
}

/**
 * 解析 ezPay JSON 回應（Result 可能是字串或物件）
 */
export function parseEzpayResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return { Status: 'ERROR', Message: 'ezPay 回應為空', Result: null, result: null };
  }
  let result = raw.Result ?? null;
  if (typeof result === 'string' && result.trim()) {
    try {
      result = JSON.parse(result);
    } catch {
      // 保留字串
    }
  }
  return {
    Status: raw.Status,
    Message: raw.Message || '',
    Result: raw.Result,
    result: result && typeof result === 'object' ? result : null,
  };
}

async function postEzpay(apiName, postData) {
  assertEzpayEnv();
  const url = resolveEzpayApiUrl(apiName);
  const encryptedData = encryptData(postData);
  const requestBody = querystring.stringify({
    MerchantID_: MERCHANT_ID,
    PostData_: encryptedData,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: requestBody,
    });

    const textResult = await response.text();
    try {
      return parseEzpayResponse(JSON.parse(textResult));
    } catch {
      console.error(`ezPay ${apiName} 回傳非 JSON:`, textResult);
      const err = new Error('ezPay 回傳格式異常');
      err.statusCode = 502;
      throw err;
    }
  } catch (error) {
    if (error.statusCode) throw error;
    console.error(`ezPay ${apiName} 呼叫失敗:`, error);
    throw error;
  }
}

function throwEzpayFailure(actionLabel, parsed) {
  const detail = parsed?.Message || parsed?.Status || '未知錯誤';
  const err = new Error(`ezPay ${actionLabel}失敗：${detail}`);
  err.statusCode = 502;
  err.ezpay = parsed;
  throw err;
}

/**
 * 🧾 開立電子發票 (B2C／B2B 即時開立)
 * orderData: carrierNum? / buyerUbn? / loveCode?（互斥規則見 normalizeInvoiceOptions）
 */
export async function issueInvoice(orderData) {
  assertEzpayEnv();

  const { totalAmt, amt, taxAmt } = splitTaxIncludedAmount(orderData.amount);

  const { carrierNum, buyerUbn, loveCode } = normalizeInvoiceOptions({
    carrierNum: orderData.carrierNum,
    buyerUbn: orderData.buyerUbn,
    loveCode: orderData.loveCode,
  });
  const carrierType = resolveCarrierType(carrierNum);
  const isB2B = Boolean(buyerUbn);

  let printFlag = 'Y';
  if (!isB2B && (carrierNum || loveCode)) {
    printFlag = 'N';
  }

  const merchantOrderNo = sanitizeMerchantOrderNo(orderData.id);
  const itemName = sanitizeItemName(orderData.itemDesc);
  const buyerName = sanitizeBuyerName(
    orderData.buyerName || (isB2B ? buyerUbn : '體育客會員'),
    isB2B,
  );

  const postData = {
    RespondType: 'JSON',
    Version: '1.4',
    TimeStamp: Math.floor(Date.now() / 1000).toString(),
    MerchantOrderNo: merchantOrderNo,
    BuyerName: buyerName || buyerUbn || '體育客會員',
    BuyerUBN: buyerUbn || '',
    BuyerEmail: orderData.buyerEmail || '',
    Category: isB2B ? 'B2B' : 'B2C',
    TaxType: '1',
    TaxRate: 5,
    Amt: amt.toString(),
    TaxAmt: taxAmt.toString(),
    TotalAmt: totalAmt.toString(),
    PrintFlag: printFlag,
    ItemName: itemName,
    ItemCount: '1',
    ItemUnit: '式',
    ItemPrice: totalAmt.toString(),
    ItemAmt: totalAmt.toString(),
    Status: '1',
  };

  if (carrierNum && carrierType) {
    postData.CarrierType = carrierType;
    postData.CarrierNum = carrierNum;
  }
  if (loveCode) {
    postData.LoveCode = loveCode;
  }

  const parsed = await postEzpay('invoice_issue', postData);
  // 維持舊呼叫端相容：回傳含原始 Result 字串的物件
  return {
    Status: parsed.Status,
    Message: parsed.Message,
    Result: typeof parsed.Result === 'string' ? parsed.Result : JSON.stringify(parsed.result || {}),
  };
}

/**
 * 作廢電子發票（當期可作廢時使用）
 * @returns {{ invoiceNumber: string, createTime?: string }}
 */
export async function voidInvoice({ invoiceNumber, reason } = {}) {
  const inv = String(invoiceNumber || '').trim().toUpperCase();
  if (!inv) {
    const err = new Error('缺少發票號碼，無法作廢');
    err.statusCode = 400;
    throw err;
  }

  const postData = {
    RespondType: 'JSON',
    Version: '1.0',
    TimeStamp: Math.floor(Date.now() / 1000).toString(),
    InvoiceNumber: inv,
    InvalidReason: sanitizeInvalidReason(reason, '交易取消'),
  };

  const parsed = await postEzpay('invoice_invalid', postData);
  if (parsed.Status !== 'SUCCESS') {
    throwEzpayFailure('作廢發票', parsed);
  }

  return {
    invoiceNumber: parsed.result?.InvoiceNumber || inv,
    createTime: parsed.result?.CreateTime || null,
    raw: parsed,
  };
}

/**
 * 開立折讓並立即確認（Status=1）
 * MerchantOrderNo 必須與開立發票時相同
 * @returns {{ allowanceNo: string, allowanceAmt: number, remainAmt: number|null, invoiceNumber: string }}
 */
export async function issueAllowance({
  invoiceNumber,
  merchantOrderNo,
  itemDesc,
  amount,
  buyerEmail,
} = {}) {
  const inv = String(invoiceNumber || '').trim().toUpperCase();
  if (!inv) {
    const err = new Error('缺少發票號碼，無法開立折讓');
    err.statusCode = 400;
    throw err;
  }

  const { totalAmt, amt, taxAmt } = splitTaxIncludedAmount(amount);
  const orderNo = sanitizeMerchantOrderNo(merchantOrderNo);
  const itemName = sanitizeItemName(itemDesc || '折讓');

  const postData = {
    RespondType: 'JSON',
    Version: '1.3',
    TimeStamp: Math.floor(Date.now() / 1000).toString(),
    InvoiceNo: inv,
    MerchantOrderNo: orderNo,
    ItemName: itemName,
    ItemCount: '1',
    ItemUnit: '式',
    // 未稅單價 + 稅額（與開立發票 TaxType=1 一致，可扣抵）
    ItemPrice: String(amt),
    ItemAmt: String(amt),
    ItemTaxAmt: String(taxAmt),
    TotalAmt: String(totalAmt),
    Status: '1',
  };
  if (buyerEmail) {
    postData.BuyerEmail = String(buyerEmail).trim().slice(0, 50);
  }

  const parsed = await postEzpay('allowance_issue', postData);
  if (parsed.Status !== 'SUCCESS') {
    throwEzpayFailure('開立折讓', parsed);
  }

  const allowanceNo = parsed.result?.AllowanceNo || null;
  if (!allowanceNo) {
    const err = new Error('ezPay 折讓成功但未回傳折讓號');
    err.statusCode = 502;
    err.ezpay = parsed;
    throw err;
  }

  return {
    allowanceNo,
    allowanceAmt: Number(parsed.result?.AllowanceAmt ?? totalAmt),
    remainAmt:
      parsed.result?.RemainAmt != null && parsed.result.RemainAmt !== ''
        ? Number(parsed.result.RemainAmt)
        : null,
    invoiceNumber: parsed.result?.InvoiceNumber || inv,
    merchantOrderNo: parsed.result?.MerchantOrderNo || orderNo,
    raw: parsed,
  };
}

/**
 * 反向處理已開立發票：
 * - prefer='void'：先作廢；失敗則改開立全額折讓
 * - prefer='allowance'：直接開立折讓（可部分金額）
 */
export async function reverseIssuedInvoice({
  invoiceNumber,
  merchantOrderNo,
  itemDesc,
  amount,
  reason,
  prefer = 'void',
  buyerEmail,
} = {}) {
  const mode = prefer === 'allowance' ? 'allowance' : 'void';
  const inv = String(invoiceNumber || '').trim();
  if (!inv) {
    return { action: 'none', invoiceNumber: null };
  }

  const email = buyerEmail ? String(buyerEmail).trim().slice(0, 50) : null;

  if (mode === 'allowance') {
    const allowance = await issueAllowance({
      invoiceNumber: inv,
      merchantOrderNo,
      itemDesc,
      amount,
      buyerEmail: email || undefined,
    });
    return {
      action: 'allowance',
      invoiceNumber: inv,
      allowanceNo: allowance.allowanceNo,
      allowanceAmt: allowance.allowanceAmt,
      remainAmt: allowance.remainAmt,
      merchantOrderNo: allowance.merchantOrderNo,
      buyerEmail: email,
      itemDesc: itemDesc || null,
      reason: sanitizeInvalidReason(reason, '退費折讓'),
    };
  }

  try {
    const voided = await voidInvoice({ invoiceNumber: inv, reason });
    return {
      action: 'void',
      invoiceNumber: voided.invoiceNumber,
      createTime: voided.createTime,
      reason: sanitizeInvalidReason(reason, '交易取消'),
    };
  } catch (voidErr) {
    console.warn(
      `ezPay 作廢 ${inv} 失敗，改開立折讓：`,
      voidErr.message,
    );
    const allowance = await issueAllowance({
      invoiceNumber: inv,
      merchantOrderNo,
      itemDesc,
      amount,
      buyerEmail: email || undefined,
    });
    return {
      action: 'allowance',
      invoiceNumber: inv,
      allowanceNo: allowance.allowanceNo,
      allowanceAmt: allowance.allowanceAmt,
      remainAmt: allowance.remainAmt,
      merchantOrderNo: allowance.merchantOrderNo,
      buyerEmail: email,
      itemDesc: itemDesc || null,
      voidError: voidErr.message,
      reason: sanitizeInvalidReason(reason, '交易取消'),
    };
  }
}
