package com.pixous.pixcart.catalogue.domain.listing;

import java.util.List;

/**
 * Listing lifecycle — the only legal moves.
 *
 * Normative sources (Documentation Suite v1.0):
 *   FR-VEN-003 outputs:    "Listing in state machine Draft→Submitted→Approved/Rejected→Live/Paused"
 *   FR-VEN-003 rules:      "regulated-field edits (title, category, brand, images, MRP)
 *                           re-enter approval; other edits hot-apply"  (= BRU-02)
 *   FR-VEN-003 acceptance: "When A approves, Then it goes Live within 2 min" — APPROVED is a
 *                           transient state; publication to LIVE is a SYSTEM action.
 *                          "Given MRP edited on a Live listing, Then state returns to Submitted
 *                           and public price stays unchanged until re-approval."
 *   ck_listing_state (V001): DRAFT, SUBMITTED, APPROVED, REJECTED, LIVE, PAUSED, ARCHIVED.
 *
 * Derived arrows, marked so review can challenge them: Archive is a vendor action allowed
 * from every non-terminal state (delisting); RegulatedEdit from PAUSED and APPROVED behaves
 * as from LIVE (BRU-02 gives the rule by field, not by state). ARCHIVED is terminal.
 *
 * Vendor-owns-listing scoping (Vol. 2 §2.4 "S") and the LIVE snapshot continuing to serve
 * during re-approval are service-layer responsibilities; the domain fixes the state algebra.
 */
public final class ListingLifecycle {

    public enum State { DRAFT, SUBMITTED, APPROVED, REJECTED, LIVE, PAUSED, ARCHIVED }

    public enum Actor { VENDOR, ADMIN, SYSTEM }

    /** Events carry their required actor; construction enforces event-level invariants. */
    public sealed interface Event {
        Actor actor();

        /** Vendor submits a complete draft (field validation happens in the application layer). */
        record Submit() implements Event {
            @Override public Actor actor() { return Actor.VENDOR; }
        }

        /** FR-ADM-004 approval decision. */
        record Approve(String adminId) implements Event {
            public Approve { requireId(adminId, "adminId"); }
            @Override public Actor actor() { return Actor.ADMIN; }
        }

        /** FR-ADM-004: rejection must carry a fix-list for the vendor. */
        record Reject(String adminId, List<String> fixList) implements Event {
            public Reject {
                requireId(adminId, "adminId");
                if (fixList == null || fixList.isEmpty()) {
                    throw new IllegalArgumentException("rejection requires a fix-list (FR-ADM-004)");
                }
                fixList = List.copyOf(fixList);
            }
            @Override public Actor actor() { return Actor.ADMIN; }
        }

        /** SYSTEM publication after approval ("goes Live within 2 min"). */
        record Publish() implements Event {
            @Override public Actor actor() { return Actor.SYSTEM; }
        }

        record Pause() implements Event {
            @Override public Actor actor() { return Actor.VENDOR; }
        }

        record Resume() implements Event {
            @Override public Actor actor() { return Actor.VENDOR; }
        }

        /** BRU-02: an edit touching title/category/brand/images/MRP re-enters approval. */
        record RegulatedEdit() implements Event {
            @Override public Actor actor() { return Actor.VENDOR; }
        }

        /** Vendor picks up a rejection's fix-list and returns the listing to draft. */
        record Revise() implements Event {
            @Override public Actor actor() { return Actor.VENDOR; }
        }

        /** Vendor delists permanently. Derived arrow — allowed from any non-terminal state. */
        record Archive() implements Event {
            @Override public Actor actor() { return Actor.VENDOR; }
        }
    }

    public sealed interface Result {
        record Moved(State to) implements Result {}
        record Illegal(String reason) implements Result {}
    }

    private ListingLifecycle() {
    }

    public static Result apply(State from, Event event) {
        if (from == State.ARCHIVED) return illegal(from, event); // terminal

        return switch (event) {
            case Event.Submit e        -> from == State.DRAFT
                    ? moved(State.SUBMITTED) : illegal(from, e);
            case Event.Approve e       -> from == State.SUBMITTED
                    ? moved(State.APPROVED) : illegal(from, e);
            case Event.Reject e        -> from == State.SUBMITTED
                    ? moved(State.REJECTED) : illegal(from, e);
            case Event.Publish e       -> from == State.APPROVED
                    ? moved(State.LIVE) : illegal(from, e);
            case Event.Pause e         -> from == State.LIVE
                    ? moved(State.PAUSED) : illegal(from, e);
            case Event.Resume e        -> from == State.PAUSED
                    ? moved(State.LIVE) : illegal(from, e);
            case Event.RegulatedEdit e -> (from == State.LIVE || from == State.PAUSED || from == State.APPROVED)
                    ? moved(State.SUBMITTED) : illegal(from, e);
            case Event.Revise e        -> from == State.REJECTED
                    ? moved(State.DRAFT) : illegal(from, e);
            case Event.Archive e       -> moved(State.ARCHIVED); // any non-terminal state
        };
    }

    private static Result moved(State to) {
        return new Result.Moved(to);
    }

    private static Result illegal(State from, Event e) {
        return new Result.Illegal(e.getClass().getSimpleName() + " is not legal from " + from);
    }

    private static void requireId(String v, String name) {
        if (v == null || v.isBlank()) throw new IllegalArgumentException(name);
    }
}
