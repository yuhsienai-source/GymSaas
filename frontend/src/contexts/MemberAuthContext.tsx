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
  getMemberToken,
  setMemberToken,
  clearMemberToken,
  MEMBER_AUTH_LOST_EVENT,
} from '../lib/storage';

interface MemberAuthContextValue {
  token: string | null;
  isAuthenticated: boolean;
  login: (token: string) => void;
  logout: () => void;
}

const MemberAuthContext = createContext<MemberAuthContextValue | null>(null);

export function MemberAuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getMemberToken());

  const login = useCallback((newToken: string) => {
    setMemberToken(newToken);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    clearMemberToken();
    setToken(null);
  }, []);

  useEffect(() => {
    const onLost = () => setToken(null);
    window.addEventListener(MEMBER_AUTH_LOST_EVENT, onLost);
    return () => window.removeEventListener(MEMBER_AUTH_LOST_EVENT, onLost);
  }, []);

  const value = useMemo(
    () => ({
      token,
      isAuthenticated: Boolean(token),
      login,
      logout,
    }),
    [token, login, logout],
  );

  return <MemberAuthContext.Provider value={value}>{children}</MemberAuthContext.Provider>;
}

export function useMemberAuth() {
  const ctx = useContext(MemberAuthContext);
  if (!ctx) throw new Error('useMemberAuth must be used within MemberAuthProvider');
  return ctx;
}
