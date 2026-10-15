/**
 * Auth passthrough: `/api/v1/auth/*` → identity-svc `/api/auth/*`.
 *
 * The browser must only ever talk to one origin. In dev Vite proxies `/api` at the
 * BFF, and in production the BFF serves the built SPA itself — either way, if
 * registration and login had to be addressed at identity-svc directly, the SPA would
 * need a second origin, a CORS policy, and two different base URLs in the client.
 *
 * This is a *transport*, not an auth implementation: identity-svc still owns password
 * verification, session issuance and step-up. The BFF forwards the body and returns
 * identity's own status code and problem body unchanged, so error codes (`E-VAL-001`,
 * `INVALID_CREDENTIALS`, …) and their `traceId` survive the hop.
 */
import { config } from '../config.js';
import { ApiError, type Router } from '../http.js';
import type { Ctx } from '../db.js';

/** Endpoints identity-svc exposes under /api/auth that the SPA needs. */
const ALLOWED = new Set([
  'register',
  'login',
  'step-up',
  'refresh',
  'logout',
  'me',
]);

const UPSTREAM_TIMEOUT_MS = 8000;

interface UpstreamResult {
  status: number;
  body: unknown;
}

async function forward(ctx: Ctx, subpath: string): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    // The caller's bearer token rides along so `me` / `step-up` / `logout` work.
    const auth = ctx.req.headers.authorization;
    if (auth) headers.authorization = auth;
    if (ctx.body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(`${config.identityOrigin}/api/auth/${subpath}`, {
      method: ctx.method,
      headers,
      body: ctx.body === undefined ? undefined : JSON.stringify(ctx.body),
      signal: controller.signal,
    });

    // 204 and other empty bodies must not be parsed.
    if (res.status === 204) return { status: 204, body: undefined };
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // identity returned a non-JSON body (a proxy error page, say). Surface it as a
      // BFF problem rather than forwarding something the client cannot parse.
      throw new ApiError(
        502,
        'Upstream error',
        'The identity service returned an unparseable response',
        'IDENTITY_BAD_RESPONSE',
      );
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Fail closed and name the dependency: the UI shows this verbatim.
    throw new ApiError(
      503,
      'Service unavailable',
      'The identity service could not be reached',
      'IDENTITY_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Register a passthrough for one identity-svc subpath.
 *
 * `createApp` defaults POST to 201; a login must stay 200 and a failed login must
 * stay identity's own 401, so the handler records the upstream code in
 * `ctx.explicitStatus` and the framework uses it verbatim.
 */
function passthrough(router: Router, subpath: string): void {
  const handler = async (ctx: Ctx) => {
    const { status, body } = await forward(ctx, subpath);
    ctx.explicitStatus = status;
    return body;
  };
  router.get(`/api/v1/auth/${subpath}`, handler);
  router.post(`/api/v1/auth/${subpath}`, handler);
}

export function register(router: Router): void {
  for (const subpath of ALLOWED) passthrough(router, subpath);
}
