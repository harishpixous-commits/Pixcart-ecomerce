package com.pixous.pixcart.wallet.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Closed-loop wallet — FR-CUS-019.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "closed-loop wallet holding refund credits and promotional cashback,
 *                usable as partial/full tender at checkout, with statement, expiry rules on
 *                promo balances and KYC-light limits."
 *   RULES:      "Cash bucket never expires; promo default expiry 90 days; wallet-funded
 *                portions refund back to wallet; negative balance impossible by design
 *                (serialised debits)."
 *   VALIDATION: "Debit ≤ balance; promo bucket has earliest-expiry-first consumption;
 *                monthly load cap per KYC tier."
 *   Vol.6 wal_entry/wal_balance: bucket CASH|PROMO, ck_wal_nonneg (>= 0).
 *
 * Two buckets: CASH (never expires — refunds, spendable, itself refundable) and PROMO
 * (cashback, default 90-day expiry). A debit at checkout consumes PROMO earliest-expiry
 * first, then CASH — spending the most perishable money first. A debit can never exceed the
 * (unexpired) balance: negative is impossible by construction. Money is integer paise.
 * Credits/debits are idempotent on a reference so replays never double-apply.
 */
public final class Wallet {

    public enum Bucket { CASH, PROMO }

    public static final int PROMO_DEFAULT_EXPIRY_DAYS = 90;

    /** A promo credit tranche with its own expiry (earliest-first consumption). */
    private record PromoTranche(long remainingPaise, Instant expiresAt, String reference) {}

    public record Movement(Bucket bucket, long amountPaise, String reason, String reference, Instant at) {}

    private long cashPaise;
    private final List<PromoTranche> promoTranches = new ArrayList<>(); // kept sorted by expiry
    private final List<Movement> ledger = new ArrayList<>();
    private final List<String> seenRefs = new ArrayList<>();

    public sealed interface Result {
        record Ok(long cashPaise, long promoPaise) implements Result {}
        record Idempotent(long cashPaise, long promoPaise) implements Result {}
        record Rejected(String reason) implements Result {}
    }

    private boolean seen(String reference, String reason) {
        return seenRefs.contains(reference + "|" + reason);
    }

    private void mark(String reference, String reason) {
        seenRefs.add(reference + "|" + reason);
    }

    /** Credit the CASH bucket (a refund to wallet, BRU-06 / FR-CUS-018). Never expires. */
    public Result creditCash(long amountPaise, String reason, String reference, Instant at) {
        if (amountPaise <= 0) return new Result.Rejected("amount must be positive");
        if (seen(reference, reason)) return new Result.Idempotent(cashPaise, promoBalance(at));
        cashPaise += amountPaise;
        ledger.add(new Movement(Bucket.CASH, amountPaise, reason, reference, at));
        mark(reference, reason);
        return new Result.Ok(cashPaise, promoBalance(at));
    }

    /** Credit a PROMO tranche (cashback). Expiry defaults to +90 days if not given. */
    public Result creditPromo(long amountPaise, String reference, Instant at, Instant expiresAt) {
        if (amountPaise <= 0) return new Result.Rejected("amount must be positive");
        if (seen(reference, "CASHBACK")) return new Result.Idempotent(cashPaise, promoBalance(at));
        Instant exp = expiresAt != null ? expiresAt : at.plusSeconds((long) PROMO_DEFAULT_EXPIRY_DAYS * 86_400);
        promoTranches.add(new PromoTranche(amountPaise, exp, reference));
        promoTranches.sort((a, b) -> a.expiresAt().compareTo(b.expiresAt())); // earliest-first
        ledger.add(new Movement(Bucket.PROMO, amountPaise, "CASHBACK", reference, at));
        mark(reference, "CASHBACK");
        return new Result.Ok(cashPaise, promoBalance(at));
    }

    /** Unexpired promo balance at an instant. */
    public long promoBalance(Instant at) {
        return promoTranches.stream().filter(t -> t.expiresAt().isAfter(at)).mapToLong(PromoTranche::remainingPaise).sum();
    }

    public long cashBalance() {
        return cashPaise;
    }

    /** Total spendable tender at an instant = cash + unexpired promo. */
    public long spendable(Instant at) {
        return cashPaise + promoBalance(at);
    }

    /**
     * Spend at checkout (FR-CUS-019 tender). Consumes PROMO earliest-expiry-first, then
     * CASH. Refused if the requested amount exceeds spendable — the debit <= balance rule,
     * so the wallet can never go negative. Idempotent on the order reference.
     */
    public Result spend(long amountPaise, String reference, Instant at) {
        if (amountPaise <= 0) return new Result.Rejected("amount must be positive");
        if (seen(reference, "SPEND")) return new Result.Idempotent(cashPaise, promoBalance(at));
        if (amountPaise > spendable(at)) {
            return new Result.Rejected("INSUFFICIENT_BALANCE: need " + amountPaise + ", spendable " + spendable(at));
        }
        long remaining = amountPaise;
        // consume unexpired promo tranches, earliest expiry first
        List<PromoTranche> rebuilt = new ArrayList<>();
        for (PromoTranche t : promoTranches) {
            if (remaining == 0 || !t.expiresAt().isAfter(at)) { rebuilt.add(t); continue; }
            long take = Math.min(remaining, t.remainingPaise());
            long left = t.remainingPaise() - take;
            remaining -= take;
            if (left > 0) rebuilt.add(new PromoTranche(left, t.expiresAt(), t.reference()));
        }
        promoTranches.clear();
        promoTranches.addAll(rebuilt);
        if (remaining > 0) { cashPaise -= remaining; remaining = 0; } // then cash
        ledger.add(new Movement(Bucket.CASH, -amountPaise, "SPEND", reference, at));
        mark(reference, "SPEND");
        return new Result.Ok(cashPaise, promoBalance(at));
    }

    /** Expire promo tranches whose time has passed; returns the amount expired. */
    public long expirePromos(Instant at) {
        long expired = promoTranches.stream().filter(t -> !t.expiresAt().isAfter(at)).mapToLong(PromoTranche::remainingPaise).sum();
        promoTranches.removeIf(t -> !t.expiresAt().isAfter(at));
        if (expired > 0) ledger.add(new Movement(Bucket.PROMO, -expired, "EXPIRY", "expiry@" + at, at));
        return expired;
    }

    public boolean invariantHolds(Instant at) {
        return cashPaise >= 0 && promoBalance(at) >= 0;
    }

    public List<Movement> statement() {
        return List.copyOf(ledger);
    }
}
