import {
  RANK_DUTY,
  RANK_STORE_MANAGER,
  STAFF_PERMISSIONS,
  canonicalPosition,
  isPosition,
  positionRank,
} from './orgStructure';
import type { StaffInfo, StaffPermission } from './storage';
import type { StaffDutyStatus } from '../types/api';

const ROUTE_BY_PERMISSION: { permission: StaffPermission; path: string }[] = [
  { permission: 'ops', path: '/staff/ops' },
  { permission: 'pt', path: '/staff/pt' },
  { permission: 'trainer', path: '/staff/trainer' },
];

/** DUTY（值班）以上可進入交易異動 */
export function staffHasDutyRankOrAbove(staff: StaffInfo | null): boolean {
  return Boolean(staff) && positionRank(staff?.role) >= RANK_DUTY;
}

/** STORE_MANAGER（店長）以上 — 交接班差額調整等 */
export function staffHasManagerRankOrAbove(staff: StaffInfo | null): boolean {
  return Boolean(staff) && positionRank(staff?.role) >= RANK_STORE_MANAGER;
}

/** 「我的排班」：場務／值班／教練遞交排假或提報週班表、店長／GM／FM 提報週班表；ADMIN 免排班（適用與否由後端判定） */
export function staffCanRequestOff(staff: StaffInfo | null): boolean {
  return ['STAFF', 'DUTY', 'TRAINER', 'STORE_MANAGER', 'GM', 'FM'].includes(canonicalPosition(staff?.role) ?? '');
}

/** 週班表審核入口：店長與 FM 審教練、ADMIN 審店長／GM／FM（可代審教練）；GM 無審核權。實際範圍由後端判定 */
export function staffCanReviewWeekPlans(staff: StaffInfo | null): boolean {
  return ['STORE_MANAGER', 'FM', 'ADMIN'].includes(canonicalPosition(staff?.role) ?? '');
}

export function staffIsAdmin(staff: StaffInfo | null): boolean {
  return isPosition(staff?.role, 'ADMIN');
}

export function staffHasPermission(
  staff: StaffInfo | null,
  permission: StaffPermission,
): boolean {
  if (!staff) return false;
  if (staffIsAdmin(staff)) return true;
  return (staff.permissions ?? []).includes(permission);
}

export const MY_ATTENDANCE_PATH = '/staff/my-attendance';

/** 非值勤（後端判定）一律導「我的出勤」；值勤中依模組權限 */
export function getDefaultStaffPath(staff: StaffInfo | null, duty?: StaffDutyStatus | null): string {
  if (!staff) return '/staff/login';
  if (staffIsAdmin(staff)) return '/staff/hq';
  if (duty && !duty.onDuty) return MY_ATTENDANCE_PATH;
  const permissions = staff.permissions ?? [];
  for (const item of ROUTE_BY_PERMISSION) {
    if (permissions.includes(item.permission)) return item.path;
  }
  if (staffHasDutyRankOrAbove(staff)) return '/staff/tx';
  return MY_ATTENDANCE_PATH;
}

export const STAFF_PERMISSION_LABELS: Record<StaffPermission, string> = {
  ops: '櫃檯維運',
  pt: '團課管理',
  trainer: '教練服務台',
};

export const ALL_STAFF_PERMISSIONS: StaffPermission[] = STAFF_PERMISSIONS;
