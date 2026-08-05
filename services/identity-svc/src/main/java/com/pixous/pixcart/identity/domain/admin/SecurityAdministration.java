package com.pixous.pixcart.identity.domain.admin;

import com.pixous.pixcart.identity.domain.rbac.Rbac;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Security administration — FR-ADM-017.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "role & permission editor with SoD conflict detection, IP allow-lists for admin
 *                console, session policies, MFA enforcement toggles per role, and access-review
 *                campaigns with attestations."
 *   RULES:      "Admin console access only from allow-listed CIDRs + MFA; break-glass account
 *                sealed with dual-custody procedure and 24-h auto-review."
 *   VALIDATION: "Permission changes preview blast-radius (affected users count); cannot remove
 *                last SA; SoD rule set versioned."
 *
 * Console access requires BOTH an allow-listed source address and satisfied MFA — the
 * conjunction is enforced in one place so neither can be waived independently. Break-glass
 * needs two distinct custodians and schedules its own 24-hour review at the moment it is
 * opened, so the review cannot be forgotten. Removing the last Super Admin is refused
 * outright: a platform that can lock itself out of its own administration is a worse outcome
 * than an over-privileged account.
 */
public final class SecurityAdministration {

    public static final Duration BREAK_GLASS_AUTO_REVIEW = Duration.ofHours(24);

    public sealed interface Decision {
        record Allowed() implements Decision {}
        record Denied(String reason) implements Decision {}
    }

    // ------------------------------------------------------- console access

    /** IPv4 CIDR membership, e.g. "203.0.113.0/24". */
    public static boolean cidrContains(String cidr, String ipv4) {
        try {
            String[] parts = cidr.split("/");
            long network = ipToLong(parts[0]);
            int prefix = Integer.parseInt(parts[1]);
            if (prefix < 0 || prefix > 32) return false;
            long mask = prefix == 0 ? 0L : (0xFFFFFFFFL << (32 - prefix)) & 0xFFFFFFFFL;
            return (ipToLong(ipv4) & mask) == (network & mask);
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static long ipToLong(String ip) {
        String[] o = ip.trim().split("\\.");
        if (o.length != 4) throw new IllegalArgumentException("not IPv4: " + ip);
        long v = 0;
        for (String part : o) {
            int b = Integer.parseInt(part);
            if (b < 0 || b > 255) throw new IllegalArgumentException("octet out of range");
            v = (v << 8) | b;
        }
        return v;
    }

    /**
     * RULES: admin console access requires an allow-listed CIDR **and** MFA. Both conditions,
     * every time — there is no path that satisfies one and skips the other.
     */
    public static Decision mayAccessConsole(String sourceIp, List<String> allowedCidrs, boolean mfaSatisfied) {
        boolean inAllowList = allowedCidrs.stream().anyMatch(c -> cidrContains(c, sourceIp));
        if (!inAllowList) return new Decision.Denied("SOURCE_IP_NOT_ALLOW_LISTED: " + sourceIp);
        if (!mfaSatisfied) return new Decision.Denied("MFA_REQUIRED_FOR_CONSOLE");
        return new Decision.Allowed();
    }

    /** MFA enforcement toggles per role; staff roles cannot opt out. */
    public static boolean mfaRequiredFor(Rbac.Role role, Set<Rbac.Role> mfaOptionalRoles) {
        if (role == Rbac.Role.SUPER_ADMIN || role == Rbac.Role.ADMIN || role == Rbac.Role.FINANCE) return true;
        return !mfaOptionalRoles.contains(role);
    }

    // --------------------------------------------------------- break-glass

    /** A sealed break-glass activation requiring two distinct custodians. */
    public record BreakGlass(String accountId, String custodianA, String custodianB,
                             Instant openedAt, Instant autoReviewDueAt, String justification) {}

    public sealed interface BreakGlassResult {
        record Opened(BreakGlass session) implements BreakGlassResult {}
        record Refused(String reason) implements BreakGlassResult {}
    }

    /**
     * Open the break-glass account under dual custody. The 24-hour auto-review is scheduled at
     * the moment of opening, so it exists whether or not anyone remembers to file it.
     */
    public static BreakGlassResult openBreakGlass(String accountId, String custodianA, String custodianB,
                                                  String justification, Instant now) {
        if (custodianA == null || custodianA.isBlank() || custodianB == null || custodianB.isBlank()) {
            return new BreakGlassResult.Refused("DUAL_CUSTODY_REQUIRES_TWO_CUSTODIANS");
        }
        if (custodianA.equals(custodianB)) {
            return new BreakGlassResult.Refused("CUSTODIANS_MUST_BE_DISTINCT");
        }
        if (justification == null || justification.trim().length() < 10) {
            return new BreakGlassResult.Refused("JUSTIFICATION_REQUIRED");
        }
        return new BreakGlassResult.Opened(new BreakGlass(accountId, custodianA, custodianB,
                now, now.plus(BREAK_GLASS_AUTO_REVIEW), justification));
    }

    public static boolean isBreakGlassReviewOverdue(BreakGlass session, Instant now) {
        return now.isAfter(session.autoReviewDueAt());
    }

    // ------------------------------------------- permission change safety

    /** VALIDATION: a permission change previews its blast radius before being applied. */
    public record BlastRadius(String capability, Rbac.Role role, Rbac.Access from, Rbac.Access to,
                              int affectedUsers, boolean removesAccess) {}

    public static BlastRadius previewPermissionChange(Rbac.Role role, Rbac.Capability capability,
                                                      Rbac.Access to, int usersHoldingRole) {
        Rbac.Access from = Rbac.access(role, capability);
        boolean removes = from != Rbac.Access.NONE && to == Rbac.Access.NONE;
        return new BlastRadius(capability.name(), role, from, to, usersHoldingRole, removes);
    }

    /**
     * VALIDATION: the last Super Admin cannot be removed or demoted. Returns a refusal so the
     * console can explain why rather than silently doing nothing.
     */
    public static Decision mayRemoveSuperAdmin(int currentSuperAdminCount) {
        if (currentSuperAdminCount <= 1) {
            return new Decision.Denied("CANNOT_REMOVE_LAST_SUPER_ADMIN");
        }
        return new Decision.Allowed();
    }

    // ------------------------------------------------- versioned SoD ruleset

    /** A versioned separation-of-duties ruleset (VALIDATION: "SoD rule set versioned"). */
    public record SodRule(String ruleId, Rbac.Capability a, Rbac.Capability b, String rationale) {}

    public record SodRuleset(int version, Instant effectiveFrom, List<SodRule> rules) {
        public SodRuleset {
            rules = List.copyOf(rules);
        }

        /** Roles that hold both halves of any rule in this ruleset version. */
        public List<String> conflictsFor(Set<Rbac.Role> roles) {
            var out = new ArrayList<String>();
            for (SodRule r : rules) {
                boolean holdsA = roles.stream().anyMatch(x -> Rbac.permits(x, r.a()));
                boolean holdsB = roles.stream().anyMatch(x -> Rbac.permits(x, r.b()));
                if (holdsA && holdsB) out.add(r.ruleId());
            }
            return out;
        }
    }

    /** The ruleset as documented: settlement approval must not sit with refund initiation. */
    public static SodRuleset defaultRuleset(Instant effectiveFrom) {
        return new SodRuleset(1, effectiveFrom, List.of(
                new SodRule("SOD-01", Rbac.Capability.SETTLEMENT_PAYOUTS, Rbac.Capability.REFUND_INITIATION,
                        "an approver of payouts must not also initiate refunds"),
                new SodRule("SOD-02", Rbac.Capability.USER_ADMINISTRATION, Rbac.Capability.AUDIT_LOG_VIEW,
                        "an administrator of users must not be the sole reviewer of their own audit trail")));
    }

    private SecurityAdministration() {
    }
}
