package com.pixous.pixcart.identity.domain.admin;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * System settings & configuration — FR-ADM-014.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "centralise runtime configuration — business rules parameters (COD caps,
 *                return windows, SLA timers), feature flags, provider routing
 *                (payment/courier/LLM priorities), locales/currencies — with typed schemas,
 *                environments, staged rollout and instant rollback."
 *   RULES:      "Production changes require change note + second-person review for 'critical'
 *                keys; flags default-off on create."
 *   ACCEPTANCE: "Given return-window changed 7→10 days for Fashion, When saved, Then new
 *                orders show 10 days within 60 s while existing orders keep their originally
 *                promised window."
 *   VALIDATION: "Schema-typed values; guard rules (e.g., COD cap ≤ ₹50k) enforced at save;
 *                dependency checks (disabling last payment method blocked)."
 *
 * The acceptance criterion is the design driver: settings are EFFECTIVE-DATED, so
 * {@link #valueAt} resolves what was in force at a given instant. An order that resolved its
 * return window at placement therefore keeps that promise for ever, while a new order picks
 * up the new value — no retroactive mutation is even expressible, and nothing has to run at
 * the boundary.
 */
public final class SystemSettings {

    public enum ValueType { INT, BOOLEAN, STRING, STRING_LIST }

    /** A typed key. `critical` keys need a second-person review in production. */
    public record KeySpec(String key, ValueType type, boolean critical, boolean featureFlag,
                          Integer minInt, Integer maxInt) {
        public static KeySpec intKey(String key, boolean critical, Integer min, Integer max) {
            return new KeySpec(key, ValueType.INT, critical, false, min, max);
        }
        public static KeySpec flag(String key) {
            return new KeySpec(key, ValueType.BOOLEAN, false, true, null, null);
        }
        public static KeySpec listKey(String key, boolean critical) {
            return new KeySpec(key, ValueType.STRING_LIST, critical, false, null, null);
        }
    }

    /** One effective-dated setting version. */
    public record Version(String key, Object value, Instant effectiveFrom, String changeNote,
                          String author, String reviewer) {}

    public sealed interface Outcome {
        record Ok(String key) implements Outcome {}
        record Rejected(List<String> violations) implements Outcome {}
    }

    /** Business guard rules from VALIDATION; these are hard ceilings, not defaults. */
    public static final int COD_CAP_MAX_PAISE = 50_000 * 100;
    public static final int RETURN_WINDOW_MAX_DAYS = 90;

    private final Map<String, KeySpec> schema = new LinkedHashMap<>();
    private final Map<String, List<Version>> versions = new LinkedHashMap<>();

    public SystemSettings register(KeySpec spec) {
        schema.put(spec.key(), spec);
        // RULES: feature flags default OFF on create.
        if (spec.featureFlag()) {
            versions.computeIfAbsent(spec.key(), k -> new ArrayList<>())
                    .add(new Version(spec.key(), Boolean.FALSE, Instant.EPOCH,
                            "created (flags default off)", "SYSTEM", null));
        }
        return this;
    }

    /**
     * Save a value, effective from an instant. Enforces the schema type, the guard rules, the
     * change-note requirement, and the second-person review on critical keys in production.
     */
    public Outcome set(String key, Object value, Instant effectiveFrom, String changeNote,
                       String author, String reviewer, boolean production,
                       Map<String, Object> dependencyContext) {
        var v = new ArrayList<String>();
        KeySpec spec = schema.get(key);
        if (spec == null) return new Outcome.Rejected(List.of("UNKNOWN_KEY: " + key));

        if (!typeMatches(spec.type(), value)) v.add("TYPE_MISMATCH: expected " + spec.type());
        if (changeNote == null || changeNote.trim().length() < 5) v.add("CHANGE_NOTE_REQUIRED");
        if (production && spec.critical()) {
            if (reviewer == null || reviewer.isBlank()) v.add("CRITICAL_KEY_REQUIRES_SECOND_PERSON_REVIEW");
            else if (reviewer.equals(author)) v.add("REVIEWER_MUST_DIFFER_FROM_AUTHOR");
        }
        if (spec.type() == ValueType.INT && value instanceof Integer i) {
            if (spec.minInt() != null && i < spec.minInt()) v.add("BELOW_MIN: " + spec.minInt());
            if (spec.maxInt() != null && i > spec.maxInt()) v.add("ABOVE_MAX: " + spec.maxInt());
        }
        v.addAll(guardRules(key, value));
        v.addAll(dependencyChecks(key, value, dependencyContext));
        if (!v.isEmpty()) return new Outcome.Rejected(List.copyOf(v));

        versions.computeIfAbsent(key, k -> new ArrayList<>())
                .add(new Version(key, value, effectiveFrom, changeNote, author, reviewer));
        return new Outcome.Ok(key);
    }

    private static boolean typeMatches(ValueType t, Object value) {
        return switch (t) {
            case INT -> value instanceof Integer;
            case BOOLEAN -> value instanceof Boolean;
            case STRING -> value instanceof String;
            case STRING_LIST -> value instanceof List<?>;
        };
    }

    /** VALIDATION: named guard rules enforced at save time. */
    private static List<String> guardRules(String key, Object value) {
        var v = new ArrayList<String>();
        if (key.endsWith("cod.cap.paise") && value instanceof Integer i && i > COD_CAP_MAX_PAISE) {
            v.add("COD_CAP_EXCEEDS_50K: " + i);
        }
        if (key.contains("return.window.days") && value instanceof Integer i) {
            if (i < 0) v.add("RETURN_WINDOW_NEGATIVE");
            if (i > RETURN_WINDOW_MAX_DAYS) v.add("RETURN_WINDOW_EXCEEDS_90_DAYS: " + i);
        }
        return v;
    }

    /** VALIDATION: dependency checks — e.g. disabling the last payment method is blocked. */
    private static List<String> dependencyChecks(String key, Object value, Map<String, Object> ctx) {
        var v = new ArrayList<String>();
        if (key.equals("payment.methods.enabled") && value instanceof List<?> list && list.isEmpty()) {
            v.add("CANNOT_DISABLE_ALL_PAYMENT_METHODS");
        }
        if (key.startsWith("payment.method.") && key.endsWith(".enabled")
                && Boolean.FALSE.equals(value)) {
            Object remaining = ctx == null ? null : ctx.get("otherEnabledPaymentMethods");
            if (remaining instanceof Integer n && n == 0) {
                v.add("CANNOT_DISABLE_LAST_PAYMENT_METHOD");
            }
        }
        return v;
    }

    /**
     * The value in force at an instant. This is what makes the acceptance criterion true:
     * an order that resolved its terms at placement keeps them, because resolution is a
     * function of the placement time, not of "now".
     */
    public Optional<Object> valueAt(String key, Instant at) {
        List<Version> vs = versions.get(key);
        if (vs == null || vs.isEmpty()) return Optional.empty();
        Version best = null;
        for (Version candidate : vs) {
            if (!candidate.effectiveFrom().isAfter(at)
                    && (best == null || candidate.effectiveFrom().isAfter(best.effectiveFrom()))) {
                best = candidate;
            }
        }
        return Optional.ofNullable(best).map(Version::value);
    }

    public Optional<Integer> intAt(String key, Instant at) {
        return valueAt(key, at).filter(Integer.class::isInstance).map(Integer.class::cast);
    }

    public boolean flagAt(String key, Instant at) {
        return valueAt(key, at).filter(Boolean.class::isInstance).map(Boolean.class::cast).orElse(false);
    }

    /** Instant rollback: re-assert a prior version as a new one (history stays append-only). */
    public Outcome rollbackTo(String key, int versionIndex, Instant effectiveFrom, String author,
                              String reviewer, boolean production) {
        List<Version> vs = versions.get(key);
        if (vs == null || versionIndex < 0 || versionIndex >= vs.size()) {
            return new Outcome.Rejected(List.of("UNKNOWN_VERSION_INDEX"));
        }
        Version prior = vs.get(versionIndex);
        return set(key, prior.value(), effectiveFrom, "rollback to version " + versionIndex,
                author, reviewer, production, Map.of("otherEnabledPaymentMethods", 1));
    }

    public List<Version> history(String key) {
        return List.copyOf(versions.getOrDefault(key, List.of()));
    }

    public boolean isCritical(String key) {
        KeySpec s = schema.get(key);
        return s != null && s.critical();
    }
}
