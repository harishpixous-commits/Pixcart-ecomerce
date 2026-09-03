package com.pixous.pixcart.finance.domain.statutory;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Statutory deductions & filings support — FR-FIN-007.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "compute marketplace statutory obligations — GST TCS on net taxable supplies,
 *                income-tax TDS (194-O) on gross sales — per vendor per month, reflect them in
 *                settlements, and produce filing-ready exports (GSTR-8 style, TDS statements)
 *                with certificates to vendors."
 *   INPUTS:     "statutory rate config (effective-dated), vendor PAN/GSTIN status."
 *   VALIDATION: "PAN-missing vendors → higher-rate rule + onboarding block flag; register totals
 *                must tie to ledger control accounts."
 *   RULES:      "Rates config-driven with advisor sign-off; corrections flow through
 *                subsequent-month adjustments with trace."
 *   ERRORS:     "Rate change mid-month → split-period computation with both segments shown;
 *                export schema drift versioned."
 *   SECURITY:   "Filings exports access-restricted; certificates tamper-hashed."
 *   ACCEPTANCE: "Given month-end close, When registers generate, Then Σ vendor TCS = TCS
 *                control-ledger balance exactly."
 *
 * This closes a dangling reference: the FR-VEN-010 vendor statement has itemised TCS and TDS
 * components since it was written, but nothing computed them.
 *
 * Two deliberate design positions:
 *
 *  - RATES ARE NEVER CONSTANTS IN THE ARITHMETIC. Statutory rates change by legislation, so every
 *    rate is effective-dated configuration carrying an advisor sign-off reference, and a rate
 *    without that reference is refused. The tests exercise the MECHANISM using the prevailing
 *    rates as fixtures; when the law moves, configuration moves and no code changes.
 *
 *  - THE TWO LEVIES HAVE DIFFERENT BASES, and conflating them is the classic error: GST TCS is
 *    computed on NET TAXABLE SUPPLIES, while income-tax TDS under section 194-O is computed on
 *    GROSS SALES. The types carry their own base so a caller cannot accidentally apply one base
 *    to the other levy.
 */
public final class StatutoryDeductions {

    public enum DeductionType {
        /** GST TCS — base is net taxable supplies. */
        GST_TCS(Base.NET_TAXABLE_SUPPLIES),
        /** Income-tax TDS under section 194-O — base is gross sales. */
        INCOME_TAX_TDS_194O(Base.GROSS_SALES);

        public enum Base { NET_TAXABLE_SUPPLIES, GROSS_SALES }

        private final Base base;

        DeductionType(Base base) {
            this.base = base;
        }

        public Base base() {
            return base;
        }
    }

    /** RULES: rates are config-driven, effective-dated and advisor-signed-off. */
    public record RateConfig(DeductionType type, int rateBps, LocalDate effectiveFrom,
                             String advisorSignOffRef) {}

    /** VALIDATION: PAN status drives the higher-rate rule and the onboarding block. */
    public record VendorTaxStatus(String vendorId, boolean panPresent, boolean gstinPresent) {}

    /**
     * A period's aggregates for one vendor. Both bases are supplied because the two levies use
     * different ones; supplying only one would force this class to guess.
     */
    public record PeriodAggregate(String vendorId, LocalDate from, LocalDate to,
                                  long netTaxableSuppliesPaise, long grossSalesPaise) {}

    /** One computed deduction segment. A mid-month rate change produces more than one. */
    public record DeductionLine(String vendorId, DeductionType type, LocalDate segmentFrom,
                                LocalDate segmentTo, int rateBps, long basePaise, long amountPaise,
                                boolean higherRateApplied, String rateSignOffRef) {}

    public sealed interface ConfigResult {
        record Ok() implements ConfigResult {}
        record Rejected(String reason) implements ConfigResult {}
    }

    public sealed interface ComputeResult {
        record Ok(List<DeductionLine> lines) implements ComputeResult {}
        record Rejected(List<String> violations) implements ComputeResult {}
    }

    /** The higher rate applied when PAN is absent, itself configuration. */
    private final Map<DeductionType, Integer> panMissingRateBps = new LinkedHashMap<>();
    private final List<RateConfig> rates = new ArrayList<>();
    /** vendorId -> flag raised because PAN is missing. */
    private final Map<String, Boolean> onboardingBlocks = new LinkedHashMap<>();

    /** RULES: a rate without an advisor sign-off reference is refused. */
    public ConfigResult registerRate(RateConfig config) {
        if (config.advisorSignOffRef() == null || config.advisorSignOffRef().isBlank()) {
            return new ConfigResult.Rejected("RATE_REQUIRES_ADVISOR_SIGN_OFF");
        }
        if (config.rateBps() < 0 || config.rateBps() > 10_000) {
            return new ConfigResult.Rejected("RATE_OUT_OF_RANGE_BPS");
        }
        rates.add(config);
        return new ConfigResult.Ok();
    }

    public ConfigResult setPanMissingRate(DeductionType type, int rateBps, String advisorSignOffRef) {
        if (advisorSignOffRef == null || advisorSignOffRef.isBlank()) {
            return new ConfigResult.Rejected("RATE_REQUIRES_ADVISOR_SIGN_OFF");
        }
        panMissingRateBps.put(type, rateBps);
        return new ConfigResult.Ok();
    }

    /** The rate in force for a levy on a given date. */
    public Optional<RateConfig> rateOn(DeductionType type, LocalDate date) {
        return rates.stream()
                .filter(r -> r.type() == type && !r.effectiveFrom().isAfter(date))
                .max(Comparator.comparing(RateConfig::effectiveFrom));
    }

    /** Every date within the period on which the rate for this levy changes. */
    public List<LocalDate> rateChangeDatesWithin(DeductionType type, LocalDate from, LocalDate to) {
        return rates.stream()
                .filter(r -> r.type() == type)
                .map(RateConfig::effectiveFrom)
                .filter(d -> d.isAfter(from) && !d.isAfter(to))
                .distinct()
                .sorted()
                .toList();
    }

    /**
     * Compute a levy for one vendor over a period.
     *
     * ERRORS: a rate change inside the period splits it, and BOTH segments are returned so the
     * register shows them rather than a single blended figure nobody can reconcile to a rate.
     *
     * The base is apportioned across segments by day count using cumulative deltas — the same
     * technique the credit-note engine uses — so however many segments a period is cut into, the
     * segment bases sum to EXACTLY the period base and the amounts sum to exactly the levy. No
     * paisa is created or lost by the split.
     */
    public ComputeResult compute(DeductionType type, PeriodAggregate aggregate, VendorTaxStatus status) {
        var violations = new ArrayList<String>();
        if (aggregate.to().isBefore(aggregate.from())) violations.add("PERIOD_INVERTED");
        if (aggregate.netTaxableSuppliesPaise() < 0 || aggregate.grossSalesPaise() < 0) {
            violations.add("NEGATIVE_BASE");
        }
        if (!status.vendorId().equals(aggregate.vendorId())) violations.add("STATUS_VENDOR_MISMATCH");
        if (rateOn(type, aggregate.from()).isEmpty()) violations.add("NO_RATE_IN_FORCE_AT_PERIOD_START");
        if (!violations.isEmpty()) return new ComputeResult.Rejected(List.copyOf(violations));

        // VALIDATION: PAN missing → higher rate, and the onboarding block flag is raised.
        boolean higherRate = !status.panPresent();
        if (higherRate) onboardingBlocks.put(status.vendorId(), true);

        long periodBase = switch (type.base()) {
            case NET_TAXABLE_SUPPLIES -> aggregate.netTaxableSuppliesPaise();
            case GROSS_SALES -> aggregate.grossSalesPaise();
        };

        // segment boundaries: period start, each in-period rate change, period end (exclusive)
        var boundaries = new ArrayList<LocalDate>();
        boundaries.add(aggregate.from());
        boundaries.addAll(rateChangeDatesWithin(type, aggregate.from(), aggregate.to()));
        LocalDate endExclusive = aggregate.to().plusDays(1);

        long totalDays = aggregate.from().datesUntil(endExclusive).count();
        var lines = new ArrayList<DeductionLine>();
        long cumulativeDaysBefore = 0;
        long allocatedSoFar = 0;

        for (int i = 0; i < boundaries.size(); i++) {
            LocalDate segFrom = boundaries.get(i);
            LocalDate segEndExclusive = (i + 1 < boundaries.size()) ? boundaries.get(i + 1) : endExclusive;
            long segDays = segFrom.datesUntil(segEndExclusive).count();
            cumulativeDaysBefore += segDays;

            // cumulative apportionment: the delta between successive cumulative shares, so the
            // segment bases sum to exactly periodBase regardless of rounding
            long cumulativeBase = proportion(periodBase, totalDays, cumulativeDaysBefore);
            long segBase = cumulativeBase - allocatedSoFar;
            allocatedSoFar = cumulativeBase;

            RateConfig applicable = rateOn(type, segFrom).orElseThrow();
            int rateBps = higherRate
                    ? panMissingRateBps.getOrDefault(type, applicable.rateBps())
                    : applicable.rateBps();
            long amount = roundHalfUp(segBase * (long) rateBps, 10_000);

            lines.add(new DeductionLine(status.vendorId(), type, segFrom, segEndExclusive.minusDays(1),
                    rateBps, segBase, amount, higherRate, applicable.advisorSignOffRef()));
        }
        return new ComputeResult.Ok(List.copyOf(lines));
    }

    /** round-half-up of total × n / denominator in integer arithmetic. */
    static long proportion(long total, long denominator, long n) {
        if (denominator <= 0 || n <= 0) return 0;
        if (n >= denominator) return total;
        return (total * n * 2 + denominator) / (2 * denominator);
    }

    static long roundHalfUp(long numerator, long denominator) {
        return (numerator * 2 + denominator) / (2 * denominator);
    }

    /** VALIDATION: PAN-missing vendors carry an onboarding block flag. */
    public boolean isOnboardingBlocked(String vendorId) {
        return onboardingBlocks.getOrDefault(vendorId, false);
    }

    // ------------------------------------------------------------- registers

    /** A vendor-wise monthly register for one levy. */
    public record Register(YearMonth month, DeductionType type, List<DeductionLine> lines,
                           long totalBasePaise, long totalDeductionPaise) {
        public Register {
            lines = List.copyOf(lines);
        }

        /** Per-vendor totals, as the filing export needs them. */
        public Map<String, Long> byVendor() {
            var out = new LinkedHashMap<String, Long>();
            for (DeductionLine l : lines) out.merge(l.vendorId(), l.amountPaise(), Long::sum);
            return out;
        }
    }

    public static Register buildRegister(YearMonth month, DeductionType type, List<DeductionLine> lines) {
        long base = lines.stream().mapToLong(DeductionLine::basePaise).sum();
        long deduction = lines.stream().mapToLong(DeductionLine::amountPaise).sum();
        return new Register(month, type, lines, base, deduction);
    }

    /**
     * ACCEPTANCE: Σ vendor deductions must equal the control-ledger balance EXACTLY. A non-zero
     * difference is returned rather than swallowed, because a statutory register that does not
     * tie out is a filing risk, not a rounding curiosity.
     */
    public static long controlLedgerDifference(Register register, long controlLedgerBalancePaise) {
        return register.totalDeductionPaise() - controlLedgerBalancePaise;
    }

    public static boolean tiesOutToControlLedger(Register register, long controlLedgerBalancePaise) {
        return controlLedgerDifference(register, controlLedgerBalancePaise) == 0;
    }

    // ------------------------------------------------------------- corrections

    /**
     * RULES: corrections flow through a SUBSEQUENT-month adjustment with a trace back to the
     * period being corrected — a filed month is never rewritten.
     */
    public record Adjustment(YearMonth correctedMonth, YearMonth appliedInMonth, String vendorId,
                             DeductionType type, long deltaPaise, String reason, String traceRef) {}

    public sealed interface AdjustmentResult {
        record Ok(Adjustment adjustment) implements AdjustmentResult {}
        record Rejected(String reason) implements AdjustmentResult {}
    }

    public static AdjustmentResult raiseAdjustment(YearMonth correctedMonth, YearMonth appliedInMonth,
                                                   String vendorId, DeductionType type, long deltaPaise,
                                                   String reason, String traceRef) {
        if (!appliedInMonth.isAfter(correctedMonth)) {
            return new AdjustmentResult.Rejected("ADJUSTMENT_MUST_APPLY_IN_A_SUBSEQUENT_MONTH");
        }
        if (deltaPaise == 0) return new AdjustmentResult.Rejected("ADJUSTMENT_DELTA_IS_ZERO");
        if (traceRef == null || traceRef.isBlank()) return new AdjustmentResult.Rejected("TRACE_REF_REQUIRED");
        if (reason == null || reason.trim().length() < 5) return new AdjustmentResult.Rejected("REASON_REQUIRED");
        return new AdjustmentResult.Ok(
                new Adjustment(correctedMonth, appliedInMonth, vendorId, type, deltaPaise, reason, traceRef));
    }

    // ------------------------------------------------------------- exports

    /** ERRORS: export schema drift is versioned, so a downstream filing tool can pin a version. */
    public record Export(String schemaVersion, YearMonth month, DeductionType type,
                         List<String> rows, String accessScope) {}

    /** A GSTR-8-style / TDS-statement export. Access scope is carried so it can be enforced. */
    public static Export export(Register register, String schemaVersion, String accessScope) {
        var rows = new ArrayList<String>();
        rows.add("vendor_id,levy,base_paise,rate_bps,deduction_paise,segment_from,segment_to,sign_off");
        for (DeductionLine l : register.lines()) {
            rows.add(String.join(",", l.vendorId(), l.type().name(), String.valueOf(l.basePaise()),
                    String.valueOf(l.rateBps()), String.valueOf(l.amountPaise()),
                    l.segmentFrom().toString(), l.segmentTo().toString(), l.rateSignOffRef()));
        }
        return new Export(schemaVersion, register.month(), register.type(), List.copyOf(rows), accessScope);
    }

    // ------------------------------------------------------------- certificates

    /** SECURITY: vendor certificates are tamper-hashed. */
    public record Certificate(String vendorId, YearMonth month, DeductionType type,
                              long basePaise, long deductionPaise, String tamperHash) {}

    public static Certificate certificate(String vendorId, YearMonth month, DeductionType type,
                                          List<DeductionLine> vendorLines) {
        long base = vendorLines.stream().mapToLong(DeductionLine::basePaise).sum();
        long deduction = vendorLines.stream().mapToLong(DeductionLine::amountPaise).sum();
        String canonical = String.join("|", vendorId, month.toString(), type.name(),
                String.valueOf(base), String.valueOf(deduction));
        return new Certificate(vendorId, month, type, base, deduction, sha256(canonical));
    }

    public static boolean isCertificateIntact(Certificate c) {
        String canonical = String.join("|", c.vendorId(), c.month().toString(), c.type().name(),
                String.valueOf(c.basePaise()), String.valueOf(c.deductionPaise()));
        return c.tamperHash().equals(sha256(canonical));
    }

    private static String sha256(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            var hex = new StringBuilder(64);
            for (byte b : d) hex.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            return hex.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
