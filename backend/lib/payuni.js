// lib/payuni.js
import crypto from 'crypto';
import querystring from 'querystring'; // 官方指定的轉碼模組

const HASH_KEY = (process.env.PAYUNI_HASH_KEY || '').trim();
// 🚨 官方明訂：IV 必須是 Buffer 格式
const HASH_IV = Buffer.from((process.env.PAYUNI_HASH_IV || '').trim()); 
const MERCHANT_ID = (process.env.PAYUNI_MERCHANT_ID || '').trim();

/** 統一金流常見信用卡分期期數（須於商店後台開通） */
export const CARD_INSTALLMENT_OPTIONS = [3, 6, 9, 12, 18, 24, 30];

export const CARD_MODES = ['LUMP', 'INSTALLMENT', 'RECURRING'];

/**
 * 🛡️ PayUNi AES-256-GCM 加密演算法 (最新官方標準)
 */
function encrypt(plaintext, key, iv) {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let cipherText = cipher.update(plaintext, "utf8", "base64");
  cipherText += cipher.final("base64");

  const tag = cipher.getAuthTag().toString("base64");
  return Buffer.from(`${cipherText}:::${tag}`).toString("hex").trim();
}

/**
 * 🔐 PayUNi SHA256 雜湊演算法
 */
function sha256(encryptStr, key, iv) {
  // 注意：這裡模板字串會自動把 Buffer(iv) 轉回普通字串，與官方邏輯一致
  const hash = crypto.createHash("sha256").update(`${key}${encryptStr}${iv}`);
  return hash.digest("hex").toUpperCase();
}

/**
 * 🔓 PayUNi AES-256-GCM 解密演算法
 */
export function decryptInfo(encryptStr) {
  try {
    const [encryptData, tag] = Buffer.from(encryptStr, "hex").toString().split(":::");

    const decipher = crypto.createDecipheriv("aes-256-gcm", HASH_KEY, HASH_IV);
    decipher.setAuthTag(Buffer.from(tag, "base64"));

    let decipherText = decipher.update(encryptData, "base64", "utf8");
    decipherText += decipher.final("utf8");

    // 解密出來是 a=1&b=2 格式，直接用 querystring 轉回物件
    return querystring.parse(decipherText);
  } catch (error) {
    console.error("PayUNi 解密失敗:", error);
    throw new Error("解密失敗", { cause: error });
  }
}

export const PAYUNI_UPP_URL = 'https://sandbox-api.payuni.com.tw/api/upp';

/** 測試／正式 API 根網址 */
export function getPayuniApiBase() {
  const explicit = (process.env.PAYUNI_API_BASE || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const mode = String(process.env.PAYUNI_TEST_MODE ?? 'true').toLowerCase();
  if (mode === 'false' || mode === '0' || mode === 'prod' || mode === 'production') {
    return 'https://api.payuni.com.tw';
  }
  return 'https://sandbox-api.payuni.com.tw';
}

export function getPayuniUppUrl() {
  return (process.env.PAYUNI_UPP_URL || '').trim() || `${getPayuniApiBase()}/api/upp`;
}

/**
 * 續期收款（定期定額）幕前支付頁
 * 例：https://sandbox-api.payuni.com.tw/api/period/{MerID}/{Hash}
 * Hash 由商店後台「續期收款」串接資訊提供（PAYUNI_PERIOD_HASH 或完整 PAYUNI_PERIOD_URL）
 */
export function getPayuniPeriodPayUrl() {
  const full = (process.env.PAYUNI_PERIOD_URL || '').trim().replace(/\/$/, '');
  if (full) return full;
  const hash = (process.env.PAYUNI_PERIOD_HASH || '').trim();
  if (!hash) {
    const err = new Error(
      '定期定額（續期收款）未設定：請在 .env 填 PAYUNI_PERIOD_HASH 或 PAYUNI_PERIOD_URL',
    );
    err.statusCode = 500;
    throw err;
  }
  if (!MERCHANT_ID) {
    const err = new Error('PAYUNI_MERCHANT_ID 未設定');
    err.statusCode = 500;
    throw err;
  }
  return `${getPayuniApiBase()}/api/period/${MERCHANT_ID}/${hash}`;
}

function stripEnvUrl(raw) {
  return String(raw || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\/$/, '');
}

function isLoopbackBase(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return /localhost|127\.0\.0\.1/i.test(String(url || ''));
  }
}

/**
 * PayUNi Return／Notify 必須是「外網可達」的 HTTPS／公網位址。
 * 若 API_PUBLIC_URL 為 localhost，改走 FRONTEND_URL（Vite proxy `/api` → :8000）。
 */
export function getPayuniCallbackBaseUrl() {
  const api = stripEnvUrl(process.env.API_PUBLIC_URL || process.env.BASE_URL || '');
  if (!api) {
    const err = new Error('API_PUBLIC_URL（或 BASE_URL）未設定：無法組 PayUNi ReturnURL／NotifyURL');
    err.statusCode = 500;
    throw err;
  }
  if (!isLoopbackBase(api)) return api;

  const fe = stripEnvUrl(process.env.FRONTEND_URL || '');
  if (fe && !isLoopbackBase(fe)) {
    console.warn(
      `[PayUNi] API_PUBLIC_URL 為本機（${api}），Return/Notify 改走 FRONTEND_URL=${fe}（需 Vite proxy /api → 後端）`,
    );
    return fe;
  }

  const err = new Error(
    'PayUNi 無法回呼 localhost，所以不會自動跳回系統。請將 API_PUBLIC_URL 設成公網 HTTPS（ngrok 打到 :8000），或把 FRONTEND_URL 設成公網前端並確認 Vite 有 proxy /api',
  );
  err.statusCode = 500;
  throw err;
}

/**
 * NotifyURL：PayUNi 伺服器背景通知，必須公網可達。
 * ReturnURL：使用者瀏覽器回流，優先走 FRONTEND_URL（本機或 Vite／ngrok + /api proxy）。
 */
export function getPayuniNotifyBaseUrl() {
  return getPayuniCallbackBaseUrl();
}

export function getPayuniReturnBaseUrl() {
  const fe = stripEnvUrl(process.env.FRONTEND_URL || '');
  if (fe) return fe;
  return getPayuniCallbackBaseUrl();
}

/** @deprecated 請改用 getPayuniNotifyBaseUrl / getPayuniReturnBaseUrl */
function getApiPublicBaseUrl() {
  return getPayuniCallbackBaseUrl();
}

function getPayuniBackUrl() {
  const fe = stripEnvUrl(process.env.FRONTEND_URL || '');
  if (!fe) return null;
  return `${fe}/staff/ops`;
}

function packEncryptPayload(innerParams) {
  const plaintext = querystring.stringify(innerParams);
  const encryptInfo = encrypt(plaintext, HASH_KEY, HASH_IV);
  const hashInfo = sha256(encryptInfo, HASH_KEY, HASH_IV);
  return {
    MerID: MERCHANT_ID,
    Version: '1.0',
    EncryptInfo: encryptInfo,
    HashInfo: hashInfo,
  };
}

/**
 * 解析刷卡選項：一次付清／分期繳納／定期定額
 * @param {object} body
 * @param {{ allowRecurring?: boolean }} opts
 */
export function parseCardPayOptions(body = {}, opts = {}) {
  const allowRecurring = Boolean(opts.allowRecurring);
  const rawMode = String(body.cardMode || body.cardPayMode || 'LUMP').toUpperCase();
  const cardMode = CARD_MODES.includes(rawMode) ? rawMode : 'LUMP';

  if (cardMode === 'RECURRING' && !allowRecurring) {
    const err = new Error('此方案未啟用定期定額（enableCardRecurring）');
    err.statusCode = 400;
    throw err;
  }

  let cardInst = null;
  if (cardMode === 'INSTALLMENT') {
    const n = parseInt(body.cardInst ?? body.installments, 10);
    if (!Number.isInteger(n) || !CARD_INSTALLMENT_OPTIONS.includes(n)) {
      const err = new Error(
        `分期期數無效，請選擇：${CARD_INSTALLMENT_OPTIONS.join('、')}`,
      );
      err.statusCode = 400;
      throw err;
    }
    cardInst = n;
  }

  let periodType = null;
  let periodTimes = null;
  if (cardMode === 'RECURRING') {
    const pt = String(body.periodType || 'M').toUpperCase();
    if (!['W', 'M', 'Y'].includes(pt)) {
      const err = new Error('定期定額週期僅支援 W（週）／M（月）／Y（年）');
      err.statusCode = 400;
      throw err;
    }
    periodType = pt;

    const timesRaw = body.periodTimes;
    if (timesRaw === undefined || timesRaw === null || timesRaw === '') {
      periodTimes = 0; // 0＝不限期數（商店端續扣）
    } else {
      const t = parseInt(timesRaw, 10);
      if (!Number.isInteger(t) || t < 0 || t > 99) {
        const err = new Error('定期定額期數須為 0–99（0＝不限）');
        err.statusCode = 400;
        throw err;
      }
      periodTimes = t;
    }
  }

  return { cardMode, cardInst, periodType, periodTimes };
}

/**
 * 🛒 建立幕前支付 (UPP) 跳轉參數 — 一次付清／分期
 * 定期定額請用 buildPeriodPayload／buildCardCheckoutRequest
 */
export function buildUPPPayload(orderData) {
  const returnBase = getPayuniReturnBaseUrl();
  const notifyBase = getPayuniNotifyBaseUrl();
  const cardMode = String(orderData.cardMode || 'LUMP').toUpperCase();
  const tradeAmt = Math.round(orderData.amount).toString();
  const backUrl = getPayuniBackUrl();

  const innerParams = {
    MerID: MERCHANT_ID,
    MerTradeNo: orderData.id,
    TradeAmt: tradeAmt,
    Timestamp: Math.floor(Date.now() / 1000).toString(),
    ProdDesc: String(orderData.itemDesc || '訂單').substring(0, 50),
    ReturnURL: `${returnBase}/api/ops/payuni/return`,
    NotifyURL: `${notifyBase}/api/ops/payuni/webhook`,
  };
  if (backUrl) innerParams.BackURL = backUrl;

  if (cardMode === 'INSTALLMENT') {
    innerParams.CreditInst = '1';
    const inst = parseInt(orderData.cardInst, 10);
    if (Number.isInteger(inst) && inst > 1) {
      innerParams.CardInst = String(inst);
    }
  } else {
    innerParams.Credit = '1';
  }

  return packEncryptPayload(innerParams);
}

/**
 * 續期收款支付頁（PayUNi 定期定額幕前）
 * TradeAmt＝本次首期；PeriodAmt＝後續每期（可與首期不同，例如課程 2／4 期）
 * @see https://docs.payuni.com.tw — 續期收款 › 續期收款支付頁
 */
export function buildPeriodPayload(orderData) {
  const returnBase = getPayuniReturnBaseUrl();
  const notifyBase = getPayuniNotifyBaseUrl();
  const tradeAmt = Math.round(Number(orderData.amount));
  if (!Number.isFinite(tradeAmt) || tradeAmt <= 0) {
    const err = new Error('定期定額首期金額無效');
    err.statusCode = 400;
    throw err;
  }

  const periodRaw =
    orderData.periodAmt != null && orderData.periodAmt !== ''
      ? orderData.periodAmt
      : orderData.recurringAmount != null && orderData.recurringAmount !== ''
        ? orderData.recurringAmount
        : tradeAmt;
  const periodAmt = Math.round(Number(periodRaw));
  if (!Number.isFinite(periodAmt) || periodAmt <= 0) {
    const err = new Error('定期定額每期金額無效');
    err.statusCode = 400;
    throw err;
  }

  const pt = String(orderData.periodType || 'M').toUpperCase();
  if (!['W', 'M', 'Y'].includes(pt)) {
    const err = new Error('定期定額週期僅支援 W／M／Y');
    err.statusCode = 400;
    throw err;
  }

  const times = parseInt(orderData.periodTimes, 10);
  if (!Number.isInteger(times) || times <= 0) {
    const err = new Error('續期收款總期數須為正整數');
    err.statusCode = 400;
    throw err;
  }

  const innerParams = {
    MerID: MERCHANT_ID,
    MerTradeNo: orderData.id,
    TradeAmt: String(tradeAmt),
    PeriodAmt: String(periodAmt),
    PeriodType: pt,
    PeriodTimes: String(times),
    Timestamp: Math.floor(Date.now() / 1000).toString(),
    ProdDesc: String(orderData.itemDesc || '定期定額').substring(0, 50),
    ReturnURL: `${returnBase}/api/ops/payuni/return`,
    NotifyURL: `${notifyBase}/api/ops/payuni/webhook`,
  };
  const backUrl = getPayuniBackUrl();
  if (backUrl) innerParams.BackURL = backUrl;

  console.log(
    `[PayUNi] 續期收款 ReturnURL=${innerParams.ReturnURL} NotifyURL=${innerParams.NotifyURL}`,
  );

  return packEncryptPayload(innerParams);
}

/**
 * 依刷卡模式回傳幕前 actionUrl + 表單 payload
 * RECURRING → 續期收款支付頁；其餘 → UPP
 */
export function buildCardCheckoutRequest(orderData) {
  const cardMode = String(orderData.cardMode || 'LUMP').toUpperCase();
  if (cardMode === 'RECURRING') {
    return {
      actionUrl: getPayuniPeriodPayUrl(),
      payload: buildPeriodPayload(orderData),
    };
  }
  return {
    actionUrl: getPayuniUppUrl(),
    payload: buildUPPPayload(orderData),
  };
}

/**
 * 從 webhook 解密資料抽出刷卡結果欄位（分期數／Token）
 */
export function extractCardTradeMeta(tradeData = {}) {
  const cardInstRaw = parseInt(tradeData.CardInst, 10);
  const cardInst =
    Number.isInteger(cardInstRaw) && cardInstRaw > 1 ? cardInstRaw : null;
  const creditHash = tradeData.CreditHash
    ? String(tradeData.CreditHash).trim()
    : tradeData.CreditToken
      ? String(tradeData.CreditToken).trim()
      : null;
  return {
    cardInst,
    creditHash: creditHash || null,
    firstAmt: tradeData.FirstAmt != null ? Number(tradeData.FirstAmt) : null,
    eachAmt: tradeData.EachAmt != null ? Number(tradeData.EachAmt) : null,
    authType: tradeData.AuthType != null ? String(tradeData.AuthType) : null,
  };
}

export function getPayuniCreditApiUrl() {
  return (
    (process.env.PAYUNI_CREDIT_TOKEN_URL || '').trim() ||
    (process.env.PAYUNI_CREDIT_URL || '').trim() ||
    'https://sandbox-api.payuni.com.tw/api/credit'
  );
}

/**
 * 幕後信用卡 Token 扣款（定期定額續扣）
 * @returns {{ ok: boolean, tradeNo?: string, status?: string, message?: string, raw?: object }}
 */
export async function chargeWithCreditHash({
  merTradeNo,
  amount,
  itemDesc,
  creditHash,
  usrMail,
}) {
  const hash = String(creditHash || '').trim();
  if (!hash) {
    return { ok: false, message: '缺少 CreditHash，無法幕後扣款' };
  }
  if (!merTradeNo) {
    return { ok: false, message: '缺少 MerTradeNo' };
  }

  const tradeAmt = Math.round(Number(amount));
  if (!Number.isFinite(tradeAmt) || tradeAmt <= 0) {
    return { ok: false, message: '扣款金額無效' };
  }

  const innerParams = {
    MerID: MERCHANT_ID,
    MerTradeNo: String(merTradeNo),
    TradeAmt: String(tradeAmt),
    Timestamp: Math.floor(Date.now() / 1000).toString(),
    ProdDesc: String(itemDesc || '定期定額續扣').substring(0, 50),
    CreditHash: hash,
    CreditInstallment: '0',
  };
  if (usrMail) {
    innerParams.UsrMail = String(usrMail).substring(0, 100);
  }

  const plaintext = querystring.stringify(innerParams);
  const encryptInfo = encrypt(plaintext, HASH_KEY, HASH_IV);
  const hashInfo = sha256(encryptInfo, HASH_KEY, HASH_IV);

  const body = new URLSearchParams({
    MerID: MERCHANT_ID,
    Version: '1.0',
    EncryptInfo: encryptInfo,
    HashInfo: hashInfo,
  });

  let response;
  try {
    response = await fetch(getPayuniCreditApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    return { ok: false, message: `PayUNi 連線失敗：${error.message}` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    const text = await response.text().catch(() => '');
    return { ok: false, message: `PayUNi 回應非 JSON：${text.slice(0, 200)}` };
  }

  if (!payload?.EncryptInfo) {
    return {
      ok: false,
      message: payload?.Message || payload?.Status || 'PayUNi 未回傳 EncryptInfo',
      raw: payload,
    };
  }

  if (payload.HashInfo && !verifyWebhookHash(payload.EncryptInfo, payload.HashInfo)) {
    return { ok: false, message: 'PayUNi 回應 Hash 驗證失敗', raw: payload };
  }

  let tradeData;
  try {
    tradeData = decryptInfo(payload.EncryptInfo);
  } catch (error) {
    return { ok: false, message: `解密失敗：${error.message}`, raw: payload };
  }

  const status = String(tradeData.Status || payload.Status || '');
  const tradeStatus = String(tradeData.TradeStatus || '');
  const ok = status === 'SUCCESS' && (tradeStatus === '1' || tradeStatus === '');

  return {
    ok,
    tradeNo: tradeData.TradeNo || null,
    status,
    tradeStatus,
    message: tradeData.Message || (ok ? '扣款成功' : '扣款失敗'),
    raw: tradeData,
  };
}

/**
 * 🛡️ 驗證來自統一金流 Webhook 的 Hash 是否合法
 */
export function verifyWebhookHash(encryptInfo, receivedHash) {
  const expectedHash = sha256(encryptInfo, HASH_KEY, HASH_IV);
  const expectedBuf = Buffer.from(String(expectedHash || ''), 'utf8');
  const receivedBuf = Buffer.from(String(receivedHash || ''), 'utf8');
  if (!expectedBuf.length || expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
