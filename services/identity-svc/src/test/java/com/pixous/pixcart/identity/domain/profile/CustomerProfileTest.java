package com.pixous.pixcart.identity.domain.profile;

import com.pixous.pixcart.identity.domain.auth.SessionRegistry;
import com.pixous.pixcart.identity.domain.profile.CustomerProfile.Channel;
import com.pixous.pixcart.identity.domain.profile.CustomerProfile.ChangeResult;
import com.pixous.pixcart.identity.domain.profile.CustomerProfile.ConfirmResult;
import com.pixous.pixcart.identity.domain.profile.CustomerProfile.Identifier;
import com.pixous.pixcart.identity.domain.profile.CustomerProfile.Result;
import com.pixous.pixcart.identity.domain.profile.CustomerProfile.SanitisedAvatar;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-CUS-004 profile management. Two areas get the most attention: the name charset, because a
 * letters-only rule silently rejects Tamil names on a Tamil Nadu platform; and the identifier
 * change, because proving possession of the wrong value proves nothing useful.
 */
class CustomerProfileTest {

    private static final Instant NOW = Instant.parse("2026-08-24T10:00:00Z");

    private static CustomerProfile profile() {
        return new CustomerProfile("CUS-1", "Harish C", "harish@example.com", "+919876543210");
    }

    /** A session with a live step-up grant for the given action. */
    private static SessionRegistry sessionsWithGrant(SessionRegistry.SensitiveAction action) {
        var s = new SessionRegistry();
        s.register("CUS-1", "S1", "dev-A", "Phone", "1.1.1.1", "TN", NOW);
        s.grantStepUp("G1", "S1", action, NOW);
        return s;
    }

    private static SanitisedAvatar avatar(long bytes, String type, boolean reEncoded, boolean exifStripped) {
        return new SanitisedAvatar("media://avatar/1", type, bytes, reEncoded, exifStripped);
    }

    // ============================================ name charset

    @Test
    void tamilNamesAreAccepted_becauseCombiningMarksAreAllowed() {
        // Tamil writes vowels as combining signs (category Mn), so a \p{L}-only rule rejects these
        for (String name : new String[]{
                "தமிழ்",                 // has the virama, a combining mark
                "ஹரிஷ்",
                "முருகன் செல்வம்",
                "கார்த்திகா",
        }) {
            assertTrue(CustomerProfile.isValidName(name), "must accept Tamil name: " + name);
        }
    }

    @Test
    void otherIndianScriptsAndLatinNamesAreAccepted() {
        for (String name : new String[]{
                "Harish C",
                "हरीश चंद्र",            // Devanagari, also uses combining marks
                "ಹರೀಶ್",                 // Kannada
                "O'Brien",
                "Jean-Luc",
                "A. R. Rahman",
        }) {
            assertTrue(CustomerProfile.isValidName(name), "must accept: " + name);
        }
    }

    @Test
    void aNameCannotBeDigitsSymbolsOrEmpty() {
        for (String bad : new String[]{
                "H4rish",                // digits
                "harish@example.com",    // an address, not a name
                "<script>x</script>",
                "  ",
                "",
                "A",                     // too short to be a display name
                null,
        }) {
            assertFalse(CustomerProfile.isValidName(bad), "must reject: " + bad);
        }
        assertFalse(CustomerProfile.isValidName("a".repeat(71)));
    }

    @Test
    void aRejectedNameIsNotStored() {
        var p = profile();
        var r = assertInstanceOf(Result.Rejected.class, p.updateName("H4rish", NOW));
        assertEquals("E-VAL-010", r.code());
        assertEquals("Harish C", p.name());
        assertTrue(p.changeHistory().isEmpty());

        assertInstanceOf(Result.Ok.class, p.updateName("  ஹரிஷ்  ", NOW));
        assertEquals("ஹரிஷ்", p.name(), "the stored name is trimmed");
        assertEquals(1, p.changeHistory().size());
    }

    // ============================================ language

    @Test
    void languageMustBeInTheSupportedSet() {
        var p = profile();
        assertInstanceOf(Result.Ok.class, p.updateLanguage("ta", NOW));
        assertEquals("ta", p.language());

        var bad = assertInstanceOf(Result.Rejected.class, p.updateLanguage("fr", NOW));
        assertEquals("E-VAL-011", bad.code());
        assertEquals("ta", p.language(), "the rejected language is not applied");
        assertInstanceOf(Result.Rejected.class, p.updateLanguage(null, NOW));
        assertEquals(11, CustomerProfile.SUPPORTED_LANGUAGES.size());
    }

    // ============================================ avatar

    @Test
    void onlyASanitisedAvatarMayBeSet() {
        var p = profile();
        // SECURITY: identity does not strip EXIF itself; it refuses anything that has not been
        // through the media pipeline
        var notReEncoded = assertInstanceOf(Result.Rejected.class,
                p.setAvatar(avatar(500_000, "image/jpeg", false, true), NOW));
        assertEquals("E-VAL-020", notReEncoded.code());
        assertEquals("AVATAR_NOT_RE_ENCODED_SERVER_SIDE", notReEncoded.reason());

        var exifIntact = assertInstanceOf(Result.Rejected.class,
                p.setAvatar(avatar(500_000, "image/jpeg", true, false), NOW));
        assertEquals("AVATAR_EXIF_NOT_STRIPPED", exifIntact.reason());
        assertTrue(p.avatar().isEmpty());

        assertInstanceOf(Result.Ok.class, p.setAvatar(avatar(500_000, "image/jpeg", true, true), NOW));
        assertTrue(p.avatar().isPresent());
    }

    @Test
    void avatarSizeAndTypeAreBounded() {
        var p = profile();
        var tooBig = assertInstanceOf(Result.Rejected.class,
                p.setAvatar(avatar(CustomerProfile.AVATAR_MAX_BYTES + 1, "image/png", true, true), NOW));
        assertEquals("AVATAR_EXCEEDS_2MB", tooBig.reason());

        var badType = assertInstanceOf(Result.Rejected.class,
                p.setAvatar(avatar(1_000, "image/gif", true, true), NOW));
        assertTrue(badType.reason().startsWith("AVATAR_TYPE_NOT_ALLOWED"));

        assertInstanceOf(Result.Rejected.class, p.setAvatar(avatar(0, "image/png", true, true), NOW));
        assertInstanceOf(Result.Rejected.class, p.setAvatar(null, NOW));
        assertInstanceOf(Result.Ok.class,
                p.setAvatar(avatar(CustomerProfile.AVATAR_MAX_BYTES, "image/webp", true, true), NOW));
    }

    // ============================================ identifier change

    @Test
    void anIdentifierChangeRequiresStepUpMfa() {
        var p = profile();
        var noGrant = new SessionRegistry();
        noGrant.register("CUS-1", "S1", "dev-A", "Phone", "1.1.1.1", "TN", NOW);

        var refused = assertInstanceOf(ChangeResult.Rejected.class, p.requestIdentifierChange(
                Identifier.MOBILE, "+919000000001", noGrant, "NO-GRANT", "S1", "CH-1", NOW));
        assertEquals("E-AUTH-012", refused.code());
        assertTrue(p.pendingChange().isEmpty());
    }

    @Test
    void aGrantForADifferentActionDoesNotAuthoriseTheChange() {
        var p = profile();
        // a payout-account grant must not unlock a mobile change
        var wrong = sessionsWithGrant(SessionRegistry.SensitiveAction.PAYOUT_ACCOUNT_EDIT);
        assertInstanceOf(ChangeResult.Rejected.class, p.requestIdentifierChange(
                Identifier.MOBILE, "+919000000001", wrong, "G1", "S1", "CH-1", NOW));
    }

    @Test
    void thePossessionChallengeTargetsTheNEWIdentifier() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        var r = assertInstanceOf(ChangeResult.PendingVerification.class, p.requestIdentifierChange(
                Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW));

        // sending the OTP to the number already on file would prove only that the owner is
        // present, which step-up already established
        assertEquals("+919000000001", r.pending().newValue());
        assertEquals("+919876543210", r.pending().oldValue());
        assertEquals("+919000000001", p.challengeTarget().orElseThrow());
        // and nothing has changed yet
        assertEquals("+919876543210", p.mobile());
    }

    @Test
    void identifierValidationRejectsMalformedAndUnchangedValues() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        assertInstanceOf(ChangeResult.Rejected.class,
                p.requestIdentifierChange(Identifier.MOBILE, "12345", s, "G1", "S1", "CH-1", NOW));
        assertInstanceOf(ChangeResult.Rejected.class,
                p.requestIdentifierChange(Identifier.MOBILE, "  ", s, "G1", "S1", "CH-1", NOW));
        var same = assertInstanceOf(ChangeResult.Rejected.class,
                p.requestIdentifierChange(Identifier.MOBILE, "+919876543210", s, "G1", "S1", "CH-1", NOW));
        assertEquals("NEW_IDENTIFIER_SAME_AS_CURRENT", same.reason());

        var emailSessions = sessionsWithGrant(SessionRegistry.SensitiveAction.PASSWORD_CHANGE);
        assertInstanceOf(ChangeResult.Rejected.class, p.requestIdentifierChange(
                Identifier.EMAIL, "not-an-email", emailSessions, "G1", "S1", "CH-1", NOW));
    }

    @Test
    void onlyOneIdentifierChangeMayBePendingAtOnce() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        p.requestIdentifierChange(Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW);
        var second = assertInstanceOf(ChangeResult.Rejected.class, p.requestIdentifierChange(
                Identifier.MOBILE, "+919000000002", s, "G1", "S1", "CH-2", NOW));
        assertEquals("E-CONFLICT-001", second.code());

        assertInstanceOf(Result.Ok.class, p.cancelPendingChange(NOW));
        assertInstanceOf(ChangeResult.PendingVerification.class, p.requestIdentifierChange(
                Identifier.MOBILE, "+919000000002", s, "G1", "S1", "CH-2", NOW));
    }

    // ============================================ confirmation & rollback

    @Test
    void aFailedVerificationRollsBackAtomicallyAndLeavesNothingHalfApplied() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        p.requestIdentifierChange(Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW);

        var first = assertInstanceOf(ConfirmResult.RolledBack.class,
                p.confirmIdentifierChange("CH-1", false, NOW.plusSeconds(30)));
        assertEquals(2, first.attemptsRemaining());
        // the profile is untouched
        assertEquals("+919876543210", p.mobile());
        assertTrue(p.undoableChange().isEmpty());
        // and the change is still pending, so a legitimate retry is possible
        assertTrue(p.pendingChange().isPresent());
    }

    @Test
    void repeatedFailureDiscardsTheWholeChangeRatherThanRetainingPartOfIt() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        p.requestIdentifierChange(Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW);

        for (int i = 0; i < CustomerProfile.MAX_VERIFICATION_ATTEMPTS - 1; i++) {
            p.confirmIdentifierChange("CH-1", false, NOW.plusSeconds(30L * i));
        }
        var last = assertInstanceOf(ConfirmResult.RolledBack.class,
                p.confirmIdentifierChange("CH-1", false, NOW.plusSeconds(300)));
        assertEquals(0, last.attemptsRemaining());
        assertEquals("VERIFICATION_FAILED_CHANGE_DISCARDED", last.reason());
        assertTrue(p.pendingChange().isEmpty());
        assertEquals("+919876543210", p.mobile());
    }

    @Test
    void aMismatchedChallengeIdIsRefusedWithoutConsumingAnAttempt() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        p.requestIdentifierChange(Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW);
        assertInstanceOf(ConfirmResult.Rejected.class, p.confirmIdentifierChange("CH-WRONG", true, NOW));
        assertEquals(0, p.pendingChange().orElseThrow().attemptsUsed());
        assertInstanceOf(ConfirmResult.Rejected.class,
                new CustomerProfile("C", "N N", "a@b.com", "+911111111111")
                        .confirmIdentifierChange("CH-1", true, NOW));
    }

    @Test
    void aSuccessfulChangeNotifiesBOTHTheOldAndTheNewIdentifier() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        p.requestIdentifierChange(Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW);

        var committed = assertInstanceOf(ConfirmResult.Committed.class,
                p.confirmIdentifierChange("CH-1", true, NOW.plusSeconds(60)));

        assertEquals("+919000000001", p.mobile());
        assertEquals(2, committed.notifications().size());
        // a customer whose account was taken over learns of it at the address the attacker no
        // longer controls
        var toOld = committed.notifications().stream()
                .filter(n -> n.value().equals("+919876543210")).findFirst().orElseThrow();
        assertTrue(toOld.reason().contains("undo within 72 hours"));
        assertTrue(committed.notifications().stream().anyMatch(n -> n.value().equals("+919000000001")));
    }

    // ============================================ undo window

    @Test
    void theOldIdentifierStaysReachableForSeventyTwoHours() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        p.requestIdentifierChange(Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW);
        var committed = assertInstanceOf(ConfirmResult.Committed.class,
                p.confirmIdentifierChange("CH-1", true, NOW));

        assertEquals(NOW.plus(Duration.ofHours(72)), committed.undoable().undoableUntil());
        assertTrue(p.isOldIdentifierReachable(NOW.plus(Duration.ofHours(71))));
        assertFalse(p.isOldIdentifierReachable(NOW.plus(Duration.ofHours(73))));
        assertEquals(Duration.ofHours(72), CustomerProfile.UNDO_WINDOW);
    }

    @Test
    void anUndoRestoresThePreviousIdentifierInsideTheWindow() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        p.requestIdentifierChange(Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW);
        p.confirmIdentifierChange("CH-1", true, NOW);
        assertEquals("+919000000001", p.mobile());

        assertInstanceOf(Result.Ok.class, p.undoIdentifierChange(NOW.plus(Duration.ofHours(10))));
        assertEquals("+919876543210", p.mobile());
        assertTrue(p.undoableChange().isEmpty());
        assertTrue(p.changeHistory().stream()
                .anyMatch(e -> e.field().equals("IDENTIFIER_CHANGE_UNDONE")));
    }

    @Test
    void anUndoAfterTheWindowIsRefusedAndTheChangeStands() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.MOBILE_CHANGE);
        p.requestIdentifierChange(Identifier.MOBILE, "+919000000001", s, "G1", "S1", "CH-1", NOW);
        p.confirmIdentifierChange("CH-1", true, NOW);

        var late = assertInstanceOf(Result.Rejected.class,
                p.undoIdentifierChange(NOW.plus(Duration.ofHours(73))));
        assertEquals("E-STATE-004", late.code());
        assertEquals("+919000000001", p.mobile());
        assertInstanceOf(Result.Rejected.class, profile().undoIdentifierChange(NOW));
    }

    @Test
    void anEmailChangeFollowsTheSamePathWithItsOwnStepUpAction() {
        var p = profile();
        var s = sessionsWithGrant(SessionRegistry.SensitiveAction.PASSWORD_CHANGE);
        var r = assertInstanceOf(ChangeResult.PendingVerification.class, p.requestIdentifierChange(
                Identifier.EMAIL, "new@example.com", s, "G1", "S1", "CH-E", NOW));
        assertEquals("new@example.com", r.pending().newValue());

        var committed = assertInstanceOf(ConfirmResult.Committed.class,
                p.confirmIdentifierChange("CH-E", true, NOW.plusSeconds(30)));
        assertEquals("new@example.com", p.email());
        assertEquals(Identifier.EMAIL, committed.undoable().identifier());
    }

    // ============================================ preferences

    @Test
    void preferenceChangesTakeEffectWithinTwentyFourHoursRatherThanInstantly() {
        var p = profile();
        assertTrue(p.prefersChannel(Channel.PUSH, NOW));

        assertInstanceOf(Result.Ok.class, p.setPreferences(Map.of(Channel.PUSH, false), NOW));
        // staged rather than flipped: downstream channels cache consent, and an instant flip here
        // would be a claim this service cannot honour
        assertTrue(p.prefersChannel(Channel.PUSH, NOW.plus(Duration.ofHours(23))));
        assertFalse(p.prefersChannel(Channel.PUSH, NOW.plus(Duration.ofHours(24))));
        assertEquals(NOW.plus(Duration.ofHours(24)), p.preferencesEffectiveFrom().orElseThrow());
    }

    @Test
    void anUnstagedChannelKeepsItsCurrentPreference() {
        var p = profile();
        p.setPreferences(Map.of(Channel.PUSH, false), NOW);
        assertTrue(p.prefersChannel(Channel.EMAIL, NOW.plus(Duration.ofHours(48))));
        assertFalse(p.prefersChannel(Channel.PUSH, NOW.plus(Duration.ofHours(48))));
    }

    @Test
    void emptyPreferencesAreRefused() {
        var p = profile();
        assertInstanceOf(Result.Rejected.class, p.setPreferences(Map.of(), NOW));
        assertInstanceOf(Result.Rejected.class, p.setPreferences(null, NOW));
        assertTrue(p.preferencesEffectiveFrom().isEmpty());
    }

    // ============================================ change history

    @Test
    void everyAppliedChangeIsRecordedWithAnActorAndNothingElseIs() {
        var p = profile();
        p.updateName("H4rish", NOW);                                    // refused
        p.updateName("ஹரிஷ்", NOW.plusSeconds(10));                     // applied
        p.updateLanguage("ta", NOW.plusSeconds(20));                    // applied
        p.updateLanguage("fr", NOW.plusSeconds(30));                    // refused

        var history = p.changeHistory();
        assertEquals(2, history.size());
        assertEquals("NAME", history.get(0).field());
        assertEquals("LANGUAGE", history.get(1).field());
        assertTrue(history.stream().allMatch(e -> e.actorId().equals("CUS-1")));
    }
}
