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

/** @typedef {'counter'|'online'} PayuniPeriodChannel */

/**
 * 解析 PAYUNI_PERIOD_HASHES JSON
 * 臨櫃鍵：promo:12 / course:5；線上鍵：promo:12:online / course:5:online
 */
export function parsePayuniPeriodHashMap() {
  const raw = (process.env.PAYUNI_PERIOD_HASHES || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k || '').trim();
      const hash = String(v || '').trim();
      if (key && hash) out[key] = hash;
    }
    return out;
  } catch (e) {
    console.error('PAYUNI_PERIOD_HASHES JSON 解析失敗:', e.message);
    return {};
  }
}

export function normalizePayuniPeriodChannel(channel) {
  const c = String(channel || 'counter').toLowerCase().trim();
  return c === 'online' || c === 'member' ? 'online' : 'counter';
}

/**
 * 選定要用的續期 Hash
 * 臨櫃：方案 payuniPeriodHash → map promo:id → PAYUNI_PERIOD_HASH
 * 線上：方案 payuniPeriodHashOnline → map promo:id:online → PAYUNI_PERIOD_HASH_ONLINE
 * （兩通道互不回退對方 Hash）
 * @param {{ channel?: PayuniPeriodChannel|'member', periodHash?: string|null, payuniPeriodHash?: string|null, promotionId?: number|null, coursePlanId?: number|null, promotion?: object|null, coursePlan?: object|null }} [opts]
 * @returns {string|null}
 */
export function resolvePayuniPeriodHash(opts = {}) {
  const channel = normalizePayuniPeriodChannel(opts.channel);
  const isOnline = channel === 'online';

  const explicit = String(opts.periodHash || opts.payuniPeriodHash || '').trim();
  if (explicit) return explicit;

  const planHash = isOnline
    ? String(
        opts.promotion?.payuniPeriodHashOnline || opts.coursePlan?.payuniPeriodHashOnline || '',
      ).trim()
    : String(opts.promotion?.payuniPeriodHash || opts.coursePlan?.payuniPeriodHash || '').trim();
  if (planHash) return planHash;

  const map = parsePayuniPeriodHashMap();
  const promoId = opts.promotionId ?? opts.promotion?.id;
  const courseId = opts.coursePlanId ?? opts.coursePlan?.id;
  if (isOnline) {
    if (promoId != null && map[`promo:${promoId}:online`]) return map[`promo:${promoId}:online`];
    if (courseId != null && map[`course:${courseId}:online`]) return map[`course:${courseId}:online`];
    const onlineFallback = (process.env.PAYUNI_PERIOD_HASH_ONLINE || '').trim();
    return onlineFallback || null;
  }
  if (promoId != null && map[`promo:${promoId}`]) return map[`promo:${promoId}`];
  if (courseId != null && map[`course:${courseId}`]) return map[`course:${courseId}`];
  const counterFallback = (process.env.PAYUNI_PERIOD_HASH || '').trim();
  return counterFallback || null;
}

/**
 * 續期收款（定期定額）幕前支付頁
 * 例：https://sandbox-api.payuni.com.tw/api/period/{MerID}/{Hash}
 * 臨櫃／會員線上必須用不同 Hash（方案欄或 env 分開設定）。
 * @param {{ channel?: PayuniPeriodChannel|'member', periodHash?: string|null, payuniPeriodHash?: string|null, promotion?: object|null, coursePlan?: object|null }} [opts]
 */
export function getPayuniPeriodPayUrl(opts = {}) {
  const channel = normalizePayuniPeriodChannel(opts.channel);
  const periodHash = resolvePayuniPeriodHash(opts);
  if (periodHash) {
    if (!MERCHANT_ID) {
      const err = new Error('PAYUNI_MERCHANT_ID 未設定');
      err.statusCode = 500;
      throw err;
    }
    return `${getPayuniApiBase()}/api/period/${MERCHANT_ID}/${periodHash}`;
  }
  const urlEnv =
    channel === 'online'
      ? process.env.PAYUNI_PERIOD_URL_ONLINE || process.env.PAYUNI_PERIOD_URL
      : process.env.PAYUNI_PERIOD_URL;
  const full = String(urlEnv || '')
    .trim()
    .replace(/\/$/, '');
  if (full) return full;
  const err = new Error(
    channel === 'online'
      ? '會員線上定期定額未設定：請填方案 payuniPeriodHashOnline，或 .env PAYUNI_PERIOD_HASH_ONLINE／PAYUNI_PERIOD_HASHES（promo:id:online）／PAYUNI_PERIOD_URL_ONLINE'
      : '臨櫃定期定額未設定：請填方案 payuniPeriodHash，或 .env PAYUNI_PERIOD_HASH／PAYUNI_PERIOD_HASHES／PAYUNI_PERIOD_URL',
  );
  err.statusCode = 500;
  throw err;
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
 * - 一般：TradeAmt／FAmt＝本次首期收款；PeriodAmt＝後續每期
 * - bindOnly（臨櫃）：乙禾已收方案首期 → TradeAmt／FAmt＝驗證授權（預設 $1），
 *   約定成功後本機呼叫 trade_cancel 取消授權（不請款）；PeriodAmt＝第 2 期起原價
 * - bindOnly（線上）：預設 TradeAmt／FAmt＝0（不收款），只約定後續
 * @see https://docs.payuni.com.tw — 續期收款 › 續期收款支付頁
 */
export function resolveBindVerifyAmount(orderData = {}) {
  if (!orderData?.bindOnly) return null;
  if (orderData.verifyAmt != null && orderData.verifyAmt !== '') {
    const v = Math.round(Number(orderData.verifyAmt));
    if (Number.isFinite(v) && v >= 0) return v;
  }
  if (orderData.bindVerifyAmt != null && orderData.bindVerifyAmt !== '') {
    const v = Math.round(Number(orderData.bindVerifyAmt));
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const channel = normalizePayuniPeriodChannel(orderData.channel);
  // 會員線上約定：維持 0；臨櫃預設 $1 驗證授權（可用 PAYUNI_BIND_VERIFY_AMT 覆寫）
  if (channel === 'online') {
    const onlineEnv = (process.env.PAYUNI_BIND_VERIFY_AMT_ONLINE || '').trim();
    if (onlineEnv !== '') {
      const v = Math.round(Number(onlineEnv));
      if (Number.isFinite(v) && v >= 0) return v;
    }
    return 0;
  }
  const env = (process.env.PAYUNI_BIND_VERIFY_AMT || '1').trim();
  const v = Math.round(Number(env));
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

/** 臨櫃預設驗證授權金額上限（與 PAYUNI_BIND_VERIFY_AMT 對齊） */
export function getBindVerifyAmountCap() {
  const env = (process.env.PAYUNI_BIND_VERIFY_AMT || '1').trim();
  const v = Math.round(Number(env));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Notify 是否為「續期約定驗證授權」（小額 Auth／FAmt + PeriodTradeNo／PeriodAmt）
 * 成功後應取消授權，避免實際請款。
 */
export function isBindVerifyAuthNotify(tradeData = {}) {
  const auth = Number(
    tradeData.AuthAmt != null
      ? tradeData.AuthAmt
      : tradeData.FAmt != null
        ? tradeData.FAmt
        : NaN,
  );
  if (!Number.isFinite(auth) || auth <= 0) return false;
  const cap = getBindVerifyAmountCap();
  if (auth > cap) return false;
  const hasPeriod =
    Boolean(String(tradeData.PeriodTradeNo || '').trim()) ||
    (tradeData.PeriodAmt != null && Number(tradeData.PeriodAmt) > 0);
  if (!hasPeriod) return false;
  const periodAmt = Number(tradeData.PeriodAmt);
  if (Number.isFinite(periodAmt) && periodAmt > 0 && auth >= periodAmt) return false;
  return Boolean(String(tradeData.TradeNo || '').trim());
}

export function buildPeriodPayload(orderData) {
  const returnBase = getPayuniReturnBaseUrl();
  const notifyBase = getPayuniNotifyBaseUrl();
  const bindOnly = Boolean(orderData.bindOnly);
  const verifyAmt = bindOnly ? resolveBindVerifyAmount(orderData) : null;

  let tradeAmt = Math.round(Number(orderData.amount));
  if (bindOnly) {
    tradeAmt = verifyAmt ?? 0;
  } else if (!Number.isFinite(tradeAmt) || tradeAmt <= 0) {
    const err = new Error('定期定額首期金額無效');
    err.statusCode = 400;
    throw err;
  }

  const periodRaw =
    orderData.periodAmt != null && orderData.periodAmt !== ''
      ? orderData.periodAmt
      : orderData.recurringAmount != null && orderData.recurringAmount !== ''
        ? orderData.recurringAmount
        : bindOnly
          ? null
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
    ProdDesc: buildPeriodProdDesc(
      orderData.bindCheckoutId || orderData.bindSubscriptionId || orderData.id,
      bindOnly
        ? `${orderData.itemDesc || '定期定額'}|${orderData.rebind ? 'REBIND' : 'BIND'}`
        : orderData.itemDesc,
    ),
    PeriodType: pt,
    PeriodTimes: String(times),
    Timestamp: Math.floor(Date.now() / 1000).toString(),
    ReturnURL: `${returnBase}/api/ops/payuni/return`,
    NotifyURL: `${notifyBase}/api/ops/payuni/webhook`,
  };

  if (bindOnly) {
    // FAmt＝當下驗證授權：臨櫃預設 $1（Notify 後 trade_cancel）；線上預設 $0；PeriodAmt＝第 2 期起原價
    innerParams.FAmt = String(verifyAmt ?? 0);
    innerParams.FType = pt;
    const schedule = buildFuturePeriodDates(pt, times, orderData.firstChargeAt);
    if (schedule.length > 0) {
      // Date＝自訂未來扣款日（不可含今日）；PeriodDate＝首扣日（YYYY-MM-DD）
      innerParams.PeriodDate = schedule[0];
      innerParams.FDate = schedule[0];
      innerParams.Date = schedule.join(',');
    }
  } else {
    // 一般續期：首期授權金額與 TradeAmt 對齊
    innerParams.FAmt = String(tradeAmt);
    if (orderData.periodDate) {
      innerParams.PeriodDate = String(orderData.periodDate);
    }
  }

  const backUrl = getPayuniBackUrl();
  if (backUrl) innerParams.BackURL = backUrl;

  const bindLabel =
    bindOnly && (verifyAmt ?? 0) > 0
      ? `（驗卡授權 $${verifyAmt}→取消；PeriodAmt 自第2期）`
      : bindOnly
        ? '（僅約定不收款）'
        : '';
  console.log(
    `[PayUNi] 續期收款${bindLabel} TradeAmt=${innerParams.TradeAmt} FAmt=${innerParams.FAmt} PeriodAmt=${innerParams.PeriodAmt} Times=${innerParams.PeriodTimes} PeriodDate=${innerParams.PeriodDate || '-'} Date=${innerParams.Date ? `${String(innerParams.Date).slice(0, 10)}…(${times})` : '-'}`,
  );

  return packEncryptPayload(innerParams);
}

/** 自 now／指定日起算，產出 periodTimes 筆「嚴格未來」扣款日 YYYY-MM-DD（不可含今日） */
export function buildFuturePeriodDates(periodType, times, fromDate = null) {
  const pt = String(periodType || 'M').toUpperCase();
  const n = parseInt(times, 10);
  if (!Number.isInteger(n) || n <= 0) return [];
  let cursor = fromDate ? new Date(fromDate) : new Date();
  if (Number.isNaN(cursor.getTime())) cursor = new Date();
  const today = formatYmd(new Date());
  const out = [];
  for (let i = 0; i < n; i++) {
    cursor = addOnePeriod(cursor, pt);
    // 防止時區／同日誤排到今日（PayUNi 首日＝今日就會立刻授權 FAmt）
    while (formatYmd(cursor) <= today) {
      cursor = addOnePeriod(cursor, pt);
    }
    out.push(formatYmd(cursor));
  }
  return out;
}

function addOnePeriod(date, periodType) {
  const d = new Date(date.getTime());
  const pt = String(periodType || 'M').toUpperCase();
  if (pt === 'W') d.setDate(d.getDate() + 7);
  else if (pt === 'Y') d.setFullYear(d.getFullYear() + 1);
  else d.setDate(d.getDate() + 30);
  return d;
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 依刷卡模式回傳幕前 actionUrl + 表單 payload
 * RECURRING → 續期收款支付頁；其餘 → UPP
 */
export function buildCardCheckoutRequest(orderData) {
  const cardMode = String(orderData.cardMode || 'LUMP').toUpperCase();
  if (cardMode === 'RECURRING') {
    return {
      actionUrl: getPayuniPeriodPayUrl({
        channel: orderData.channel || orderData.periodChannel || 'counter',
        periodHash: orderData.periodHash || orderData.payuniPeriodHash,
        promotionId: orderData.promotionId,
        coursePlanId: orderData.coursePlanId,
        promotion: orderData.promotion,
        coursePlan: orderData.coursePlan,
      }),
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
  const dateListRaw = tradeData.DateList != null ? String(tradeData.DateList).trim() : '';
  return {
    cardInst,
    creditHash: creditHash || null,
    firstAmt: tradeData.FirstAmt != null ? Number(tradeData.FirstAmt) : null,
    eachAmt: tradeData.EachAmt != null ? Number(tradeData.EachAmt) : null,
    authType: tradeData.AuthType != null ? String(tradeData.AuthType) : null,
    periodTradeNo: tradeData.PeriodTradeNo
      ? String(tradeData.PeriodTradeNo).trim()
      : null,
    dateList: dateListRaw || null,
    periodDate: tradeData.PeriodDate ? String(tradeData.PeriodDate).trim() : null,
    authAmt:
      tradeData.AuthAmt != null
        ? Number(tradeData.AuthAmt)
        : tradeData.FAmt != null
          ? Number(tradeData.FAmt)
          : tradeData.TradeAmt != null
            ? Number(tradeData.TradeAmt)
            : null,
  };
}

/** DateList／ExpAuthDT → YYYY-MM-DD 列表 */
export function parsePayuniDateList(dateListOrCsv) {
  if (Array.isArray(dateListOrCsv)) {
    return dateListOrCsv
      .map((x) => {
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(x || '').trim());
        return m ? m[1] : '';
      })
      .filter(Boolean);
  }
  const raw = String(dateListOrCsv || '').trim();
  if (!raw) return [];
  return raw
    .split(/[,，\s]+/)
    .map((p) => {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(p.trim());
      return m ? m[1] : '';
    })
    .filter(Boolean);
}

/** YYYY-MM-DD 或 `YYYY-MM-DD HH:mm:ss` → 本地 00:00 Date */
export function parsePayuniYmdToDate(ymdOrDt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymdOrDt || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

function formatLocalYmd(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 從 PayUNi DateList 取「下一筆未來扣款日」（略過今日／過去＝首期授權日）
 */
export function resolveNextChargeAtFromDateList(dateList, now = new Date()) {
  const today = formatLocalYmd(now);
  for (const ymd of parsePayuniDateList(dateList)) {
    if (ymd > today) {
      return parsePayuniYmdToDate(ymd);
    }
  }
  return null;
}

/**
 * 從 period/query 摘要取最近一筆「排程中」的 ExpAuthDT
 */
export function resolveNextChargeAtFromPeriodSchedule(schedule, now = new Date()) {
  const today = formatLocalYmd(now);
  const pending = Array.isArray(schedule?.pendingPeriods) ? schedule.pendingPeriods : [];
  for (const row of pending) {
    const ymd = parsePayuniDateList(row?.expAuthDT)[0];
    if (!ymd) continue;
    if (ymd >= today) return parsePayuniYmdToDate(ymd);
  }
  return null;
}

/**
 * UPP Notify：Status=SUCCESS 且 TradeStatus=1
 * 續期收款 Notify：常無 TradeStatus，改看 Status=SUCCESS + ResCode=00／AuthAmt／PeriodTradeNo
 */
export function isPayuniNotifySuccess(tradeData = {}) {
  if (String(tradeData.Status || '').toUpperCase() !== 'SUCCESS') return false;
  if (tradeData.TradeStatus != null && String(tradeData.TradeStatus).trim() !== '') {
    return String(tradeData.TradeStatus) === '1';
  }
  if (tradeData.ResCode != null && String(tradeData.ResCode).trim() !== '') {
    return String(tradeData.ResCode) === '00';
  }
  // 續期收款：成功碼／期別序號；bindOnly（TradeAmt=0）可能 AuthAmt=0 仍成功
  if (tradeData.PeriodTradeNo || tradeData.CreditHash || tradeData.CreditToken) {
    return true;
  }
  if (tradeData.AuthAmt != null || tradeData.FAmt != null) {
    return true;
  }
  return false;
}

const OUR_TRADE_NO_RE = /^(CHK|SAL|CRS|TYK|CRC)[A-Za-z0-9]+/i;

/**
 * 解析本系統單號。續期收款 Notify 的 MerTradeNo 常為 PayUNi 自編（…_1），
 * 因此 ProdDesc 必須以本系統單號開頭（見 buildPeriodProdDesc）。
 * 約定／換卡自編 MerTradeNo 可能帶 B／R 後綴（CHK…B123456、CRS…R123456）。
 */
export function stripPayuniBindMerTradeSuffix(ref) {
  const s = String(ref || '').trim();
  if (!s) return s;
  const stripped = s.replace(/(B|R)\d{4,}$/i, '');
  return stripped || s;
}

export function resolvePayuniOrderRef(tradeData = {}) {
  const raw = String(tradeData.MerTradeNo || '').trim();
  const rawBase = stripPayuniBindMerTradeSuffix(raw.replace(/_\d+$/, ''));
  if (OUR_TRADE_NO_RE.test(rawBase)) {
    return rawBase;
  }
  // PayUNi 續期：xxx_1 → 去掉期別後綴再試（仍可能非本系統單號）
  const base = raw.replace(/_\d+$/, '');
  const baseStripped = stripPayuniBindMerTradeSuffix(base);
  if (baseStripped !== raw && OUR_TRADE_NO_RE.test(baseStripped)) {
    return baseStripped;
  }

  const desc = String(tradeData.ProdDesc || '').trim();
  const fromDesc = desc.match(/\b((?:CHK|SAL|CRS|TYK|CRC)[A-Za-z0-9]+)\b/i);
  if (fromDesc) return stripPayuniBindMerTradeSuffix(fromDesc[1]);

  // 舊格式／開頭即單號
  const head = desc.split(/[|\s]/)[0];
  if (head && OUR_TRADE_NO_RE.test(head)) return stripPayuniBindMerTradeSuffix(head);

  // 續期收款頁常覆寫 MerTradeNo／ProdDesc 為商店端自編，不可當成本系統單號
  return null;
}

/**
 * 約定／換卡 Notify 可能無 CreditHash，改以 PeriodTradeNo 佔位（PERIOD:…）
 * @returns {string|null}
 */
export function resolveBindCreditHash(cardMeta = {}, tradeData = {}) {
  const real = String(cardMeta?.creditHash || '').trim();
  if (real) return real;
  const periodNo = String(
    cardMeta?.periodTradeNo || tradeData?.PeriodTradeNo || '',
  ).trim();
  if (periodNo) return `PERIOD:${periodNo}`;
  return null;
}

/** 續期收款 ProdDesc：單號置前，Notify 才能反查 CHK／CRS… */
export function buildPeriodProdDesc(orderId, itemDesc) {
  const id = String(orderId || '').trim();
  const rest = String(itemDesc || '定期定額')
    .replace(/^(CHK|SAL|CRS|TYK|CRC)[A-Za-z0-9]+\s*[|｜]?\s*/i, '')
    .trim();
  const combined = rest ? `${id}|${rest}` : id;
  return combined.substring(0, 50);
}

export function getPayuniCreditApiUrl() {
  return (
    (process.env.PAYUNI_CREDIT_TOKEN_URL || '').trim() ||
    (process.env.PAYUNI_CREDIT_URL || '').trim() ||
    'https://sandbox-api.payuni.com.tw/api/credit'
  );
}

export function getPayuniTradeCancelUrl() {
  return (
    (process.env.PAYUNI_TRADE_CANCEL_URL || '').trim() ||
    `${getPayuniApiBase()}/api/trade/cancel`
  );
}

export function getPayuniPeriodQueryUrl() {
  return (
    (process.env.PAYUNI_PERIOD_QUERY_URL || '').trim() ||
    `${getPayuniApiBase()}/api/period/query`
  );
}

/** 續期狀態異動（終止／暫停／啟用）— 官方：/api/period/mdfStatus */
export function getPayuniPeriodAlterUrl() {
  const explicit = (process.env.PAYUNI_PERIOD_ALTER_URL || '').trim();
  if (explicit) return explicit;
  const path = (process.env.PAYUNI_PERIOD_ALTER_PATH || '').trim() || '/api/period/mdfStatus';
  if (/^https?:\/\//i.test(path)) return path;
  return `${getPayuniApiBase()}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** 從訂閱 creditHash（PERIOD:…）取出 PayUNi PeriodTradeNo */
export function extractPeriodTradeNo(subOrHash) {
  const h =
    typeof subOrHash === 'string'
      ? subOrHash
      : String(subOrHash?.creditHash || '');
  if (h.startsWith('PERIOD:')) return h.slice('PERIOD:'.length).trim();
  const raw = String(subOrHash?.periodTradeNo || '').trim();
  return raw || '';
}

/**
 * 呼叫 PayUNi 加密 API（form POST）
 * @returns {{ ok: boolean, html?: boolean, message?: string, status?: string, data?: object, raw?: object }}
 */
async function postPayuniEncrypted(urlPathOrAbsolute, innerParams, { version = '1.0' } = {}) {
  if (!MERCHANT_ID) return { ok: false, message: 'PAYUNI_MERCHANT_ID 未設定' };
  const url = /^https?:\/\//i.test(String(urlPathOrAbsolute || ''))
    ? String(urlPathOrAbsolute)
    : `${getPayuniApiBase()}${String(urlPathOrAbsolute || '').startsWith('/') ? '' : '/'}${urlPathOrAbsolute}`;

  const payload = {
    MerID: MERCHANT_ID,
    Timestamp: Math.floor(Date.now() / 1000).toString(),
    ...innerParams,
  };
  const plaintext = querystring.stringify(payload);
  const encryptInfo = encrypt(plaintext, HASH_KEY, HASH_IV);
  const hashInfo = sha256(encryptInfo, HASH_KEY, HASH_IV);
  const body = new URLSearchParams({
    MerID: MERCHANT_ID,
    Version: String(version || '1.0'),
    EncryptInfo: encryptInfo,
    HashInfo: hashInfo,
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // 官方文件：請於 header 加入 user-agent，建議內容為 payuni
        'User-Agent': (process.env.PAYUNI_USER_AGENT || 'payuni').trim() || 'payuni',
      },
      body: body.toString(),
    });
  } catch (error) {
    return { ok: false, message: `PayUNi 連線失敗：${error.message}` };
  }

  const text = await response.text().catch(() => '');
  if (text.trim().startsWith('<')) {
    return { ok: false, html: true, message: `PayUNi 路徑無 API（${url}）` };
  }

  let payloadJson;
  try {
    payloadJson = JSON.parse(text);
  } catch {
    return { ok: false, message: `PayUNi 回應非 JSON：${text.slice(0, 200)}` };
  }

  if (!payloadJson?.EncryptInfo) {
    const topStatus = String(payloadJson?.Status || '').toUpperCase();
    return {
      ok: topStatus === 'SUCCESS',
      status: topStatus,
      message: payloadJson?.Message || payloadJson?.Status || 'PayUNi 未回傳 EncryptInfo',
      raw: payloadJson,
    };
  }

  if (payloadJson.HashInfo && !verifyWebhookHash(payloadJson.EncryptInfo, payloadJson.HashInfo)) {
    return { ok: false, message: 'PayUNi 回應 Hash 驗證失敗', raw: payloadJson };
  }

  let tradeData;
  try {
    tradeData = decryptInfo(payloadJson.EncryptInfo);
  } catch (error) {
    return { ok: false, message: `PayUNi 解密失敗：${error.message}`, raw: payloadJson };
  }

  const status = String(tradeData.Status || payloadJson.Status || '').toUpperCase();
  return {
    ok: status === 'SUCCESS',
    status,
    message: tradeData.Message || (status === 'SUCCESS' ? '成功' : '失敗'),
    data: tradeData,
    raw: payloadJson,
  };
}

/** 查詢 PayUNi 續期訂單（PeriodTradeNo） */
export async function queryPayuniPeriod({ periodTradeNo } = {}) {
  const no = String(periodTradeNo || '').trim();
  if (!no) return { ok: false, message: '缺少 PeriodTradeNo' };
  return postPayuniEncrypted(getPayuniPeriodQueryUrl(), { PeriodTradeNo: no });
}

/**
 * 解析 period/query 回傳：是否仍有「排程中」等未執行期數
 * （PayUNi 用 Result[i][StatusDesc] 扁平欄位）
 */
export function summarizePayuniPeriodSchedule(data = {}) {
  const pendingPeriods = [];
  for (const [key, value] of Object.entries(data || {})) {
    const m = /^Result\[(\d+)\]\[StatusDesc\]$/.exec(key);
    if (!m) continue;
    const desc = String(value || '');
    if (!/排程中|待授權|未授權|授權中/.test(desc)) continue;
    const i = m[1];
    pendingPeriods.push({
      index: Number(i),
      period: data[`Result[${i}][Period]`] ?? null,
      expAuthDT: data[`Result[${i}][ExpAuthDT]`] ?? null,
      amt: data[`Result[${i}][Amt]`] ?? null,
      statusDesc: desc,
    });
  }
  pendingPeriods.sort((a, b) => a.index - b.index);
  return {
    pendingCount: pendingPeriods.length,
    pendingPeriods,
    stopped: pendingPeriods.length === 0,
  };
}

/**
 * 異動 PayUNi 續期訂單狀態（終止／暫停／啟用）
 * @see https://docs.payuni.com.tw/web/#/7/311 — `/api/period/mdfStatus`
 *
 * EncryptInfo：
 * - PeriodTradeNo（必填）
 * - ReviseTradeStatus（必填，全小寫）：end=終止／suspend=暫停／restart=啟用
 * - PeriodOrderNo（選填）：指定某期；整筆訂單不帶
 */
export async function alterPayuniPeriodStatus({
  periodTradeNo,
  alterType = 'terminate',
  periodOrderNo,
} = {}) {
  const no = String(periodTradeNo || '').trim();
  if (!no) return { ok: false, message: '缺少 PeriodTradeNo' };

  const action = String(alterType || 'terminate').toLowerCase();
  const reviseStatus =
    action === 'suspend' || action === 'pause'
      ? String(process.env.PAYUNI_PERIOD_ALTER_SUSPEND || 'suspend').toLowerCase()
      : action === 'restart' || action === 'resume' || action === 'enable'
        ? String(process.env.PAYUNI_PERIOD_ALTER_RESTART || 'restart').toLowerCase()
        : String(process.env.PAYUNI_PERIOD_ALTER_TERMINATE || 'end').toLowerCase();

  const pathOrUrl = getPayuniPeriodAlterUrl();
  const statusParam =
    (process.env.PAYUNI_PERIOD_ALTER_PARAM || '').trim() || 'ReviseTradeStatus';

  const params = {
    PeriodTradeNo: no,
    [statusParam]: reviseStatus,
  };
  const orderNo = periodOrderNo != null && periodOrderNo !== '' ? Number(periodOrderNo) : null;
  if (Number.isInteger(orderNo) && orderNo > 0) {
    params.PeriodOrderNo = String(orderNo);
  }

  const result = await postPayuniEncrypted(pathOrUrl, params);
  const attempts = [
    {
      path: pathOrUrl,
      params: `${statusParam}=${reviseStatus}`,
      ok: result.ok,
      html: Boolean(result.html),
      message: result.message,
      status: result.status,
    },
  ];

  if (result.ok) {
    console.log(
      `[PayUNi] 續期狀態異動成功 PeriodTradeNo=${no} ReviseTradeStatus=${reviseStatus} path=${pathOrUrl}`,
    );
    return {
      ...result,
      periodTradeNo: no,
      alterType: action,
      reviseStatus,
      path: pathOrUrl,
      attempts,
    };
  }

  const msg = String(result.message || '');
  if (/已終止|已停止|已取消|無需|不可調整已終止/.test(msg)) {
    return {
      ok: true,
      alreadyStopped: true,
      message: msg,
      periodTradeNo: no,
      alterType: action,
      reviseStatus,
      path: pathOrUrl,
      attempts,
    };
  }

  return {
    ok: false,
    message: msg || `無法異動 PayUNi 續期單（PeriodTradeNo=${no}）`,
    periodTradeNo: no,
    alterType: action,
    reviseStatus,
    path: pathOrUrl,
    attempts,
  };
}

/**
 * 取消／暫停訂閱時：停掉 PayUNi 續期排程（PERIOD:…）或取消約定 Token
 * 以 period/query 驗證：terminate／suspend 後不應再有「排程中」
 */
export async function stopPayuniRecurringForSubscription(sub, { mode = 'terminate' } = {}) {
  const periodNo = extractPeriodTradeNo(sub);
  if (periodNo) {
    const alterType = mode === 'suspend' || mode === 'pause' ? 'suspend' : 'terminate';
    const before = await queryPayuniPeriod({ periodTradeNo: periodNo });
    if (!before.ok) {
      if (/不正確|未有|不存在/.test(String(before.message || ''))) {
        return {
          ok: true,
          alreadyStopped: true,
          periodTradeNo: periodNo,
          message: before.message || '查無續期單（視為已停）',
        };
      }
      return {
        ok: false,
        periodTradeNo: periodNo,
        message: before.message || '查詢 PayUNi 續期單失敗',
      };
    }

    const scheduleBefore = summarizePayuniPeriodSchedule(before.data);
    if (scheduleBefore.stopped) {
      return {
        ok: true,
        alreadyStopped: true,
        periodTradeNo: periodNo,
        schedule: scheduleBefore,
        message: 'PayUNi 無待扣排程',
      };
    }

    const alter = await alterPayuniPeriodStatus({ periodTradeNo: periodNo, alterType });
    const after = await queryPayuniPeriod({ periodTradeNo: periodNo });
    const scheduleAfter = after.ok
      ? summarizePayuniPeriodSchedule(after.data)
      : scheduleBefore;

    if (alter.ok || scheduleAfter.stopped) {
      return {
        ok: true,
        periodTradeNo: periodNo,
        alter,
        schedule: scheduleAfter,
        message: alterType === 'suspend' ? 'PayUNi 續期已暫停' : 'PayUNi 續期已終止',
      };
    }

    return {
      ok: false,
      periodTradeNo: periodNo,
      alter,
      schedule: scheduleAfter,
      message:
        `PayUNi 仍有 ${scheduleAfter.pendingCount} 期排程中（PeriodTradeNo=${periodNo}）。` +
        `請至統一金流商店後台「續期收款」終止該單` +
        (alter?.message ? `；異動 API：${alter.message}` : ''),
    };
  }

  const hash = String(sub?.creditHash || '').trim();
  if (hash && !hash.startsWith('PERIOD:')) {
    // 暫停／請假：不可取消 Token（恢復時無法重建）；僅終止才 credit_bind/cancel
    if (mode === 'suspend' || mode === 'pause') {
      return {
        ok: true,
        skipped: true,
        message: '約定 Token 暫停僅本機（未取消 Bind）；終止訂閱才會解綁',
      };
    }
    const result = await postPayuniEncrypted(`${getPayuniApiBase()}/api/credit_bind/cancel`, {
      UseTokenType: '1',
      BindVal: hash,
    });
    return {
      ...result,
      creditHashCancelled: result.ok,
      message: result.ok
        ? '已取消 PayUNi 約定 Token'
        : result.message || '取消約定 Token 失敗',
    };
  }

  return { ok: true, skipped: true, message: '無 PayUNi 續期單／Token 可停' };
}

/**
 * 恢復訂閱時：PayUNi 續期從暫停改回啟用（ReviseTradeStatus=restart）
 * @see https://docs.payuni.com.tw/web/#/7/311
 */
export async function resumePayuniRecurringForSubscription(sub) {
  const periodNo = extractPeriodTradeNo(sub);
  if (!periodNo) {
    return { ok: true, skipped: true, message: '無 PayUNi 續期單可恢復' };
  }

  const before = await queryPayuniPeriod({ periodTradeNo: periodNo });
  if (!before.ok) {
    return {
      ok: false,
      periodTradeNo: periodNo,
      message: before.message || '查詢 PayUNi 續期單失敗',
    };
  }

  const scheduleBefore = summarizePayuniPeriodSchedule(before.data);
  // 已有排程中＝PayUNi 端已在扣，不必再 restart
  if (scheduleBefore.pendingCount > 0) {
    return {
      ok: true,
      alreadyActive: true,
      periodTradeNo: periodNo,
      schedule: scheduleBefore,
      message: 'PayUNi 續期已在排程中',
    };
  }

  const alter = await alterPayuniPeriodStatus({
    periodTradeNo: periodNo,
    alterType: 'restart',
  });
  const after = await queryPayuniPeriod({ periodTradeNo: periodNo });
  const scheduleAfter = after.ok
    ? summarizePayuniPeriodSchedule(after.data)
    : scheduleBefore;

  if (alter.ok || scheduleAfter.pendingCount > 0) {
    return {
      ok: true,
      periodTradeNo: periodNo,
      alter,
      schedule: scheduleAfter,
      message: 'PayUNi 續期已啟用',
    };
  }

  return {
    ok: false,
    periodTradeNo: periodNo,
    alter,
    schedule: scheduleAfter,
    message:
      alter?.message ||
      `PayUNi 續期未能啟用（PeriodTradeNo=${periodNo}）；若訂單已終止無法 restart，需重新約定`,
  };
}

/**
 * 取消信用卡授權（尚未請款）。用於臨櫃續期頁 $1 驗卡授權釋放。
 * @returns {{ ok: boolean, message?: string, raw?: object }}
 */
export async function cancelPayuniAuth({ tradeNo } = {}) {
  const tn = String(tradeNo || '').trim();
  if (!tn) return { ok: false, message: '缺少 TradeNo' };
  return postPayuniEncrypted(getPayuniTradeCancelUrl(), { TradeNo: tn });
}

export function getPayuniTradeCloseUrl() {
  return (
    (process.env.PAYUNI_TRADE_CLOSE_URL || '').trim() ||
    `${getPayuniApiBase()}/api/trade/close`
  );
}

/**
 * 信用卡已請款交易退款（官方 SDK：/api/trade/close，CloseType=2 退款）
 * 已確認：端點、MerID／TradeNo／CloseType／Timestamp 必填。
 * 未經官方文件確認（PAYUNI_REFUND_SPEC_UNVERIFIED）：部分退款金額欄位 CloseAmt、成功回應欄位（以解密 Status=SUCCESS 判定）。
 * 上線前須以 PayUNi 測試環境驗證部分退款；未驗證前可設 PAYUNI_PARTIAL_REFUND=false 讓部分退款改走臨櫃人工。
 * @returns {Promise<{ ok: boolean, status?: string, message?: string, data?: object, ambiguous?: boolean }>}
 */
export async function refundPayuniTrade({ tradeNo, amount, fullAmount } = {}) {
  const tn = String(tradeNo || '').trim();
  const amt = Math.round(Number(amount) || 0);
  if (!tn) return { ok: false, message: '缺少 PayUNi TradeNo' };
  if (!(amt > 0)) return { ok: false, message: '退款金額必須為正整數' };
  const partial = fullAmount != null && amt < Math.round(Number(fullAmount) || 0);
  if (partial && String(process.env.PAYUNI_PARTIAL_REFUND ?? 'true').toLowerCase() === 'false') {
    return { ok: false, message: 'PayUNi 部分退款未啟用（PAYUNI_PARTIAL_REFUND=false），請改臨櫃人工退款' };
  }
  const params = { TradeNo: tn, CloseType: '2' };
  if (partial) params.CloseAmt = String(amt);
  const result = await postPayuniEncrypted(getPayuniTradeCloseUrl(), params);
  return { ...result, ambiguous: !result.ok && !result.status };
}

/**
 * 若 Notify 為臨櫃驗卡小額授權，呼叫 trade_cancel（可用 PAYUNI_BIND_VERIFY_AUTO_CANCEL=false 關閉）
 */
export async function maybeCancelBindVerifyAuth(tradeData = {}) {
  const enabled =
    String(process.env.PAYUNI_BIND_VERIFY_AUTO_CANCEL ?? 'true').toLowerCase() !== 'false';
  if (!enabled) return { skipped: true, reason: 'disabled' };
  if (!isBindVerifyAuthNotify(tradeData)) {
    return { skipped: true, reason: 'not_verify_auth' };
  }
  const tradeNo = String(tradeData.TradeNo || '').trim();
  const result = await cancelPayuniAuth({ tradeNo });
  if (result.ok) {
    console.log(`[PayUNi] 驗卡授權已取消 TradeNo=${tradeNo} AuthAmt=${tradeData.AuthAmt ?? tradeData.FAmt}`);
  } else {
    console.error(
      `[PayUNi] 驗卡授權取消失敗 TradeNo=${tradeNo}：${result.message}（請人工於後台取消授權，避免請款）`,
    );
  }
  return { skipped: false, tradeNo, ...result };
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
