package com.pixous.pixcart.inventory.domain;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Inventory item aggregate — sellable stock per variant per fulfilment location.
 *
 * Normative source: FR-VEN-004 (Inventory Management):
 *   "track sellable stock per variant per fulfilment location with reservations at order
 *    confirm, decrement on manifest, restock on cancel/RTO/QC-pass, low-stock alerts and
 *    bulk CSV/API updates."
 *   Vol.6 inv_item: on_hand, reserved, safety_stock, row_version;
 *     ck_inv_nonneg CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand).
 *   Vol.5 §5.5 events: inventory.reserved / committed / released .v1.
 *
 * The correctness property this aggregate exists to guarantee is NO OVERSELLING:
 * available-to-promise (ATP) = on_hand − reserved − safety_stock, and a reservation may
 * never drive reserved past on_hand (mirrors ck_inv_nonneg). Reservations are keyed by a
 * holdRef (cart/quote id + sku) so retries are idempotent; each hold records its quantity,
 * so releasing or committing is exact. Optimistic concurrency is via row_version — the
 * repository writes with a version guard, so two racing reservations cannot both win
 * (the DB proof exercises this).
 *
 * Lifecycle:
 *   reserve(holdRef, qty)  ATP check → reserved += qty            (order confirm)
 *   commit(holdRef)        on_hand -= qty; reserved -= qty        (manifest/handover)
 *   release(holdRef)       reserved -= qty                        (cancel / RTO / QC-pass restock elsewhere)
 *   restock(qty)           on_hand += qty                         (GRN inbound, RTO receive)
 */
public final class InventoryItem {

    public sealed interface Result {
        record Ok(int atp) implements Result {}
        record Idempotent(int atp, String note) implements Result {}
        record Rejected(String reason) implements Result {}
    }

    private final String variantSku;
    private final String locationId;
    private int onHand;
    private int reserved;
    private final int safetyStock;
    private int rowVersion;

    /** Active holds: holdRef → quantity reserved under it. */
    private final Map<String, Integer> holds = new LinkedHashMap<>();

    public InventoryItem(String variantSku, String locationId, int onHand, int reserved, int safetyStock) {
        if (variantSku == null || variantSku.isBlank()) throw new IllegalArgumentException("variantSku");
        if (locationId == null || locationId.isBlank()) throw new IllegalArgumentException("locationId");
        if (onHand < 0 || reserved < 0 || safetyStock < 0) throw new IllegalArgumentException("negative stock");
        if (reserved > onHand) throw new IllegalArgumentException("reserved > onHand violates ck_inv_nonneg");
        this.variantSku = variantSku;
        this.locationId = locationId;
        this.onHand = onHand;
        this.reserved = reserved;
        this.safetyStock = safetyStock;
    }

    /** Available to promise: what a new order may take, protecting safety stock. */
    public int availableToPromise() {
        return onHand - reserved - safetyStock;
    }

    /**
     * Reserve qty under a hold reference (FR-VEN-004: reservations at order confirm).
     * Idempotent on holdRef: the same ref replayed returns the existing reservation and
     * changes nothing. Refused if ATP cannot cover qty — this is the anti-oversell gate.
     */
    public Result reserve(String holdRef, int qty) {
        if (holdRef == null || holdRef.isBlank()) return new Result.Rejected("holdRef required");
        if (qty <= 0) return new Result.Rejected("qty must be positive");
        Integer existing = holds.get(holdRef);
        if (existing != null) {
            return existing == qty
                    ? new Result.Idempotent(availableToPromise(), "hold already applied")
                    : new Result.Rejected("HOLD_REF_REUSED with a different qty");
        }
        if (qty > availableToPromise()) {
            return new Result.Rejected("INSUFFICIENT_ATP: need " + qty + ", atp " + availableToPromise());
        }
        reserved += qty;
        holds.put(holdRef, qty);
        rowVersion++;
        return new Result.Ok(availableToPromise());
    }

    /**
     * Commit a hold (FR-VEN-004: decrement on manifest). on_hand and reserved both fall by
     * the held qty — the goods have left. Idempotent: committing an unknown/spent hold is a
     * no-op rejection the caller can treat as already-done.
     */
    public Result commit(String holdRef) {
        Integer qty = holds.remove(holdRef);
        if (qty == null) return new Result.Rejected("UNKNOWN_OR_SPENT_HOLD: " + holdRef);
        onHand -= qty;
        reserved -= qty;
        rowVersion++;
        return new Result.Ok(availableToPromise());
    }

    /**
     * Release a hold without shipping (FR-VEN-004: restock on cancel/RTO/QC-pass). reserved
     * falls by the held qty; on_hand is untouched (the stock was never shipped).
     */
    public Result release(String holdRef) {
        Integer qty = holds.remove(holdRef);
        if (qty == null) return new Result.Rejected("UNKNOWN_OR_SPENT_HOLD: " + holdRef);
        reserved -= qty;
        rowVersion++;
        return new Result.Ok(availableToPromise());
    }

    /** Add physical stock (GRN inbound / RTO receive). */
    public Result restock(int qty) {
        if (qty <= 0) return new Result.Rejected("qty must be positive");
        onHand += qty;
        rowVersion++;
        return new Result.Ok(availableToPromise());
    }

    /** FR-VEN-004 low-stock alert predicate. */
    public boolean isLowStock(int threshold) {
        return availableToPromise() <= threshold;
    }

    /** The schema invariant, checkable in tests: mirrors ck_inv_nonneg. */
    public boolean invariantHolds() {
        return onHand >= 0 && reserved >= 0 && reserved <= onHand;
    }

    public String variantSku()  { return variantSku; }
    public String locationId()  { return locationId; }
    public int onHand()         { return onHand; }
    public int reserved()       { return reserved; }
    public int safetyStock()    { return safetyStock; }
    public int rowVersion()     { return rowVersion; }
    public boolean hasHold(String holdRef) { return holds.containsKey(holdRef); }
}
