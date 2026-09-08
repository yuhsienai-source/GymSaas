// lib/captcha.js — 簡易圖形驗證碼（登入／註冊防刷；記憶體存放）
import crypto from 'crypto';

const TTL_MS = 5 * 60 * 1000;
const store = new Map();

function purgeExpired() {
  const now = Date.now();
  for (const [id, row] of store) {
    if (row.expiresAt <= now) store.delete(id);
  }
}

function randomCode(len = 4) {
  // 對齊健身工廠：4 位數字驗證碼
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += String(bytes[i] % 10);
  }
  return out;
}

function svgCaptcha(text) {
  const w = 140;
  const h = 48;
  const chars = String(text).split('');
  const letters = chars
    .map((ch, i) => {
      const x = 18 + i * 28;
      const y = 30 + ((i % 2) * 4 - 2);
      const rot = (i % 3) * 6 - 6;
      return `<text x="${x}" y="${y}" transform="rotate(${rot} ${x} ${y})" font-size="22" font-family="ui-monospace, monospace" font-weight="700" fill="#103D4A">${ch}</text>`;
    })
    .join('');
  const noise = Array.from({ length: 5 }, (_, i) => {
    const x1 = 5 + i * 25;
    const y1 = 8 + (i % 3) * 12;
    const x2 = x1 + 40;
    const y2 = y1 + 10;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#c5d0d5" stroke-width="1"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="驗證碼">
  <rect width="100%" height="100%" fill="#f3f6f7"/>
  ${noise}
  ${letters}
</svg>`;
}

export function createCaptchaChallenge() {
  purgeExpired();
  const id = crypto.randomBytes(16).toString('hex');
  const code = randomCode(4);
  store.set(id, {
    codeHash: crypto.createHash('sha256').update(code.toUpperCase()).digest('hex'),
    expiresAt: Date.now() + TTL_MS,
  });
  const svg = svgCaptcha(code);
  const imageDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  return { captchaId: id, imageDataUrl, expiresInSec: Math.floor(TTL_MS / 1000) };
}

export function consumeCaptcha(captchaId, captchaCode) {
  purgeExpired();
  const id = String(captchaId || '').trim();
  const code = String(captchaCode || '').trim().toUpperCase();
  if (!id || !code) {
    const err = new Error('請輸入驗證碼');
    err.statusCode = 400;
    throw err;
  }
  const row = store.get(id);
  store.delete(id);
  if (!row || row.expiresAt <= Date.now()) {
    const err = new Error('驗證碼已失效，請重新取得');
    err.statusCode = 400;
    throw err;
  }
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  if (hash !== row.codeHash) {
    const err = new Error('驗證碼錯誤');
    err.statusCode = 400;
    throw err;
  }
  return true;
}
