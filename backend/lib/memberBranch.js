// lib/memberBranch.js — 會員分店綁定（進出場閘機以此為準）
import prisma from './prisma.js';
import {
  assertGateAccessAllowed,
  loadBranch,
} from './branchShare.js';
import { memberBranchLabel, staffBranchLabel } from './branchLabel.js';

/** 自助註冊可選分店代碼（僅此清單；顯示一律用正式名稱） */
export const SELF_REGISTER_BRANCH_CODES = Object.freeze(['HP', 'FD']);

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * 自助註冊可選分店（啟用中且代碼∈ HP／FD）；會員端只回 id＋正式名稱
 * @returns {Promise<{ id: number, name: string }[]>}
 */
export async function listSelfRegisterBranches(db = prisma) {
  const rows = await db.branch.findMany({
    where: {
      isActive: true,
      code: { in: [...SELF_REGISTER_BRANCH_CODES] },
    },
    select: { id: true, name: true, code: true },
    orderBy: { id: 'asc' },
  });
  // 依 SELF_REGISTER_BRANCH_CODES 順序排列
  const byCode = new Map(rows.map((r) => [String(r.code).toUpperCase(), r]));
  return SELF_REGISTER_BRANCH_CODES.map((code) => byCode.get(code))
    .filter(Boolean)
    .map((b) => ({
      id: b.id,
      name: memberBranchLabel(b) || b.name,
    }));
}

/**
 * 驗證 branchId 為自助註冊允許之分店
 * @returns {Promise<{ id: number, name: string, code: string|null }>}
 */
export async function assertSelfRegisterBranchId(branchId, db = prisma) {
  const id = parseInt(branchId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError('請選擇綁定分店', 400);
  }
  const branch = await db.branch.findFirst({
    where: { id, isActive: true },
    select: { id: true, name: true, code: true },
  });
  if (!branch) {
    throw httpError('分店無效或已停用', 400);
  }
  const code = branch.code != null ? String(branch.code).trim().toUpperCase() : '';
  if (!SELF_REGISTER_BRANCH_CODES.includes(code)) {
    throw httpError('自助註冊僅可選擇指定分店，請重新選擇', 400);
  }
  return branch;
}

export function serializeMemberBranchLink(row) {
  const branch = row.branch || null;
  return {
    branchId: row.branchId,
    branch: branch
      ? {
          id: branch.id,
          name: branch.name,
          code: branch.code || null,
        }
      : null,
    label: staffBranchLabel(branch) || (branch?.name ?? `#${row.branchId}`),
  };
}

export async function listMemberBranches(memberId, db = prisma) {
  const mid = parseInt(memberId, 10);
  if (!Number.isInteger(mid)) return [];
  const rows = await db.memberBranch.findMany({
    where: { memberId: mid },
    include: { branch: { select: { id: true, name: true, code: true, isActive: true } } },
    orderBy: { branchId: 'asc' },
  });
  return rows
    .filter((r) => r.branch?.isActive !== false)
    .map(serializeMemberBranchLink);
}

/**
 * 覆寫會員綁定分店（至少一間；須為啟用中分店）
 * @returns {Promise<ReturnType<typeof serializeMemberBranchLink>[]>}
 */
export async function setMemberBranches(memberId, branchIds, db = prisma) {
  const mid = parseInt(memberId, 10);
  if (!Number.isInteger(mid)) throw httpError('會員 ID 無效');

  const raw = Array.isArray(branchIds) ? branchIds : [];
  const ids = [
    ...new Set(
      raw
        .map((x) => parseInt(x, 10))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
  if (ids.length === 0) {
    throw httpError('請至少綁定一間分店', 400);
  }

  const branches = await db.branch.findMany({
    where: { id: { in: ids }, isActive: true },
    select: { id: true, name: true, code: true },
  });
  if (branches.length !== ids.length) {
    throw httpError('含無效或已停用的分店', 400);
  }

  await db.memberBranch.deleteMany({ where: { memberId: mid } });
  await db.memberBranch.createMany({
    data: ids.map((branchId) => ({ memberId: mid, branchId })),
  });

  return listMemberBranches(mid, db);
}

/** 綁定分店列（含 code）供閘機共享判斷 */
export async function resolveMemberBoundBranches(memberId, db = prisma) {
  const mid = parseInt(memberId, 10);
  if (!Number.isInteger(mid)) return [];
  const rows = await db.memberBranch.findMany({
    where: { memberId: mid },
    include: { branch: { select: { id: true, name: true, code: true, isActive: true } } },
  });
  return rows
    .filter((r) => r.branch && r.branch.isActive !== false)
    .map((r) => ({
      id: r.branch.id,
      name: r.branch.name,
      code: r.branch.code,
    }));
}

/**
 * 進出場：閘機分店須為會員綁定場館（含 AC↔HP 共享）
 * @param {number} memberId
 * @param {number|null} gateBranchId
 */
export async function assertMemberBoundGateAccess(memberId, gateBranchId, db = prisma) {
  if (!gateBranchId) {
    throw httpError('閘機未設定分店，無法驗證綁定場館', 400);
  }
  const gateBranch = await loadBranch(gateBranchId, db);
  if (!gateBranch) {
    throw httpError('閘機分店無效或已停用', 400);
  }

  const bound = await resolveMemberBoundBranches(memberId, db);
  if (bound.length === 0) {
    throw httpError('⛔ 此會員尚未綁定分店，請洽櫃檯設定後再進出場', 403);
  }

  try {
    assertGateAccessAllowed(bound, gateBranch);
  } catch (_err) {
    const gate = staffBranchLabel(gateBranch) || gateBranch.id;
    const boundLabels = bound.map((b) => staffBranchLabel(b) || b.id).join('、');
    throw httpError(
      `⛔ 進出場館不符：本機為 [${gate}]，會員綁定為 [${boundLabels}]（AC↔HP 可互進）`,
      403,
    );
  }

  return { gateBranch, bound };
}
