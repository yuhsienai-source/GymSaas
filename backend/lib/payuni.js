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
    throw new Error("解密失敗");
  }
}

export const PAYUNI_UPP_URL = 'https://sandbox-api.payuni.com.tw/api/upp';

/** 金流 Notify／Return 必須打回「後端」公開網址，不是前端網域 */
function getApiPublicBaseUrl() {
  const base = (
    process.env.API_PUBLIC_URL ||
    process.env.BASE_URL ||
    ''
  )
    .trim()
    .replace(/\/$/, '');

  if (!base) {
    throw new Error('API_PUBLIC_URL（或 BASE_URL）未設定：無法組 PayUNi ReturnURL／NotifyURL');
  }
  return base;
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
 * 🛒 建立幕前支付 (UPP) 跳轉參數
 * orderData 可含 cardMode / cardInst / periodType / periodTimes
 */
export function buildUPPPayload(orderData) {
  const apiBase = getApiPublicBaseUrl();
  const cardMode = String(orderData.cardMode || 'LUMP').toUpperCase();
  const tradeAmt = Math.round(orderData.amount).toString();

  // 整理要傳給金流的內層參數
  const innerParams = {
    MerID: MERCHANT_ID,
    MerTradeNo: orderData.id,
    TradeAmt: tradeAmt,
    Timestamp: Math.floor(Date.now() / 1000).toString(),
    ProdDesc: String(orderData.itemDesc || '訂單').substring(0, 50),
    // Return／Notify → 後端；瀏覽器再由 return handler 導向獨立前端
    ReturnURL: `${apiBase}/api/ops/payuni/return`,
    NotifyURL: `${apiBase}/api/ops/payuni/webhook`,
  };

  if (cardMode === 'INSTALLMENT') {
    // 僅開信用卡分期；指定期數時帶 CardInst（幕前／幕後共通欄位）
    innerParams.CreditInst = '1';
    const inst = parseInt(orderData.cardInst, 10);
    if (Number.isInteger(inst) && inst > 1) {
      innerParams.CardInst = String(inst);
    }
  } else if (cardMode === 'RECURRING') {
    // 一次付清＋約定 Token（首次綁定），供後續定期扣款
    innerParams.Credit = '1';
    innerParams.UseTokenType = '1';
    innerParams.UseTokenStatus = '1';
    const pt = String(orderData.periodType || 'M').toUpperCase();
    if (['W', 'M', 'Y'].includes(pt)) {
      innerParams.PeriodType = pt;
      innerParams.PeriodAmt = tradeAmt;
      const times = parseInt(orderData.periodTimes, 10);
      if (Number.isInteger(times) && times > 0) {
        innerParams.PeriodTimes = String(times);
      }
    }
  } else {
    // 預設：僅信用卡一次付清
    innerParams.Credit = '1';
  }

  // 1. 嚴格使用官方指定的 querystring 進行編碼
  const plaintext = querystring.stringify(innerParams);
  
  // 2. 執行 AES-GCM 加密與 SHA256 壓碼
  const encryptInfo = encrypt(plaintext, HASH_KEY, HASH_IV);
  const hashInfo = sha256(encryptInfo, HASH_KEY, HASH_IV);

  return {
    MerID: MERCHANT_ID,
    Version: '1.0', 
    EncryptInfo: encryptInfo,
    HashInfo: hashInfo
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
