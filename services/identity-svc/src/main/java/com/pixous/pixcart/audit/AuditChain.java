package com.pixous.pixcart.audit;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;

/**
 * Append-only, hash-chained audit log — FR-ADM-013.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "record all privileged, financial and consent-relevant actions to an
 *                append-only, hash-chained audit store."
 *   RULES:      "no delete/update API exists; tamper check runs daily."
 *   ACCEPTANCE: "Given any settlement-adjustment action, When searched by entity id, Then
 *                the event appears with full before/after payload and passes chain verification."
 *   VALIDATION: "Writes only via audit SDK (no direct DB path); clock from trusted source."
 *   Vol.6 adm_audit_event: prev_hash BINARY(32), this_hash BINARY(32) =
 *                SHA-256(prev_hash || canonical(payload)).
 *
 * This is the write-path SDK. It exposes ONLY append and verify — there is deliberately
 * no mutate/delete, mirroring "no delete/update API exists". Each record's this_hash is
 * SHA-256(prev_hash ‖ canonicalBytes(record)); the first record chains from a 32-byte
 * zero genesis. canonicalBytes is a deterministic, injective serialisation so the hash is
 * reproducible byte-for-byte by an independent verifier (the daily tamper check, or the
 * live-DB proof). Any change to a historical field changes that record's hash and, because
 * each link binds the previous hash, every subsequent link — so tampering is detectable at
 * the first altered record.
 */
public final class AuditChain {

    /** The immutable fields that are hashed. Mirrors adm_audit_event's payload columns. */
    public record Record(
            String id,
            String actorType,   // STAFF | VENDOR | CUSTOMER | SYSTEM
            String actorId,
            String action,
            String entityType,
            String entityId,
            String beforeJson,  // may be null
            String afterJson,   // may be null
            String justification, // may be null
            long createdAtMs) {
    }

    /** A record plus its chain hashes, exactly as persisted. */
    public record Entry(Record record, byte[] prevHash, byte[] thisHash) {
    }

    public static final byte[] GENESIS_PREV_HASH = new byte[32]; // 32 zero bytes

    private final List<Entry> entries = new ArrayList<>();

    /**
     * Append a record. Computes this_hash from the current tip's hash (or genesis) and the
     * record's canonical bytes, then commits. There is NO way to modify or remove an entry.
     */
    public Entry append(Record record) {
        if (record.id() == null || record.id().isBlank()) throw new IllegalArgumentException("id");
        if (record.action() == null || record.action().isBlank()) throw new IllegalArgumentException("action");
        byte[] prev = entries.isEmpty() ? GENESIS_PREV_HASH : entries.get(entries.size() - 1).thisHash();
        byte[] hash = hash(prev, record);
        Entry e = new Entry(record, prev, hash);
        entries.add(e);
        return e;
    }

    /** SHA-256(prev_hash ‖ canonicalBytes(record)) — the schema's this_hash definition. */
    public static byte[] hash(byte[] prevHash, Record r) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(prevHash);
            md.update(canonicalBytes(r));
            return md.digest();
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /**
     * Deterministic, injective canonical serialisation. Keys are emitted in a fixed
     * (sorted) order with explicit length prefixes so no field-boundary ambiguity exists
     * (e.g. action="a",entity="bc" cannot collide with action="ab",entity="c"). Nulls are
     * distinguished from empty strings by a marker. This is the exact byte sequence an
     * independent verifier reconstructs, so hashes match across languages/DB.
     */
    static byte[] canonicalBytes(Record r) {
        TreeMap<String, String> fields = new TreeMap<>();
        fields.put("id", r.id());
        fields.put("actorType", r.actorType());
        fields.put("actorId", r.actorId());
        fields.put("action", r.action());
        fields.put("entityType", r.entityType());
        fields.put("entityId", r.entityId());
        fields.put("beforeJson", r.beforeJson());
        fields.put("afterJson", r.afterJson());
        fields.put("justification", r.justification());
        fields.put("createdAtMs", Long.toString(r.createdAtMs()));

        StringBuilder sb = new StringBuilder();
        for (var e : fields.entrySet()) {
            sb.append(e.getKey()).append('=');
            if (e.getValue() == null) {
                sb.append("\u0000NULL\u0000");           // null marker, distinct from ""
            } else {
                sb.append(e.getValue().length()).append(':').append(e.getValue());
            }
            sb.append(';');
        }
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    public sealed interface Verification {
        record Valid(int count) implements Verification {}
        record Broken(int atIndex, String reason) implements Verification {}
    }

    /** Re-derive every link and confirm it matches what is stored (the daily tamper check). */
    public Verification verify() {
        return verify(entries);
    }

    public static Verification verify(List<Entry> chain) {
        byte[] expectedPrev = GENESIS_PREV_HASH;
        for (int i = 0; i < chain.size(); i++) {
            Entry e = chain.get(i);
            if (!MessageDigest.isEqual(e.prevHash(), expectedPrev)) {
                return new Verification.Broken(i, "prev_hash does not match the previous link");
            }
            byte[] recomputed = hash(e.prevHash(), e.record());
            if (!MessageDigest.isEqual(e.thisHash(), recomputed)) {
                return new Verification.Broken(i, "this_hash does not match the record payload (tampered)");
            }
            expectedPrev = e.thisHash();
        }
        return new Verification.Valid(chain.size());
    }

    public List<Entry> entries() {
        return List.copyOf(entries);
    }

    /** ACCEPTANCE: search by entity id returns the events with before/after payload. */
    public List<Entry> findByEntity(String entityType, String entityId) {
        return entries.stream()
                .filter(e -> e.record().entityType().equals(entityType) && e.record().entityId().equals(entityId))
                .toList();
    }

    public static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xF, 16)).append(Character.forDigit(x & 0xF, 16));
        return sb.toString();
    }
}
