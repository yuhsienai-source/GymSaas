// lib/staffLineBinding.js — 員工 LINE 推播綁定（LINE Login，僅取 userId 作收件人，禁止用於登入）
/**
 * state＝HMAC 簽章之 { sid, exp, nonce }，10 分鐘有效、單次使用；
 * 換綁時 sid 必須等於呼叫者員工 JWT staffId，防止他人以自身 LINE 綁到別人帳號。
 */
import crypto from 'crypto';
import prisma from './prisma.js';
import { buildFrontendRedirect } from './frontendUrl.js';
import { buildLineAuthorizeUrl, lineLoginConfigured, lineProfileFromCode } from './lineLogin.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const usedNonces = new Map();

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function stateKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw httpError('JWT_SECRET 未設定', 500);
  return crypto.createHash('sha256').update(`staff-line-bind:${secret}`).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url');
}

export function staffLineCallbackUrl() {
  const explicit = String(process.env.LINE_STAFF_CALLBACK_URL || '').trim();
  if (explicit) return explicit;
  try {
    return buildFrontendRedirect('/staff/line/callback');
  } catch {
    return null;
  }
}

function pruneNonces(now = Date.now()) {
  for (const [nonce, exp] of usedNonces) if (exp < now) usedNonces.delete(nonce);
}

function issueState(staffId) {
  const payload = Buffer.from(
    JSON.stringify({ sid: staffId, exp: Date.now() + STATE_TTL_MS, nonce: crypto.randomBytes(12).toString('hex') }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function consumeState(state, staffId) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) throw httpError('綁定連結無效，請重新操作', 400, 'LINE_BIND_STATE_INVALID');
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw httpError('綁定連結無效，請重新操作', 400, 'LINE_BIND_STATE_INVALID');
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw httpError('綁定連結無效，請重新操作', 400, 'LINE_BIND_STATE_INVALID');
  }
  const now = Date.now();
  if (!data?.exp || data.exp < now) throw httpError('綁定連結已過期，請重新操作', 400, 'LINE_BIND_STATE_EXPIRED');
  if (data.sid !== staffId) throw httpError('綁定連結與目前登入員工不符', 403, 'LINE_BIND_STATE_MISMATCH');
  pruneNonces(now);
  if (usedNonces.has(data.nonce)) throw httpError('綁定連結已使用，請重新操作', 400, 'LINE_BIND_STATE_USED');
  usedNonces.set(data.nonce, data.exp);
}

export function lineStatusView(staff) {
  return {
    bound: Boolean(staff?.lineUserId),
    displayName: staff?.lineDisplayName || null,
    boundAt: staff?.lineBoundAt || null,
    notifyEnabled: staff?.lineNotifyEnabled !== false,
    loginConfigured: lineLoginConfigured() && Boolean(staffLineCallbackUrl()),
    pushConfigured: Boolean(String(process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim()),
  };
}

const STATUS_SELECT = { id: true, lineUserId: true, lineDisplayName: true, lineBoundAt: true, lineNotifyEnabled: true };

export async function getStaffLineStatus(staffId) {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: STATUS_SELECT });
  if (!staff) throw httpError('找不到員工', 404);
  return lineStatusView(staff);
}

export function createStaffLineBindUrl(staffId) {
  const redirectUri = staffLineCallbackUrl();
  if (!lineLoginConfigured() || !redirectUri) {
    throw httpError('尚未設定 LINE Login（LINE_CHANNEL_ID／SECRET）', 503, 'LINE_NOT_CONFIGURED');
  }
  const state = issueState(staffId);
  return { url: buildLineAuthorizeUrl({ redirectUri, state, scope: 'profile openid' }) };
}

export async function bindStaffLine(staffId, { code, state }) {
  if (!code) throw httpError('缺少授權碼', 400);
  consumeState(state, staffId);
  const profile = await lineProfileFromCode(String(code), staffLineCallbackUrl());

  const taken = await prisma.staff.findUnique({ where: { lineUserId: profile.sub }, select: { id: true } });
  if (taken && taken.id !== staffId) {
    throw httpError('此 LINE 帳號已綁定其他員工', 409, 'LINE_ALREADY_BOUND');
  }
  try {
    const staff = await prisma.staff.update({
      where: { id: staffId },
      data: {
        lineUserId: profile.sub,
        lineDisplayName: profile.name ? String(profile.name).slice(0, 80) : null,
        lineBoundAt: new Date(),
        lineNotifyEnabled: true,
      },
      select: STATUS_SELECT,
    });
    return lineStatusView(staff);
  } catch (err) {
    if (err?.code === 'P2002') throw httpError('此 LINE 帳號已綁定其他員工', 409, 'LINE_ALREADY_BOUND');
    throw err;
  }
}

export async function unbindStaffLine(staffId) {
  const staff = await prisma.staff.update({
    where: { id: staffId },
    data: { lineUserId: null, lineDisplayName: null, lineBoundAt: null },
    select: STATUS_SELECT,
  });
  return lineStatusView(staff);
}

export async function setStaffLineNotify(staffId, enabled) {
  if (typeof enabled !== 'boolean') throw httpError('notifyEnabled 須為布林值', 400);
  const staff = await prisma.staff.update({
    where: { id: staffId },
    data: { lineNotifyEnabled: enabled },
    select: STATUS_SELECT,
  });
  return lineStatusView(staff);
}
