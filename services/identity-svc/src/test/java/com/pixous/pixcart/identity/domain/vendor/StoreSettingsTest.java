package com.pixous.pixcart.identity.domain.vendor;

import com.pixous.pixcart.identity.domain.auth.SessionRegistry;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.CreateResult;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.MediaAsset;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.MediaKind;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.Outcome;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.Permission;
import com.pixous.pixcart.identity.domain.vendor.StoreSettings.StaffRole;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-VEN-002 store creation & settings. Two cross-slice checks are done for real rather than
 * mocked: only an ACTIVE vendor per the Slice-25 lifecycle may create a store, and a payout-setting
 * edit is verified against the Slice-33 SessionRegistry's step-up grant.
 */
class StoreSettingsTest {

    private static final Instant NOW = Instant.parse("2026-08-20T10:00:00Z");
    private static final LocalDate TODAY = LocalDate.of(2026, 8, 20);

    private static VendorLifecycle activeVendor() {
        var v = new VendorLifecycle("01VEND0001");
        v.approve("01ADM1", false, true, null, false, NOW);
        return v;
    }

    private static StoreSettings store() {
        var r = StoreSettings.create(activeVendor(), "Kanchi Weaves", Set.of());
        if (r instanceof CreateResult.Rejected rej) throw new AssertionError(rej.violations().toString());
        return ((CreateResult.Ok) r).store();
    }

    // ============================================ approved vendors only

    @Test
    void onlyAnActiveVendorMayCreateAStore() {
        // CROSS-SLICE: the Slice-25 lifecycle is the authority on "approved"
        var pending = new VendorLifecycle("01VEND0002");
        var rejected = assertInstanceOf(CreateResult.Rejected.class,
                StoreSettings.create(pending, "Pending Store", Set.of()));
        assertTrue(rejected.violations().get(0).startsWith("VENDOR_NOT_APPROVED"));

        var suspended = activeVendor();
        suspended.suspend("01ADM1", "counterfeit complaints", NOW);
        assertInstanceOf(CreateResult.Rejected.class,
                StoreSettings.create(suspended, "Suspended Store", Set.of()));

        assertInstanceOf(CreateResult.Ok.class, StoreSettings.create(activeVendor(), "Kanchi Weaves", Set.of()));
    }

    @Test
    void theStoreExposesItsPublicUrl() {
        assertEquals("/store/kanchi-weaves", store().publicUrl());
        assertEquals("01VEND0001", store().vendorId());
    }

    // ============================================ slug

    @Test
    void slugsAreDerivedFromTheStoreName() {
        assertEquals("kanchi-weaves", StoreSettings.slugify("Kanchi Weaves"));
        assertEquals("kanchi-weaves", StoreSettings.slugify("  Kanchi   Weaves!  "));
        assertEquals("chettinad-silks-2026", StoreSettings.slugify("Chettinad Silks 2026"));
        assertEquals("", StoreSettings.slugify("!!!"));
    }

    @Test
    void storeNameLengthIsBounded() {
        var short_ = StoreSettings.resolveSlug("ab", Set.of());
        assertFalse(short_.available());
        assertTrue(short_.violations().contains("STORE_NAME_TOO_SHORT_MIN_3"));

        var long_ = StoreSettings.resolveSlug("a".repeat(41), Set.of());
        assertFalse(long_.available());
        assertTrue(long_.violations().contains("STORE_NAME_TOO_LONG_MAX_40"));

        assertTrue(StoreSettings.resolveSlug("abc", Set.of()).available());
        assertTrue(StoreSettings.resolveSlug("a".repeat(40), Set.of()).available());
    }

    @Test
    void reservedSlugsAreRefusedWithSuggestions() {
        var r = StoreSettings.resolveSlug("Official", Set.of());
        assertFalse(r.available());
        assertTrue(r.violations().get(0).startsWith("SLUG_IS_RESERVED"));
        assertFalse(r.suggestions().isEmpty(), "a reserved slug must offer alternatives");
        // and every suggestion is itself neither reserved nor taken
        for (String s : r.suggestions()) {
            assertFalse(StoreSettings.RESERVED_SLUGS.contains(s), s);
        }
    }

    @Test
    void aSlugClashYieldsUsableSuggestions() {
        var r = StoreSettings.resolveSlug("Kanchi Weaves", Set.of("kanchi-weaves", "kanchi-weaves-store"));
        assertFalse(r.available());
        assertTrue(r.violations().get(0).startsWith("SLUG_ALREADY_TAKEN"));
        assertEquals(3, r.suggestions().size());
        assertFalse(r.suggestions().contains("kanchi-weaves"), "a taken slug is never suggested");
        assertFalse(r.suggestions().contains("kanchi-weaves-store"));
    }

    @Test
    void profanityInAStoreNameIsRefused() {
        var r = StoreSettings.resolveSlug("Bloody Good Sarees", Set.of());
        assertFalse(r.available());
        assertTrue(r.violations().stream().anyMatch(v -> v.startsWith("PROFANITY_IN_STORE_NAME")));
    }

    @Test
    void aNameWithNoUsableCharactersIsRefused() {
        var r = StoreSettings.resolveSlug("!!!!", Set.of());
        assertFalse(r.available());
        assertTrue(r.violations().contains("STORE_NAME_YIELDS_EMPTY_SLUG"));
    }

    // ============================================ media

    @Test
    void logoSizeTypeAndShapeAreEnforced() {
        assertInstanceOf(Outcome.Ok.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.LOGO, 500_000, 400, 400, "image/png")));

        var tooBig = assertInstanceOf(Outcome.Rejected.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.LOGO, StoreSettings.LOGO_MAX_BYTES + 1, 400, 400, "image/png")));
        assertTrue(tooBig.violations().contains("LOGO_EXCEEDS_1MB"));

        var notSquare = assertInstanceOf(Outcome.Rejected.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.LOGO, 500_000, 400, 300, "image/png")));
        assertTrue(notSquare.violations().contains("LOGO_MUST_BE_SQUARE"));

        var tooSmall = assertInstanceOf(Outcome.Rejected.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.LOGO, 500_000, 100, 100, "image/png")));
        assertTrue(tooSmall.violations().contains("LOGO_MIN_200x200"));

        var badType = assertInstanceOf(Outcome.Rejected.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.LOGO, 500_000, 400, 400, "image/gif")));
        assertTrue(badType.violations().stream().anyMatch(v -> v.startsWith("MEDIA_TYPE_NOT_ALLOWED")));
    }

    @Test
    void bannerHasItsOwnLargerCeilingAndAspect() {
        assertInstanceOf(Outcome.Ok.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.BANNER, 2_500_000, 1600, 400, "image/jpeg")));
        // 2.5 MB is fine for a banner but would have failed as a logo
        assertInstanceOf(Outcome.Rejected.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.LOGO, 2_500_000, 400, 400, "image/jpeg")));

        var tooBig = assertInstanceOf(Outcome.Rejected.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.BANNER, StoreSettings.BANNER_MAX_BYTES + 1, 1600, 400, "image/jpeg")));
        assertTrue(tooBig.violations().contains("BANNER_EXCEEDS_3MB"));

        var tooNarrow = assertInstanceOf(Outcome.Rejected.class, StoreSettings.validateMedia(
                new MediaAsset(MediaKind.BANNER, 500_000, 800, 400, "image/jpeg")));
        assertTrue(tooNarrow.violations().contains("BANNER_MIN_1200x300"));
    }

    @Test
    void mediaProcessingFailureShowsAPlaceholderAndPermitsRetry() {
        var s = store();
        assertTrue(s.showsLogoPlaceholder(), "no logo yet");
        assertInstanceOf(Outcome.Ok.class, s.setMedia(
                new MediaAsset(MediaKind.LOGO, 500_000, 400, 400, "image/png"), "01OWNER", NOW));
        assertFalse(s.showsLogoPlaceholder());
        assertFalse(s.logoRetryAvailable());

        s.recordLogoProcessingFailure();
        assertTrue(s.showsLogoPlaceholder());
        assertTrue(s.logoRetryAvailable());

        // a successful retry clears both
        s.setMedia(new MediaAsset(MediaKind.LOGO, 400_000, 400, 400, "image/webp"), "01OWNER", NOW);
        assertFalse(s.showsLogoPlaceholder());
        assertFalse(s.logoRetryAvailable());
    }

    // ============================================ policies

    @Test
    void dispatchSlaIsBoundedToOneToSevenDays() {
        var s = store();
        assertInstanceOf(Outcome.Rejected.class, s.setDispatchSlaDays(0, "01OWNER", NOW));
        assertInstanceOf(Outcome.Rejected.class, s.setDispatchSlaDays(8, "01OWNER", NOW));
        assertInstanceOf(Outcome.Ok.class, s.setDispatchSlaDays(1, "01OWNER", NOW));
        assertInstanceOf(Outcome.Ok.class, s.setDispatchSlaDays(7, "01OWNER", NOW));
        assertEquals(7, s.dispatchSlaDays());
    }

    @Test
    void publicTextIsProfanityFiltered() {
        var s = store();
        var bad = assertInstanceOf(Outcome.Rejected.class,
                s.setDescription("This damn fine saree", "01OWNER", NOW));
        assertTrue(bad.violations().get(0).startsWith("PROFANITY_IN_DESCRIPTION"));
        assertEquals("", s.description(), "the rejected text is not stored");

        assertInstanceOf(Outcome.Ok.class,
                s.setDescription("Handloom Kanchipuram silk sarees, woven in Tamil Nadu", "01OWNER", NOW));
        assertTrue(s.description().contains("Handloom"));

        assertInstanceOf(Outcome.Rejected.class, s.setReturnsExtras("no crap returns", "01OWNER", NOW));
        assertInstanceOf(Outcome.Ok.class, s.setReturnsExtras("14-day returns on unworn items", "01OWNER", NOW));
    }

    @Test
    void anOverlongDescriptionIsRefused() {
        var s = store();
        assertInstanceOf(Outcome.Rejected.class, s.setDescription("a".repeat(2_001), "01OWNER", NOW));
    }

    // ============================================ holiday mode

    @Test
    void holidayModeHidesBuyActionsButKeepsThePageIndexed() {
        var s = store();
        assertTrue(s.buyActionsEnabled());
        assertTrue(s.isIndexable());
        assertEquals("", s.storefrontNotice());

        assertInstanceOf(Outcome.Ok.class,
                s.enableHolidayMode(LocalDate.of(2026, 9, 5), TODAY, "01OWNER", NOW));

        assertFalse(s.buyActionsEnabled(), "Buy actions are hidden");
        assertTrue(s.isIndexable(), "but the page stays indexed — de-indexing would cost ranking");
        assertEquals("Back on 2026-09-05", s.storefrontNotice());
    }

    @Test
    void holidayModeRequiresAFutureReturnDate() {
        var s = store();
        assertInstanceOf(Outcome.Rejected.class, s.enableHolidayMode(null, TODAY, "01OWNER", NOW));
        assertInstanceOf(Outcome.Rejected.class, s.enableHolidayMode(TODAY, TODAY, "01OWNER", NOW));
        assertInstanceOf(Outcome.Rejected.class,
                s.enableHolidayMode(TODAY.minusDays(1), TODAY, "01OWNER", NOW));
        assertFalse(s.holidayMode());
    }

    @Test
    void disablingHolidayModeRestoresBuyActions() {
        var s = store();
        s.enableHolidayMode(LocalDate.of(2026, 9, 5), TODAY, "01OWNER", NOW);
        s.disableHolidayMode("01OWNER", NOW.plusSeconds(60));
        assertTrue(s.buyActionsEnabled());
        assertNull(s.backOnDate());
        assertEquals("", s.storefrontNotice());
    }

    // ============================================ staff role matrix

    @Test
    void noStaffRoleCanEditPayoutSettings() {
        // RULES: "Catalogue, Orders, Finance-view (no payout edit)". Finance-view is the role whose
        // name invites the assumption that it might, so every role is checked.
        for (StaffRole role : StaffRole.values()) {
            assertFalse(StoreSettings.roleGrants(role, Permission.PAYOUT_SETTINGS_EDIT),
                    role + " must not grant payout editing");
        }
    }

    @Test
    void eachStaffRoleGrantsOnlyItsOwnScope() {
        assertTrue(StoreSettings.roleGrants(StaffRole.CATALOGUE, Permission.CATALOGUE_MANAGE));
        assertFalse(StoreSettings.roleGrants(StaffRole.CATALOGUE, Permission.ORDERS_MANAGE));
        assertFalse(StoreSettings.roleGrants(StaffRole.CATALOGUE, Permission.FINANCE_READ));

        assertTrue(StoreSettings.roleGrants(StaffRole.ORDERS, Permission.ORDERS_MANAGE));
        assertFalse(StoreSettings.roleGrants(StaffRole.ORDERS, Permission.CATALOGUE_MANAGE));

        assertTrue(StoreSettings.roleGrants(StaffRole.FINANCE_VIEW, Permission.FINANCE_READ));
        assertFalse(StoreSettings.roleGrants(StaffRole.FINANCE_VIEW, Permission.ORDERS_MANAGE));

        assertFalse(StoreSettings.roleGrants(null, Permission.CATALOGUE_MANAGE));
    }

    @Test
    void anAcceptedStaffMemberGetsExactlyTheirRoleScope() {
        var s = store();
        s.inviteStaff("ops@kanchiweaves.com", StaffRole.ORDERS, Set.of(), "01OWNER", NOW);
        s.acceptInvite("ops@kanchiweaves.com", "01STAFF-1", NOW.plusSeconds(60));

        assertEquals(StaffRole.ORDERS, s.roleOf("01STAFF-1"));
        assertTrue(s.staffMay("01STAFF-1", Permission.ORDERS_MANAGE));
        assertFalse(s.staffMay("01STAFF-1", Permission.CATALOGUE_MANAGE));
        assertFalse(s.staffMay("01STAFF-1", Permission.PAYOUT_SETTINGS_EDIT));
        assertFalse(s.staffMay("01UNKNOWN", Permission.ORDERS_MANAGE));
    }

    // ============================================ invites

    @Test
    void invitesExpireAfterSeventyTwoHours() {
        var s = store();
        assertInstanceOf(Outcome.Ok.class,
                s.inviteStaff("ops@kanchiweaves.com", StaffRole.CATALOGUE, Set.of(), "01OWNER", NOW));
        var invite = s.invite("ops@kanchiweaves.com");
        assertEquals(NOW.plus(Duration.ofHours(72)), invite.expiresAt());

        assertInstanceOf(Outcome.Ok.class,
                s.acceptInvite("ops@kanchiweaves.com", "01STAFF-1", NOW.plus(Duration.ofHours(71))));

        var s2 = store();
        s2.inviteStaff("late@kanchiweaves.com", StaffRole.CATALOGUE, Set.of(), "01OWNER", NOW);
        var expired = assertInstanceOf(Outcome.Rejected.class,
                s2.acceptInvite("late@kanchiweaves.com", "01STAFF-2", NOW.plus(Duration.ofHours(73))));
        assertTrue(expired.violations().contains("INVITE_EXPIRED"));
    }

    @Test
    void aBouncedInviteCanBeResentWithAFreshExpiry() {
        var s = store();
        s.inviteStaff("ops@kanchiweaves.com", StaffRole.ORDERS, Set.of(), "01OWNER", NOW);
        s.recordInviteBounce("ops@kanchiweaves.com");
        assertTrue(s.invite("ops@kanchiweaves.com").bounced());

        Instant later = NOW.plus(Duration.ofHours(10));
        assertInstanceOf(Outcome.Ok.class, s.resendInvite("ops@kanchiweaves.com", "01OWNER", later));
        var resent = s.invite("ops@kanchiweaves.com");
        assertEquals(later.plus(Duration.ofHours(72)), resent.expiresAt());
        assertEquals(2, resent.sendAttempts());
        assertFalse(resent.bounced());
    }

    @Test
    void anAcceptedInviteCannotBeResentOrAcceptedTwice() {
        var s = store();
        s.inviteStaff("ops@kanchiweaves.com", StaffRole.ORDERS, Set.of(), "01OWNER", NOW);
        s.acceptInvite("ops@kanchiweaves.com", "01STAFF-1", NOW.plusSeconds(60));
        assertInstanceOf(Outcome.Rejected.class, s.resendInvite("ops@kanchiweaves.com", "01OWNER", NOW));
        assertInstanceOf(Outcome.Rejected.class,
                s.acceptInvite("ops@kanchiweaves.com", "01STAFF-2", NOW.plusSeconds(120)));
        assertInstanceOf(Outcome.Rejected.class, s.resendInvite("nobody@x.com", "01OWNER", NOW));
    }

    @Test
    void inviteValidationCoversEmailAndDomainAllowList() {
        var s = store();
        assertInstanceOf(Outcome.Rejected.class,
                s.inviteStaff("not-an-email", StaffRole.ORDERS, Set.of(), "01OWNER", NOW));
        var wrongDomain = assertInstanceOf(Outcome.Rejected.class,
                s.inviteStaff("ops@gmail.com", StaffRole.ORDERS, Set.of("kanchiweaves.com"), "01OWNER", NOW));
        assertTrue(wrongDomain.violations().stream().anyMatch(v -> v.startsWith("EMAIL_DOMAIN_NOT_ALLOWED")));
        assertInstanceOf(Outcome.Ok.class,
                s.inviteStaff("ops@kanchiweaves.com", StaffRole.ORDERS, Set.of("kanchiweaves.com"), "01OWNER", NOW));
    }

    // ============================================ payout settings + step-up

    @Test
    void payoutSettingsRequireTheOwnerAndASatisfiedStepUpGrant() {
        // CROSS-SLICE: the grant is verified against the real Slice-33 SessionRegistry
        var s = store();
        var sessions = new SessionRegistry();
        sessions.register("01OWNER", "S1", "dev-A", "Laptop", "1.1.1.1", "TN", NOW);
        sessions.grantStepUp("G1", "S1", SessionRegistry.SensitiveAction.PAYOUT_ACCOUNT_EDIT, NOW);

        assertTrue(s.mayEditPayoutSettings("01OWNER", true, sessions, "G1", "S1", NOW.plusSeconds(30)));

        // not the owner: refused even with a valid grant
        assertFalse(s.mayEditPayoutSettings("01SOMEONE", false, sessions, "G1", "S1", NOW.plusSeconds(30)));

        // owner without a grant: refused
        assertFalse(s.mayEditPayoutSettings("01OWNER", true, sessions, "NO-GRANT", "S1", NOW));

        // owner with an expired grant: refused
        assertFalse(s.mayEditPayoutSettings("01OWNER", true, sessions, "G1", "S1",
                NOW.plus(Duration.ofMinutes(11))));
    }

    @Test
    void aGrantForADifferentActionDoesNotUnlockPayoutSettings() {
        var s = store();
        var sessions = new SessionRegistry();
        sessions.register("01OWNER", "S1", "dev-A", "Laptop", "1.1.1.1", "TN", NOW);
        sessions.grantStepUp("G1", "S1", SessionRegistry.SensitiveAction.PASSWORD_CHANGE, NOW);
        assertFalse(s.mayEditPayoutSettings("01OWNER", true, sessions, "G1", "S1", NOW.plusSeconds(30)),
                "a password-change grant must not authorise a payout edit");
    }

    @Test
    void aStaffAccountIsNeverTreatedAsTheOwnerEvenIfClaimedSo() {
        var s = store();
        s.inviteStaff("fin@kanchiweaves.com", StaffRole.FINANCE_VIEW, Set.of(), "01OWNER", NOW);
        s.acceptInvite("fin@kanchiweaves.com", "01STAFF-FIN", NOW.plusSeconds(60));

        var sessions = new SessionRegistry();
        sessions.register("01STAFF-FIN", "S9", "dev-B", "Phone", "2.2.2.2", "TN", NOW);
        sessions.grantStepUp("G9", "S9", SessionRegistry.SensitiveAction.PAYOUT_ACCOUNT_EDIT, NOW);

        // even with isOwner erroneously passed true and a valid grant, a staff account is refused
        assertFalse(s.mayEditPayoutSettings("01STAFF-FIN", true, sessions, "G9", "S9", NOW.plusSeconds(30)));
    }

    // ============================================ audit attribution

    @Test
    void staffActionsAreAttributedIndividually() {
        var s = store();
        s.setDispatchSlaDays(3, "01OWNER", NOW);
        s.inviteStaff("ops@kanchiweaves.com", StaffRole.ORDERS, Set.of(), "01OWNER", NOW.plusSeconds(10));
        s.acceptInvite("ops@kanchiweaves.com", "01STAFF-1", NOW.plusSeconds(20));
        s.setDescription("Handloom sarees", "01STAFF-1", NOW.plusSeconds(30));

        var trail = s.auditTrail();
        assertEquals(4, trail.size());
        assertEquals("01OWNER", trail.get(0).actorUserId());
        assertEquals("SET_DISPATCH_SLA", trail.get(0).action());
        assertEquals("01STAFF-1", trail.get(2).actorUserId());
        assertEquals("ACCEPT_INVITE", trail.get(2).action());
        assertEquals("01STAFF-1", trail.get(3).actorUserId());
        assertEquals("SET_DESCRIPTION", trail.get(3).action());
        // every entry names an actor — none is anonymous
        assertTrue(trail.stream().allMatch(e -> e.actorUserId() != null && !e.actorUserId().isBlank()));
    }

    @Test
    void aRejectedChangeIsNotAudited() {
        var s = store();
        s.setDispatchSlaDays(99, "01OWNER", NOW);
        assertTrue(s.auditTrail().isEmpty(), "a refused change left no trail because nothing changed");
    }
}
