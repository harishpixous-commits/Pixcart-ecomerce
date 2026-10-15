import { createHash } from 'node:crypto';
import { config } from './config.js';
import { ApiError, unauthorized, forbidden } from './http.js';
import type { AuthContext, Ctx } from './db.js';

/**
 * Authentication boundary.
 *
 * The BFF does NOT decide who anyone is and does NOT encode RBAC rules. identity-svc
 * (Java) owns password verification, sessions, step-up MFA and the permission matrix;
 * it is the single source of truth (CLAUDE.md §5 — a second implementation of a rule
 * is a second behaviour wearing one name). This module only transports that verdict.
 *
 * Two calls, both short-cached because they are on every request:
 *   POST /api/auth/introspect  -> is this token live, and who is it
 *   POST /api/auth/can         -> does this role hold this capability
 */

interface Introspection {
  active: boolean;
  subject?: string;
  role?: string;
  sessionId?: string;
  stepUpSatisfied?: boolean;
}

interface CapabilityVerdict {
  permitted: boolean;
  access: string;
}

const INTROSPECT_TTL_MS = 30_000;
const CAN_TTL_MS = 60_000;

const introspectCache = new Map<string, { at: number; value: Introspection }>();
const canCache = new Map<string, { at: number; value: CapabilityVerdict }>();

function tokenKey(token: string): string {
  // The cache key must not be a recoverable copy of the bearer token at rest.
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

async function postJson<T>(path: string, body: unknown, timeoutMs = 3000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.identityOrigin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`identity-svc ${path} returned ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function introspect(token: string): Promise<Introspection> {
  const key = tokenKey(token);
  const hit = introspectCache.get(key);
  if (hit && Date.now() - hit.at < INTROSPECT_TTL_MS) return hit.value;

  const value = await postJson<Introspection>('/api/auth/introspect', { token }).catch(
    // Fail closed: if identity-svc cannot be reached, treat the caller as anonymous.
    // An outage must never widen access (CLAUDE.md §5).
    (): Introspection => ({ active: false }),
  );
  introspectCache.set(key, { at: Date.now(), value });
  if (introspectCache.size > 500) {
    const oldest = introspectCache.keys().next().value;
    if (oldest) introspectCache.delete(oldest);
  }
  return value;
}

/** True only when the capability is affirmatively granted. Fail closed. */
export async function can(role: string, capability: string): Promise<boolean> {
  const key = `${role}:${capability}`;
  const hit = canCache.get(key);
  if (hit && Date.now() - hit.at < CAN_TTL_MS) return hit.value.permitted;

  const verdict = await postJson<CapabilityVerdict>('/api/auth/can', {
    role,
    capability,
  }).catch((): CapabilityVerdict => ({ permitted: false, access: 'NONE' }));

  canCache.set(key, { at: Date.now(), value: verdict });
  return verdict.permitted;
}

/** Router middleware: populates `ctx.auth` when a valid bearer token is presented. */
export async function authMiddleware(ctx: Ctx, next: () => Promise<unknown>) {
  const header = ctx.req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) {
      const result = await introspect(token);
      if (result.active && result.subject && result.role) {
        ctx.auth = {
          subject: result.subject,
          role: result.role,
          sessionId: result.sessionId ?? '',
          stepUpSatisfied: result.stepUpSatisfied ?? false,
        };
      }
    }
  }
  return next();
}

export function requireAuth(ctx: Ctx): AuthContext {
  if (!ctx.auth) throw unauthorized('Sign in to continue');
  return ctx.auth;
}

export async function requireRole(ctx: Ctx, ...roles: string[]): Promise<AuthContext> {
  const auth = requireAuth(ctx);
  if (!roles.includes(auth.role)) {
    throw forbidden(`This area requires one of: ${roles.join(', ')}`);
  }
  return auth;
}

/** Capability check against identity-svc. Fails closed. */
export async function requireCapability(ctx: Ctx, capability: string): Promise<AuthContext> {
  const auth = requireAuth(ctx);
  const permitted = await can(auth.role, capability);
  if (!permitted) throw new ForbiddenCapability(capability);
  return auth;
}

class ForbiddenCapability extends ApiError {
  constructor(capability: string) {
    super(403, 'Forbidden', `Your role does not permit ${capability}`, 'CAPABILITY_DENIED', {
      capability,
    });
    this.name = 'ForbiddenCapability';
  }
}

/** Test seam: clears the short caches between cases. */
export function clearAuthCaches(): void {
  introspectCache.clear();
  canCache.clear();
}
