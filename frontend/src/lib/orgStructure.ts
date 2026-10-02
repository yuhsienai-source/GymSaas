/**
 * 體育客組織架構（前端鏡像；權威定義與驗證在後端 lib/orgStructure.js，兩邊須同步）
 * 總公司 HQ(ADMIN) → 管理(GM/FM) → 分店（GYM／ACADEMY；CLASS 隸屬 GYM）→ 場務 STORE／教練 TRAINER
 */
import type { StaffPermission, StaffRole } from './storage';

export type Department = 'HQ' | 'MANAGEMENT' | 'STORE' | 'TRAINER';
export type BranchType = 'GYM' | 'CLASS' | 'ACADEMY';
export type TrainerLevel = 'GOLD' | 'SILVER';
export type TrainerRole = 'NORMAL' | 'MANAGER';
/** 現行職位（不含舊制 MANAGER） */
export type Position = Exclude<StaffRole, 'MANAGER'>;

export const DEPARTMENT_LABELS: Record<Department, string> = {
  HQ: '總公司',
  MANAGEMENT: '管理',
  STORE: '場務',
  TRAINER: '教練',
};

interface BranchTypeDef {
  label: string;
  /** 擔任該分店主管之職位 */
  heads: Position[];
  /** 可直接綁定員工之部門 */
  departments: Department[];
  /** 可隸屬之上層分店類型（空＝僅頂層） */
  parentTypes: BranchType[];
  /** 必須隸屬上層分店 */
  requiresParent: boolean;
  /** 無自有主管與員工，由上層分店督導與支援 */
  inheritsParent: boolean;
}

export const BRANCH_TYPES: Record<BranchType, BranchTypeDef> = {
  GYM: {
    label: '健身房',
    heads: ['STORE_MANAGER'],
    departments: ['STORE', 'TRAINER'],
    parentTypes: [],
    requiresParent: false,
    inheritsParent: false,
  },
  CLASS: {
    label: '教室',
    heads: [],
    departments: [],
    parentTypes: ['GYM'],
    requiresParent: true,
    inheritsParent: true,
  },
  ACADEMY: {
    label: '學院',
    heads: ['FM'],
    departments: ['TRAINER'],
    parentTypes: [],
    requiresParent: false,
    inheritsParent: false,
  },
};

export const ALL_BRANCH_TYPES = Object.keys(BRANCH_TYPES) as BranchType[];

export const STAFF_PERMISSIONS: StaffPermission[] = ['ops', 'pt', 'trainer'];

interface PositionDef {
  label: string;
  /** 所屬部門；STORE_MANAGER 為分店主管（null） */
  department: Department | null;
  rank: number;
  /** 不綁單一分店、可跨店 */
  crossBranch: boolean;
  defaultPermissions: StaffPermission[];
  requiredPermissions: StaffPermission[];
}

export const POSITIONS: Record<Position, PositionDef> = {
  ADMIN: { label: '總公司', department: 'HQ', rank: 5, crossBranch: true, defaultPermissions: [], requiredPermissions: [] },
  GM: { label: '店務部主管', department: 'MANAGEMENT', rank: 4, crossBranch: true, defaultPermissions: ['ops', 'pt'], requiredPermissions: ['ops', 'pt'] },
  FM: { label: '教練部主管', department: 'MANAGEMENT', rank: 4, crossBranch: true, defaultPermissions: ['pt', 'trainer'], requiredPermissions: ['pt', 'trainer'] },
  STORE_MANAGER: { label: '店長', department: null, rank: 3, crossBranch: false, defaultPermissions: ['ops', 'pt'], requiredPermissions: [] },
  DUTY: { label: '值班', department: 'STORE', rank: 2, crossBranch: false, defaultPermissions: ['ops'], requiredPermissions: [] },
  STAFF: { label: '一般場務', department: 'STORE', rank: 1, crossBranch: false, defaultPermissions: ['ops'], requiredPermissions: [] },
  TRAINER: { label: '教練', department: 'TRAINER', rank: 1, crossBranch: false, defaultPermissions: ['trainer'], requiredPermissions: ['trainer'] },
};

/** 組織圖由上而下之職位順序 */
export const ALL_POSITIONS: Position[] = ['ADMIN', 'GM', 'FM', 'STORE_MANAGER', 'DUTY', 'STAFF', 'TRAINER'];

export const RANK_DUTY = POSITIONS.DUTY.rank;
export const RANK_STORE_MANAGER = POSITIONS.STORE_MANAGER.rank;

const LEGACY_ROLE_ALIASES: Partial<Record<string, Position>> = { MANAGER: 'STORE_MANAGER' };

export const TRAINER_LEVEL_LABELS: Record<TrainerLevel, string> = { GOLD: '金牌', SILVER: '銀牌' };
export const TRAINER_ROLE_LABELS: Record<TrainerRole, string> = { NORMAL: '一般教練', MANAGER: '主管教練' };

/** 舊制代碼轉現行；未知回傳 null */
export function canonicalPosition(role: string | null | undefined): Position | null {
  const r = String(role || '').trim().toUpperCase();
  const mapped = LEGACY_ROLE_ALIASES[r] ?? r;
  return mapped in POSITIONS ? (mapped as Position) : null;
}

export function isPosition(role: string | null | undefined, position: Position): boolean {
  return canonicalPosition(role) === position;
}

export function positionRank(role: string | null | undefined): number {
  const p = canonicalPosition(role);
  return p ? POSITIONS[p].rank : 0;
}

export function isCrossBranchRole(role: string | null | undefined): boolean {
  const p = canonicalPosition(role);
  return p ? POSITIONS[p].crossBranch : false;
}

/** 「GM 店務部主管」格式；未知職位原樣回傳 */
export function positionLabel(role: string | null | undefined): string {
  const p = canonicalPosition(role);
  if (!p) return String(role || '');
  if (p === 'ADMIN') return '總公司（ADMIN）';
  return `${p === 'STORE_MANAGER' ? 'STORE MANAGER' : p} ${POSITIONS[p].label}`;
}

/** 僅中文職稱（交接班操作人等） */
export function positionShortLabel(role: string | null | undefined): string {
  const p = canonicalPosition(role);
  return p ? POSITIONS[p].label : String(role || '');
}

export function departmentOf(role: string | null | undefined): Department | null {
  const p = canonicalPosition(role);
  return p ? POSITIONS[p].department : null;
}

/** 職位 + 勾選模組 → 送出前預覽之實際模組（後端 positionPermissions 為準） */
export function positionPermissions(role: string, picked: StaffPermission[]): StaffPermission[] {
  const p = canonicalPosition(role);
  if (!p) return [];
  if (p === 'ADMIN') return [...STAFF_PERMISSIONS];
  const pos = POSITIONS[p];
  const base = picked.length > 0 ? picked : pos.defaultPermissions;
  return STAFF_PERMISSIONS.filter((x) => base.includes(x) || pos.requiredPermissions.includes(x));
}

export function branchTypeOf(branch: { type?: string | null } | null | undefined): BranchType {
  const t = String(branch?.type || '').toUpperCase();
  return t in BRANCH_TYPES ? (t as BranchType) : 'GYM';
}

export function trainerLevelOf(trainer: { level?: string | null }): TrainerLevel {
  return trainer.level === 'GOLD' ? 'GOLD' : 'SILVER';
}

export function trainerRoleOf(trainer: { role?: string | null }): TrainerRole {
  return String(trainer.role || '').toUpperCase() === 'MANAGER' ? 'MANAGER' : 'NORMAL';
}

export function isManagerTrainer(trainer: { role?: string | null }): boolean {
  return trainerRoleOf(trainer) === 'MANAGER';
}

/** 職位可否綁定此類型分店（跨店職位一律可；隸屬型分店不直接綁員工） */
export function positionFitsBranchType(role: string, type: BranchType): boolean {
  const p = canonicalPosition(role);
  if (!p) return false;
  const pos = POSITIONS[p];
  if (pos.crossBranch) return true;
  const def = BRANCH_TYPES[type];
  if (def.inheritsParent) return false;
  return pos.department === null ? def.heads.includes(p) : def.departments.includes(pos.department);
}

export function branchTypeCanHaveChildren(type: BranchType): boolean {
  return ALL_BRANCH_TYPES.some((t) => BRANCH_TYPES[t].parentTypes.includes(type));
}
