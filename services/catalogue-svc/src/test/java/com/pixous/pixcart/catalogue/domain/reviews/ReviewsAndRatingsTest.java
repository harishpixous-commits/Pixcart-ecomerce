package com.pixous.pixcart.catalogue.domain.reviews;

import com.pixous.pixcart.catalogue.domain.reviews.ReviewModeration.Draft;
import com.pixous.pixcart.catalogue.domain.reviews.ReviewModeration.Outcome;
import com.pixous.pixcart.catalogue.domain.reviews.ReviewModeration.PurchaseFact;
import com.pixous.pixcart.catalogue.domain.reviews.ReviewModeration.Review;
import com.pixous.pixcart.catalogue.domain.reviews.ReviewModeration.ScreenVerdict;
import com.pixous.pixcart.catalogue.domain.reviews.ReviewModeration.State;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-CUS-023 reviews and FR-CUS-024 ratings, with both documented acceptance scenarios encoded
 * verbatim: a non-purchaser is refused, and a listing with a single 1-star review must NOT
 * display 1.0.
 */
class ReviewsAndRatingsTest {

    private static final Instant T0 = Instant.parse("2026-08-15T10:00:00Z");
    private static final List<PurchaseFact> DELIVERED =
            List.of(new PurchaseFact("CUS-1", "SKU-A", "SUB-1", true));

    private static Draft draft(String id, int stars, String body) {
        return new Draft(id, "CUS-1", "SKU-A", "SUB-1", stars, "Good saree", body, 2, 30, false, false);
    }

    private static Review ok(Outcome o) {
        if (o instanceof Outcome.Rejected r) throw new AssertionError("rejected: " + r.violations());
        return ((Outcome.Ok) o).review();
    }

    // ============================================== FR-CUS-023

    @Test
    void nonPurchaserCannotReview_acceptanceScenario() {
        var m = new ReviewModeration();
        var r = m.submit(draft("R1", 5, "Lovely fabric and fast delivery"),
                List.of(), ScreenVerdict.CLEAN, T0);
        var rejected = assertInstanceOf(Outcome.Rejected.class, r);
        assertTrue(rejected.violations().contains("NOT_A_VERIFIED_PURCHASER"));
        assertNull(m.review("R1"), "nothing is stored for an ineligible submission");
    }

    @Test
    void purchasedButNotYetDeliveredIsDistinguishedFromNeverPurchased() {
        var m = new ReviewModeration();
        var r = m.submit(draft("R1", 5, "Arrived quickly"),
                List.of(new PurchaseFact("CUS-1", "SKU-A", "SUB-1", false)), ScreenVerdict.CLEAN, T0);
        var rejected = assertInstanceOf(Outcome.Rejected.class, r);
        assertTrue(rejected.violations().contains("PURCHASE_NOT_YET_DELIVERED"));
    }

    @Test
    void aVerifiedPurchaserMayReviewOncePerSku() {
        var m = new ReviewModeration();
        var first = ok(m.submit(draft("R1", 5, "Beautiful weave"), DELIVERED, ScreenVerdict.CLEAN, T0));
        assertEquals(State.PUBLISHED, first.state());
        assertTrue(first.verifiedBadge());

        var second = assertInstanceOf(Outcome.Rejected.class,
                m.submit(draft("R2", 4, "Second thoughts"), DELIVERED, ScreenVerdict.CLEAN, T0.plusSeconds(60)));
        assertTrue(second.violations().contains("ONE_REVIEW_PER_SKU_PER_CUSTOMER"));
    }

    @Test
    void contentLimitsAndFiltersAreEnforced() {
        var m = new ReviewModeration();
        var long_ = new Draft("R1", "CUS-1", "SKU-A", "SUB-1", 5, "t", "x".repeat(2_001), 0, 0, false, false);
        assertTrue(assertInstanceOf(Outcome.Rejected.class, m.submit(long_, DELIVERED, ScreenVerdict.CLEAN, T0))
                .violations().contains("BODY_EXCEEDS_2000_CHARS"));

        var media = new Draft("R2", "CUS-1", "SKU-A", "SUB-1", 5, "t", "fine", 6, 90, false, false);
        var mv = assertInstanceOf(Outcome.Rejected.class, m.submit(media, DELIVERED, ScreenVerdict.CLEAN, T0)).violations();
        assertTrue(mv.contains("TOO_MANY_PHOTOS"));
        assertTrue(mv.contains("VIDEO_EXCEEDS_60_SECONDS"));

        assertTrue(ReviewModeration.validateContent(draft("R3", 5, "buy at www.elsewhere.com")).contains("URL_NOT_PERMITTED"));
        assertTrue(ReviewModeration.validateContent(draft("R4", 5, "reach me at a@b.com")).contains("EMAIL_ADDRESS_NOT_PERMITTED"));
        assertTrue(ReviewModeration.validateContent(draft("R5", 5, "call +91 98765 43210")).contains("PHONE_NUMBER_NOT_PERMITTED"));
        assertTrue(ReviewModeration.validateContent(draft("R6", 5, "what an idiot seller")).contains("PROFANITY_NOT_PERMITTED"));
        assertTrue(ReviewModeration.validateContent(draft("R7", 0, "fine")).contains("STARS_OUT_OF_RANGE"));
    }

    @Test
    void uncertainAiScreenGoesToTheHumanQueueVisibleToTheAuthorOnly() {
        var m = new ReviewModeration();
        var r = ok(m.submit(draft("R1", 2, "Colour differed slightly"), DELIVERED, ScreenVerdict.UNCERTAIN, T0));
        assertEquals(State.PENDING_HUMAN, r.state());
        assertFalse(r.countsTowardsRating(), "a queued review must not move the rating");

        assertTrue(r.isVisibleTo("CUS-1", false), "the author sees their own pending review");
        assertFalse(r.isVisibleTo("CUS-2", false), "other shoppers do not");
        assertTrue(r.isVisibleTo("CUS-2", true), "an admin does");

        assertFalse(m.isHumanQueueSlaBreached("R1", T0.plus(Duration.ofHours(23))));
        assertTrue(m.isHumanQueueSlaBreached("R1", T0.plus(Duration.ofHours(25))));

        assertEquals(State.PUBLISHED, ok(m.moderate("R1", true, "01MOD", T0.plus(Duration.ofHours(2)))).state());
        assertInstanceOf(Outcome.Rejected.class, m.moderate("R1", true, "01MOD", T0.plus(Duration.ofHours(3))));
    }

    @Test
    void abusiveScreenRejectsOutrightAndCountsForNothing() {
        var m = new ReviewModeration();
        var r = ok(m.submit(draft("R1", 1, "hateful content here"), DELIVERED, ScreenVerdict.ABUSIVE, T0));
        assertEquals(State.REJECTED, r.state());
        assertFalse(r.countsTowardsRating());
        assertFalse(r.isVisibleTo("CUS-1", false));
    }

    @Test
    void editableForThirtyDaysWithEveryVersionRetained() {
        var m = new ReviewModeration();
        ok(m.submit(draft("R1", 3, "Decent but crumpled on arrival"), DELIVERED, ScreenVerdict.CLEAN, T0));
        var edited = ok(m.edit("R1", 5, "Resolved", "Vendor replaced it promptly", T0.plus(Duration.ofDays(29))));
        assertEquals(5, edited.stars());
        assertEquals(2, edited.history().size(), "edit history is retained");
        assertEquals(3, edited.history().get(0).stars(), "the original wording survives");

        assertTrue(assertInstanceOf(Outcome.Rejected.class,
                m.edit("R1", 4, "Later", "Too late", T0.plus(Duration.ofDays(31)))).violations()
                .contains("EDIT_WINDOW_EXPIRED"));
    }

    @Test
    void vendorMayReplyButHasNoDeletePath() {
        var m = new ReviewModeration();
        ok(m.submit(draft("R1", 2, "Ran small"), DELIVERED, ScreenVerdict.CLEAN, T0));
        assertEquals("Sorry about that — we have updated the size chart.",
                ok(m.vendorReply("R1", "01VEND1", "Sorry about that — we have updated the size chart.", T0)).vendorReply());
        assertInstanceOf(Outcome.Rejected.class, m.vendorReply("R1", "01VEND1", "  ", T0));

        // there is no vendor delete method at all
        var deleteMethods = java.util.Arrays.stream(ReviewModeration.class.getMethods())
                .map(java.lang.reflect.Method::getName)
                .filter(n -> n.toLowerCase().contains("delete") || n.toLowerCase().contains("remove"))
                .toList();
        assertTrue(deleteMethods.isEmpty(), "vendors must have no delete path, found: " + deleteMethods);
    }

    @Test
    void takedownRequiresAnAdminAndALoggedReason() {
        var m = new ReviewModeration();
        ok(m.submit(draft("R1", 1, "Nonsense claim"), DELIVERED, ScreenVerdict.CLEAN, T0));
        assertInstanceOf(Outcome.Rejected.class, m.adminTakedown("R1", "", "court order", T0));
        assertInstanceOf(Outcome.Rejected.class, m.adminTakedown("R1", "01ADM", "no", T0));
        var down = ok(m.adminTakedown("R1", "01ADM", "defamatory allegation, legal notice LN-88", T0));
        assertEquals(State.TAKEN_DOWN, down.state());
        assertEquals("defamatory allegation, legal notice LN-88", down.takedownReason());
        assertFalse(down.countsTowardsRating());
        assertInstanceOf(Outcome.Rejected.class, m.edit("R1", 5, "x", "y", T0.plusSeconds(1)));
    }

    @Test
    void helpfulnessVotesExcludeSelfVotesAndUnpublishedReviews() {
        var m = new ReviewModeration();
        ok(m.submit(draft("R1", 4, "Good value overall"), DELIVERED, ScreenVerdict.CLEAN, T0));
        assertInstanceOf(Outcome.Rejected.class, m.voteHelpful("R1", "CUS-1"));
        assertEquals(1, ok(m.voteHelpful("R1", "CUS-2")).helpfulVotes());

        var m2 = new ReviewModeration();
        ok(m2.submit(draft("R2", 4, "Pending one"), DELIVERED, ScreenVerdict.UNCERTAIN, T0));
        assertInstanceOf(Outcome.Rejected.class, m2.voteHelpful("R2", "CUS-2"));
    }

    @Test
    void antiBrigadingVelocityCapAppliesPerCustomer() {
        var m = new ReviewModeration();
        var purchases = new ArrayList<PurchaseFact>();
        for (int i = 0; i < 8; i++) purchases.add(new PurchaseFact("CUS-1", "SKU-" + i, "SUB-" + i, true));
        for (int i = 0; i < ReviewModeration.MAX_REVIEWS_PER_DAY; i++) {
            var d = new Draft("R" + i, "CUS-1", "SKU-" + i, "SUB-" + i, 5, "t", "genuine feedback", 0, 0, false, false);
            assertInstanceOf(Outcome.Ok.class, m.submit(d, purchases, ScreenVerdict.CLEAN, T0.plusSeconds(i)), "review " + i);
        }
        var sixth = new Draft("R9", "CUS-1", "SKU-6", "SUB-6", 5, "t", "genuine feedback", 0, 0, false, false);
        assertTrue(assertInstanceOf(Outcome.Rejected.class, m.submit(sixth, purchases, ScreenVerdict.CLEAN, T0.plusSeconds(10)))
                .violations().contains("REVIEW_VELOCITY_EXCEEDED"));
        // a day later the budget is back
        assertInstanceOf(Outcome.Ok.class, m.submit(sixth, purchases, ScreenVerdict.CLEAN, T0.plus(Duration.ofDays(1)).plusSeconds(11)));
    }

    @Test
    void incentivisedReviewsAreLabelledAndAnonymityMasksTheAuthor() {
        var m = new ReviewModeration();
        var incentivised = new Draft("R1", "CUS-1", "SKU-A", "SUB-1", 5, "t", "sponsored trial unit", 0, 0, true, true);
        var r = ok(m.submit(incentivised, DELIVERED, ScreenVerdict.CLEAN, T0));
        assertEquals("Incentivised review", r.displayLabel());
        assertEquals("A verified buyer", r.displayAuthor("Harish C"));

        var plain = ok(new ReviewModeration().submit(draft("R2", 5, "bought it myself"), DELIVERED, ScreenVerdict.CLEAN, T0));
        assertEquals("", plain.displayLabel());
        assertEquals("Harish C", plain.displayAuthor("Harish C"));
    }

    // ============================================== FR-CUS-024

    private static List<Review> reviewsWithStars(int... stars) {
        var m = new ReviewModeration();
        var purchases = new ArrayList<PurchaseFact>();
        var out = new ArrayList<Review>();
        for (int i = 0; i < stars.length; i++) {
            purchases.add(new PurchaseFact("CUS-" + i, "SKU-A", "SUB-" + i, true));
        }
        for (int i = 0; i < stars.length; i++) {
            var d = new Draft("R" + i, "CUS-" + i, "SKU-A", "SUB-" + i, stars[i], "t", "feedback text", 0, 0, false, false);
            out.add(ok(m.submit(d, purchases, ScreenVerdict.CLEAN, T0.plusSeconds(i))));
        }
        return out;
    }

    @Test
    void singleOneStarReviewDoesNotDisplayAsOnePointZero_acceptanceScenario() {
        // "Given a listing with one 1★ review, When displayed, Then shown rating reflects
        //  smoothed value (not raw 1.0)."
        var reviews = reviewsWithStars(1);
        var rating = RatingAggregate.forListing("SKU-A", reviews, 4.0);

        assertEquals(1, rating.ratingCount());
        assertEquals(1.0, rating.rawAverage(), 1e-9, "the raw mean really is 1.0");
        // smoothed = (10 × 4.0 + 1) / 11 = 3.727...
        assertEquals(3.727, rating.smoothedAverage(), 0.001);
        assertEquals(3.7, rating.displayedAverage(), 1e-9);
        assertNotEquals(1.0, rating.displayedAverage(), "a single review must not define the score");
    }

    @Test
    void smoothingConvergesOnTheTrueMeanAsVolumeGrows() {
        double categoryMean = 4.0;
        int[] fiveOnes = {1, 1, 1, 1, 1};
        double few = RatingAggregate.smoothed(RatingAggregate.histogramOf(reviewsWithStars(fiveOnes)), categoryMean);

        int[] manyOnes = new int[100];
        java.util.Arrays.fill(manyOnes, 1);
        double many = RatingAggregate.smoothed(RatingAggregate.histogramOf(reviewsWithStars(manyOnes)), categoryMean);

        assertTrue(few > many, "with little evidence the prior dominates");
        assertTrue(many < 1.3, "with 100 one-star reviews the score approaches the truth");
        assertTrue(many > 1.0, "but never quite reaches it");
    }

    @Test
    void histogramCountsOnlyPublishedReviews() {
        var m = new ReviewModeration();
        var purchases = List.of(
                new PurchaseFact("CUS-1", "SKU-A", "SUB-1", true),
                new PurchaseFact("CUS-2", "SKU-A", "SUB-2", true),
                new PurchaseFact("CUS-3", "SKU-A", "SUB-3", true));
        var published = ok(m.submit(new Draft("R1", "CUS-1", "SKU-A", "SUB-1", 5, "t", "great", 0, 0, false, false),
                purchases, ScreenVerdict.CLEAN, T0));
        var pending = ok(m.submit(new Draft("R2", "CUS-2", "SKU-A", "SUB-2", 1, "t", "unsure", 0, 0, false, false),
                purchases, ScreenVerdict.UNCERTAIN, T0));
        var rejected = ok(m.submit(new Draft("R3", "CUS-3", "SKU-A", "SUB-3", 1, "t", "abusive", 0, 0, false, false),
                purchases, ScreenVerdict.ABUSIVE, T0));

        var h = RatingAggregate.histogramOf(List.of(published, pending, rejected));
        assertEquals(1, h.total(), "only the published review counts");
        assertEquals(1, h.fiveStar());
        assertEquals(0, h.oneStar());

        // and a takedown removes it again
        m.adminTakedown("R1", "01ADM", "policy breach confirmed", T0.plusSeconds(10));
        assertEquals(0, RatingAggregate.histogramOf(List.of(published)).total());
    }

    @Test
    void histogramAndCountsAreExposedPerStar() {
        var h = RatingAggregate.histogramOf(reviewsWithStars(5, 5, 4, 3, 1));
        assertEquals(5, h.total());
        assertEquals(2, h.fiveStar());
        assertEquals(1, h.fourStar());
        assertEquals(1, h.threeStar());
        assertEquals(0, h.twoStar());
        assertEquals(1, h.oneStar());
        assertEquals(18, h.starSum());
        assertEquals(3.6, RatingAggregate.rawAverage(h), 1e-9);
    }

    @Test
    void anUnreviewedListingShowsTheCategoryMeanNotZero() {
        var rating = RatingAggregate.forListing("SKU-NEW", List.of(), 4.2);
        assertEquals(0, rating.ratingCount());
        assertEquals(4.2, rating.displayedAverage(), 1e-9);
        assertEquals(0.0, rating.rawAverage(), 1e-9);
    }

    @Test
    void vendorCompositeUsesTheDocumentedWeighting() {
        // 60/25/15 over product/fulfilment/service
        assertEquals(4.0 * 0.6 + 3.0 * 0.25 + 5.0 * 0.15,
                RatingAggregate.vendorComposite(4.0, 3.0, 5.0), 1e-9);
        assertEquals(4.5, RatingAggregate.vendorComposite(4.5, 4.5, 4.5), 1e-9);
        assertThrows(IllegalArgumentException.class, () -> RatingAggregate.vendorComposite(0.9, 4.0, 4.0));
        assertThrows(IllegalArgumentException.class, () -> RatingAggregate.vendorComposite(4.0, 5.1, 4.0));
    }

    @Test
    void payoutRiskTierFollowsTheVendorScore() {
        assertEquals(RatingAggregate.RiskTier.LOW, RatingAggregate.payoutRiskTier(4.3));
        assertEquals(RatingAggregate.RiskTier.MEDIUM, RatingAggregate.payoutRiskTier(3.6));
        assertEquals(RatingAggregate.RiskTier.HIGH, RatingAggregate.payoutRiskTier(3.4));
    }

    @Test
    void recencyTrendIsPositiveWhenRecentReviewsImprove() {
        // newest first: recent 5s after older 1s
        var reviews = reviewsWithStars(1, 1, 1, 1, 5, 5, 5, 5);
        var newestFirst = new ArrayList<>(reviews);
        java.util.Collections.reverse(newestFirst);
        double t = RatingAggregate.trend(newestFirst, 4, 4.0);
        assertTrue(t > 0, "an improving listing shows a positive trend, got " + t);

        var flat = reviewsWithStars(4, 4, 4, 4, 4, 4);
        assertEquals(0.0, RatingAggregate.trend(flat, 3, 4.0), 0.001);
        assertEquals(0.0, RatingAggregate.trend(List.of(), 3, 4.0), 1e-9);
    }

    @Test
    void categoryMeansFallBackToFourWhenACategoryHasNoReviews() {
        var means = RatingAggregate.categoryMeans(java.util.Map.of(
                "SAREES", reviewsWithStars(5, 4, 3),
                "EMPTY", List.of()));
        assertEquals(4.0, means.get("SAREES"), 1e-9);
        assertEquals(4.0, means.get("EMPTY"), 1e-9);
    }
}
