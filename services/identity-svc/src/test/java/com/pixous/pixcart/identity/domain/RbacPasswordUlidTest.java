package com.pixous.pixcart.identity.domain;

import com.pixous.pixcart.identity.domain.rbac.Rbac;
import com.pixous.pixcart.identity.domain.rbac.Rbac.Access;
import com.pixous.pixcart.identity.domain.rbac.Rbac.Capability;
import com.pixous.pixcart.identity.domain.rbac.Rbac.PasswordPolicy;
import com.pixous.pixcart.identity.domain.rbac.Rbac.Role;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/** Vol.2 §2.4 matrix spot-checks, FR-CUS-001 password rule, ULID guarantees. */
class RbacPasswordUlidTest {

    @Test
    void matrixMatchesDocumentedCells() {
        // System settings & API keys: Super Admin only — the sharpest row in §2.4
        assertEquals(Access.FULL, Rbac.access(Role.SUPER_ADMIN, Capability.SYSTEM_SETTINGS_API_KEYS));
        for (Role r : Role.values()) {
            if (r != Role.SUPER_ADMIN) {
                assertEquals(Access.NONE, Rbac.access(r, Capability.SYSTEM_SETTINGS_API_KEYS), r.name());
            }
        }
        assertEquals(Access.FULL,   Rbac.access(Role.FINANCE, Capability.SETTLEMENT_PAYOUTS));
        assertEquals(Access.READ,   Rbac.access(Role.VENDOR, Capability.SETTLEMENT_PAYOUTS));   // R(own)
        assertEquals(Access.SCOPED, Rbac.access(Role.VENDOR, Capability.REFUND_INITIATION));    // S(own)
        assertEquals(Access.SCOPED, Rbac.access(Role.SUPPORT, Capability.REFUND_INITIATION));   // S(policy)
        assertEquals(Access.NONE,   Rbac.access(Role.SUPPORT, Capability.AUDIT_LOG_VIEW));
        assertEquals(Access.SCOPED, Rbac.access(Role.ADMIN, Capability.USER_ADMINISTRATION));
        assertEquals(Access.FULL,   Rbac.access(Role.SUPER_ADMIN, Capability.USER_ADMINISTRATION));
        assertEquals(Access.SCOPED, Rbac.access(Role.DELIVERY, Capability.ORDER_MANAGEMENT));
        assertEquals(Access.NONE,   Rbac.access(Role.MARKETING, Capability.REFUND_INITIATION));
        assertEquals(Access.FULL,   Rbac.access(Role.MARKETING, Capability.PROMOTIONS_COUPONS));
        assertEquals(Access.SCOPED, Rbac.access(Role.WAREHOUSE, Capability.INVENTORY_UPDATE));
        assertEquals(Access.READ,   Rbac.access(Role.ADMIN, Capability.AUDIT_LOG_VIEW));
    }

    @Test
    void customerRowMatchesDocument() {
        assertEquals(Access.FULL,   Rbac.access(Role.CUSTOMER, Capability.BROWSE_AND_PURCHASE));
        assertEquals(Access.SCOPED, Rbac.access(Role.CUSTOMER, Capability.ORDER_MANAGEMENT));
        assertEquals(Access.NONE,   Rbac.access(Role.CUSTOMER, Capability.PRODUCT_CRUD));
        assertEquals(Access.NONE,   Rbac.access(Role.CUSTOMER, Capability.AI_DASHBOARDS));
    }

    @Test
    void superAdminIsDeniedNothing() {
        for (Capability c : Capability.values()) {
            assertNotEquals(Access.NONE, Rbac.access(Role.SUPER_ADMIN, c), c.name());
        }
    }

    @Test
    void everyRoleManagesItsOwnProfile() {
        for (Role r : Role.values()) {
            assertEquals(Access.FULL, Rbac.access(r, Capability.OWN_PROFILE_ADDRESSES), r.name());
        }
    }

    @Test
    void passwordRuleTenCharsThreeOfFourClasses() {
        assertTrue(PasswordPolicy.isAcceptable("Abcdefghi1".toCharArray()));          // 10, 3 classes
        assertTrue(PasswordPolicy.isAcceptable("correct-horse-9".toCharArray()));     // lower+digit+symbol

        assertEquals(java.util.List.of(PasswordPolicy.Violation.TOO_SHORT),
                PasswordPolicy.validate("Abcdefg1!".toCharArray()));                  // 9 chars
        assertEquals(java.util.List.of(PasswordPolicy.Violation.INSUFFICIENT_CLASSES),
                PasswordPolicy.validate("abcdefghijk".toCharArray()));                // 1 class
        assertEquals(java.util.List.of(PasswordPolicy.Violation.INSUFFICIENT_CLASSES),
                PasswordPolicy.validate("abcdefghij9".toCharArray()));                // 2 classes
    }

    @Test
    void ulidFormatAndMonotonicity() {
        String a = Ulid.next();
        assertTrue(Ulid.isValid(a));
        assertEquals(26, a.length());

        assertFalse(Ulid.isValid("01ILOU0000000000000000000O"));  // I,L,O,U outside alphabet
        assertFalse(Ulid.isValid("short"));
        assertFalse(Ulid.isValid(null));

        // monotonic within one millisecond: mint order == sort order
        long t = 1_784_800_000_000L;
        String prev = Ulid.next(t);
        for (int i = 0; i < 1_000; i++) {
            String cur = Ulid.next(t);
            assertTrue(cur.compareTo(prev) > 0, "burst mint must stay ordered");
            prev = cur;
        }
        // and strictly ordered across milliseconds
        assertTrue(Ulid.next(t + 1).compareTo(prev) > 0);
    }
}
