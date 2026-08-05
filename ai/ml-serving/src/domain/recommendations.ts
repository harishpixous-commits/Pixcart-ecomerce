/**
 * Recommendation serving platform — FR-AI-003, enforcing the product rules of FR-CUS-013.
 *
 * Normative source (Documentation Suite v1.0):
 *   FR-AI-003 DESC:       "two-stage architecture (candidate generation: co-visitation,
 *                          embeddings, popularity; ranking: gradient-boosted/learned model
 *                          with business re-rank), with slot-level configuration".
 *   FR-AI-003 RULES:      "Business re-rank cannot alter top-1 relevance by more than
 *                          configured epsilon".
 *   FR-AI-003 VALIDATION: "Candidate filters (approved/in-stock/serviceable) applied
 *                          PRE-ranking; fallback chain (model→heuristic→curated) always
 *                          yields a full slate."
 *   FR-CUS-013 RULES:     "Personalisation requires consent (BRU-12); diversity constraint
 *                          ≥ 3 vendors in any 10-item rail; sponsored blend ≤ 20% and
 *                          labelled."
 *   FR-CUS-013 VALIDATION:"Only Approved, serviceable, in-stock items; no self-recommend of
 *                          the seed; category exclusions (e.g., sensitive) honoured."
 *   FR-CUS-013 DESC:      an explainable "why this" affordance.
 *
 * Pure and deterministic. The learned ranker is INJECTED as a scorer function, so the model
 * can be swapped/shadowed without touching this logic, and the fallback chain is testable
 * without any model at all. The p95-under-60ms target is an infrastructure property of the
 * serving path, not of this module; what is enforced here are the correctness rules.
 */

export type CandidateSource = 'CO_VISITATION' | 'EMBEDDING' | 'POPULARITY' | 'PERSONALISED' | 'CURATED';

/** Sources that read the user's own history — gated behind consent (BRU-12). */
export const PERSONALISED_SOURCES: ReadonlySet<CandidateSource> = new Set<CandidateSource>(['PERSONALISED']);

export interface Candidate {
  listingId: string;
  vendorId: string;
  categoryId: string;
  /** Which generators produced it — drives the "why this" explanation. */
  sources: CandidateSource[];
  /** Base relevance from candidate generation (0..1); the ranker may override. */
  relevance: number;
}

export interface Visibility {
  listingId: string;
  state: string;       // must be LIVE
  inStock: boolean;
  serviceable: boolean;
}

export interface RecoRequest {
  slot: string;                       // e.g. SIMILAR_ITEMS, FBT, HOME_RAIL, CART_CROSS_SELL
  slotSize: number;                   // rail size (10 for the diversity rule)
  seedListingId?: string;             // present for similar-items / FBT
  personalisationConsent: boolean;    // BRU-12
  excludedCategoryIds: Set<string>;   // sensitive / configured exclusions
  sponsoredCandidates?: string[];
  /** Business re-rank may not depress top-1 relevance by more than this. */
  epsilon?: number;
}

export const DEFAULT_EPSILON = 0.05;
export const MIN_DISTINCT_VENDORS = 3;      // in any 10-item rail
export const SPONSORED_MAX_FRACTION = 0.20; // ≤ 20% and labelled

export interface RecoItem {
  listingId: string;
  vendorId: string;
  relevance: number;
  sponsored: boolean;
  label?: 'Sponsored';
  /** "Why this" — human-readable, derived from the generating sources. */
  why: string;
}

export interface RecoResponse {
  slot: string;
  items: RecoItem[];
  /** Which stage produced the slate: the fallback chain's outcome. */
  servedBy: 'MODEL' | 'HEURISTIC' | 'CURATED';
  diversityMet: boolean;
  distinctVendors: number;
}

const WHY_TEXT: Record<CandidateSource, string> = {
  CO_VISITATION: 'Customers who viewed this also viewed it',
  EMBEDDING: 'Similar to what you are looking at',
  POPULARITY: 'Popular in this category',
  PERSONALISED: 'Based on your browsing',
  CURATED: 'Editorially picked',
};

export function explain(sources: CandidateSource[]): string {
  if (sources.length === 0) return 'Recommended';
  // deterministic: report the strongest signal, preferring specific over generic
  const order: CandidateSource[] = ['CO_VISITATION', 'EMBEDDING', 'PERSONALISED', 'POPULARITY', 'CURATED'];
  const best = order.find((s) => sources.includes(s))!;
  return WHY_TEXT[best];
}

/**
 * Stage 1 — candidate generation. Merges the generator outputs, de-duplicating by listing
 * and unioning their sources. Personalised candidates are DROPPED entirely when consent is
 * absent (BRU-12); a listing that also came from a non-personalised source survives, but
 * loses the personalised attribution so the explanation cannot leak that history was used.
 */
export function generateCandidates(pools: Candidate[][], consent: boolean): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const pool of pools) {
    for (const c of pool) {
      const sources = consent ? c.sources : c.sources.filter((s) => !PERSONALISED_SOURCES.has(s));
      if (sources.length === 0) continue;         // personalised-only, no consent → dropped
      const existing = merged.get(c.listingId);
      if (existing) {
        const union = [...new Set([...existing.sources, ...sources])];
        merged.set(c.listingId, { ...existing, sources: union, relevance: Math.max(existing.relevance, c.relevance) });
      } else {
        merged.set(c.listingId, { ...c, sources });
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.relevance - a.relevance || a.listingId.localeCompare(b.listingId));
}

/**
 * Pre-ranking filters (FR-AI-003 VALIDATION — applied BEFORE ranking so the model never
 * spends effort on ineligible items, and FR-CUS-013 VALIDATION): visible only, never the
 * seed itself, never an excluded category. Fails closed on unknown visibility.
 */
export function filterCandidates(
  candidates: Candidate[],
  visibility: Map<string, Visibility>,
  req: RecoRequest,
): Candidate[] {
  return candidates.filter((c) => {
    if (req.seedListingId && c.listingId === req.seedListingId) return false;   // no self-recommend
    if (req.excludedCategoryIds.has(c.categoryId)) return false;               // sensitive exclusions
    const v = visibility.get(c.listingId);
    return v !== undefined && v.state === 'LIVE' && v.inStock && v.serviceable;
  });
}

/** The learned ranker, injected. Throwing (or returning nothing) triggers the fallback. */
export type Ranker = (candidates: Candidate[], req: RecoRequest) => Array<{ listingId: string; score: number }>;

/** Heuristic stage of the fallback chain: rank by the candidate-generation relevance. */
export function heuristicRanker(candidates: Candidate[]): Array<{ listingId: string; score: number }> {
  return candidates
    .map((c) => ({ listingId: c.listingId, score: c.relevance }))
    .sort((a, b) => b.score - a.score || a.listingId.localeCompare(b.listingId));
}

/**
 * Business re-rank: diversity then sponsored blending, with the top-1 epsilon guard.
 *
 * Diversity — to guarantee ≥ 3 distinct vendors in a rail we cap each vendor at
 * ceil(size/3) slots (4 in a 10-rail): two vendors can then fill at most 8, so a third is
 * forced whenever the pool contains one. If the pool genuinely has fewer vendors, a second
 * pass backfills beyond the cap so the slate is still full (FR-AI-003: "always yields a
 * full slate"), and diversityMet reports the truth rather than silently shrinking the rail.
 *
 * Epsilon guard — the highest-relevance eligible item must occupy position 1 unless the
 * item that does is within epsilon of it.
 */
export function businessRerank(
  ranked: Array<{ candidate: Candidate; score: number }>,
  size: number,
  epsilon: number,
): { items: Array<{ candidate: Candidate; score: number }>; diversityMet: boolean; distinctVendors: number } {
  const perVendorCap = Math.ceil(size / MIN_DISTINCT_VENDORS);
  const used = new Map<string, number>();
  const picked: Array<{ candidate: Candidate; score: number }> = [];

  // pass 1 — respect the vendor cap
  for (const r of ranked) {
    if (picked.length >= size) break;
    const n = used.get(r.candidate.vendorId) ?? 0;
    if (n >= perVendorCap) continue;
    picked.push(r);
    used.set(r.candidate.vendorId, n + 1);
  }
  // pass 2 — backfill ignoring the cap so the slate is full
  if (picked.length < size) {
    for (const r of ranked) {
      if (picked.length >= size) break;
      if (picked.includes(r)) continue;
      picked.push(r);
    }
  }

  // epsilon guard on top-1 relevance
  if (picked.length > 0 && ranked.length > 0) {
    const best = ranked[0];
    if (picked[0] !== best && best.score - picked[0].score > epsilon) {
      const idx = picked.indexOf(best);
      if (idx > 0) picked.splice(idx, 1);
      picked.unshift(best);
      if (picked.length > size) picked.length = size;
    }
  }

  const distinctVendors = new Set(picked.map((p) => p.candidate.vendorId)).size;
  return { items: picked, diversityMet: distinctVendors >= MIN_DISTINCT_VENDORS, distinctVendors };
}

/**
 * Serve a slot end to end: generate → filter (pre-ranking) → rank with the fallback chain
 * → business re-rank → sponsored blend. Always returns a slate when eligible candidates
 * exist; `servedBy` says which stage produced it.
 */
export function serve(
  pools: Candidate[][],
  visibility: Map<string, Visibility>,
  req: RecoRequest,
  model?: Ranker,
  curated: string[] = [],
): RecoResponse {
  const epsilon = req.epsilon ?? DEFAULT_EPSILON;
  const candidates = filterCandidates(generateCandidates(pools, req.personalisationConsent), visibility, req);
  const byId = new Map(candidates.map((c) => [c.listingId, c]));

  // ---- fallback chain: model → heuristic → curated ----
  let scored: Array<{ listingId: string; score: number }> = [];
  let servedBy: RecoResponse['servedBy'] = 'MODEL';
  if (model) {
    try {
      scored = model(candidates, req).filter((s) => byId.has(s.listingId));
    } catch {
      scored = [];
    }
  }
  if (scored.length === 0) {
    scored = heuristicRanker(candidates);
    servedBy = 'HEURISTIC';
  }
  if (scored.length === 0 && curated.length > 0) {
    const curatedVisible = curated.filter((id) => {
      const v = visibility.get(id);
      return v !== undefined && v.state === 'LIVE' && v.inStock && v.serviceable && id !== req.seedListingId;
    });
    scored = curatedVisible.map((id, i) => ({ listingId: id, score: 1 - i * 0.01 }));
    for (const id of curatedVisible) {
      if (!byId.has(id)) {
        byId.set(id, { listingId: id, vendorId: 'CURATED', categoryId: 'CURATED', sources: ['CURATED'], relevance: 0.5 });
      }
    }
    servedBy = 'CURATED';
  }

  const ranked = scored
    .map((s) => ({ candidate: byId.get(s.listingId)!, score: s.score }))
    .filter((r) => r.candidate !== undefined)
    .sort((a, b) => b.score - a.score || a.candidate.listingId.localeCompare(b.candidate.listingId));

  const { items: reranked, diversityMet, distinctVendors } = businessRerank(ranked, req.slotSize, epsilon);

  // ---- sponsored blend: ≤ 20% of the rail, labelled ----
  const maxSponsored = Math.floor(req.slotSize * SPONSORED_MAX_FRACTION);
  const sponsoredVisible = (req.sponsoredCandidates ?? []).filter((id) => {
    const v = visibility.get(id);
    return v !== undefined && v.state === 'LIVE' && v.inStock && v.serviceable && id !== req.seedListingId;
  }).slice(0, maxSponsored);

  const items: RecoItem[] = [];
  const organic = reranked.filter((r) => !sponsoredVisible.includes(r.candidate.listingId));
  let si = 0;
  let oi = 0;
  for (let pos = 0; pos < req.slotSize && (si < sponsoredVisible.length || oi < organic.length); pos++) {
    // sponsored occupies every 4th slot, never position 1 (top-1 stays relevance-driven)
    if (pos > 0 && pos % 4 === 0 && si < sponsoredVisible.length) {
      const id = sponsoredVisible[si++];
      const c = byId.get(id);
      items.push({
        listingId: id, vendorId: c?.vendorId ?? 'UNKNOWN', relevance: 0,
        sponsored: true, label: 'Sponsored', why: 'Sponsored',
      });
      continue;
    }
    if (oi < organic.length) {
      const r = organic[oi++];
      items.push({
        listingId: r.candidate.listingId, vendorId: r.candidate.vendorId, relevance: r.score,
        sponsored: false, why: explain(r.candidate.sources),
      });
    }
  }

  return { slot: req.slot, items, servedBy, diversityMet, distinctVendors };
}
