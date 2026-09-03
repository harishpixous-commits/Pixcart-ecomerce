package com.pixous.pixcart.catalogue.domain.reviews;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Ratings & aggregation — FR-CUS-024.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "compute listing and vendor ratings using a Bayesian-smoothed average over
 *                verified reviews, exposing distribution histograms and recency-weighted trend."
 *   OUTPUTS:    "rating_avg (1 decimal), rating_count, per-star histogram, vendor composite
 *                score (weighting: product 60%, fulfilment 25%, service 15%)."
 *   VALIDATION: "Only published verified reviews count; deleted/moderated-out reviews excluded."
 *   RULES:      "Smoothing prior m=10, C=category mean, to protect low-volume listings from
 *                single-review extremes; vendor score feeds search ranking and payout-risk
 *                tiering."
 *   ACCEPTANCE: "Given a listing with one 1★ review, When displayed, Then shown rating reflects
 *                smoothed value (not raw 1.0)."
 *
 * The smoothing is the requirement's whole purpose: a listing with a single one-star review must
 * not display 1.0, because one review is not evidence of a one-star product. The Bayesian
 * posterior blends the observed ratings with the category mean, weighted by a prior of m=10
 * pseudo-reviews, so a listing's displayed score converges on its true mean only as real volume
 * accumulates.
 *
 *   smoothed = (m × C + Σ stars) / (m + n)
 */
public final class RatingAggregate {

    /** RULES: smoothing prior. */
    public static final int PRIOR_M = 10;

    /** OUTPUTS: vendor composite weighting. */
    public static final double WEIGHT_PRODUCT = 0.60;
    public static final double WEIGHT_FULFILMENT = 0.25;
    public static final double WEIGHT_SERVICE = 0.15;

    public record Histogram(int oneStar, int twoStar, int threeStar, int fourStar, int fiveStar) {
        public int total() { return oneStar + twoStar + threeStar + fourStar + fiveStar; }
        public long starSum() {
            return 1L * oneStar + 2L * twoStar + 3L * threeStar + 4L * fourStar + 5L * fiveStar;
        }
    }

    public record ListingRating(String sku, double smoothedAverage, double displayedAverage,
                                int ratingCount, Histogram histogram, double rawAverage) {}

    private RatingAggregate() {
    }

    /**
     * Build the histogram from reviews, counting ONLY published ones (VALIDATION). A review that
     * was rejected, taken down or is still in the human queue contributes nothing.
     */
    public static Histogram histogramOf(List<ReviewModeration.Review> reviews) {
        int[] buckets = new int[6];
        for (var r : reviews) {
            if (!r.countsTowardsRating()) continue;
            int s = r.stars();
            if (s >= 1 && s <= 5) buckets[s]++;
        }
        return new Histogram(buckets[1], buckets[2], buckets[3], buckets[4], buckets[5]);
    }

    /** The Bayesian posterior mean: (m × C + Σ stars) / (m + n). */
    public static double smoothed(Histogram h, double categoryMean) {
        int n = h.total();
        return (PRIOR_M * categoryMean + h.starSum()) / (double) (PRIOR_M + n);
    }

    /** OUTPUTS: rating_avg is displayed to one decimal. */
    public static double toOneDecimal(double value) {
        return Math.round(value * 10.0) / 10.0;
    }

    /** The raw, unsmoothed mean — retained for analytics, never for display. */
    public static double rawAverage(Histogram h) {
        return h.total() == 0 ? 0.0 : h.starSum() / (double) h.total();
    }

    public static ListingRating forListing(String sku, List<ReviewModeration.Review> reviews, double categoryMean) {
        Histogram h = histogramOf(reviews);
        double s = smoothed(h, categoryMean);
        return new ListingRating(sku, s, toOneDecimal(s), h.total(), h, rawAverage(h));
    }

    /**
     * Vendor composite score: product 60%, fulfilment 25%, service 15%. Each input is itself a
     * smoothed 1–5 score. The weights are asserted to sum to 1 so a future edit cannot silently
     * change the scale of every vendor's score.
     */
    public static double vendorComposite(double productScore, double fulfilmentScore, double serviceScore) {
        double sum = WEIGHT_PRODUCT + WEIGHT_FULFILMENT + WEIGHT_SERVICE;
        if (Math.abs(sum - 1.0) > 1e-9) throw new IllegalStateException("composite weights must sum to 1");
        for (double v : new double[]{productScore, fulfilmentScore, serviceScore}) {
            if (v < 1.0 || v > 5.0) throw new IllegalArgumentException("component scores must be 1..5");
        }
        return WEIGHT_PRODUCT * productScore + WEIGHT_FULFILMENT * fulfilmentScore + WEIGHT_SERVICE * serviceScore;
    }

    /**
     * Recency-weighted trend: the smoothed score over the most recent `window` published reviews
     * minus the smoothed score over everything, so a listing that has recently improved shows a
     * positive trend even while its lifetime average lags.
     */
    public static double trend(List<ReviewModeration.Review> reviewsNewestFirst, int window, double categoryMean) {
        var published = new ArrayList<ReviewModeration.Review>();
        for (var r : reviewsNewestFirst) if (r.countsTowardsRating()) published.add(r);
        if (published.isEmpty()) return 0.0;
        var recent = published.subList(0, Math.min(window, published.size()));
        double recentScore = smoothed(histogramOf(recent), categoryMean);
        double allScore = smoothed(histogramOf(published), categoryMean);
        return Math.round((recentScore - allScore) * 100.0) / 100.0;
    }

    /** Convenience for a payout-risk tier fed by the vendor score (RULES). */
    public enum RiskTier { LOW, MEDIUM, HIGH }

    public static RiskTier payoutRiskTier(double vendorComposite) {
        if (vendorComposite >= 4.2) return RiskTier.LOW;
        if (vendorComposite >= 3.5) return RiskTier.MEDIUM;
        return RiskTier.HIGH;
    }

    /** Category means, keyed by category — the C in the smoothing formula. */
    public static Map<String, Double> categoryMeans(Map<String, List<ReviewModeration.Review>> byCategory) {
        Map<String, Double> out = new LinkedHashMap<>();
        for (var e : byCategory.entrySet()) {
            Histogram h = histogramOf(e.getValue());
            out.put(e.getKey(), h.total() == 0 ? 4.0 : rawAverage(h));
        }
        return out;
    }
}
