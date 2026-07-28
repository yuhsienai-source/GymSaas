// lib/staffAccess.js — 員工分店範圍與模組權限
import { staffBranchLabel } from './branchLabel.js';
import { resolveDisplayName } from './displayName.js';

export const STAFF_PERMISSIONS = ['ops', 'pt', 'trainer'];

/** 職位層級：STAFF < DUTY < MANAGER < ADMIN */
export const STAFF_ROLES = ['STAFF', 'DUTY', 'MANAGER', 'ADMIN'];

const ROLE_RANK = {
  STAFF: 1,
  DUTY: 2,
  MANAGER: 3,
  ADMIN: 4,
};

export function roleRank(role) {
  return ROLE_RANK[String(role || '').toUpperCase()] || 0;
}

/** DUTY（值星）以上可操作交易異動 */
export function hasDutyRankOrAbove(user) {
  return roleRank(user?.role) >= ROLE_RANK.DUTY;
}

/** MANAGER（店長）以上 */
export function hasManagerRankOrAbove(user) {
  return roleRank(user?.role) >= ROLE_RANK.MANAGER;
}

export function isAdminUser(user) {
  return user?.role === 'ADMIN';
}

export function resolvePermissions(staff) {
  if (staff?.role === 'ADMIN') return [...STAFF_PERMISSIONS];
  return Array.isArray(staff?.permissions) ? staff.permissions : [];
}

export function hasPermission(user, perm) {
  if (isAdminUser(user)) return true;
  return Array.isArray(user?.permissions) && user.permissions.includes(perm);
}

export function assertBranchAccess(req, branchId) {
  if (isAdminUser(req.user)) return;
  const staffBranchId = req.user?.branchId;
  if (!staffBranchId) {
    const err = new Error('⛔ 帳號未綁定分店，請洽管理員');
    err.statusCode = 403;
    throw err;
  }
  const bid = parseInt(branchId, 10);
  if (!Number.isInteger(bid) || bid !== staffBranchId) {
    const err = new Error('⛔ 無權操作其他分店資料');
    err.statusCode = 403;
    throw err;
  }
}

export function branchListWhere(req) {
  if (isAdminUser(req.user)) return { isActive: true };
  if (!req.user?.branchId) return { id: -1, isActive: true };
  return { id: req.user.branchId, isActive: true };
}

export function promotionListWhere(req) {
  const base = { isActive: true };
  if (isAdminUser(req.user)) return base;
  if (!req.user?.branchId) return { ...base, branchId: -1 };
  return { ...base, branchId: req.user.branchId };
}

export function toStaffAuthPayload(staff, { trainerId = null } = {}) {
  const permissions = resolvePermissions(staff);
  const displayName = resolveDisplayName(staff);
  return {
    id: staff.id,
    /** 側欄／歡迎語等顯示用（預設匿名） */
    name: displayName,
    /** 真實姓名（總部／內部） */
    realName: staff.name,
    displayName,
    role: staff.role,
    branchId: staff.branchId ?? null,
    branchName: staffBranchLabel(staff.branch),
    permissions,
    trainerId: trainerId ?? staff.trainerProfile?.id ?? null,
  };
}

export function toJwtPayload(staff, { trainerId = null } = {}) {
  return {
    id: staff.id,
    role: staff.role,
    type: 'staff',
    branchId: staff.branchId ?? null,
    permissions: resolvePermissions(staff),
    trainerId: trainerId ?? staff.trainerProfile?.id ?? null,
  };
}

export function validateStaffCreateInput({ role, branchId, permissions }) {
  const errors = [];
  const normalizedRole = String(role || 'STAFF').toUpperCase();

  if (!STAFF_ROLES.includes(normalizedRole)) {
    errors.push('role 必須為 STAFF、DUTY、MANAGER 或 ADMIN');
  }

  if (normalizedRole === 'ADMIN') {
    return { role: normalizedRole, branchId: branchId ?? null, permissions: [], errors };
  }

  if (!branchId) {
    errors.push('STAFF/DUTY/MANAGER 必須綁定分店 branchId');
  }

  const perms = Array.isArray(permissions) ? permissions : [];
  const invalid = perms.filter((p) => !STAFF_PERMISSIONS.includes(p));
  if (invalid.length > 0) {
    errors.push(`無效權限：${invalid.join(', ')}`);
  }
  if (perms.length === 0) {
    errors.push('至少需勾選一項模組權限（ops / pt / trainer）');
  }

  return { role: normalizedRole, branchId: branchId ?? null, permissions: perms, errors };
}
