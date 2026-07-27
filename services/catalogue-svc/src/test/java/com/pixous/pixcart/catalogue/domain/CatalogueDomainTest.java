package com.pixous.pixcart.catalogue.domain;

import com.pixous.pixcart.catalogue.domain.approval.ApprovalCase;
import com.pixous.pixcart.catalogue.domain.listing.ListingLifecycle;
import com.pixous.pixcart.catalogue.domain.listing.ListingLifecycle.Event;
import com.pixous.pixcart.catalogue.domain.listing.ListingLifecycle.Result;
import com.pixous.pixcart.catalogue.domain.listing.ListingLifecycle.State;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FR-VEN-003 / BRU-02 lifecycle: the transition table below IS the specification —
 * the test walks every (state × event) pair, so an arrow can neither be lost nor
 * smuggled in. FR-ADM-004: bulk gates and decision invariants as written.
 */
class CatalogueDomainTest {

    private static final Instant NOW = Instant.parse("2026-08-15T10:00:00Z");

    private static List<Event> allEvents() {
        return List.of(new Event.Submit(), new Event.Approve("01ADM"), 
                new Event.Reject("01ADM", List.of("fix images")), new Event.Publish(),
                new Event.Pause(), new Event.Resume(), new Event.RegulatedEdit(),
                new Event.Revise(), new Event.Archive());
    }

    @Test
    void exhaustiveTransitionMatrix() {
        // Legal moves, exactly as FR-VEN-003 states them (Archive arrows marked derived
        // in the domain Javadoc). Everything absent from this map must be Illegal.
        Map<State, Map<Class<?>, State>> legal = new EnumMap<>(State.class);
        legal.put(State.DRAFT, Map.of(
                Event.Submit.class, State.SUBMITTED,
                Event.Archive.class, State.ARCHIVED));
        legal.put(State.SUBMITTED, Map.of(
                Event.Approve.class, State.APPROVED,
                Event.Reject.class, State.REJECTED,
                Event.Archive.class, State.ARCHIVED));
        legal.put(State.APPROVED, Map.of(
                Event.Publish.class, State.LIVE,
                Event.RegulatedEdit.class, State.SUBMITTED,
                Event.Archive.class, State.ARCHIVED));
        legal.put(State.REJECTED, Map.of(
                Event.Revise.class, State.DRAFT,
                Event.Archive.class, State.ARCHIVED));
        legal.put(State.LIVE, Map.of(
                Event.Pause.class, State.PAUSED,
                Event.RegulatedEdit.class, State.SUBMITTED,   // BRU-02 acceptance scenario
                Event.Archive.class, State.ARCHIVED));
        legal.put(State.PAUSED, Map.of(
                Event.Resume.class, State.LIVE,
                Event.RegulatedEdit.class, State.SUBMITTED,
                Event.Archive.class, State.ARCHIVED));
        legal.put(State.ARCHIVED, Map.of());                  // terminal

        int checked = 0;
        for (State from : State.values()) {
            for (Event e : allEvents()) {
                Result r = ListingLifecycle.apply(from, e);
                State expected = legal.get(from).get(e.getClass());
                if (expected != null) {
                    assertEquals(new Result.Moved(expected), r, from + " × " + e.getClass().getSimpleName());
                } else {
                    assertInstanceOf(Result.Illegal.class, r, from + " × " + e.getClass().getSimpleName());
                }
                checked++;
            }
        }
        assertEquals(State.values().length * allEvents().size(), checked); // 7 × 9 = 63 pairs
    }

    @Test
    void mrpEditOnLiveReturnsToSubmitted_bru02Acceptance() {
        Result r = ListingLifecycle.apply(State.LIVE, new Event.RegulatedEdit());
        assertEquals(new Result.Moved(State.SUBMITTED), r);
    }

    @Test
    void rejectionWithoutFixListIsUnconstructible() {
        assertThrows(IllegalArgumentException.class, () -> new Event.Reject("01ADM", List.of()));
        assertThrows(IllegalArgumentException.class, () -> new Event.Reject("01ADM", null));
    }

    @Test
    void actorAssignmentsMatchTheSpec() {
        assertEquals(ListingLifecycle.Actor.SYSTEM, new Event.Publish().actor()); // "within 2 min"
        assertEquals(ListingLifecycle.Actor.ADMIN,  new Event.Approve("01ADM").actor());
        assertEquals(ListingLifecycle.Actor.VENDOR, new Event.Submit().actor());
    }

    // ---------------------------------------------------------- FR-ADM-004

    private static ApprovalCase plain(String id) {
        return new ApprovalCase(id, "01LST" + id, 1, false, false, null);
    }

    @Test
    void bulkExcludesProhibitedItemWithReason_acceptanceScenario() {
        var weaponLike = new ApprovalCase("C-PROHIB", "01LSTX", 1, false, true, "weapon-like");
        var selection = new ArrayList<ApprovalCase>();
        selection.add(weaponLike);
        for (int i = 0; i < 9; i++) selection.add(plain("C" + i));

        var r = ApprovalCase.bulkApprove(selection, 1, "01ADM", NOW);
        var ok = assertInstanceOf(ApprovalCase.BulkResult.Ok.class, r);
        assertEquals(9, ok.outcome().approvedCaseIds().size());
        assertTrue(ok.outcome().excluded().get("C-PROHIB").startsWith("PROHIBITED_REQUIRES_INDIVIDUAL"));
        assertEquals(ApprovalCase.State.PENDING, weaponLike.state(), "still awaits individual adjudication");
    }

    @Test
    void bulkGates_sizeAndSampling() {
        var oversize = new ArrayList<ApprovalCase>();
        for (int i = 0; i <= ApprovalCase.BULK_MAX; i++) oversize.add(plain("O" + i)); // 101
        assertInstanceOf(ApprovalCase.BulkResult.Invalid.class,
                ApprovalCase.bulkApprove(oversize, 20, "01ADM", NOW));

        var fifty = new ArrayList<ApprovalCase>();
        for (int i = 0; i < 50; i++) fifty.add(plain("S" + i));
        var under = ApprovalCase.bulkApprove(fifty, 4, "01ADM", NOW);        // needs ≥ 5
        var inv = assertInstanceOf(ApprovalCase.BulkResult.Invalid.class, under);
        assertTrue(inv.reason().startsWith("SAMPLING_BELOW_10_PERCENT"));
        assertInstanceOf(ApprovalCase.BulkResult.Ok.class,
                ApprovalCase.bulkApprove(fifty, 5, "01ADM", NOW));
    }

    @Test
    void regulatedEditNeedsDiffView_individualAndBulk() {
        var reg = new ApprovalCase("C-REG", "01LSTR", 2, true, false, null);
        var refused = assertInstanceOf(ApprovalCase.DecisionResult.Refused.class,
                reg.approve("01ADM", NOW));
        assertEquals("DIFF_VIEW_REQUIRED for regulated-field edits", refused.reason());

        reg.markDiffViewed();
        assertInstanceOf(ApprovalCase.DecisionResult.Decided.class, reg.approve("01ADM", NOW));
        assertEquals(ApprovalCase.State.APPROVED, reg.state());
        assertEquals("01ADM", reg.decidedBy());
    }

    @Test
    void prohibitedItemApprovableOnlyAfterAdjudicationWithEvidence() {
        var c = new ApprovalCase("C-P", "01LSTP", 1, false, true, "weapon-like");
        assertInstanceOf(ApprovalCase.DecisionResult.Refused.class, c.approve("01ADM", NOW));
        assertThrows(IllegalArgumentException.class, () -> c.adjudicateProhibited("01ADM", " "));
        c.adjudicateProhibited("01ADM", "evidence://case/C-P/photos");
        assertInstanceOf(ApprovalCase.DecisionResult.Decided.class, c.approve("01ADM", NOW));
    }

    @Test
    void rejectionCarriesFixListAndCasesDecideOnce() {
        var c = plain("C-RJ");
        assertInstanceOf(ApprovalCase.DecisionResult.Refused.class,
                c.reject("01ADM", List.of(), NOW));
        var ok = c.reject("01ADM", List.of("image below 1000x1000", "HSN missing"), NOW);
        assertInstanceOf(ApprovalCase.DecisionResult.Decided.class, ok);
        assertEquals(List.of("image below 1000x1000", "HSN missing"), c.fixList());
        // double decision refused
        assertInstanceOf(ApprovalCase.DecisionResult.Refused.class, c.approve("01ADM", NOW));
    }
}
