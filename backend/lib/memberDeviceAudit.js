// lib/memberDeviceAudit.js — 裝置綁定／換機稽核（append-only）
import prisma from './prisma.js';

/**
 * @param {{
 *  memberId: number,
 *  action: 'OPS_BIND'|'OPS_UNBIND'|'ADMIN_RESET'|'SELF_SWITCH',
 *  oldDeviceId?: string|null,
 *  newDeviceId?: string|null,
 *  oldDav: number,
 *  newDav: number,
 *  operatorId?: number|null,
 *  reason?: string|null,
 *  ip?: string|null,
 *  userAgent?: string|null,
 * }} row
 */
export async function writeMemberDeviceAuditLog(row, db = prisma) {
  return db.memberDeviceAuditLog.create({
    data: {
      memberId: Number(row.memberId),
      operatorId: row.operatorId == null ? null : Number(row.operatorId),
      action: String(row.action),
      oldDeviceId: row.oldDeviceId ? String(row.oldDeviceId) : null,
      newDeviceId: row.newDeviceId ? String(row.newDeviceId) : null,
      oldDav: Number(row.oldDav) || 0,
      newDav: Number(row.newDav) || 0,
      reason: row.reason ? String(row.reason).slice(0, 200) : null,
      ip: row.ip ? String(row.ip).slice(0, 80) : null,
      userAgent: row.userAgent ? String(row.userAgent).slice(0, 500) : null,
    },
  });
}

export function clientIp(req) {
  const xf = req?.headers?.['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req?.ip || null;
}

export function clientUserAgent(req) {
  const ua = req?.headers?.['user-agent'];
  return ua ? String(ua) : null;
}
