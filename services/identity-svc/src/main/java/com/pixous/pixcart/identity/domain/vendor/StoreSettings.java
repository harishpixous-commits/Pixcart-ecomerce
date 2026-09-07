package com.pixous.pixcart.identity.domain.vendor;

import com.pixous.pixcart.identity.domain.auth.SessionRegistry;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Store creation & settings — FR-VEN-002.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "let an approved vendor configure a public storefront: store name (unique slug),
 *                logo/banner, description, policies (dispatch SLA, returns extras), holiday mode
 *                and staff sub-users with scoped permissions."
 *   INPUTS:     "Store name (3–40 chars), media (logo ≤ 1 MB, banner ≤ 3 MB), policy fields,
 *                staff invites (email+role)."
 *   OUTPUTS:    "Live store page /store/{slug}, policy display on PDPs, staff accounts with
 *                V-scoped RBAC, holiday-mode listing suppression."
 *   VALIDATION: "Slug uniqueness + reserved-word list; media dimension/type checks; dispatch SLA
 *                1–7 days; profanity filter on public text."
 *   RULES:      "Holiday mode hides Buy actions but keeps pages indexed with 'back on {date}';
 *                staff role matrix: Catalogue, Orders, Finance-view (no payout edit)."
 *   ERRORS:     "Slug clash → suggestions; media processing fail → placeholder with retry; staff
 *                invite bounce → resend with expiry 72 h."
 *   SECURITY:   "Payout-affecting settings restricted to Owner + step-up MFA; staff actions
 *                attributed individually in audit."
 *
 * Two properties carry the security weight, and both are enforced here rather than in a UI:
 *
 *  1. NO STAFF ROLE CAN EVER EDIT PAYOUT SETTINGS. Not even Finance-view, whose name invites the
 *     assumption that it might. The role matrix is exhaustive and the test iterates every role to
 *     prove none grants it.
 *
 *  2. A PAYOUT EDIT REQUIRES THE OWNER *AND* A SATISFIED STEP-UP GRANT. The grant is verified
 *     against the real Slice-33 SessionRegistry, so the two conditions are checked in one place
 *     and neither can be waived independently.
 *
 * Holiday mode is deliberately not a soft delete: Buy actions disappear, but the page stays
 * indexable with a "back on" notice, because de-indexing a storefront for a fortnight's holiday
 * costs a vendor search ranking that takes months to rebuild.
 */
public final class StoreSettings {

    public static final int NAME_MIN_CHARS = 3;
    public static final int NAME_MAX_CHARS = 40;
    public static final long LOGO_MAX_BYTES = 1L * 1024 * 1024;      // 1 MB
    public static final long BANNER_MAX_BYTES = 3L * 1024 * 1024;    // 3 MB
    public static final int DISPATCH_SLA_MIN_DAYS = 1;
    public static final int DISPATCH_SLA_MAX_DAYS = 7;
    public static final Duration STAFF_INVITE_EXPIRY = Duration.ofHours(72);

    /** VALIDATION: slugs that would collide with platform routes or imply endorsement. */
    public static final Set<String> RESERVED_SLUGS = Set.of(
            "admin", "api", "store", "stores", "checkout", "cart", "account", "login", "logout",
            "help", "support", "pixous", "pixcart", "official", "verified", "search", "orders",
            "settings", "static", "assets", "app", "www");

    private static final List<String> PROFANITY = List.of("bloody", "damn", "idiot", "crap");

    /** RULES: the staff role matrix, exactly as documented. */
    public enum StaffRole {
        CATALOGUE(Set.of(Permission.CATALOGUE_MANAGE)),
        ORDERS(Set.of(Permission.ORDERS_MANAGE)),
        FINANCE_VIEW(Set.of(Permission.FINANCE_READ));

        private final Set<Permission> permissions;

        StaffRole(Set<Permission> permissions) {
            this.permissions = Set.copyOf(permissions);
        }

        public Set<Permission> permissions() {
            return permissions;
        }
    }

    public enum Permission {
        CATALOGUE_MANAGE, ORDERS_MANAGE, FINANCE_READ,
        /** Deliberately granted by NO staff role — owner-only, and then only with step-up. */
        PAYOUT_SETTINGS_EDIT
    }

    public enum MediaKind { LOGO, BANNER }

    public record MediaAsset(MediaKind kind, long bytes, int widthPx, int heightPx, String mimeType) {}

    public sealed interface Outcome {
        record Ok() implements Outcome {}
        record Rejected(List<String> violations) implements Outcome {}
    }

    /** ERRORS: a slug clash returns alternatives rather than a bare failure. */
    public record SlugResult(boolean available, String slug, List<String> suggestions,
                             List<String> violations) {}

    public record StaffInvite(String email, StaffRole role, Instant invitedAt, Instant expiresAt,
                              int sendAttempts, boolean bounced, boolean accepted) {}

    /** SECURITY: staff actions are attributed individually. */
    public record AuditEntry(Instant at, String actorUserId, String action, String detail) {}

    // ------------------------------------------------------------- slug

    public static String slugify(String storeName) {
        if (storeName == null) return "";
        return storeName.toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9\\s-]", "")
                .trim()
                .replaceAll("[\\s-]+", "-");
    }

    /**
     * VALIDATION: slug uniqueness and the reserved-word list. ERRORS: a clash yields suggestions.
     */
    public static SlugResult resolveSlug(String storeName, Set<String> existingSlugs) {
        var violations = new ArrayList<String>();
        if (storeName == null || storeName.trim().length() < NAME_MIN_CHARS) {
            violations.add("STORE_NAME_TOO_SHORT_MIN_" + NAME_MIN_CHARS);
        }
        if (storeName != null && storeName.trim().length() > NAME_MAX_CHARS) {
            violations.add("STORE_NAME_TOO_LONG_MAX_" + NAME_MAX_CHARS);
        }
        String profane = profanityIn(storeName);
        if (profane != null) violations.add("PROFANITY_IN_STORE_NAME: " + profane);

        String slug = slugify(storeName);
        if (slug.isEmpty()) violations.add("STORE_NAME_YIELDS_EMPTY_SLUG");
        if (!violations.isEmpty()) return new SlugResult(false, slug, List.of(), List.copyOf(violations));

        if (RESERVED_SLUGS.contains(slug)) {
            return new SlugResult(false, slug, suggestSlugs(slug, existingSlugs),
                    List.of("SLUG_IS_RESERVED: " + slug));
        }
        if (existingSlugs.contains(slug)) {
            return new SlugResult(false, slug, suggestSlugs(slug, existingSlugs),
                    List.of("SLUG_ALREADY_TAKEN: " + slug));
        }
        return new SlugResult(true, slug, List.of(), List.of());
    }

    /** Suggestions that are themselves available and never reserved. */
    public static List<String> suggestSlugs(String base, Set<String> existingSlugs) {
        var out = new ArrayList<String>();
        for (String candidate : List.of(base + "-store", base + "-official-store", base + "-shop",
                base + "-in", base + "-2")) {
            if (!existingSlugs.contains(candidate) && !RESERVED_SLUGS.contains(candidate)) {
                out.add(candidate);
            }
            if (out.size() == 3) break;
        }
        for (int i = 1; out.size() < 3; i++) {
            String candidate = base + "-" + i;
            if (!existingSlugs.contains(candidate) && !RESERVED_SLUGS.contains(candidate)) out.add(candidate);
            if (i > 50) break;
        }
        return List.copyOf(out);
    }

    // ------------------------------------------------------------- media

    /** VALIDATION: media dimension and type checks, with per-kind size ceilings. */
    public static Outcome validateMedia(MediaAsset asset) {
        var v = new ArrayList<String>();
        Set<String> allowed = Set.of("image/png", "image/jpeg", "image/webp");
        if (asset.mimeType() == null || !allowed.contains(asset.mimeType())) {
            v.add("MEDIA_TYPE_NOT_ALLOWED: " + asset.mimeType());
        }
        long ceiling = asset.kind() == MediaKind.LOGO ? LOGO_MAX_BYTES : BANNER_MAX_BYTES;
        if (asset.bytes() > ceiling) {
            v.add(asset.kind() + "_EXCEEDS_" + (ceiling / 1024 / 1024) + "MB");
        }
        if (asset.bytes() <= 0) v.add("MEDIA_EMPTY");

        if (asset.kind() == MediaKind.LOGO) {
            if (asset.widthPx() < 200 || asset.heightPx() < 200) v.add("LOGO_MIN_200x200");
            if (asset.widthPx() != asset.heightPx()) v.add("LOGO_MUST_BE_SQUARE");
        } else {
            if (asset.widthPx() < 1200 || asset.heightPx() < 300) v.add("BANNER_MIN_1200x300");
        }
        return v.isEmpty() ? new Outcome.Ok() : new Outcome.Rejected(List.copyOf(v));
    }

    // ------------------------------------------------------------- the store

    private final String vendorId;
    private final String slug;
    private String description = "";
    private int dispatchSlaDays = 2;
    private String returnsExtras = "";
    private boolean holidayMode;
    private LocalDate backOnDate;
    private MediaAsset logo;
    private MediaAsset banner;
    private boolean logoProcessingFailed;
    private final Map<String, StaffRole> staff = new LinkedHashMap<>();
    private final Map<String, StaffInvite> invites = new LinkedHashMap<>();
    private final List<AuditEntry> audit = new ArrayList<>();

    private StoreSettings(String vendorId, String slug) {
        this.vendorId = vendorId;
        this.slug = slug;
    }

    /**
     * A store may only be created for a vendor whose lifecycle state is ACTIVE — the requirement
     * says "an approved vendor", and the Slice-25 lifecycle is the authority on that.
     */
    public sealed interface CreateResult {
        record Ok(StoreSettings store) implements CreateResult {}
        record Rejected(List<String> violations) implements CreateResult {}
    }

    public static CreateResult create(VendorLifecycle lifecycle, String storeName,
                                      Set<String> existingSlugs) {
        if (lifecycle.state() != VendorLifecycle.State.ACTIVE) {
            return new CreateResult.Rejected(
                    List.of("VENDOR_NOT_APPROVED: " + lifecycle.state()));
        }
        SlugResult slugResult = resolveSlug(storeName, existingSlugs);
        if (!slugResult.available()) {
            return new CreateResult.Rejected(slugResult.violations());
        }
        return new CreateResult.Ok(new StoreSettings(lifecycle.vendorId(), slugResult.slug()));
    }

    public String publicUrl() {
        return "/store/" + slug;
    }

    // ------------------------------------------------------------- policies

    /** VALIDATION: dispatch SLA is 1–7 days. */
    public Outcome setDispatchSlaDays(int days, String actorUserId, Instant now) {
        if (days < DISPATCH_SLA_MIN_DAYS || days > DISPATCH_SLA_MAX_DAYS) {
            return new Outcome.Rejected(List.of(
                    "DISPATCH_SLA_OUT_OF_RANGE_" + DISPATCH_SLA_MIN_DAYS + "_TO_" + DISPATCH_SLA_MAX_DAYS));
        }
        this.dispatchSlaDays = days;
        audit.add(new AuditEntry(now, actorUserId, "SET_DISPATCH_SLA", days + " days"));
        return new Outcome.Ok();
    }

    /** VALIDATION: profanity filter on public text. */
    public Outcome setDescription(String description, String actorUserId, Instant now) {
        String profane = profanityIn(description);
        if (profane != null) {
            return new Outcome.Rejected(List.of("PROFANITY_IN_DESCRIPTION: " + profane));
        }
        if (description != null && description.length() > 2_000) {
            return new Outcome.Rejected(List.of("DESCRIPTION_EXCEEDS_2000_CHARS"));
        }
        this.description = description == null ? "" : description;
        audit.add(new AuditEntry(now, actorUserId, "SET_DESCRIPTION", ""));
        return new Outcome.Ok();
    }

    public Outcome setReturnsExtras(String text, String actorUserId, Instant now) {
        String profane = profanityIn(text);
        if (profane != null) return new Outcome.Rejected(List.of("PROFANITY_IN_RETURNS_TEXT: " + profane));
        this.returnsExtras = text == null ? "" : text;
        audit.add(new AuditEntry(now, actorUserId, "SET_RETURNS_EXTRAS", ""));
        return new Outcome.Ok();
    }

    public Outcome setMedia(MediaAsset asset, String actorUserId, Instant now) {
        Outcome check = validateMedia(asset);
        if (check instanceof Outcome.Rejected) return check;
        if (asset.kind() == MediaKind.LOGO) {
            this.logo = asset;
            this.logoProcessingFailed = false;
        } else {
            this.banner = asset;
        }
        audit.add(new AuditEntry(now, actorUserId, "SET_MEDIA", asset.kind().name()));
        return new Outcome.Ok();
    }

    /** ERRORS: media processing failure shows a placeholder and permits a retry. */
    public void recordLogoProcessingFailure() {
        this.logoProcessingFailed = true;
    }

    public boolean showsLogoPlaceholder() {
        return logo == null || logoProcessingFailed;
    }

    public boolean logoRetryAvailable() {
        return logoProcessingFailed;
    }

    // ------------------------------------------------------------- holiday mode

    /**
     * RULES: holiday mode hides Buy actions but keeps the page indexed with a "back on" notice.
     * A return date is mandatory — an indefinite "we are away" notice is worse than none.
     */
    public Outcome enableHolidayMode(LocalDate backOn, LocalDate today, String actorUserId, Instant now) {
        if (backOn == null) return new Outcome.Rejected(List.of("HOLIDAY_MODE_REQUIRES_RETURN_DATE"));
        if (!backOn.isAfter(today)) return new Outcome.Rejected(List.of("HOLIDAY_RETURN_DATE_MUST_BE_FUTURE"));
        this.holidayMode = true;
        this.backOnDate = backOn;
        audit.add(new AuditEntry(now, actorUserId, "ENABLE_HOLIDAY_MODE", "back on " + backOn));
        return new Outcome.Ok();
    }

    public Outcome disableHolidayMode(String actorUserId, Instant now) {
        this.holidayMode = false;
        this.backOnDate = null;
        audit.add(new AuditEntry(now, actorUserId, "DISABLE_HOLIDAY_MODE", ""));
        return new Outcome.Ok();
    }

    public boolean buyActionsEnabled() {
        return !holidayMode;
    }

    /** RULES: the page stays indexed — de-indexing would cost ranking that takes months to regain. */
    public boolean isIndexable() {
        return true;
    }

    public String storefrontNotice() {
        return holidayMode ? "Back on " + backOnDate : "";
    }

    // ------------------------------------------------------------- staff

    /** ERRORS: an invite expires after 72 hours; a bounce permits a resend. */
    public Outcome inviteStaff(String email, StaffRole role, Set<String> allowedDomains,
                               String actorUserId, Instant now) {
        var v = new ArrayList<String>();
        if (email == null || !email.contains("@")) v.add("EMAIL_MALFORMED");
        if (role == null) v.add("ROLE_REQUIRED");
        if (email != null && email.contains("@") && !allowedDomains.isEmpty()) {
            String domain = email.substring(email.indexOf('@') + 1).toLowerCase(Locale.ROOT);
            if (!allowedDomains.contains(domain)) v.add("EMAIL_DOMAIN_NOT_ALLOWED: " + domain);
        }
        if (!v.isEmpty()) return new Outcome.Rejected(List.copyOf(v));

        invites.put(email, new StaffInvite(email, role, now, now.plus(STAFF_INVITE_EXPIRY), 1, false, false));
        audit.add(new AuditEntry(now, actorUserId, "INVITE_STAFF", email + " as " + role));
        return new Outcome.Ok();
    }

    public void recordInviteBounce(String email) {
        StaffInvite i = invites.get(email);
        if (i == null) return;
        invites.put(email, new StaffInvite(i.email(), i.role(), i.invitedAt(), i.expiresAt(),
                i.sendAttempts(), true, false));
    }

    /** ERRORS: a bounced invite is resent with a fresh 72-hour expiry. */
    public Outcome resendInvite(String email, String actorUserId, Instant now) {
        StaffInvite i = invites.get(email);
        if (i == null) return new Outcome.Rejected(List.of("UNKNOWN_INVITE"));
        if (i.accepted()) return new Outcome.Rejected(List.of("INVITE_ALREADY_ACCEPTED"));
        invites.put(email, new StaffInvite(i.email(), i.role(), i.invitedAt(),
                now.plus(STAFF_INVITE_EXPIRY), i.sendAttempts() + 1, false, false));
        audit.add(new AuditEntry(now, actorUserId, "RESEND_INVITE", email));
        return new Outcome.Ok();
    }

    public Outcome acceptInvite(String email, String staffUserId, Instant now) {
        StaffInvite i = invites.get(email);
        if (i == null) return new Outcome.Rejected(List.of("UNKNOWN_INVITE"));
        if (now.isAfter(i.expiresAt())) return new Outcome.Rejected(List.of("INVITE_EXPIRED"));
        if (i.accepted()) return new Outcome.Rejected(List.of("INVITE_ALREADY_ACCEPTED"));
        invites.put(email, new StaffInvite(i.email(), i.role(), i.invitedAt(), i.expiresAt(),
                i.sendAttempts(), i.bounced(), true));
        staff.put(staffUserId, i.role());
        audit.add(new AuditEntry(now, staffUserId, "ACCEPT_INVITE", email + " as " + i.role()));
        return new Outcome.Ok();
    }

    public StaffInvite invite(String email) {
        return invites.get(email);
    }

    public StaffRole roleOf(String staffUserId) {
        return staff.get(staffUserId);
    }

    /** RULES: what a staff role may do. Payout editing is absent from every role. */
    public static boolean roleGrants(StaffRole role, Permission permission) {
        return role != null && role.permissions().contains(permission);
    }

    public boolean staffMay(String staffUserId, Permission permission) {
        return roleGrants(staff.get(staffUserId), permission);
    }

    /**
     * SECURITY: payout-affecting settings require the Owner AND a satisfied step-up grant. Both
     * conditions are checked here, so neither can be waived by a caller that satisfies the other.
     */
    public boolean mayEditPayoutSettings(String userId, boolean isOwner, SessionRegistry sessions,
                                         String grantId, String sessionId, Instant now) {
        if (!isOwner) return false;
        if (staff.containsKey(userId)) return false;      // a staff account is never the owner
        return sessions.isStepUpSatisfied(grantId, sessionId,
                SessionRegistry.SensitiveAction.PAYOUT_ACCOUNT_EDIT, now);
    }

    // ------------------------------------------------------------- accessors

    public String vendorId()                { return vendorId; }
    public String slug()                    { return slug; }
    public String description()             { return description; }
    public int dispatchSlaDays()            { return dispatchSlaDays; }
    public String returnsExtras()           { return returnsExtras; }
    public boolean holidayMode()            { return holidayMode; }
    public LocalDate backOnDate()           { return backOnDate; }
    public MediaAsset logo()                { return logo; }
    public MediaAsset banner()              { return banner; }
    public List<AuditEntry> auditTrail()    { return List.copyOf(audit); }
    public Set<String> staffUserIds()       { return new LinkedHashSet<>(staff.keySet()); }

    private static String profanityIn(String text) {
        if (text == null) return null;
        String lower = text.toLowerCase(Locale.ROOT);
        for (String p : PROFANITY) {
            if (lower.contains(p)) return p;
        }
        return null;
    }
}
