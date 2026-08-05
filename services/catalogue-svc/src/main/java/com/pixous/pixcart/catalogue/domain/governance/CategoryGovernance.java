package com.pixous.pixcart.catalogue.domain.governance;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Category & attribute governance — FR-ADM-005.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "manage the category tree (≤ 5 levels), category attribute schemas (typed,
 *                mandatory flags, facets), size charts, return-window & commission mapping,
 *                with draft→publish versioning and impact preview."
 *   RULES:      "Publish is atomic and cache-invalidated ≤ 2 min; search facets regenerate
 *                from schema (no hand-edits)."
 *   ACCEPTANCE: "Given attribute 'fabric' made mandatory in Sarees, When published, Then
 *                affected live listings flag 'needs update', remain live 14 days, and PLP
 *                facet appears once ≥ 100 listings carry values."
 *   VALIDATION: "No deleting nodes with live listings (merge/move instead); attribute type
 *                changes require migration plan; enum removals blocked while referenced."
 *
 * Pure domain. A schema is edited as a DRAFT and published atomically: publishing returns an
 * {@link ImpactPreview} that names the newly-mandatory attributes, the live listings that
 * must be updated, and the date their 14-day grace expires — so an operator sees the blast
 * radius before committing. The guards that protect existing data (no deleting a node with
 * live listings, no untyped type change, no enum removal while referenced) are refusals, not
 * warnings.
 */
public final class CategoryGovernance {

    public static final int MAX_TREE_DEPTH = 5;
    /** Affected live listings stay live for this long while vendors add the new value. */
    public static final Duration NEEDS_UPDATE_GRACE = Duration.ofDays(14);
    /** A facet only appears on the PLP once enough listings carry values. */
    public static final int FACET_MIN_LISTINGS_WITH_VALUES = 100;

    public enum AttributeType { STRING, NUMBER, BOOLEAN, ENUM, DIMENSION }

    public enum SchemaState { DRAFT, PUBLISHED }

    /** A typed attribute definition. `facet` drives PLP facet generation from the schema. */
    public record AttributeDef(String name, AttributeType type, boolean mandatory, boolean facet,
                               List<String> enumValues) {
        public AttributeDef {
            if (name == null || name.isBlank()) throw new IllegalArgumentException("attribute name");
            if (type == AttributeType.ENUM && (enumValues == null || enumValues.isEmpty())) {
                throw new IllegalArgumentException("ENUM attribute requires values: " + name);
            }
            enumValues = enumValues == null ? List.of() : List.copyOf(enumValues);
        }
    }

    public sealed interface Outcome {
        record Ok() implements Outcome {}
        record Rejected(String reason) implements Outcome {}
    }

    /** What publishing a draft will do — shown before the operator commits. */
    public record ImpactPreview(String categoryId, int fromVersion, int toVersion,
                                List<String> newlyMandatory, int affectedLiveListings,
                                Instant needsUpdateGraceEndsAt, List<String> newFacets) {}

    /** A category node with its published and draft schemas. */
    public static final class Category {
        private final String categoryId;
        private final int depth;                 // 1 = root
        private final Map<String, AttributeDef> published = new LinkedHashMap<>();
        private final Map<String, AttributeDef> draft = new LinkedHashMap<>();
        private int publishedVersion;
        private SchemaState draftState = SchemaState.DRAFT;
        private int returnWindowDays = 7;
        private int commissionRateBps = 1000;

        public Category(String categoryId, int depth) {
            if (depth < 1 || depth > MAX_TREE_DEPTH) {
                throw new IllegalArgumentException("category depth must be 1.." + MAX_TREE_DEPTH + " (got " + depth + ")");
            }
            this.categoryId = categoryId;
            this.depth = depth;
        }

        public Outcome putDraftAttribute(AttributeDef def) {
            AttributeDef existing = published.get(def.name());
            // VALIDATION: an attribute TYPE change needs an explicit migration plan.
            if (existing != null && existing.type() != def.type()) {
                return new Outcome.Rejected("TYPE_CHANGE_REQUIRES_MIGRATION_PLAN: " + def.name()
                        + " " + existing.type() + "->" + def.type());
            }
            draft.put(def.name(), def);
            return new Outcome.Ok();
        }

        /** A typed change is permitted only with a migration plan reference. */
        public Outcome putDraftAttributeWithMigration(AttributeDef def, String migrationPlanRef) {
            if (migrationPlanRef == null || migrationPlanRef.isBlank()) {
                return new Outcome.Rejected("MIGRATION_PLAN_REF_REQUIRED");
            }
            draft.put(def.name(), def);
            return new Outcome.Ok();
        }

        /**
         * VALIDATION: an enum value cannot be removed while listings still reference it.
         * `referencedValues` is supplied by the catalogue (a live count per value).
         */
        public Outcome removeEnumValue(String attributeName, String value, Set<String> referencedValues) {
            AttributeDef def = draft.getOrDefault(attributeName, published.get(attributeName));
            if (def == null) return new Outcome.Rejected("UNKNOWN_ATTRIBUTE: " + attributeName);
            if (def.type() != AttributeType.ENUM) return new Outcome.Rejected("NOT_AN_ENUM: " + attributeName);
            if (referencedValues.contains(value)) {
                return new Outcome.Rejected("ENUM_VALUE_REFERENCED_BY_LIVE_LISTINGS: " + value);
            }
            var remaining = new ArrayList<>(def.enumValues());
            if (!remaining.remove(value)) return new Outcome.Rejected("VALUE_NOT_IN_ENUM: " + value);
            if (remaining.isEmpty()) return new Outcome.Rejected("ENUM_CANNOT_BE_EMPTIED: " + attributeName);
            draft.put(attributeName, new AttributeDef(def.name(), def.type(), def.mandatory(), def.facet(), remaining));
            return new Outcome.Ok();
        }

        /**
         * Preview the effect of publishing the draft. Newly-mandatory attributes are the ones
         * that force existing live listings into "needs update".
         */
        public ImpactPreview previewPublish(int liveListingCount, Instant now) {
            var newlyMandatory = new ArrayList<String>();
            var newFacets = new ArrayList<String>();
            for (var e : draft.entrySet()) {
                AttributeDef next = e.getValue();
                AttributeDef prev = published.get(e.getKey());
                if (next.mandatory() && (prev == null || !prev.mandatory())) newlyMandatory.add(e.getKey());
                if (next.facet() && (prev == null || !prev.facet())) newFacets.add(e.getKey());
            }
            int affected = newlyMandatory.isEmpty() ? 0 : liveListingCount;
            return new ImpactPreview(categoryId, publishedVersion, publishedVersion + 1,
                    List.copyOf(newlyMandatory), affected, now.plus(NEEDS_UPDATE_GRACE), List.copyOf(newFacets));
        }

        /** Publish atomically: the draft becomes the published schema, version increments. */
        public ImpactPreview publish(int liveListingCount, Instant now) {
            ImpactPreview preview = previewPublish(liveListingCount, now);
            published.clear();
            published.putAll(draft);
            publishedVersion++;
            draftState = SchemaState.PUBLISHED;
            return preview;
        }

        /**
         * VALIDATION: a node with live listings may not be deleted — it must be merged or
         * moved so the listings keep a home.
         */
        public Outcome delete(int liveListingCount) {
            if (liveListingCount > 0) {
                return new Outcome.Rejected("CATEGORY_HAS_LIVE_LISTINGS_MERGE_OR_MOVE_INSTEAD: " + liveListingCount);
            }
            return new Outcome.Ok();
        }

        public Outcome setReturnWindowDays(int days) {
            if (days < 0 || days > 90) return new Outcome.Rejected("RETURN_WINDOW_OUT_OF_RANGE");
            this.returnWindowDays = days;
            return new Outcome.Ok();
        }

        public Outcome setCommissionRateBps(int bps) {
            if (bps < 0 || bps > 5000) return new Outcome.Rejected("COMMISSION_RATE_OUT_OF_RANGE");
            this.commissionRateBps = bps;
            return new Outcome.Ok();
        }

        public String categoryId()            { return categoryId; }
        public int depth()                    { return depth; }
        public int publishedVersion()         { return publishedVersion; }
        public SchemaState draftState()       { return draftState; }
        public int returnWindowDays()         { return returnWindowDays; }
        public int commissionRateBps()        { return commissionRateBps; }
        public Map<String, AttributeDef> publishedSchema() { return Map.copyOf(published); }
        public Map<String, AttributeDef> draftSchema()     { return Map.copyOf(draft); }
    }

    private CategoryGovernance() {
    }

    /** RULES: facets regenerate FROM the schema — never hand-edited. */
    public static List<String> facetsFor(Map<String, AttributeDef> schema, Map<String, Integer> valueCounts) {
        var out = new ArrayList<String>();
        for (var e : schema.entrySet()) {
            if (!e.getValue().facet()) continue;
            if (valueCounts.getOrDefault(e.getKey(), 0) >= FACET_MIN_LISTINGS_WITH_VALUES) out.add(e.getKey());
        }
        return out;
    }

    /** A live listing's compliance with a newly-published schema. */
    public enum ListingCompliance { COMPLIANT, NEEDS_UPDATE, PAST_GRACE }

    /**
     * ACCEPTANCE: a live listing missing a newly-mandatory attribute is flagged NEEDS_UPDATE
     * and stays live for 14 days; after the grace it is PAST_GRACE (the catalogue service
     * then pauses it).
     */
    public static ListingCompliance complianceOf(Map<String, String> listingAttributes,
                                                 Map<String, AttributeDef> publishedSchema,
                                                 Instant graceEndsAt, Instant now) {
        boolean missingMandatory = publishedSchema.values().stream()
                .filter(AttributeDef::mandatory)
                .anyMatch(d -> {
                    String v = listingAttributes.get(d.name());
                    return v == null || v.isBlank();
                });
        if (!missingMandatory) return ListingCompliance.COMPLIANT;
        return now.isAfter(graceEndsAt) ? ListingCompliance.PAST_GRACE : ListingCompliance.NEEDS_UPDATE;
    }
}
