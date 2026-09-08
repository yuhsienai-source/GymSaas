// lib/memberPassword.js — 會員帳密（對齊健身工廠：會員帳號＝E-mail；相容手機／會員編號）
import bcrypt from 'bcrypt';
import prisma from './prisma.js';
import { normalizePhone } from './memberIdentify.js';
import { isValidMemberNo } from './memberNo.js';

const BCRYPT_ROUNDS = 10;
const MIN_LEN = 8;
const MAX_LEN = 72;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeMemberEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    const err = new Error('請輸入有效的 E-mail');
    err.statusCode = 400;
    throw err;
  }
  return email;
}

export function tryNormalizeMemberEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) return null;
  return email;
}

export function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return null;
  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  const u =
    user.length <= 2 ? `${user[0] || '*'}*` : `${user[0]}${'*'.repeat(Math.min(user.length - 2, 4))}${user[user.length - 1]}`;
  return `${u}@${domain}`;
}

export function validateMemberPassword(raw) {
  const password = String(raw || '');
  if (password.length < MIN_LEN || password.length > MAX_LEN) {
    const err = new Error(`密碼須為 ${MIN_LEN}～${MAX_LEN} 字元`);
    err.statusCode = 400;
    throw err;
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    const err = new Error('密碼須同時包含英文字母與數字');
    err.statusCode = 400;
    throw err;
  }
  return password;
}

export async function hashMemberPassword(raw) {
  const password = validateMemberPassword(raw);
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyMemberPassword(member, raw) {
  const hash = String(member?.passwordHash || '');
  if (!hash) return false;
  return bcrypt.compare(String(raw || ''), hash);
}

/**
 * 以 E-mail（優先）、手機或會員編號找會員（登入／忘記密碼）
 * 查無回 null；呼叫端勿區分「無此帳」與「密碼錯」以外的細節洩漏
 */
export async function findMemberByLoginAccount(accountRaw) {
  const account = String(accountRaw || '').trim();
  if (!account) return null;

  const email = tryNormalizeMemberEmail(account);
  if (email) {
    return prisma.member.findUnique({ where: { email } });
  }

  const phone = normalizePhone(account);
  if (/^09\d{8}$/.test(phone)) {
    return prisma.member.findUnique({ where: { phone } });
  }

  const no = account.toUpperCase();
  if (isValidMemberNo(no)) {
    return prisma.member.findUnique({ where: { memberNo: no } });
  }

  if (/^\d{10}$/.test(account) && account.startsWith('09')) {
    return prisma.member.findUnique({ where: { phone: account } });
  }

  return null;
}

export function memberHasPassword(member) {
  return Boolean(member?.passwordHash);
}
