package com.pixous.pixcart.finance.domain.refunds;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Refund operations console — FR-FIN-006.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "give Finance an operations view over all refunds (auto + manual), SLA tracking,
 *                manual initiation with maker-checker above threshold, failure retries,
 *                instrument-change handling and refund-to-source proof capture (ARN/UTR)."
 *   VALIDATION: "Amount caps vs captured; duplicate-refund guard per line; SUP-initiated bounded
 *                by policy matrix (≤ ₹2,000, delivered-issue reasons)."
 *   RULES:      "Manual > ₹10,000 requires checker (BRU/SoD); COD refunds require verified
 *                beneficiary; goodwill refunds tagged separately for P&L."
 *   ERRORS:     "Gateway refund reject codes mapped to actions (expired-instrument →
 *                collect-details flow); stuck > 7 days auto-escalates with customer notice."
 *
 * This is the operator surface over the Slice-4 refund engine and the Slice-7 return saga: those
 * decide WHETHER a refund is owed, this governs WHO may push it, HOW MUCH, and what happens when
 * the gateway says no.
 *
 * The authority model is the substance of the requirement. Support may refund, but only within a
 * bounded policy matrix — at most ₹2,000 and only for delivered-issue reasons — so a support
 * seat cannot be socially engineered into a large payout. Finance may refund any amount, but
 * above ₹10,000 a second person must approve, and the checker may not be the maker.
 */
public final class RefundConsole {

    /** VALIDATION: the support policy-matrix ceiling. */
    public static final long SUP_INITIATION_CAP_PAISE = 2_000 * 100;
    /** RULES: a manual refund above this needs a checker. */
    public static final long CHECKER_THRESHOLD_PAISE = 10_000 * 100;
    /** ERRORS: a refund stuck this long auto-escalates with a customer notice. */
    public static final Duration STUCK_ESCALATION_AFTER = Duration.ofDays(7);
    /** FR-CUS-018: refund initiation SLA after a QC-pass. */
    public static final Duration INITIATION_SLA = Duration.ofHours(24);

    public enum Origin { AUTO_RETURN, MANUAL_FIN, MANUAL_SUP, GOODWILL }

    public enum State { PENDING_CHECKER, INITIATED, SENT_TO_GATEWAY, SUCCEEDED, FAILED, ESCALATED, CANCELLED }

    public enum Destination { ORIGINAL_INSTRUMENT, WALLET, BANK_TRANSFER }

    /** Reasons Support is permitted to act on (VALIDATION: "delivered-issue reasons"). */
    public enum Reason {
        DAMAGED_ON_DELIVERY(true),
        WRONG_ITEM_DELIVERED(true),
        MISSING_ITEM(true),
        NOT_AS_DESCRIBED(true),
        QC_PASS_RETURN(false),
        CANCELLED_PRE_SHIP(false),
        PRICE_ADJUSTMENT(false),
        GOODWILL(false);

        private final boolean deliveredIssue;

        Reason(boolean deliveredIssue) {
            this.deliveredIssue = deliveredIssue;
        }

        public boolean isDeliveredIssue() {
            return deliveredIssue;
        }
    }

    /** Gateway rejection codes and the remediation each maps to (ERRORS). */
    public enum RejectCode { EXPIRED_INSTRUMENT, ACCOUNT_CLOSED, INSTRUMENT_BLOCKED, GATEWAY_TECHNICAL, LIMIT_EXCEEDED }

    public enum Remediation { COLLECT_NEW_INSTRUMENT_DETAILS, ROUTE_TO_WALLET_WITH_CONSENT, RETRY, MANUAL_INVESTIGATION }

    /** ERRORS: the reject-code → action mapping, held in one place so it cannot diverge. */
    private static final Map<RejectCode, Remediation> REMEDIATION = new EnumMap<>(RejectCode.class);
    static {
        REMEDIATION.put(RejectCode.EXPIRED_INSTRUMENT, Remediation.COLLECT_NEW_INSTRUMENT_DETAILS);
        REMEDIATION.put(RejectCode.ACCOUNT_CLOSED, Remediation.COLLECT_NEW_INSTRUMENT_DETAILS);
        REMEDIATION.put(RejectCode.INSTRUMENT_BLOCKED, Remediation.ROUTE_TO_WALLET_WITH_CONSENT);
        REMEDIATION.put(RejectCode.GATEWAY_TECHNICAL, Remediation.RETRY);
        REMEDIATION.put(RejectCode.LIMIT_EXCEEDED, Remediation.MANUAL_INVESTIGATION);
    }

    public static Remediation remediationFor(RejectCode code) {
        return REMEDIATION.get(code);
    }

    /** The initiator's role, which the policy matrix is expressed against. */
    public enum InitiatorRole { FINANCE, SUPPORT, SYSTEM }

    public record Request(String refundId, String subOrderId, String lineId, long amountPaise,
                          Reason reason, Origin origin, Destination destination,
                          String initiatorId, InitiatorRole initiatorRole,
                          boolean beneficiaryVerified, String evidenceRef, Instant at) {}

    /** Facts about the underlying payment, supplied by the payment service. */
    public record LineFacts(String lineId, long capturedPaise, long alreadyRefundedPaise, boolean wasCod) {}

    public sealed interface Result {
        record Ok(Refund refund) implements Result {}
        record Rejected(List<String> violations) implements Result {}
    }

    public static final class Refund {
        private final Request request;
        private State state;
        private String makerId;
        private String checkerId;
        private String proofRef;                 // ARN or UTR
        private RejectCode lastRejectCode;
        private int attempts;
        private Instant lastTransitionAt;
        private final List<String> trail = new ArrayList<>();

        private Refund(Request r, State initial) {
            this.request = r;
            this.state = initial;
            this.makerId = r.initiatorId();
            this.lastTransitionAt = r.at();
            this.trail.add(initial + " by " + r.initiatorId() + " (" + r.initiatorRole() + ")");
        }

        public State state()               { return state; }
        public Request request()           { return request; }
        public String proofRef()           { return proofRef; }
        public RejectCode lastRejectCode() { return lastRejectCode; }
        public int attempts()              { return attempts; }
        public String makerId()            { return makerId; }
        public String checkerId()          { return checkerId; }
        public List<String> trail()        { return List.copyOf(trail); }
        public Instant lastTransitionAt()  { return lastTransitionAt; }

        /** RULES: goodwill refunds are tagged separately so they can be isolated in P&L. */
        public boolean isGoodwill() {
            return request.origin() == Origin.GOODWILL || request.reason() == Reason.GOODWILL;
        }

        private void moveTo(State next, String note, Instant at) {
            this.state = next;
            this.lastTransitionAt = at;
            this.trail.add(next + ": " + note);
        }
    }

    private final Map<String, Refund> refunds = new LinkedHashMap<>();
    /** lineId -> refund ids already raised, backing the duplicate guard. */
    private final Map<String, List<String>> byLine = new LinkedHashMap<>();

    /**
     * Initiate a refund. Every authority and amount check runs before the refund exists, so a
     * rejected attempt leaves nothing in the queue for an operator to retry into existence.
     */
    public Result initiate(Request r, LineFacts facts) {
        var v = new ArrayList<String>();

        if (r.amountPaise() <= 0) v.add("AMOUNT_MUST_BE_POSITIVE");

        // VALIDATION: amount cap against what was actually captured, net of prior refunds.
        long refundable = facts.capturedPaise() - facts.alreadyRefundedPaise();
        if (r.amountPaise() > refundable) {
            v.add("AMOUNT_EXCEEDS_REFUNDABLE: " + r.amountPaise() + " > " + refundable);
        }

        // VALIDATION: duplicate-refund guard per line. A second refund on a line is permitted
        // only if the first was cancelled or failed - an in-flight or successful one blocks it.
        for (String existingId : byLine.getOrDefault(r.lineId(), List.of())) {
            Refund existing = refunds.get(existingId);
            if (existing == null) continue;
            if (existing.state != State.CANCELLED && existing.state != State.FAILED) {
                v.add("DUPLICATE_REFUND_FOR_LINE: " + r.lineId() + " already has " + existingId
                        + " in " + existing.state);
            }
        }

        // VALIDATION: the support policy matrix - bounded amount AND delivered-issue reasons only.
        if (r.initiatorRole() == InitiatorRole.SUPPORT) {
            if (r.amountPaise() > SUP_INITIATION_CAP_PAISE) {
                v.add("SUPPORT_CAP_EXCEEDED: " + r.amountPaise() + " > " + SUP_INITIATION_CAP_PAISE);
            }
            if (!r.reason().isDeliveredIssue()) {
                v.add("SUPPORT_REASON_NOT_IN_POLICY_MATRIX: " + r.reason());
            }
        }

        // RULES: a COD refund needs a verified beneficiary - there is no original instrument.
        if (facts.wasCod()) {
            if (r.destination() == Destination.ORIGINAL_INSTRUMENT) {
                v.add("COD_HAS_NO_ORIGINAL_INSTRUMENT");
            }
            if (!r.beneficiaryVerified()) {
                v.add("COD_REFUND_REQUIRES_VERIFIED_BENEFICIARY");
            }
        }

        if (r.origin() == Origin.GOODWILL && (r.evidenceRef() == null || r.evidenceRef().isBlank())) {
            v.add("GOODWILL_REFUND_REQUIRES_EVIDENCE");
        }

        if (!v.isEmpty()) return new Result.Rejected(List.copyOf(v));

        // RULES: a manual refund above the threshold waits for a checker.
        boolean manual = r.origin() == Origin.MANUAL_FIN || r.origin() == Origin.MANUAL_SUP
                || r.origin() == Origin.GOODWILL;
        State initial = (manual && r.amountPaise() > CHECKER_THRESHOLD_PAISE)
                ? State.PENDING_CHECKER : State.INITIATED;

        var refund = new Refund(r, initial);
        refunds.put(r.refundId(), refund);
        byLine.computeIfAbsent(r.lineId(), k -> new ArrayList<>()).add(r.refundId());
        return new Result.Ok(refund);
    }

    /** RULES/SoD: the checker must be a different person from the maker. */
    public Result approve(String refundId, String checkerId, Instant at) {
        Refund f = refunds.get(refundId);
        if (f == null) return new Result.Rejected(List.of("UNKNOWN_REFUND"));
        if (f.state != State.PENDING_CHECKER) return new Result.Rejected(List.of("NOT_PENDING_CHECKER"));
        if (checkerId == null || checkerId.isBlank()) return new Result.Rejected(List.of("CHECKER_REQUIRED"));
        if (checkerId.equals(f.makerId)) return new Result.Rejected(List.of("SOD_VIOLATION_CHECKER_EQUALS_MAKER"));
        f.checkerId = checkerId;
        f.moveTo(State.INITIATED, "approved by " + checkerId, at);
        return new Result.Ok(f);
    }

    public Result cancel(String refundId, String actorId, String reason, Instant at) {
        Refund f = refunds.get(refundId);
        if (f == null) return new Result.Rejected(List.of("UNKNOWN_REFUND"));
        if (f.state == State.SUCCEEDED) return new Result.Rejected(List.of("CANNOT_CANCEL_A_SUCCEEDED_REFUND"));
        if (reason == null || reason.isBlank()) return new Result.Rejected(List.of("CANCEL_REASON_REQUIRED"));
        f.moveTo(State.CANCELLED, "cancelled by " + actorId + ": " + reason, at);
        return new Result.Ok(f);
    }

    public Result sendToGateway(String refundId, Instant at) {
        Refund f = refunds.get(refundId);
        if (f == null) return new Result.Rejected(List.of("UNKNOWN_REFUND"));
        if (f.state != State.INITIATED && f.state != State.FAILED) {
            return new Result.Rejected(List.of("NOT_SENDABLE_FROM_" + f.state));
        }
        f.attempts++;
        f.moveTo(State.SENT_TO_GATEWAY, "attempt " + f.attempts, at);
        return new Result.Ok(f);
    }

    /** DESC: refund-to-source proof capture. A success without an ARN/UTR is not a success. */
    public Result recordSuccess(String refundId, String proofRef, Instant at) {
        Refund f = refunds.get(refundId);
        if (f == null) return new Result.Rejected(List.of("UNKNOWN_REFUND"));
        if (f.state != State.SENT_TO_GATEWAY) return new Result.Rejected(List.of("NOT_AWAITING_GATEWAY"));
        if (proofRef == null || proofRef.isBlank()) return new Result.Rejected(List.of("PROOF_REF_REQUIRED_ARN_OR_UTR"));
        f.proofRef = proofRef;
        f.moveTo(State.SUCCEEDED, "proof " + proofRef, at);
        return new Result.Ok(f);
    }

    public Result recordFailure(String refundId, RejectCode code, Instant at) {
        Refund f = refunds.get(refundId);
        if (f == null) return new Result.Rejected(List.of("UNKNOWN_REFUND"));
        if (f.state != State.SENT_TO_GATEWAY) return new Result.Rejected(List.of("NOT_AWAITING_GATEWAY"));
        f.lastRejectCode = code;
        f.moveTo(State.FAILED, code + " -> " + remediationFor(code), at);
        return new Result.Ok(f);
    }

    /** ERRORS: a refund stuck beyond 7 days escalates, with a customer notice owed. */
    public boolean isStuck(String refundId, Instant now) {
        Refund f = refunds.get(refundId);
        if (f == null) return false;
        if (f.state == State.SUCCEEDED || f.state == State.CANCELLED || f.state == State.ESCALATED) return false;
        return now.isAfter(f.lastTransitionAt.plus(STUCK_ESCALATION_AFTER));
    }

    public Result escalate(String refundId, Instant now) {
        Refund f = refunds.get(refundId);
        if (f == null) return new Result.Rejected(List.of("UNKNOWN_REFUND"));
        if (!isStuck(refundId, now)) return new Result.Rejected(List.of("NOT_STUCK_YET"));
        f.moveTo(State.ESCALATED, "auto-escalated after 7 days; customer notice sent", now);
        return new Result.Ok(f);
    }

    /** DESC: SLA tracking against the FR-CUS-018 24-hour initiation deadline. */
    public boolean isInitiationSlaBreached(String refundId, Instant qcPassedAt, Instant now) {
        Refund f = refunds.get(refundId);
        if (f == null) return false;
        boolean notYetSent = f.state == State.PENDING_CHECKER || f.state == State.INITIATED;
        return notYetSent && now.isAfter(qcPassedAt.plus(INITIATION_SLA));
    }

    // ------------------------------------------------------------- analytics

    /** OUTPUTS: monthly refund analytics by reason. */
    public Map<Reason, Long> succeededTotalsByReason() {
        var out = new EnumMap<Reason, Long>(Reason.class);
        for (Refund f : refunds.values()) {
            if (f.state != State.SUCCEEDED) continue;
            out.merge(f.request.reason(), f.request.amountPaise(), Long::sum);
        }
        return out;
    }

    /** RULES: goodwill isolated for P&L — it is a cost, not a returns-driven reversal. */
    public long goodwillTotalPaise() {
        return refunds.values().stream()
                .filter(f -> f.state == State.SUCCEEDED && f.isGoodwill())
                .mapToLong(f -> f.request.amountPaise()).sum();
    }

    /** "Leakage": succeeded refunds that were NOT driven by a return or a cancellation. */
    public long leakagePaise() {
        return refunds.values().stream()
                .filter(f -> f.state == State.SUCCEEDED)
                .filter(f -> f.request.reason() != Reason.QC_PASS_RETURN
                        && f.request.reason() != Reason.CANCELLED_PRE_SHIP)
                .mapToLong(f -> f.request.amountPaise()).sum();
    }

    public List<Refund> queue(State state) {
        return refunds.values().stream().filter(f -> f.state == state).toList();
    }

    public Optional<Refund> refund(String refundId) {
        return Optional.ofNullable(refunds.get(refundId));
    }
}
