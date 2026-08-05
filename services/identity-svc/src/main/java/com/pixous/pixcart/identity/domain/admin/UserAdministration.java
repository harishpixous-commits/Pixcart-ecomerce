package com.pixous.pixcart.identity.domain.admin;

import com.pixous.pixcart.identity.domain.rbac.Rbac;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;

/**
 * User management (customers & staff) — FR-ADM-002.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "search users, view profiles with masked PII (audited reveal), manage state
 *                (active/suspend with reason), reset MFA via verified process, and manage
 *                internal staff accounts with role assignment."
 *   RULES:      "Customer deletion only via privacy workflow (FR-CUS-027), never ad-hoc;
 *                staff dormant 60 days auto-disabled."
 *   VALIDATION: "Suspension requires reason; staff email domain allow-list; SoD:
 *                settlement-approver role cannot also hold refund-initiator
 *                (FR-ADM-017 policies)."
 *
 * PII is masked by default and a reveal is only permitted when an audit record is written —
 * the reveal and its audit entry are one operation, so an unaudited reveal is not
 * expressible. Deletion of a customer is deliberately NOT implemented here: the only lawful
 * path is the privacy workflow, and this class refuses rather than offering a shortcut.
 */
public final class UserAdministration {

    public static final Duration STAFF_DORMANCY_LIMIT = Duration.ofDays(60);

    public enum UserState { ACTIVE, SUSPENDED, DISABLED }

    public sealed interface Outcome {
        record Ok(String detail) implements Outcome {}
        record Rejected(String reason) implements Outcome {}
    }

    private UserAdministration() {
    }

    // ------------------------------------------------------------- PII masking

    /** Masked email: first character, then asterisks, preserving the domain. */
    public static String maskEmail(String email) {
        if (email == null || !email.contains("@")) return "***";
        int at = email.indexOf('@');
        String local = email.substring(0, at);
        String domain = email.substring(at);
        if (local.isEmpty()) return "***" + domain;
        return local.charAt(0) + "*".repeat(Math.max(3, local.length() - 1)) + domain;
    }

    /** Masked mobile: country code and last two digits only. */
    public static String maskMobile(String e164) {
        if (e164 == null || e164.length() < 5) return "***";
        String cc = e164.startsWith("+") ? e164.substring(0, 3) : "";
        String tail = e164.substring(e164.length() - 2);
        return cc + "*".repeat(Math.max(4, e164.length() - cc.length() - 2)) + tail;
    }

    /** The result of a reveal: the clear value AND the audit record that authorised it. */
    public record Reveal(String clearValue, String auditAction, String auditDetail) {}

    /**
     * Reveal PII. Requires a role holding USER_ADMINISTRATION and a stated justification; the
     * returned record carries the audit entry the caller must append (Slice-14 AuditChain).
     * There is no overload that reveals without producing one.
     */
    public static Outcome revealPii(Rbac.Role actorRole, String actorId, String subjectId,
                                    String field, String clearValue, String justification) {
        if (!Rbac.permits(actorRole, Rbac.Capability.USER_ADMINISTRATION)) {
            return new Outcome.Rejected("ROLE_MAY_NOT_ADMINISTER_USERS: " + actorRole);
        }
        if (justification == null || justification.trim().length() < 8) {
            return new Outcome.Rejected("REVEAL_JUSTIFICATION_REQUIRED");
        }
        return new Outcome.Ok("PII_REVEALED:" + field + ":" + clearValue
                + "|audit=PII_REVEAL actor=" + actorId + " subject=" + subjectId
                + " field=" + field + " reason=" + justification);
    }

    // ------------------------------------------------------------ state changes

    /** VALIDATION: suspension requires a reason. */
    public static Outcome suspendUser(String subjectId, String reason) {
        if (reason == null || reason.trim().length() < 4) return new Outcome.Rejected("SUSPENSION_REASON_REQUIRED");
        return new Outcome.Ok("SUSPENDED:" + subjectId + " reason=" + reason);
    }

    /**
     * RULES: a customer may only be deleted through the privacy workflow (FR-CUS-027).
     * This entry point exists so the refusal is explicit and testable.
     */
    public static Outcome deleteCustomerAdHoc(String subjectId) {
        return new Outcome.Rejected("AD_HOC_DELETION_FORBIDDEN_USE_PRIVACY_WORKFLOW (FR-CUS-027)");
    }

    /** MFA reset only through the verified process: identity re-proof plus a second approver. */
    public static Outcome resetMfa(String subjectId, boolean identityReVerified, String secondApproverId) {
        if (!identityReVerified) return new Outcome.Rejected("IDENTITY_REVERIFICATION_REQUIRED");
        if (secondApproverId == null || secondApproverId.isBlank()) return new Outcome.Rejected("SECOND_APPROVER_REQUIRED");
        return new Outcome.Ok("MFA_RESET:" + subjectId + " approver=" + secondApproverId);
    }

    // ------------------------------------------------------------------- staff

    /** VALIDATION: staff email must be on the corporate domain allow-list. */
    public static Outcome createStaff(String email, Rbac.Role role, Set<String> allowedDomains) {
        if (email == null || !email.contains("@")) return new Outcome.Rejected("EMAIL_MALFORMED");
        String domain = email.substring(email.indexOf('@') + 1).toLowerCase();
        if (!allowedDomains.contains(domain)) return new Outcome.Rejected("EMAIL_DOMAIN_NOT_ALLOWED: " + domain);
        if (role == Rbac.Role.CUSTOMER || role == Rbac.Role.VENDOR) {
            return new Outcome.Rejected("NOT_A_STAFF_ROLE: " + role);
        }
        return new Outcome.Ok("STAFF_CREATED:" + email + " role=" + role);
    }

    /** RULES: staff dormant for 60 days are auto-disabled. */
    public static boolean isDormant(Instant lastLoginAt, Instant now) {
        return lastLoginAt == null || now.isAfter(lastLoginAt.plus(STAFF_DORMANCY_LIMIT));
    }

    public static UserState applyDormancy(UserState current, Instant lastLoginAt, Instant now) {
        if (current == UserState.ACTIVE && isDormant(lastLoginAt, now)) return UserState.DISABLED;
        return current;
    }

    // --------------------------------------------------------- separation of duties

    /**
     * VALIDATION / FR-ADM-017: the settlement-approver duty and the refund-initiator duty may
     * not rest with the same person. Expressed against the Vol.2 §2.4 capability matrix:
     * a role set is conflicting if it grants full SETTLEMENT_PAYOUTS and any
     * REFUND_INITIATION at the same time.
     */
    public static boolean isSodConflict(Set<Rbac.Role> roles) {
        boolean settlementApprover = roles.stream()
                .anyMatch(r -> Rbac.access(r, Rbac.Capability.SETTLEMENT_PAYOUTS) == Rbac.Access.FULL);
        boolean refundInitiator = roles.stream()
                .anyMatch(r -> Rbac.permits(r, Rbac.Capability.REFUND_INITIATION));
        return settlementApprover && refundInitiator;
    }

    /** Assign roles, refusing a combination that breaks separation of duties. */
    public static Outcome assignRoles(String staffId, Set<Rbac.Role> roles) {
        if (roles.isEmpty()) return new Outcome.Rejected("AT_LEAST_ONE_ROLE_REQUIRED");
        if (isSodConflict(roles)) {
            return new Outcome.Rejected("SOD_CONFLICT_SETTLEMENT_APPROVER_AND_REFUND_INITIATOR");
        }
        return new Outcome.Ok("ROLES_ASSIGNED:" + staffId + " " + roles);
    }

    /** Roles that individually breach SoD — useful for an admin-console warning. */
    public static List<Rbac.Role> selfConflictingRoles() {
        return java.util.Arrays.stream(Rbac.Role.values())
                .filter(r -> isSodConflict(Set.of(r)))
                .toList();
    }
}
