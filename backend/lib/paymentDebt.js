// lib/paymentDebt.js — 欠款黑名單（PaymentBlacklist）之查詢與購課攔截
// 僅限制「新締約」（購課、課程分期）；不得據以停止已收費之入場或既有合約服務（消保不當聯結）。
import { hasDutyRankOrAbove } from './staffAccess.js';

export const DEBT_CLEAR_REASON_MIN = 2;
export const DEBT_CLEAR_REASON_MAX = 200;

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function debtView(row) {
  return { reason: row.reason, note: row.note ?? null, since: row.createdAt.toISOString() };
}

/** @returns {Promise<{ reason: string, note: string|null, since: string } | null>} */
export async function findActivePaymentDebt(db, memberId) {
  const id = parseInt(memberId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await db.paymentBlacklist.findFirst({ where: { memberId: id, isActive: true } });
  return row ? debtView(row) : null;
}

/** @returns {Promise<Map<number, { reason: string, note: string|null, since: string }>>} */
export async function paymentDebtByMember(db, memberIds) {
  const ids = [...new Set(memberIds)].filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const rows = await db.paymentBlacklist.findMany({ where: { memberId: { in: ids }, isActive: true } });
  return new Map(rows.map((r) => [r.memberId, debtView(r)]));
}

/**
 * 登錄欠款（手動新增與退費立案追償共用）：同會員既有有效紀錄則累加事由，不覆寫。
 * 不設 Member.isAlert；呼叫端須於交易內先鎖會員列以免並發累加遺失。
 */
export async function addPaymentDebt(db, { memberId, reason, note = null, staffId = null }) {
  const existing = await db.paymentBlacklist.findUnique({ where: { memberId } });
  const active = Boolean(existing?.isActive);
  const mergedReason = active ? `${existing.reason}；${reason}` : reason;
  const mergedNote = note ?? (active ? existing.note : null);
  const row = await db.paymentBlacklist.upsert({
    where: { memberId },
    create: { memberId, reason: mergedReason, note: mergedNote, staffId, isActive: true },
    update: { reason: mergedReason, note: mergedNote, staffId, isActive: true, clearedAt: null },
  });
  return { row, before: { blacklistActive: active, blacklistReason: active ? existing.reason : null } };
}

/**
 * 結清欠款（門市 DUTY+）：必填收款單號／清償說明；同一交易鎖會員列、解除黑名單並寫稽核 PAYMENT_DEBT_CLEAR
 * （before 快照原欠款事由與備註），不留稽核即不得解除。
 */
export async function clearPaymentDebt(prisma, { memberId, reason, user, clientIp = null }) {
  if (!hasDutyRankOrAbove(user)) {
    throw httpError(403, 'DUTY_ROLE_REQUIRED_FOR_DEBT_CLEAR', '結清欠款限值班主管（DUTY）以上');
  }
  const text = String(reason ?? '').trim();
  if (text.length < DEBT_CLEAR_REASON_MIN) {
    throw httpError(400, 'DEBT_CLEAR_REASON_REQUIRED', '請填寫收款單號或清償說明（至少 2 字）');
  }
  if (text.length > DEBT_CLEAR_REASON_MAX) {
    throw httpError(400, 'DEBT_CLEAR_REASON_TOO_LONG', `清償說明最多 ${DEBT_CLEAR_REASON_MAX} 字`);
  }
  const id = parseInt(memberId, 10);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'MEMBER_ID_INVALID', '會員編號無效');

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`SELECT id FROM "Member" WHERE id = ${id} FOR UPDATE`;
    if (!locked.length) throw httpError(404, 'MEMBER_NOT_FOUND', '找不到會員');
    const row = await tx.paymentBlacklist.findFirst({ where: { memberId: id, isActive: true } });
    if (!row) throw httpError(409, 'PAYMENT_DEBT_NOT_FOUND', '此會員沒有未清償欠款');

    const clearedAt = new Date();
    const cleared = await tx.paymentBlacklist.update({
      where: { id: row.id },
      data: { isActive: false, clearedAt },
    });
    await tx.transactionAuditLog.create({
      data: {
        action: 'PAYMENT_DEBT_CLEAR',
        refType: 'PAYMENT_BLACKLIST',
        refId: String(id),
        staffId: user?.id ?? null,
        staffRole: user?.role ?? null,
        branchId: user?.branchId ?? null,
        reason: text,
        before: {
          isActive: true,
          reason: row.reason,
          note: row.note ?? null,
          addedByStaffId: row.staffId ?? null,
          since: row.createdAt.toISOString(),
        },
        after: { isActive: false, clearedAt: clearedAt.toISOString() },
        clientIp,
      },
    });
    return cleared;
  });
}

/** 有未清償欠款 → 409 PAYMENT_DEBT_OUTSTANDING */
export async function assertNoPaymentDebt(db, memberId) {
  const debt = await findActivePaymentDebt(db, memberId);
  if (!debt) return;
  const err = new Error(`會員有未清償欠款（${debt.reason}），請先臨櫃清償並由值班主管解除欠款黑名單後再購課`);
  err.statusCode = 409;
  err.code = 'PAYMENT_DEBT_OUTSTANDING';
  throw err;
}
