package com.pixous.pixcart.order.domain;

/**
 * Sub-order lifecycle — the fulfilment state machine.
 *
 * Normative source: UML-STM-01 (Vol. 5), captioned "transitions are the only legal moves
 * (FR-VEN-007)". The transition table below is that diagram transcribed edge-for-edge;
 * the state set matches ck_sub_order_state's domain in the live schema (V001).
 *
 * Key rules encoded from the diagram:
 *   Confirmed → Accepted (vendor or 4 h auto) | Cancelled
 *   Accepted  → Packed
 *   Packed    → Shipped (handover scan) | Cancelled (pre-manifest ONLY — no cancel after shipping)
 *   Shipped   → OutForDelivery → Delivered (POD) | NDR
 *   NDR       → OutForDelivery (re-attempt ≤ 3) | RTO_Initiated (exhausted/refused)
 *   Delivered → ReturnRequested (within BRU-07 window) | Closed (window lapse)
 *   Return leg: ReturnRequested → ReturnPickedUp → QC → Refunded | ReturnRejected
 *   Terminals into Closed; Closed is final.
 *
 * NDR re-attempt counting (≤ 3) is carried on the aggregate, not the pure transition
 * function; this class answers only "is this move legal from this state".
 */
public final class SubOrderLifecycle {

    public enum State {
        CONFIRMED, ACCEPTED, PACKED, SHIPPED, OUT_FOR_DELIVERY, DELIVERED,
        NDR, RTO_INITIATED, RTO_RECEIVED,
        RETURN_REQUESTED, RETURN_PICKED_UP, QC, REFUNDED, RETURN_REJECTED,
        CANCELLED, CLOSED
    }

    public enum Event {
        ACCEPT, CANCEL, PACK, SHIP, OUT_FOR_DELIVERY, DELIVER,
        MARK_NDR, REATTEMPT, INITIATE_RTO, RECEIVE_RTO,
        REQUEST_RETURN, PICK_UP_RETURN, START_QC, QC_PASS, QC_FAIL,
        CLOSE
    }

    public sealed interface Result {
        record Moved(State to) implements Result {}
        record Illegal(String reason) implements Result {}
    }

    private SubOrderLifecycle() {
    }

    public static Result apply(State from, Event event) {
        if (from == State.CLOSED) return illegal(from, event); // terminal

        return switch (from) {
            case CONFIRMED -> switch (event) {
                case ACCEPT -> moved(State.ACCEPTED);
                case CANCEL -> moved(State.CANCELLED);
                default -> illegal(from, event);
            };
            case ACCEPTED -> switch (event) {
                case PACK -> moved(State.PACKED);
                case CANCEL -> moved(State.CANCELLED);        // still pre-manifest
                default -> illegal(from, event);
            };
            case PACKED -> switch (event) {
                case SHIP -> moved(State.SHIPPED);
                case CANCEL -> moved(State.CANCELLED);        // pre-manifest only
                default -> illegal(from, event);
            };
            case SHIPPED -> switch (event) {
                case OUT_FOR_DELIVERY -> moved(State.OUT_FOR_DELIVERY);
                default -> illegal(from, event);              // no cancel after handover
            };
            case OUT_FOR_DELIVERY -> switch (event) {
                case DELIVER -> moved(State.DELIVERED);
                case MARK_NDR -> moved(State.NDR);
                default -> illegal(from, event);
            };
            case NDR -> switch (event) {
                case REATTEMPT -> moved(State.OUT_FOR_DELIVERY);
                case INITIATE_RTO -> moved(State.RTO_INITIATED);
                default -> illegal(from, event);
            };
            case RTO_INITIATED -> switch (event) {
                case RECEIVE_RTO -> moved(State.RTO_RECEIVED);
                default -> illegal(from, event);
            };
            case RTO_RECEIVED -> switch (event) {
                case CLOSE -> moved(State.CLOSED);            // restock + fees
                default -> illegal(from, event);
            };
            case DELIVERED -> switch (event) {
                case REQUEST_RETURN -> moved(State.RETURN_REQUESTED); // within BRU-07 window
                case CLOSE -> moved(State.CLOSED);                    // window lapse
                default -> illegal(from, event);
            };
            case RETURN_REQUESTED -> switch (event) {
                case PICK_UP_RETURN -> moved(State.RETURN_PICKED_UP);
                default -> illegal(from, event);
            };
            case RETURN_PICKED_UP -> switch (event) {
                case START_QC -> moved(State.QC);
                default -> illegal(from, event);
            };
            case QC -> switch (event) {
                case QC_PASS -> moved(State.REFUNDED);
                case QC_FAIL -> moved(State.RETURN_REJECTED);
                default -> illegal(from, event);
            };
            case REFUNDED -> switch (event) {
                case CLOSE -> moved(State.CLOSED);
                default -> illegal(from, event);
            };
            case RETURN_REJECTED -> switch (event) {
                case CLOSE -> moved(State.CLOSED);            // dispute path noted
                default -> illegal(from, event);
            };
            case CANCELLED -> switch (event) {
                case CLOSE -> moved(State.CLOSED);
                default -> illegal(from, event);
            };
            case CLOSED -> illegal(from, event);
        };
    }

    /** BRU-07 / diagram: an NDR may re-attempt at most 3 times before RTO is forced. */
    public static final int MAX_NDR_REATTEMPTS = 3;

    private static Result moved(State to) {
        return new Result.Moved(to);
    }

    private static Result illegal(State from, Event e) {
        return new Result.Illegal(e + " is not legal from " + from);
    }
}
