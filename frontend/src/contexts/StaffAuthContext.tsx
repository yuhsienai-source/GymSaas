import {
  createContext,
  useCallback,
  useContext,
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
  type StaffInfo,
  type StaffPermission,
} from '../lib/storage';
import { staffHasDutyRankOrAbove, staffHasPermission } from '../lib/staffPermissions';

interface StaffAuthContextValue {
  token: string | null;
  staff: StaffInfo | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  /** DUTY（值星）以上 — 交易異動 */
  canAccessTx: boolean;
  hasPermission: (permission: StaffPermission) => boolean;
  login: (token: string, staff: StaffInfo) => void;
  logout: () => void;
}

const StaffAuthContext = createContext<StaffAuthContextValue | null>(null);

export function StaffAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getStaffToken());
  const [staff, setStaff] = useState<StaffInfo | null>(() => getStaffInfo());

  const login = useCallback((newToken: string, info: StaffInfo) => {
    setStaffToken(newToken);
    setStaffInfo(info);
    setToken(newToken);
    setStaff(info);
  }, []);

  const logout = useCallback(() => {
    clearStaffToken();
    setToken(null);
    setStaff(null);
  }, []);

  const value = useMemo(
    () => ({
      token,
      staff,
      isAuthenticated: Boolean(token),
      isAdmin: staff?.role === 'ADMIN',
      canAccessTx: staffHasDutyRankOrAbove(staff),
      hasPermission: (permission: StaffPermission) => staffHasPermission(staff, permission),
      login,
      logout,
    }),
    [token, staff, login, logout],
  );

  return <StaffAuthContext.Provider value={value}>{children}</StaffAuthContext.Provider>;
}

export function useStaffAuth() {
  const ctx = useContext(StaffAuthContext);
  if (!ctx) throw new Error('useStaffAuth must be used within StaffAuthProvider');
  return ctx;
}
