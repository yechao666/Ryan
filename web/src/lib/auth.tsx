import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Person } from '@shared';
import { api, getToken, setToken } from './api.ts';

interface AuthState {
  person: Person | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [person, setPerson] = useState<Person | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setPerson(null);
      setLoading(false);
      return;
    }
    try {
      const result = await api.me();
      setPerson(result.person);
    } catch {
      setToken(null);
      setPerson(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const ssoToken = hash.get('token');
    if (ssoToken) {
      setToken(ssoToken);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    setToken(result.token);
    setPerson(result.person);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setToken(null);
      setPerson(null);
    }
  }, []);

  const value = useMemo(() => ({ person, loading, login, logout, refresh }), [person, loading, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
