package com.pixous.pixcart.order.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Order assembly — turns a captured payment + signed quote into a split order.
 *
 * Normative sources:
 *   FR-CUS-014 acceptance:  "When gateway capture succeeds, Then exactly one order is
 *                            created (idempotent on payment reference) matching the quote
 *                            to the paisa."
 *   BRU-03:                 "one customer payment may create multiple vendor sub-orders."
 *   FR-CUS-016:             per-item status timelines across vendor sub-orders.
 *   Vol.6 ord_order/ord_sub_order: uq_order_quote(quote_id, placed_at); every sub-order
 *                            starts CONFIRMED (ck_sub_order_state default).
 *
 * Idempotency is intrinsic and lives at TWO levels — the payment reference (an
 * OrderFactory memoises the order it built for a reference) and the database
 * uq_order_quote key. This class is pure; the factory below models the in-memory guarantee
 * the service layer mirrors with the unique key.
 */
public final class Order {

    /** A priced line as frozen into the quote (net paise already computed upstream). */
    public record QuoteLineRef(String lineId, String vendorId, long netPaise) {}

    public record SubOrder(String subOrderId, String vendorId, List<String> lineIds,
                           long amountPaise, SubOrderLifecycle.State state) {}

    private final String orderId;
    private final String quoteId;
    private final String paymentRef;
    private final long grandTotalPaise;
    private final List<SubOrder> subOrders;
    private final Instant placedAt;

    private Order(String orderId, String quoteId, String paymentRef, long grandTotalPaise,
                  List<SubOrder> subOrders, Instant placedAt) {
        this.orderId = orderId;
        this.quoteId = quoteId;
        this.paymentRef = paymentRef;
        this.grandTotalPaise = grandTotalPaise;
        this.subOrders = List.copyOf(subOrders);
        this.placedAt = placedAt;
    }

    /**
     * Build an order from the quote's priced lines, split per vendor (BRU-03). The sum of
     * sub-order amounts MUST equal the quote grand total to the paisa, or assembly fails —
     * this is the "matching the quote to the paisa" guarantee, checked here rather than
     * trusted.
     */
    public static Order create(String orderId, String quoteId, String paymentRef,
                               long grandTotalPaise, List<QuoteLineRef> lines,
                               java.util.function.Function<String, String> mintSubOrderId,
                               Instant placedAt) {
        if (lines.isEmpty()) throw new IllegalArgumentException("no lines");

        // preserve cart/vendor order (LinkedHashMap) for stable sub-order numbering
        Map<String, List<QuoteLineRef>> byVendor = new LinkedHashMap<>();
        for (QuoteLineRef l : lines) byVendor.computeIfAbsent(l.vendorId(), v -> new ArrayList<>()).add(l);

        List<SubOrder> subs = new ArrayList<>();
        long sum = 0;
        for (var entry : byVendor.entrySet()) {
            long amt = entry.getValue().stream().mapToLong(QuoteLineRef::netPaise).sum();
            sum += amt;
            subs.add(new SubOrder(
                    mintSubOrderId.apply(entry.getKey()),
                    entry.getKey(),
                    entry.getValue().stream().map(QuoteLineRef::lineId).toList(),
                    amt,
                    SubOrderLifecycle.State.CONFIRMED));       // ck_sub_order_state default
        }
        if (sum != grandTotalPaise) {
            throw new IllegalArgumentException(
                    "SPLIT_MISMATCH: sub-orders sum " + sum + " != quote grand total " + grandTotalPaise);
        }
        return new Order(orderId, quoteId, paymentRef, grandTotalPaise, subs, placedAt);
    }

    public String orderId()          { return orderId; }
    public String quoteId()          { return quoteId; }
    public String paymentRef()       { return paymentRef; }
    public long grandTotalPaise()    { return grandTotalPaise; }
    public List<SubOrder> subOrders(){ return subOrders; }
    public Instant placedAt()        { return placedAt; }

    /**
     * In-memory idempotency guarantee (FR-CUS-014): the same payment reference always
     * yields the same order object and never creates a second. The service layer mirrors
     * this with the ord_order unique key so it holds across instances too.
     */
    public static final class OrderFactory {
        private final Map<String, Order> byPaymentRef = new java.util.concurrent.ConcurrentHashMap<>();

        public sealed interface Outcome {
            record Created(Order order) implements Outcome {}
            record Existing(Order order) implements Outcome {}
        }

        public Outcome createOnce(String orderId, String quoteId, String paymentRef,
                                  long grandTotalPaise, List<QuoteLineRef> lines,
                                  java.util.function.Function<String, String> mintSubOrderId,
                                  Instant placedAt) {
            Order existing = byPaymentRef.get(paymentRef);
            if (existing != null) return new Outcome.Existing(existing);
            Order created = create(orderId, quoteId, paymentRef, grandTotalPaise, lines, mintSubOrderId, placedAt);
            Order prior = byPaymentRef.putIfAbsent(paymentRef, created);
            return prior != null ? new Outcome.Existing(prior) : new Outcome.Created(created);
        }
    }
}
