/**
 * Semantic & multimodal indexing pipeline — FR-AI-004.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "maintain the search intelligence indices: text embeddings (title+attributes+
 *                enriched copy), image embeddings, synonym/attribute extraction, near-duplicate
 *                detection — updated near-real-time on catalogue events with backfill jobs."
 *   INPUTS:     "Catalogue CDC events, media store, embedding model versions, category schema."
 *   OUTPUTS:    "Versioned vector indices + lexical enrichments, freshness metrics
 *                (event→searchable ≤ 5 min p95), duplicate-cluster ids, index health dashboards."
 *   VALIDATION: "Only Approved listings enter public indices; schema-hash guards prevent
 *                mixed-version queries."
 *   RULES:      "Embedding model upgrades run dual-index with A/B before cutover; deletes
 *                propagate ≤ 2 min (compliance-relevant)."
 *   ERRORS:     "Pipeline lag breach → alert + auto-scale workers; poison document (parse fail)
 *                quarantined with ops task, never blocks batch."
 *
 * Three properties here are the ones that would hurt if wrong, and each is enforced rather than
 * hoped for:
 *
 *  1. ONLY APPROVED LISTINGS REACH THE PUBLIC INDEX. A rejected or withdrawn listing that stays
 *     searchable is the platform continuing to sell something it decided not to sell — and for a
 *     listing pulled on a trademark takedown, that is the takedown having failed.
 *
 *  2. A POISON DOCUMENT NEVER BLOCKS THE BATCH. One unparseable record must not stall indexing for
 *     every other listing behind it. It is quarantined with an ops task and the batch continues,
 *     because the alternative is a single malformed record freezing the whole catalogue's
 *     searchability.
 *
 *  3. DELETES PROPAGATE INSIDE TWO MINUTES, and the requirement flags this as
 *     compliance-relevant. A delete is therefore applied unconditionally and immediately — it does
 *     not queue behind upserts, and it does not care what state the document was in.
 */

/** OUTPUTS: event → searchable, p95. */
export const FRESHNESS_SLA_MS = 5 * 60_000;
/** RULES: deletes propagate within this window. Compliance-relevant. */
export const DELETE_PROPAGATION_SLA_MS = 2 * 60_000;
/** Cosine similarity at or above which two listings are near-duplicates. */
export const NEAR_DUPLICATE_THRESHOLD = 0.95;

export type ListingState = 'APPROVED' | 'PENDING' | 'REJECTED' | 'WITHDRAWN';

export type EventType = 'UPSERT' | 'DELETE';

export interface CatalogueEvent {
  eventId: string;
  listingId: string;
  type: EventType;
  state: ListingState;
  /** Raw payload; a parse failure here is the poison-document case. */
  payload?: {
    title?: string;
    attributes?: Record<string, string>;
    enrichedCopy?: string;
    imageRefs?: string[];
  };
  /** The category schema version this event was produced against. */
  schemaHash: string;
  emittedAtMs: number;
}

export interface Embedding {
  vector: number[];
  modelVersion: string;
}

export interface LexicalEnrichment {
  synonyms: string[];
  attributes: Record<string, string>;
}

export interface IndexDocument {
  listingId: string;
  textEmbedding: Embedding;
  imageEmbedding?: Embedding;
  lexical: LexicalEnrichment;
  schemaHash: string;
  /** OUTPUTS: freshness — how long from event emission to searchable. */
  indexedAtMs: number;
  eventEmittedAtMs: number;
  duplicateClusterId?: string;
}

export interface QuarantinedDocument {
  listingId: string;
  eventId: string;
  reason: string;
  quarantinedAtMs: number;
  /** ERRORS: an ops task accompanies every quarantine, so nothing rots silently. */
  opsTaskRef: string;
}

export type IngestOutcome =
  | { outcome: 'INDEXED'; document: IndexDocument; freshnessMs: number }
  /** VALIDATION: a non-approved listing is kept out of the public index. */
  | { outcome: 'EXCLUDED_NOT_APPROVED'; state: ListingState }
  | { outcome: 'DELETED'; propagatedInMs: number }
  /** ERRORS: quarantined without blocking the batch. */
  | { outcome: 'QUARANTINED'; quarantined: QuarantinedDocument }
  | { outcome: 'REJECTED_SCHEMA_MISMATCH'; expected: string; received: string };

/** The embedding provider, injected as everywhere else in the platform. */
export type Embedder = (text: string) => number[];
export type ImageEmbedder = (imageRef: string) => number[];

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Extract lexical enrichments. Synonyms come from the category schema, not invented. */
export function enrich(payload: NonNullable<CatalogueEvent['payload']>,
                       synonymTable: Record<string, string[]>): LexicalEnrichment {
  const attributes = payload.attributes ?? {};
  const terms = new Set<string>();
  const source = `${payload.title ?? ''} ${Object.values(attributes).join(' ')}`.toLowerCase();
  for (const [term, syns] of Object.entries(synonymTable)) {
    if (source.includes(term.toLowerCase())) {
      for (const s of syns) terms.add(s.toLowerCase());
    }
  }
  return { synonyms: [...terms].sort(), attributes };
}

export interface IndexHealth {
  documents: number;
  quarantined: number;
  /** OUTPUTS: p95 of event → searchable. */
  freshnessP95Ms: number;
  slaBreached: boolean;
  /** ERRORS: a lag breach alerts and asks for more workers. */
  autoScaleRequested: boolean;
  duplicateClusters: number;
}

export class SemanticIndex {
  private readonly documents = new Map<string, IndexDocument>();
  private readonly quarantine: QuarantinedDocument[] = [];
  private readonly freshnessSamples: number[] = [];
  private deleteLatencies: number[] = [];

  constructor(
    readonly modelVersion: string,
    readonly schemaHash: string,
    private readonly embedText: Embedder,
    private readonly embedImage?: ImageEmbedder,
    private readonly synonymTable: Record<string, string[]> = {},
  ) {}

  /**
   * Ingest one catalogue event. Deletes are handled FIRST and unconditionally, because the
   * requirement marks delete propagation as compliance-relevant: a takedown must not wait behind
   * a state check or an upsert queue.
   */
  ingest(event: CatalogueEvent, nowMs: number): IngestOutcome {
    if (event.type === 'DELETE') {
      this.documents.delete(event.listingId);
      const latency = nowMs - event.emittedAtMs;
      this.deleteLatencies.push(latency);
      return { outcome: 'DELETED', propagatedInMs: latency };
    }

    // VALIDATION: schema-hash guard. An event produced against a different category schema is
    // refused rather than indexed alongside documents it cannot be compared with.
    if (event.schemaHash !== this.schemaHash) {
      return {
        outcome: 'REJECTED_SCHEMA_MISMATCH',
        expected: this.schemaHash,
        received: event.schemaHash,
      };
    }

    // VALIDATION: only approved listings enter the public index. A previously indexed listing that
    // has since been rejected or withdrawn is REMOVED, not merely skipped.
    if (event.state !== 'APPROVED') {
      this.documents.delete(event.listingId);
      return { outcome: 'EXCLUDED_NOT_APPROVED', state: event.state };
    }

    // ERRORS: a poison document is quarantined with an ops task and the batch carries on.
    if (!event.payload || !event.payload.title || event.payload.title.trim().length === 0) {
      const q: QuarantinedDocument = {
        listingId: event.listingId,
        eventId: event.eventId,
        reason: 'PARSE_FAILURE_MISSING_TITLE',
        quarantinedAtMs: nowMs,
        opsTaskRef: `OPS-INDEX-${event.listingId}`,
      };
      this.quarantine.push(q);
      return { outcome: 'QUARANTINED', quarantined: q };
    }

    let textEmbedding: Embedding;
    try {
      const text = [
        event.payload.title,
        ...Object.values(event.payload.attributes ?? {}),
        event.payload.enrichedCopy ?? '',
      ].join(' ');
      textEmbedding = { vector: this.embedText(text), modelVersion: this.modelVersion };
      if (textEmbedding.vector.length === 0) throw new Error('empty vector');
    } catch {
      const q: QuarantinedDocument = {
        listingId: event.listingId,
        eventId: event.eventId,
        reason: 'TEXT_EMBEDDING_FAILED',
        quarantinedAtMs: nowMs,
        opsTaskRef: `OPS-INDEX-${event.listingId}`,
      };
      this.quarantine.push(q);
      return { outcome: 'QUARANTINED', quarantined: q };
    }

    let imageEmbedding: Embedding | undefined;
    const firstImage = event.payload.imageRefs?.[0];
    if (firstImage && this.embedImage) {
      try {
        const v = this.embedImage(firstImage);
        // an image embedding failure degrades the document to text-only rather than quarantining
        // it: a listing with a bad photo is still worth finding by name
        if (v.length > 0) imageEmbedding = { vector: v, modelVersion: this.modelVersion };
      } catch {
        imageEmbedding = undefined;
      }
    }

    const document: IndexDocument = {
      listingId: event.listingId,
      textEmbedding,
      imageEmbedding,
      lexical: enrich(event.payload, this.synonymTable),
      schemaHash: event.schemaHash,
      indexedAtMs: nowMs,
      eventEmittedAtMs: event.emittedAtMs,
    };
    this.documents.set(document.listingId, document);

    const freshnessMs = nowMs - event.emittedAtMs;
    this.freshnessSamples.push(freshnessMs);
    return { outcome: 'INDEXED', document, freshnessMs };
  }

  /**
   * Ingest a batch. ERRORS: a poison document never blocks the batch — every other event is still
   * processed and the outcomes are reported per event.
   */
  ingestBatch(events: CatalogueEvent[], nowMs: number): IngestOutcome[] {
    return events.map((e) => this.ingest(e, nowMs));
  }

  /**
   * VALIDATION: query with a schema-hash guard. A caller holding a stale schema is refused rather
   * than served results computed under different assumptions about what the attributes mean.
   */
  query(vector: number[], schemaHash: string, limit = 10):
    { ok: true; hits: Array<{ listingId: string; score: number }> }
    | { ok: false; reason: string } {
    if (schemaHash !== this.schemaHash) {
      return {
        ok: false,
        reason: `SCHEMA_HASH_MISMATCH: index ${this.schemaHash}, query ${schemaHash}`,
      };
    }
    const hits = [...this.documents.values()]
      .map((d) => ({ listingId: d.listingId, score: cosineSimilarity(vector, d.textEmbedding.vector) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.listingId.localeCompare(b.listingId))
      .slice(0, limit);
    return { ok: true, hits };
  }

  /** Query the image index specifically, for FR-CUS-012. */
  queryByImage(vector: number[], schemaHash: string, limit = 20):
    { ok: true; hits: Array<{ listingId: string; score: number }> }
    | { ok: false; reason: string } {
    if (schemaHash !== this.schemaHash) {
      return { ok: false, reason: `SCHEMA_HASH_MISMATCH: index ${this.schemaHash}, query ${schemaHash}` };
    }
    const hits = [...this.documents.values()]
      .filter((d) => d.imageEmbedding !== undefined)
      .map((d) => ({ listingId: d.listingId, score: cosineSimilarity(vector, d.imageEmbedding!.vector) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.listingId.localeCompare(b.listingId))
      .slice(0, limit);
    return { ok: true, hits };
  }

  /**
   * OUTPUTS: near-duplicate clusters. Assigns a stable cluster id to every group of listings whose
   * text embeddings sit above the threshold, so a search can collapse them rather than showing a
   * shopper the same saree from six sellers.
   */
  computeDuplicateClusters(): Map<string, string[]> {
    const clusters = new Map<string, string[]>();
    const assigned = new Set<string>();
    const docs = [...this.documents.values()].sort((a, b) => a.listingId.localeCompare(b.listingId));

    for (const doc of docs) {
      if (assigned.has(doc.listingId)) continue;
      const clusterId = `dup:${doc.listingId}`;
      const members = [doc.listingId];
      assigned.add(doc.listingId);
      doc.duplicateClusterId = clusterId;

      for (const other of docs) {
        if (assigned.has(other.listingId)) continue;
        const sim = cosineSimilarity(doc.textEmbedding.vector, other.textEmbedding.vector);
        if (sim >= NEAR_DUPLICATE_THRESHOLD) {
          members.push(other.listingId);
          assigned.add(other.listingId);
          other.duplicateClusterId = clusterId;
        }
      }
      clusters.set(clusterId, members);
    }
    return clusters;
  }

  /** OUTPUTS: index health, including the freshness p95 and whether the SLA is breached. */
  health(): IndexHealth {
    const sorted = [...this.freshnessSamples].sort((a, b) => a - b);
    const p95 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const breached = p95 > FRESHNESS_SLA_MS;
    return {
      documents: this.documents.size,
      quarantined: this.quarantine.length,
      freshnessP95Ms: p95,
      slaBreached: breached,
      autoScaleRequested: breached,
      duplicateClusters: this.computeDuplicateClusters().size,
    };
  }

  /** RULES: is delete propagation inside the compliance window? */
  deletePropagationBreaches(): number[] {
    return this.deleteLatencies.filter((l) => l > DELETE_PROPAGATION_SLA_MS);
  }

  quarantinedDocuments(): QuarantinedDocument[] {
    return [...this.quarantine];
  }

  /** A quarantined document is re-ingestible once the payload is fixed. */
  releaseFromQuarantine(listingId: string): boolean {
    const before = this.quarantine.length;
    const idx = this.quarantine.findIndex((q) => q.listingId === listingId);
    if (idx >= 0) this.quarantine.splice(idx, 1);
    return this.quarantine.length < before;
  }

  document(listingId: string): IndexDocument | undefined {
    return this.documents.get(listingId);
  }

  size(): number {
    return this.documents.size;
  }

  isSearchable(listingId: string): boolean {
    return this.documents.has(listingId);
  }
}

// ================================================= dual-index A/B cutover

export interface AbResult {
  /** Fraction of queries where the challenger's top hit was clicked, versus the champion's. */
  championCtr: number;
  challengerCtr: number;
  queriesEvaluated: number;
}

export type CutoverDecision =
  | { cutover: true; upliftPts: number }
  | { cutover: false; reason: string };

/** Minimum queries before an A/B comparison is worth acting on. */
export const MIN_AB_QUERIES = 1_000;

/**
 * RULES: an embedding model upgrade runs DUAL-INDEX with A/B before cutover. The champion keeps
 * serving until the challenger has demonstrably won on enough traffic — cutting over on a small
 * sample is how a worse index reaches production with a confident number attached.
 */
export class DualIndex {
  constructor(
    readonly champion: SemanticIndex,
    readonly challenger: SemanticIndex,
  ) {}

  /** Both indices are written; only the champion is read until cutover. */
  ingest(event: CatalogueEvent, nowMs: number): { champion: IngestOutcome; challenger: IngestOutcome } {
    return {
      champion: this.champion.ingest(event, nowMs),
      challenger: this.challenger.ingest(event, nowMs),
    };
  }

  /** Serving reads the CHAMPION, so an unproven challenger cannot affect shoppers. */
  serve(vector: number[], schemaHash: string, limit = 10) {
    return this.champion.query(vector, schemaHash, limit);
  }

  static cutoverDecision(ab: AbResult): CutoverDecision {
    if (ab.queriesEvaluated < MIN_AB_QUERIES) {
      return {
        cutover: false,
        reason: `INSUFFICIENT_AB_TRAFFIC: ${ab.queriesEvaluated} < ${MIN_AB_QUERIES}`,
      };
    }
    if (ab.challengerCtr <= ab.championCtr) {
      return { cutover: false, reason: 'CHALLENGER_DID_NOT_BEAT_CHAMPION' };
    }
    return {
      cutover: true,
      upliftPts: Math.round((ab.challengerCtr - ab.championCtr) * 1000) / 10,
    };
  }
}
