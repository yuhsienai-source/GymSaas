// lib/leaveProofAccess.js — 會籍暫停證明（個資法第 6 條特種個資）調閱：DUTY+、必填原因、短效 URL、append-only 稽核
import crypto from 'crypto';
import prisma from './prisma.js';
import { createIdPhotoPresignedGetUrl, getIdPhotoObject, idPhotoPresignTtlSec } from './idPhotoStorage.js';
import { getRequestClientMeta } from './contractAudit.js';
import { hasDutyRankOrAbove } from './staffAccess.js';

const TOKEN_PURPOSE = 'leave-proof-access';
const REASON_MIN = 4;
const REASON_MAX = 200;

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function accessSecret() {
  return (
    process.env.ID_PHOTO_ACCESS_SECRET ||
    process.env.JWT_STAFF_SECRET ||
    process.env.JWT_SECRET ||
    'gymsaas-id-photo-access-dev'
  );
}

/** 以用途前綴簽章，避免與證件調閱 token 互換 */
const sign = (body) => crypto.createHmac('sha256', accessSecret()).update(`${TOKEN_PURPOSE}.${body}`).digest('base64url');
/** 綁定簽發當下之檔案；換檔後舊連結失效 */
const keyFingerprint = (storageKey) => crypto.createHash('sha256').update(String(storageKey)).digest('hex').slice(0, 16);

async function writeLog({ leave, action, staffId = null, staffRole = null, branchId = null, reason = null, accessMode = null, expiresAt = null, req = null }) {
  const meta = req ? getRequestClientMeta(req) : { ipAddress: null, userAgent: null };
  await prisma.leaveProofAccessLog.create({
    data: {
      leaveId: leave.id,
      memberId: leave.memberId,
      action,
      staffId,
      staffRole,
      branchId,
      reason,
      accessMode,
      expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });
}

/**
 * 簽發 3～5 分短效調閱 URL：R2 → Presigned GET；local → HMAC token（GET /api/ops/leave-proof-access/:token）。
 * 稽核寫入成功後才回傳 URL（寫不進去即不得調閱）。
 */
export async function issueLeaveProofAccess({ leaveId, user, reason, req = null }) {
  if (!hasDutyRankOrAbove(user)) {
    throw httpError('調閱暫停證明限值班主管（DUTY）以上', 403, 'DUTY_ROLE_REQUIRED_FOR_LEAVE_PROOF');
  }
  const reasonText = String(reason ?? '').trim();
  if (reasonText.length < REASON_MIN) {
    throw httpError(`調閱原因必填（至少 ${REASON_MIN} 字，例：審核暫停申請）`, 400, 'REASON_REQUIRED');
  }
  const leave = await prisma.memberLeave.findUnique({ where: { id: Number(leaveId) } });
  if (!leave) throw httpError('找不到暫停申請', 404, 'LEAVE_NOT_FOUND');
  if (!leave.proofStorageKey) throw httpError('此申請未附證明', 404, 'LEAVE_PROOF_MISSING');

  const ttl = idPhotoPresignTtlSec();
  const expiresAt = new Date(Date.now() + ttl * 1000);
  let url;
  let mode;
  const signed = await createIdPhotoPresignedGetUrl(leave.proofStorageKey, ttl);
  if (signed?.url) {
    url = signed.url;
    mode = 'r2_presign';
  } else {
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        lid: leave.id,
        kf: keyFingerprint(leave.proofStorageKey),
        sid: user?.id ?? null,
        exp: Math.floor(expiresAt.getTime() / 1000),
      }),
    ).toString('base64url');
    url = `/api/ops/leave-proof-access/${body}.${sign(body)}`;
    mode = 'local_token';
  }

  await writeLog({
    leave,
    action: 'ISSUE',
    staffId: user?.id ?? null,
    staffRole: user?.role ?? null,
    branchId: user?.branchId ?? null,
    reason: reasonText.slice(0, REASON_MAX),
    accessMode: mode,
    expiresAt,
    req,
  });
  return { url, expiresAt: expiresAt.toISOString(), expiresIn: ttl, mode, fileName: leave.proofFileName };
}

/** 兌換 local token（無 Staff JWT；token 即憑證），每次兌換皆留稽核 */
export async function redeemLeaveProofAccessToken(tokenRaw, req = null) {
  const invalid = () => httpError('調閱憑證無效', 403, 'ACCESS_TOKEN_INVALID');
  const [body, sig, ...rest] = String(tokenRaw || '').trim().split('.');
  if (!body || !sig || rest.length) throw invalid();
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw invalid();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
    throw httpError('調閱憑證已過期，請重新申請', 403, 'ACCESS_TOKEN_EXPIRED');
  }
  const leave = await prisma.memberLeave.findUnique({ where: { id: Number(payload.lid) } });
  if (!leave?.proofStorageKey || keyFingerprint(leave.proofStorageKey) !== payload.kf) {
    throw httpError('證明檔已更換或不存在，請重新申請調閱', 404, 'LEAVE_PROOF_MISSING');
  }
  await writeLog({ leave, action: 'REDEEM', staffId: payload.sid ?? null, accessMode: 'local_token', req });
  return getIdPhotoObject(leave.proofStorageKey);
}
