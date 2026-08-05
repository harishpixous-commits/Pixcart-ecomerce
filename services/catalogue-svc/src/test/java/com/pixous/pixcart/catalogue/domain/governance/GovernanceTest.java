package com.pixous.pixcart.catalogue.domain.governance;

import com.pixous.pixcart.catalogue.domain.governance.BrandRegistry.Authorisation;
import com.pixous.pixcart.catalogue.domain.governance.BrandRegistry.ClaimState;
import com.pixous.pixcart.catalogue.domain.governance.BrandRegistry.TakedownClaim;
import com.pixous.pixcart.catalogue.domain.governance.CategoryGovernance.AttributeDef;
import com.pixous.pixcart.catalogue.domain.governance.CategoryGovernance.AttributeType;
import com.pixous.pixcart.catalogue.domain.governance.CategoryGovernance.Category;
import com.pixous.pixcart.catalogue.domain.governance.CategoryGovernance.ListingCompliance;
import com.pixous.pixcart.catalogue.domain.governance.CategoryGovernance.Outcome;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/** FR-ADM-005 and FR-ADM-006, with both documented acceptance scenarios encoded verbatim. */
class GovernanceTest {

    private static final Instant NOW = Instant.parse("2026-08-15T10:00:00Z");

    // ==================================================== FR-ADM-005

    @Test
    void categoryTreeIsLimitedToFiveLevels() {
        assertDoesNotThrow(() -> new Category("C5", 5));
        var ex = assertThrows(IllegalArgumentException.class, () -> new Category("C6", 6));
        assertTrue(ex.getMessage().contains("1..5"));
        assertThrows(IllegalArgumentException.class, () -> new Category("C0", 0));
    }

    @Test
    void sareesFabricMandatoryAcceptanceScenario() {
        // "Given attribute 'fabric' made mandatory in Sarees, When published, Then affected
        //  live listings flag 'needs update', remain live 14 days, and PLP facet appears once
        //  >= 100 listings carry values."
        var sarees = new Category("01CATSAREES", 3);
        sarees.putDraftAttribute(new AttributeDef("fabric", AttributeType.ENUM, false, true,
                List.of("silk", "cotton", "linen")));
        sarees.publish(500, NOW);                       // v1: fabric optional

        // now make it mandatory
        sarees.putDraftAttribute(new AttributeDef("fabric", AttributeType.ENUM, true, true,
                List.of("silk", "cotton", "linen")));
        var preview = sarees.previewPublish(500, NOW);
        assertEquals(List.of("fabric"), preview.newlyMandatory());
        assertEquals(500, preview.affectedLiveListings());
        assertEquals(NOW.plus(Duration.ofDays(14)), preview.needsUpdateGraceEndsAt());

        var published = sarees.publish(500, NOW);
        assertEquals(2, sarees.publishedVersion());

        // a live listing without fabric is NEEDS_UPDATE and stays live for 14 days
        Map<String, String> without = Map.of("colour", "navy");
        assertEquals(ListingCompliance.NEEDS_UPDATE, CategoryGovernance.complianceOf(
                without, sarees.publishedSchema(), published.needsUpdateGraceEndsAt(), NOW.plus(Duration.ofDays(13))));
        // on day 15 the grace has lapsed
        assertEquals(ListingCompliance.PAST_GRACE, CategoryGovernance.complianceOf(
                without, sarees.publishedSchema(), published.needsUpdateGraceEndsAt(), NOW.plus(Duration.ofDays(15))));
        // a listing that carries the value is compliant throughout
        assertEquals(ListingCompliance.COMPLIANT, CategoryGovernance.complianceOf(
                Map.of("fabric", "silk"), sarees.publishedSchema(), published.needsUpdateGraceEndsAt(),
                NOW.plus(Duration.ofDays(30))));

        // the PLP facet only appears once >= 100 listings carry values
        assertEquals(List.of(), CategoryGovernance.facetsFor(sarees.publishedSchema(), Map.of("fabric", 99)));
        assertEquals(List.of("fabric"), CategoryGovernance.facetsFor(sarees.publishedSchema(), Map.of("fabric", 100)));
    }

    @Test
    void facetsAreGeneratedFromSchemaNotHandEdited() {
        var c = new Category("01CAT", 2);
        c.putDraftAttribute(new AttributeDef("colour", AttributeType.ENUM, false, true, List.of("navy", "red")));
        c.putDraftAttribute(new AttributeDef("sku_note", AttributeType.STRING, false, false, null));
        c.publish(0, NOW);
        // sku_note is not a facet, so no count can make it appear
        assertEquals(List.of("colour"),
                CategoryGovernance.facetsFor(c.publishedSchema(), Map.of("colour", 200, "sku_note", 5000)));
    }

    @Test
    void deletingACategoryWithLiveListingsIsRefused() {
        var c = new Category("01CAT", 2);
        var refused = assertInstanceOf(Outcome.Rejected.class, c.delete(12));
        assertTrue(refused.reason().startsWith("CATEGORY_HAS_LIVE_LISTINGS"));
        assertInstanceOf(Outcome.Ok.class, c.delete(0));
    }

    @Test
    void attributeTypeChangeRequiresAMigrationPlan() {
        var c = new Category("01CAT", 2);
        c.putDraftAttribute(new AttributeDef("weight", AttributeType.STRING, false, false, null));
        c.publish(0, NOW);
        // STRING -> NUMBER without a plan is refused
        var refused = assertInstanceOf(Outcome.Rejected.class,
                c.putDraftAttribute(new AttributeDef("weight", AttributeType.NUMBER, false, false, null)));
        assertTrue(refused.reason().startsWith("TYPE_CHANGE_REQUIRES_MIGRATION_PLAN"));
        // with a plan reference it proceeds
        assertInstanceOf(Outcome.Ok.class, c.putDraftAttributeWithMigration(
                new AttributeDef("weight", AttributeType.NUMBER, false, false, null), "MIG-2026-08-001"));
        assertInstanceOf(Outcome.Rejected.class, c.putDraftAttributeWithMigration(
                new AttributeDef("weight", AttributeType.NUMBER, false, false, null), "  "));
    }

    @Test
    void enumRemovalIsBlockedWhileReferenced() {
        var c = new Category("01CAT", 2);
        c.putDraftAttribute(new AttributeDef("fabric", AttributeType.ENUM, false, true,
                List.of("silk", "cotton", "linen")));
        c.publish(0, NOW);

        var refused = assertInstanceOf(Outcome.Rejected.class,
                c.removeEnumValue("fabric", "silk", Set.of("silk")));
        assertTrue(refused.reason().startsWith("ENUM_VALUE_REFERENCED_BY_LIVE_LISTINGS"));

        assertInstanceOf(Outcome.Ok.class, c.removeEnumValue("fabric", "linen", Set.of("silk", "cotton")));
        assertEquals(List.of("silk", "cotton"), c.draftSchema().get("fabric").enumValues());

        // an enum cannot be emptied
        c.removeEnumValue("fabric", "cotton", Set.of("silk"));
        assertInstanceOf(Outcome.Rejected.class, c.removeEnumValue("fabric", "silk", Set.of()));
    }

    @Test
    void returnWindowAndCommissionMappingAreBounded() {
        var c = new Category("01CAT", 2);
        assertInstanceOf(Outcome.Ok.class, c.setReturnWindowDays(10));
        assertEquals(10, c.returnWindowDays());
        assertInstanceOf(Outcome.Rejected.class, c.setReturnWindowDays(120));
        assertInstanceOf(Outcome.Ok.class, c.setCommissionRateBps(1500));
        assertInstanceOf(Outcome.Rejected.class, c.setCommissionRateBps(6000));
    }

    @Test
    void enumAttributeWithoutValuesIsUnconstructible() {
        assertThrows(IllegalArgumentException.class,
                () -> new AttributeDef("fabric", AttributeType.ENUM, true, true, List.of()));
    }

    // ==================================================== FR-ADM-006

    private static BrandRegistry registryWithActiveBrand() {
        var r = new BrandRegistry();
        assertInstanceOf(BrandRegistry.Outcome.Ok.class, r.registerBrand("01BRD1", "Kanchi Weaves", "owner-ref-1"));
        assertInstanceOf(BrandRegistry.Outcome.Ok.class, r.approveBrand("01BRD1"));
        return r;
    }

    @Test
    void brandNameDedupeIsNormalised() {
        var r = registryWithActiveBrand();
        // punctuation, case and spacing differences are the same brand
        for (String variant : List.of("kanchi weaves", "KANCHI-WEAVES", "Kanchi  Weaves.", "KanchiWeaves")) {
            var dup = assertInstanceOf(BrandRegistry.Outcome.Rejected.class,
                    r.registerBrand("01BRD-X", variant, "owner-2"));
            assertTrue(dup.reason().startsWith("DUPLICATE_BRAND_NAME"), variant);
        }
        assertInstanceOf(BrandRegistry.Outcome.Ok.class, r.registerBrand("01BRD2", "Chettinad Silks", "owner-3"));
    }

    @Test
    void authorisationMustBeDatedAndExpiring() {
        assertThrows(IllegalArgumentException.class,
                () -> new Authorisation("V1", "01BRD1", "doc-1", NOW, NOW));            // expiry not after issue
        assertThrows(IllegalArgumentException.class,
                () -> new Authorisation("V1", "01BRD1", "  ", NOW, NOW.plusSeconds(60))); // no document
    }

    @Test
    void brandedListingIsGatedToAuthorisedVendors() {
        var r = registryWithActiveBrand();
        assertFalse(r.mayListBrand("V1", "01BRD1", NOW), "no authorisation yet");

        r.addAuthorisation(new Authorisation("V1", "01BRD1", "auth-doc-1",
                NOW.minus(Duration.ofDays(1)), NOW.plus(Duration.ofDays(365))));
        assertTrue(r.mayListBrand("V1", "01BRD1", NOW));
        assertFalse(r.mayListBrand("V2", "01BRD1", NOW), "another vendor is not covered");
    }

    @Test
    void expiredAuthorisationRevokesTheGate() {
        var r = registryWithActiveBrand();
        r.addAuthorisation(new Authorisation("V1", "01BRD1", "auth-doc-1",
                NOW.minus(Duration.ofDays(400)), NOW.minus(Duration.ofDays(1))));
        assertFalse(r.mayListBrand("V1", "01BRD1", NOW), "expiry is enforced, not merely recorded");
    }

    @Test
    void authorisationRequiresAnActiveBrand() {
        var r = new BrandRegistry();
        r.registerBrand("01BRD9", "Pending Brand", "owner");
        var refused = assertInstanceOf(BrandRegistry.Outcome.Rejected.class,
                r.addAuthorisation(new Authorisation("V1", "01BRD9", "doc", NOW, NOW.plus(Duration.ofDays(30)))));
        assertTrue(refused.reason().startsWith("BRAND_NOT_ACTIVE"));
    }

    @Test
    void claimRequiresIdentityRightsBasisAndCitedListings() {
        var r = registryWithActiveBrand();
        assertTrue(assertInstanceOf(BrandRegistry.Outcome.Rejected.class, r.fileTakedown(
                new TakedownClaim("C1", "01BRD1", "", "trademark", List.of("L1"), NOW))).reason()
                .contains("CLAIMANT_IDENTITY_REQUIRED"));
        assertTrue(assertInstanceOf(BrandRegistry.Outcome.Rejected.class, r.fileTakedown(
                new TakedownClaim("C2", "01BRD1", "claimant-1", "", List.of("L1"), NOW))).reason()
                .contains("RIGHTS_BASIS_REQUIRED"));
        assertTrue(assertInstanceOf(BrandRegistry.Outcome.Rejected.class, r.fileTakedown(
                new TakedownClaim("C3", "01BRD1", "claimant-1", "trademark", List.of(), NOW))).reason()
                .contains("NO_LISTINGS_CITED"));
    }

    @Test
    void takedownAcceptanceScenario() {
        // "Given a takedown accepted, When executed, Then all cited listings unpublish within
        //  1 h, vendors are notified with cure/appeal path, and the case log is complete."
        var r = registryWithActiveBrand();
        var cited = List.of("L1", "L2", "L3");
        assertInstanceOf(BrandRegistry.Outcome.Ok.class, r.fileTakedown(
                new TakedownClaim("C-100", "01BRD1", "claimant-identity-ref", "registered trademark TM-123", cited, NOW)));

        var c = r.caseFor("C-100");
        assertInstanceOf(BrandRegistry.Outcome.Ok.class, c.accept("01ADM", NOW.plus(Duration.ofHours(20))));
        assertEquals(ClaimState.ACCEPTED, c.state());
        assertFalse(c.isDecisionSlaBreached(), "decided inside the 48 h SLA");
        assertEquals(NOW.plus(Duration.ofHours(21)), c.executionDeadline());   // +1 h from decision

        assertInstanceOf(BrandRegistry.Outcome.Ok.class, c.execute(NOW.plus(Duration.ofHours(20).plusMinutes(30))));
        assertEquals(cited, c.unpublishedListings());                          // ALL cited listings
        assertTrue(c.isLogComplete());
        var actions = c.caseLog().stream().map(BrandRegistry.CaseLogEntry::action).toList();
        assertTrue(actions.containsAll(List.of("FILED", "ACCEPTED", "EXECUTED", "VENDOR_NOTIFIED")));
    }

    @Test
    void lateDecisionAndLateExecutionAreRecordedAsBreaches() {
        var r = registryWithActiveBrand();
        r.fileTakedown(new TakedownClaim("C-200", "01BRD1", "claimant", "trademark", List.of("L1"), NOW));
        var c = r.caseFor("C-200");
        c.accept("01ADM", NOW.plus(Duration.ofHours(60)));            // past the 48 h SLA
        assertTrue(c.isDecisionSlaBreached());
        c.execute(NOW.plus(Duration.ofHours(65)));                    // past the 1 h execution window
        assertTrue(c.caseLog().stream().anyMatch(e -> e.detail().contains("EXECUTION_SLA_BREACHED")));
    }

    @Test
    void counterNoticePathIsAvailableUntilTheWindowCloses() {
        var r = registryWithActiveBrand();
        r.fileTakedown(new TakedownClaim("C-300", "01BRD1", "claimant", "trademark", List.of("L1"), NOW));
        var c = r.caseFor("C-300");
        c.accept("01ADM", NOW);
        c.execute(NOW);
        assertInstanceOf(BrandRegistry.Outcome.Ok.class,
                c.counterNotice("V1", "evidence://licence.pdf", NOW.plus(Duration.ofDays(9))));
        assertEquals(ClaimState.COUNTER_NOTICED, c.state());

        // and a late counter-notice is refused
        var r2 = registryWithActiveBrand();
        r2.fileTakedown(new TakedownClaim("C-301", "01BRD1", "claimant", "trademark", List.of("L1"), NOW));
        var c2 = r2.caseFor("C-301");
        c2.accept("01ADM", NOW);
        c2.execute(NOW);
        assertTrue(assertInstanceOf(BrandRegistry.Outcome.Rejected.class,
                c2.counterNotice("V1", "evidence://late.pdf", NOW.plus(Duration.ofDays(11))))
                .reason().contains("WINDOW_CLOSED"));
    }

    @Test
    void rejectionNeedsAReasonAndClosesTheCase() {
        var r = registryWithActiveBrand();
        r.fileTakedown(new TakedownClaim("C-400", "01BRD1", "claimant", "trademark", List.of("L1"), NOW));
        var c = r.caseFor("C-400");
        assertInstanceOf(BrandRegistry.Outcome.Rejected.class, c.reject("01ADM", "  ", NOW));
        assertInstanceOf(BrandRegistry.Outcome.Ok.class, c.reject("01ADM", "no rights evidence", NOW));
        assertEquals(ClaimState.REJECTED, c.state());
        assertTrue(c.isLogComplete());
        assertInstanceOf(BrandRegistry.Outcome.Rejected.class, c.execute(NOW), "a rejected claim cannot execute");
    }
}
