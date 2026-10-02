// lib/ezpay.js — ezPay 電子發票傳輸層（不碰資料庫）
// 多營業人：每次呼叫必須帶入 merchant（由 lib/legalEntity.js 依營業人解析；HashKey／IV 只在 env）
import crypto from 'crypto';

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

function ezpayError(message, { statusCode = 502, code, ezpay } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  if (ezpay) {
    err.ezpay = ezpay;
    err.ezpayStatus = ezpay.Status || null;
    err.ezpayMessage = ezpay.Message || null;
  }
  return err;
}

/** 商店憑證：MerchantID、HashKey（32 bytes）、HashIV（16 bytes）、開立網址；錯誤訊息不得帶出金鑰內容 */
export function assertMerchant(merchant) {
  if (!merchant?.merchantId || !merchant?.hashKey || !merchant?.hashIv || !merchant?.invoiceUrl) {
    throw ezpayError(
      `營業人 ${merchant?.entityCode || '?'} 的 ezPay 商店未設定完整（MerchantID／EZPAY_{code}_HASH_KEY／_HASH_IV／EZPAY_INVOICE_URL）`,
      { statusCode: 503, code: 'EZPAY_MERCHANT_NOT_CONFIGURED' },
    );
  }
  if (Buffer.byteLength(merchant.hashKey, 'utf8') !== 32 || Buffer.byteLength(merchant.hashIv, 'utf8') !== 16) {
    throw ezpayError(
      `營業人 ${merchant.entityCode || '?'} 的 ezPay 金鑰長度錯誤：HashKey 須 32 字元、HashIV 須 16 字元（請檢查環境變數）`,
      { statusCode: 503, code: 'EZPAY_MERCHANT_KEY_INVALID' },
    );
  }
}

/**
 * 由開立網址推導同主機其他 API（invoice_invalid / allowance_issue）
 * 例：…/Api/invoice_issue → …/Api/invoice_invalid
 */
export function resolveEzpayApiUrl(invoiceUrl, apiName) {
  const name = String(apiName || '').replace(/^\/+/, '');
  if (!name) {
    const err = new Error('ezPay API 名稱無效');
    err.statusCode = 500;
    throw err;
  }
  try {
    const u = new URL(invoiceUrl);
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

/** ezPay 規格：PKCS7 以 32 bytes 為區塊補齊（非 OpenSSL 預設 16） */
const EZPAY_PAD_BLOCK = 32;

/** http_build_query 等價（略過 undefined／null） */
export function toEzpayQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    q.append(k, String(v));
  }
  return q.toString();
}

/**
 * PostData 加密：參數 → query string → PKCS7(32) → AES-256-CBC(HashKey, HashIV) → 小寫 hex
 * @param {{ hashKey: string, hashIv: string }} merchant
 * @param {Record<string, string|number>} postData
 */
export function encryptPostData(merchant, postData) {
  assertMerchant(merchant);
  const plain = Buffer.from(toEzpayQuery(postData), 'utf8');
  const pad = EZPAY_PAD_BLOCK - (plain.length % EZPAY_PAD_BLOCK);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(merchant.hashKey, 'utf8'),
    Buffer.from(merchant.hashIv, 'utf8'),
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])), cipher.final()]).toString('hex');
}

/** PostData 解密（對帳／測試用；ezPay 部分查詢 API 之 Result 亦為此格式） */
export function decryptPostData(merchant, hex) {
  assertMerchant(merchant);
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(merchant.hashKey, 'utf8'),
    Buffer.from(merchant.hashIv, 'utf8'),
  );
  decipher.setAutoPadding(false);
  const buf = Buffer.concat([decipher.update(String(hex || ''), 'hex'), decipher.final()]);
  const pad = buf[buf.length - 1];
  if (!pad || pad > EZPAY_PAD_BLOCK || pad > buf.length || !buf.subarray(buf.length - pad).every((b) => b === pad)) {
    throw ezpayError('ezPay 資料解密失敗（padding 無效）', { statusCode: 400, code: 'EZPAY_DECRYPT_FAILED' });
  }
  return Object.fromEntries(new URLSearchParams(buf.subarray(0, buf.length - pad).toString('utf8')));
}

const CHECK_CODE_FIELDS = ['InvoiceTransNo', 'MerchantID', 'MerchantOrderNo', 'RandomNum', 'TotalAmt'];

/** 回傳 Result 防偽碼：五欄依字母排序 → HashIV=…&{query}&HashKey=… → SHA256 大寫 */
export function computeCheckCode(merchant, result) {
  const query = CHECK_CODE_FIELDS.map((k) => `${k}=${result?.[k] ?? ''}`).join('&');
  return crypto
    .createHash('sha256')
    .update(`HashIV=${merchant.hashIv}&${query}&HashKey=${merchant.hashKey}`)
    .digest('hex')
    .toUpperCase();
}

export function verifyCheckCode(merchant, result) {
  const got = String(result?.CheckCode || '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(got)) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(computeCheckCode(merchant, result)));
}

/**
 * 組 ezPay 請求（每次帶入營業人商店，分店依營業人切換 MerchantID）
 * @returns {{ url: string, merchantId: string, body: string }}
 */
export function buildEzpayRequest(merchant, apiName, postData) {
  assertMerchant(merchant);
  return {
    url: resolveEzpayApiUrl(merchant.invoiceUrl, apiName),
    merchantId: merchant.merchantId,
    body: toEzpayQuery({ MerchantID_: merchant.merchantId, PostData_: encryptPostData(merchant, postData) }),
  };
}

function truncateChars(str, max) {
  const chars = Array.from(String(str || ''));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max).join('');
}

/** MerchantOrderNo：Varchar(20)，僅英數與 _ */
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

/** 多品項以半形「|」串接：品名／單位內之半形 | 必須轉全形，否則品項數與 ItemCount／ItemAmt 錯位 */
function escapePipe(raw) {
  return String(raw ?? '').replace(/\|/g, '｜');
}

function sanitizeItemName(raw) {
  const flat = escapePipe(raw || '商品')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateChars(flat || '商品', 30);
}

function sanitizeItemUnit(raw, fallback) {
  return truncateChars(escapePipe(raw || fallback).trim(), 2) || fallback;
}

function sanitizeBuyerName(raw, isB2B) {
  const name = String(raw || (isB2B ? '' : '體育客會員')).trim() || (isB2B ? '' : '體育客會員');
  return truncateChars(name, isB2B ? 60 : 30);
}

/** 作廢／折讓原因：手冊限中文 6 字或英文 20 字 */
export function sanitizeInvalidReason(raw, fallback = '交易取消') {
  const s = String(raw || fallback).trim().replace(/\s+/g, '') || fallback;
  if (/[\u3400-\u9FFF]/.test(s)) {
    return truncateChars(s, 6);
  }
  return truncateChars(s, 20);
}

/**
 * 解析 ezPay JSON 回應（Result 可能是字串或物件）
 */
export function parseEzpayResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return { Status: 'ERROR', Message: 'ezPay 回應為空', Result: null, result: null };
  }
  let result = raw.Result ?? null;
  let resultUnparsed = false;
  if (typeof result === 'string' && result.trim()) {
    try {
      result = JSON.parse(result);
    } catch {
      resultUnparsed = true;
    }
  }
  return {
    Status: raw.Status,
    Message: raw.Message || '',
    Result: raw.Result,
    result: result && typeof result === 'object' ? result : null,
    resultUnparsed,
  };
}

/**
 * 送出 ezPay API。錯誤碼：
 * - EZPAY_NETWORK：連線失敗／逾時（ezPay 端結果未知，重試前須先查詢）
 * - EZPAY_BAD_RESPONSE：回傳非 JSON
 */
async function postEzpay(merchant, apiName, postData) {
  const { url, body } = buildEzpayRequest(merchant, apiName, postData);
  let textResult;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000),
    });
    textResult = await response.text();
  } catch (error) {
    const cause = error?.cause;
    const hint =
      cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN'
        ? `（無法解析 ${cause.hostname || 'ezPay 主機'}，請檢查網路／DNS，或確認 EZPAY_INVOICE_URL 為 cinv 測試或 inv 正式）`
        : cause?.code === 'ECONNREFUSED' || cause?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError'
          ? '（連線 ezPay 失敗或逾時，請檢查網路或防火牆）'
          : '';
    console.error(`ezPay ${apiName} 呼叫失敗（${merchant.entityCode}）:`, error.message);
    const err = ezpayError(`ezPay 連線失敗${hint}: ${error.message}`, { code: 'EZPAY_NETWORK' });
    err.cause = cause;
    throw err;
  }
  try {
    return parseEzpayResponse(JSON.parse(textResult));
  } catch {
    console.error(`ezPay ${apiName} 回傳非 JSON（${merchant.entityCode}）`);
    throw ezpayError('ezPay 回傳格式異常', { code: 'EZPAY_BAD_RESPONSE' });
  }
}

/** ezPay 拒絕（Status ≠ SUCCESS）：訊息帶 ezPay 錯誤代碼供總部查錯 */
function throwEzpayFailure(actionLabel, parsed) {
  const detail = parsed?.Message || '未知錯誤';
  throw ezpayError(`ezPay ${actionLabel}失敗：[${parsed?.Status || '?'}] ${detail}`, {
    code: 'EZPAY_REJECTED',
    ezpay: parsed,
  });
}

/** 設定或資料錯誤，重送也不會成功（需人工修正後補開） */
export const EZPAY_NON_RETRYABLE_STATUSES = new Set([
  'KEY10002', 'KEY10004', 'KEY10006', 'KEY10010', 'KEY10011', 'KEY10013', 'KEY10015',
  'INV10003', 'INV10004', 'INV10006', 'INV10012', 'INV10013', 'INV10014', 'INV10015',
  'INV10016', 'INV10017', 'INV10019',
]);
/** 商店自訂編號重覆：可能已開立過，須查詢補登 */
export const EZPAY_DUPLICATE_ORDER_STATUS = 'LIB10003';
const EZPAY_NOT_FOUND_STATUS = 'INV20006';

function amountError(message) {
  return ezpayError(`發票金額檢核失敗：${message}`, { statusCode: 400, code: 'EINVOICE_AMOUNT_INVALID' });
}

/**
 * 組開立發票 PostData（v1.5，即時開立）。金額／明細由 lib/einvoiceRules.js 計算，此處只打包並檢核：
 * - Amt＋TaxAmt＝TotalAmt；每列 ItemAmt＝ItemCount×ItemPrice
 * - B2C 明細為含稅、合計＝TotalAmt；B2B 明細為未稅、合計＝Amt
 * - TaxType：1 應稅（TaxRate 5）、2 零稅率（帶 CustomsClearance）、3 免稅（TaxRate 0）
 * - 載具：CarrierType 0 手機條碼／1 自然人憑證，CarrierNum 依規格 rawurlencode；捐贈碼與載具互斥
 * @param {{ merchantOrderNo, category, buyerName?, buyerUbn?, buyerEmail?, carrierType?, carrierNum?, loveCode?,
 *   printFlag?, taxType, taxRate, salesAmount, taxAmount, totalAmount, customsClearance?,
 *   items: Array<{ name, qty, unit?, unitPrice, amount }> }} inv
 * @returns {Record<string, string>}
 */
export function buildIssuePostData(inv, { now = Date.now() } = {}) {
  const isB2B = inv.category === 'B2B';
  const items = inv.items || [];
  if (!items.length) throw amountError('發票明細不可為空');

  const ints = { Amt: inv.salesAmount, TaxAmt: inv.taxAmount, TotalAmt: inv.totalAmount };
  for (const [k, v] of Object.entries(ints)) {
    if (!Number.isInteger(Number(v)) || Number(v) < 0) throw amountError(`${k} 須為非負整數`);
  }
  if (Number(inv.salesAmount) + Number(inv.taxAmount) !== Number(inv.totalAmount)) {
    throw amountError(`Amt(${inv.salesAmount})＋TaxAmt(${inv.taxAmount}) ≠ TotalAmt(${inv.totalAmount})`);
  }
  let itemSum = 0;
  for (const it of items) {
    const qty = Number(it.qty);
    const price = Number(it.unitPrice);
    const amt = Number(it.amount);
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isInteger(price) || !Number.isInteger(amt)) {
      throw amountError(`品項「${it.name}」數量／單價／小計須為整數`);
    }
    if (qty * price !== amt) throw amountError(`品項「${it.name}」小計 ${amt} ≠ ${qty}×${price}`);
    itemSum += amt;
  }
  const expectedItemSum = isB2B ? Number(inv.salesAmount) : Number(inv.totalAmount);
  if (itemSum !== expectedItemSum) {
    throw amountError(`明細合計 ${itemSum} ≠ ${isB2B ? '未稅銷售額' : '發票總額'} ${expectedItemSum}`);
  }

  const taxType = String(inv.taxType || '1');
  if (!['1', '2', '3'].includes(taxType)) throw amountError(`不支援的課稅別 ${taxType}`);
  if (taxType !== '1' && Number(inv.taxAmount) !== 0) throw amountError('零稅率／免稅發票稅額須為 0');

  const postData = {
    RespondType: 'JSON',
    Version: '1.5',
    TimeStamp: String(Math.floor(now / 1000)),
    MerchantOrderNo: sanitizeMerchantOrderNo(inv.merchantOrderNo),
    Status: '1',
    Category: isB2B ? 'B2B' : 'B2C',
    BuyerName: sanitizeBuyerName(inv.buyerName || (isB2B ? inv.buyerUbn : ''), isB2B) || inv.buyerUbn || '體育客會員',
    BuyerUBN: isB2B ? inv.buyerUbn || '' : '',
    BuyerEmail: inv.buyerEmail || '',
    PrintFlag: isB2B ? 'Y' : inv.printFlag || 'Y',
    TaxType: taxType,
    TaxRate: taxType === '1' ? String(inv.taxRate ?? 5) : '0',
    Amt: String(inv.salesAmount),
    TaxAmt: String(inv.taxAmount),
    TotalAmt: String(inv.totalAmount),
    ItemName: items.map((it) => sanitizeItemName(it.name)).join('|'),
    ItemCount: items.map((it) => String(it.qty)).join('|'),
    ItemUnit: items.map((it) => sanitizeItemUnit(it.unit, '個')).join('|'),
    ItemPrice: items.map((it) => String(it.unitPrice)).join('|'),
    ItemAmt: items.map((it) => String(it.amount)).join('|'),
  };
  if (taxType === '2') postData.CustomsClearance = String(inv.customsClearance || '1');

  if (isB2B && !/^\d{8}$/.test(postData.BuyerUBN)) throw amountError('B2B 發票須有 8 碼買受人統編');
  if (!isB2B && inv.carrierNum && inv.carrierType) {
    postData.CarrierType = String(inv.carrierType);
    postData.CarrierNum = encodeURIComponent(inv.carrierNum);
    postData.PrintFlag = 'N';
  } else if (!isB2B && inv.loveCode) {
    postData.LoveCode = String(inv.loveCode);
    postData.PrintFlag = 'N';
  }
  return postData;
}

/** 驗證 ezPay 回傳之 Result 屬於本張發票（CheckCode＋自訂編號＋金額）；無 CheckCode 時回 warning */
function assertIssuedResult(merchant, r, { merchantOrderNo, totalAmount }, parsed) {
  if (String(r.MerchantOrderNo || '') !== String(merchantOrderNo) || Number(r.TotalAmt) !== Number(totalAmount)) {
    throw ezpayError(
      `ezPay 回傳之自訂編號／金額與本張發票不符（${r.MerchantOrderNo || '?'}／${r.TotalAmt ?? '?'}）`,
      { code: 'EZPAY_CHECKCODE_MISMATCH', ezpay: parsed },
    );
  }
  if (!r.CheckCode) return 'ezPay 未回傳 CheckCode，未能驗證回傳資料';
  if (!verifyCheckCode(merchant, r)) {
    throw ezpayError('ezPay 回傳 CheckCode 驗證失敗（資料可能遭竄改或金鑰不符），請至 ezPay 後台確認', {
      code: 'EZPAY_CHECKCODE_MISMATCH',
      ezpay: parsed,
    });
  }
  return null;
}

/**
 * 開立電子發票（即時開立）
 * @param {object} merchant  resolveMerchant() 結果（各營業人 MerchantID／HashKey／HashIV）
 * @param {object} inv       EInvoice 草稿（含 items）
 * @returns {{ invoiceNumber, randomNum, transNo, createTime, ezpayStatus, ezpayMessage, warning }}
 */
export async function issueInvoice(merchant, inv) {
  const postData = buildIssuePostData(inv);
  const parsed = await postEzpay(merchant, 'invoice_issue', postData);
  if (parsed.Status !== 'SUCCESS') {
    throwEzpayFailure('開立發票', parsed);
  }
  const r = parsed.result || {};
  if (!r.InvoiceNumber) {
    throw ezpayError('ezPay 開立成功但未回傳發票號碼', { code: 'EZPAY_BAD_RESPONSE', ezpay: parsed });
  }
  const warning = assertIssuedResult(
    merchant,
    r,
    { merchantOrderNo: postData.MerchantOrderNo, totalAmount: postData.TotalAmt },
    parsed,
  );
  return {
    invoiceNumber: String(r.InvoiceNumber).toUpperCase(),
    randomNum: r.RandomNum || null,
    transNo: r.InvoiceTransNo || null,
    createTime: r.CreateTime || null,
    ezpayStatus: parsed.Status,
    ezpayMessage: parsed.Message || null,
    warning,
  };
}

/**
 * invoice_search v1.3 PostData。
 * SearchType 0＝發票號碼＋隨機碼（作廢／折讓逾時後核對遠端狀態）；1＝自訂編號＋金額（開立重試防重複開票）。
 * 官方規格兩種查詢的必填欄位互斥，不得把另一種的欄位一併送出。
 */
export function buildInvoiceSearchPostData(
  { searchType = '0', merchantOrderNo, totalAmount, invoiceNumber, randomNum } = {},
  { now = Date.now() } = {},
) {
  const type = String(searchType) === '1' ? '1' : '0';
  const post = {
    RespondType: 'JSON',
    Version: '1.3',
    TimeStamp: String(Math.floor(now / 1000)),
    SearchType: type,
  };
  if (type === '1') {
    post.MerchantOrderNo = sanitizeMerchantOrderNo(merchantOrderNo);
    post.TotalAmt = String(totalAmount);
    return post;
  }
  post.InvoiceNumber = normalizeInvoiceNumber(invoiceNumber, '查詢');
  const rnd = String(randomNum || '').trim();
  if (!/^\d{4}$/.test(rnd)) {
    throw ezpayError('發票隨機碼須為 4 位數字，無法以發票號碼查詢', { statusCode: 400, code: 'INVALID_RANDOM_NUM' });
  }
  post.RandomNum = rnd;
  return post;
}

function mapInvoiceSearch(merchant, parsed, expected) {
  if (parsed.Status === EZPAY_NOT_FOUND_STATUS) return null;
  if (parsed.Status !== 'SUCCESS') throwEzpayFailure('查詢發票', parsed);
  const r = parsed.result || {};
  if (!r.InvoiceNumber) return null;
  const invoiceNumber = String(r.InvoiceNumber).toUpperCase();
  if (expected.invoiceNumber && invoiceNumber !== String(expected.invoiceNumber).trim().toUpperCase()) {
    throw ezpayError('ezPay 回傳之發票號碼與查詢條件不符', { code: 'EZPAY_CHECKCODE_MISMATCH', ezpay: parsed });
  }
  if (expected.randomNum && String(r.RandomNum || '') !== String(expected.randomNum)) {
    throw ezpayError('ezPay 回傳之隨機碼與查詢條件不符', { code: 'EZPAY_CHECKCODE_MISMATCH', ezpay: parsed });
  }
  const warning = expected.merchantOrderNo
    ? assertIssuedResult(merchant, r, { merchantOrderNo: expected.merchantOrderNo, totalAmount: expected.totalAmount }, parsed)
    : null;
  const remainRaw = r.RemainAmt;
  return {
    invoiceNumber,
    randomNum: r.RandomNum || null,
    transNo: r.InvoiceTransNo || null,
    createTime: r.CreateTime || null,
    invoiceStatus: r.InvoiceStatus != null ? String(r.InvoiceStatus) : null,
    // 官方 invoice_search 不回 RemainAmt（只在 allowance_issue）。有值才帶出，不得拿來假造折讓號。
    remainAmt: remainRaw != null && remainRaw !== '' && Number.isFinite(Number(remainRaw)) ? Number(remainRaw) : null,
    ezpayStatus: parsed.Status,
    warning,
  };
}

/**
 * 依商店自訂編號＋發票金額查詢（invoice_search v1.3, SearchType=1）
 * 用於連線逾時或自訂編號重覆時確認 ezPay 是否已開立，避免重複開票或漏記發票號
 * @returns {Promise<null | { invoiceNumber, randomNum, transNo, createTime, invoiceStatus, remainAmt, ezpayStatus, warning }>} 查無回 null
 */
export async function searchInvoiceByOrderNo(merchant, { merchantOrderNo, totalAmount }) {
  const orderNo = sanitizeMerchantOrderNo(merchantOrderNo);
  const parsed = await postEzpay(merchant, 'invoice_search', buildInvoiceSearchPostData({
    searchType: '1',
    merchantOrderNo: orderNo,
    totalAmount,
  }));
  return mapInvoiceSearch(merchant, parsed, { merchantOrderNo: orderNo, totalAmount });
}

/**
 * 依發票號碼＋隨機碼查詢（invoice_search v1.3, SearchType=0）
 * 作廢逾時後核對遠端 InvoiceStatus（1 開立、2 已作廢）。查詢失敗由呼叫端決定是否中止，此函式不吞錯。
 * @returns {Promise<null | { invoiceNumber, randomNum, transNo, createTime, invoiceStatus, remainAmt, ezpayStatus, warning }>} 查無回 null
 */
export async function searchInvoiceByNumber(merchant, { invoiceNumber, randomNum, merchantOrderNo, totalAmount } = {}) {
  const parsed = await postEzpay(
    merchant,
    'invoice_search',
    buildInvoiceSearchPostData({ searchType: '0', invoiceNumber, randomNum }),
  );
  return mapInvoiceSearch(merchant, parsed, {
    invoiceNumber,
    randomNum: String(randomNum || '').trim(),
    merchantOrderNo: merchantOrderNo || null,
    totalAmount,
  });
}

const INVOICE_NUMBER_RE = /^[A-Z]{2}\d{8}$/;

function normalizeInvoiceNumber(raw, action) {
  const inv = String(raw || '').trim().toUpperCase();
  if (!INVOICE_NUMBER_RE.test(inv)) {
    const err = new Error(`發票號碼格式錯誤（須 2 碼英文＋8 碼數字），無法${action}：${inv || '（空）'}`);
    err.statusCode = 400;
    err.code = 'INVALID_INVOICE_NUMBER';
    throw err;
  }
  return inv;
}

/**
 * 組作廢發票 PostData（invoice_invalid v1.0）
 * 原發票號欄位名為 InvoiceNumber（與 allowance_issue 之 InvoiceNo 不同，勿混用）
 */
export function buildVoidPostData({ invoiceNumber, reason } = {}, { now = Date.now() } = {}) {
  return {
    RespondType: 'JSON',
    Version: '1.0',
    TimeStamp: String(Math.floor(now / 1000)),
    InvoiceNumber: normalizeInvoiceNumber(invoiceNumber, '作廢'),
    InvalidReason: sanitizeInvalidReason(reason, '交易取消'),
  };
}

/**
 * 作廢電子發票（當期可作廢時使用）
 */
export async function voidInvoice(merchant, { invoiceNumber, reason } = {}) {
  const postData = buildVoidPostData({ invoiceNumber, reason });
  const inv = postData.InvoiceNumber;

  const parsed = await postEzpay(merchant, 'invoice_invalid', postData);
  if (parsed.Status !== 'SUCCESS') {
    throwEzpayFailure('作廢發票', parsed);
  }

  return {
    invoiceNumber: parsed.result?.InvoiceNumber || inv,
    createTime: parsed.result?.CreateTime || null,
  };
}

/**
 * 組開立折讓 PostData（allowance_issue v1.3，Status=1 立即確認）；MerchantOrderNo 必須與開立發票時相同
 * - 原發票號欄位名為 InvoiceNo（與 invoice_invalid 之 InvoiceNumber 不同，勿混用）
 * - ItemPrice／ItemAmt 為未稅、ItemTaxAmt 為該列營業稅；每列 ItemAmt＝ItemCount×ItemPrice，
 *   Σ(ItemAmt＋ItemTaxAmt) 必須等於 TotalAmt（含稅折讓總額），否則 400 EINVOICE_AMOUNT_INVALID
 * - 免稅發票（taxType 3）每列稅額必須為 0
 * items 未帶時以單一品項「式」送出（untaxed／tax）
 * @param {{ invoiceNumber, merchantOrderNo, itemDesc?, untaxed?, tax?, total, taxType?, buyerEmail?,
 *   items?: Array<{ name, qty, unit?, unitPrice, amount, taxAmt }> }} input
 * @returns {Record<string, string>}
 */
export function buildAllowancePostData(
  { invoiceNumber, merchantOrderNo, itemDesc, untaxed, tax, total, taxType = '1', buyerEmail, items = null } = {},
  { now = Date.now() } = {},
) {
  const inv = normalizeInvoiceNumber(invoiceNumber, '開立折讓');
  const orderNo = sanitizeMerchantOrderNo(merchantOrderNo);
  const taxFree = String(taxType) === '3';
  const rows = items?.length
    ? items
    : [{ name: itemDesc || '折讓', qty: 1, unit: '式', unitPrice: untaxed, amount: untaxed, taxAmt: tax }];

  const totalAmt = Number(total);
  if (!Number.isInteger(totalAmt) || totalAmt <= 0) throw amountError(`折讓總額 ${total} 須為正整數`);
  let sumAmt = 0;
  let sumTax = 0;
  for (const r of rows) {
    const qty = Number(r.qty);
    const price = Number(r.unitPrice);
    const amt = Number(r.amount);
    const taxAmt = Number(r.taxAmt ?? 0);
    const label = r.name || '折讓';
    if (![qty, price, amt, taxAmt].every(Number.isInteger) || qty <= 0 || price < 0 || amt < 0 || taxAmt < 0) {
      throw amountError(`折讓品項「${label}」數量／未稅單價／未稅小計／稅額須為非負整數`);
    }
    if (qty * price !== amt) throw amountError(`折讓品項「${label}」未稅小計 ${amt} ≠ ${qty}×${price}`);
    if (taxFree && taxAmt !== 0) throw amountError(`免稅發票折讓品項「${label}」稅額須為 0`);
    sumAmt += amt;
    sumTax += taxAmt;
  }
  if (sumAmt + sumTax !== totalAmt) {
    throw amountError(`折讓明細未稅 ${sumAmt}＋稅額 ${sumTax} ≠ 折讓總額 ${totalAmt}`);
  }

  const join = (fn) => rows.map(fn).join('|');
  const postData = {
    RespondType: 'JSON',
    Version: '1.3',
    TimeStamp: String(Math.floor(now / 1000)),
    InvoiceNo: inv,
    MerchantOrderNo: orderNo,
    ItemName: join((r) => sanitizeItemName(r.name || '折讓')),
    ItemCount: join((r) => String(Number(r.qty))),
    ItemUnit: join((r) => sanitizeItemUnit(r.unit, '式')),
    ItemPrice: join((r) => String(Number(r.unitPrice))),
    ItemAmt: join((r) => String(Number(r.amount))),
    ItemTaxAmt: join((r) => String(Number(r.taxAmt ?? 0))),
    TotalAmt: String(totalAmt),
    Status: '1',
  };
  if (buyerEmail) {
    postData.BuyerEmail = String(buyerEmail).trim().slice(0, 50);
  }
  return postData;
}

/**
 * 開立折讓（allowance_issue v1.3）；PostData 由 buildAllowancePostData 打包並檢核
 * ezPay 回 SUCCESS 但 Result 無法解析／缺折讓號時標 EZPAY_BAD_RESPONSE（結果不明，呼叫端不得視為確定失敗）
 */
export async function issueAllowance(merchant, input = {}) {
  const postData = buildAllowancePostData(input);
  const inv = postData.InvoiceNo;
  const orderNo = postData.MerchantOrderNo;
  const total = Number(postData.TotalAmt);

  const parsed = await postEzpay(merchant, 'allowance_issue', postData);
  if (parsed.Status !== 'SUCCESS') {
    throwEzpayFailure('開立折讓', parsed);
  }

  const allowanceNo = parsed.result?.AllowanceNo || null;
  if (!allowanceNo) {
    throw ezpayError(
      parsed.resultUnparsed
        ? 'ezPay 折讓回應 Result 無法解析，請至 ezPay 後台確認是否已開立'
        : 'ezPay 折讓成功但未回傳折讓號，請至 ezPay 後台確認是否已開立',
      { code: 'EZPAY_BAD_RESPONSE', ezpay: parsed },
    );
  }

  return {
    allowanceNo,
    allowanceAmt: Number(parsed.result?.AllowanceAmt ?? total),
    remainAmt:
      parsed.result?.RemainAmt != null && parsed.result.RemainAmt !== ''
        ? Number(parsed.result.RemainAmt)
        : null,
    invoiceNumber: parsed.result?.InvoiceNumber || inv,
    merchantOrderNo: parsed.result?.MerchantOrderNo || orderNo,
  };
}
