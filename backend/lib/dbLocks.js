// lib/dbLocks.js — PostgreSQL 悲觀鎖（進出場並發）；錢包增減一律經 lib/walletMutation.js

/**
 * 鎖定會員列（SELECT … FOR UPDATE），序列化同會員進出場／扣款。
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {number} memberId
 */
export async function lockMemberRow(tx, memberId) {
  const rows = await tx.$queryRaw`
    SELECT id FROM "Member" WHERE id = ${memberId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** 鎖定員工列，序列化同員工上下班打卡（防連點雙開卡） */
export async function lockStaffRow(tx, staffId) {
  const rows = await tx.$queryRaw`
    SELECT id FROM "Staff" WHERE id = ${staffId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** 鎖定薪資批次列，序列化同批次之重算／核定／結算 */
export async function lockPayrollRun(tx, runId) {
  const rows = await tx.$queryRaw`
    SELECT id, status FROM "PayrollRun" WHERE id = ${runId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * 鎖定該會員 ACTIVE 在場 CheckInLog（可選指定 id）。
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ memberId: number, logId?: number|null }} opts
 */
export async function lockActiveCheckInLog(tx, { memberId, logId = null }) {
  const rows =
    logId != null
      ? await tx.$queryRaw`
          SELECT id
          FROM "CheckInLog"
          WHERE id = ${logId}
            AND "memberId" = ${memberId}
            AND "checkOutAt" IS NULL
            AND status = 'ACTIVE'
          FOR UPDATE
        `
      : await tx.$queryRaw`
          SELECT id
          FROM "CheckInLog"
          WHERE "memberId" = ${memberId}
            AND "checkOutAt" IS NULL
            AND status = 'ACTIVE'
          ORDER BY "checkInAt" DESC
          LIMIT 1
          FOR UPDATE
        `;
  return rows[0] ?? null;
}

export function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === 'P2002' || err.code === '23505') return true;
  const msg = String(err.message || '');
  const cause = err.meta?.cause || err.meta?.driverAdapterError?.cause || {};
  return (
    cause.originalCode === '23505' ||
    cause.code === '23505' ||
    msg.includes('uniq_active_member_checkin') ||
    msg.includes('Unique constraint failed')
  );
}

/** Prisma unique／PG 23505 → 應用層 ANTI_PASSBACK */
export function antiPassbackFromUnique(err, memberId) {
  if (!isUniqueViolation(err)) return null;
  const e = new Error(
    '⛔ 防潛回：此帳號已在場內且尚未出場結算，進場閘禁止再次刷開。請先於出場閘刷卡／刷臉結算。',
  );
  e.statusCode = 403;
  e.code = 'ANTI_PASSBACK';
  e.memberId = memberId;
  return e;
}
