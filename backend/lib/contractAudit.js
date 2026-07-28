// lib/contractAudit.js — 電子合約稽核：內容雜湊、客戶端指紋、append-only 軌跡
import crypto from 'crypto';
import prisma from './prisma.js';

export function hashContractBody(body) {
  return crypto.createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
}

export function generateContractAuditId() {
  const dateStr = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 8);
  const randomStr = Math.floor(100000 + Math.random() * 900000).toString();
  return `CAL${dateStr}${randomStr}`;
}

export function getRequestClientMeta(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  const ip =
    forwarded ||
    String(req?.headers?.['x-real-ip'] || '').trim() ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    null;
  const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 500) || null;
  return { ipAddress: ip, userAgent };
}

/**
 * 寫入稽核軌跡（可在 transaction 內傳 tx）
 */
export async function writeContractAudit(db, {
  contractId,
  memberId,
  signatureId,
  versionId,
  action,
  summary,
  changeNote,
  detail,
  actorStaffId,
  actorType = 'STAFF',
  ipAddress,
  userAgent,
}) {
  const client = db || prisma;
  return client.contractAuditLog.create({
    data: {
      id: generateContractAuditId(),
      contractId: contractId ?? null,
      memberId: memberId ?? null,
      signatureId: signatureId ?? null,
      versionId: versionId ?? null,
      action: String(action || 'UPDATE').toUpperCase(),
      summary: summary || null,
      changeNote: changeNote || null,
      detail: detail ?? undefined,
      actorStaffId: actorStaffId ?? null,
      actorType: actorType || 'STAFF',
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    },
  });
}
