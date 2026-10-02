// lib/signedToken.js — 後端簽發之短效憑證（base64url(JSON).HMAC-SHA256）；金鑰由 JWT_SECRET＋用途衍生，不同用途互不通用
import crypto from 'node:crypto';

function keyFor(purpose) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error('JWT_SECRET 未設定');
    err.statusCode = 500;
    err.code = 'SERVER_MISCONFIGURED';
    throw err;
  }
  return crypto.createHash('sha256').update(`${purpose}:${secret}`).digest();
}

/** payload 必須含 exp（epoch ms） */
export function signToken(purpose, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', keyFor(purpose)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** 回傳 { payload, expired }；簽章或格式不符回 null */
export function readToken(purpose, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto.createHmac('sha256', keyFor(purpose)).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || !payload.exp) return null;
  return { payload, expired: Date.now() > payload.exp };
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
