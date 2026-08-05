/**
 * FR-CUS-013 + FR-AI-003 as tests: consent-gated personalisation (BRU-12), pre-ranking
 * candidate filters, no self-recommend, category exclusions, ≥3-vendor diversity,
 * sponsored ≤20% labelled, the top-1 epsilon guard, the model→heuristic→curated fallback
 * chain always yielding a full slate, and the explainable "why this" affordance.
 */
import { describe, expect, it } from 'vitest';
import {
  businessRerank,
  DEFAULT_EPSILON,
  explain,
  filterCandidates,
  generateCandidates,
  heuristicRanker,
  MIN_DISTINCT_VENDORS,
  serve,
  SPONSORED_MAX_FRACTION,
  type Candidate,
  type RecoRequest,
  type Ranker,
  type Visibility,
} from '../src/domain/recommendations.js';

const cand = (id: string, vendorId: string, relevance: number, sources: Candidate['sources'] = ['CO_VISITATION'], categoryId = 'CAT1'): Candidate =>
  ({ listingId: id, vendorId, categoryId, sources, relevance });

const vis = (ids: string[], over: Partial<Visibility> = {}): Map<string, Visibility> => {
  const m = new Map<string, Visibility>();
  for (const id of ids) m.set(id, { listingId: id, state: 'LIVE', inStock: true, serviceable: true, ...over });
  return m;
};

const req = (over: Partial<RecoRequest> = {}): RecoRequest => ({
  slot: 'SIMILAR_ITEMS', slotSize: 10, personalisationConsent: true,
  excludedCategoryIds: new Set(), ...over,
});

describe('candidate generation and consent gating (BRU-12)', () => {
  it('merges pools, unioning sources and keeping the strongest relevance', () => {
    const merged = generateCandidates([
      [cand('A', 'V1', 0.5, ['CO_VISITATION'])],
      [cand('A', 'V1', 0.9, ['EMBEDDING'])],
    ], true);
    expect(merged).toHaveLength(1);
    expect(merged[0].relevance).toBe(0.9);
    expect(merged[0].sources.sort()).toEqual(['CO_VISITATION', 'EMBEDDING']);
  });

  it('drops personalised-only candidates when consent is absent', () => {
    const merged = generateCandidates([
      [cand('P1', 'V1', 0.9, ['PERSONALISED'])],
      [cand('C1', 'V2', 0.4, ['POPULARITY'])],
    ], false);
    expect(merged.map((c) => c.listingId)).toEqual(['C1']);
  });

  it('keeps a listing that also has a non-personalised source, but strips the attribution', () => {
    const merged = generateCandidates([[cand('X', 'V1', 0.8, ['PERSONALISED', 'POPULARITY'])]], false);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toEqual(['POPULARITY']);
    expect(explain(merged[0].sources)).toBe('Popular in this category');   // cannot leak history
  });

  it('with consent, personalised candidates survive and are explained as such', () => {
    const merged = generateCandidates([[cand('P1', 'V1', 0.9, ['PERSONALISED'])]], true);
    expect(explain(merged[0].sources)).toBe('Based on your browsing');
  });
});

describe('pre-ranking filters (FR-AI-003 VALIDATION / FR-CUS-013 VALIDATION)', () => {
  it('never recommends the seed itself', () => {
    const out = filterCandidates([cand('SEED', 'V1', 0.9), cand('A', 'V2', 0.5)],
      vis(['SEED', 'A']), req({ seedListingId: 'SEED' }));
    expect(out.map((c) => c.listingId)).toEqual(['A']);
  });

  it('honours category exclusions', () => {
    const out = filterCandidates(
      [cand('S1', 'V1', 0.9, ['POPULARITY'], 'SENSITIVE'), cand('A', 'V2', 0.5)],
      vis(['S1', 'A']), req({ excludedCategoryIds: new Set(['SENSITIVE']) }));
    expect(out.map((c) => c.listingId)).toEqual(['A']);
  });

  it('drops non-LIVE, out-of-stock and unserviceable candidates, and fails closed on unknown', () => {
    const visibility = vis(['LIVE-1']);
    visibility.set('DRAFT-1', { listingId: 'DRAFT-1', state: 'DRAFT', inStock: true, serviceable: true });
    visibility.set('OOS-1', { listingId: 'OOS-1', state: 'LIVE', inStock: false, serviceable: true });
    visibility.set('NOSVC-1', { listingId: 'NOSVC-1', state: 'LIVE', inStock: true, serviceable: false });
    const out = filterCandidates(
      [cand('LIVE-1', 'V1', 0.9), cand('DRAFT-1', 'V2', 0.8), cand('OOS-1', 'V3', 0.7),
       cand('NOSVC-1', 'V4', 0.6), cand('GHOST', 'V5', 0.5)],
      visibility, req());
    expect(out.map((c) => c.listingId)).toEqual(['LIVE-1']);
  });
});

describe('diversity: ≥3 vendors in a 10-item rail (FR-CUS-013 RULES)', () => {
  it('forces a third vendor even when one vendor dominates on relevance', () => {
    // V1 has 8 strong items, V2 has 4, V3 has 2 weaker ones
    const ranked = [
      ...Array.from({ length: 8 }, (_, i) => ({ candidate: cand(`A${i}`, 'V1', 0.9 - i * 0.01), score: 0.9 - i * 0.01 })),
      ...Array.from({ length: 4 }, (_, i) => ({ candidate: cand(`B${i}`, 'V2', 0.5 - i * 0.01), score: 0.5 - i * 0.01 })),
      ...Array.from({ length: 2 }, (_, i) => ({ candidate: cand(`C${i}`, 'V3', 0.2 - i * 0.01), score: 0.2 - i * 0.01 })),
    ];
    const out = businessRerank(ranked, 10, DEFAULT_EPSILON);
    expect(out.items).toHaveLength(10);
    expect(out.distinctVendors).toBeGreaterThanOrEqual(MIN_DISTINCT_VENDORS);
    expect(out.diversityMet).toBe(true);
    // the per-vendor cap for a 10-rail is 4
    const v1Count = out.items.filter((i) => i.candidate.vendorId === 'V1').length;
    expect(v1Count).toBeLessThanOrEqual(4);
  });

  it('still returns a full slate when the pool has fewer than 3 vendors, and says so honestly', () => {
    const ranked = Array.from({ length: 12 }, (_, i) => ({ candidate: cand(`A${i}`, 'V1', 0.9 - i * 0.01), score: 0.9 - i * 0.01 }));
    const out = businessRerank(ranked, 10, DEFAULT_EPSILON);
    expect(out.items).toHaveLength(10);            // full slate (FR-AI-003)
    expect(out.distinctVendors).toBe(1);
    expect(out.diversityMet).toBe(false);          // reported, not hidden
  });
});

describe('top-1 epsilon guard (FR-AI-003 RULES)', () => {
  it('restores the highest-relevance item to position 1 when re-rank depressed it beyond epsilon', () => {
    // craft a case where the cap would push the best item out of slot 1
    const ranked = [
      { candidate: cand('BEST', 'V1', 0.99), score: 0.99 },
      { candidate: cand('B1', 'V1', 0.98), score: 0.98 },
      { candidate: cand('B2', 'V1', 0.97), score: 0.97 },
      { candidate: cand('B3', 'V1', 0.96), score: 0.96 },
      { candidate: cand('OTHER', 'V2', 0.10), score: 0.10 },
    ];
    const out = businessRerank(ranked, 5, 0.05);
    expect(out.items[0].candidate.listingId).toBe('BEST');
  });

  it('permits a small re-ordering inside epsilon', () => {
    const ranked = [
      { candidate: cand('A', 'V1', 0.90), score: 0.90 },
      { candidate: cand('B', 'V2', 0.89), score: 0.89 },
    ];
    const out = businessRerank(ranked, 2, 0.05);
    // both within epsilon, so the diversity-friendly order is allowed to stand
    expect(out.items).toHaveLength(2);
    expect(out.items[0].score).toBeGreaterThanOrEqual(0.89);
  });
});

describe('fallback chain: model → heuristic → curated (FR-AI-003 VALIDATION)', () => {
  const pool = [cand('A', 'V1', 0.9), cand('B', 'V2', 0.8), cand('C', 'V3', 0.7)];
  const visibility = vis(['A', 'B', 'C', 'CUR1', 'CUR2', 'CUR3']);

  it('uses the model when it returns results', () => {
    const model: Ranker = (cs) => cs.map((c) => ({ listingId: c.listingId, score: c.relevance }));
    const r = serve([pool], visibility, req({ slotSize: 3 }), model);
    expect(r.servedBy).toBe('MODEL');
    expect(r.items).toHaveLength(3);
  });

  it('falls back to the heuristic when the model throws', () => {
    const broken: Ranker = () => { throw new Error('model unavailable'); };
    const r = serve([pool], visibility, req({ slotSize: 3 }), broken);
    expect(r.servedBy).toBe('HEURISTIC');
    expect(r.items).toHaveLength(3);
    expect(r.items[0].listingId).toBe('A');       // highest candidate relevance
  });

  it('falls back to the heuristic when the model returns an empty ranking', () => {
    const empty: Ranker = () => [];
    expect(serve([pool], visibility, req({ slotSize: 3 }), empty).servedBy).toBe('HEURISTIC');
  });

  it('falls back to curated when there are no candidates at all, still yielding a slate', () => {
    const r = serve([[]], visibility, req({ slotSize: 3 }), undefined, ['CUR1', 'CUR2', 'CUR3']);
    expect(r.servedBy).toBe('CURATED');
    expect(r.items.map((i) => i.listingId)).toEqual(['CUR1', 'CUR2', 'CUR3']);
    expect(r.items[0].why).toBe('Editorially picked');
  });

  it('a curated item that is not visible is not served', () => {
    const v = vis(['CUR1']);
    v.set('CUR2', { listingId: 'CUR2', state: 'DRAFT', inStock: true, serviceable: true });
    const r = serve([[]], v, req({ slotSize: 3 }), undefined, ['CUR1', 'CUR2']);
    expect(r.items.map((i) => i.listingId)).toEqual(['CUR1']);
  });

  it('heuristic ranker orders by candidate relevance deterministically', () => {
    const h = heuristicRanker([cand('B', 'V2', 0.5), cand('A', 'V1', 0.5), cand('C', 'V3', 0.9)]);
    expect(h.map((x) => x.listingId)).toEqual(['C', 'A', 'B']);   // tie broken by id
  });
});

describe('sponsored blend ≤ 20% and labelled (FR-CUS-013 RULES)', () => {
  it('places at most 20% sponsored, never at position 1, each labelled', () => {
    const pool = Array.from({ length: 14 }, (_, i) => cand(`O${i}`, `V${i % 4}`, 0.9 - i * 0.01));
    const ids = [...pool.map((c) => c.listingId), 'SP1', 'SP2', 'SP3'];
    const r = serve([pool], vis(ids), req({ slotSize: 10, sponsoredCandidates: ['SP1', 'SP2', 'SP3'] }));
    const sponsored = r.items.filter((i) => i.sponsored);
    expect(sponsored.length).toBeLessThanOrEqual(Math.floor(10 * SPONSORED_MAX_FRACTION));  // ≤ 2
    expect(sponsored.every((s) => s.label === 'Sponsored' && s.why === 'Sponsored')).toBe(true);
    expect(r.items[0].sponsored).toBe(false);    // top-1 stays relevance-driven
    expect(r.items).toHaveLength(10);
  });

  it('a non-visible sponsored candidate is discarded', () => {
    const pool = Array.from({ length: 12 }, (_, i) => cand(`O${i}`, `V${i % 4}`, 0.9 - i * 0.01));
    const v = vis([...pool.map((c) => c.listingId)]);
    v.set('SP-DRAFT', { listingId: 'SP-DRAFT', state: 'DRAFT', inStock: true, serviceable: true });
    const r = serve([pool], v, req({ slotSize: 10, sponsoredCandidates: ['SP-DRAFT'] }));
    expect(r.items.some((i) => i.sponsored)).toBe(false);
  });
});

describe('why-this explanations (FR-CUS-013 DESC)', () => {
  it('reports the strongest signal, preferring specific over generic', () => {
    expect(explain(['POPULARITY', 'CO_VISITATION'])).toBe('Customers who viewed this also viewed it');
    expect(explain(['POPULARITY'])).toBe('Popular in this category');
    expect(explain([])).toBe('Recommended');
  });

  it('every served organic item carries an explanation', () => {
    const pool = [cand('A', 'V1', 0.9, ['EMBEDDING']), cand('B', 'V2', 0.8, ['POPULARITY'])];
    const r = serve([pool], vis(['A', 'B']), req({ slotSize: 2 }));
    expect(r.items.every((i) => i.why.length > 0)).toBe(true);
    expect(r.items.find((i) => i.listingId === 'A')!.why).toBe('Similar to what you are looking at');
  });
});
