import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AuthContext, Ctx } from './db.js';
import { newTraceId } from './db.js';

/* ------------------------------------------------------------------ *
 * Vol. 7 §7.2 — Error Model (RFC 7807 problem+json).
 * Every failure leaves through here, so the shape is uniform and the
 * trace id is always present for the UI's error state to reveal.
 * ------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly code: string,
    readonly extras: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = 'ApiError';
  }

  toProblem(traceId: string) {
    return {
      type: `https://api.pixcart.pixoustech.com/problems/${this.code}`,
      title: this.title,
      status: this.status,
      detail: this.detail,
      code: this.code,
      traceId,
      ...this.extras,
    };
  }
}

export const badRequest = (detail: string, code = 'BAD_REQUEST') =>
  new ApiError(400, 'Bad request', detail, code);
export const unauthorized = (detail = 'Authentication required') =>
  new ApiError(401, 'Unauthorized', detail, 'UNAUTHENTICATED');
export const forbidden = (detail: string) => new ApiError(403, 'Forbidden', detail, 'FORBIDDEN');
export const notFound = (detail: string) => new ApiError(404, 'Not found', detail, 'NOT_FOUND');
export const conflict = (detail: string, code = 'CONFLICT') =>
  new ApiError(409, 'Conflict', detail, code);
export const unprocessable = (detail: string, fields: Record<string, string> = {}) =>
  new ApiError(422, 'Unprocessable entity', detail, 'VALIDATION_FAILED', { fields });

/* ------------------------------------------------------------------ *
 * Router — path patterns with :params. No framework: the whole routing
 * surface is a sorted list of compiled regexes.
 * ------------------------------------------------------------------ */

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
type Middleware = (ctx: Ctx, next: () => Promise<unknown>) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  private middlewares: Middleware[] = [];

  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:[A-Za-z_]+/g, (m) => {
          keys.push(m.slice(1));
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method: method.toUpperCase(), pattern, keys, handler });
    return this;
  }

  get(p: string, h: Handler) {
    return this.add('GET', p, h);
  }
  post(p: string, h: Handler) {
    return this.add('POST', p, h);
  }
  put(p: string, h: Handler) {
    return this.add('PUT', p, h);
  }
  patch(p: string, h: Handler) {
    return this.add('PATCH', p, h);
  }
  delete(p: string, h: Handler) {
    return this.add('DELETE', p, h);
  }

  async dispatch(ctx: Ctx): Promise<unknown> {
    const match = this.routes.find(
      (r) => r.method === ctx.method && r.pattern.test(ctx.path),
    );
    if (!match) throw notFound(`No route for ${ctx.method} ${ctx.path}`);

    const m = ctx.path.match(match.pattern)!;
    ctx.params = {};
    match.keys.forEach((k, i) => {
      ctx.params[k] = decodeURIComponent(m[i + 1] ?? '');
    });

    let index = -1;
    const run = async (i: number): Promise<unknown> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      if (i === this.middlewares.length) return match.handler(ctx);
      return this.middlewares[i]!(ctx, () => run(i + 1));
    };
    return run(0);
  }
}

/* ------------------------------------------------------------------ *
 * Body parsing / response helpers
 * ------------------------------------------------------------------ */

const MAX_BODY = 1_000_000; // 1 MB

export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'Payload too large', 'Request body exceeds 1 MB', 'PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(badRequest('Request body is not valid JSON', 'MALFORMED_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export interface ServerOptions {
  router: Router;
  /** Serves built SPA assets when set (single-origin production shape). */
  staticRoot?: string;
  onRequest?: (ctx: Ctx, status: number, ms: number) => void;
}

export function createApp(opts: ServerOptions) {
  const { router } = opts;

  return createServer(async (req, res) => {
    const started = Date.now();
    const traceId = (req.headers['x-trace-id'] as string | undefined) ?? newTraceId();
    res.setHeader('x-trace-id', traceId);

    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Ctx = {
      req,
      res,
      traceId,
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      params: {},
      query: url.searchParams,
      body: undefined,
      auth: null,
    };

    try {
      if (ctx.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        res.end();
        return;
      }

      if (ctx.path.startsWith('/api/')) {
        if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
          ctx.body = await readBody(req);
        }
        const result = await router.dispatch(ctx);
        const status =
          ctx.explicitStatus ??
          (res.statusCode !== 200 ? res.statusCode : ctx.method === 'POST' ? 201 : 200);
        if (result === undefined) {
          res.writeHead(status === 201 ? 204 : status);
          res.end();
        } else {
          sendJson(res, status, result);
        }
      } else if (opts.staticRoot) {
        await serveStatic(opts.staticRoot, url.pathname, res);
      } else {
        sendJson(res, 404, {
          type: 'https://api.pixcart.pixoustech.com/problems/NOT_FOUND',
          title: 'Not found',
          status: 404,
          detail: 'No handler',
          code: 'NOT_FOUND',
          traceId,
        });
      }
      opts.onRequest?.(ctx, res.statusCode, Date.now() - started);
    } catch (err) {
      const problem =
        err instanceof ApiError
          ? err.toProblem(traceId)
          : new ApiError(
              500,
              'Internal server error',
              'The request could not be completed.',
              'INTERNAL',
            ).toProblem(traceId);
      if (!(err instanceof ApiError)) {
        // Never leak internals to the client; keep them in the server log.
        console.error(`[${traceId}] ${ctx.method} ${ctx.path}`, err);
      }
      sendJson(res, err instanceof ApiError ? err.status : 500, problem);
      opts.onRequest?.(ctx, err instanceof ApiError ? err.status : 500, Date.now() - started);
    }
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': process.env.BFF_ALLOW_ORIGIN ?? '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,idempotency-key,x-trace-id',
    'access-control-max-age': '86400',
  };
}

/* Minimal static file server — only what the SPA build emits. */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.ico': 'image/x-icon',
};

async function serveStatic(root: string, pathname: string, res: ServerResponse) {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(root, 'index.html'); // SPA fallback
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size });
  createReadStream(file).pipe(res);
}

export type { AuthContext };
export { randomUUID };
