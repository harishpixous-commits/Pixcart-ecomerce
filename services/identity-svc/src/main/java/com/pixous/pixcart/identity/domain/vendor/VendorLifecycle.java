package com.pixous.pixcart.identity.domain.vendor;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Vendor approval & lifecycle — FR-ADM-003.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "queue vendor applications with KYC evidence and AI risk pre-score, support
 *                approve/reject/request-info decisions with templates, and manage lifecycle
 *                states (Active, Restricted, Suspended, Off-boarded) with financial-safe
 *                off-boarding."
 *   RULES:      "Suspension freezes listings + payouts (holds per BRU-09) but preserves order
 *                servicing duties; re-application cooldown 30 days after fraud-reject."
 *   ACCEPTANCE: "Given a fraud-flagged application, When A approves, Then state stays
 *                Pending-Second-Approval until SA confirms, and both actions appear in audit."
 *   VALIDATION: "Approve requires all KYC checks green or documented override (SA only);
 *                reject reason mandatory & templated."
 *
 * Two invariants carry the weight here:
 *   - A fraud-flagged application cannot be activated by one person. An ordinary admin's
 *     approval moves it to PENDING_SECOND_APPROVAL and no further; only a Super Admin's
 *     confirmation activates it, and both actions are recorded.
 *   - Off-boarding is financial-safe: a vendor with outstanding obligations or unserviced
 *     orders cannot be off-boarded, and suspension explicitly PRESERVES the duty to service
 *     orders already placed while freezing listings and payouts.
 */
public final class VendorLifecycle {

    public static final Duration FRAUD_REJECT_COOLDOWN = Duration.ofDays(30);

    public enum State { PENDING, PENDING_SECOND_APPROVAL, ACTIVE, RESTRICTED, SUSPENDED, OFF_BOARDED, REJECTED }

    /** Templated rejection reasons (VALIDATION: "reason mandatory & templated"). */
    public enum RejectTemplate {
        KYC_DOCUMENTS_ILLEGIBLE, GSTIN_MISMATCH, BANK_VERIFICATION_FAILED,
        PROHIBITED_CATEGORY_INTENT, FRAUD_SIGNALS, DUPLICATE_APPLICATION
    }

    public record Action(Instant at, String actorId, String action, String detail) {}

    public sealed interface Outcome {
        record Ok(State state) implements Outcome {}
        record Rejected(String reason) implements Outcome {}
    }

    private final String vendorId;
    private State state = State.PENDING;
    private final List<Action> actions = new ArrayList<>();
    private String firstApproverId;
    private Instant reapplyAllowedFrom;
    private boolean listingsFrozen;
    private boolean payoutsFrozen;
    private boolean orderServicingRequired = true;   // always true while orders are open

    public VendorLifecycle(String vendorId) {
        if (vendorId == null || vendorId.isBlank()) throw new IllegalArgumentException("vendorId");
        this.vendorId = vendorId;
    }

    /**
     * Approve an application.
     *
     * @param kycAllGreen   every KYC check passed (from {@link VendorKycApplication})
     * @param overrideRef   documented override reference when KYC is not all green — Super
     *                      Admin only (VALIDATION)
     * @param fraudFlagged  the AI risk pre-score flagged this application
     */
    public Outcome approve(String actorId, boolean isSuperAdmin, boolean kycAllGreen,
                           String overrideRef, boolean fraudFlagged, Instant now) {
        if (state != State.PENDING) return new Outcome.Rejected("NOT_PENDING: " + state);
        if (actorId == null || actorId.isBlank()) return new Outcome.Rejected("ACTOR_REQUIRED");

        if (!kycAllGreen) {
            if (overrideRef == null || overrideRef.isBlank()) {
                return new Outcome.Rejected("KYC_NOT_GREEN_AND_NO_OVERRIDE");
            }
            if (!isSuperAdmin) {
                return new Outcome.Rejected("KYC_OVERRIDE_REQUIRES_SUPER_ADMIN");
            }
        }

        if (fraudFlagged && !isSuperAdmin) {
            // ACCEPTANCE: an ordinary admin's approval of a fraud-flagged application stops here
            state = State.PENDING_SECOND_APPROVAL;
            firstApproverId = actorId;
            actions.add(new Action(now, actorId, "APPROVE_FIRST",
                    "fraud-flagged; awaiting super-admin confirmation"
                            + (overrideRef != null ? " override=" + overrideRef : "")));
            return new Outcome.Ok(state);
        }

        state = State.ACTIVE;
        actions.add(new Action(now, actorId, "APPROVE",
                (fraudFlagged ? "fraud-flagged, approved by super admin" : "clean")
                        + (overrideRef != null ? " override=" + overrideRef : "")));
        return new Outcome.Ok(state);
    }

    /** Super-Admin confirmation of a fraud-flagged application. Maker must differ from checker. */
    public Outcome confirmSecondApproval(String superAdminId, Instant now) {
        if (state != State.PENDING_SECOND_APPROVAL) return new Outcome.Rejected("NOT_AWAITING_SECOND_APPROVAL: " + state);
        if (superAdminId == null || superAdminId.isBlank()) return new Outcome.Rejected("ACTOR_REQUIRED");
        if (superAdminId.equals(firstApproverId)) return new Outcome.Rejected("SOD_VIOLATION_SAME_APPROVER");
        state = State.ACTIVE;
        actions.add(new Action(now, superAdminId, "APPROVE_SECOND", "confirmed first approval by " + firstApproverId));
        return new Outcome.Ok(state);
    }

    /** Reject with a mandatory templated reason. A fraud rejection starts the cooldown. */
    public Outcome reject(String actorId, RejectTemplate template, String note, Instant now) {
        if (state != State.PENDING && state != State.PENDING_SECOND_APPROVAL) {
            return new Outcome.Rejected("NOT_PENDING: " + state);
        }
        if (template == null) return new Outcome.Rejected("REJECT_TEMPLATE_REQUIRED");
        state = State.REJECTED;
        if (template == RejectTemplate.FRAUD_SIGNALS) {
            reapplyAllowedFrom = now.plus(FRAUD_REJECT_COOLDOWN);
        }
        actions.add(new Action(now, actorId, "REJECT", template.name() + (note != null ? ": " + note : "")));
        return new Outcome.Ok(state);
    }

    /** RULES: 30-day cooldown after a fraud rejection before re-application. */
    public boolean mayReapply(Instant now) {
        if (state != State.REJECTED) return false;
        return reapplyAllowedFrom == null || !now.isBefore(reapplyAllowedFrom);
    }

    public Outcome requestInfo(String actorId, String what, Instant now) {
        if (state != State.PENDING) return new Outcome.Rejected("NOT_PENDING: " + state);
        if (what == null || what.isBlank()) return new Outcome.Rejected("INFO_REQUEST_DETAIL_REQUIRED");
        actions.add(new Action(now, actorId, "REQUEST_INFO", what));
        return new Outcome.Ok(state);
    }

    /**
     * Suspend: freezes listings and payouts (BRU-09 holds) but the vendor still owes service
     * on orders already placed — that duty is explicitly preserved, not cancelled.
     */
    public Outcome suspend(String actorId, String reason, Instant now) {
        if (state != State.ACTIVE && state != State.RESTRICTED) return new Outcome.Rejected("NOT_SUSPENDABLE: " + state);
        if (reason == null || reason.isBlank()) return new Outcome.Rejected("SUSPENSION_REASON_REQUIRED");
        state = State.SUSPENDED;
        listingsFrozen = true;
        payoutsFrozen = true;
        orderServicingRequired = true;
        actions.add(new Action(now, actorId, "SUSPEND", reason));
        return new Outcome.Ok(state);
    }

    /** Restrict: a lighter measure — listings frozen, payouts continue. */
    public Outcome restrict(String actorId, String reason, Instant now) {
        if (state != State.ACTIVE) return new Outcome.Rejected("NOT_RESTRICTABLE: " + state);
        if (reason == null || reason.isBlank()) return new Outcome.Rejected("RESTRICTION_REASON_REQUIRED");
        state = State.RESTRICTED;
        listingsFrozen = true;
        payoutsFrozen = false;
        actions.add(new Action(now, actorId, "RESTRICT", reason));
        return new Outcome.Ok(state);
    }

    public Outcome reinstate(String actorId, Instant now) {
        if (state != State.SUSPENDED && state != State.RESTRICTED) return new Outcome.Rejected("NOT_REINSTATABLE: " + state);
        state = State.ACTIVE;
        listingsFrozen = false;
        payoutsFrozen = false;
        actions.add(new Action(now, actorId, "REINSTATE", ""));
        return new Outcome.Ok(state);
    }

    /**
     * Financial-safe off-boarding: refused while the vendor owes money to the platform, is
     * owed money by it, or still has orders to service. Off-boarding must not orphan an
     * obligation in either direction.
     */
    public Outcome offBoard(String actorId, long outstandingPayablePaise, long outstandingRecoveryPaise,
                            int openOrders, Instant now) {
        if (state == State.OFF_BOARDED) return new Outcome.Rejected("ALREADY_OFF_BOARDED");
        if (state == State.PENDING || state == State.PENDING_SECOND_APPROVAL || state == State.REJECTED) {
            return new Outcome.Rejected("NOT_ONBOARDED: " + state);
        }
        var blockers = new ArrayList<String>();
        if (openOrders > 0) blockers.add("OPEN_ORDERS=" + openOrders);
        if (outstandingPayablePaise != 0) blockers.add("UNSETTLED_PAYABLE=" + outstandingPayablePaise);
        if (outstandingRecoveryPaise != 0) blockers.add("UNRECOVERED_BALANCE=" + outstandingRecoveryPaise);
        if (!blockers.isEmpty()) {
            return new Outcome.Rejected("OFF_BOARDING_NOT_FINANCIALLY_SAFE: " + String.join(",", blockers));
        }
        state = State.OFF_BOARDED;
        listingsFrozen = true;
        payoutsFrozen = true;
        orderServicingRequired = false;   // nothing left to service
        actions.add(new Action(now, actorId, "OFF_BOARD", "financially clear"));
        return new Outcome.Ok(state);
    }

    public String vendorId()                { return vendorId; }
    public State state()                    { return state; }
    public boolean listingsFrozen()         { return listingsFrozen; }
    public boolean payoutsFrozen()          { return payoutsFrozen; }
    public boolean orderServicingRequired() { return orderServicingRequired; }
    public Instant reapplyAllowedFrom()     { return reapplyAllowedFrom; }
    public List<Action> auditTrail()        { return List.copyOf(actions); }
}
