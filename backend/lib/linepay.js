// lib/linepay.js — LINE Pay：會員端 Online v3；臨櫃 POS Offline v4（oneTimeKey）
import crypto from 'crypto';
import { getPayuniNotifyBaseUrl } from './payuni.js';
import { getFrontendBaseUrl } from './frontendUrl.js';

const CHANNEL_ID = (process.env.LINEPAY_CHANNEL_ID || '').trim();
const CHANNEL_SECRET = (process.env.LINEPAY_CHANNEL_SECRET || '').trim();
const DEVICE_PROFILE = (process.env.LINEPAY_DEVICE_PROFILE_ID || '').trim();
const SANDBOX =
  String(process.env.LINEPAY_SANDBOX || 'true').toLowerCase() !== 'false';
const BASE_URL = SANDBOX
  ? 'https://sandbox-api-pay.line.me'
  : 'https://api-pay.line.me';

/** 沙盒產生測試用 My Code（臨櫃 POS） */
export const LINEPAY_SANDBOX_ONETIME_KEY_URL =
  'https://sandbox-web-pay.line.me/web/sandbox/payment/oneTimeKey?countryCode=TW';

export function isLinePayConfigured() {
  return Boolean(CHANNEL_ID && CHANNEL_SECRET);
}

export function isLinePaySandbox() {
  return SANDBOX;
}

function assertConfigured() {
  if (!isLinePayConfigured()) {
    const err = new Error(
      'LinePay 未設定：請於 backend/.env 填 LINEPAY_CHANNEL_ID、LINEPAY_CHANNEL_SECRET',
    );
    err.statusCode = 500;
    throw err;
  }
}

function sign(channelSecret, message) {
  return crypto.createHmac('sha256', channelSecret).update(message).digest('base64');
}

async function linePayRequest(method, apiPath, body = null, queryString = '') {
  assertConfigured();
  const nonce = crypto.randomUUID();
  const bodyStr = body ? JSON.stringify(body) : '';
  const message =
    method === 'GET'
      ? `${CHANNEL_SECRET}${apiPath}${queryString}${nonce}`
      : `${CHANNEL_SECRET}${apiPath}${bodyStr}${nonce}`;
  const signature = sign(CHANNEL_SECRET, message);

  const headers = {
    'Content-Type': 'application/json',
    'X-LINE-ChannelId': CHANNEL_ID,
    'X-LINE-Authorization': signature,
    'X-LINE-Authorization-Nonce': nonce,
  };
  if (DEVICE_PROFILE) {
    headers['X-LINE-MerchantDeviceProfileId'] = DEVICE_PROFILE;
  }

  const qs = queryString ? (queryString.startsWith('?') ? queryString : `?${queryString}`) : '';
  const res = await fetch(`${BASE_URL}${apiPath}${qs}`, {
    method,
    headers,
    body: body ? bodyStr : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`LinePay 回應非 JSON：${text.slice(0, 200)}`);
    err.statusCode = 502;
    throw err;
  }
  return data;
}

function callbackBase() {
  try {
    return getPayuniNotifyBaseUrl();
  } catch {
    return getFrontendBaseUrl();
  }
}

/**
 * 會員端：Online API v3 導向付款
 * @returns {{ paymentUrl: string, transactionId: string }}
 */
export async function requestLinePayOnlinePayment({
  orderId,
  amount,
  productName,
  confirmPath = '/api/ops/linepay/confirm',
  cancelPath = '/api/ops/linepay/cancel',
  client = 'ops',
}) {
  const amt = Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('LinePay 金額無效');
    err.statusCode = 400;
    throw err;
  }

  const base = callbackBase().replace(/\/$/, '');
  const name = String(productName || '體育客消費').slice(0, 100);
  const clientQ = client ? `?client=${encodeURIComponent(client)}` : '';
  const body = {
    amount: amt,
    currency: 'TWD',
    orderId: String(orderId),
    packages: [
      {
        id: String(orderId).slice(0, 50),
        amount: amt,
        products: [
          {
            name,
            quantity: 1,
            price: amt,
          },
        ],
      },
    ],
    redirectUrls: {
      confirmUrl: `${base}${confirmPath}${clientQ}`,
      cancelUrl: `${base}${cancelPath}${clientQ}`,
    },
  };

  const apiPath = '/v3/payments/request';
  const result = await linePayRequest('POST', apiPath, body);

  if (String(result.returnCode) !== '0000') {
    const err = new Error(
      `LinePay 建立失敗：${result.returnCode} ${result.returnMessage || ''}`.trim(),
    );
    err.statusCode = 502;
    err.linePay = result;
    throw err;
  }

  const info = result.info || {};
  const paymentUrl =
    info.paymentUrl?.web || info.paymentUrl?.app || info.paymentUrl || null;
  const transactionId = info.transactionId != null ? String(info.transactionId) : null;

  if (!paymentUrl || !transactionId) {
    const err = new Error('LinePay 回應缺少 paymentUrl／transactionId');
    err.statusCode = 502;
    throw err;
  }

  console.log(`[LinePay:online] request order=${orderId} tx=${transactionId}`);
  return { paymentUrl, transactionId, raw: result, mode: 'ONLINE' };
}

/** @deprecated 請改用 requestLinePayOnlinePayment */
export async function requestLinePayPayment(opts) {
  return requestLinePayOnlinePayment(opts);
}

/**
 * 臨櫃 POS：Offline API v4 — 掃會員 LinePay「付款碼／My Code」即完成扣款
 * @see https://developers-pay.line.me/offline-api-v4/request-payment
 */
export async function payLinePayPosWithOneTimeKey({
  orderId,
  amount,
  productName,
  oneTimeKey,
  branchId,
  branchName,
}) {
  const amt = Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('LinePay 金額無效');
    err.statusCode = 400;
    throw err;
  }

  const key = String(oneTimeKey || '').trim();
  if (!key || key.length < 8) {
    const err = new Error('請掃描或輸入會員 LinePay 付款碼（My Code）');
    err.statusCode = 400;
    throw err;
  }

  const name = String(productName || '體育客臨櫃').slice(0, 100);
  const body = {
    amount: amt,
    currency: 'TWD',
    orderId: String(orderId),
    oneTimeKey: key,
    productName: name,
    packages: [
      {
        id: String(orderId).slice(0, 50),
        amount: amt,
        products: [{ name, quantity: 1, price: amt }],
      },
    ],
  };

  if (branchId || branchName) {
    body.options = {
      extra: {
        ...(branchId ? { branchId: String(branchId) } : {}),
        ...(branchName ? { branchName: String(branchName).slice(0, 100) } : {}),
      },
    };
  }

  const apiPath = '/v4/payments/oneTimeKeys/pay';
  const result = await linePayRequest('POST', apiPath, body);

  if (String(result.returnCode) !== '0000') {
    const hint =
      SANDBOX && String(result.returnCode) === '1133'
        ? `（沙盒請用 ${LINEPAY_SANDBOX_ONETIME_KEY_URL} 產生測試碼，不可用真實 App）`
        : '';
    const err = new Error(
      `LinePay POS 失敗：${result.returnCode} ${result.returnMessage || ''}${hint}`.trim(),
    );
    err.statusCode = 502;
    err.linePay = result;
    throw err;
  }

  const info = result.info || {};
  const transactionId =
    info.transactionId != null
      ? String(info.transactionId)
      : info.transaction?.transactionId != null
        ? String(info.transaction.transactionId)
        : null;

  console.log(`[LinePay:pos] order=${orderId} tx=${transactionId || 'n/a'}`);
  return {
    transactionId: transactionId || `POS:${orderId}`,
    raw: result,
    mode: 'POS',
  };
}

/**
 * LinePay 退款（Online／POS 交易號皆可）
 * @see https://developers-pay.line.me/online-api-v3/refund-payment
 */
export async function refundLinePayPayment({ transactionId, refundAmount }) {
  const txId = String(transactionId || '').trim();
  if (!txId) {
    const err = new Error('缺少 LinePay transactionId，無法退款');
    err.statusCode = 400;
    throw err;
  }
  const amt = Math.round(Number(refundAmount));
  if (!Number.isFinite(amt) || amt <= 0) {
    const err = new Error('LinePay 退款金額無效');
    err.statusCode = 400;
    throw err;
  }

  const apiPath = `/v3/payments/${encodeURIComponent(txId)}/refund`;
  const result = await linePayRequest('POST', apiPath, {
    refundAmount: amt,
  });

  if (String(result.returnCode) !== '0000') {
    const err = new Error(
      `LinePay 退款失敗：${result.returnCode} ${result.returnMessage || ''}`.trim(),
    );
    err.statusCode = 502;
    err.linePay = result;
    throw err;
  }

  console.log(`[LinePay:refund] tx=${txId} amount=${amt}`);
  return result;
}

/**
 * 會員端 Online：ConfirmURL 確認扣款
 */
export async function confirmLinePayPayment({ transactionId, amount }) {
  const amt = Math.round(Number(amount));
  const apiPath = `/v3/payments/${encodeURIComponent(String(transactionId))}/confirm`;
  const result = await linePayRequest('POST', apiPath, {
    amount: amt,
    currency: 'TWD',
  });

  if (String(result.returnCode) !== '0000') {
    const err = new Error(
      `LinePay 確認失敗：${result.returnCode} ${result.returnMessage || ''}`.trim(),
    );
    err.statusCode = 502;
    err.linePay = result;
    throw err;
  }

  return result;
}
