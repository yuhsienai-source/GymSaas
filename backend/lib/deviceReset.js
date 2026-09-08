// lib/deviceReset.js — 雙重核對＋Email OTP 換機（禁 SMS；守則 4.2／5／5.1）
import jwt from 'jsonwebtoken';
import prisma from './prisma.js';
import { assertMemberSignedNewMemberContract } from './memberContract.js';
import {
  deviceBindUpdateData,
  deviceBindUpdateIfChanged,
  memberTokenDeviceOpts,
  normalizeDeviceId,
  readRequestDeviceId,
} from './memberDevice.js';
import { writeMemberDeviceAuditLog } from './memberDeviceAudit.js';
import { issueMemberToken } from './onboardingAuth.js';
import { assertMemberPhone } from './phoneOtp.js';
import {
  PURPOSE_DEVICE_RESET,
  maskEmail,
  normalizeEmail,
  sendEmailOtp,
  verifyEmailOtp,
} from './emailOtp.js';

const RESET_TICKET_TTL_SEC = 10 * 60;
const DAILY_OTP_MAX = 5;
/** 自助換機冷卻（小時）；預設 24 小時內僅 1 次實際改綁 */
const SELF_SWITCH_COOLDOWN_HOURS = Math.max(
  1,
  Number(process.env.DEVICE_RESET_COOLDOWN_HOURS) || 24,
);
/** 自助換機滾動 30 日上限；預設 2 次（超過須櫃檯 DUTY+） */
const SELF_SWITCH_MONTHLY_MAX = Math.max(
  1,
  Number(process.env.DEVICE_RESET_MONTHLY_MAX) || 2,
);
/** 對外統一文案，避免掃庫反查在籍 Email／證件 */
const IDENTITY_MISMATCH_MSG = '身分資料與 Email 不符，請確認後再試或洽櫃檯臨櫃重置';

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw httpError('伺服器未設定 JWT_SECRET', 500);
  return s;
}

/** 短時換機票：內嵌 memberId，禁止前端直傳 memberId */
export function issueDeviceResetTicket(memberId) {
  return jwt.sign(
    { typ: 'device_reset', memberId: Number(memberId) },
    jwtSecret(),
    { expiresIn: RESET_TICKET_TTL_SEC },
  );
}

export function verifyDeviceResetTicket(token) {
  try {
    const payload = jwt.verify(String(token || ''), jwtSecret());
    if (payload?.typ !== 'device_reset' || !Number.isInteger(payload.memberId)) {
      throw httpError('換機憑證無效', 401, 'RESET_TICKET_INVALID');
    }
    return { memberId: payload.memberId };
  } catch (e) {
    if (e.statusCode) throw e;
    throw httpError('換機憑證無效或已過期，請重新登入後再試', 401, 'RESET_TICKET_INVALID');
  }
}

/**
 * 證件號正規化（英數大寫，去空白／連字）
 * 允許：身分證、居留證（統一證號等）、外國護照號
 * @returns {string|null}
 */
export function normalizeIdNumber(raw) {
  const id = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-]/g, '');
  if (!id) return null;
  // 不可把台灣手機當證件
  if (/^09\d{8}$/.test(id)) return null;
  // 中華民國身分證：1 英＋9 數字
  if (/^[A-Z]\d{9}$/.test(id)) return id;
  // 居留證／統一證號常見：2 英數開頭＋8 數字
  if (/^[A-Z][A-Z0-9]\d{8}$/.test(id)) return id;
  // 護照／外國證件：6～12 碼英數且至少含 1 英文字母
  if (/^[A-Z0-9]{6,12}$/.test(id) && /[A-Z]/.test(id)) return id;
  // 純數字護照號（8～9 碼）
  if (/^\d{8,9}$/.test(id)) return id;
  return null;
}

/** 必填證件：空或格式不符則丟錯 */
export function assertRequiredIdNumber(raw) {
  const id = normalizeIdNumber(raw);
  if (!id) {
    throw httpError(
      '請填寫有效證件號（身分證／居留證／護照）',
      400,
      'ID_NUMBER_REQUIRED',
    );
  }
  return id;
}

/**
 * 核身字串：台灣手機 09xxxxxxxx，或證件號
 * @returns {{ kind: 'phone'|'idNumber', value: string }}
 */
export function parseIdentity(raw) {
  const s = String(raw || '').trim();
  if (!s) throw httpError('請輸入身分證／居留證／護照，或註冊手機號碼');
  try {
    return { kind: 'phone', value: assertMemberPhone(s) };
  } catch {
    /* not phone — try document id */
  }
  const id = normalizeIdNumber(s);
  if (!id) {
    throw httpError('請輸入有效的身分證／居留證／護照，或註冊手機號碼（09 開頭 10 碼）');
  }
  return { kind: 'idNumber', value: id };
}

function identityMatchesMember(member, identity) {
  if (identity.kind === 'phone') {
    return Boolean(member.phone && member.phone === identity.value);
  }
  const stored = member.idNumber ? normalizeIdNumber(member.idNumber) : null;
  return Boolean(stored && stored === identity.value);
}

/**
 * 換機資格：已簽 NEW_MEMBER；須有登記 Email；須有手機或證件可核身
 */
export async function assertEligibleForDeviceReset(memberId) {
  const member = await prisma.member.findUnique({ where: { id: Number(memberId) } });
  if (!member) throw httpError('找不到會員', 404);
  try {
    await assertMemberSignedNewMemberContract(member.id);
  } catch (e) {
    if (e.code === 'CONTRACT_REQUIRED' || e.code === 'CONTRACT_UNSIGNED') {
      throw httpError(
        '請先完成入會契約簽署，始可換機綁定（禁止未簽約發證）',
        403,
        'CONTRACT_REQUIRED',
      );
    }
    throw e;
  }
  if (!member.email) {
    throw httpError('會員未設定 Email，請洽櫃檯臨櫃重置裝置', 400, 'EMAIL_MISSING');
  }
  if (!member.phone && !member.idNumber) {
    throw httpError('會員未設定手機或證件號，請洽櫃檯臨櫃重置裝置', 400);
  }
  return member;
}

/** LINE／換票偵測到新裝置：發換機票（須已簽約） */
export async function buildDeviceMismatchResetPayload(member) {
  await assertEligibleForDeviceReset(member.id);
  return {
    code: 'DEVICE_MISMATCH_RESET_REQUIRED',
    message: '偵測到新裝置，請以身分＋登記 Email 完成驗證後換機',
    resetTicket: issueDeviceResetTicket(member.id),
    maskedEmail: maskEmail(member.email),
  };
}

/**
 * 已綁其他裝置 → 拋 403 DEVICE_MISMATCH_RESET_REQUIRED（附 resetTicket）
 */
export async function throwDeviceMismatchResetRequired(member) {
  const payload = await buildDeviceMismatchResetPayload(member);
  const err = new Error(payload.message);
  err.statusCode = 403;
  err.code = payload.code;
  err.data = {
    resetTicket: payload.resetTicket,
    maskedEmail: payload.maskedEmail,
  };
  throw err;
}

/** 統一錯誤 JSON（含換機 data） */
export function deviceResetErrorBody(error) {
  return {
    status: 'error',
    code: error?.code || undefined,
    message: error?.message || '換機失敗',
    ...(error?.data && typeof error.data === 'object' ? error.data : {}),
  };
}

async function assertDailyEmailOtpQuota(memberId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const count = await prisma.emailOtp.count({
    where: {
      memberId: Number(memberId),
      purpose: PURPOSE_DEVICE_RESET,
      createdAt: { gte: start },
    },
  });
  if (count >= DAILY_OTP_MAX) {
    throw httpError('今日換機驗證信發送次數已達上限，請改洽櫃檯或明日再試', 429);
  }
}

/**
 * 自助換機頻率熔斷：防「轉發 Email OTP」輪流共用帳號
 * - 冷卻窗內僅允許 1 次「實際改綁」（oldDeviceId ≠ newDeviceId）
 * - 滾動 30 日最多 N 次；超過一律 429，引導櫃檯 DUTY+ 臨櫃重置
 * 臨櫃 opsReset 不計入此限。
 */
export async function assertSelfDeviceSwitchAllowed(memberId) {
  const id = Number(memberId);
  const now = Date.now();
  const cooldownStart = new Date(now - SELF_SWITCH_COOLDOWN_HOURS * 60 * 60 * 1000);
  const monthStart = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const rows = await prisma.memberDeviceAuditLog.findMany({
    where: {
      memberId: id,
      action: 'SELF_SWITCH',
      createdAt: { gte: monthStart },
    },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: {
      createdAt: true,
      oldDeviceId: true,
      newDeviceId: true,
    },
  });

  const realSwitches = rows.filter(
    (r) =>
      r.oldDeviceId &&
      r.newDeviceId &&
      String(r.oldDeviceId) !== String(r.newDeviceId),
  );

  const lastInCooldown = realSwitches.find((r) => r.createdAt >= cooldownStart);
  if (lastInCooldown) {
    throw httpError(
      `自助換機冷卻中（${SELF_SWITCH_COOLDOWN_HOURS} 小時內僅限 1 次）。請改洽櫃檯出示證件，由值班人員（DUTY+）臨櫃重置。`,
      429,
      'DEVICE_RESET_RATE_LIMITED',
    );
  }

  if (realSwitches.length >= SELF_SWITCH_MONTHLY_MAX) {
    throw httpError(
      `近 30 日自助換機已達上限（${SELF_SWITCH_MONTHLY_MAX} 次）。請改洽櫃檯出示證件，由值班人員（DUTY+）臨櫃重置。`,
      429,
      'DEVICE_RESET_RATE_LIMITED',
    );
  }
}

/**
 * 雙重核對後鎖定會員：identity + email 必須與檔案完全相符
 * 失敗一律回 IDENTITY_MISMATCH_MSG（防掃庫）
 */
export async function resolveMemberByIdentityAndEmail({
  resetTicket,
  identityRaw,
  emailRaw,
} = {}) {
  const identity = parseIdentity(identityRaw);
  let email;
  try {
    email = normalizeEmail(emailRaw);
  } catch {
    throw httpError(IDENTITY_MISMATCH_MSG, 400, 'IDENTITY_MISMATCH');
  }

  let member = null;
  if (resetTicket) {
    const { memberId } = verifyDeviceResetTicket(resetTicket);
    member = await prisma.member.findUnique({ where: { id: memberId } });
  } else if (identity.kind === 'phone') {
    member = await prisma.member.findUnique({ where: { phone: identity.value } });
  } else {
    member = await prisma.member.findUnique({ where: { idNumber: identity.value } });
  }

  if (!member) {
    throw httpError(IDENTITY_MISMATCH_MSG, 400, 'IDENTITY_MISMATCH');
  }

  const registeredEmail = member.email ? normalizeEmail(member.email) : '';
  if (!registeredEmail || registeredEmail !== email || !identityMatchesMember(member, identity)) {
    throw httpError(IDENTITY_MISMATCH_MSG, 400, 'IDENTITY_MISMATCH');
  }

  return member;
}

/**
 * POST /auth/device-reset/request-email
 * 核身通過後才寄 Email OTP
 */
export async function requestDeviceResetEmail({
  resetTicket,
  identity: identityRaw,
  email: emailRaw,
} = {}) {
  const member = await resolveMemberByIdentityAndEmail({
    resetTicket,
    identityRaw,
    emailRaw,
  });

  await assertEligibleForDeviceReset(member.id);

  if (!member.deviceId) {
    throw httpError('此帳號尚未綁定裝置，請直接登入完成本機綁定即可', 400);
  }

  await assertSelfDeviceSwitchAllowed(member.id);
  await assertDailyEmailOtpQuota(member.id);

  const sent = await sendEmailOtp(member.email, PURPOSE_DEVICE_RESET, {
    memberId: member.id,
  });

  return {
    ...sent,
    maskedEmail: maskEmail(member.email),
    resetTicket: issueDeviceResetTicket(member.id),
  };
}

/**
 * POST /auth/device-reset/verify-email
 * OTP 通過 → 檢契約 → deviceBindUpdate（dav+1）→ 發 JWT
 */
export async function verifyAndBindDeviceResetEmail({
  resetTicket,
  identity: identityRaw,
  email: emailRaw,
  otpCode,
  newDeviceId,
  req,
  ip,
  userAgent,
} = {}) {
  const fromHeader = req ? readRequestDeviceId(req) : '';
  const nextId = normalizeDeviceId(newDeviceId || fromHeader);
  if (!nextId || nextId.length < 8) {
    throw httpError('請提供有效的本機裝置識別（至少 8 碼）', 400, 'DEVICE_REQUIRED');
  }

  const memberMatched = await resolveMemberByIdentityAndEmail({
    resetTicket,
    identityRaw,
    emailRaw,
  });

  // 守則 4.2：發 JWT／寫 deviceId 前必須已簽 NEW_MEMBER
  const member = await assertEligibleForDeviceReset(memberMatched.id);

  await assertSelfDeviceSwitchAllowed(member.id);
  await verifyEmailOtp(member.email, otpCode, PURPOSE_DEVICE_RESET);

  const oldDeviceId = member.deviceId;
  const oldDav = Number(member.deviceAuthVersion) || 0;
  const bindPatch = deviceBindUpdateIfChanged(oldDeviceId, nextId, member.id);

  let updated = member;
  if (bindPatch) {
    updated = await prisma.member.update({
      where: { id: member.id },
      data: bindPatch,
    });
    await writeMemberDeviceAuditLog({
      memberId: member.id,
      operatorId: null,
      action: 'SELF_SWITCH',
      oldDeviceId,
      newDeviceId: nextId,
      oldDav,
      newDav: Number(updated.deviceAuthVersion) || oldDav + 1,
      reason: '會員自助換機（Email OTP）',
      ip: ip || null,
      userAgent: userAgent || null,
    });
  }

  const token = issueMemberToken(updated.id, memberTokenDeviceOpts(updated));
  return {
    token,
    member: {
      id: updated.id,
      name: updated.name,
      plan: updated.plan,
      hasDeviceBound: Boolean(updated.deviceId),
      hasLineBound: Boolean(updated.lineId),
    },
    deviceChanged: Boolean(bindPatch),
    message: bindPatch
      ? '已切換為此裝置；舊裝置登入已失效'
      : '裝置碼未變更，登入已更新',
  };
}

/**
 * 臨櫃重置：清 deviceId＋dav 遞增＋稽核（DUTY+／ADMIN）
 */
export async function opsResetMemberDevice({
  memberId,
  operatorId,
  reason,
  ip,
  userAgent,
  action = 'OPS_UNBIND',
} = {}) {
  const id = Number(memberId);
  if (!Number.isInteger(id)) throw httpError('無效的會員 ID', 400);

  const existing = await prisma.member.findUnique({ where: { id } });
  if (!existing) throw httpError('找不到此會員', 404);

  const oldDeviceId = existing.deviceId;
  const oldDav = Number(existing.deviceAuthVersion) || 0;

  if (!oldDeviceId && oldDav >= 0) {
    // 仍允許重跑以確保 dav 遞增？無綁定則直接回成功不 bump
    return {
      member: existing,
      changed: false,
      message: `會員 [${existing.name}] 目前未綁定裝置`,
    };
  }

  const updated = await prisma.member.update({
    where: { id },
    data: deviceBindUpdateData({ deviceId: null }, id),
  });

  await writeMemberDeviceAuditLog({
    memberId: id,
    operatorId: operatorId ?? null,
    action,
    oldDeviceId,
    newDeviceId: null,
    oldDav,
    newDav: Number(updated.deviceAuthVersion) || oldDav + 1,
    reason: reason || '臨櫃核身重置裝置',
    ip: ip || null,
    userAgent: userAgent || null,
  });

  return {
    member: updated,
    changed: true,
    message: `會員 [${updated.name}] 已解除裝置綁定（舊登入已失效）；請於會員 App 重新登入綁定`,
  };
}

export { PURPOSE_DEVICE_RESET, readRequestDeviceId, maskEmail };
