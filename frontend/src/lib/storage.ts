const MEMBER_TOKEN_KEY = 'gym_token';
const STAFF_TOKEN_KEY = 'admin_token';
const STAFF_INFO_KEY = 'gym_staff_info';
const DEVICE_ID_KEY = 'gymsaas_device_id';
const ONBOARDING_TOKEN_KEY = 'gym_onboarding_token';
const secureStore = typeof window !== 'undefined' ? window.sessionStorage : null;
const legacyStore = typeof window !== 'undefined' ? window.localStorage : null;

function readSecure(key: string): string | null {
  try {
    return secureStore?.getItem(key) || legacyStore?.getItem(key) || null;
  } catch {
    try {
      return legacyStore?.getItem(key) || null;
    } catch {
      return null;
    }
  }
}

function writeSecure(key: string, value: string): void {
  try {
    secureStore?.setItem(key, value);
    try {
      legacyStore?.removeItem(key);
    } catch {
      /* ignore */
    }
  } catch {
    // iOS 私密模式等可能拒寫 sessionStorage，改落 localStorage
    try {
      legacyStore?.setItem(key, value);
    } catch {
      /* ignore */
    }
  }
}

function removeSecure(key: string): void {
  try {
    secureStore?.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    legacyStore?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getMemberToken(): string | null {
  return readSecure(MEMBER_TOKEN_KEY);
}

export function setMemberToken(token: string): void {
  writeSecure(MEMBER_TOKEN_KEY, token);
}

export function clearMemberToken(): void {
  removeSecure(MEMBER_TOKEN_KEY);
}

export function getOnboardingToken(): string | null {
  return readSecure(ONBOARDING_TOKEN_KEY);
}

export function setOnboardingToken(token: string): void {
  writeSecure(ONBOARDING_TOKEN_KEY, token);
}

export function clearOnboardingToken(): void {
  removeSecure(ONBOARDING_TOKEN_KEY);
}

export function getStaffToken(): string | null {
  return readSecure(STAFF_TOKEN_KEY);
}

export function setStaffToken(token: string): void {
  writeSecure(STAFF_TOKEN_KEY, token);
}

export function clearStaffToken(): void {
  removeSecure(STAFF_TOKEN_KEY);
  removeSecure(STAFF_INFO_KEY);
}

/** API interceptor 與 AuthContext 同步：登入票失效時派發 */
export const MEMBER_AUTH_LOST_EVENT = 'gymsaas:member-auth-lost';
export const STAFF_AUTH_LOST_EVENT = 'gymsaas:staff-auth-lost';
/** 業務 API 回 403 OFF_DUTY（非班表值勤）時派發，detail.duty＝後端值勤狀態；不登出 */
export const STAFF_OFF_DUTY_EVENT = 'gymsaas:staff-off-duty';

export type StaffPermission = 'ops' | 'pt' | 'trainer';

/** 職位代碼（定義與階級見 lib/orgStructure.ts；MANAGER 為舊制＝STORE_MANAGER） */
export type StaffRole =
  | 'ADMIN'
  | 'GM'
  | 'FM'
  | 'STORE_MANAGER'
  | 'DUTY'
  | 'STAFF'
  | 'TRAINER'
  | 'MANAGER';

export interface StaffInfo {
  id: number;
  /** 顯示名稱（預設匿名） */
  name: string;
  realName?: string;
  displayName?: string;
  role: StaffRole;
  branchId: number | null;
  /** 可操作分店：本店＋隸屬分店（跨店職位為空陣列） */
  branchIds?: number[];
  branchName: string | null;
  permissions: StaffPermission[];
  /** 綁定的教練檔案；教練端個人工作區用 */
  trainerId?: number | null;
  /** 頭像版本（null＝無照片） */
  photoUpdatedAt?: string | null;
}

export function getStaffInfo(): StaffInfo | null {
  const raw = readSecure(STAFF_INFO_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StaffInfo;
  } catch {
    return null;
  }
}

export function setStaffInfo(info: StaffInfo): void {
  writeSecure(STAFF_INFO_KEY, JSON.stringify(info));
}

export function getOrCreateDeviceId(): string {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

/** 閘機本機配對（須跨重開保留；勿用 sessionStorage） */
const GATE_PAIR_KEY = 'gymsaas_gate_pair';
const LEGACY_GATE_CODE_KEY = 'gate.deviceCode';
const LEGACY_GATE_KEY_KEY = 'gate.deviceKey';

export type StoredGatePair = {
  deviceCode: string;
  deviceKey: string;
  /** 上次成功配對的顯示資訊（離線還原用） */
  name?: string | null;
  code?: string | null;
  branchLabel?: string | null;
};

function migrateLegacyGatePair(): StoredGatePair | null {
  try {
    const deviceCode = localStorage.getItem(LEGACY_GATE_CODE_KEY) || '';
    const deviceKey = localStorage.getItem(LEGACY_GATE_KEY_KEY) || '';
    if (!deviceCode || !deviceKey) return null;
    const next: StoredGatePair = { deviceCode, deviceKey };
    localStorage.setItem(GATE_PAIR_KEY, JSON.stringify(next));
    localStorage.removeItem(LEGACY_GATE_CODE_KEY);
    localStorage.removeItem(LEGACY_GATE_KEY_KEY);
    return next;
  } catch {
    return null;
  }
}

export function getGatePair(): StoredGatePair | null {
  try {
    const raw = localStorage.getItem(GATE_PAIR_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredGatePair;
      if (parsed?.deviceCode && parsed?.deviceKey) return parsed;
    }
    return migrateLegacyGatePair();
  } catch {
    return migrateLegacyGatePair();
  }
}

export function setGatePair(pair: StoredGatePair): void {
  const payload: StoredGatePair = {
    deviceCode: String(pair.deviceCode || '').trim().toUpperCase(),
    deviceKey: String(pair.deviceKey || '').trim(),
    name: pair.name ?? null,
    code: pair.code ?? null,
    branchLabel: pair.branchLabel ?? null,
  };
  if (!payload.deviceCode || !payload.deviceKey) return;
  try {
    localStorage.setItem(GATE_PAIR_KEY, JSON.stringify(payload));
    localStorage.removeItem(LEGACY_GATE_CODE_KEY);
    localStorage.removeItem(LEGACY_GATE_KEY_KEY);
  } catch {
    /* ignore */
  }
}

export function clearGatePair(): void {
  try {
    localStorage.removeItem(GATE_PAIR_KEY);
    localStorage.removeItem(LEGACY_GATE_CODE_KEY);
    localStorage.removeItem(LEGACY_GATE_KEY_KEY);
  } catch {
    /* ignore */
  }
}
