/**
 * Hybrid retrieval fusion & result assembly — FR-CUS-009 / FR-CUS-010.
 *
 * Normative source (Documentation Suite v1.0):
 *   FR-CUS-010 DESC:  "hybrid BM25+vector with reciprocal-rank fusion".
 *   FR-CUS-010 RULES: "Hybrid weights configurable per category; semantic layer must never
 *                      surface non-Approved listings (index filter)."
 *   FR-CUS-009 DESC:  "results restricted to Approved & in-stock-visible listings".
 *   FR-CUS-009 RULES: "Sponsored slots (max 2 of top 10) always labelled 'Sponsored'
 *                      (compliance BRD §1.22)".
 *
 * Pure and deterministic. The BM25 and vector rankings arrive as ordered id lists (the
 * OpenSearch / vector-store adapters produce them); fusion, filtering and sponsored
 * blending are decided here. The approved-only filter is applied AFTER fusion as a
 * belt-and-braces guard: even if an index is stale and returns a draft listing, it cannot
 * reach a customer.
 */

/** Reciprocal-rank-fusion damping constant; 60 is the standard published value. */
export const RRF_K = 60;

export interface RankedList {
  /** Listing ids in rank order, best first. */
  ids: string[];
  /** Fusion weight for this retriever (per-category configurable). */
  weight: number;
  label: 'BM25' | 'VECTOR';
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ_lists weight / (K + rank(d)), rank being 1-based.
 * A document appearing high in both lists outranks one that is top of a single list —
 * the property that makes hybrid retrieval work. Ties break on id for determinism.
 */
export function fuse(lists: RankedList[], k = RRF_K): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.ids.forEach((id, idx) => {
      const contribution = list.weight / (k + (idx + 1));
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** The visibility facts every candidate must satisfy before a customer can see it. */
export interface ListingVisibility {
  listingId: string;
  state: string;            // must be LIVE (approved and published)
  inStock: boolean;
  serviceable: boolean;
}

/**
 * Index filter (FR-CUS-009 DESC / FR-CUS-010 RULES). Only LIVE, in-stock, serviceable
 * listings survive; anything unknown to the visibility map is dropped (fail-closed).
 */
export function filterVisible(
  ranked: Array<{ id: string; score: number }>,
  visibility: Map<string, ListingVisibility>,
): Array<{ id: string; score: number }> {
  return ranked.filter((r) => {
    const v = visibility.get(r.id);
    return v !== undefined && v.state === 'LIVE' && v.inStock && v.serviceable;
  });
}

export interface ResultItem {
  listingId: string;
  score: number;
  sponsored: boolean;
  /** Mandatory disclosure text when sponsored (compliance BRD §1.22). */
  label?: 'Sponsored';
}

export const MAX_SPONSORED_IN_TOP_10 = 2;

/**
 * Blend sponsored listings into organic results. At most 2 of the top 10 may be sponsored
 * and each is labelled; sponsored candidates that are not visible are discarded like any
 * other. Sponsored items are placed at positions 1 and 4 (a stable, disclosed pattern)
 * without displacing more than the permitted count.
 */
export function blendSponsored(
  organic: Array<{ id: string; score: number }>,
  sponsoredCandidates: string[],
  visibility: Map<string, ListingVisibility>,
  pageSize = 10,
): ResultItem[] {
  const visibleSponsored = sponsoredCandidates.filter((id) => {
    const v = visibility.get(id);
    return v !== undefined && v.state === 'LIVE' && v.inStock && v.serviceable;
  }).slice(0, MAX_SPONSORED_IN_TOP_10);

  const organicIds = organic.filter((o) => !visibleSponsored.includes(o.id));
  const out: ResultItem[] = [];
  const sponsoredSlots = new Set([0, 3]);          // positions 1 and 4
  let si = 0;
  let oi = 0;
  for (let pos = 0; pos < pageSize; pos++) {
    if (sponsoredSlots.has(pos) && si < visibleSponsored.length) {
      out.push({ listingId: visibleSponsored[si++], score: 0, sponsored: true, label: 'Sponsored' });
      continue;
    }
    if (oi < organicIds.length) {
      const o = organicIds[oi++];
      out.push({ listingId: o.id, score: o.score, sponsored: false });
    }
  }
  return out;
}

/** Per-category fusion weights (FR-CUS-010 RULES: configurable per category). */
export interface FusionWeights { bm25: number; vector: number; }
export const DEFAULT_FUSION_WEIGHTS: FusionWeights = { bm25: 1.0, vector: 1.0 };

/**
 * Full search assembly: fuse → filter → blend. Returns at most pageSize items, every
 * sponsored one labelled, every item verified visible.
 */
export function assembleResults(
  bm25Ids: string[],
  vectorIds: string[],
  visibility: Map<string, ListingVisibility>,
  sponsoredCandidates: string[] = [],
  weights: FusionWeights = DEFAULT_FUSION_WEIGHTS,
  pageSize = 10,
): ResultItem[] {
  const fused = fuse([
    { ids: bm25Ids, weight: weights.bm25, label: 'BM25' },
    { ids: vectorIds, weight: weights.vector, label: 'VECTOR' },
  ]);
  const visible = filterVisible(fused, visibility);
  return blendSponsored(visible, sponsoredCandidates, visibility, pageSize);
}
