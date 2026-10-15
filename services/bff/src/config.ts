import type { PoolConfig } from 'mariadb';

/**
 * Configuration.
 *
 * Per Vol. 10 §10.5 the datasource carries no embedded credentials: everything comes
 * from the environment, and a missing value is a startup failure rather than a silent
 * default (CLAUDE.md §5 — refuse rather than silently default).
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.BFF_PORT ?? 8090),
  host: process.env.BFF_HOST ?? '127.0.0.1',
  db: {
    host: required('PIXCART_DB_HOST'),
    port: Number(process.env.PIXCART_DB_PORT ?? 3306),
    user: required('PIXCART_DB_USER'),
    password: process.env.PIXCART_DB_PASSWORD ?? '',
    database: required('PIXCART_DB_NAME'),
    // Keep the SSL-verify warning out of server logs on a local passwordless dev box.
    ssl: false as const,
  } satisfies PoolConfig,
  /**
   * identity-svc (Java) owns auth: password verify, MFA step-up, session issue and the
   * RBAC matrix. The BFF never re-implements those rules — it forwards to this origin.
   */
  identityOrigin: process.env.IDENTITY_ORIGIN ?? 'http://127.0.0.1:8081',
  /** Dev-only: serve the built SPA from the BFF so one origin is enough. */
  webRoot: process.env.BFF_WEB_ROOT ?? '',
};
