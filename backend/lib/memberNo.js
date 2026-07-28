// lib/memberNo.js — 對外會員編號（隨機 6 碼大寫英數；內部 PK 仍用 Int id）
import crypto from 'crypto';
import prisma from './prisma.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MEMBER_NO_LEN = 6;
const MEMBER_NO_RE = /^[A-Z0-9]{6}$/;

function randomCode(len = MEMBER_NO_LEN) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/** 產生候選編號：隨機 6 碼大寫英數混合 */
export function buildMemberNoCandidate() {
  return randomCode(MEMBER_NO_LEN);
}

export function isValidMemberNo(raw) {
  return MEMBER_NO_RE.test(String(raw || '').trim().toUpperCase());
}

/**
 * 配置唯一會員編號（碰撞時重試）
 * @param {import('@prisma/client').Prisma.TransactionClient | typeof prisma} [db]
 */
export async function allocateUniqueMemberNo(db = prisma) {
  for (let i = 0; i < 24; i += 1) {
    const memberNo = buildMemberNoCandidate();
    const exists = await db.member.findUnique({
      where: { memberNo },
      select: { id: true },
    });
    if (!exists) return memberNo;
  }
  const err = new Error('無法配置唯一會員編號，請重試');
  err.statusCode = 500;
  throw err;
}

/**
 * 為缺少編號、或非現行 6 碼格式的會員補發／改號
 */
export async function backfillMissingMemberNos(db = prisma) {
  const rows = await db.member.findMany({
    select: { id: true, memberNo: true },
    orderBy: { id: 'asc' },
  });
  let updated = 0;
  for (const row of rows) {
    if (isValidMemberNo(row.memberNo)) continue;
    const memberNo = await allocateUniqueMemberNo(db);
    await db.member.update({
      where: { id: row.id },
      data: { memberNo },
    });
    updated += 1;
  }
  return updated;
}
