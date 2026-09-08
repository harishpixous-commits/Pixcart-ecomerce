/**
 * FR-AI-004 semantic & multimodal indexing. Three properties get the most attention, because each
 * failure mode is quiet: a withdrawn listing that stays searchable, one bad record stalling the
 * whole batch, and a takedown that never propagates.
 */
import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  DELETE_PROPAGATION_SLA_MS,
  DualIndex,
  enrich,
  FRESHNESS_SLA_MS,
  MIN_AB_QUERIES,
  NEAR_DUPLICATE_THRESHOLD,
  SemanticIndex,
  type CatalogueEvent,
  type ListingState,
} from '../src/domain/indexing.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const SCHEMA = 'schema-v7-abc123';

/** A deterministic stand-in embedder: distinct words give distinct, comparable vectors. */
const embedText = (text: string): number[] => {
  const v = new Array(8).fill(0);
  for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) & 0xffff;
    v[h % 8] += 1;
  }
  return v;
};

const embedImage = (ref: string): number[] => embedText(ref);

const index = (over: { modelVersion?: string; synonyms?: Record<string, string[]> } = {}) =>
  new SemanticIndex(
    over.modelVersion ?? 'emb-v3',
    SCHEMA,
    embedText,
    embedImage,
    over.synonyms ?? { saree: ['sari', 'shari'], kurta: ['kurti'] },
  );

const event = (over: Partial<CatalogueEvent> = {}): CatalogueEvent => ({
  eventId: 'EV-1',
  listingId: 'LST-1',
  type: 'UPSERT',
  state: 'APPROVED',
  payload: {
    title: 'Kanchipuram silk saree',
    attributes: { fabric: 'silk', colour: 'navy' },
    enrichedCopy: 'handwoven in Tamil Nadu',
    imageRefs: ['img://saree-1.jpg'],
  },
  schemaHash: SCHEMA,
  emittedAtMs: NOW - 30_000,
  ...over,
});

// ============================================ approved-only

describe('only APPROVED listings enter the public index (VALIDATION)', () => {
  it('indexes an approved listing', () => {
    const idx = index();
    const r = idx.ingest(event(), NOW);
    expect(r.outcome).toBe('INDEXED');
    expect(idx.isSearchable('LST-1')).toBe(true);
  });

  it('excludes every non-approved state', () => {
    for (const state of ['PENDING', 'REJECTED', 'WITHDRAWN'] as ListingState[]) {
      const idx = index();
      const r = idx.ingest(event({ state }), NOW);
      expect(r.outcome).toBe('EXCLUDED_NOT_APPROVED');
      expect(idx.isSearchable('LST-1')).toBe(false);
    }
  });

  it('REMOVES a listing that was indexed and has since been withdrawn', () => {
    const idx = index();
    idx.ingest(event(), NOW);
    expect(idx.isSearchable('LST-1')).toBe(true);

    // a withdrawn listing that stays searchable is the platform still selling what it stopped
    // selling — and for a trademark takedown, it is the takedown having failed
    idx.ingest(event({ eventId: 'EV-2', state: 'WITHDRAWN' }), NOW + 1000);
    expect(idx.isSearchable('LST-1')).toBe(false);
    expect(idx.size()).toBe(0);
  });

  it('a non-approved listing does not appear in query results', () => {
    const idx = index();
    idx.ingest(event({ listingId: 'LST-OK' }), NOW);
    idx.ingest(event({ listingId: 'LST-BAD', state: 'REJECTED' }), NOW);
    const r = idx.query(embedText('Kanchipuram silk saree'), SCHEMA);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hits.map((h) => h.listingId)).toEqual(['LST-OK']);
  });
});

// ============================================ poison documents

describe('a poison document NEVER blocks the batch (ERRORS)', () => {
  it('quarantines an unparseable record with an ops task', () => {
    const idx = index();
    const r = idx.ingest(event({ payload: { title: '  ' } }), NOW);
    expect(r.outcome).toBe('QUARANTINED');
    if (r.outcome !== 'QUARANTINED') return;
    expect(r.quarantined.reason).toBe('PARSE_FAILURE_MISSING_TITLE');
    // an ops task accompanies every quarantine, so nothing rots silently
    expect(r.quarantined.opsTaskRef).toBe('OPS-INDEX-LST-1');
    expect(idx.isSearchable('LST-1')).toBe(false);
  });

  it('the rest of the batch is still indexed', () => {
    const idx = index();
    const outcomes = idx.ingestBatch([
      event({ eventId: 'E1', listingId: 'LST-1' }),
      event({ eventId: 'E2', listingId: 'LST-POISON', payload: undefined }),
      event({ eventId: 'E3', listingId: 'LST-3' }),
      event({ eventId: 'E4', listingId: 'LST-4' }),
    ], NOW);

    expect(outcomes.map((o) => o.outcome)).toEqual(['INDEXED', 'QUARANTINED', 'INDEXED', 'INDEXED']);
    // a single malformed record must not freeze the whole catalogue's searchability
    expect(idx.size()).toBe(3);
    expect(idx.isSearchable('LST-3')).toBe(true);
    expect(idx.isSearchable('LST-4')).toBe(true);
  });

  it('quarantines an embedding failure rather than indexing an empty vector', () => {
    const broken = new SemanticIndex('emb-v3', SCHEMA, () => { throw new Error('model down'); });
    const r = broken.ingest(event(), NOW);
    expect(r.outcome).toBe('QUARANTINED');
    if (r.outcome === 'QUARANTINED') expect(r.quarantined.reason).toBe('TEXT_EMBEDDING_FAILED');
  });

  it('an empty vector is treated as a failure, not indexed as a zero document', () => {
    const empty = new SemanticIndex('emb-v3', SCHEMA, () => []);
    expect(empty.ingest(event(), NOW).outcome).toBe('QUARANTINED');
  });

  it('an IMAGE embedding failure degrades to text-only rather than quarantining', () => {
    // a listing with a bad photo is still worth finding by name
    const idx = new SemanticIndex('emb-v3', SCHEMA, embedText, () => { throw new Error('vision down'); });
    const r = idx.ingest(event(), NOW);
    expect(r.outcome).toBe('INDEXED');
    if (r.outcome === 'INDEXED') {
      expect(r.document.textEmbedding.vector.length).toBeGreaterThan(0);
      expect(r.document.imageEmbedding).toBeUndefined();
    }
  });

  it('a released quarantine can be re-ingested once fixed', () => {
    const idx = index();
    idx.ingest(event({ payload: { title: '' } }), NOW);
    expect(idx.quarantinedDocuments()).toHaveLength(1);
    expect(idx.releaseFromQuarantine('LST-1')).toBe(true);
    expect(idx.quarantinedDocuments()).toHaveLength(0);
    expect(idx.releaseFromQuarantine('LST-1')).toBe(false);

    expect(idx.ingest(event({ eventId: 'EV-FIXED' }), NOW + 1000).outcome).toBe('INDEXED');
  });
});

// ============================================ delete propagation

describe('deletes propagate inside two minutes (RULES, compliance-relevant)', () => {
  it('applies a delete immediately and reports the latency', () => {
    const idx = index();
    idx.ingest(event(), NOW);
    const r = idx.ingest(event({ eventId: 'EV-DEL', type: 'DELETE', emittedAtMs: NOW }), NOW + 30_000);
    expect(r.outcome).toBe('DELETED');
    if (r.outcome === 'DELETED') expect(r.propagatedInMs).toBe(30_000);
    expect(idx.isSearchable('LST-1')).toBe(false);
  });

  it('a delete does NOT queue behind a state check or schema guard', () => {
    const idx = index();
    idx.ingest(event(), NOW);
    // a delete carrying a stale schema hash and a non-approved state must still take effect
    const r = idx.ingest(event({
      eventId: 'EV-DEL', type: 'DELETE', state: 'PENDING', schemaHash: 'schema-v6-old',
      emittedAtMs: NOW,
    }), NOW + 5_000);
    expect(r.outcome).toBe('DELETED');
    expect(idx.isSearchable('LST-1')).toBe(false);
  });

  it('deleting something never indexed is harmless', () => {
    expect(index().ingest(event({ type: 'DELETE' }), NOW).outcome).toBe('DELETED');
  });

  it('flags a propagation breach beyond the compliance window', () => {
    const idx = index();
    idx.ingest(event({ type: 'DELETE', emittedAtMs: NOW }), NOW + DELETE_PROPAGATION_SLA_MS);
    expect(idx.deletePropagationBreaches()).toHaveLength(0);

    idx.ingest(event({ eventId: 'E2', listingId: 'LST-2', type: 'DELETE', emittedAtMs: NOW }),
      NOW + DELETE_PROPAGATION_SLA_MS + 1);
    expect(idx.deletePropagationBreaches()).toHaveLength(1);
    expect(DELETE_PROPAGATION_SLA_MS).toBe(120_000);
  });
});

// ============================================ schema-hash guard

describe('the schema-hash guard prevents mixed-version queries (VALIDATION)', () => {
  it('refuses an event produced against a different schema', () => {
    const idx = index();
    const r = idx.ingest(event({ schemaHash: 'schema-v6-old' }), NOW);
    expect(r.outcome).toBe('REJECTED_SCHEMA_MISMATCH');
    if (r.outcome === 'REJECTED_SCHEMA_MISMATCH') {
      expect(r.expected).toBe(SCHEMA);
      expect(r.received).toBe('schema-v6-old');
    }
    expect(idx.size()).toBe(0);
  });

  it('refuses a query carrying a stale schema hash', () => {
    const idx = index();
    idx.ingest(event(), NOW);
    const r = idx.query(embedText('saree'), 'schema-v6-old');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('SCHEMA_HASH_MISMATCH');
  });

  it('guards the image query path too, not just text', () => {
    const idx = index();
    idx.ingest(event(), NOW);
    expect(idx.queryByImage(embedImage('img://saree-1.jpg'), 'schema-v6-old').ok).toBe(false);
    expect(idx.queryByImage(embedImage('img://saree-1.jpg'), SCHEMA).ok).toBe(true);
  });
});

// ============================================ enrichment & similarity

describe('lexical enrichment and vector similarity', () => {
  it('expands synonyms from the category schema rather than inventing them', () => {
    const e = enrich({ title: 'Kanchipuram silk saree', attributes: { fabric: 'silk' } },
      { saree: ['sari', 'shari'], shoes: ['footwear'] });
    expect(e.synonyms).toEqual(['sari', 'shari']);
    // a term absent from the title contributes nothing
    expect(e.synonyms).not.toContain('footwear');
    expect(e.attributes).toEqual({ fabric: 'silk' });
  });

  it('an empty synonym table yields no synonyms rather than guesses', () => {
    expect(enrich({ title: 'Kanchipuram silk saree' }, {}).synonyms).toEqual([]);
  });

  it('cosine similarity is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it('handles degenerate vectors without dividing by zero', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('ranks the closest document first', () => {
    const idx = index();
    idx.ingest(event({ listingId: 'LST-SAREE', payload: { title: 'Kanchipuram silk saree' } }), NOW);
    idx.ingest(event({ eventId: 'E2', listingId: 'LST-SHOE', payload: { title: 'running shoes mesh' } }), NOW);
    const r = idx.query(embedText('Kanchipuram silk saree'), SCHEMA);
    if (r.ok) expect(r.hits[0].listingId).toBe('LST-SAREE');
  });
});

// ============================================ duplicate clusters

describe('near-duplicate clustering (OUTPUTS)', () => {
  it('clusters identical listings from different sellers together', () => {
    const idx = index();
    for (const id of ['LST-A', 'LST-B', 'LST-C']) {
      idx.ingest(event({ eventId: `E-${id}`, listingId: id, payload: { title: 'Kanchipuram silk saree navy' } }), NOW);
    }
    idx.ingest(event({ eventId: 'E-D', listingId: 'LST-D', payload: { title: 'running shoes mesh grey' } }), NOW);

    const clusters = idx.computeDuplicateClusters();
    const big = [...clusters.values()].find((m) => m.length === 3);
    expect(big).toBeDefined();
    expect(big!.sort()).toEqual(['LST-A', 'LST-B', 'LST-C']);
    // the unrelated listing forms its own cluster rather than being lumped in
    expect(clusters.size).toBe(2);
  });

  it('assigns a stable cluster id to every member', () => {
    const idx = index();
    idx.ingest(event({ listingId: 'LST-A', payload: { title: 'identical title here' } }), NOW);
    idx.ingest(event({ eventId: 'E2', listingId: 'LST-B', payload: { title: 'identical title here' } }), NOW);
    idx.computeDuplicateClusters();
    expect(idx.document('LST-A')!.duplicateClusterId).toBe(idx.document('LST-B')!.duplicateClusterId);
  });

  it('does not cluster merely similar listings below the threshold', () => {
    expect(NEAR_DUPLICATE_THRESHOLD).toBe(0.95);
    const idx = index();
    idx.ingest(event({ listingId: 'LST-A', payload: { title: 'silk saree navy blue handwoven' } }), NOW);
    idx.ingest(event({ eventId: 'E2', listingId: 'LST-B', payload: { title: 'cotton shirt white formal' } }), NOW);
    expect(idx.computeDuplicateClusters().size).toBe(2);
  });

  it('an empty index yields no clusters', () => {
    expect(index().computeDuplicateClusters().size).toBe(0);
  });
});

// ============================================ health & freshness

describe('index health and freshness telemetry (OUTPUTS / ERRORS)', () => {
  it('reports the freshness p95 and no breach when inside the SLA', () => {
    const idx = index();
    for (let i = 0; i < 20; i++) {
      idx.ingest(event({ eventId: `E${i}`, listingId: `LST-${i}`, emittedAtMs: NOW - 20_000 }), NOW);
    }
    const h = idx.health();
    expect(h.documents).toBe(20);
    expect(h.freshnessP95Ms).toBe(20_000);
    expect(h.slaBreached).toBe(false);
    expect(h.autoScaleRequested).toBe(false);
  });

  it('a lag breach alerts AND requests auto-scaling', () => {
    const idx = index();
    idx.ingest(event({ emittedAtMs: NOW - FRESHNESS_SLA_MS - 1_000 }), NOW);
    const h = idx.health();
    expect(h.slaBreached).toBe(true);
    expect(h.autoScaleRequested).toBe(true);
    expect(FRESHNESS_SLA_MS).toBe(300_000);
  });

  it('counts quarantined documents separately from indexed ones', () => {
    const idx = index();
    idx.ingest(event({ listingId: 'LST-OK' }), NOW);
    idx.ingest(event({ eventId: 'E2', listingId: 'LST-BAD', payload: { title: '' } }), NOW);
    const h = idx.health();
    expect(h.documents).toBe(1);
    expect(h.quarantined).toBe(1);
  });

  it('an empty index reports zero rather than NaN', () => {
    const h = index().health();
    expect(h.freshnessP95Ms).toBe(0);
    expect(h.slaBreached).toBe(false);
  });
});

// ============================================ dual-index cutover

describe('a model upgrade runs dual-index with A/B before cutover (RULES)', () => {
  const dual = () => new DualIndex(index({ modelVersion: 'emb-v3' }), index({ modelVersion: 'emb-v4' }));

  it('writes both indices but SERVES the champion', () => {
    const d = dual();
    const r = d.ingest(event(), NOW);
    expect(r.champion.outcome).toBe('INDEXED');
    expect(r.challenger.outcome).toBe('INDEXED');
    expect(d.champion.size()).toBe(1);
    expect(d.challenger.size()).toBe(1);

    // an unproven challenger must not affect shoppers
    const served = d.serve(embedText('Kanchipuram silk saree'), SCHEMA);
    expect(served.ok).toBe(true);
    if (served.ok) expect(served.hits[0].listingId).toBe('LST-1');
  });

  it('refuses cutover on insufficient traffic, however good the numbers look', () => {
    const decision = DualIndex.cutoverDecision({ championCtr: 0.20, challengerCtr: 0.40, queriesEvaluated: 50 });
    expect(decision.cutover).toBe(false);
    if (!decision.cutover) expect(decision.reason).toContain('INSUFFICIENT_AB_TRAFFIC');
    // cutting over on a small sample is how a worse index reaches production with a confident
    // number attached
    expect(MIN_AB_QUERIES).toBe(1_000);
  });

  it('refuses cutover when the challenger does not beat the champion', () => {
    expect(DualIndex.cutoverDecision({ championCtr: 0.30, challengerCtr: 0.28, queriesEvaluated: 5_000 })
      .cutover).toBe(false);
    // a tie is not a win
    expect(DualIndex.cutoverDecision({ championCtr: 0.30, challengerCtr: 0.30, queriesEvaluated: 5_000 })
      .cutover).toBe(false);
  });

  it('permits cutover on a genuine win with enough traffic, reporting the uplift', () => {
    const d = DualIndex.cutoverDecision({ championCtr: 0.30, challengerCtr: 0.345, queriesEvaluated: 12_000 });
    expect(d.cutover).toBe(true);
    if (d.cutover) expect(d.upliftPts).toBeCloseTo(4.5, 1);
  });
});
