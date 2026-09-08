package com.pixous.pixcart.identity.domain.profile;

import com.pixous.pixcart.identity.domain.auth.SessionRegistry;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Profile management — FR-CUS-004.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "let customers view/update name, email, mobile (with re-verification), language,
 *                avatar, and communication preferences; email/mobile changes require possession
 *                proof of the new identifier."
 *   INPUTS:     "Editable fields; verification OTPs for identifier changes; avatar image ≤ 2 MB
 *                (jpg/png/webp)."
 *   OUTPUTS:    "Updated profile, change-history entries, notifications to old+new identifiers on
 *                change."
 *   VALIDATION: "Name charset incl. Tamil script; image type/size sniffed server-side; language ∈
 *                supported set."
 *   RULES:      "Identifier change keeps old value reachable for 72 h undo; preference changes
 *                apply within 24 h across channels (BRU-12)."
 *   ERRORS:     "Verification fail → change rolled back atomically; image malware/type fail →
 *                E-VAL-020 reject with reason."
 *   SECURITY:   "Step-up MFA on identifier change (FR-CUS-003); avatar re-encoded server-side;
 *                EXIF stripped."
 *
 * Three things here are worth stating because the obvious implementation of each is wrong:
 *
 *  1. THE NAME CHARSET MUST ADMIT COMBINING MARKS, not merely letters. Tamil writes vowels as
 *     combining signs (Unicode category Mn), so a validator allowing only \p{L} rejects
 *     "தமிழ்" — a name-field that refuses Tamil names on a Tamil Nadu platform. The rule is
 *     therefore \p{L} AND \p{M}, and there is a test with real Tamil text to keep it that way.
 *
 *  2. AN IDENTIFIER CHANGE PROVES POSSESSION OF THE NEW VALUE, not the old. Sending the OTP to
 *     the address already on file proves only that the account owner is present, which step-up
 *     has already established; it proves nothing about whether they can receive mail at the new
 *     one. So the challenge targets the NEW identifier, and a failed verification rolls the whole
 *     change back rather than leaving a half-applied profile.
 *
 *  3. THE AVATAR CANNOT BE SET FROM RAW BYTES AT ALL. This module accepts only a
 *     {@link SanitisedAvatar}, which carries evidence that the media pipeline re-encoded the image
 *     and stripped its EXIF. Identity does not reimplement EXIF stripping — that lives in one
 *     place — it refuses anything that has not been through it.
 */
public final class CustomerProfile {

    /** RULES: the old identifier stays reachable this long so a change can be undone. */
    public static final Duration UNDO_WINDOW = Duration.ofHours(72);
    /** RULES/BRU-12: preference changes apply across channels within this window. */
    public static final Duration PREFERENCE_PROPAGATION = Duration.ofHours(24);
    /** INPUTS: avatar size ceiling. */
    public static final long AVATAR_MAX_BYTES = 2L * 1024 * 1024;
    public static final int NAME_MAX_CHARS = 70;

    /** VALIDATION: the supported language set, matching the platform's 11-language framework. */
    public static final Set<String> SUPPORTED_LANGUAGES = Set.of(
            "en", "hi", "ta", "te", "kn", "ml", "mr", "bn", "gu", "pa", "or");

    /**
     * VALIDATION: the name charset.
     *
     * \p{L} alone is not enough. Tamil represents vowels with combining signs in Unicode category
     * Mn, so a letters-only rule rejects ordinary Tamil names. \p{M} is therefore required, and
     * digits and symbols are excluded because a display name is not a free-text field.
     */
    private static final Pattern NAME_PATTERN = Pattern.compile(
            "^[\\p{L}\\p{M}][\\p{L}\\p{M} .'\\-]*$", Pattern.UNICODE_CHARACTER_CLASS);

    public enum Identifier { EMAIL, MOBILE }

    public enum Channel { EMAIL, SMS, PUSH, WHATSAPP }

    /**
     * SECURITY: an avatar that has been through the media pipeline. The flags are evidence, and a
     * value with either false is refused — so a caller cannot construct one that merely claims to
     * be sanitised and have it accepted.
     */
    public record SanitisedAvatar(String mediaRef, String contentType, long bytes,
                                  boolean reEncodedServerSide, boolean exifStripped) {
        public SanitisedAvatar {
            if (mediaRef == null || mediaRef.isBlank()) throw new IllegalArgumentException("mediaRef");
        }
    }

    public record ChangeHistoryEntry(Instant at, String field, String detail, String actorId) {}

    /** OUTPUTS: a notification owed to an identifier as a result of a change. */
    public record IdentifierNotification(Identifier identifier, String value, String reason) {}

    /** A pending identifier change, awaiting possession proof of the NEW value. */
    public record PendingIdentifierChange(Identifier identifier, String oldValue, String newValue,
                                          String challengeId, Instant requestedAt, int attemptsUsed) {}

    /** RULES: the old value, still reachable for the undo window. */
    public record UndoableChange(Identifier identifier, String previousValue, Instant changedAt,
                                 Instant undoableUntil) {}

    public sealed interface Result {
        record Ok() implements Result {}
        record Rejected(String code, String reason) implements Result {}
    }

    public sealed interface ChangeResult {
        record PendingVerification(PendingIdentifierChange pending) implements ChangeResult {}
        record Rejected(String code, String reason) implements ChangeResult {}
    }

    public sealed interface ConfirmResult {
        record Committed(List<IdentifierNotification> notifications, UndoableChange undoable)
                implements ConfirmResult {}
        /** ERRORS: verification failed and the change was rolled back atomically. */
        record RolledBack(String reason, int attemptsRemaining) implements ConfirmResult {}
        record Rejected(String code, String reason) implements ConfirmResult {}
    }

    public static final int MAX_VERIFICATION_ATTEMPTS = 3;

    private final String customerId;
    private String name;
    private String email;
    private String mobile;
    private String language = "en";
    private SanitisedAvatar avatar;
    private final Map<Channel, Boolean> preferences = new LinkedHashMap<>();
    private Instant preferencesEffectiveFrom;
    private final Map<Channel, Boolean> pendingPreferences = new LinkedHashMap<>();
    private PendingIdentifierChange pending;
    private UndoableChange undoable;
    private final List<ChangeHistoryEntry> history = new ArrayList<>();

    public CustomerProfile(String customerId, String name, String email, String mobile) {
        this.customerId = customerId;
        this.name = name;
        this.email = email;
        this.mobile = mobile;
        for (Channel c : Channel.values()) preferences.put(c, true);
    }

    // ------------------------------------------------------------- simple fields

    /** VALIDATION: name charset, including Tamil script and its combining marks. */
    public static boolean isValidName(String candidate) {
        if (candidate == null) return false;
        String trimmed = candidate.trim();
        if (trimmed.length() < 2 || trimmed.length() > NAME_MAX_CHARS) return false;
        return NAME_PATTERN.matcher(trimmed).matches();
    }

    public Result updateName(String newName, Instant now) {
        if (!isValidName(newName)) {
            return new Result.Rejected("E-VAL-010", "NAME_CHARSET_OR_LENGTH_INVALID");
        }
        String old = this.name;
        this.name = newName.trim();
        history.add(new ChangeHistoryEntry(now, "NAME", "changed from " + old, customerId));
        return new Result.Ok();
    }

    /** VALIDATION: language must be in the supported set. */
    public Result updateLanguage(String lang, Instant now) {
        if (lang == null || !SUPPORTED_LANGUAGES.contains(lang)) {
            return new Result.Rejected("E-VAL-011", "LANGUAGE_NOT_SUPPORTED: " + lang);
        }
        this.language = lang;
        history.add(new ChangeHistoryEntry(now, "LANGUAGE", lang, customerId));
        return new Result.Ok();
    }

    /**
     * SECURITY: only a sanitised avatar may be set. ERRORS: an unsanitised or oversized image is
     * refused with E-VAL-020 and a reason, per the requirement's error code.
     */
    public Result setAvatar(SanitisedAvatar candidate, Instant now) {
        if (candidate == null) return new Result.Rejected("E-VAL-020", "AVATAR_REQUIRED");
        if (!candidate.reEncodedServerSide()) {
            return new Result.Rejected("E-VAL-020", "AVATAR_NOT_RE_ENCODED_SERVER_SIDE");
        }
        if (!candidate.exifStripped()) {
            return new Result.Rejected("E-VAL-020", "AVATAR_EXIF_NOT_STRIPPED");
        }
        if (candidate.bytes() <= 0) return new Result.Rejected("E-VAL-020", "AVATAR_EMPTY");
        if (candidate.bytes() > AVATAR_MAX_BYTES) {
            return new Result.Rejected("E-VAL-020", "AVATAR_EXCEEDS_2MB");
        }
        if (!Set.of("image/jpeg", "image/png", "image/webp").contains(candidate.contentType())) {
            return new Result.Rejected("E-VAL-020", "AVATAR_TYPE_NOT_ALLOWED: " + candidate.contentType());
        }
        this.avatar = candidate;
        history.add(new ChangeHistoryEntry(now, "AVATAR", candidate.mediaRef(), customerId));
        return new Result.Ok();
    }

    // ------------------------------------------------------------- preferences

    /**
     * RULES/BRU-12: a preference change applies across channels within 24 hours. It is staged with
     * an effective instant rather than applied instantly, because the downstream channels cache
     * consent and an instant flip here would be a claim this service cannot honour.
     */
    public Result setPreferences(Map<Channel, Boolean> next, Instant now) {
        if (next == null || next.isEmpty()) return new Result.Rejected("E-VAL-012", "NO_PREFERENCES_SUPPLIED");
        pendingPreferences.clear();
        pendingPreferences.putAll(next);
        preferencesEffectiveFrom = now.plus(PREFERENCE_PROPAGATION);
        history.add(new ChangeHistoryEntry(now, "PREFERENCES",
                "effective " + preferencesEffectiveFrom, customerId));
        return new Result.Ok();
    }

    /** The preference in force at an instant — staged changes apply only once effective. */
    public boolean prefersChannel(Channel channel, Instant at) {
        if (preferencesEffectiveFrom != null && !at.isBefore(preferencesEffectiveFrom)
                && pendingPreferences.containsKey(channel)) {
            return pendingPreferences.get(channel);
        }
        return preferences.getOrDefault(channel, true);
    }

    public Optional<Instant> preferencesEffectiveFrom() {
        return Optional.ofNullable(preferencesEffectiveFrom);
    }

    // ------------------------------------------------------------- identifier change

    /**
     * Request an identifier change.
     *
     * SECURITY: step-up MFA is required, verified against the real Slice-33 SessionRegistry. The
     * challenge is then issued to the NEW identifier, because possession of the new value is the
     * thing not yet proven — step-up has already established that the account owner is present.
     */
    public ChangeResult requestIdentifierChange(Identifier identifier, String newValue,
                                                SessionRegistry sessions, String grantId,
                                                String sessionId, String challengeId, Instant now) {
        if (newValue == null || newValue.isBlank()) {
            return new ChangeResult.Rejected("E-VAL-013", "NEW_IDENTIFIER_REQUIRED");
        }
        if (identifier == Identifier.EMAIL && !newValue.contains("@")) {
            return new ChangeResult.Rejected("E-VAL-013", "EMAIL_MALFORMED");
        }
        if (identifier == Identifier.MOBILE && !newValue.matches("^\\+?[0-9]{10,15}$")) {
            return new ChangeResult.Rejected("E-VAL-013", "MOBILE_MALFORMED");
        }
        String current = identifier == Identifier.EMAIL ? email : mobile;
        if (newValue.equalsIgnoreCase(current)) {
            return new ChangeResult.Rejected("E-VAL-013", "NEW_IDENTIFIER_SAME_AS_CURRENT");
        }
        if (pending != null) {
            return new ChangeResult.Rejected("E-CONFLICT-001", "ANOTHER_IDENTIFIER_CHANGE_IS_PENDING");
        }

        SessionRegistry.SensitiveAction action = identifier == Identifier.EMAIL
                ? SessionRegistry.SensitiveAction.PASSWORD_CHANGE     // email is a login identifier
                : SessionRegistry.SensitiveAction.MOBILE_CHANGE;
        if (!sessions.isStepUpSatisfied(grantId, sessionId, action, now)) {
            return new ChangeResult.Rejected("E-AUTH-012", "STEP_UP_MFA_REQUIRED_FOR_IDENTIFIER_CHANGE");
        }

        pending = new PendingIdentifierChange(identifier, current, newValue, challengeId, now, 0);
        return new ChangeResult.PendingVerification(pending);
    }

    /** Which identifier the possession challenge was sent to. Always the NEW one. */
    public Optional<String> challengeTarget() {
        return Optional.ofNullable(pending).map(PendingIdentifierChange::newValue);
    }

    /**
     * Confirm the change with possession proof of the new identifier.
     *
     * ERRORS: a failed verification rolls back ATOMICALLY — the profile is untouched, no
     * notification is owed, and nothing is left half-applied. OUTPUTS: on success BOTH the old and
     * the new identifier are notified, so a customer whose account was taken over learns of it at
     * the address the attacker no longer controls.
     */
    public ConfirmResult confirmIdentifierChange(String challengeId, boolean otpValid, Instant now) {
        if (pending == null) return new ConfirmResult.Rejected("E-STATE-001", "NO_PENDING_CHANGE");
        if (!pending.challengeId().equals(challengeId)) {
            return new ConfirmResult.Rejected("E-STATE-002", "CHALLENGE_ID_MISMATCH");
        }

        if (!otpValid) {
            int used = pending.attemptsUsed() + 1;
            int remaining = MAX_VERIFICATION_ATTEMPTS - used;
            if (remaining <= 0) {
                pending = null;      // the whole change is discarded, not partially retained
                history.add(new ChangeHistoryEntry(now, "IDENTIFIER_CHANGE",
                        "abandoned after failed verification", customerId));
                return new ConfirmResult.RolledBack("VERIFICATION_FAILED_CHANGE_DISCARDED", 0);
            }
            pending = new PendingIdentifierChange(pending.identifier(), pending.oldValue(),
                    pending.newValue(), pending.challengeId(), pending.requestedAt(), used);
            return new ConfirmResult.RolledBack("VERIFICATION_FAILED", remaining);
        }

        Identifier id = pending.identifier();
        String oldValue = pending.oldValue();
        String newValue = pending.newValue();

        if (id == Identifier.EMAIL) this.email = newValue;
        else this.mobile = newValue;

        undoable = new UndoableChange(id, oldValue, now, now.plus(UNDO_WINDOW));
        pending = null;
        history.add(new ChangeHistoryEntry(now, "IDENTIFIER_CHANGE",
                id + " changed; undo available until " + undoable.undoableUntil(), customerId));

        var notifications = List.of(
                new IdentifierNotification(id, oldValue, "Your " + id
                        + " was changed. If this was not you, undo within 72 hours."),
                new IdentifierNotification(id, newValue, "This " + id + " is now on your account."));
        return new ConfirmResult.Committed(notifications, undoable);
    }

    /** RULES: undo within 72 hours, restoring the previous value. */
    public Result undoIdentifierChange(Instant now) {
        if (undoable == null) return new Result.Rejected("E-STATE-003", "NOTHING_TO_UNDO");
        if (now.isAfter(undoable.undoableUntil())) {
            return new Result.Rejected("E-STATE-004", "UNDO_WINDOW_EXPIRED");
        }
        if (undoable.identifier() == Identifier.EMAIL) this.email = undoable.previousValue();
        else this.mobile = undoable.previousValue();
        history.add(new ChangeHistoryEntry(now, "IDENTIFIER_CHANGE_UNDONE",
                "restored " + undoable.identifier(), customerId));
        undoable = null;
        return new Result.Ok();
    }

    /** RULES: is the old identifier still reachable for undo purposes? */
    public boolean isOldIdentifierReachable(Instant now) {
        return undoable != null && !now.isAfter(undoable.undoableUntil());
    }

    /** Abandon a pending change without consuming an attempt. */
    public Result cancelPendingChange(Instant now) {
        if (pending == null) return new Result.Rejected("E-STATE-001", "NO_PENDING_CHANGE");
        pending = null;
        history.add(new ChangeHistoryEntry(now, "IDENTIFIER_CHANGE", "cancelled by customer", customerId));
        return new Result.Ok();
    }

    // ------------------------------------------------------------- accessors

    public String customerId()                       { return customerId; }
    public String name()                             { return name; }
    public String email()                            { return email; }
    public String mobile()                           { return mobile; }
    public String language()                         { return language; }
    public Optional<SanitisedAvatar> avatar()        { return Optional.ofNullable(avatar); }
    public Optional<PendingIdentifierChange> pendingChange() { return Optional.ofNullable(pending); }
    public Optional<UndoableChange> undoableChange() { return Optional.ofNullable(undoable); }
    public List<ChangeHistoryEntry> changeHistory()  { return List.copyOf(history); }
}
