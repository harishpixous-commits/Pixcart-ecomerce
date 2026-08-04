package com.pixous.pixcart.audit;

import com.pixous.pixcart.audit.AuditChain.Entry;
import com.pixous.pixcart.audit.AuditChain.Record;
import com.pixous.pixcart.audit.AuditChain.Verification;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** FR-ADM-013: append-only hash chain, tamper-evidence, entity search. */
class AuditChainTest {

    private static Record rec(String id, String action, String entityId, String before, String after) {
        return new Record(id, "STAFF", "01ADM0000000000000000000AA", action,
                "SETTLEMENT", entityId, before, after, "routine", 1_784_800_000_000L);
    }

    @Test
    void firstEntryChainsFromGenesisAndVerifies() {
        var chain = new AuditChain();
        var e = chain.append(rec("01AUD0000000000000000000AA", "SETTLEMENT_ADJUST", "01SET0000000000000000000AA", null, "{\"amount\":100}"));
        assertArrayEquals(AuditChain.GENESIS_PREV_HASH, e.prevHash());
        assertEquals(32, e.thisHash().length);
        assertEquals(new Verification.Valid(1), chain.verify());
    }

    @Test
    void eachEntryChainsFromThePrevious() {
        var chain = new AuditChain();
        var e1 = chain.append(rec("01AUD0000000000000000000AA", "A", "01E10000000000000000000AAA", null, "{\"v\":1}"));
        var e2 = chain.append(rec("01AUD0000000000000000000AB", "B", "01E20000000000000000000AAA", null, "{\"v\":2}"));
        assertArrayEquals(e1.thisHash(), e2.prevHash(), "e2.prev must equal e1.this");
        assertEquals(new Verification.Valid(2), chain.verify());
    }

    @Test
    void tamperingWithAHistoricalPayloadIsDetectedAtThatEntry() {
        var chain = new AuditChain();
        chain.append(rec("01AUD0000000000000000000AA", "A", "01E10000000000000000000AAA", null, "{\"amount\":100}"));
        chain.append(rec("01AUD0000000000000000000AB", "B", "01E20000000000000000000AAA", null, "{\"amount\":200}"));
        chain.append(rec("01AUD0000000000000000000AC", "C", "01E30000000000000000000AAA", null, "{\"amount\":300}"));

        // Reconstruct the stored chain but ALTER entry 1's after_json (the classic fraud:
        // change a settled amount after the fact), keeping its stored hashes.
        List<Entry> stored = new ArrayList<>(chain.entries());
        Entry victim = stored.get(1);
        Record altered = new Record(victim.record().id(), victim.record().actorType(), victim.record().actorId(),
                victim.record().action(), victim.record().entityType(), victim.record().entityId(),
                victim.record().beforeJson(), "{\"amount\":999}", // <-- tampered value
                victim.record().justification(), victim.record().createdAtMs());
        stored.set(1, new Entry(altered, victim.prevHash(), victim.thisHash())); // keep old hashes

        Verification v = AuditChain.verify(stored);
        var broken = assertInstanceOf(Verification.Broken.class, v);
        assertEquals(1, broken.atIndex());
        assertTrue(broken.reason().contains("tampered") || broken.reason().contains("this_hash"));
    }

    @Test
    void reorderingEntriesBreaksTheChain() {
        var chain = new AuditChain();
        chain.append(rec("01AUD0000000000000000000AA", "A", "01E10000000000000000000AAA", null, "{\"v\":1}"));
        chain.append(rec("01AUD0000000000000000000AB", "B", "01E20000000000000000000AAA", null, "{\"v\":2}"));
        List<Entry> stored = new ArrayList<>(chain.entries());
        // swap the two entries
        Entry tmp = stored.get(0); stored.set(0, stored.get(1)); stored.set(1, tmp);
        assertInstanceOf(Verification.Broken.class, AuditChain.verify(stored));
    }

    @Test
    void deletingAnEntryBreaksTheChain() {
        var chain = new AuditChain();
        chain.append(rec("01AUD0000000000000000000AA", "A", "01E10000000000000000000AAA", null, "{\"v\":1}"));
        chain.append(rec("01AUD0000000000000000000AB", "B", "01E20000000000000000000AAA", null, "{\"v\":2}"));
        chain.append(rec("01AUD0000000000000000000AC", "C", "01E30000000000000000000AAA", null, "{\"v\":3}"));
        List<Entry> stored = new ArrayList<>(chain.entries());
        stored.remove(1); // drop the middle entry
        var broken = assertInstanceOf(Verification.Broken.class, AuditChain.verify(stored));
        assertEquals(1, broken.atIndex());
    }

    @Test
    void canonicalSerialisationIsUnambiguousAcrossFieldBoundaries() {
        // action="ab", entityId="c…" must not canonicalise the same as action="a", entityId="bc…"
        var r1 = rec("01AUD0000000000000000000AA", "ab", "01C0000000000000000000AAAA", null, null);
        var r2 = rec("01AUD0000000000000000000AA", "a", "01BC00000000000000000AAAAA", null, null);
        assertFalse(java.util.Arrays.equals(AuditChain.canonicalBytes(r1), AuditChain.canonicalBytes(r2)));
    }

    @Test
    void nullPayloadDiffersFromEmptyString() {
        var withNull = rec("01AUD0000000000000000000AA", "A", "01E10000000000000000000AAA", null, null);
        var withEmpty = rec("01AUD0000000000000000000AA", "A", "01E10000000000000000000AAA", "", "");
        assertFalse(java.util.Arrays.equals(AuditChain.canonicalBytes(withNull), AuditChain.canonicalBytes(withEmpty)));
    }

    @Test
    void searchByEntityReturnsEventsWithPayload_acceptance() {
        var chain = new AuditChain();
        chain.append(rec("01AUD0000000000000000000AA", "SETTLEMENT_ADJUST", "01SET0000000000000000000AA", "{\"amount\":100}", "{\"amount\":120}"));
        chain.append(rec("01AUD0000000000000000000AB", "OTHER", "01OTH0000000000000000000AA", null, null));
        var hits = chain.findByEntity("SETTLEMENT", "01SET0000000000000000000AA");
        assertEquals(1, hits.size());
        assertEquals("{\"amount\":100}", hits.get(0).record().beforeJson());
        assertEquals("{\"amount\":120}", hits.get(0).record().afterJson());
        // and the whole chain still verifies (acceptance: passes chain verification)
        assertInstanceOf(Verification.Valid.class, chain.verify());
    }

    @Test
    void hashIsStableAndReproducible() {
        var r = rec("01AUD0000000000000000000AA", "A", "01E10000000000000000000AAA", null, "{\"v\":1}");
        byte[] h1 = AuditChain.hash(AuditChain.GENESIS_PREV_HASH, r);
        byte[] h2 = AuditChain.hash(AuditChain.GENESIS_PREV_HASH, r);
        assertArrayEquals(h1, h2);
        assertEquals(64, AuditChain.toHex(h1).length()); // 32 bytes → 64 hex chars
    }
}
