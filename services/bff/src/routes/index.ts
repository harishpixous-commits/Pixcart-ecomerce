/**
 * Route registry: composes every route module onto one Router.
 *
 * Each module exports `register(router)` and owns its own paths; this file is
 * the only place that knows the full surface. Adding a module is one import and
 * one call — no private-state reaches, no regex re-derivation.
 */
import { Router } from '../http.js';
import * as authRoutes from './auth.js';
import * as storefront from './storefront.js';
import * as cartRoutes from './cart.js';
import * as account from './account.js';
import * as assistant from './assistant.js';
import * as vendor from './vendor.js';
import * as admin from './admin.js';

/** Build the fully-registered router. */
export function buildRouter(): Router {
  const router = new Router();
  authRoutes.register(router);
  storefront.register(router);
  cartRoutes.register(router);
  account.register(router);
  assistant.register(router);
  vendor.register(router);
  admin.register(router);
  return router;
}
