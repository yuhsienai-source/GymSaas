// lib/qrToken.js — 門禁動態 QR：HMAC-SHA256 防截圖簽章
import crypto from 'crypto';

const QR_SECRET_KEY = process.env.QR_SECRET_KEY || process.env.JWT_SECRET || 'GymSaaS_Super_Secret_Key_2026';
export const QR_TTL_MS = 30_000; // 30 秒防截圖時效
/** 閘機／手機時鐘漂移容許（±秒） */
export const QR_SKEW_MS = Number(process.env.QR_SKEW_MS) || 5_000;

/**
 * 產生動態進場 QR Token
 * 格式：Base64(JSON payload).HMAC-SHA256
 */
export function signGateQrToken({ memberId, deviceId }) {
  const timestamp = Date.now();
  const payload = { memberId, deviceId, timestamp };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha256', QR_SECRET_KEY)
    .update(JSON.stringify(payload))
    .digest('hex');

  return {
    qrToken: `${payloadBase64}.${signature}`,
    expiresInMs: QR_TTL_MS,
    timestamp,
  };
}

/**
 * 驗證動態進場 QR Token（簽章 + 30 秒時效）
 * @returns {{ memberId: number, deviceId: string|null }}
 */
export function verifyGateQrToken(qrToken) {
  if (!qrToken || typeof qrToken !== 'string') {
    const err = new Error('請出示門禁條碼');
    err.code = 'QR_MISSING';
    throw err;
  }

  const parts = qrToken.split('.');
  if (parts.length !== 2) {
    const err = new Error('閘門拒絕：無效或偽造的 QR Code');
    err.code = 'QR_INVALID';
    throw err;
  }

  const [payloadBase64, signature] = parts;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
  } catch {
    const err = new Error('閘門拒絕：無效或偽造的 QR Code');
    err.code = 'QR_INVALID';
    throw err;
  }

  const expected = crypto
    .createHmac('sha256', QR_SECRET_KEY)
    .update(JSON.stringify(payload))
    .digest('hex');

  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    const err = new Error('閘門拒絕：無效或偽造的 QR Code');
    err.code = 'QR_INVALID';
    throw err;
  }

  const { memberId, deviceId = null, timestamp } = payload;

  if (!memberId || typeof timestamp !== 'number') {
    const err = new Error('閘門拒絕：無效或偽造的 QR Code');
    err.code = 'QR_INVALID';
    throw err;
  }

  if (Date.now() - timestamp > QR_TTL_MS + QR_SKEW_MS) {
    const err = new Error('⛔ 條碼已過期 (超過30秒)，請重新整理畫面產生新條碼 (防截圖機制)');
    err.code = 'QR_EXPIRED';
    throw err;
  }

  // 拒絕未來時間戳（防時鐘竄改；允許 ± skew）
  if (timestamp > Date.now() + QR_SKEW_MS) {
    const err = new Error('閘門拒絕：無效或偽造的 QR Code');
    err.code = 'QR_INVALID';
    throw err;
  }

  return { memberId: Number(memberId), deviceId };
}
