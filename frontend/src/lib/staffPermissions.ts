import type { StaffInfo, StaffPermission, StaffRole } from './storage';

const ROUTE_BY_PERMISSION: { permission: StaffPermission; path: string }[] = [
  { permission: 'ops', path: '/staff/ops' },
  { permission: 'pt', path: '/staff/pt' },
  { permission: 'trainer', path: '/staff/trainer' },
];

const ROLE_RANK: Record<StaffRole, number> = {
  STAFF: 1,
  DUTY: 2,
  MANAGER: 3,
  ADMIN: 4,
};

export function staffRoleRank(role: string | undefined | null): number {
  const key = String(role || '').toUpperCase() as StaffRole;
  return ROLE_RANK[key] || 0;
}

/** DUTY（值星）以上可進入交易異動 */
export function staffHasDutyRankOrAbove(staff: StaffInfo | null): boolean {
  if (!staff) return false;
  return staffRoleRank(staff.role) >= ROLE_RANK.DUTY;
}

/** MANAGER（店長）以上 — 交接班差額調整等 */
export function staffHasManagerRankOrAbove(staff: StaffInfo | null): boolean {
  if (!staff) return false;
  return staffRoleRank(staff.role) >= ROLE_RANK.MANAGER;
}

export function staffHasPermission(
  staff: StaffInfo | null,
  permission: StaffPermission,
): boolean {
  if (!staff) return false;
  if (staff.role === 'ADMIN') return true;
  return (staff.permissions ?? []).includes(permission);
}

export function getDefaultStaffPath(staff: StaffInfo | null): string {
  if (!staff) return '/staff/login';
  if (staff.role === 'ADMIN') return '/staff/hq';
  const permissions = staff.permissions ?? [];
  for (const item of ROUTE_BY_PERMISSION) {
    if (permissions.includes(item.permission)) return item.path;
  }
  if (staffHasDutyRankOrAbove(staff)) return '/staff/tx';
  return '/staff/login';
}

export const STAFF_PERMISSION_LABELS: Record<StaffPermission, string> = {
  ops: '櫃檯維運',
  pt: '團課管理',
  trainer: '教練服務台',
};

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  STAFF: 'STAFF（櫃檯）',
  DUTY: 'DUTY（值星）',
  MANAGER: 'MANAGER（店長）',
  ADMIN: 'ADMIN（總部）',
};

export const ALL_STAFF_PERMISSIONS: StaffPermission[] = ['ops', 'pt', 'trainer'];
export const ALL_STAFF_ROLES: StaffRole[] = ['STAFF', 'DUTY', 'MANAGER', 'ADMIN'];
