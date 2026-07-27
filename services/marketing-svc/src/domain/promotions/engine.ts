/**
 * FR-MKT-010 Promotions Engine — the single runtime that resolves every
 * price-affecting construct into a deterministic, explainable discount waterfall.
 *
 * Acceptance criteria implemented here and enforced by the test suite:
 *  - identical input ⇒ byte-identical output (100× replay test)
 *  - fixed precedence: ITEM_SALE → QTY_DEAL → VENDOR_COUPON → PLATFORM_COUPON
 *    → LOYALTY → WALLET_PROMO
 *  - exactly one platform coupon (BRU-14); best-for-customer auto-pick,
 *    explicit user code occupies the slot and is never silently swapped
 *  - no negative line prices; Σ(allocation) === amount on every waterfall line
 *  - the stored allocation map reproduces refund claw-back exactly
 *  - evaluation budget ≤ 80 ms p95 for 50-line carts (perf test)
 *
 * The engine is pure: no I/O, no clocks (time arrives in ctx.nowMs), no
 * randomness. Cap/budget racing is the service layer's job (Redis counters,
 * FR-MKT-001); the engine receives remaining caps as facts.
 */
import {
  allocateLargestRemainder,
  Coupon,
  EngineInput,
  EngineInputSchema,
  EvaluationResult,
  fromPaise,
  halfEvenDiv,
  Paise,
  QtyDeal,
  Rejection,
  WaterfallLine,
} from './core.js';

interface LineState {
  lineId: string;
  listingId: string;
  vendorId: string;
  categoryId: string;
  qty: number;
  remaining: Paise; // net-so-far; discounts reduce it, never below zero
}

export function evaluateWaterfall(rawInput: unknown): EvaluationResult {
  const input: EngineInput = EngineInputSchema.parse(rawInput);
  const { ctx } = input;

  const lines: LineState[] = input.lines.map((l) => ({
    lineId: l.lineId,
    listingId: l.listingId,
    vendorId: l.vendorId,
    categoryId: l.categoryId,
    qty: l.qty,
    remaining: l.unitListPaise * l.qty,
  }));
  const lineOrder = lines.map((l) => l.lineId);
  const itemTotal = lines.reduce((a, l) => a + l.remaining, 0);

  const waterfall: WaterfallLine[] = [];
  const rejected: Rejection[] = [];

  const remainingTotal = () => lines.reduce((a, l) => a + l.remaining, 0);

  /** Apply an amount across a subset of lines, weighted by their remaining value. */
  const apply = (
    stage: WaterfallLine['stage'],
    sourceId: string,
    label: string,
    amount: Paise,
    subset: LineState[],
  ) => {
    const weights = subset.map((l) => l.remaining);
    const parts = allocateLargestRemainder(amount, weights);
    const allocation: Record<string, Paise> = {};
    for (const id of lineOrder) {
      const k = subset.findIndex((l) => l.lineId === id);
      if (k >= 0 && parts[k] > 0) allocation[id] = parts[k];
    }
    subset.forEach((l, k) => { l.remaining -= parts[k]; });
    waterfall.push({ stage, sourceId, label, amountPaise: amount, allocation });
  };

  // ---------------------------------------------------------- 1. ITEM_SALE
  // Effective sale prices (FR-VEN-005 schedule resolution happens upstream);
  // the strike-through delta is reported as the first savings stage.
  for (const src of input.lines) {
    if (src.unitSalePaise !== undefined && src.unitSalePaise < src.unitListPaise) {
      const line = lines.find((l) => l.lineId === src.lineId)!;
      const amount = (src.unitListPaise - src.unitSalePaise) * src.qty;
      apply('ITEM_SALE', `SALE:${src.listingId}`, 'Sale price', amount, [line]);
    }
  }

  // ----------------------------------------------------------- 2. QTY_DEAL
  // FR-VEN-006 buy-N-get-x%. Deals evaluate in id order; a line consumed by
  // one deal is excluded from later deals (deterministic, no double-dipping).
  const consumedByDeal = new Set<string>();
  const deals = [...input.qtyDeals].sort((a, b) => a.id.localeCompare(b.id));
  for (const deal of deals) {
    const eligible = lines.filter(
      (l) =>
        l.vendorId === deal.vendorId &&
        deal.listingIds.includes(l.listingId) &&
        !consumedByDeal.has(l.lineId) &&
        l.remaining > 0,
    );
    const totalQty = eligible.reduce((a, l) => a + l.qty, 0);
    if (totalQty < deal.minQty) continue;
    const base = eligible.reduce((a, l) => a + l.remaining, 0);
    const amount = Math.min(halfEvenDiv(base * deal.percentBp, 10_000), base);
    if (amount === 0) continue;
    apply('QTY_DEAL', `DEAL:${deal.id}`, dealLabel(deal), amount, eligible);
    eligible.forEach((l) => consumedByDeal.add(l.lineId));
  }

  // ------------------------------------------------ coupon eligibility core
  type Verdict = { ok: true; base: Paise; scope: LineState[] } | { ok: false; reason: Rejection['reason'] };

  const eligibility = (c: Coupon): Verdict => {
    if (c.startsAtMs !== undefined && ctx.nowMs < c.startsAtMs) return { ok: false, reason: 'NOT_STARTED' };
    if (c.endsAtMs !== undefined && ctx.nowMs > c.endsAtMs) return { ok: false, reason: 'EXPIRED' };
    if (c.firstOrderOnly && !ctx.isFirstOrder) return { ok: false, reason: 'USER_INELIGIBLE' };
    if (c.tiers && (!ctx.userTier || !c.tiers.includes(ctx.userTier))) return { ok: false, reason: 'USER_INELIGIBLE' };
    if (c.perUserRemaining <= 0) return { ok: false, reason: 'PER_USER_CAP' };
    if (c.budgetRemainingPaise !== undefined && c.budgetRemainingPaise <= 0) return { ok: false, reason: 'BUDGET_EXHAUSTED' };

    const scope = lines.filter(
      (l) =>
        (c.level === 'PLATFORM' || l.vendorId === c.vendorId) &&
        (!c.listingIds || c.listingIds.includes(l.listingId)) &&
        (!c.categoryIds || c.categoryIds.includes(l.categoryId)) &&
        l.remaining > 0,
    );
    if (scope.length === 0) return { ok: false, reason: 'SCOPE_MISMATCH' };

    // Min-order: platform coupons measure the whole cart; vendor coupons
    // measure that vendor's current subtotal (FR-MKT-001 / FR-VEN-006).
    const minBase =
      c.level === 'PLATFORM'
        ? remainingTotal()
        : lines.filter((l) => l.vendorId === c.vendorId).reduce((a, l) => a + l.remaining, 0);
    if (minBase < c.minOrderPaise) return { ok: false, reason: 'MIN_ORDER' };

    const base = scope.reduce((a, l) => a + l.remaining, 0);
    return { ok: true, base, scope };
  };

  const discountOf = (c: Coupon, base: Paise): Paise => {
    let d = c.kind === 'PERCENT' ? halfEvenDiv(base * c.value, 10_000) : c.value;
    if (c.kind === 'PERCENT' && c.maxDiscountPaise !== undefined) d = Math.min(d, c.maxDiscountPaise);
    d = Math.min(d, base); // never below zero on any line (clamped to scope value)
    if (c.budgetRemainingPaise !== undefined) d = Math.min(d, c.budgetRemainingPaise);
    return d;
  };

  // -------------------------------------------------------- 3. VENDOR_COUPON
  // At most one per vendor: best-for-customer among that vendor's eligible
  // coupons; ties break on id ascending (determinism).
  const vendorCoupons = input.coupons.filter((c) => c.level === 'VENDOR');
  const byVendor = new Map<string, Coupon[]>();
  for (const c of vendorCoupons) {
    const arr = byVendor.get(c.vendorId!) ?? [];
    arr.push(c);
    byVendor.set(c.vendorId!, arr);
  }
  let vendorCouponApplied = false;
  for (const vendorId of [...byVendor.keys()].sort()) {
    const candidates = byVendor.get(vendorId)!;
    const scored: Array<{ c: Coupon; d: Paise; scope: LineState[] }> = [];
    for (const c of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
      const v = eligibility(c);
      if (!v.ok) { rejected.push({ sourceId: `COUPON:${c.code}`, reason: v.reason }); continue; }
      const d = discountOf(c, v.base);
      if (d === 0) { rejected.push({ sourceId: `COUPON:${c.code}`, reason: 'ZERO_DISCOUNT' }); continue; }
      scored.push({ c, d, scope: v.scope });
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => (b.d - a.d) || a.c.id.localeCompare(b.c.id));
    const win = scored[0];
    apply('VENDOR_COUPON', `COUPON:${win.c.code}`, couponLabel(win.c), win.d, win.scope);
    vendorCouponApplied = true;
    for (const s of scored.slice(1)) rejected.push({ sourceId: `COUPON:${s.c.code}`, reason: 'BETTER_ALTERNATIVE' });
  }

  // ------------------------------------------------------ 4. PLATFORM_COUPON
  // Exactly one (BRU-14). An explicit user code owns the slot: if it fails,
  // the user gets the specific reason — the engine never silently substitutes.
  const platformPool = input.coupons.filter((c) => c.level === 'PLATFORM');
  const tryPlatform = (c: Coupon): { d: Paise; scope: LineState[] } | Rejection['reason'] => {
    if (vendorCouponApplied && c.stackWithVendorCoupon === false) return 'STACKING_BLOCKED';
    const v = eligibility(c);
    if (!v.ok) return v.reason;
    const d = discountOf(c, v.base);
    if (d === 0) return 'ZERO_DISCOUNT';
    return { d, scope: v.scope };
  };

  if (ctx.explicitPlatformCode !== undefined) {
    const c = platformPool.find((x) => x.code === ctx.explicitPlatformCode);
    if (!c) {
      rejected.push({ sourceId: `COUPON:${ctx.explicitPlatformCode}`, reason: 'CODE_UNKNOWN' });
    } else {
      const r = tryPlatform(c);
      if (typeof r === 'string') rejected.push({ sourceId: `COUPON:${c.code}`, reason: r });
      else apply('PLATFORM_COUPON', `COUPON:${c.code}`, couponLabel(c), r.d, r.scope);
    }
  } else {
    const scored: Array<{ c: Coupon; d: Paise; scope: LineState[] }> = [];
    for (const c of [...platformPool].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!c.autoApply) continue;
      const r = tryPlatform(c);
      if (typeof r === 'string') { rejected.push({ sourceId: `COUPON:${c.code}`, reason: r }); continue; }
      scored.push({ c, d: r.d, scope: r.scope });
    }
    if (scored.length > 0) {
      scored.sort((a, b) => (b.d - a.d) || a.c.id.localeCompare(b.c.id));
      const win = scored[0];
      apply('PLATFORM_COUPON', `COUPON:${win.c.code}`, couponLabel(win.c), win.d, win.scope);
      for (const s of scored.slice(1)) rejected.push({ sourceId: `COUPON:${s.c.code}`, reason: 'BETTER_ALTERNATIVE' });
    }
  }

  // -------------------------------------------------------------- 5. LOYALTY
  // FR-CUS-020: 1 point = ₹1 redemption value, capped by what is left to pay.
  if (ctx.loyaltyPointsPaise > 0) {
    const amount = Math.min(ctx.loyaltyPointsPaise, remainingTotal());
    if (amount > 0) apply('LOYALTY', 'LOYALTY:points', 'Loyalty points', amount, lines.filter((l) => l.remaining > 0));
  }

  // --------------------------------------------------------- 6. WALLET_PROMO
  // Promo-bucket tender (FR-CUS-019); earliest-expiry consumption is the
  // wallet ledger's job — the engine only caps and records the tender line.
  if (ctx.walletPromo) {
    const amount = Math.min(ctx.walletPromo.requestedPaise, ctx.walletPromo.balancePaise, remainingTotal());
    if (amount > 0) apply('WALLET_PROMO', 'WALLET:promo', 'Wallet promo credit', amount, lines.filter((l) => l.remaining > 0));
  }

  // ----------------------------------------------------------------- result
  for (const w of waterfall) {
    const sum = Object.values(w.allocation).reduce((a, b) => a + b, 0);
    if (sum !== w.amountPaise) throw new Error(`allocation drift on ${w.sourceId}: ${sum} != ${w.amountPaise}`);
  }
  for (const l of lines) if (l.remaining < 0) throw new Error(`negative line ${l.lineId}`);

  const finalPayable = remainingTotal();
  const perLineNet: Record<string, Paise> = {};
  for (const id of lineOrder) perLineNet[id] = lines.find((l) => l.lineId === id)!.remaining;

  return {
    itemTotalPaise: itemTotal,
    waterfall,
    rejected,
    finalPayablePaise: finalPayable,
    savingsPaise: itemTotal - finalPayable,
    perLineNetPaise: perLineNet,
    explain: waterfall.map((w) => ({ source: w.sourceId, label: w.label, amount: fromPaise(w.amountPaise) })),
  };
}

/**
 * Refund claw-back for one line (FR-CUS-018 / FR-MKT-010): the discount that
 * must reverse when `lineId` refunds in full is exactly the sum of that line's
 * stored allocations — no recomputation, no drift.
 */
export function clawbackForLine(result: EvaluationResult, lineId: string): Paise {
  return result.waterfall.reduce((a, w) => a + (w.allocation[lineId] ?? 0), 0);
}

function couponLabel(c: Coupon): string {
  return c.kind === 'PERCENT'
    ? `Coupon ${c.code} (${c.value / 100}% off)`
    : `Coupon ${c.code} (flat ${fromPaise(c.value)})`;
}
function dealLabel(d: QtyDeal): string {
  return `Buy ${d.minQty}+ save ${d.percentBp / 100}%`;
}
