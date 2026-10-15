import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import mariadb from 'mariadb';
import type { Pool, PoolConfig } from 'mariadb';
import { config } from './config.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = mariadb.createPool({
      ...config.db,
      connectionLimit: 10,
      acquireTimeout: 10000,
      // MariaDB's client emits an SSL warning on a local passwordless login; that
      // warning must never be mixed into a result set (it corrupted the migration
      // gate's output until it was suppressed).
      ssl: false,
    } satisfies PoolConfig);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Run a query and return every row. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const conn = await getPool().getConnection();
  try {
    return (await conn.query(sql, params as unknown[])) as T[];
  } finally {
    conn.release();
  }
}

/** Run a query and return the first row, or undefined. */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

/**
 * Run `fn` inside a transaction. Any throw rolls back.
 *
 * Used by every write path that touches more than one table so a partial write can
 * never be observed — the same guarantee the schema's CHECK constraints give within
 * a single statement.
 */
export async function tx<T>(fn: (conn: mariadb.Connection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}

/* ------------------------------------------------------------------ *
 * Request context: every request carries a trace id so the UI can show
 * it on failure (Vol. 8 §8.3 "error (retry + trace-id reveal)").
 * ------------------------------------------------------------------ */

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  traceId: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Populated by the auth middleware when a valid bearer token is present. */
  auth: AuthContext | null;
  /**
   * Set by a handler that must control the response status exactly, e.g. a
   * passthrough that has to preserve identity-svc's own code (200 for a login,
   * 401 for bad credentials). When set, `createApp` uses it verbatim instead of
   * the method-derived default of 201-on-POST / 200-otherwise.
   */
  explicitStatus?: number;
}

export interface AuthContext {
  subject: string;
  role: string;
  sessionId: string;
  stepUpSatisfied?: boolean;
}

export function newTraceId(): string {
  return randomUUID();
}
