/**
 * FR-CUS-014 Checkout — server-authoritative quote engine.
 *
 * Governing specification (Documentation Suite v1.0):
 *   FR-CUS-014 outputs:     "Order quote id (10-min validity), price/tax breakdown per line"
 *   FR-CUS-014 validation:  "Every line re-validated (price, stock, serviceability, offer
 *                            eligibility) at quote creation and again at payment capture"
 *   FR-CUS-014 rules:       BRU-05 COD gate; BRU-14 one platform coupon; quote expiry
 *   FR-CUS-014 acceptance:  "exactly one order ... matching the quote to the paisa"
 *   BRU-03:                 "one customer payment may create multiple vendor sub-orders"
 *   BRU-05:                 "COD ... order value ≤ ₹10,000, serviceable PIN, fraud-score below threshold"
 *   FR-CUS-007:             qty 1–10 per line, category caps; server re-quote on every mutation
 *
 * This module is pure. It composes the FR-MKT-010 promotions engine (already delivered)
 * for discounting, then splits the priced cart per vendor (BRU-03) and produces an
 * immutable quote. The server signature and 10-minute clock are represented as data;
 * cryptographic signing and persistence are adapter concerns (Vol. 10 §10.3/§10.6).
 * Tax here is a strategy input (FR-FIN-002 owns the real GST rules).
 */
import { z } from 'zod';
import { CouponSchema, EngineInput, fromPaise, Paise } from '../promotions/core.js';
import { evaluateWaterfall } from '../promotions/engine.js';

export const QUOTE_VALIDITY_MS = 10 * 60 * 1000;         // FR-CUS-014: 10-min validity
export const COD_MAX_PAISE = 10_000 * 100;               // BRU-05: order value ≤ ₹10,000

export const CheckoutLineSchema = z.object({
  lineId: z.string().min(1),
  listingId: z.string().min(1),
  vendorId: z.string().min(1),
  categoryId: z.string().min(1),
  qty: z.number().int().min(1).max(10),                  // FR-CUS-007 per-line cap
  unitListPaise: z.number().int().nonnegative(),
  unitSalePaise: z.number().int().nonnegative().optional(),
  // server-side facts captured at quote time (FR-CUS-014 validation)
  availableStock: z.number().int().nonnegative(),
  serviceablePin: z.boolean(),
  categoryQtyCap: z.number().int().positive().optional(),
  taxBps: z.number().int().nonnegative().default(0),     // GST rate for this line (FR-FIN-002)
});
export type CheckoutLine = z.infer<typeof CheckoutLineSchema>;

export const CheckoutRequestSchema = z.object({
  cartId: z.string().min(1),
  customerId: z.string().min(1),
  addressPin: z.string().regex(/^\d{6}$/),
  lines: z.array(CheckoutLineSchema).min(1).max(50),
  coupons: z.array(CouponSchema).default([]),            // reuse promotions coupon schema
  requestedPaymentMethod: z.enum(['PREPAID', 'COD']),
  fraudScore: z.number().min(0).max(1),                  // BRU-05 threshold input
  codFraudThreshold: z.number().min(0).max(1).default(0.7),
  nowMs: z.number().int(),
});

/** A single line failing revalidation (FR-CUS-014: per-line resolution UI). */
export type LineProblem =
  | { lineId: string; reason: 'OUT_OF_STOCK'; available: number }
  | { lineId: string; reason: 'QTY_OVER_CATEGORY_CAP'; cap: number }
  | { lineId: string; reason: 'PIN_NOT_SERVICEABLE' };

export interface QuoteLine {
  lineId: string;
  vendorId: string;
  grossPaise: Paise;       // qty × list
  discountPaise: Paise;    // Σ this line's promotion allocations
  taxPaise: Paise;         // tax on the discounted net (FR-FIN-002)
  netPaise: Paise;         // gross − discount + tax  (what the customer pays for the line)
}

export interface VendorSubOrder {
  vendorId: string;
  lineIds: string[];
  itemPaise: Paise;        // Σ (gross − discount) for the vendor
  taxPaise: Paise;
  grandPaise: Paise;
}

export interface Quote {
  quoteId: string;
  cartId: string;
  customerId: string;
  createdAtMs: number;
  expiresAtMs: number;     // createdAt + 10 min
  lines: QuoteLine[];
  subOrders: VendorSubOrder[];   // BRU-03 split
  itemTotalPaise: Paise;   // Σ gross
  discountTotalPaise: Paise;
  taxTotalPaise: Paise;
  grandTotalPaise: Paise;  // Σ net — the figure a payment must match to the paisa
  paymentMethod: 'PREPAID' | 'COD';
  codEligible: boolean;
  codReasons: string[];    // why COD was refused, if it was
  signaturePayload: string; // canonical string the adapter signs (anti-tamper)
}

export type QuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; problems: LineProblem[] };

/**
 * Create an immutable order quote. Revalidation first (FR-CUS-014): if any line fails,
 * no quote is produced and every failing line is reported for the resolution UI.
 */
export function createQuote(raw: unknown, mintQuoteId: (seed: string) => string): QuoteResult {
  const req = CheckoutRequestSchema.parse(raw) as unknown as {
    cartId: string; customerId: string; addressPin: string; lines: CheckoutLine[];
    coupons: EngineInput['coupons']; requestedPaymentMethod: 'PREPAID' | 'COD';
    fraudScore: number; codFraudThreshold: number; nowMs: number;
  };

  // ---- 1. revalidate every line (stock, category cap, serviceability) ----
  const problems: LineProblem[] = [];
  for (const l of req.lines) {
    if (l.qty > l.availableStock) problems.push({ lineId: l.lineId, reason: 'OUT_OF_STOCK', available: l.availableStock });
    if (l.categoryQtyCap !== undefined && l.qty > l.categoryQtyCap) {
      problems.push({ lineId: l.lineId, reason: 'QTY_OVER_CATEGORY_CAP', cap: l.categoryQtyCap });
    }
    if (!l.serviceablePin) problems.push({ lineId: l.lineId, reason: 'PIN_NOT_SERVICEABLE' });
  }
  if (problems.length > 0) return { ok: false, problems };

  // ---- 2. price via the FR-MKT-010 promotions engine ----
  const promoInput: EngineInput = {
    lines: req.lines.map((l) => ({
      lineId: l.lineId, listingId: l.listingId, vendorId: l.vendorId,
      categoryId: l.categoryId, qty: l.qty, unitListPaise: l.unitListPaise,
      unitSalePaise: l.unitSalePaise,
    })),
    coupons: req.coupons ?? [],
    qtyDeals: [],
    ctx: { nowMs: req.nowMs, isFirstOrder: false, loyaltyPointsPaise: 0 },
  };
  const promo = evaluateWaterfall(promoInput);

  // ---- 3. per-line gross/discount/tax; tax applies to the discounted net (FR-FIN-002) ----
  const lines: QuoteLine[] = req.lines.map((l) => {
    const gross = l.unitListPaise * l.qty;
    const discount = promo.waterfall.reduce((a, w) => a + (w.allocation[l.lineId] ?? 0), 0);
    const taxable = gross - discount;
    const tax = Math.round((taxable * l.taxBps) / 10_000); // half-up at line; totals reconciled below
    return { lineId: l.lineId, vendorId: l.vendorId, grossPaise: gross, discountPaise: discount, taxPaise: tax, netPaise: taxable + tax };
  });

  // ---- 4. BRU-03 split into vendor sub-orders, preserving cart order ----
  const vendorOrder: string[] = [];
  const byVendor = new Map<string, QuoteLine[]>();
  for (const ql of lines) {
    if (!byVendor.has(ql.vendorId)) { byVendor.set(ql.vendorId, []); vendorOrder.push(ql.vendorId); }
    byVendor.get(ql.vendorId)!.push(ql);
  }
  const subOrders: VendorSubOrder[] = vendorOrder.map((vendorId) => {
    const vls = byVendor.get(vendorId)!;
    const item = vls.reduce((a, x) => a + (x.grossPaise - x.discountPaise), 0);
    const tax = vls.reduce((a, x) => a + x.taxPaise, 0);
    return { vendorId, lineIds: vls.map((x) => x.lineId), itemPaise: item, taxPaise: tax, grandPaise: item + tax };
  });

  // ---- 5. totals; grand is Σ net so the sub-orders reconcile to the paisa ----
  const itemTotal = lines.reduce((a, x) => a + x.grossPaise, 0);
  const discountTotal = lines.reduce((a, x) => a + x.discountPaise, 0);
  const taxTotal = lines.reduce((a, x) => a + x.taxPaise, 0);
  const grandTotal = lines.reduce((a, x) => a + x.netPaise, 0);

  // ---- 6. BRU-05 COD gate ----
  const codReasons: string[] = [];
  if (grandTotal > COD_MAX_PAISE) codReasons.push(`ORDER_VALUE_OVER_10000 (${fromPaise(grandTotal)})`);
  if (!req.lines.every((l) => l.serviceablePin)) codReasons.push('PIN_NOT_SERVICEABLE');
  if (req.fraudScore >= req.codFraudThreshold) codReasons.push('FRAUD_SCORE_ABOVE_THRESHOLD');
  const codEligible = codReasons.length === 0;

  let paymentMethod = req.requestedPaymentMethod;
  if (paymentMethod === 'COD' && !codEligible) paymentMethod = 'PREPAID'; // gate forces prepaid

  const createdAtMs = req.nowMs;
  const expiresAtMs = createdAtMs + QUOTE_VALIDITY_MS;
  const seed = `${req.cartId}|${req.customerId}|${createdAtMs}|${grandTotal}`;
  const quoteId = mintQuoteId(seed);

  // canonical anti-tamper payload the adapter signs (FR-CUS-014 "quote server-signed")
  const signaturePayload = JSON.stringify({
    quoteId, cartId: req.cartId, customerId: req.customerId, grandTotalPaise: grandTotal,
    expiresAtMs, lines: lines.map((l) => [l.lineId, l.netPaise]),
  });

  return {
    ok: true,
    quote: {
      quoteId, cartId: req.cartId, customerId: req.customerId, createdAtMs, expiresAtMs,
      lines, subOrders, itemTotalPaise: itemTotal, discountTotalPaise: discountTotal,
      taxTotalPaise: taxTotal, grandTotalPaise: grandTotal, paymentMethod,
      codEligible, codReasons, signaturePayload,
    },
  };
}

export function isExpired(quote: Quote, nowMs: number): boolean {
  return nowMs > quote.expiresAtMs;
}

/**
 * Capture-time guard (FR-CUS-014 acceptance): a payment is only allowed to create an
 * order if the quote is unexpired and the captured amount matches grand total to the
 * paisa. Idempotency on the payment reference is the order service's job.
 */
export function canCapture(quote: Quote, capturedPaise: Paise, nowMs: number):
  { ok: true } | { ok: false; reason: 'QUOTE_EXPIRED' | 'AMOUNT_MISMATCH' } {
  if (isExpired(quote, nowMs)) return { ok: false, reason: 'QUOTE_EXPIRED' };
  if (capturedPaise !== quote.grandTotalPaise) return { ok: false, reason: 'AMOUNT_MISMATCH' };
  return { ok: true };
}

/** Exposed for tests/analytics: verify a quote's internal arithmetic is self-consistent. */
export function reconcile(quote: Quote): boolean {
  const subSum = quote.subOrders.reduce((a, s) => a + s.grandPaise, 0);
  const lineSum = quote.lines.reduce((a, l) => a + l.netPaise, 0);
  return subSum === quote.grandTotalPaise && lineSum === quote.grandTotalPaise;
}

/** Deterministic quote-id for tests (adapters supply a ULID minter in production). */
export function hashQuoteId(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 'Q' + (h >>> 0).toString(16).padStart(8, '0').toUpperCase();
}
