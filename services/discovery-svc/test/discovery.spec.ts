/**
 * FR-CUS-009 / FR-CUS-010 as tests. The doc's own example query
 * ("office chair for back pain under 8k") and a Tanglish query are both encoded verbatim,
 * along with the RRF fusion properties, the never-surface-non-Approved invariant, and the
 * sponsored-slot compliance cap.
 */
import { describe, expect, it } from 'vitest';
import {
  applySchema,
  BANNED_TERMS,
  parseQuery,
  POLICY_MESSAGE,
  sanitise,
} from '../src/domain/query.js';
import {
  assembleResults,
  blendSponsored,
  filterVisible,
  fuse,
  MAX_SPONSORED_IN_TOP_10,
  RRF_K,
  type ListingVisibility,
} from '../src/domain/fusion.js';

const ok = (r: ReturnType<typeof parseQuery>) => {
  if (!r.ok) throw new Error('expected parse, got policy message');
  return r.parsed;
};

describe('query understanding (FR-CUS-010)', () => {
  it("parses the doc's example: 'office chair for back pain under 8k'", () => {
    const p = ok(parseQuery('office chair for back pain under 8k'));
    expect(p.maxPricePaise).toBe(8_000 * 100);       // ₹8,000 → paise
    expect(p.text).toBe('office chair back pain');   // constraint phrase removed, intent kept
  });

  it('parses a Tanglish query, keeping Tamil script as free text (graceful fallback)', () => {
    const p = ok(parseQuery('நாற்காலி office chair 5k kku keela'));
    expect(p.maxPricePaise).toBe(5_000 * 100);
    expect(p.text).toContain('நாற்காலி');            // Tamil preserved for lexical+vector
    expect(p.text).toContain('office chair');
  });

  it('recognises Tanglish "mele" as a minimum', () => {
    const p = ok(parseQuery('saree 2k kku mele'));
    expect(p.minPricePaise).toBe(2_000 * 100);
    expect(p.maxPricePaise).toBeUndefined();
  });

  it('handles rupee notations: k, lakh, commas and the ₹ sign', () => {
    expect(ok(parseQuery('laptop under 60k')).maxPricePaise).toBe(60_000 * 100);
    expect(ok(parseQuery('laptop under ₹60,000')).maxPricePaise).toBe(60_000 * 100);
    expect(ok(parseQuery('flat under 2 lakh')).maxPricePaise).toBe(200_000 * 100);
  });

  it('parses a between-range and a rating constraint', () => {
    const p = ok(parseQuery('running shoes between 2k and 5k 4 star'));
    expect(p.minPricePaise).toBe(2_000 * 100);
    expect(p.maxPricePaise).toBe(5_000 * 100);
    expect(p.minRating).toBe(4);
  });

  it('drops an inverted price range rather than applying it (VALIDATION: min ≤ max)', () => {
    const p = ok(parseQuery('shirt between 5k and 2k'));
    expect(p.minPricePaise).toBeUndefined();
    expect(p.maxPricePaise).toBeUndefined();
    expect(p.droppedConstraints).toContain('PRICE_RANGE_INVERTED');
  });

  it('sanitises control characters and query metacharacters', () => {
    expect(sanitise('chair\u0000 <script> {a} ^boost "x"')).toBe('chair script a boost x');
  });

  it('returns the policy message for banned/regulated terms', () => {
    for (const term of ['weapon', 'ammunition', 'ivory']) {
      const r = parseQuery(`buy ${term} online`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.policyMessage).toBe(POLICY_MESSAGE);
    }
    expect(BANNED_TERMS.length).toBeGreaterThan(5);
  });

  it('an unparsable query degrades to free text, never an error', () => {
    const p = ok(parseQuery('something totally opaque zzz'));
    expect(p.text).toContain('opaque');
    expect(p.maxPricePaise).toBeUndefined();
  });

  it('constraints not in the category attribute schema are dropped with a note', () => {
    const parsed = ok(parseQuery('chair under 8k 4 star'));
    const noRating = applySchema(parsed, new Set(['price']));      // category has no rating
    expect(noRating.maxPricePaise).toBe(8_000 * 100);
    expect(noRating.minRating).toBeUndefined();
    expect(noRating.droppedConstraints).toContain('minRating:NOT_IN_CATEGORY_SCHEMA');

    const both = applySchema(parsed, new Set(['price', 'rating']));
    expect(both.minRating).toBe(4);
    expect(both.droppedConstraints).toHaveLength(0);
  });
});

describe('reciprocal rank fusion (FR-CUS-010)', () => {
  it('an item ranked in both retrievers outranks one that tops only a single list', () => {
    const fused = fuse([
      { ids: ['A', 'B', 'C'], weight: 1, label: 'BM25' },
      { ids: ['D', 'B', 'E'], weight: 1, label: 'VECTOR' },
    ]);
    // B is 2nd in both; A is 1st in one only
    const scoreOf = (id: string) => fused.find((f) => f.id === id)!.score;
    expect(scoreOf('B')).toBeGreaterThan(scoreOf('A'));
    expect(scoreOf('B')).toBeGreaterThan(scoreOf('D'));
    expect(fused[0].id).toBe('B');
  });

  it('uses the published RRF formula weight/(K+rank)', () => {
    const fused = fuse([{ ids: ['A'], weight: 1, label: 'BM25' }]);
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it('per-category weights change the ordering (RULES: configurable per category)', () => {
    const bm25 = ['A', 'B'];
    const vec = ['B', 'A'];
    const bm25Heavy = fuse([
      { ids: bm25, weight: 3, label: 'BM25' },
      { ids: vec, weight: 1, label: 'VECTOR' },
    ]);
    expect(bm25Heavy[0].id).toBe('A');
    const vectorHeavy = fuse([
      { ids: bm25, weight: 1, label: 'BM25' },
      { ids: vec, weight: 3, label: 'VECTOR' },
    ]);
    expect(vectorHeavy[0].id).toBe('B');
  });

  it('is deterministic for tied scores', () => {
    const a = fuse([{ ids: ['Z', 'Y'], weight: 1, label: 'BM25' }, { ids: ['Y', 'Z'], weight: 1, label: 'VECTOR' }]);
    const b = fuse([{ ids: ['Z', 'Y'], weight: 1, label: 'BM25' }, { ids: ['Y', 'Z'], weight: 1, label: 'VECTOR' }]);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
  });
});

describe('index filter: non-Approved can never surface (FR-CUS-010 RULES)', () => {
  const vis = (over: Partial<ListingVisibility> & { listingId: string }): ListingVisibility =>
    ({ state: 'LIVE', inStock: true, serviceable: true, ...over });

  const visibility = new Map<string, ListingVisibility>([
    ['LIVE-1', vis({ listingId: 'LIVE-1' })],
    ['DRAFT-1', vis({ listingId: 'DRAFT-1', state: 'DRAFT' })],
    ['SUBMITTED-1', vis({ listingId: 'SUBMITTED-1', state: 'SUBMITTED' })],
    ['OOS-1', vis({ listingId: 'OOS-1', inStock: false })],
    ['UNSERVICEABLE-1', vis({ listingId: 'UNSERVICEABLE-1', serviceable: false })],
  ]);

  it('drops non-LIVE, out-of-stock and unserviceable listings even if the index returned them', () => {
    const fused = fuse([{ ids: ['DRAFT-1', 'LIVE-1', 'SUBMITTED-1', 'OOS-1', 'UNSERVICEABLE-1'], weight: 1, label: 'VECTOR' }]);
    const visible = filterVisible(fused, visibility);
    expect(visible.map((v) => v.id)).toEqual(['LIVE-1']);
  });

  it('fails closed on an id absent from the visibility map (stale index)', () => {
    const fused = fuse([{ ids: ['GHOST-1'], weight: 1, label: 'VECTOR' }]);
    expect(filterVisible(fused, visibility)).toHaveLength(0);
  });
});

describe('sponsored slots (FR-CUS-009 RULES, compliance BRD §1.22)', () => {
  const visibility = new Map<string, ListingVisibility>();
  for (let i = 1; i <= 20; i++) {
    visibility.set(`O${i}`, { listingId: `O${i}`, state: 'LIVE', inStock: true, serviceable: true });
  }
  for (const s of ['S1', 'S2', 'S3']) {
    visibility.set(s, { listingId: s, state: 'LIVE', inStock: true, serviceable: true });
  }
  visibility.set('S-DRAFT', { listingId: 'S-DRAFT', state: 'DRAFT', inStock: true, serviceable: true });

  const organic = Array.from({ length: 15 }, (_, i) => ({ id: `O${i + 1}`, score: 1 - i * 0.01 }));

  it('places at most 2 sponsored in the top 10 and labels each', () => {
    const page = blendSponsored(organic, ['S1', 'S2', 'S3'], visibility, 10);
    expect(page).toHaveLength(10);
    const sponsored = page.filter((p) => p.sponsored);
    expect(sponsored).toHaveLength(MAX_SPONSORED_IN_TOP_10);
    expect(sponsored.every((s) => s.label === 'Sponsored')).toBe(true);
    expect(page.filter((p) => !p.sponsored)).toHaveLength(8);
  });

  it('a non-visible sponsored candidate is discarded like any other listing', () => {
    const page = blendSponsored(organic, ['S-DRAFT', 'S1'], visibility, 10);
    expect(page.some((p) => p.listingId === 'S-DRAFT')).toBe(false);
    expect(page.filter((p) => p.sponsored).map((p) => p.listingId)).toEqual(['S1']);
  });

  it('no sponsored candidates yields a fully organic page', () => {
    const page = blendSponsored(organic, [], visibility, 10);
    expect(page.every((p) => !p.sponsored)).toBe(true);
    expect(page).toHaveLength(10);
  });
});

describe('full assembly: fuse → filter → blend', () => {
  it('produces a compliant page from two retrievers', () => {
    const visibility = new Map<string, ListingVisibility>();
    for (const id of ['L1', 'L2', 'L3', 'L4', 'SP1']) {
      visibility.set(id, { listingId: id, state: 'LIVE', inStock: true, serviceable: true });
    }
    visibility.set('L-DRAFT', { listingId: 'L-DRAFT', state: 'DRAFT', inStock: true, serviceable: true });

    const page = assembleResults(
      ['L1', 'L-DRAFT', 'L2'],      // BM25 (index returned a draft — must be dropped)
      ['L2', 'L3', 'L4'],           // vector
      visibility,
      ['SP1'],
      { bm25: 1, vector: 1 },
      5,
    );
    expect(page.some((p) => p.listingId === 'L-DRAFT')).toBe(false);
    expect(page[0]).toEqual({ listingId: 'SP1', score: 0, sponsored: true, label: 'Sponsored' });
    // L2 appears in both retrievers, so it leads the organic order
    expect(page.filter((p) => !p.sponsored)[0].listingId).toBe('L2');
  });
});
