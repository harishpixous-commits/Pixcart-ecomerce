package com.pixous.pixcart.catalogue.domain.reviews;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Product reviews — FR-CUS-023.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "accept reviews (text ≤ 2,000 chars, photos ≤ 5, video ≤ 60 s) only from
 *                verified purchasers per SKU, run moderation (AI pre-screen + human queue for
 *                flags), and display with verified badge, helpfulness votes and vendor reply."
 *   VALIDATION: "One review per delivered SKU per customer, editable 30 days (BRU-13); media
 *                scanned; PII/profanity/URL filters."
 *   RULES:      "Incentivised reviews auto-labelled; vendor cannot delete reviews, only reply
 *                and flag; takedown only via A with logged reason."
 *   ERRORS:     "AI screen uncertain → human queue (24-h SLA) with 'pending' state visible to
 *                author only."
 *   SECURITY:   "Reviewer identity maskable; anti-brigading velocity checks; edit history
 *                retained."
 *   ACCEPTANCE: a non-purchaser attempting to review is refused.
 *
 * The eligibility gate is the point of the requirement: only a customer with a DELIVERED
 * purchase of that exact SKU may review it, once. Vendors have no delete path at all — the API
 * offers reply and flag only, and takedown belongs to an admin with a logged reason. Edits are
 * permitted for 30 days and every version is retained, so a review cannot be quietly rewritten
 * after it has influenced buyers.
 */
public final class ReviewModeration {

    public static final int MAX_BODY_CHARS = 2_000;
    public static final int MAX_PHOTOS = 5;
    public static final int MAX_VIDEO_SECONDS = 60;
    public static final Duration EDIT_WINDOW = Duration.ofDays(30);          // BRU-13
    public static final Duration HUMAN_QUEUE_SLA = Duration.ofHours(24);
    /** Anti-brigading: reviews per customer per rolling window. */
    public static final int MAX_REVIEWS_PER_DAY = 5;

    public enum State { PENDING_HUMAN, PUBLISHED, REJECTED, TAKEN_DOWN }

    /** The AI pre-screen verdict; UNCERTAIN routes to the human queue rather than guessing. */
    public enum ScreenVerdict { CLEAN, UNCERTAIN, ABUSIVE }

    private static final Pattern URL = Pattern.compile("(?i)(https?://|www\\.)");
    private static final Pattern EMAIL = Pattern.compile("(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}");
    private static final Pattern PHONE = Pattern.compile("(\\+?\\d[\\d\\s-]{8,}\\d)");
    private static final List<String> PROFANITY = List.of("bloody", "damn", "idiot");

    /** What the caller submits. */
    public record Draft(String reviewId, String customerId, String sku, String subOrderId,
                        int stars, String title, String body,
                        int photoCount, int videoSeconds, boolean anonymous, boolean incentivised) {}

    /** Purchase facts supplied by the order service — the domain never assumes them. */
    public record PurchaseFact(String customerId, String sku, String subOrderId, boolean delivered) {}

    public record Version(Instant at, int stars, String title, String body) {}

    public sealed interface Outcome {
        record Ok(Review review) implements Outcome {}
        record Rejected(List<String> violations) implements Outcome {}
    }

    public static final class Review {
        private final String reviewId;
        private final String customerId;
        private final String sku;
        private final String subOrderId;
        private int stars;
        private String title;
        private String body;
        private final boolean anonymous;
        private final boolean incentivised;
        private final Instant createdAt;
        private State state;
        private Instant queuedAt;
        private String takedownReason;
        private String takedownBy;
        private String vendorReply;
        private int helpfulVotes;
        private final List<Version> history = new ArrayList<>();

        private Review(Draft d, Instant now, State state) {
            this.reviewId = d.reviewId();
            this.customerId = d.customerId();
            this.sku = d.sku();
            this.subOrderId = d.subOrderId();
            this.stars = d.stars();
            this.title = d.title();
            this.body = d.body();
            this.anonymous = d.anonymous();
            this.incentivised = d.incentivised();
            this.createdAt = now;
            this.state = state;
            if (state == State.PENDING_HUMAN) this.queuedAt = now;
            this.history.add(new Version(now, d.stars(), d.title(), d.body()));
        }

        /** VALIDATION: only published reviews count towards aggregates. */
        public boolean countsTowardsRating() { return state == State.PUBLISHED; }

        /** ERRORS: a pending review is visible to its author only. */
        public boolean isVisibleTo(String viewerId, boolean viewerIsAdmin) {
            return switch (state) {
                case PUBLISHED -> true;
                case PENDING_HUMAN -> viewerIsAdmin || customerId.equals(viewerId);
                case REJECTED, TAKEN_DOWN -> viewerIsAdmin;
            };
        }

        /** RULES: incentivised reviews carry a label wherever they are shown. */
        public String displayLabel() {
            return incentivised ? "Incentivised review" : "";
        }

        /** SECURITY: reviewer identity is maskable. */
        public String displayAuthor(String customerDisplayName) {
            return anonymous ? "A verified buyer" : customerDisplayName;
        }

        public String reviewId()        { return reviewId; }
        public String customerId()      { return customerId; }
        public String sku()             { return sku; }
        public String subOrderId()      { return subOrderId; }
        public int stars()              { return stars; }
        public String title()           { return title; }
        public String body()            { return body; }
        public State state()            { return state; }
        public Instant createdAt()      { return createdAt; }
        public boolean incentivised()   { return incentivised; }
        public boolean anonymous()      { return anonymous; }
        public String vendorReply()     { return vendorReply; }
        public int helpfulVotes()       { return helpfulVotes; }
        public String takedownReason()  { return takedownReason; }
        public List<Version> history()  { return List.copyOf(history); }
        public boolean verifiedBadge()  { return true; }   // only verified purchasers can get here
    }

    private final Map<String, Review> reviews = new LinkedHashMap<>();
    /** customerId|sku -> reviewId, enforcing one review per delivered SKU per customer. */
    private final Map<String, String> onePerSku = new LinkedHashMap<>();
    private final Map<String, List<Instant>> submissionTimes = new LinkedHashMap<>();

    /** Content checks: length, media limits, and the PII/profanity/URL filters. */
    public static List<String> validateContent(Draft d) {
        var v = new ArrayList<String>();
        if (d.stars() < 1 || d.stars() > 5) v.add("STARS_OUT_OF_RANGE");
        if (d.body() == null || d.body().isBlank()) v.add("BODY_REQUIRED");
        else if (d.body().length() > MAX_BODY_CHARS) v.add("BODY_EXCEEDS_2000_CHARS");
        if (d.photoCount() > MAX_PHOTOS) v.add("TOO_MANY_PHOTOS");
        if (d.photoCount() < 0 || d.videoSeconds() < 0) v.add("NEGATIVE_MEDIA_COUNT");
        if (d.videoSeconds() > MAX_VIDEO_SECONDS) v.add("VIDEO_EXCEEDS_60_SECONDS");
        String text = (d.title() == null ? "" : d.title()) + " " + (d.body() == null ? "" : d.body());
        if (URL.matcher(text).find()) v.add("URL_NOT_PERMITTED");
        if (EMAIL.matcher(text).find()) v.add("EMAIL_ADDRESS_NOT_PERMITTED");
        if (PHONE.matcher(text).find()) v.add("PHONE_NUMBER_NOT_PERMITTED");
        String lower = text.toLowerCase();
        if (PROFANITY.stream().anyMatch(lower::contains)) v.add("PROFANITY_NOT_PERMITTED");
        return v;
    }

    /**
     * Submit a review. ACCEPTANCE: a non-purchaser is refused. Eligibility requires a DELIVERED
     * purchase of that exact SKU by that customer, and only one review per SKU per customer.
     */
    public Outcome submit(Draft d, List<PurchaseFact> purchases, ScreenVerdict verdict, Instant now) {
        var v = new ArrayList<String>(validateContent(d));

        boolean purchased = purchases.stream().anyMatch(p ->
                p.customerId().equals(d.customerId()) && p.sku().equals(d.sku()) && p.delivered());
        if (!purchased) {
            boolean boughtButNotDelivered = purchases.stream().anyMatch(p ->
                    p.customerId().equals(d.customerId()) && p.sku().equals(d.sku()) && !p.delivered());
            v.add(boughtButNotDelivered ? "PURCHASE_NOT_YET_DELIVERED" : "NOT_A_VERIFIED_PURCHASER");
        }

        String skuKey = d.customerId() + "|" + d.sku();
        if (onePerSku.containsKey(skuKey)) v.add("ONE_REVIEW_PER_SKU_PER_CUSTOMER");

        // SECURITY: anti-brigading velocity check
        var times = submissionTimes.computeIfAbsent(d.customerId(), k -> new ArrayList<>());
        Instant cutoff = now.minus(Duration.ofDays(1));
        times.removeIf(t -> t.isBefore(cutoff));
        if (times.size() >= MAX_REVIEWS_PER_DAY) v.add("REVIEW_VELOCITY_EXCEEDED");

        if (!v.isEmpty()) return new Outcome.Rejected(List.copyOf(v));

        State state = switch (verdict) {
            case CLEAN -> State.PUBLISHED;
            case UNCERTAIN -> State.PENDING_HUMAN;      // never guess: route to a human
            case ABUSIVE -> State.REJECTED;
        };
        var review = new Review(d, now, state);
        reviews.put(d.reviewId(), review);
        onePerSku.put(skuKey, d.reviewId());
        times.add(now);
        return new Outcome.Ok(review);
    }

    /** Human moderator decision on a queued review. */
    public Outcome moderate(String reviewId, boolean approve, String moderatorId, Instant now) {
        Review r = reviews.get(reviewId);
        if (r == null) return new Outcome.Rejected(List.of("UNKNOWN_REVIEW"));
        if (r.state != State.PENDING_HUMAN) return new Outcome.Rejected(List.of("NOT_IN_HUMAN_QUEUE"));
        if (moderatorId == null || moderatorId.isBlank()) return new Outcome.Rejected(List.of("MODERATOR_REQUIRED"));
        r.state = approve ? State.PUBLISHED : State.REJECTED;
        return new Outcome.Ok(r);
    }

    /** ERRORS: the human queue carries a 24-hour SLA. */
    public boolean isHumanQueueSlaBreached(String reviewId, Instant now) {
        Review r = reviews.get(reviewId);
        return r != null && r.state == State.PENDING_HUMAN && now.isAfter(r.queuedAt.plus(HUMAN_QUEUE_SLA));
    }

    /** VALIDATION/BRU-13: editable for 30 days, with every version retained. */
    public Outcome edit(String reviewId, int stars, String title, String body, Instant now) {
        Review r = reviews.get(reviewId);
        if (r == null) return new Outcome.Rejected(List.of("UNKNOWN_REVIEW"));
        if (now.isAfter(r.createdAt.plus(EDIT_WINDOW))) return new Outcome.Rejected(List.of("EDIT_WINDOW_EXPIRED"));
        if (r.state == State.TAKEN_DOWN) return new Outcome.Rejected(List.of("REVIEW_TAKEN_DOWN"));
        var v = validateContent(new Draft(reviewId, r.customerId, r.sku, r.subOrderId, stars, title, body,
                0, 0, r.anonymous, r.incentivised));
        if (!v.isEmpty()) return new Outcome.Rejected(v);
        r.stars = stars;
        r.title = title;
        r.body = body;
        r.history.add(new Version(now, stars, title, body));
        return new Outcome.Ok(r);
    }

    /** RULES: a vendor may reply but has no delete path — this is the only vendor mutation. */
    public Outcome vendorReply(String reviewId, String vendorId, String reply, Instant now) {
        Review r = reviews.get(reviewId);
        if (r == null) return new Outcome.Rejected(List.of("UNKNOWN_REVIEW"));
        if (reply == null || reply.isBlank()) return new Outcome.Rejected(List.of("REPLY_REQUIRED"));
        if (reply.length() > MAX_BODY_CHARS) return new Outcome.Rejected(List.of("REPLY_EXCEEDS_2000_CHARS"));
        r.vendorReply = reply;
        return new Outcome.Ok(r);
    }

    /** RULES: takedown only by an admin, and only with a logged reason. */
    public Outcome adminTakedown(String reviewId, String adminId, String reason, Instant now) {
        Review r = reviews.get(reviewId);
        if (r == null) return new Outcome.Rejected(List.of("UNKNOWN_REVIEW"));
        if (adminId == null || adminId.isBlank()) return new Outcome.Rejected(List.of("ADMIN_REQUIRED"));
        if (reason == null || reason.trim().length() < 5) return new Outcome.Rejected(List.of("TAKEDOWN_REASON_REQUIRED"));
        r.state = State.TAKEN_DOWN;
        r.takedownBy = adminId;
        r.takedownReason = reason;
        return new Outcome.Ok(r);
    }

    public Outcome voteHelpful(String reviewId, String voterId) {
        Review r = reviews.get(reviewId);
        if (r == null) return new Outcome.Rejected(List.of("UNKNOWN_REVIEW"));
        if (r.state != State.PUBLISHED) return new Outcome.Rejected(List.of("ONLY_PUBLISHED_REVIEWS_VOTABLE"));
        if (r.customerId.equals(voterId)) return new Outcome.Rejected(List.of("CANNOT_VOTE_ON_OWN_REVIEW"));
        r.helpfulVotes++;
        return new Outcome.Ok(r);
    }

    public Review review(String reviewId) {
        return reviews.get(reviewId);
    }

    public List<Review> publishedFor(String sku) {
        return reviews.values().stream().filter(r -> r.sku().equals(sku) && r.countsTowardsRating()).toList();
    }
}
