import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { authApi, type AuthUser } from '../api/auth';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  isAdmin: boolean;
  register: (accessKey: string, username: string) => Promise<void>;
  login: (accessKey: string, username: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = 'youtube_auto_auth';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.username && parsed.accessKey) {
          return parsed;
        }
      }
    } catch {}
    return null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persist user changes to localStorage
  useEffect(() => {
    if (user) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [user]);

  const register = useCallback(async (accessKey: string, username: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await authApi.register(accessKey, username);
      setUser({ username: result.username, accessKey: result.accessKey, isAdmin: result.isAdmin });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (accessKey: string, username: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await authApi.login(username, accessKey);
      setUser({ username: result.username, accessKey: result.accessKey, isAdmin: result.isAdmin });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return (
    <AuthContext.Provider value={{ user, loading, error, isAdmin: user?.isAdmin ?? false, register, login, logout, clearError }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
