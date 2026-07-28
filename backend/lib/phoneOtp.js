// lib/phoneOtp.js — 手機 OTP 產生／驗證（可接簡訊；未設定時支援開發揭示）
import crypto from 'crypto';
import prisma from './prisma.js';
import { normalizePhone } from './memberIdentify.js';

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

export function assertTaiwanMobile(raw) {
  const phone = normalizePhone(raw);
  if (!/^09\d{8}$/.test(phone)) {
    const err = new Error('請輸入有效的台灣手機號碼（09 開頭共 10 碼）');
    err.statusCode = 400;
    throw err;
  }
  return phone;
}

function hashCode(phone, code) {
  const secret = process.env.JWT_SECRET || 'otp';
  return crypto.createHash('sha256').update(`${phone}:${code}:${secret}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

/** 發送（或開發模式揭示）OTP */
export async function sendPhoneOtp(rawPhone, purpose, { memberId } = {}) {
  const phone = assertTaiwanMobile(rawPhone);
  const p = String(purpose || '').toUpperCase();
  if (p !== 'LOGIN' && p !== 'REGISTER') {
    const err = new Error('purpose 僅允許 LOGIN 或 REGISTER');
    err.statusCode = 400;
    throw err;
  }

  const latest = await prisma.phoneOtp.findFirst({
    where: { phone, purpose: p, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (latest && Date.now() - new Date(latest.createdAt).getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil(
      (RESEND_COOLDOWN_MS - (Date.now() - new Date(latest.createdAt).getTime())) / 1000,
    );
    const err = new Error(`請稍候 ${wait} 秒再重新發送驗證碼`);
    err.statusCode = 429;
    throw err;
  }

  const code = generateCode();
  const row = await prisma.phoneOtp.create({
    data: {
      phone,
      purpose: p,
      codeHash: hashCode(phone, code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      memberId: memberId ?? null,
    },
  });

  // 正式環境：在此串接簡訊閘道。禁止記錄 OTP 明碼。
  const masked = `${phone.slice(0, 3)}****${phone.slice(-3)}`;
  console.info(`[OTP] phone=${masked} purpose=${p} id=${row.id}`);

  const revealFlag = String(process.env.OTP_DEV_REVEAL || '').toLowerCase() === 'true';
  const reveal = !isProd && revealFlag;
  return {
    phone,
    expiresInSec: Math.floor(OTP_TTL_MS / 1000),
    ...(reveal ? { devCode: code } : {}),
    message: reveal
      ? `開發模式：驗證碼 ${code}`
      : '驗證碼已發送，請於 5 分鐘內輸入',
  };
}

/** 驗證成功回傳 phone（已正規化） */
export async function verifyPhoneOtp(rawPhone, codeRaw, purpose) {
  const phone = assertTaiwanMobile(rawPhone);
  const p = String(purpose || '').toUpperCase();
  const code = String(codeRaw || '').trim();
  if (!/^\d{6}$/.test(code)) {
    const err = new Error('請輸入 6 碼驗證碼');
    err.statusCode = 400;
    throw err;
  }

  const row = await prisma.phoneOtp.findFirst({
    where: { phone, purpose: p, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) {
    const err = new Error('請先取得驗證碼');
    err.statusCode = 400;
    throw err;
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    const err = new Error('驗證碼已過期，請重新發送');
    err.statusCode = 400;
    throw err;
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    const err = new Error('驗證次數過多，請重新發送驗證碼');
    err.statusCode = 400;
    throw err;
  }

  const ok = row.codeHash === hashCode(phone, code);
  if (!ok) {
    await prisma.phoneOtp.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    const err = new Error('驗證碼錯誤');
    err.statusCode = 400;
    throw err;
  }

  await prisma.phoneOtp.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });

  return phone;
}
