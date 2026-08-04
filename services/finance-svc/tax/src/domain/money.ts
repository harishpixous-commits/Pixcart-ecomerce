/**
 * Money primitives for the fee & tax engines. Integer paise throughout (FR-FIN-001/002).
 *
 * These mirror the helpers already proven in the promotions engine (marketing-svc), kept
 * as a local copy so this module compiles standalone in-sandbox; in the monorepo build it
 * is a workspace dependency on the shared money package. GST convention rounds each line's
 * tax HALF-UP (CBIC Rule), which the doc's FR-FIN-002 acceptance assumes ("rounded per
 * rules"); half-even is retained for fee splits where the promotions engine already uses it.
 */

export type Paise = number;

/** Parse a rupee string ("1499.00") to integer paise. */
export function toPaise(s: string): Paise {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a rupee amount: ${s}`);
  const sign = m[1] === '-' ? -1 : 1;
  const rupees = parseInt(m[2], 10);
  const paise = m[3] ? parseInt(m[3].padEnd(2, '0'), 10) : 0;
  return sign * (rupees * 100 + paise);
}

/** Render integer paise as a rupee string. */
export function fromPaise(p: Paise): string {
  const sign = p < 0 ? '-' : '';
  const a = Math.abs(p);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/**
 * Round n/d to nearest integer, ties AWAY from zero (half-up). n ≥ 0, d > 0.
 * GST per-line rounding rule (CBIC): 0.5 paisa rounds up.
 */
export function halfUpDiv(n: number, d: number): number {
  const q = Math.floor(n / d);
  const twiceRem = 2 * (n - q * d);
  return twiceRem >= d ? q + 1 : q;
}

/** Banker's rounding (ties to even) — used for fee splits, matching promotions. */
export function halfEvenDiv(n: number, d: number): number {
  const q = Math.floor(n / d);
  const twiceRem = 2 * (n - q * d);
  if (twiceRem < d) return q;
  if (twiceRem > d) return q + 1;
  return q % 2 === 0 ? q : q + 1;
}
