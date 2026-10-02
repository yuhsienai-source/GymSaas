// lib/staffAccess.js — 員工分店範圍與模組權限（職位定義一律取自 orgStructure.js）
import { staffBranchLabel } from './branchLabel.js';
import { resolveDisplayName } from './displayName.js';
import {
  STAFF_PERMISSIONS,
  RANK_DUTY,
  RANK_STORE_MANAGER,
  canonicalRole,
  isCrossBranchRole,
  positionPermissions,
  positionRank,
  staffBranchScope,
} from './orgStructure.js';

export { STAFF_PERMISSIONS };

export const roleRank = positionRank;

/** DUTY（值班）以上可操作交易異動 */
export function hasDutyRankOrAbove(user) {
  return positionRank(user?.role) >= RANK_DUTY;
}

/** STORE_MANAGER（店長；相容舊 MANAGER）以上 */
export function hasManagerRankOrAbove(user) {
  return positionRank(user?.role) >= RANK_STORE_MANAGER;
}

/** 總公司 ADMIN：僅用於 /api/hq 與教練工作區代看，禁止用於分店範圍 */
export function isAdminUser(user) {
  return canonicalRole(user?.role) === 'ADMIN';
}

/** 跨店職位（ADMIN／GM／FM）：不受分店範圍限制 */
export function isCrossBranchUser(user) {
  return isCrossBranchRole(user?.role);
}

export function resolvePermissions(staff) {
  return positionPermissions(staff?.role, staff?.permissions);
}

export function hasPermission(user, perm) {
  if (isAdminUser(user)) return true;
  return Array.isArray(user?.permissions) && user.permissions.includes(perm);
}

/** 非跨店員工可操作之分店 ID（JWT branchIds；舊憑證退回 branchId） */
export function staffBranchIds(user) {
  if (Array.isArray(user?.branchIds) && user.branchIds.length > 0) {
    return user.branchIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  return user?.branchId ? [Number(user.branchId)] : [];
}

export function canAccessBranch(user, branchId) {
  if (isCrossBranchUser(user)) return true;
  const bid = parseInt(branchId, 10);
  return Number.isInteger(bid) && staffBranchIds(user).includes(bid);
}

export function assertBranchAccess(req, branchId) {
  if (isCrossBranchUser(req.user)) return;
  if (staffBranchIds(req.user).length === 0) {
    const err = new Error('⛔ 帳號未綁定分店，請洽管理員');
    err.statusCode = 403;
    throw err;
  }
  if (!canAccessBranch(req.user, branchId)) {
    const err = new Error('⛔ 無權操作其他分店資料');
    err.statusCode = 403;
    throw err;
  }
}

function scopeIdsOrNone(user) {
  const ids = staffBranchIds(user);
  return ids.length > 0 ? ids : [-1];
}

export function branchListWhere(req) {
  if (isCrossBranchUser(req.user)) return { isActive: true };
  return { id: { in: scopeIdsOrNone(req.user) }, isActive: true };
}

export function promotionListWhere(req) {
  const base = { isActive: true };
  if (isCrossBranchUser(req.user)) return base;
  return { ...base, branchId: { in: scopeIdsOrNone(req.user) } };
}

/** 以 branchId 篩選之資料（商品、報表等）；跨店回傳 {} */
export function branchScopedWhere(req, field = 'branchId') {
  if (isCrossBranchUser(req.user)) return {};
  return { [field]: { in: scopeIdsOrNone(req.user) } };
}

/**
 * 員工帳號 → 登入回應（staff 須 include branch{ id,name,code,children{ id,isActive } }）
 */
export function toStaffAuthPayload(staff, { trainerId = null } = {}) {
  const displayName = resolveDisplayName(staff);
  return {
    id: staff.id,
    /** 側欄／歡迎語等顯示用（預設匿名） */
    name: displayName,
    /** 真實姓名（總部／內部） */
    realName: staff.name,
    displayName,
    role: canonicalRole(staff.role) || staff.role,
    branchId: staff.branchId ?? null,
    branchIds: staffBranchScope(staff.branch),
    branchName: staffBranchLabel(staff.branch),
    permissions: resolvePermissions(staff),
    trainerId: trainerId ?? staff.trainerProfile?.id ?? null,
    photoUpdatedAt: staff.photoUpdatedAt ?? null,
  };
}

export function toJwtPayload(staff, { trainerId = null } = {}) {
  return {
    id: staff.id,
    role: canonicalRole(staff.role) || staff.role,
    type: 'staff',
    branchId: staff.branchId ?? null,
    branchIds: staffBranchScope(staff.branch),
    permissions: resolvePermissions(staff),
    trainerId: trainerId ?? staff.trainerProfile?.id ?? null,
  };
}

/** 登入／me 查詢員工時之 include（供 toJwtPayload 計算分店範圍） */
export const staffAuthInclude = {
  branch: {
    select: {
      id: true,
      name: true,
      code: true,
      children: { select: { id: true, isActive: true } },
    },
  },
  trainerProfile: { select: { id: true, isActive: true } },
};

/**
 * 建立／更新員工之職位、分店、模組正規化（分店類型相容性另由 positionBranchError 檢查）
 */
export function validateStaffCreateInput({ role, branchId, permissions }) {
  const errors = [];
  const normalizedRole = canonicalRole(role || 'STAFF');
  if (!normalizedRole) {
    errors.push('role 必須為 ADMIN、GM、FM、STORE_MANAGER、DUTY、STAFF 或 TRAINER');
    return { role: null, branchId: null, permissions: [], errors };
  }

  const invalid = (Array.isArray(permissions) ? permissions : []).filter(
    (p) => !STAFF_PERMISSIONS.includes(p),
  );
  if (invalid.length > 0) errors.push(`無效權限：${invalid.join(', ')}`);

  const bid = branchId ? Number(branchId) : null;
  if (normalizedRole === 'ADMIN') {
    return { role: normalizedRole, branchId: null, permissions: [], errors };
  }
  if (!isCrossBranchRole(normalizedRole) && !bid) {
    errors.push('STORE_MANAGER／DUTY／STAFF／TRAINER 必須綁定所屬分店 branchId');
  }

  const perms = positionPermissions(normalizedRole, permissions);
  if (perms.length === 0) errors.push('至少需勾選一項模組權限（ops / pt / trainer）');

  return { role: normalizedRole, branchId: bid, permissions: perms, errors };
}
