/**
 * Session state for the whole app.
 *
 * Ownership split, which this file must not blur (CLAUDE.md §5):
 *  - **identity-svc** issues and revokes credentials. It decides what a password is,
 *    when step-up MFA is required, and what a role is.
 *  - **this file** only holds the resulting token and the `SessionUser` projection the
 *    UI renders. It never inspects the JWT, never derives a role from claims, and
 *    never decides a permission — every capability call goes to the BFF, which asks
 *    identity-svc (`POST /api/auth/can`).
 *
 * On load, a token already in sessionStorage is not trusted on the client's own say-so:
 * `/api/v1/account` is fetched, and a 401 clears the session. The client believing a
 * stale token is how a signed-out user ends up looking signed-in.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Role, SessionUser } from '@contracts/dto';
import {
  ApiProblem,
  api,
  clearTokens,
  getRefreshToken,
  getToken,
  request,
  setTokens,
} from '../lib/api';

/** identity-svc's own login/register envelope, which is not the same as SessionUser. */
interface AuthEnvelope {
  accessToken: string;
  refreshToken: string;
  expiresInMs: number;
  user: {
    id: string;
    email: string | null;
    mobile: string | null;
    fullName: string | null;
    role: string;
    status: string;
    kycTier: number;
    lang: string;
  };
  requiresStepUp: boolean;
}

/** Map identity's user projection onto the DTO the rest of the UI is typed against. */
function toSessionUser(u: AuthEnvelope['user']): SessionUser {
  return {
    id: u.id,
    displayName: u.fullName ?? u.email ?? u.mobile ?? 'Signed in',
    role: u.role as Role,
    email: u.email ?? undefined,
    mobile: u.mobile ?? undefined,
    locale: u.lang,
  };
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
}

export interface AuthContextValue {
  /** null while signed out or while the stored token is still being verified. */
  user: SessionUser | null;
  /** true until the initial session probe settles. */
  loading: boolean;
  login(email: string, password: string): Promise<SessionUser>;
  register(input: RegisterInput): Promise<SessionUser>;
  logout(): Promise<void>;
  /** Re-read `/account`, e.g. after a profile edit. */
  refresh(): Promise<void>;
  signedIn: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .account()
      .then((acct) => {
        if (!cancelled) setUser(acct as SessionUser);
      })
      .catch((err: unknown) => {
        // A 401 here means the stored token is dead — expire it rather than leave the
        // shell rendering as if the user were still signed in.
        if (cancelled) return;
        if (err instanceof ApiProblem && err.status === 401) clearTokens();
        setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyEnvelope = useCallback((env: AuthEnvelope) => {
    setTokens(env.accessToken, env.refreshToken);
    const u = toSessionUser(env.user);
    setUser(u);
    return u;
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const env = await request<AuthEnvelope>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      return applyEnvelope(env);
    },
    [applyEnvelope],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const env = await request<AuthEnvelope>('/auth/register', {
        method: 'POST',
        body: input,
      });
      return applyEnvelope(env);
    },
    [applyEnvelope],
  );

  const logout = useCallback(async () => {
    const refresh = getRefreshToken();
    // Best-effort server-side revoke: the session registry is identity-svc's, and a
    // local-only sign-out would leave the refresh token live.
    await request('/auth/logout', {
      method: 'POST',
      body: { refreshToken: refresh },
    }).catch(() => undefined);
    clearTokens();
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setUser((await api.account()) as SessionUser);
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 401) {
        clearTokens();
        setUser(null);
      }
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading, login, register, logout, refresh, signedIn: user !== null }),
    [user, loading, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
