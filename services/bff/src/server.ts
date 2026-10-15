/**
 * BFF entrypoint: builds the router, applies the auth boundary, and starts
 * the HTTP server.
 *
 * The auth middleware runs on every request and transports identity-svc's
 * verdict into `ctx.auth`; it never decides who anyone is (see auth.ts).
 * Route-level RBAC (requireRole / customer) then gates each surface.
 */
import { createApp } from './http.js';
import { authMiddleware } from './auth.js';
import { config } from './config.js';
import { closePool } from './db.js';
import { buildRouter } from './routes/index.js';

const router = buildRouter();
router.use(authMiddleware);

const app = createApp({ router, staticRoot: config.webRoot || undefined });

const server = app.listen(config.port, config.host, () => {
  console.log(`bff listening on http://${config.host}:${config.port} (identity: ${config.identityOrigin})`);
});

function shutdown(signal: string): void {
  console.log(`bff received ${signal}, shutting down`);
  server.close(() => {
    closePool()
      .catch((err) => {
        console.error('error closing db pool on shutdown', err);
      })
      .finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
