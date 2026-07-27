package com.pixous.pixcart.identity.domain.rbac;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Role-based access control — the product-level contract.
 *
 * Normative source — Vol. 2 §2.4 "User Roles & Permissions Matrix":
 * nine roles × fifteen capabilities, legend F = full, R = read-only,
 * S = scoped to own records, – = none. The static rows below are the document's
 * table transcribed cell-for-cell in the same row/column order, so review against
 * §2.4 is line-by-line. The endpoint-level refinement is Vol. 10 §10.1; the
 * S(own)/S(policy) annotations on Refund and R(own) on Settlement are enforced by
 * the owning service with the caller's scope claim — both map to SCOPED/READ here.
 */
public final class Rbac {

    /** Column order of §2.4: Cust, Vendor, Admin, SupAdm, Fin, Mktg, WH, Deliv, Supp. */
    public enum Role { CUSTOMER, VENDOR, ADMIN, SUPER_ADMIN, FINANCE, MARKETING, WAREHOUSE, DELIVERY, SUPPORT }

    /** Row order of §2.4. */
    public enum Capability {
        BROWSE_AND_PURCHASE,
        OWN_PROFILE_ADDRESSES,
        PRODUCT_CRUD,
        PRODUCT_APPROVAL,
        INVENTORY_UPDATE,
        ORDER_MANAGEMENT,
        REFUND_INITIATION,
        PROMOTIONS_COUPONS,
        SETTLEMENT_PAYOUTS,
        REPORTS_ANALYTICS,
        CMS_BANNERS,
        USER_ADMINISTRATION,
        SYSTEM_SETTINGS_API_KEYS,
        AUDIT_LOG_VIEW,
        AI_DASHBOARDS
    }

    public enum Access { FULL, READ, SCOPED, NONE }

    private static final Access F = Access.FULL, R = Access.READ, S = Access.SCOPED, N = Access.NONE;
    private static final Map<Capability, Access[]> MATRIX = new EnumMap<>(Capability.class);

    private static void row(Capability c, Access... a) {
        if (a.length != Role.values().length) throw new IllegalStateException("matrix row " + c);
        MATRIX.put(c, a);
    }

    static { //                                Cust Vendor Admin SupAdm Fin Mktg WH  Deliv Supp
        row(Capability.BROWSE_AND_PURCHASE,      F,   S,    R,    R,    N,  N,   N,  N,    R);
        row(Capability.OWN_PROFILE_ADDRESSES,    F,   F,    F,    F,    F,  F,   F,  F,    F);
        row(Capability.PRODUCT_CRUD,             N,   S,    F,    F,    N,  N,   N,  N,    N);
        row(Capability.PRODUCT_APPROVAL,         N,   N,    F,    F,    N,  N,   N,  N,    N);
        row(Capability.INVENTORY_UPDATE,         N,   S,    F,    F,    N,  N,   S,  N,    N);
        row(Capability.ORDER_MANAGEMENT,         S,   S,    F,    F,    R,  R,   S,  S,    S);
        row(Capability.REFUND_INITIATION,        S,   S,    F,    F,    F,  N,   N,  N,    S);
        row(Capability.PROMOTIONS_COUPONS,       N,   S,    F,    F,    N,  F,   N,  N,    N);
        row(Capability.SETTLEMENT_PAYOUTS,       N,   R,    R,    F,    F,  N,   N,  N,    N);
        row(Capability.REPORTS_ANALYTICS,        N,   S,    F,    F,    F,  S,   S,  S,    S);
        row(Capability.CMS_BANNERS,              N,   N,    F,    F,    N,  S,   N,  N,    N);
        row(Capability.USER_ADMINISTRATION,      N,   N,    S,    F,    N,  N,   N,  N,    N);
        row(Capability.SYSTEM_SETTINGS_API_KEYS, N,   N,    N,    F,    N,  N,   N,  N,    N);
        row(Capability.AUDIT_LOG_VIEW,           N,   N,    R,    F,    R,  N,   N,  N,    N);
        row(Capability.AI_DASHBOARDS,            N,   S,    F,    F,    R,  S,   N,  N,    R);
    }

    private Rbac() {
    }

    public static Access access(Role role, Capability capability) {
        return MATRIX.get(capability)[role.ordinal()];
    }

    /** Any access at all (FULL, READ or SCOPED). Write-vs-read is the caller's check. */
    public static boolean permits(Role role, Capability capability) {
        return access(role, capability) != Access.NONE;
    }

    /** SCOPED cells: the owning service must also match the caller's scope claim. */
    public static boolean isScoped(Role role, Capability capability) {
        return access(role, capability) == Access.SCOPED;
    }

    /**
     * Password acceptance rule.
     * Normative source — FR-CUS-001 validation: "password ≥ 10 chars with 3 of 4 classes".
     * Storage (Argon2id m=64MiB, t=3, p=2, per-user salt) and the breach-corpus check
     * are adapter concerns per Vol. 10 §10.3 and are verified by TC-SEC-001.
     */
    public static final class PasswordPolicy {
        public static final int MIN_LENGTH = 10;
        public static final int MAX_LENGTH = 128;   // ASVS upper bound; prevents DoS hashes
        public static final int REQUIRED_CLASSES = 3;

        public enum Violation { TOO_SHORT, TOO_LONG, INSUFFICIENT_CLASSES }

        private PasswordPolicy() {
        }

        public static List<Violation> validate(char[] password) {
            var out = new java.util.ArrayList<Violation>(2);
            if (password.length < MIN_LENGTH) out.add(Violation.TOO_SHORT);
            if (password.length > MAX_LENGTH) out.add(Violation.TOO_LONG);
            boolean lower = false, upper = false, digit = false, other = false;
            for (char c : password) {
                if (Character.isLowerCase(c)) lower = true;
                else if (Character.isUpperCase(c)) upper = true;
                else if (Character.isDigit(c)) digit = true;
                else other = true;
            }
            int classes = (lower ? 1 : 0) + (upper ? 1 : 0) + (digit ? 1 : 0) + (other ? 1 : 0);
            if (classes < REQUIRED_CLASSES) out.add(Violation.INSUFFICIENT_CLASSES);
            return out;
        }

        public static boolean isAcceptable(char[] password) {
            return validate(password).isEmpty();
        }
    }
}
