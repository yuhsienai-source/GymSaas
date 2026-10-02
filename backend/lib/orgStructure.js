// lib/orgStructure.js — 體育客組織架構單一來源：分店類型、部門、職位、教練等級
// 總公司 HQ(ADMIN) → 管理(GM/FM) → 分店（GYM／ACADEMY；CLASS 隸屬 GYM）→ 場務 STORE／教練 TRAINER

/** 部門（組織圖節點） */
export const DEPARTMENTS = {
  HQ: { label: '總公司' },
  MANAGEMENT: { label: '管理' },
  STORE: { label: '場務' },
  TRAINER: { label: '教練' },
};

/**
 * 分店類型
 * - heads：擔任該分店主管之職位
 * - departments：可直接綁定員工之部門
 * - parentTypes：可隸屬之上層分店類型（空陣列＝僅能為頂層）
 * - requiresParent：必須隸屬上層分店
 * - inheritsParent：無自有主管與員工，由上層分店主管督導、上層員工支援作業
 */
export const BRANCH_TYPES = {
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

export const DEFAULT_BRANCH_TYPE = 'GYM';

/** 模組權限 */
export const STAFF_PERMISSIONS = ['ops', 'pt', 'trainer'];

/**
 * 員工職位（Staff.role）
 * - department：所屬部門；STORE_MANAGER 為分店主管（department=null）
 * - crossBranch：不綁單一分店、可跨店（仍不得進 /api/hq，限 ADMIN）
 * - defaultPermissions：未勾選模組時之預設
 * - requiredPermissions：強制併入之模組（寫入與 JWT 皆套用）
 */
export const STAFF_POSITIONS = {
  ADMIN: {
    label: '總公司',
    department: 'HQ',
    rank: 5,
    crossBranch: true,
    defaultPermissions: [],
    requiredPermissions: [],
  },
  GM: {
    label: '店務部主管',
    department: 'MANAGEMENT',
    rank: 4,
    crossBranch: true,
    defaultPermissions: ['ops', 'pt'],
    requiredPermissions: ['ops', 'pt'],
  },
  FM: {
    label: '教練部主管',
    department: 'MANAGEMENT',
    rank: 4,
    crossBranch: true,
    defaultPermissions: ['pt', 'trainer'],
    requiredPermissions: ['pt', 'trainer'],
  },
  STORE_MANAGER: {
    label: '店長',
    department: null,
    rank: 3,
    crossBranch: false,
    defaultPermissions: ['ops', 'pt'],
    requiredPermissions: [],
  },
  DUTY: {
    label: '值班',
    department: 'STORE',
    rank: 2,
    crossBranch: false,
    defaultPermissions: ['ops'],
    requiredPermissions: [],
  },
  STAFF: {
    label: '一般場務',
    department: 'STORE',
    rank: 1,
    crossBranch: false,
    defaultPermissions: ['ops'],
    requiredPermissions: [],
  },
  TRAINER: {
    label: '教練',
    department: 'TRAINER',
    rank: 1,
    crossBranch: false,
    defaultPermissions: ['trainer'],
    requiredPermissions: ['trainer'],
  },
};

/** 階級門檻（禁止在他處另寫數字） */
export const RANK_DUTY = STAFF_POSITIONS.DUTY.rank;
export const RANK_STORE_MANAGER = STAFF_POSITIONS.STORE_MANAGER.rank;

/** 舊制職位代碼 → 現行職位（僅讀取相容；寫入一律正規化） */
export const LEGACY_ROLE_ALIASES = { MANAGER: 'STORE_MANAGER' };

/** JWT／DB 可接受之全部職位代碼（含舊制） */
export const STAFF_ROLES = [...Object.keys(STAFF_POSITIONS), ...Object.keys(LEGACY_ROLE_ALIASES)];

/** 教練等級（Trainer.level） */
export const TRAINER_LEVELS = {
  GOLD: { label: '金牌' },
  SILVER: { label: '銀牌' },
};
export const DEFAULT_TRAINER_LEVEL = 'SILVER';

/** 教練角色（Trainer.role）：MANAGER 不限授課分店 */
export const TRAINER_ROLES = {
  NORMAL: { label: '一般教練' },
  MANAGER: { label: '主管教練' },
};

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// ---------- 職位 ----------

/** 舊制代碼轉現行；未知回傳 null */
export function canonicalRole(role) {
  const r = upper(role);
  const mapped = LEGACY_ROLE_ALIASES[r] || r;
  return STAFF_POSITIONS[mapped] ? mapped : null;
}

export function isKnownStaffRole(role) {
  return canonicalRole(role) !== null;
}

export function getPosition(role) {
  const key = canonicalRole(role);
  return key ? STAFF_POSITIONS[key] : null;
}

export function positionRank(role) {
  return getPosition(role)?.rank ?? 0;
}

export function isCrossBranchRole(role) {
  return Boolean(getPosition(role)?.crossBranch);
}

/** 「店長（STORE_MANAGER）」格式；未知職位原樣回傳 */
export function positionLabel(role) {
  const key = canonicalRole(role);
  return key ? STAFF_POSITIONS[key].label : String(role || '');
}

/**
 * 職位 + 勾選模組 → 實際模組（ADMIN 全開；其餘過濾無效值、空則套預設、併入必備）
 */
export function positionPermissions(role, configured) {
  const key = canonicalRole(role);
  if (!key) return [];
  if (key === 'ADMIN') return [...STAFF_PERMISSIONS];
  const pos = STAFF_POSITIONS[key];
  const picked = (Array.isArray(configured) ? configured : []).filter((p) =>
    STAFF_PERMISSIONS.includes(p),
  );
  const base = picked.length > 0 ? picked : pos.defaultPermissions;
  return STAFF_PERMISSIONS.filter((p) => base.includes(p) || pos.requiredPermissions.includes(p));
}

// ---------- 分店 ----------

export function normalizeBranchType(raw, fallback = DEFAULT_BRANCH_TYPE) {
  const t = upper(raw);
  if (!t) return fallback;
  if (!BRANCH_TYPES[t]) {
    throw httpError(`分店類型必須為 ${Object.keys(BRANCH_TYPES).join('／')}`);
  }
  return t;
}

function branchTypeDef(branch) {
  return BRANCH_TYPES[branch?.type] || BRANCH_TYPES[DEFAULT_BRANCH_TYPE];
}

function branchWhere(branch) {
  return `${branchTypeDef(branch).label}（${branch.code || branch.name || branch.id}）`;
}

/** 此類型分店底下可否掛隸屬分店 */
export function branchTypeCanHaveChildren(type) {
  return Object.values(BRANCH_TYPES).some((t) => t.parentTypes.includes(type));
}

/**
 * 分店上層關係檢查（僅一層：CLASS 隸屬 GYM）
 * @param {{ id?: number, type: string, childCount?: number }} branch
 * @param {{ id: number, type: string, parentId?: number|null, isActive?: boolean }|null} parent
 * @returns {string|null} 錯誤訊息；null 表示允許
 */
export function branchParentError(branch, parent) {
  const type = branchTypeDef(branch);
  if (branch.childCount && !branchTypeCanHaveChildren(branch.type)) {
    return `此分店底下仍有隸屬分店，不可改為${type.label}`;
  }
  if (!parent) {
    if (type.requiresParent) {
      const parents = type.parentTypes.map((t) => BRANCH_TYPES[t].label).join('／');
      return `${type.label}必須隸屬一間${parents}`;
    }
    return null;
  }
  if (branch.id && parent.id === branch.id) return '上層分店不可為自己';
  if (parent.isActive === false) return '上層分店已停用';
  if (parent.parentId) return '上層分店本身已隸屬其他分店（僅支援一層）';
  if (!type.parentTypes.includes(parent.type)) {
    return `${type.label}不可隸屬${BRANCH_TYPES[parent.type]?.label || parent.type}`;
  }
  if (branch.childCount) return '此分店底下已有隸屬分店，不可再隸屬其他分店';
  return null;
}

/**
 * 職位能否綁定於此分店（依分店類型）
 * @param {string} role
 * @param {{ id: number, type: string, code?: string|null, name?: string }|null} branch
 * @returns {string|null} 錯誤訊息；null 表示允許
 */
export function positionBranchError(role, branch) {
  const key = canonicalRole(role);
  if (!key || !branch) return null;
  const pos = STAFF_POSITIONS[key];
  if (pos.crossBranch) return null;
  const type = branchTypeDef(branch);
  const where = branchWhere(branch);
  if (type.inheritsParent) {
    return `${where}由上層分店督導與支援，員工請綁定上層分店`;
  }
  if (pos.department === null) {
    if (!type.heads.includes(key)) {
      const heads = type.heads.map((h) => STAFF_POSITIONS[h].label).join('／');
      return `${where}由 ${heads} 督導，不可設置${pos.label}`;
    }
    return null;
  }
  if (!type.departments.includes(pos.department)) {
    return `${where}未設${DEPARTMENTS[pos.department].label}部門，${pos.label}請綁定其他分店`;
  }
  return null;
}

/**
 * 員工可操作之分店 ID：本店 + 啟用中之隸屬分店（CLASS 由上層 GYM 員工支援）
 * @param {{ id: number, children?: Array<{ id: number, isActive?: boolean }> }|null} branch
 */
export function staffBranchScope(branch) {
  if (!branch?.id) return [];
  const children = (branch.children || []).filter((c) => c.isActive !== false).map((c) => c.id);
  return [branch.id, ...children];
}

// ---------- 教練 ----------

export function normalizeTrainerLevel(raw, fallback = DEFAULT_TRAINER_LEVEL) {
  const l = upper(raw);
  return TRAINER_LEVELS[l] ? l : fallback;
}

export function normalizeTrainerRole(raw) {
  return upper(raw) === 'MANAGER' ? 'MANAGER' : 'NORMAL';
}

export function isManagerTrainer(trainer) {
  return normalizeTrainerRole(trainer?.role) === 'MANAGER';
}
