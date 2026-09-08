// lib/emailEnroll.js — 舊會員無 Email：手機＋證件核身後補登並驗證 Email
import prisma from './prisma.js';
import { assertMemberPhone } from './phoneOtp.js';
import {
  PURPOSE_EMAIL_ENROLL,
  maskEmail,
  normalizeEmail,
  sendEmailOtp,
  verifyEmailOtp,
} from './emailOtp.js';
import { normalizeIdNumber } from './deviceReset.js';
import { evaluateMemberOnboardingGate } from './memberOnboardingGate.js';
import { issueOnboardingToken, issueMemberToken } from './onboardingAuth.js';
import { memberTokenDeviceOpts } from './memberDevice.js';

const DAILY_OTP_MAX = 5;
/** 對外統一文案，避免掃庫反查 */
const MISMATCH_MSG = '手機、證件或資料不符，請確認後再試或洽櫃檯';

function httpError(message, statusCode = 400, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function isRealMember(member) {
  return Boolean(member) && !String(member.phone || '').startsWith('LINE_');
}

async function findMemberByEmail(email) {
  const rows = await prisma.member.findMany({
    where: { email },
    take: 2,
  });
  if (rows.length > 1) {
    throw httpError('此 Email 對應多筆帳號，請洽櫃檯', 409);
  }
  return rows[0] || null;
}

async function assertDailyEnrollQuota(memberId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const count = await prisma.emailOtp.count({
    where: {
      memberId: Number(memberId),
      purpose: PURPOSE_EMAIL_ENROLL,
      createdAt: { gte: start },
    },
  });
  if (count >= DAILY_OTP_MAX) {
    throw httpError('今日 Email 補登驗證信次數已達上限，請改洽櫃檯或明日再試', 429);
  }
}

/**
 * 核對：手機找得到會員、尚無 Email、檔案證件與輸入相符、新 Email 未被占用
 * @returns {{ member, email, phone, idNumber }}
 */
export async function assertEligibleForEmailEnroll({ phone: phoneRaw, idNumber: idRaw, email: emailRaw }) {
  let phone;
  try {
    phone = assertMemberPhone(phoneRaw);
  } catch {
    throw httpError(MISMATCH_MSG, 400, 'IDENTITY_MISMATCH');
  }

  const idNumber = normalizeIdNumber(idRaw);
  if (!idNumber) {
    throw httpError('請輸入有效的身分證／居留證／護照', 400);
  }

  let email;
  try {
    email = normalizeEmail(emailRaw);
  } catch (e) {
    throw httpError(e.message || '請輸入有效的 Email', 400);
  }

  const member = await prisma.member.findUnique({ where: { phone } });
  if (!isRealMember(member)) {
    throw httpError(MISMATCH_MSG, 400, 'IDENTITY_MISMATCH');
  }

  const storedEmail = member.email ? String(member.email).trim() : '';
  if (storedEmail) {
    throw httpError('此帳號已登記 Email，請直接以手機或 Email 登入', 400, 'EMAIL_ALREADY_SET');
  }

  const storedId = member.idNumber ? normalizeIdNumber(member.idNumber) : null;
  if (!storedId || storedId !== idNumber) {
    throw httpError(MISMATCH_MSG, 400, 'IDENTITY_MISMATCH');
  }

  const taken = await findMemberByEmail(email);
  if (taken && taken.id !== member.id) {
    throw httpError('此 Email 已被其他帳號使用，請改用其他信箱或洽櫃檯', 409, 'EMAIL_TAKEN');
  }

  return { member, email, phone, idNumber };
}

/**
 * 寄送補登 Email OTP（尚未寫入 Member.email）
 */
export async function requestEmailEnroll(body) {
  const { member, email } = await assertEligibleForEmailEnroll(body || {});
  await assertDailyEnrollQuota(member.id);
  const sent = await sendEmailOtp(email, PURPOSE_EMAIL_ENROLL, { memberId: member.id });
  return {
    message: sent.message,
    maskedEmail: sent.maskedEmail,
    otpEmail: email,
    expiresInSec: sent.expiresInSec,
    memberId: member.id,
    ...(sent.devCode ? { devCode: sent.devCode } : {}),
    ...(sent.mock ? { mock: true } : {}),
  };
}

/**
 * 驗證 OTP → 寫入 Member.email → 發 onboarding token 並回傳 gate 狀態
 * @param {object} body
 * @param {(decoded: object) => Promise<object>} buildStatusFn
 */
export async function verifyEmailEnroll(body, buildStatusFn) {
  const { member, email, phone } = await assertEligibleForEmailEnroll(body || {});
  await verifyEmailOtp(email, body?.code, PURPOSE_EMAIL_ENROLL);

  const updated = await prisma.member.update({
    where: { id: member.id },
    data: { email },
  });

  const gate = await evaluateMemberOnboardingGate(updated);
  const purpose = gate.nextStep === 'DONE' ? 'LOGIN' : 'REGISTER';

  const onboardingToken = issueOnboardingToken({
    email,
    phone,
    memberId: updated.id,
    purpose,
  });

  const status = await buildStatusFn({
    email,
    phone,
    memberId: updated.id,
    purpose,
  });

  let memberToken = null;
  if (status.nextStep === 'DONE' && status.member) {
    const m = await prisma.member.findUnique({
      where: { id: updated.id },
      select: { id: true, deviceId: true, deviceAuthVersion: true },
    });
    memberToken = issueMemberToken(updated.id, memberTokenDeviceOpts(m));
  }

  return {
    message: 'Email 補登並驗證成功',
    onboardingToken,
    ...status,
    ...(memberToken ? { token: memberToken } : {}),
    enrolledEmail: maskEmail(email),
  };
}
