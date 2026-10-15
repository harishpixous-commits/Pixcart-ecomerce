/**
 * Shared BFF helpers: money, JSON, timestamps, keyset cursors.
 *
 * Money convention (contracts/dto.ts): the wire carries INTEGER PAISE. The
 * database stores money two ways and this module is the single conversion
 * point so no handler ever re-derives the rule:
 *
 *   - DECIMAL(12,2) columns (cat_listing.mrp, ord_order.grand_total …) arrive
 *     from the mariadb driver as STRINGS ("14249.05") → `paise()` multiplies
 *     by 100 and rounds.
 *   - `*_paise BIGINT` columns (wal_entry.amount_paise, cart_line.unit_mrppaise
 *     …) arrive as native BigInt → `paise()` converts exactly (every value in
 *     the schema fits double precision; 10^12 paise << 2^53).
 *
 * `dec()` is the inverse, used only at the INSERT/UPDATE boundary where a
 * DECIMAL(12,2) column needs a string.
 */

/** Integer paise from any DB money representation. Refuses anything else. */
export function paise(dbValue: unknown): number {
  if (typeof dbValue === 'bigint') return Number(dbValue);
  if (typeof dbValue === 'number') {
    if (!Number.isFinite(dbValue)) throw new Error(`non-finite money: ${dbValue}`);
    return Math.round(dbValue);
  }
  if (typeof dbValue === 'string') {
    const n = Number(dbValue);
    if (!Number.isFinite(n)) throw new Error(`not money: ${dbValue}`);
    return Math.round(n * 100);
  }
  throw new Error(`not money: ${String(dbValue)}`);
}

/** Integer paise → DECIMAL(12,2) string for the insert/update boundary. */
export function dec(paiseValue: number): string {
  if (!Number.isInteger(paiseValue)) throw new Error(`paise must be an integer: ${paiseValue}`);
  return (paiseValue / 100).toFixed(2);
}

/** Safe numeric coercion for COUNT/INT columns (the driver returns BigInt for BIGINT). */
export function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return 0;
}

/** Parse a JSON text column; the driver already parses JSON objects, so both shapes occur. */
export function jsonCol<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v as T;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** ISO-8601 string from a driver Date (or pass through an existing string). */
export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return String(v);
}

/** NULL-safe ISO timestamp. */
export function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return iso(v);
}

/* ------------------------------------------------------------------ *
 * Keyset cursors — Vol. 7 §7.3: every list is a cursor page, never an
 * offset page. The cursor is base64url(JSON) of the last row's sort key.
 * ------------------------------------------------------------------ */

export interface CursorKey {
  /** Primary sort value (timestamp string or integer paise …). */
  k: string | number;
  /** Tie-break id: ULID sort order == creation order. */
  id: string;
}

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | null): CursorKey | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorKey;
    if (parsed && typeof parsed.id === 'string' && (typeof parsed.k === 'string' || typeof parsed.k === 'number')) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Clamp a client-supplied page size into (0, hardMax]. */
export function limitOf(raw: string | null, dflt: number, hardMax: number): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return dflt;
  return Math.min(n, hardMax);
}
