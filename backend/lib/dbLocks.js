// lib/dbLocks.js — PostgreSQL 悲觀鎖（進出場並發）＋條件式雙錢包扣款

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

/**
 * 雙錢包原子遞減（條件式 UPDATE，拒絕寫成負數）。
 * 呼叫前必須已對 Member 列 FOR UPDATE。
 * @returns {Promise<{ cashWallet: number, bonusWallet: number } | null>}
 */
export async function decrementWalletsAtomic(tx, memberId, deductBonus, deductCash) {
  const bonus = Number(deductBonus) || 0;
  const cash = Number(deductCash) || 0;
  if (bonus < 0 || cash < 0) {
    throw new Error('wallet decrement must be non-negative');
  }
  if (bonus === 0 && cash === 0) {
    const m = await tx.member.findUnique({
      where: { id: memberId },
      select: { cashWallet: true, bonusWallet: true },
    });
    return m
      ? { cashWallet: Number(m.cashWallet), bonusWallet: Number(m.bonusWallet) }
      : null;
  }

  const rows = await tx.$queryRaw`
    UPDATE "Member"
    SET
      "bonusWallet" = "bonusWallet" - ${bonus},
      "cashWallet" = "cashWallet" - ${cash}
    WHERE id = ${memberId}
      AND "bonusWallet" >= ${bonus}
      AND "cashWallet" >= ${cash}
    RETURNING "cashWallet", "bonusWallet"
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    cashWallet: Number(row.cashWallet),
    bonusWallet: Number(row.bonusWallet),
  };
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
