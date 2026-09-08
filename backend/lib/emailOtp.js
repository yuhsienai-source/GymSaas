// lib/emailOtp.js — Email OTP（僅存 hash；禁明碼寫入 log／DB 可讀欄位）
import crypto from 'crypto';
import prisma from './prisma.js';
import { sendMail, isMailConfigured } from './mailer.js';
import { buildOtpMailCopy } from './emailOtpTemplate.js';

const OTP_TTL_MS = 4 * 60 * 1000; // 4 分鐘（3～5 分鐘區間）
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 3;
const PURPOSE_DEVICE_RESET = 'DEVICE_RESET';
const PURPOSE_LOGIN = 'LOGIN';
const PURPOSE_REGISTER = 'REGISTER';
const PURPOSE_EMAIL_ENROLL = 'EMAIL_ENROLL';
const ALLOWED_PURPOSES = new Set([
  PURPOSE_DEVICE_RESET,
  PURPOSE_LOGIN,
  PURPOSE_REGISTER,
  PURPOSE_EMAIL_ENROLL,
]);
const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

export function normalizeEmail(raw) {
  const email = String(raw || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError('請輸入有效的 Email');
  }
  return email;
}

function hashCode(email, code) {
  const secret = process.env.JWT_SECRET || 'otp';
  return crypto.createHash('sha256').update(`${email}:${code}:${secret}`).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

function maskEmail(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at < 1) return '***';
  const user = e.slice(0, at);
  const domain = e.slice(at);
  const keep = Math.min(2, user.length);
  return `${user.slice(0, keep)}***${domain}`;
}

function mailCopy(purpose, code) {
  return buildOtpMailCopy({
    purpose,
    code,
    expiresInMin: Math.max(1, Math.round(OTP_TTL_MS / 60000)),
  });
}

/**
 * 發送 Email OTP（明碼僅出現在郵件本文；禁 console／NotificationLog body）
 * @returns {{ email: string, maskedEmail: string, expiresInSec: number, message: string, mock?: boolean, devCode?: string }}
 */
export async function sendEmailOtp(rawEmail, purpose, { memberId } = {}) {
  const email = normalizeEmail(rawEmail);
  const p = String(purpose || '').toUpperCase();
  if (!ALLOWED_PURPOSES.has(p)) {
    throw httpError('不支援的 Email OTP 用途');
  }

  const latest = await prisma.emailOtp.findFirst({
    where: { email, purpose: p, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (latest && Date.now() - new Date(latest.createdAt).getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil(
      (RESEND_COOLDOWN_MS - (Date.now() - new Date(latest.createdAt).getTime())) / 1000,
    );
    throw httpError(`請稍候 ${wait} 秒再重新發送驗證碼`, 429);
  }

  const code = generateCode();
  const row = await prisma.emailOtp.create({
    data: {
      email,
      purpose: p,
      codeHash: hashCode(email, code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      memberId: memberId ?? null,
    },
  });

  // 僅記錄遮罩；嚴禁輸出驗證碼明碼
  console.info(`[EmailOTP] email=${maskEmail(email)} purpose=${p} id=${row.id}`);

  const copy = mailCopy(p, code);
  const mailed = await sendMail({
    to: email,
    subject: copy.subject,
    text: copy.text,
    html: copy.html,
    memberId: memberId ?? undefined,
    kind: copy.kind,
    omitBodyFromLog: true,
  });

  if (!mailed.ok && !mailed.mock) {
    throw httpError(mailed.message || '驗證信發送失敗，請稍後再試或洽櫃檯', 502);
  }

  const revealFlag = String(process.env.OTP_DEV_REVEAL || '').toLowerCase() === 'true';
  // 僅登入／註冊／Email 補登允許非正式環境揭示；換機一律不揭示
  const reveal =
    !isProd &&
    revealFlag &&
    (p === PURPOSE_LOGIN || p === PURPOSE_REGISTER || p === PURPOSE_EMAIL_ENROLL);

  return {
    email,
    maskedEmail: maskEmail(email),
    expiresInSec: Math.floor(OTP_TTL_MS / 1000),
    ...(reveal ? { devCode: code } : {}),
    message: reveal
      ? `開發模式：驗證碼 ${code}`
      : isMailConfigured()
        ? `驗證碼已寄至 ${maskEmail(email)}，請於 4 分鐘內輸入`
        : `（開發）SMTP 未設定：驗證信改為 mock；請設定 SMTP 或開啟 OTP_DEV_REVEAL`,
    mock: Boolean(mailed.mock),
  };
}

/**
 * 驗證 Email OTP；錯誤達 3 次立即作廢
 */
export async function verifyEmailOtp(rawEmail, codeRaw, purpose) {
  const email = normalizeEmail(rawEmail);
  const p = String(purpose || '').toUpperCase();
  const code = String(codeRaw || '').trim();
  if (!/^\d{6}$/.test(code)) {
    throw httpError('請輸入 6 碼驗證碼');
  }

  const row = await prisma.emailOtp.findFirst({
    where: { email, purpose: p, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) {
    throw httpError('請先取得驗證碼');
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await prisma.emailOtp.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    throw httpError('驗證碼已過期，請重新發送');
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await prisma.emailOtp.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    throw httpError('驗證次數過多，驗證碼已作廢，請重新發送', 400, 'OTP_LOCKED');
  }

  const ok = row.codeHash === hashCode(email, code);
  if (!ok) {
    const nextAttempts = row.attempts + 1;
    await prisma.emailOtp.update({
      where: { id: row.id },
      data: {
        attempts: { increment: 1 },
        ...(nextAttempts >= MAX_ATTEMPTS ? { consumedAt: new Date() } : {}),
      },
    });
    if (nextAttempts >= MAX_ATTEMPTS) {
      throw httpError('驗證次數過多，驗證碼已作廢，請重新發送', 400, 'OTP_LOCKED');
    }
    throw httpError(`驗證碼錯誤（剩餘 ${MAX_ATTEMPTS - nextAttempts} 次）`);
  }

  await prisma.emailOtp.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });

  return email;
}

export {
  PURPOSE_DEVICE_RESET,
  PURPOSE_LOGIN,
  PURPOSE_REGISTER,
  PURPOSE_EMAIL_ENROLL,
  maskEmail,
  OTP_TTL_MS,
  MAX_ATTEMPTS,
};
