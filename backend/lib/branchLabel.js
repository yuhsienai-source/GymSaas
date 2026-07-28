// lib/branchLabel.js — 分店顯示：員工用代碼、會員／對外用正式名稱

/** Prisma include／select 共用（員工端需 code） */
export const BRANCH_STAFF_SELECT = { id: true, name: true, code: true };

/**
 * 正規化分店代碼（必填於建立；唯一）
 * @returns {string}
 */
export function normalizeBranchCode(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .slice(0, 32);
  if (!s) {
    const err = new Error('請提供分店代碼');
    err.statusCode = 400;
    throw err;
  }
  if (!/^[\w\u4e00-\u9fff\-]+$/u.test(s)) {
    const err = new Error('分店代碼僅能使用中英數、底線或連字號');
    err.statusCode = 400;
    throw err;
  }
  return s;
}

/** 員工／內部關聯顯示：優先代碼，無則正式名稱 */
export function staffBranchLabel(branch) {
  if (!branch) return null;
  const code = branch.code != null ? String(branch.code).trim() : '';
  if (code) return code;
  return branch.name ? String(branch.name) : null;
}

/** 會員／對外／發票／推播：一律正式名稱 */
export function memberBranchLabel(branch) {
  if (!branch) return null;
  return branch.name ? String(branch.name) : null;
}
