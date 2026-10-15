/**
 * Contract test for the typed BFF client.
 *
 * What this file exists to guarantee (CLAUDE.md §6 — make the property structural):
 * the client's wire shape is the BFF's registered routes, asserted one method at a
 * time from a table, so a path or verb drift fails here rather than in a screen at
 * runtime. It asserts the request line only — the BFF's own handlers are covered by
 * services/bff tests — and it never touches a network.
 *
 * The last test is a filesystem guard: the per-directory `screens/customer/bff`
 * shim is gone and must not come back. Two clients for one API is two behaviours
 * wearing one name (CLAUDE.md §5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
// jsdom installs its own `URL` global, which node:url's fileURLToPath refuses; take
// Node's class explicitly so the path below resolves to this module's directory.
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { ApiNetworkError, ApiProblem, api, clearTokens, getToken, qs, setTokens } from './api';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let captured: Captured[] = [];

/** Answer every request with a 200 carrying `body`, and record what was sent. */
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    captured.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: headers ?? {},
      body: init.body === undefined ? undefined : String(init.body),
    });
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: '',
      headers: new Headers({ 'content-length': JSON.stringify(body ?? '').length ? '1' : '0' }),
      json: async () => body,
    } as unknown as Response;
  });
}

beforeEach(() => {
  captured = [];
  clearTokens();
  stubFetch(200, { ok: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearTokens();
});

/** The last request, asserted to be the one the method under test issued. */
function only(): Captured {
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

const ID = '01HZY9K3M4N5P6Q7R8S9T0VWXY';

/* ------------------------------------------------------------------ *
 * One row per exported method: verb + path (+ the JSON body where the
 * BFF reads one). This is the old→new alignment table in executable form.
 * ------------------------------------------------------------------ */
interface Case {
  name: string;
  call: () => Promise<unknown>;
  method: string;
  path: string;
  body?: unknown;
}

const CASES: Case[] = [
  /* Health, home, catalogue ---------------------------------------- */
  { name: 'health', call: () => api.health(), method: 'GET', path: '/api/v1/health' },
  { name: 'home', call: () => api.home(), method: 'GET', path: '/api/v1/home' },
  {
    name: 'search',
    call: () => api.search({ q: 'running shoes', sort: 'price_asc' }),
    method: 'GET',
    path: '/api/v1/search?q=running+shoes&sort=price_asc',
  },
  { name: 'categories', call: () => api.categories(), method: 'GET', path: '/api/v1/categories' },
  {
    name: 'categoryProducts',
    call: () => api.categoryProducts('phones', { limit: 8 }),
    method: 'GET',
    path: '/api/v1/categories/phones?limit=8',
  },
  { name: 'listing', call: () => api.listing(ID), method: 'GET', path: `/api/v1/listings/${ID}` },
  {
    name: 'reviews',
    call: () => api.reviews(ID),
    method: 'GET',
    path: `/api/v1/listings/${ID}/reviews`,
  },
  {
    name: 'reviewSummary',
    call: () => api.reviewSummary(ID),
    method: 'GET',
    path: `/api/v1/listings/${ID}/review-summary`,
  },
  {
    name: 'postReview',
    call: () => api.postReview(ID, { rating: 5, title: 'Great', body: 'No complaints' }),
    method: 'POST',
    path: `/api/v1/listings/${ID}/reviews`,
    body: { rating: 5, title: 'Great', body: 'No complaints' },
  },

  /* Cart: keyed by listing ULID, no separate line id ---------------- */
  { name: 'cart', call: () => api.cart(), method: 'GET', path: '/api/v1/cart' },
  {
    name: 'addLine',
    call: () => api.addLine({ listingId: ID, qty: 2 }),
    method: 'POST',
    path: '/api/v1/cart/lines',
    body: { listingId: ID, qty: 2 },
  },
  {
    name: 'patchLine',
    call: () => api.patchLine(ID, { qty: 3 }),
    method: 'PUT',
    path: `/api/v1/cart/lines/${ID}`,
    body: { qty: 3 },
  },
  {
    name: 'removeLine',
    call: () => api.removeLine(ID),
    method: 'DELETE',
    path: `/api/v1/cart/lines/${ID}`,
  },
  {
    name: 'saveForLater',
    call: () => api.saveForLater(ID),
    method: 'POST',
    path: `/api/v1/cart/lines/${ID}/save`,
  },
  {
    name: 'moveToCart',
    call: () => api.moveToCart(ID),
    method: 'POST',
    path: `/api/v1/cart/lines/${ID}/move-to-cart`,
  },

  /* Checkout -------------------------------------------------------- */
  {
    name: 'quote',
    call: () => api.quote({ addressPin: '560001', paymentMethod: 'COD' }),
    method: 'POST',
    path: '/api/v1/checkout/quote',
    body: { addressPin: '560001', paymentMethod: 'COD' },
  },
  {
    name: 'placeOrder',
    call: () =>
      api.placeOrder(
        { quoteId: 'Q1', grandTotalPaise: 199900, addressId: ID, paymentMethod: 'COD' },
        'key-1',
      ),
    method: 'POST',
    path: '/api/v1/checkout/orders',
    body: { quoteId: 'Q1', grandTotalPaise: 199900, addressId: ID, paymentMethod: 'COD' },
  },

  /* Orders & returns: orders takes a keyset cursor ------------------ */
  { name: 'orders (first page)', call: () => api.orders(), method: 'GET', path: '/api/v1/orders' },
  {
    name: 'orders (cursor page)',
    call: () => api.orders('CURSOR123'),
    method: 'GET',
    path: '/api/v1/orders?cursor=CURSOR123',
  },
  { name: 'order', call: () => api.order(ID), method: 'GET', path: `/api/v1/orders/${ID}` },
  {
    name: 'cancelOrder',
    call: () => api.cancelOrder(ID),
    method: 'POST',
    path: `/api/v1/orders/${ID}/cancel`,
  },
  { name: 'returns', call: () => api.returns(), method: 'GET', path: '/api/v1/returns' },
  {
    name: 'createReturn',
    call: () => api.createReturn({ subOrderId: ID, listingId: ID, qty: 1, reasonCode: 'DAMAGED' }),
    method: 'POST',
    path: '/api/v1/returns',
    body: { subOrderId: ID, listingId: ID, qty: 1, reasonCode: 'DAMAGED' },
  },
  { name: 'ret', call: () => api.ret(ID), method: 'GET', path: `/api/v1/returns/${ID}` },
  {
    name: 'cancelReturn',
    call: () => api.cancelReturn(ID),
    method: 'POST',
    path: `/api/v1/returns/${ID}/cancel`,
  },

  /* Account & addresses --------------------------------------------- */
  { name: 'account', call: () => api.account(), method: 'GET', path: '/api/v1/account' },
  {
    name: 'patchAccount',
    call: () => api.patchAccount({ displayName: 'Ananya S.' }),
    method: 'PATCH',
    path: '/api/v1/account',
    body: { displayName: 'Ananya S.' },
  },
  { name: 'addresses', call: () => api.addresses(), method: 'GET', path: '/api/v1/account/addresses' },
  {
    name: 'createAddress',
    call: () => api.createAddress({ label: 'HOME', line1: '14 Lavelle Road', city: 'Bengaluru' }),
    method: 'POST',
    path: '/api/v1/account/addresses',
    body: { label: 'HOME', line1: '14 Lavelle Road', city: 'Bengaluru' },
  },
  {
    name: 'patchAddress',
    call: () => api.patchAddress(ID, { city: 'Mumbai' }),
    method: 'PATCH',
    path: `/api/v1/account/addresses/${ID}`,
    body: { city: 'Mumbai' },
  },
  {
    name: 'deleteAddress',
    call: () => api.deleteAddress(ID),
    method: 'DELETE',
    path: `/api/v1/account/addresses/${ID}`,
  },
  {
    name: 'setAddressDefault is a PUT, not a PATCH',
    call: () => api.setAddressDefault(ID),
    method: 'PUT',
    path: `/api/v1/account/addresses/${ID}/default`,
  },
  { name: 'wallet', call: () => api.wallet(), method: 'GET', path: '/api/v1/account/wallet' },
  { name: 'loyalty', call: () => api.loyalty(), method: 'GET', path: '/api/v1/account/loyalty' },
  { name: 'consents', call: () => api.consents(), method: 'GET', path: '/api/v1/account/consents' },
  {
    name: 'setConsent',
    call: () => api.setConsent({ purpose: 'MARKETING', granted: true, policyVer: '2026-01' }),
    method: 'POST',
    path: '/api/v1/account/consents',
    body: { purpose: 'MARKETING', granted: true, policyVer: '2026-01' },
  },
  {
    name: 'notifications (all)',
    call: () => api.notifications(),
    method: 'GET',
    path: '/api/v1/account/notifications',
  },
  {
    name: 'notifications (unreadOnly)',
    call: () => api.notifications(true),
    method: 'GET',
    path: '/api/v1/account/notifications?unread=true',
  },
  {
    name: 'readNotification',
    call: () => api.readNotification(ID),
    method: 'POST',
    path: `/api/v1/account/notifications/${ID}/read`,
  },
  {
    name: 'readAllNotifications',
    call: () => api.readAllNotifications(),
    method: 'POST',
    path: '/api/v1/account/notifications/read-all',
  },

  /* Wishlist: the listing rides in the body ------------------------- */
  { name: 'wishlist', call: () => api.wishlist(), method: 'GET', path: '/api/v1/wishlist' },
  {
    name: 'addWishlist posts the listing id in the body',
    call: () => api.addWishlist(ID),
    method: 'POST',
    path: '/api/v1/wishlist',
    body: { listingId: ID },
  },
  {
    name: 'removeWishlist',
    call: () => api.removeWishlist(ID),
    method: 'DELETE',
    path: `/api/v1/wishlist/${ID}`,
  },

  /* Assistant: one POST route, no suggestions GET ------------------- */
  {
    name: 'assistantSuggestions asks POST /assistant/ask',
    call: () => api.assistantSuggestions('what is the cod limit?'),
    method: 'POST',
    path: '/api/v1/assistant/ask',
    body: { question: 'what is the cod limit?' },
  },

  /* Vendor ---------------------------------------------------------- */
  {
    name: 'vendorDashboard',
    call: () => api.vendorDashboard(),
    method: 'GET',
    path: '/api/v1/vendor/dashboard',
  },
  { name: 'vendorProducts', call: () => api.vendorProducts(), method: 'GET', path: '/api/v1/vendor/listings' },
  {
    name: 'createVendorProduct keys the category as categoryId',
    call: () =>
      api.createVendorProduct({
        title: 'Test listing',
        mrpPaise: 99900,
        pricePaise: 89900,
        hsnCode: '85171200',
        categoryId: ID,
      }),
    method: 'POST',
    path: '/api/v1/vendor/listings',
    body: { title: 'Test listing', mrpPaise: 99900, pricePaise: 89900, hsnCode: '85171200', categoryId: ID },
  },
  {
    name: 'vendorProduct',
    call: () => api.vendorProduct(ID),
    method: 'GET',
    path: `/api/v1/vendor/listings/${ID}`,
  },
  {
    name: 'patchVendorProduct is a revision, not a PATCH',
    call: () => api.patchVendorProduct(ID, { title: 'New title' }),
    method: 'POST',
    path: `/api/v1/vendor/listings/${ID}/revisions`,
    body: { title: 'New title' },
  },
  { name: 'vendorInventory', call: () => api.vendorInventory(), method: 'GET', path: '/api/v1/vendor/inventory' },
  {
    name: 'patchInventory (absolute mode)',
    call: () => api.patchInventory('SKU-1', { onHand: 12 }),
    method: 'POST',
    path: '/api/v1/vendor/inventory/adjust',
    body: { variantSku: 'SKU-1', onHand: 12 },
  },
  { name: 'vendorOrders', call: () => api.vendorOrders(), method: 'GET', path: '/api/v1/vendor/orders' },
  {
    name: 'vendorOrderState',
    call: () => api.vendorOrderState(ID, { state: 'PACKED' }),
    method: 'POST',
    path: `/api/v1/vendor/orders/${ID}/transition`,
    body: { to: 'PACKED' },
  },
  { name: 'vendorLedger', call: () => api.vendorLedger(), method: 'GET', path: '/api/v1/vendor/ledger' },
  {
    name: 'vendorSettlements',
    call: () => api.vendorSettlements(),
    method: 'GET',
    path: '/api/v1/vendor/settlements',
  },
  {
    name: 'vendorOnboarding',
    call: () => api.vendorOnboarding(),
    method: 'GET',
    path: '/api/v1/vendor/onboarding',
  },
  {
    name: 'patchVendorOnboarding',
    call: () => api.patchVendorOnboarding({ displayName: 'Urban Cart' }),
    method: 'PATCH',
    path: '/api/v1/vendor/onboarding',
    body: { displayName: 'Urban Cart' },
  },

  /* Admin ----------------------------------------------------------- */
  { name: 'adminOverview', call: () => api.adminOverview(), method: 'GET', path: '/api/v1/admin/overview' },
  { name: 'adminApprovals', call: () => api.adminApprovals(), method: 'GET', path: '/api/v1/admin/approvals' },
  {
    name: 'decideApproval',
    call: () => api.decideApproval(ID, { decision: 'APPROVED' }),
    method: 'POST',
    path: `/api/v1/admin/approvals/${ID}/decide`,
    body: { decision: 'APPROVED' },
  },
  {
    name: 'adminCategories',
    call: () => api.adminCategories(),
    method: 'GET',
    path: '/api/v1/admin/categories',
  },
  {
    name: 'createCategory',
    call: () => api.createCategory({ name: 'Audio', slug: 'audio' }),
    method: 'POST',
    path: '/api/v1/admin/categories',
    body: { name: 'Audio', slug: 'audio' },
  },
  {
    name: 'patchCategory',
    call: () => api.patchCategory(ID, { name: 'Audio gear' }),
    method: 'PATCH',
    path: `/api/v1/admin/categories/${ID}`,
    body: { name: 'Audio gear' },
  },
  { name: 'adminOrders', call: () => api.adminOrders(), method: 'GET', path: '/api/v1/admin/orders' },
  { name: 'adminCoupons', call: () => api.adminCoupons(), method: 'GET', path: '/api/v1/admin/coupons' },
  {
    name: 'createCoupon',
    call: () => api.createCoupon({ code: 'SAVE100', kind: 'FLAT', valuePaise: 10000 }),
    method: 'POST',
    path: '/api/v1/admin/coupons',
    body: { code: 'SAVE100', kind: 'FLAT', valuePaise: 10000 },
  },
  {
    name: 'patchCoupon',
    call: () => api.patchCoupon(ID, { status: 'PAUSED' }),
    method: 'PATCH',
    path: `/api/v1/admin/coupons/${ID}`,
    body: { status: 'PAUSED' },
  },
  { name: 'adminCms', call: () => api.adminCms(), method: 'GET', path: '/api/v1/admin/cms' },
  {
    name: 'createCms',
    call: () => api.createCms({ kind: 'PAGE', slug: 'faq', title: 'FAQ' }),
    method: 'POST',
    path: '/api/v1/admin/cms',
    body: { kind: 'PAGE', slug: 'faq', title: 'FAQ' },
  },
  {
    name: 'patchCms',
    call: () => api.patchCms(ID, { title: 'FAQ v2' }),
    method: 'PATCH',
    path: `/api/v1/admin/cms/${ID}`,
    body: { title: 'FAQ v2' },
  },
  {
    name: 'adminFinance',
    call: () => api.adminFinance(),
    method: 'GET',
    path: '/api/v1/admin/finance/overview',
  },
  { name: 'adminUsers', call: () => api.adminUsers(), method: 'GET', path: '/api/v1/admin/users' },
  {
    name: 'createUser',
    call: () => api.createUser({ fullName: 'Meera Joshi', email: 'meera@pixcart.in', role: 'SUPPORT' }),
    method: 'POST',
    path: '/api/v1/admin/users',
    body: { fullName: 'Meera Joshi', email: 'meera@pixcart.in', role: 'SUPPORT' },
  },
  {
    name: 'patchUser',
    call: () => api.patchUser(ID, { status: 'SUSPENDED' }),
    method: 'PATCH',
    path: `/api/v1/admin/users/${ID}`,
    body: { status: 'SUSPENDED' },
  },
  { name: 'adminAudit', call: () => api.adminAudit(), method: 'GET', path: '/api/v1/admin/audit' },
];

describe('api client: every method addresses a registered BFF route', () => {
  for (const c of CASES) {
    it(`${c.method} ${c.path.replace(ID, ':id')}  ←  api.${c.name}`, async () => {
      await c.call();
      const req = only();
      expect(req.method).toBe(c.method);
      // `request` joins BASE ('/api/v1') to the method's path; CASES carry the full
      // joined path, so this pins the exact string that reaches fetch.
      expect(req.url).toBe(c.path);
      if (c.body !== undefined) expect(JSON.parse(req.body!)).toEqual(c.body);
    });
  }

  it('sends no Authorization header when signed out', async () => {
    await api.cart();
    expect(only().headers.Authorization).toBeUndefined();
  });

  it('sends the bearer token when signed in', async () => {
    setTokens('tok-abc', 'ref-abc');
    expect(getToken()).toBe('tok-abc');
    await api.cart();
    expect(only().headers.Authorization).toBe('Bearer tok-abc');
  });

  it('forwards the Idempotency-Key verbatim (checkout only)', async () => {
    await api.placeOrder(
      { quoteId: 'Q1', grandTotalPaise: 1, addressId: ID, paymentMethod: 'COD' },
      'my-key',
    );
    expect(only().headers['Idempotency-Key']).toBe('my-key');
  });

  it('returns undefined for a 204 rather than trying to parse a body', async () => {
    stubFetch(204, undefined);
    await expect(api.removeLine(ID)).resolves.toBeUndefined();
  });
});

describe('error handling keeps the problem, not a flattened string', () => {
  it('surfaces an unauthenticated request as a 401 problem with its traceId', async () => {
    stubFetch(401, {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Sign in to continue',
      code: 'E-AUTH-001',
      traceId: 'trace-401',
    });
    const err = await api.cart().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiProblem);
    const problem = err as ApiProblem;
    expect(problem.status).toBe(401);
    expect(problem.code).toBe('E-AUTH-001');
    expect(problem.traceId).toBe('trace-401');
    expect(problem.fields).toBeUndefined();
  });

  it('keeps the 422 field map so a form can attach it to an input', async () => {
    stubFetch(422, {
      title: 'Unprocessable',
      status: 422,
      detail: 'pincode must be 6 digits',
      code: 'E-VAL-001',
      traceId: 'trace-422',
      fields: { pincode: 'must be 6 digits' },
    });
    const err = await api
      .createAddress({ pincode: '12' })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ApiProblem);
    expect((err as ApiProblem).fields).toEqual({ pincode: 'must be 6 digits' });
  });

  it('wraps a transport failure rather than leaking a raw fetch rejection', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await api.health().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiNetworkError);
  });
});

describe('qs drops empty values instead of sending blank params', () => {
  it('omits undefined, null and empty-string keys', () => {
    expect(qs({ q: 'phone', sort: '', limit: undefined, cursor: null })).toBe('?q=phone');
  });

  it('returns an empty string when nothing survives', () => {
    expect(qs({ a: undefined, b: '' })).toBe('');
  });
});

describe('the screens/customer/bff shim stays deleted', () => {
  const shim = fileURLToPath(new NodeURL('../screens/customer/bff.ts', import.meta.url));

  it('does not exist on disk', () => {
    expect(existsSync(shim)).toBe(false);
  });
});
