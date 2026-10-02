import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getStaffInfo,
  getStaffToken,
  setStaffInfo,
  setStaffToken,
  clearStaffToken,
  STAFF_AUTH_LOST_EVENT,
  STAFF_OFF_DUTY_EVENT,
  type StaffInfo,
  type StaffPermission,
} from '../lib/storage';
import {
  staffCanRequestOff,
  staffHasDutyRankOrAbove,
  staffHasManagerRankOrAbove,
  staffHasPermission,
  staffIsAdmin,
} from '../lib/staffPermissions';
import { fetchStaffDutyStatus } from '../lib/api';
import type { StaffDutyStatus } from '../types/api';

/** 值勤狀態輪詢（班次開始／結束時自動切換模式；業務權限以後端海關為準） */
const DUTY_POLL_MS = 60_000;

interface StaffAuthContextValue {
  token: string | null;
  staff: StaffInfo | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  /** DUTY（值星）以上 — 交易異動 */
  canAccessTx: boolean;
  /** STORE_MANAGER（店長）以上 — 場務排班 */
  canManageRoster: boolean;
  /** 場務／值班／教練 — 我的排班（排假申請） */
  canRequestOff: boolean;
  hasPermission: (permission: StaffPermission) => boolean;
  /** 後端班表值勤判定；null＝尚未取得 */
  duty: StaffDutyStatus | null;
  /** 已確認非值勤：業務模組鎖定，僅可用我的出勤／請假／班表／通知 */
  isOffDuty: boolean;
  refreshDuty: () => Promise<StaffDutyStatus | null>;
  setDuty: (duty: StaffDutyStatus | null) => void;
  login: (token: string, staff: StaffInfo, duty?: StaffDutyStatus | null) => void;
  /** 更新本機員工資訊（如頭像版本），不動 JWT */
  patchStaff: (patch: Partial<StaffInfo>) => void;
  logout: () => void;
}

const StaffAuthContext = createContext<StaffAuthContextValue | null>(null);

export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getStaffToken());
  const [staff, setStaff] = useState<StaffInfo | null>(() => getStaffInfo());
  const [duty, setDuty] = useState<StaffDutyStatus | null>(null);

  const login = useCallback((newToken: string, info: StaffInfo, nextDuty?: StaffDutyStatus | null) => {
    setStaffToken(newToken);
    setStaffInfo(info);
    setToken(newToken);
    setStaff(info);
    setDuty(nextDuty ?? null);
  }, []);

  const patchStaff = useCallback((patch: Partial<StaffInfo>) => {
    setStaff((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      setStaffInfo(next);
      return next;
    });
  }, []);

  const logout = useCallback(() => {
    clearStaffToken();
    setToken(null);
    setStaff(null);
    setDuty(null);
  }, []);

  const refreshDuty = useCallback(async () => {
    if (!getStaffToken()) return null;
    try {
      const res = await fetchStaffDutyStatus();
      const next = res.data ?? null;
      setDuty(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    const onLost = () => {
      setToken(null);
      setStaff(null);
      setDuty(null);
    };
    const onOffDuty = (e: Event) => {
      const next = (e as CustomEvent<{ duty: StaffDutyStatus | null }>).detail?.duty;
      if (next) setDuty(next);
      else void refreshDuty();
    };
    window.addEventListener(STAFF_AUTH_LOST_EVENT, onLost);
    window.addEventListener(STAFF_OFF_DUTY_EVENT, onOffDuty);
    return () => {
      window.removeEventListener(STAFF_AUTH_LOST_EVENT, onLost);
      window.removeEventListener(STAFF_OFF_DUTY_EVENT, onOffDuty);
    };
  }, [refreshDuty]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = () => {
      fetchStaffDutyStatus()
        .then((res) => {
          if (!cancelled) setDuty(res.data ?? null);
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, DUTY_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token]);

  const value = useMemo(
    () => ({
      token,
      staff,
      isAuthenticated: Boolean(token),
      isAdmin: staffIsAdmin(staff),
      canAccessTx: staffHasDutyRankOrAbove(staff),
      canManageRoster: staffHasManagerRankOrAbove(staff),
      canRequestOff: staffCanRequestOff(staff),
      hasPermission: (permission: StaffPermission) => staffHasPermission(staff, permission),
      duty,
      isOffDuty: Boolean(duty && !duty.onDuty),
      refreshDuty,
      setDuty,
      login,
      patchStaff,
      logout,
    }),
    [token, staff, duty, refreshDuty, login, patchStaff, logout],
  );

  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>;
}

export function useStaffAuth() {
  const ctx = useContext(StaffAuthContext);
  if (!ctx) throw new Error('useStaffAuth must be used within StaffAuthProvider');
  return ctx;
}
