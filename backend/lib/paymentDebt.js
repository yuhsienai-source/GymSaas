// lib/paymentDebt.js — 欠款黑名單（PaymentBlacklist）之查詢與購課攔截
// 僅限制「新締約」（購課、課程分期）；不得據以停止已收費之入場或既有合約服務（消保不當聯結）。

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

/** 有未清償欠款 → 409 PAYMENT_DEBT_OUTSTANDING */
export async function assertNoPaymentDebt(db, memberId) {
  const debt = await findActivePaymentDebt(db, memberId);
  if (!debt) return;
  const err = new Error(`會員有未清償欠款（${debt.reason}），請先臨櫃清償並由值班主管解除欠款黑名單後再購課`);
  err.statusCode = 409;
  err.code = 'PAYMENT_DEBT_OUTSTANDING';
  throw err;
}
