/**
 * Typed browser client for the PixCart BFF.
 *
 * Design constraints this file exists to enforce:
 *  - **RFC 7807 everywhere.** The BFF answers every failure with
 *    `application/problem+json` carrying `code` and `traceId` (Vol. 7 §7.2). The UI
 *    must be able to show the traceId in its error state (§8.3), so errors are not
 *    flattened to strings — they keep the whole problem.
 *  - **422 is a field map.** §8.3: "server errors mapped to fields (`E-VAL-001`)".
 *    `ApiProblem.fields` is what puts the message under the right input.
 *  - **Money is never reformatted here.** Amounts arrive as integer paise and stay
 *    that way; formatting happens once, in `lib/format.ts`.
 */

import type { Problem } from '@contracts/dto';

const BASE = '/api/v1';

/**
 * An HTTP failure the BFF actually produced.
 *
 * `fields` is populated on 422 so a form can attach the message to an input.
 * `traceId` is always present — it is the only identifier support needs when a
 * user reports a failure.
 */
export class ApiProblem extends Error {
  readonly problem: Problem;
  readonly status: number;

  constructor(problem: Problem) {
    super(problem.detail || problem.title);
    this.name = 'ApiProblem';
    this.problem = problem;
    this.status = problem.status;
  }

  get code(): string {
    return this.problem.code;
  }

  get traceId(): string {
    return this.problem.traceId;
  }

  get fields(): Record<string, string> | undefined {
    return this.problem.fields;
  }
}

/** Thrown when the network fails before a problem+json body could be read. */
export class ApiNetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ApiNetworkError';
  }
}

/* ------------------------------------------------------------------ *
 * Session token
 * ------------------------------------------------------------------ */

const TOKEN_KEY = 'pixcart.access_token';
const REFRESH_KEY = 'pixcart.refresh_token';

/**
 * Tokens live in sessionStorage, not localStorage.
 *
 * A refresh token that survives the tab closing is a longer-lived credential than
 * the risk model in Vol. 10 §10.3 warrants for an app that has no transport
 * security layer yet (LIMITATIONS — session cookies/CSRF are Step 6). sessionStorage
 * scopes the credential to the tab and clears it when the tab closes.
 */
export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string | null): void {
  sessionStorage.setItem(TOKEN_KEY, accessToken);
  if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
}

export function getRefreshToken(): string | null {
  return sessionStorage.getItem(REFRESH_KEY);
}

/* ------------------------------------------------------------------ *
 * Core request
 * ------------------------------------------------------------------ */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Sent verbatim as the `Idempotency-Key` header (checkout only). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

async function parseProblem(res: Response): Promise<ApiProblem> {
  // Prefer the problem+json body. If the body is missing or not a problem (a proxy
  // error page, say), synthesise one so the UI still has a code and traceId.
  try {
    const body = (await res.json()) as Partial<Problem>;
    return new ApiProblem({
      type: body.type ?? 'about:blank',
      title: body.title ?? (res.statusText || 'Request failed'),
      status: body.status ?? res.status,
      detail: body.detail ?? '',
      code: body.code ?? `HTTP_${res.status}`,
      traceId: body.traceId ?? '',
      fields: body.fields,
    });
  } catch {
    return new ApiProblem({
      type: 'about:blank',
      title: res.statusText || 'Request failed',
      status: res.status,
      detail: '',
      code: `HTTP_${res.status}`,
      traceId: '',
    });
  }
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiNetworkError('Could not reach the server', err);
  }

  if (res.status === 204) return undefined as T;
  if (!res.ok) throw await parseProblem(res);
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  return (await res.json()) as T;
}

const get = <T,>(path: string, signal?: AbortSignal) => request<T>(path, { signal });
const post = <T,>(path: string, body?: unknown, idempotencyKey?: string) =>
  request<T>(path, { method: 'POST', body, idempotencyKey });
const patch = <T,>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body });
const del = <T,>(path: string) => request<T>(path, { method: 'DELETE' });

/** Encode a query string, dropping empty/undefined values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/* ------------------------------------------------------------------ *
 * Endpoints
 *
 * Every path here is a route that exists in services/bff/src/routes/*
 * (verified against the registered router, not assumed). The BFF keys cart
 * mutations by listing ULID, not by a separate line id, and the assistant
 * answers at POST /assistant/ask — there is no suggestions GET.
 * ------------------------------------------------------------------ */

/** Rules-mode assistant answer (FR-AI-*). `mode` is `rules` until an LLM is bound. */
export interface RuleAnswer {
  mode: 'rules';
  answer: string;
  source: string;
  citations: string[];
}

export const api = {
  /* Health & home ------------------------------------------------- */
  health: () => get<{ status: string; service: string; time: string }>('/health'),
  home: (signal?: AbortSignal) => get<unknown>('/home', signal),

  /* Search & catalogue -------------------------------------------- */
  search: (params: Record<string, string | number | undefined>, signal?: AbortSignal) =>
    get<unknown>(`/search${qs(params)}`, signal),
  categories: (signal?: AbortSignal) => get<unknown>('/categories', signal),
  /** `GET /categories/:slug` returns the category plus its product search page. */
  categoryProducts: (slug: string, params: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    get<unknown>(`/categories/${encodeURIComponent(slug)}${qs(params)}`, signal),
  listing: (id: string, signal?: AbortSignal) => get<unknown>(`/listings/${encodeURIComponent(id)}`, signal),
  reviews: (id: string, signal?: AbortSignal) => get<unknown>(`/listings/${encodeURIComponent(id)}/reviews`, signal),
  reviewSummary: (id: string, signal?: AbortSignal) =>
    get<unknown>(`/listings/${encodeURIComponent(id)}/review-summary`, signal),
  postReview: (id: string, body: { rating: number; title: string; body: string }) =>
    post<unknown>(`/listings/${encodeURIComponent(id)}/reviews`, body),

  /* Cart & checkout ----------------------------------------------- *
   * The BFF keys cart lines by listing ULID (PUT /cart/lines/:listingId);
   * there is no separate line id. */
  cart: (signal?: AbortSignal) => get<unknown>('/cart', signal),
  addLine: (body: { listingId: string; qty: number }) => post<unknown>('/cart/lines', body),
  patchLine: (listingId: string, body: { qty: number }) =>
    request<unknown>(`/cart/lines/${encodeURIComponent(listingId)}`, { method: 'PUT', body }),
  removeLine: (listingId: string) => del<unknown>(`/cart/lines/${encodeURIComponent(listingId)}`),
  saveForLater: (listingId: string) => post<unknown>(`/cart/lines/${encodeURIComponent(listingId)}/save`),
  moveToCart: (listingId: string) =>
    post<unknown>(`/cart/lines/${encodeURIComponent(listingId)}/move-to-cart`),
  quote: (body: { addressPin: string; paymentMethod: 'PREPAID' | 'COD'; couponCodes?: string[] }) =>
    post<unknown>('/checkout/quote', body),
  placeOrder: (
    body: {
      quoteId: string;
      grandTotalPaise: number;
      addressId: string;
      paymentMethod: 'PREPAID' | 'COD';
      paymentRef?: string;
    },
    idempotencyKey?: string,
  ) => post<{ orderId: string; replay: boolean }>('/checkout/orders', body, idempotencyKey),

  /* Orders & returns ---------------------------------------------- */
  /** Keyset page (Vol. 7 §7.3); pass `cursor` from a previous page's `nextCursor`. */
  orders: (cursor?: string | null, signal?: AbortSignal) =>
    get<unknown>(`/orders${qs({ cursor: cursor ?? undefined })}`, signal),
  order: (id: string, signal?: AbortSignal) => get<unknown>(`/orders/${encodeURIComponent(id)}`, signal),
  cancelOrder: (id: string) => post<unknown>(`/orders/${encodeURIComponent(id)}/cancel`),
  returns: (signal?: AbortSignal) => get<unknown>('/returns', signal),
  createReturn: (body: unknown) => post<unknown>('/returns', body),
  ret: (id: string, signal?: AbortSignal) => get<unknown>(`/returns/${encodeURIComponent(id)}`, signal),
  cancelReturn: (id: string) => post<unknown>(`/returns/${encodeURIComponent(id)}/cancel`),

  /* Account -------------------------------------------------------- */
  account: (signal?: AbortSignal) => get<unknown>('/account', signal),
  patchAccount: (body: unknown) => patch<unknown>('/account', body),
  addresses: (signal?: AbortSignal) => get<unknown>('/account/addresses', signal),
  createAddress: (body: unknown) => post<unknown>('/account/addresses', body),
  patchAddress: (id: string, body: unknown) => patch<unknown>(`/account/addresses/${encodeURIComponent(id)}`, body),
  deleteAddress: (id: string) => del<unknown>(`/account/addresses/${encodeURIComponent(id)}`),
  setAddressDefault: (id: string) =>
    request<unknown>(`/account/addresses/${encodeURIComponent(id)}/default`, { method: 'PUT' }),
  wallet: (signal?: AbortSignal) => get<unknown>('/account/wallet', signal),
  loyalty: (signal?: AbortSignal) => get<unknown>('/account/loyalty', signal),
  consents: (signal?: AbortSignal) => get<unknown>('/account/consents', signal),
  setConsent: (body: unknown) => post<unknown>('/account/consents', body),
  /** `unreadOnly` is optional so a bare `api.notifications` reference still typechecks. */
  notifications: (unreadOnly?: boolean, signal?: AbortSignal) =>
    get<unknown>(`/account/notifications${unreadOnly ? '?unread=true' : ''}`, signal),
  readNotification: (id: string) => post<unknown>(`/account/notifications/${encodeURIComponent(id)}/read`),
  readAllNotifications: () => post<{ marked: number }>('/account/notifications/read-all'),
  wishlist: (signal?: AbortSignal) => get<unknown>('/wishlist', signal),
  /** The listing rides in the body; the BFF route is POST /wishlist, not /wishlist/:id. */
  addWishlist: (listingId: string) => post<unknown>('/wishlist', { listingId }),
  removeWishlist: (listingId: string) => del<unknown>(`/wishlist/${encodeURIComponent(listingId)}`),

  /* Assistant ------------------------------------------------------ *
   * There is no suggestions GET; the BFF answers at POST /assistant/ask. */
  assistantSuggestions: (question: string, signal?: AbortSignal) =>
    request<RuleAnswer>('/assistant/ask', { method: 'POST', body: { question }, signal }),

  /* Vendor --------------------------------------------------------- */
  vendorDashboard: (signal?: AbortSignal) => get<unknown>('/vendor/dashboard', signal),
  vendorProducts: (signal?: AbortSignal) => get<unknown>('/vendor/listings', signal),
  createVendorProduct: (body: unknown) => post<unknown>('/vendor/listings', body),
  vendorProduct: (id: string, signal?: AbortSignal) =>
    get<unknown>(`/vendor/listings/${encodeURIComponent(id)}`, signal),
  /** Regulated edits (title/MRP/HSN) move a listing back to SUBMITTED via a revision. */
  patchVendorProduct: (id: string, body: unknown) =>
    post<unknown>(`/vendor/listings/${encodeURIComponent(id)}/revisions`, body),
  vendorInventory: (signal?: AbortSignal) => get<unknown>('/vendor/inventory', signal),
  /** Absolute mode: the console posts the onHand it shows; the BFF resolves the row. */
  patchInventory: (variantSku: string, body: { onHand: number }) =>
    post<unknown>('/vendor/inventory/adjust', { variantSku, ...body }),
  vendorOrders: (signal?: AbortSignal) => get<unknown>('/vendor/orders', signal),
  vendorOrderState: (id: string, body: { state: string }) =>
    post<unknown>(`/vendor/orders/${encodeURIComponent(id)}/transition`, { to: body.state }),
  vendorLedger: (signal?: AbortSignal) => get<unknown>('/vendor/ledger', signal),
  vendorSettlements: (signal?: AbortSignal) => get<unknown>('/vendor/settlements', signal),
  vendorOnboarding: (signal?: AbortSignal) => get<unknown>('/vendor/onboarding', signal),
  patchVendorOnboarding: (body: unknown) => patch<unknown>('/vendor/onboarding', body),

  /* Admin ---------------------------------------------------------- */
  adminOverview: (signal?: AbortSignal) => get<unknown>('/admin/overview', signal),
  adminApprovals: (signal?: AbortSignal) => get<unknown>('/admin/approvals', signal),
  decideApproval: (id: string, body: unknown) =>
    post<unknown>(`/admin/approvals/${encodeURIComponent(id)}/decide`, body),
  adminCategories: (signal?: AbortSignal) => get<unknown>('/admin/categories', signal),
  createCategory: (body: unknown) => post<unknown>('/admin/categories', body),
  patchCategory: (id: string, body: unknown) =>
    patch<unknown>(`/admin/categories/${encodeURIComponent(id)}`, body),
  adminOrders: (signal?: AbortSignal) => get<unknown>('/admin/orders', signal),
  adminCoupons: (signal?: AbortSignal) => get<unknown>('/admin/coupons', signal),
  createCoupon: (body: unknown) => post<unknown>('/admin/coupons', body),
  patchCoupon: (id: string, body: unknown) => patch<unknown>(`/admin/coupons/${encodeURIComponent(id)}`, body),
  adminCms: (signal?: AbortSignal) => get<unknown>('/admin/cms', signal),
  createCms: (body: unknown) => post<unknown>('/admin/cms', body),
  patchCms: (id: string, body: unknown) => patch<unknown>(`/admin/cms/${encodeURIComponent(id)}`, body),
  adminFinance: (signal?: AbortSignal) => get<unknown>('/admin/finance/overview', signal),
  adminUsers: (signal?: AbortSignal) => get<unknown>('/admin/users', signal),
  createUser: (body: unknown) => post<unknown>('/admin/users', body),
  patchUser: (id: string, body: unknown) => patch<unknown>(`/admin/users/${encodeURIComponent(id)}`, body),
  adminAudit: (signal?: AbortSignal) => get<unknown>('/admin/audit', signal),
} as const;
