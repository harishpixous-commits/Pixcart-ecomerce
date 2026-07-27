package com.pixous.pixcart.catalogue.domain.approval;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * FR-ADM-004 — Product Approval & Catalogue QC.
 *
 * Invariants implemented straight from the specification:
 *   inputs:     "bulk selection (≤ 100 with ≥ 10% manual-view sampling)"
 *   validation: "Prohibited detection ≥ threshold blocks bulk-approve for that item;
 *                diff view mandatory before approving regulated-field edits"
 *   acceptance: "Given a listing flagged 'prohibited: weapon-like', When A attempts bulk
 *                approve including it, Then that item is excluded with reason and requires
 *                individual adjudication."
 *   outputs:    fix-lists to vendors on rejection (enforced by ListingLifecycle.Event.Reject
 *               and mirrored here for the case record).
 *
 * The auto-approve lane for trusted vendors (5% audit sampling) is a service-layer policy
 * over these primitives; decisions additionally append to adm_audit_event (Vol. 6 DDL-04).
 */
public final class ApprovalCase {

    public enum State { PENDING, APPROVED, REJECTED }

    public sealed interface DecisionResult {
        record Decided(State state) implements DecisionResult {}
        record Refused(String reason) implements DecisionResult {}
    }

    private final String caseId;
    private final String listingId;
    private final int revisionNo;
    private final boolean regulatedEdit;
    private final boolean prohibitedFlag;
    private final String prohibitedReason;

    private boolean diffViewed;
    private boolean prohibitedAdjudicated;
    private State state = State.PENDING;
    private String decidedBy;
    private Instant decidedAt;
    private List<String> fixList = List.of();

    public ApprovalCase(String caseId, String listingId, int revisionNo,
                        boolean regulatedEdit, boolean prohibitedFlag, String prohibitedReason) {
        this.caseId = caseId;
        this.listingId = listingId;
        this.revisionNo = revisionNo;
        this.regulatedEdit = regulatedEdit;
        this.prohibitedFlag = prohibitedFlag;
        this.prohibitedReason = prohibitedFlag ? prohibitedReason : null;
    }

    /** FR-ADM-004 validation: the side-by-side diff must be opened for regulated edits. */
    public void markDiffViewed() {
        this.diffViewed = true;
    }

    /** Individual adjudication of a prohibited-flagged item, with retained evidence ref. */
    public void adjudicateProhibited(String adminId, String evidenceRef) {
        if (!prohibitedFlag) throw new IllegalStateException("case is not prohibited-flagged");
        if (adminId == null || adminId.isBlank()) throw new IllegalArgumentException("adminId");
        if (evidenceRef == null || evidenceRef.isBlank()) {
            throw new IllegalArgumentException("evidence reference required (retention per legal policy)");
        }
        this.prohibitedAdjudicated = true;
    }

    public DecisionResult approve(String adminId, Instant now) {
        if (state != State.PENDING) return new DecisionResult.Refused("already decided: " + state);
        if (prohibitedFlag && !prohibitedAdjudicated) {
            return new DecisionResult.Refused("PROHIBITED_REQUIRES_INDIVIDUAL_ADJUDICATION: " + prohibitedReason);
        }
        if (regulatedEdit && !diffViewed) {
            return new DecisionResult.Refused("DIFF_VIEW_REQUIRED for regulated-field edits");
        }
        decide(State.APPROVED, adminId, now);
        return new DecisionResult.Decided(State.APPROVED);
    }

    public DecisionResult reject(String adminId, List<String> fixList, Instant now) {
        if (state != State.PENDING) return new DecisionResult.Refused("already decided: " + state);
        if (fixList == null || fixList.isEmpty()) {
            return new DecisionResult.Refused("FIX_LIST_REQUIRED on rejection");
        }
        this.fixList = List.copyOf(fixList);
        decide(State.REJECTED, adminId, now);
        return new DecisionResult.Decided(State.REJECTED);
    }

    private void decide(State s, String adminId, Instant now) {
        if (adminId == null || adminId.isBlank()) throw new IllegalArgumentException("adminId");
        this.state = s;
        this.decidedBy = adminId;
        this.decidedAt = now;
    }

    // ------------------------------------------------------------- bulk lane

    /** Outcome of a bulk approval attempt over a selection of pending cases. */
    public record BulkOutcome(List<String> approvedCaseIds, Map<String, String> excluded) {}

    public sealed interface BulkResult {
        record Ok(BulkOutcome outcome) implements BulkResult {}
        record Invalid(String reason) implements BulkResult {}
    }

    public static final int BULK_MAX = 100;                 // FR-ADM-004 inputs
    public static final int BULK_SAMPLING_PERCENT = 10;     // ≥ 10% manual-view sampling

    /**
     * Bulk approve with the document's gates. Items are never silently dropped:
     * every exclusion carries its reason back to the operator.
     */
    public static BulkResult bulkApprove(List<ApprovalCase> selection, int manuallyViewedCount,
                                         String adminId, Instant now) {
        if (selection == null || selection.isEmpty()) return new BulkResult.Invalid("EMPTY_SELECTION");
        if (selection.size() > BULK_MAX) {
            return new BulkResult.Invalid("BULK_LIMIT_EXCEEDED: " + selection.size() + " > " + BULK_MAX);
        }
        int required = (int) Math.ceil(selection.size() * (BULK_SAMPLING_PERCENT / 100.0));
        if (manuallyViewedCount < required) {
            return new BulkResult.Invalid(
                    "SAMPLING_BELOW_10_PERCENT: viewed " + manuallyViewedCount + ", required " + required);
        }
        var approved = new ArrayList<String>();
        var excluded = new LinkedHashMap<String, String>();
        for (ApprovalCase c : selection) {
            if (c.prohibitedFlag && !c.prohibitedAdjudicated) {
                excluded.put(c.caseId, "PROHIBITED_REQUIRES_INDIVIDUAL: " + c.prohibitedReason);
                continue;
            }
            if (c.regulatedEdit && !c.diffViewed) {
                excluded.put(c.caseId, "DIFF_VIEW_REQUIRED");
                continue;
            }
            var r = c.approve(adminId, now);
            if (r instanceof DecisionResult.Decided) approved.add(c.caseId);
            else excluded.put(c.caseId, ((DecisionResult.Refused) r).reason());
        }
        return new BulkResult.Ok(new BulkOutcome(List.copyOf(approved), Map.copyOf(excluded)));
    }

    public State state()            { return state; }
    public String caseId()          { return caseId; }
    public String listingId()       { return listingId; }
    public int revisionNo()         { return revisionNo; }
    public String decidedBy()       { return decidedBy; }
    public Instant decidedAt()      { return decidedAt; }
    public List<String> fixList()   { return fixList; }
}
