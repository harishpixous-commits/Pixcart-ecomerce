/**
 * FR-MKT-010 Promotions Engine — core types and money arithmetic.
 *
 * Governing specification (Documentation Suite v1.0):
 *   FR-MKT-010  single deterministic discount waterfall used identically by UI,
 *               assistant and APIs; explainable; allocation map drives refunds
 *   FR-MKT-001  coupon eligibility with specific rejection reason codes
 *   BRU-14      one platform coupon per order; stacking flags
 *   FR-FIN-001  paisa-exact, deterministic rounding half-even
 *   Vol. 7      money is a string "1234.50" at the API edge; integer paise inside
 */
import { z } from 'zod';

/** Integer paise. ₹1 = 100. Max money value 10^12 paise sits far below 2^53. */
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
 * (FR-FIN-001 "deterministic rounding half-even"). n ≥ 0, d > 0, integers.
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
 * (largest-remainder method, ties to the lower index — deterministic).
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
  for (let k = 0; assigned < total; k++, assigned++) out[order[k].i] += 1;
  return out;
}

// ---------------------------------------------------------------- input types

export const CartLineSchema = z.object({
  lineId: z.string().min(1),
  listingId: z.string().min(1),
  vendorId: z.string().min(1),
  categoryId: z.string().min(1),
  qty: z.number().int().min(1).max(10),           // FR-CUS-007 per-line cap
  unitListPaise: z.number().int().nonnegative(),
  unitSalePaise: z.number().int().nonnegative().optional(), // effective if < list
});
export type CartLine = z.infer<typeof CartLineSchema>;

export const CouponSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  level: z.enum(['PLATFORM', 'VENDOR']),
  vendorId: z.string().optional(),                 // required when level=VENDOR
  kind: z.enum(['PERCENT', 'FLAT']),
  /** PERCENT: basis points (1500 = 15%). FLAT: paise. */
  value: z.number().int().positive(),
  maxDiscountPaise: z.number().int().positive().optional(), // cap for PERCENT
  minOrderPaise: z.number().int().nonnegative().default(0),
  startsAtMs: z.number().int().optional(),
  endsAtMs: z.number().int().optional(),
  listingIds: z.array(z.string()).optional(),      // scope allow-list
  categoryIds: z.array(z.string()).optional(),
  tiers: z.array(z.string()).optional(),           // audience
  firstOrderOnly: z.boolean().default(false),
  perUserRemaining: z.number().int().nonnegative().default(1),
  budgetRemainingPaise: z.number().int().nonnegative().optional(),
  autoApply: z.boolean().default(false),
  /** BRU-14 stacking flag: may this platform coupon coexist with a vendor coupon? */
  stackWithVendorCoupon: z.boolean().default(true),
}).refine((c) => c.level !== 'VENDOR' || !!c.vendorId, { message: 'vendor coupon needs vendorId' });
export type Coupon = z.infer<typeof CouponSchema>;

export const QtyDealSchema = z.object({
  id: z.string().min(1),
  vendorId: z.string().min(1),
  listingIds: z.array(z.string()).min(1),
  minQty: z.number().int().min(2),                 // FR-VEN-006 buy-2-get-x%
  percentBp: z.number().int().min(1).max(9000),    // discount ≤ 90% (FR-MKT-001)
});
export type QtyDeal = z.infer<typeof QtyDealSchema>;

export const ContextSchema = z.object({
  nowMs: z.number().int(),
  userTier: z.string().optional(),
  isFirstOrder: z.boolean().default(false),
  /** A code the user typed. Explicit intent occupies the platform slot (FR-CUS-011). */
  explicitPlatformCode: z.string().optional(),
  loyaltyPointsPaise: z.number().int().nonnegative().default(0), // 1 pt = ₹1 (FR-CUS-020)
  walletPromo: z
    .object({
      requestedPaise: z.number().int().nonnegative(),
      balancePaise: z.number().int().nonnegative(),
    })
    .optional(),
});
export type Context = z.infer<typeof ContextSchema>;

export const EngineInputSchema = z.object({
  lines: z.array(CartLineSchema).min(1).max(50),
  coupons: z.array(CouponSchema).default([]),
  qtyDeals: z.array(QtyDealSchema).default([]),
  ctx: ContextSchema,
});
export type EngineInput = z.infer<typeof EngineInputSchema>;

// --------------------------------------------------------------- output types

/** Deterministic precedence — FR-MKT-010, normative order. */
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
  amountPaise: Paise;            // Σ allocation — asserted equal
  allocation: Record<string, Paise>; // lineId → paise, keys in cart order
}

export interface Rejection {
  sourceId: string;
  reason: RejectionReason;
}

export interface EvaluationResult {
  itemTotalPaise: Paise;         // Σ qty × unitListPaise (savings baseline)
  waterfall: WaterfallLine[];
  rejected: Rejection[];
  finalPayablePaise: Paise;
  savingsPaise: Paise;
  perLineNetPaise: Record<string, Paise>;
  /** "how you saved ₹412" — FR-MKT-010 explanation payload, edge money format */
  explain: Array<{ source: string; label: string; amount: string }>;
}
