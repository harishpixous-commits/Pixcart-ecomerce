package com.pixous.pixcart.identity.domain;

import java.security.SecureRandom;

/**
 * ULID generator — Crockford base32, 26 characters, lexicographically sortable.
 * Every primary key in the platform is CHAR(26) (Vol. 6 §6.1 conventions), so this
 * is shared platform infrastructure. Monotonic within a millisecond: two ids minted
 * in the same ms still sort in mint order, which keeps clustered-index inserts
 * append-only (Vol. 6 §6.6 write-amplification note).
 */
public final class Ulid {

    private static final char[] ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();
    private static final boolean[] VALID = new boolean[128];
    static {
        for (char c : ALPHABET) VALID[c] = true;
    }

    private static final SecureRandom RNG = new SecureRandom();
    private static long lastTimeMs = -1L;
    private static final byte[] lastRandom = new byte[10];

    private Ulid() {
    }

    /** Mint a new ULID at the current instant. */
    public static synchronized String next() {
        return next(System.currentTimeMillis());
    }

    /** Visible for tests: mint at a fixed timestamp (drives the monotonicity proof). */
    static synchronized String next(long timeMs) {
        if (timeMs == lastTimeMs) {
            increment(lastRandom);          // same ms → +1 keeps mint order
        } else {
            RNG.nextBytes(lastRandom);
            lastTimeMs = timeMs;
        }
        return encode(timeMs, lastRandom);
    }

    public static boolean isValid(String s) {
        if (s == null || s.length() != 26) return false;
        for (int i = 0; i < 26; i++) {
            char c = s.charAt(i);
            if (c >= 128 || !VALID[c]) return false;
        }
        return true;
    }

    private static void increment(byte[] b) {
        for (int i = b.length - 1; i >= 0; i--) {
            if (++b[i] != 0) return;        // carry until a byte does not wrap
        }
    }

    private static String encode(long timeMs, byte[] rnd) {
        char[] out = new char[26];
        long t = timeMs & 0xFFFFFFFFFFFFL;              // 48-bit time
        for (int i = 9; i >= 0; i--) {                  // 10 chars × 5 bits
            out[i] = ALPHABET[(int) (t & 31)];
            t >>>= 5;
        }
        long r1 = ((rnd[0] & 0xFFL) << 32) | ((rnd[1] & 0xFFL) << 24)
                | ((rnd[2] & 0xFFL) << 16) | ((rnd[3] & 0xFFL) << 8) | (rnd[4] & 0xFFL);
        long r2 = ((rnd[5] & 0xFFL) << 32) | ((rnd[6] & 0xFFL) << 24)
                | ((rnd[7] & 0xFFL) << 16) | ((rnd[8] & 0xFFL) << 8) | (rnd[9] & 0xFFL);
        for (int i = 17; i >= 10; i--) {                // 8 chars from first 40 bits
            out[i] = ALPHABET[(int) (r1 & 31)];
            r1 >>>= 5;
        }
        for (int i = 25; i >= 18; i--) {                // 8 chars from second 40 bits
            out[i] = ALPHABET[(int) (r2 & 31)];
            r2 >>>= 5;
        }
        return new String(out);
    }
}
