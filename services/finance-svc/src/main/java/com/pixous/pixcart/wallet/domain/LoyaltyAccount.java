package com.pixous.pixcart.wallet.domain;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Loyalty account — FR-CUS-020.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "accrue loyalty points on eligible net purchases (post-return), maintain
 *                tier status (Silver/Gold/Platinum) with rolling-12-month qualification,
 *                and expose tier benefits."
 *   RULES:      "Returns claw back points; tier downgrade grace 30 days; benefits stack
 *                with coupons only where flags allow (BRU-14)."
 *   VALIDATION: "Accrual only after return-window lapse; excluded categories configurable;
 *                points integer, 1 pt = ₹1 redemption value unless config differs."
 *   Vol.6 loy_entry/loy_balance: ck_loy_nonneg (points >= 0), tiers.
 *
 * Points are integers and never negative. Accrual is admitted only once the return window
 * has lapsed for the order (so a returned item never earned points to claw back later,
 * except where a partial return happens after accrual — handled by clawback). Tier is a
 * pure function of rolling-12-month qualifying points, with a 30-day grace before a
 * downgrade takes effect. Idempotent on reference.
 */
public final class LoyaltyAccount {

    public enum Tier { SILVER, GOLD, PLATINUM }

    /** Rolling-12-month qualifying-point thresholds (config; these are the defaults). */
    public static final int GOLD_THRESHOLD = 5_000;
    public static final int PLATINUM_THRESHOLD = 20_000;
    public static final int DEFAULT_POINTS_PER_RUPEE = 1;      // 1 pt per ₹1 net
    public static final Duration DOWNGRADE_GRACE = Duration.ofDays(30);

    public record Movement(int points, String reason, String reference, Instant at) {}

    private int points;
    private final List<Movement> ledger = new ArrayList<>();
    private final List<String> seenRefs = new ArrayList<>();
    private Tier tier = Tier.SILVER;
    private Instant downgradePendingSince;
    private Tier downgradeTarget;

    public sealed interface Result {
        record Ok(int points) implements Result {}
        record Idempotent(int points) implements Result {}
        record Rejected(String reason) implements Result {}
    }

    private boolean seen(String ref, String reason) { return seenRefs.contains(ref + "|" + reason); }
    private void mark(String ref, String reason) { seenRefs.add(ref + "|" + reason); }

    /**
     * Accrue points for an order's net purchase value, admitted only after the return
     * window has lapsed (VALIDATION). netPaise is the value net of any returns to date.
     */
    public Result accrue(long netPaise, String reference, Instant returnWindowEndsAt, Instant now) {
        if (now.isBefore(returnWindowEndsAt)) {
            return new Result.Rejected("ACCRUAL_BEFORE_RETURN_WINDOW_LAPSE");
        }
        if (seen(reference, "ACCRUAL")) return new Result.Idempotent(points);
        int earned = (int) (netPaise / 100) * DEFAULT_POINTS_PER_RUPEE; // 1 pt per whole ₹
        if (earned <= 0) return new Result.Rejected("NO_POINTS_FOR_AMOUNT");
        points += earned;
        ledger.add(new Movement(earned, "ACCRUAL", reference, now));
        mark(reference, "ACCRUAL");
        return new Result.Ok(points);
    }

    /** Redeem points at checkout (1 pt = ₹1 unless config differs). Cannot go negative. */
    public Result redeem(int redeemPoints, String reference, Instant now) {
        if (redeemPoints <= 0) return new Result.Rejected("redeem must be positive");
        if (seen(reference, "REDEEM")) return new Result.Idempotent(points);
        if (redeemPoints > points) return new Result.Rejected("INSUFFICIENT_POINTS: need " + redeemPoints + ", have " + points);
        points -= redeemPoints;
        ledger.add(new Movement(-redeemPoints, "REDEEM", reference, now));
        mark(reference, "REDEEM");
        return new Result.Ok(points);
    }

    /** Claw back points when an item is returned after accrual (RULES). Floored at zero. */
    public Result clawback(int clawbackPoints, String reference, Instant now) {
        if (clawbackPoints <= 0) return new Result.Rejected("clawback must be positive");
        if (seen(reference, "CLAWBACK")) return new Result.Idempotent(points);
        int applied = Math.min(clawbackPoints, points); // never below zero
        points -= applied;
        ledger.add(new Movement(-applied, "CLAWBACK", reference, now));
        mark(reference, "CLAWBACK");
        return new Result.Ok(points);
    }

    /** Pure tier from qualifying points. */
    public static Tier tierFor(int qualifyingPoints) {
        if (qualifyingPoints >= PLATINUM_THRESHOLD) return Tier.PLATINUM;
        if (qualifyingPoints >= GOLD_THRESHOLD) return Tier.GOLD;
        return Tier.SILVER;
    }

    /**
     * Recompute tier with the 30-day downgrade grace. An UPGRADE applies immediately; a
     * DOWNGRADE is deferred: it is pending until the grace elapses, at which point it takes
     * effect. Re-qualifying during the grace cancels the pending downgrade.
     */
    public Tier recomputeTier(int rolling12mPoints, Instant now) {
        Tier target = tierFor(rolling12mPoints);
        int cmp = target.compareTo(tier);
        if (cmp > 0) {                       // upgrade — immediate
            tier = target;
            downgradePendingSince = null;
            downgradeTarget = null;
        } else if (cmp < 0) {                // downgrade — deferred with grace
            if (downgradeTarget != target) { downgradePendingSince = now; downgradeTarget = target; }
            if (!now.isBefore(downgradePendingSince.plus(DOWNGRADE_GRACE))) {
                tier = target;
                downgradePendingSince = null;
                downgradeTarget = null;
            }
        } else {                             // same tier — cancel any pending downgrade
            downgradePendingSince = null;
            downgradeTarget = null;
        }
        return tier;
    }

    public int points()            { return points; }
    public Tier tier()             { return tier; }
    public boolean invariantHolds(){ return points >= 0; }
    public List<Movement> statement() { return List.copyOf(ledger); }
}
