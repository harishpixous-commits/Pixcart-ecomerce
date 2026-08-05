package com.pixous.pixcart.catalogue.domain.governance;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Brand registry & infringement takedown — FR-ADM-006.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "maintain a brand registry (name, logo, owner/authorisation evidence),
 *                vendor-brand authorisation links, and gate branded listings to authorised
 *                vendors with an infringement takedown workflow."
 *   RULES:      "Unauthorised branded listing → auto-block at approval (FR-ADM-004);
 *                takedown SLA 48 h with counter-notice path."
 *   ACCEPTANCE: "Given a takedown accepted, When executed, Then all cited listings unpublish
 *                within 1 h, vendors are notified with cure/appeal path, and the case log is
 *                complete."
 *   VALIDATION: "Brand-name dedupe (normalised); authorisation docs dated & expiring; claims
 *                require claimant identity + rights basis."
 *
 * Pure domain. The gate this exists to provide is {@link #mayListBrand}: a vendor may only
 * list under a brand it holds a current, unexpired authorisation for — which is what
 * FR-ADM-004's approval step calls to auto-block infringement. Takedowns carry a decision
 * SLA, an execution deadline, a mandatory counter-notice path and an append-only case log.
 */
public final class BrandRegistry {

    /** RULES: a takedown claim must be decided within this window. */
    public static final Duration TAKEDOWN_DECISION_SLA = Duration.ofHours(48);
    /** ACCEPTANCE: once accepted, cited listings must unpublish within this window. */
    public static final Duration TAKEDOWN_EXECUTION_SLA = Duration.ofHours(1);
    /** The cure/appeal window offered to the affected vendor. */
    public static final Duration COUNTER_NOTICE_WINDOW = Duration.ofDays(10);

    public enum BrandStatus { PENDING, ACTIVE, REJECTED, RETIRED }

    public enum ClaimState { OPEN, ACCEPTED, REJECTED, COUNTER_NOTICED, WITHDRAWN }

    public sealed interface Outcome {
        record Ok(String id) implements Outcome {}
        record Rejected(String reason) implements Outcome {}
    }

    public record Brand(String brandId, String name, String normalisedName, String ownerRef,
                        BrandStatus status) {}

    /** VALIDATION: authorisation documents are dated and expiring. */
    public record Authorisation(String vendorId, String brandId, String documentRef,
                                Instant issuedAt, Instant expiresAt) {
        public Authorisation {
            if (documentRef == null || documentRef.isBlank()) throw new IllegalArgumentException("documentRef");
            if (issuedAt == null || expiresAt == null) throw new IllegalArgumentException("authorisation must be dated");
            if (!expiresAt.isAfter(issuedAt)) throw new IllegalArgumentException("expiry must follow issue");
        }

        public boolean isCurrentAt(Instant when) {
            return !when.isBefore(issuedAt) && when.isBefore(expiresAt);
        }
    }

    /** VALIDATION: a claim requires claimant identity and a rights basis. */
    public record TakedownClaim(String claimId, String brandId, String claimantIdentityRef,
                                String rightsBasis, List<String> citedListingIds, Instant filedAt) {}

    public record CaseLogEntry(Instant at, String action, String detail) {}

    /** The full lifecycle of one takedown case. */
    public static final class TakedownCase {
        private final TakedownClaim claim;
        private ClaimState state = ClaimState.OPEN;
        private Instant decidedAt;
        private Instant executionDeadline;
        private Instant counterNoticeDeadline;
        private final List<String> unpublishedListings = new ArrayList<>();
        private final List<CaseLogEntry> log = new ArrayList<>();

        TakedownCase(TakedownClaim claim) {
            this.claim = claim;
            log.add(new CaseLogEntry(claim.filedAt(), "FILED",
                    "claimant=" + claim.claimantIdentityRef() + " basis=" + claim.rightsBasis()
                            + " listings=" + claim.citedListingIds().size()));
        }

        /** Decision must land inside the 48 h SLA; a late decision is recorded as breached. */
        public Outcome accept(String adminId, Instant now) {
            if (state != ClaimState.OPEN) return new Outcome.Rejected("ALREADY_DECIDED: " + state);
            state = ClaimState.ACCEPTED;
            decidedAt = now;
            executionDeadline = now.plus(TAKEDOWN_EXECUTION_SLA);
            counterNoticeDeadline = now.plus(COUNTER_NOTICE_WINDOW);
            log.add(new CaseLogEntry(now, "ACCEPTED", "by=" + adminId
                    + (isDecisionSlaBreached() ? " SLA_BREACHED" : " within_SLA")));
            return new Outcome.Ok(claim.claimId());
        }

        public Outcome reject(String adminId, String reason, Instant now) {
            if (state != ClaimState.OPEN) return new Outcome.Rejected("ALREADY_DECIDED: " + state);
            if (reason == null || reason.isBlank()) return new Outcome.Rejected("REJECTION_REASON_REQUIRED");
            state = ClaimState.REJECTED;
            decidedAt = now;
            log.add(new CaseLogEntry(now, "REJECTED", "by=" + adminId + " reason=" + reason));
            return new Outcome.Ok(claim.claimId());
        }

        /** Execute: every cited listing unpublishes, and the vendor gets a cure/appeal path. */
        public Outcome execute(Instant now) {
            if (state != ClaimState.ACCEPTED) return new Outcome.Rejected("NOT_ACCEPTED: " + state);
            unpublishedListings.clear();
            unpublishedListings.addAll(claim.citedListingIds());
            boolean late = now.isAfter(executionDeadline);
            log.add(new CaseLogEntry(now, "EXECUTED",
                    "unpublished=" + unpublishedListings.size() + (late ? " EXECUTION_SLA_BREACHED" : " within_1h")));
            log.add(new CaseLogEntry(now, "VENDOR_NOTIFIED",
                    "cure/appeal by " + counterNoticeDeadline));
            return new Outcome.Ok(claim.claimId());
        }

        /** The vendor's counter-notice, admissible until the window closes. */
        public Outcome counterNotice(String vendorId, String evidenceRef, Instant now) {
            if (state != ClaimState.ACCEPTED) return new Outcome.Rejected("NOT_IN_ACCEPTED_STATE: " + state);
            if (now.isAfter(counterNoticeDeadline)) return new Outcome.Rejected("COUNTER_NOTICE_WINDOW_CLOSED");
            if (evidenceRef == null || evidenceRef.isBlank()) return new Outcome.Rejected("EVIDENCE_REQUIRED");
            state = ClaimState.COUNTER_NOTICED;
            log.add(new CaseLogEntry(now, "COUNTER_NOTICE", "vendor=" + vendorId + " evidence=" + evidenceRef));
            return new Outcome.Ok(claim.claimId());
        }

        public boolean isDecisionSlaBreached() {
            return decidedAt != null && decidedAt.isAfter(claim.filedAt().plus(TAKEDOWN_DECISION_SLA));
        }

        /** ACCEPTANCE: "the case log is complete" — filed, decided, executed, notified. */
        public boolean isLogComplete() {
            var actions = log.stream().map(CaseLogEntry::action).toList();
            if (state == ClaimState.REJECTED) return actions.contains("FILED") && actions.contains("REJECTED");
            return actions.contains("FILED") && actions.contains("ACCEPTED")
                    && actions.contains("EXECUTED") && actions.contains("VENDOR_NOTIFIED");
        }

        public ClaimState state()                  { return state; }
        public List<String> unpublishedListings()  { return List.copyOf(unpublishedListings); }
        public List<CaseLogEntry> caseLog()        { return List.copyOf(log); }
        public Instant executionDeadline()         { return executionDeadline; }
        public Instant counterNoticeDeadline()     { return counterNoticeDeadline; }
    }

    private final Map<String, Brand> brands = new LinkedHashMap<>();
    private final Map<String, List<Authorisation>> authorisations = new LinkedHashMap<>();
    private final Map<String, TakedownCase> cases = new LinkedHashMap<>();

    /** VALIDATION: brand-name dedupe on a normalised form (case, punctuation, spacing). */
    public static String normalise(String name) {
        if (name == null) return "";
        return name.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    public Outcome registerBrand(String brandId, String name, String ownerRef) {
        if (name == null || name.trim().length() < 2) return new Outcome.Rejected("BRAND_NAME_TOO_SHORT");
        String norm = normalise(name);
        for (Brand b : brands.values()) {
            if (b.normalisedName().equals(norm) && b.status() != BrandStatus.REJECTED) {
                return new Outcome.Rejected("DUPLICATE_BRAND_NAME: matches " + b.brandId());
            }
        }
        brands.put(brandId, new Brand(brandId, name, norm, ownerRef, BrandStatus.PENDING));
        return new Outcome.Ok(brandId);
    }

    public Outcome approveBrand(String brandId) {
        Brand b = brands.get(brandId);
        if (b == null) return new Outcome.Rejected("UNKNOWN_BRAND");
        brands.put(brandId, new Brand(b.brandId(), b.name(), b.normalisedName(), b.ownerRef(), BrandStatus.ACTIVE));
        return new Outcome.Ok(brandId);
    }

    public Outcome addAuthorisation(Authorisation a) {
        Brand b = brands.get(a.brandId());
        if (b == null) return new Outcome.Rejected("UNKNOWN_BRAND");
        if (b.status() != BrandStatus.ACTIVE) return new Outcome.Rejected("BRAND_NOT_ACTIVE: " + b.status());
        authorisations.computeIfAbsent(a.brandId(), k -> new ArrayList<>()).add(a);
        return new Outcome.Ok(a.brandId());
    }

    /**
     * THE GATE (RULES: "unauthorised branded listing → auto-block at approval"). A vendor may
     * list under a brand only if the brand is ACTIVE and the vendor holds an authorisation
     * that is current at that instant. Expiry is enforced, not merely recorded.
     */
    public boolean mayListBrand(String vendorId, String brandId, Instant at) {
        Brand b = brands.get(brandId);
        if (b == null || b.status() != BrandStatus.ACTIVE) return false;
        return authorisations.getOrDefault(brandId, List.of()).stream()
                .anyMatch(a -> a.vendorId().equals(vendorId) && a.isCurrentAt(at));
    }

    /** File a takedown claim; identity and rights basis are mandatory (VALIDATION). */
    public Outcome fileTakedown(TakedownClaim claim) {
        if (claim.claimantIdentityRef() == null || claim.claimantIdentityRef().isBlank()) {
            return new Outcome.Rejected("CLAIMANT_IDENTITY_REQUIRED");
        }
        if (claim.rightsBasis() == null || claim.rightsBasis().isBlank()) {
            return new Outcome.Rejected("RIGHTS_BASIS_REQUIRED");
        }
        if (claim.citedListingIds().isEmpty()) return new Outcome.Rejected("NO_LISTINGS_CITED");
        if (!brands.containsKey(claim.brandId())) return new Outcome.Rejected("UNKNOWN_BRAND");
        cases.put(claim.claimId(), new TakedownCase(claim));
        return new Outcome.Ok(claim.claimId());
    }

    public TakedownCase caseFor(String claimId) {
        return cases.get(claimId);
    }

    public Brand brand(String brandId) {
        return brands.get(brandId);
    }
}
