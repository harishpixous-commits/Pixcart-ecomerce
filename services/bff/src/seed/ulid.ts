/**
 * ULID-style identifiers for the seed: 26-character Crockford base32.
 *
 * Two forms share the same alphabet:
 *
 *  - `ulid()` is the runtime monotonic generator (10 chars of millisecond
 *    timestamp + 16 chars of randomness; calls in the same millisecond increment
 *    the random part so ids stay strictly increasing within a process).
 *
 *  - `seedId(namespace, key)` is DETERMINISTIC: SHA-256 of a stable natural key
 *    (slug, email, code, order key, journal+account+leg …), encoded in the same
 *    alphabet. The seed uses only this form — deterministic primary keys are the
 *    idempotency mechanism. A second run derives the same ids, so every write
 *    becomes an INSERT … ON DUPLICATE KEY UPDATE no-op instead of a new row.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Crockford base32 alphabet: no I, L, O, U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 9; i >= 0; i--) {
    out = CROCKFORD.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

let lastTime = -1;
let lastRandom: number[] = [];

/** Monotonic ULID: 26 chars, strictly increasing within this process. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      const v = lastRandom[i]!;
      if (v < 31) {
        lastRandom[i] = v + 1;
        break;
      }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    lastRandom = Array.from(randomBytes(16), (b) => b % 32);
  }
  return encodeTime(now) + lastRandom.map((c) => CROCKFORD.charAt(c)).join('');
}

/**
 * Deterministic 26-char identifier for a (namespace, natural-key) pair.
 * The same inputs always produce the same id — that is what makes the seed
 * safe to run twice against the same database.
 */
export function seedId(namespace: string, key: string): string {
  const h = createHash('sha256').update(`pixcart/dev-seed/${namespace}/${key}`).digest();
  let out = '';
  for (let i = 0; i < 26; i++) out += CROCKFORD.charAt(h[i]! % 32);
  return out;
}
