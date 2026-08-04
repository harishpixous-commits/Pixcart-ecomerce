package com.pixous.pixcart.wallet.domain;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

/** FR-CUS-019 wallet + FR-CUS-020 loyalty acceptance as tests. */
class WalletLoyaltyTest {

    private static final Instant T0 = Instant.parse("2026-08-15T10:00:00Z");

    // ------------------------------------------------------- wallet

    @Test
    void refundCreditsCashWhichNeverExpires() {
        var w = new Wallet();
        assertInstanceOf(Wallet.Result.Ok.class, w.creditCash(50_000, "REFUND", "ref-1", T0));
        assertEquals(50_000, w.cashBalance());
        // cash is unaffected by time
        assertEquals(50_000, w.spendable(T0.plus(Duration.ofDays(365))));
    }

    @Test
    void promoCreditDefaultsTo90DayExpiry() {
        var w = new Wallet();
        w.creditPromo(10_000, "cb-1", T0, null);
        assertEquals(10_000, w.promoBalance(T0.plus(Duration.ofDays(90)).minusSeconds(1)));
        assertEquals(0, w.promoBalance(T0.plus(Duration.ofDays(90)).plusSeconds(1)), "promo expired after 90 days");
    }

    @Test
    void spendConsumesPromoEarliestExpiryFirstThenCash() {
        var w = new Wallet();
        w.creditCash(100_000, "REFUND", "r-cash", T0);
        w.creditPromo(20_000, "p-late", T0, T0.plus(Duration.ofDays(60)));
        w.creditPromo(15_000, "p-early", T0, T0.plus(Duration.ofDays(10))); // earlier expiry
        // spend 30,000: takes 15,000 from p-early, then 15,000 from p-late; cash untouched
        var r = w.spend(30_000, "order-1", T0);
        assertInstanceOf(Wallet.Result.Ok.class, r);
        assertEquals(100_000, w.cashBalance(), "cash spent only after promo");
        assertEquals(5_000, w.promoBalance(T0)); // 35,000 promo − 30,000 spent
    }

    @Test
    void spendFallsThroughToCashWhenPromoExhausted() {
        var w = new Wallet();
        w.creditCash(100_000, "REFUND", "r-cash", T0);
        w.creditPromo(10_000, "p", T0, T0.plus(Duration.ofDays(30)));
        w.spend(50_000, "order-1", T0);       // 10,000 promo + 40,000 cash
        assertEquals(60_000, w.cashBalance());
        assertEquals(0, w.promoBalance(T0));
    }

    @Test
    void debitCannotExceedBalance_noNegative() {
        var w = new Wallet();
        w.creditCash(20_000, "REFUND", "r", T0);
        var rej = assertInstanceOf(Wallet.Result.Rejected.class, w.spend(20_001, "order-1", T0));
        assertTrue(rej.reason().startsWith("INSUFFICIENT_BALANCE"));
        assertEquals(20_000, w.cashBalance(), "a rejected spend changes nothing");
        assertTrue(w.invariantHolds(T0));
    }

    @Test
    void expiredPromoIsNotSpendable() {
        var w = new Wallet();
        w.creditPromo(10_000, "p", T0, T0.plus(Duration.ofDays(10)));
        Instant later = T0.plus(Duration.ofDays(11));
        assertEquals(0, w.spendable(later));
        assertInstanceOf(Wallet.Result.Rejected.class, w.spend(1, "o", later));
    }

    @Test
    void creditsAndSpendsAreIdempotentOnReference() {
        var w = new Wallet();
        assertInstanceOf(Wallet.Result.Ok.class, w.creditCash(50_000, "REFUND", "ref-DUP", T0));
        assertInstanceOf(Wallet.Result.Idempotent.class, w.creditCash(50_000, "REFUND", "ref-DUP", T0));
        assertEquals(50_000, w.cashBalance(), "replayed credit must not double");
        w.spend(10_000, "spend-DUP", T0);
        assertInstanceOf(Wallet.Result.Idempotent.class, w.spend(10_000, "spend-DUP", T0));
        assertEquals(40_000, w.cashBalance());
    }

    @Test
    void expirePromosRemovesLapsedTranches() {
        var w = new Wallet();
        w.creditPromo(10_000, "p1", T0, T0.plus(Duration.ofDays(10)));
        w.creditPromo(5_000, "p2", T0, T0.plus(Duration.ofDays(100)));
        long expired = w.expirePromos(T0.plus(Duration.ofDays(11)));
        assertEquals(10_000, expired);
        assertEquals(5_000, w.promoBalance(T0.plus(Duration.ofDays(11))));
    }

    // ------------------------------------------------------- loyalty

    @Test
    void accrualOnlyAfterReturnWindowLapses() {
        var l = new LoyaltyAccount();
        Instant windowEnds = T0.plus(Duration.ofDays(7));
        assertInstanceOf(LoyaltyAccount.Result.Rejected.class,
                l.accrue(1_00_000, "ord-1", windowEnds, T0.plus(Duration.ofDays(3))));  // too early
        var ok = l.accrue(1_00_000, "ord-1", windowEnds, windowEnds.plusSeconds(1));    // after window
        assertInstanceOf(LoyaltyAccount.Result.Ok.class, ok);
        assertEquals(1_000, l.points()); // ₹1000 net → 1000 pts
    }

    @Test
    void redeemCannotExceedPointsAndIsIdempotent() {
        var l = new LoyaltyAccount();
        l.accrue(5_00_000, "ord-1", T0, T0); // 5000 pts (window already lapsed at T0)
        assertInstanceOf(LoyaltyAccount.Result.Rejected.class, l.redeem(5_001, "rdm-1", T0));
        assertInstanceOf(LoyaltyAccount.Result.Ok.class, l.redeem(2_000, "rdm-2", T0));
        assertEquals(3_000, l.points());
        assertInstanceOf(LoyaltyAccount.Result.Idempotent.class, l.redeem(2_000, "rdm-2", T0));
        assertEquals(3_000, l.points());
    }

    @Test
    void returnClawsBackPointsFlooredAtZero() {
        var l = new LoyaltyAccount();
        l.accrue(1_00_000, "ord-1", T0, T0); // 1000 pts
        l.clawback(1_500, "ret-1", T0);      // more than held → floored at 0
        assertEquals(0, l.points());
        assertTrue(l.invariantHolds());
    }

    @Test
    void tierThresholdsAndImmediateUpgrade() {
        assertEquals(LoyaltyAccount.Tier.SILVER, LoyaltyAccount.tierFor(4_999));
        assertEquals(LoyaltyAccount.Tier.GOLD, LoyaltyAccount.tierFor(5_000));
        assertEquals(LoyaltyAccount.Tier.PLATINUM, LoyaltyAccount.tierFor(20_000));

        var l = new LoyaltyAccount();
        assertEquals(LoyaltyAccount.Tier.GOLD, l.recomputeTier(6_000, T0)); // upgrade immediate
    }

    @Test
    void downgradeHasThirtyDayGraceAndReQualifyCancelsIt() {
        var l = new LoyaltyAccount();
        l.recomputeTier(6_000, T0);                             // GOLD
        // drop below Gold — downgrade pending, not yet applied
        assertEquals(LoyaltyAccount.Tier.GOLD, l.recomputeTier(1_000, T0.plus(Duration.ofDays(10))));
        // re-qualify during grace cancels the pending downgrade
        assertEquals(LoyaltyAccount.Tier.GOLD, l.recomputeTier(7_000, T0.plus(Duration.ofDays(20))));
        // drop again, and let the grace fully elapse → downgrade applies
        l.recomputeTier(1_000, T0.plus(Duration.ofDays(40)));
        assertEquals(LoyaltyAccount.Tier.SILVER, l.recomputeTier(1_000, T0.plus(Duration.ofDays(71))));
    }
}
