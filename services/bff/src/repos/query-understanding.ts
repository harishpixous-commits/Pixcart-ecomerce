/**
 * VERBATIM PORT of `services/discovery-svc/src/domain/query.ts` (FR-CUS-009 +
 * FR-CUS-010 query understanding), including its normative header.
 *
 * Why a port instead of an import - measured in this session, not assumed:
 *   1. `tsc -p tsconfig.json` rejects the cross-package import with TS6059
 *      ("File '.../discovery-svc/src/domain/query.ts' is not under 'rootDir'
 *      'services/bff/src'"): the BFF compiles with `rootDir: src` and the
 *      sibling package ships TypeScript sources with no build output.
 *   2. Node 18.20 (this machine) cannot strip types at runtime either, and
 *      there is no compiled `query.js` to load - `discovery-svc` has no build
 *      script, only vitest.
 * Editing tsconfig's rootDir was not an option (the task scope permits only a
 * test-exclude edit), and vendoring compiled JS would hide drift.
 *
 * RULE FOR FUTURE READERS: this file must stay behaviourally identical to the
 * discovery-svc source. If `query.ts` changes, change this copy in the same
 * commit - a divergence here is a second behaviour wearing one name
 * (CLAUDE.md section 5). The parity is asserted by `query-understanding.test.ts`.
 * The ONLY mechanical adjustment: non-null assertions on regex captures,
 * required because the BFF compiles with `noUncheckedIndexedAccess: true`
 * while discovery-svc does not. No logic changed.
 *
 * ---- original header ----
 * Pure and deterministic. The doc's own example query is a test case, and so is a
 * Tamil/English (Tanglish) query - Tamil script is preserved as free text for the lexical
 * and vector layers while numeric constraints are still extracted, which is exactly the
 * "unparsable parts fall back gracefully" requirement.
 */

export type Paise = number;

export interface ParsedConstraints {
  /** Residual free text after removing recognised constraint phrases. */
  text: string;
  maxPricePaise?: Paise;
  minPricePaise?: Paise;
  minRating?: number;
  /** Constraint phrases that were recognised but dropped (not in the attribute schema). */
  droppedConstraints: string[];
}

export type QueryResult =
  | { ok: true; parsed: ParsedConstraints }
  | { ok: false; policyMessage: string };

/** Regulated / banned terms return a policy message instead of results (FR-CUS-009 RULES). */
export const BANNED_TERMS: readonly string[] = [
  'weapon', 'firearm', 'pistol', 'ammunition', 'explosive', 'narcotic',
  'ivory', 'human organ', 'counterfeit currency',
];

export const POLICY_MESSAGE =
  'This search relates to items that cannot be listed or sold on the platform. ' +
  'Please see the Prohibited Items policy.';

/** U+0000..U+001F and U+007F, built from a string so no raw control byte lives in this file. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

/** Strip control characters and query-syntax metacharacters; collapse whitespace. */
export function sanitise(raw: string): string {
  return raw
    .replace(CONTROL_CHARS, ' ')
    .replace(/[<>{}[\]\\^~"]/g, ' ')      // lucene/vector-store metacharacters
    .replace(/\s+/g, ' ')
    .trim();
}

function containsBannedTerm(q: string): boolean {
  const lower = q.toLowerCase();
  return BANNED_TERMS.some((t) => lower.includes(t));
}

/** "8k" -> 800000 paise, "8,000" -> 800000, "8000" -> 800000. Rupees -> paise. */
function rupeesToPaise(token: string): Paise | undefined {
  const cleaned = token.replace(/[₹,\s]/g, '').toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(k|l|lakh|cr)?$/.exec(cleaned);
  if (!m) return undefined;
  let rupees = parseFloat(m[1]!);
  switch (m[2]) {
    case 'k': rupees *= 1_000; break;
    case 'l':
    case 'lakh': rupees *= 100_000; break;
    case 'cr': rupees *= 10_000_000; break;
    default: break;
  }
  return Math.round(rupees * 100);
}

/**
 * Constraint patterns. Each removes its matched phrase from the residual text. Ordered
 * longest-intent-first so "between X and Y" wins over the bare "under Y".
 * Tanglish support: the Tamil postposition forms "...kku keela/kizhe" (below) and
 * "...kku mele" (above) are recognised alongside the English forms.
 */
const PATTERNS: Array<{
  re: RegExp;
  apply: (m: RegExpMatchArray, c: ParsedConstraints) => void;
}> = [
  {
    re: /\bbetween\s+(₹?[\d.,]+\s*(?:k|l|lakh|cr)?)\s+(?:and|to|-)\s+(₹?[\d.,]+\s*(?:k|l|lakh|cr)?)\b/i,
    apply: (m, c) => {
      const lo = rupeesToPaise(m[1]!);
      const hi = rupeesToPaise(m[2]!);
      if (lo !== undefined) c.minPricePaise = lo;
      if (hi !== undefined) c.maxPricePaise = hi;
    },
  },
  {
    re: /\b(?:under|below|less than|upto|up to|cheaper than|within)\s+(₹?[\d.,]+\s*(?:k|l|lakh|cr)?)\b/i,
    apply: (m, c) => { const p = rupeesToPaise(m[1]!); if (p !== undefined) c.maxPricePaise = p; },
  },
  {
    re: /\b(?:above|over|more than|minimum|at least|starting)\s+(₹?[\d.,]+\s*(?:k|l|lakh|cr)?)\b/i,
    apply: (m, c) => { const p = rupeesToPaise(m[1]!); if (p !== undefined) c.minPricePaise = p; },
  },
  {
    // Tanglish: "5k kku keela" / "5000 kku kizhe" = below 5000
    re: /(₹?[\d.,]+\s*(?:k|l|lakh|cr)?)\s*(?:kku|ku)\s*(?:keela|kizhe|keezhe)\b/i,
    apply: (m, c) => { const p = rupeesToPaise(m[1]!); if (p !== undefined) c.maxPricePaise = p; },
  },
  {
    // Tanglish: "2k kku mele" = above 2000
    re: /(₹?[\d.,]+\s*(?:k|l|lakh|cr)?)\s*(?:kku|ku)\s*(?:mele|mela)\b/i,
    apply: (m, c) => { const p = rupeesToPaise(m[1]!); if (p !== undefined) c.minPricePaise = p; },
  },
  {
    re: /\b([1-5](?:\.\d)?)\s*(?:\+|plus)?\s*(?:star|stars|rating)\b(?:\s*(?:and above|\+|or more))?/i,
    apply: (m, c) => { const r = parseFloat(m[1]!); if (r >= 1 && r <= 5) c.minRating = r; },
  },
];

/**
 * Parse a raw query. Returns a policy message for banned terms; otherwise extracts
 * constraints and leaves everything it cannot interpret as free text (graceful fallback).
 */
export function parseQuery(raw: string): QueryResult {
  const q = sanitise(raw);
  if (q.length === 0) return { ok: true, parsed: { text: '', droppedConstraints: [] } };
  if (containsBannedTerm(q)) return { ok: false, policyMessage: POLICY_MESSAGE };

  const constraints: ParsedConstraints = { text: q, droppedConstraints: [] };
  let residual = q;
  for (const p of PATTERNS) {
    const m = residual.match(p.re);
    if (m) {
      p.apply(m, constraints);
      residual = (residual.slice(0, m.index!) + ' ' + residual.slice(m.index! + m[0].length)).replace(/\s+/g, ' ').trim();
    }
  }
  // strip filler connectives left behind, but keep everything else (incl. non-Latin script)
  constraints.text = residual.replace(/\b(for|with|in|the|a|an)\b/gi, ' ').replace(/\s+/g, ' ').trim();

  // VALIDATION: price range min <= max - an inverted range is dropped, not silently applied.
  if (constraints.minPricePaise !== undefined && constraints.maxPricePaise !== undefined
      && constraints.minPricePaise > constraints.maxPricePaise) {
    constraints.droppedConstraints.push('PRICE_RANGE_INVERTED');
    delete constraints.minPricePaise;
    delete constraints.maxPricePaise;
  }
  return { ok: true, parsed: constraints };
}

/**
 * FR-CUS-010 VALIDATION: parsed constraints are validated against the category's attribute
 * schema before being applied. A constraint the category does not declare is DROPPED with a
 * note rather than applied blindly or failing the query.
 */
export function applySchema(parsed: ParsedConstraints, categoryAttributes: Set<string>): ParsedConstraints {
  const out: ParsedConstraints = { text: parsed.text, droppedConstraints: [...parsed.droppedConstraints] };
  if (parsed.minRating !== undefined) {
    if (categoryAttributes.has('rating')) out.minRating = parsed.minRating;
    else out.droppedConstraints.push('minRating:NOT_IN_CATEGORY_SCHEMA');
  }
  // price is universal, but keep the same discipline so the rule is explicit
  if (parsed.maxPricePaise !== undefined) {
    if (categoryAttributes.has('price')) out.maxPricePaise = parsed.maxPricePaise;
    else out.droppedConstraints.push('maxPricePaise:NOT_IN_CATEGORY_SCHEMA');
  }
  if (parsed.minPricePaise !== undefined) {
    if (categoryAttributes.has('price')) out.minPricePaise = parsed.minPricePaise;
    else out.droppedConstraints.push('minPricePaise:NOT_IN_CATEGORY_SCHEMA');
  }
  return out;
}
