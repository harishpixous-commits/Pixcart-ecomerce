/**
 * PORT of `services/cart-checkout-svc/src/domain/promotions/core.ts`
 * (FR-MKT-010 core types and money arithmetic).
 *
 * Why a port instead of an import: identical to `query-understanding.ts` in
 * this directory - `tsc` rejects the cross-package import with TS6059 (file is
 * not under the BFF's `rootDir: src`), the sibling package has no build output,
 * and Node 18 cannot execute the TypeScript sources directly. The BFF also has
 * no `zod` dependency (package.json is outside the permitted edit scope), so
 * the zod schemas are represented as TypeScript types here; input validation
 * happens once at the BFF edge (422 with `fields`), and the ARITHMETIC below
 * (`halfEvenDiv`, `allocateLargestRemainder`, `fromPaise`, `toPaise`) is
 * copied verbatim. If core.ts changes, change this copy in the same commit.
 *
 * ---- original header ----
 * FR-MKT-010  single deterministic discount waterfall used identically by UI,
 *             assistant and APIs; explainable; allocation map drives refunds
 * FR-MKT-001  coupon eligibility with specific rejection reason codes
 * BRU-14      one platform coupon per order; stacking flags
 * FR-FIN-001  paisa-exact, deterministic rounding half-even
 * Vol. 7      money is a string "1234.50" at the API edge; integer paise inside
 */

/** Integer paise. Rs.1 = 100. Max money value 10^12 paise sits far below 2^53. */
export type Paise = number;

const MONEY_RE = /^\d{1,10}(\.\d{2})?$/;

/** Parse an edge-format money string ("1999.00") into integer paise. */
export function toPaise(s: string): Paise {
  if (!MONEY_RE.test(s)) throw new Error(`invalid money string: ${s}`);
  const [r, p = '00'] = s.split('.');
  return Number(r) * 100 + Number(p);
}

/** Render integer paise as the edge money string. */
export function fromPaise(p: Paise): string {
  if (!Number.isInteger(p) || p < 0) throw new Error(`invalid paise: ${p}`);
  const r = Math.floor(p / 100);
  return `${r}.${String(p % 100).padStart(2, '0')}`;
}

/**
 * Banker's division: round n/d to the nearest integer, ties to even
 * (FR-FIN-001 "deterministic rounding half-even"). n >= 0, d > 0, integers.
 */
export function halfEvenDiv(n: number, d: number): number {
  const q = Math.floor(n / d);
  const twiceRem = 2 * (n - q * d);
  if (twiceRem < d) return q;
  if (twiceRem > d) return q + 1;
  return q % 2 === 0 ? q : q + 1;
}

/**
 * Split `total` across `weights` so the parts sum to EXACTLY `total`
 * (largest-remainder method, ties to the lower index - deterministic).
 * The allocation map later drives refund claw-back (FR-MKT-010), so a
 * single leaked paisa here becomes a reconciliation exception in finance.
 */
export function allocateLargestRemainder(total: Paise, weights: Paise[]): Paise[] {
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || weights.length === 0) return weights.map(() => 0);
  if (wSum === 0) throw new Error('cannot allocate over zero total weight');
  const raw = weights.map((w) => ({ floor: Math.floor((total * w) / wSum), rem: (total * w) % wSum }));
  let assigned = raw.reduce((a, x) => a + x.floor, 0);
  const order = raw
    .map((x, i) => ({ i, rem: x.rem }))
    .sort((a, b) => (b.rem - a.rem) || (a.i - b.i));
  const out = raw.map((x) => x.floor);
  for (let k = 0; assigned < total; k++, assigned++) {
    const idx = order[k]!.i; // mechanical: noUncheckedIndexedAccess (see header)
    out[idx] = out[idx]! + 1;
  }
  return out;
}

// ---------------------------------------------------------------- input types
// The source validates these shapes with zod (CouponSchema etc.). The BFF
// validates equivalent constraints at its request edge instead; the engine
// consumes the already-validated typed values below.

export interface CartLine {
  lineId: string;
  listingId: string;
  vendorId: string;
  categoryId: string;
  qty: number;                          // FR-CUS-007 per-line cap 1..10
  unitListPaise: Paise;
  unitSalePaise?: Paise;                // effective if < list
}

export interface Coupon {
  id: string;
  code: string;
  level: 'PLATFORM' | 'VENDOR';
  vendorId?: string;                    // required when level=VENDOR
  kind: 'PERCENT' | 'FLAT';
  /** PERCENT: basis points (1500 = 15%). FLAT: paise. */
  value: number;
  maxDiscountPaise?: number;            // cap for PERCENT
  minOrderPaise: Paise;
  startsAtMs?: number;
  endsAtMs?: number;
  listingIds?: string[];                // scope allow-list
  categoryIds?: string[];
  tiers?: string[];                     // audience
  firstOrderOnly: boolean;
  perUserRemaining: number;
  budgetRemainingPaise?: number;
  autoApply: boolean;
  /** BRU-14 stacking flag: may this platform coupon coexist with a vendor coupon? */
  stackWithVendorCoupon: boolean;
}

export interface QtyDeal {
  id: string;
  vendorId: string;
  listingIds: string[];
  minQty: number;                       // FR-VEN-006 buy-2-get-x%
  percentBp: number;                    // discount <= 90% (FR-MKT-001)
}

export interface Context {
  nowMs: number;
  userTier?: string;
  isFirstOrder: boolean;
  /** A code the user typed. Explicit intent occupies the platform slot (FR-CUS-011). */
  explicitPlatformCode?: string;
  loyaltyPointsPaise: Paise;            // 1 pt = Rs.1 (FR-CUS-020)
  walletPromo?: {
    requestedPaise: Paise;
    balancePaise: Paise;
  };
}

export interface EngineInput {
  lines: CartLine[];
  coupons: Coupon[];
  qtyDeals: QtyDeal[];
  ctx: Context;
}

// --------------------------------------------------------------- output types

/** Deterministic precedence - FR-MKT-010, normative order. */
export const STAGES = [
  'ITEM_SALE',
  'QTY_DEAL',
  'VENDOR_COUPON',
  'PLATFORM_COUPON',
  'LOYALTY',
  'WALLET_PROMO',
] as const;
export type Stage = (typeof STAGES)[number];

export type RejectionReason =
  | 'CODE_UNKNOWN'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'MIN_ORDER'
  | 'SCOPE_MISMATCH'
  | 'USER_INELIGIBLE'
  | 'PER_USER_CAP'
  | 'BUDGET_EXHAUSTED'
  | 'STACKING_BLOCKED'
  | 'BETTER_ALTERNATIVE'
  | 'ZERO_DISCOUNT';

export interface WaterfallLine {
  stage: Stage;
  sourceId: string;              // e.g. COUPON:WELCOME15, SALE:<listingId>
  label: string;
  amountPaise: Paise;            // Sigma allocation - asserted equal
  allocation: Record<string, Paise>; // lineId -> paise, keys in cart order
}

export interface Rejection {
  sourceId: string;
  reason: RejectionReason;
}

export interface EvaluationResult {
  itemTotalPaise: Paise;         // Sigma qty x unitListPaise (savings baseline)
  waterfall: WaterfallLine[];
  rejected: Rejection[];
  finalPayablePaise: Paise;
  savingsPaise: Paise;
  perLineNetPaise: Record<string, Paise>;
  /** "how you saved Rs.412" - FR-MKT-010 explanation payload, edge money format */
  explain: Array<{ source: string; label: string; amount: string }>;
}
