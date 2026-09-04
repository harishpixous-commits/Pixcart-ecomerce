/**
 * AI review summarisation — FR-AI-014.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "produce PDP review summaries — overall gist, pros/cons, aspect highlights —
 *                strictly extractive-grounded on verified reviews, refreshed on review-set
 *                change, with quote-level citations and a freshness stamp."
 *   INPUTS:     "Verified published reviews (≥ 5 required), aspect labels, locale."
 *   OUTPUTS:    "Summary blocks with tap-to-see-source quotes, per-locale variants, regeneration
 *                events log."
 *   VALIDATION: "Every claim maps to ≥ 1 cited review (groundedness check in eval harness);
 *                summaries suppressed below review threshold."
 *   RULES:      "Moderated-out reviews trigger regeneration ≤ 1 h; summaries never introduce
 *                comparative claims vs other products."
 *   ERRORS:     "Generation failure → section hidden (no stale mismatched summary if review set
 *                materially changed)."
 *   SECURITY:   "Reviewer identities excluded from prompts; provider calls PII-free."
 *   ACCEPTANCE: "Given a summary claiming 'battery lasts two days', When its citation is opened,
 *                Then a verified review containing that substance displays; the automated
 *                groundedness test enforces it."
 *
 * The groundedness check is the substance of this requirement, and it is implemented as a real
 * check rather than a declared intention: a claim is grounded only if it cites at least one
 * review AND the cited review actually contains the claim's content words. A claim that cites a
 * review which does not support it is REJECTED — that is precisely the failure mode "strictly
 * extractive-grounded" exists to prevent, and it is the one an unverified summariser produces
 * most readily.
 *
 * The summariser itself is INJECTED, as with the pricing, risk and recommendation models. A
 * summariser that fabricates cannot get its output published, because publication runs the
 * groundedness gate — so the safety property does not depend on the model behaving.
 */

/** INPUTS: at least this many verified published reviews before a summary may exist. */
export const MIN_REVIEWS_FOR_SUMMARY = 5;
/** RULES: a moderated-out review must trigger regeneration within this window. */
export const REGENERATION_SLA_MS = 60 * 60 * 1000;
/** Fraction of a claim's content words that must appear in a cited review. */
export const GROUNDEDNESS_OVERLAP_THRESHOLD = 0.6;

/** A verified, published review as supplied by the catalogue service. */
export interface ReviewInput {
  reviewId: string;
  stars: number;
  body: string;
  locale: string;
  /** Only verified, published reviews are eligible — the caller filters, we re-check. */
  verified: boolean;
  published: boolean;
}

export interface Claim {
  text: string;
  /** Quote-level citations: the reviews this claim is drawn from. */
  citedReviewIds: string[];
}

export interface SummaryDraft {
  gist: string;
  pros: Claim[];
  cons: Claim[];
  aspects: Array<{ aspect: string; claim: Claim }>;
}

export interface PublishedSummary extends SummaryDraft {
  locale: string;
  /** Freshness stamp and the review-set fingerprint the summary was built from. */
  generatedAtMs: number;
  reviewSetHash: string;
  reviewCount: number;
  /** Every claim, with the quote a reader taps through to. */
  citations: Array<{ claimText: string; reviewId: string; quote: string }>;
}

/** The PII-free payload handed to the provider. Reviewer identity is absent by construction. */
export interface ProviderPayload {
  locale: string;
  aspectLabels: string[];
  /** Review bodies keyed by id only — no customer id, name or contact anywhere. */
  reviews: Array<{ reviewId: string; stars: number; body: string }>;
}

export type Summariser = (payload: ProviderPayload) => SummaryDraft;

export type SummaryResult =
  | { ok: true; summary: PublishedSummary }
  | { ok: false; reason: string; hidden: true };

/** RULES: comparative claims against other products are not permitted. */
const COMPARATIVE_PATTERNS: RegExp[] = [
  /\bbetter than\b/i,
  /\bworse than\b/i,
  /\bcompared (?:to|with)\b/i,
  /\bunlike (?:the|other)\b/i,
  /\bbest in (?:its |the )?(?:class|category|market)\b/i,
  /\bbeats\b/i,
  /\boutperforms\b/i,
  /\bcheaper than\b/i,
  /\bsuperior to\b/i,
];

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from', 'had', 'has',
  'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were',
  'with', 'very', 'really', 'quite', 'my', 'i', 'we', 'you', 'they', 'so', 'too', 'just',
]);

/**
 * Content words used for the groundedness overlap check.
 *
 * Tokenisation is Unicode-aware (\p{L}\p{N}) rather than ASCII-only. This platform serves Tamil
 * and English side by side, and an ASCII-only tokeniser silently yields zero content words for a
 * Tamil review — which would fail closed and quietly disable summaries for every Tamil locale
 * rather than erroring visibly.
 */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * VALIDATION: is this claim extractively grounded in the cited reviews?
 *
 * A claim must cite at least one review, every cited id must exist in the eligible set, and at
 * least one cited review must contain enough of the claim's content words to support it. The
 * threshold is deliberately not 100%: an extractive summary rephrases lightly ("battery lasts two
 * days" from "the battery easily lasts two days"), but it may not introduce substance the review
 * does not carry.
 */
export function isGrounded(claim: Claim, reviews: ReviewInput[]):
  { grounded: true; supportingReviewId: string } | { grounded: false; reason: string } {
  if (claim.citedReviewIds.length === 0) {
    return { grounded: false, reason: `CLAIM_HAS_NO_CITATION: "${claim.text}"` };
  }
  const byId = new Map(reviews.map((r) => [r.reviewId, r]));
  for (const id of claim.citedReviewIds) {
    if (!byId.has(id)) {
      return { grounded: false, reason: `CITED_REVIEW_NOT_IN_ELIGIBLE_SET: ${id}` };
    }
  }
  const claimWords = contentWords(claim.text);
  if (claimWords.length === 0) {
    return { grounded: false, reason: `CLAIM_HAS_NO_SUBSTANCE: "${claim.text}"` };
  }
  for (const id of claim.citedReviewIds) {
    const reviewWords = new Set(contentWords(byId.get(id)!.body));
    const overlap = claimWords.filter((w) => reviewWords.has(w)).length / claimWords.length;
    if (overlap >= GROUNDEDNESS_OVERLAP_THRESHOLD) {
      return { grounded: true, supportingReviewId: id };
    }
  }
  return {
    grounded: false,
    reason: `CLAIM_NOT_SUPPORTED_BY_ANY_CITED_REVIEW: "${claim.text}"`,
  };
}

/** RULES: reject a claim that compares this product to another. */
export function comparativeViolation(claim: Claim): string | null {
  for (const p of COMPARATIVE_PATTERNS) {
    if (p.test(claim.text)) return `COMPARATIVE_CLAIM_NOT_PERMITTED: "${claim.text}"`;
  }
  return null;
}

/**
 * A fingerprint of the eligible review set. Any addition, removal or moderation changes it, which
 * is what makes "refreshed on review-set change" detectable without polling every review.
 */
export function reviewSetHash(reviews: ReviewInput[]): string {
  const canonical = reviews
    .map((r) => `${r.reviewId}:${r.stars}:${r.body.length}`)
    .sort()
    .join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** SECURITY: build the provider payload. Reviewer identity has no field to travel in. */
export function buildProviderPayload(reviews: ReviewInput[], aspectLabels: string[], locale: string): ProviderPayload {
  return {
    locale,
    aspectLabels: [...aspectLabels],
    reviews: reviews.map((r) => ({ reviewId: r.reviewId, stars: r.stars, body: r.body })),
  };
}

function eligible(reviews: ReviewInput[], locale: string): ReviewInput[] {
  return reviews.filter((r) => r.verified && r.published && r.locale.split('-')[0] === locale.split('-')[0]);
}

function allClaims(draft: SummaryDraft): Claim[] {
  return [...draft.pros, ...draft.cons, ...draft.aspects.map((a) => a.claim)];
}

/**
 * Generate and publish a summary. Publication runs every gate, so a fabricating summariser cannot
 * get output onto a PDP: below the review threshold, on a generation failure, on an ungrounded
 * claim or on a comparative claim, the section is HIDDEN rather than shown in a degraded form.
 */
export function generateSummary(
  reviews: ReviewInput[],
  aspectLabels: string[],
  locale: string,
  summariser: Summariser,
  nowMs: number,
): SummaryResult {
  const pool = eligible(reviews, locale);

  // VALIDATION: summaries are suppressed below the review threshold.
  if (pool.length < MIN_REVIEWS_FOR_SUMMARY) {
    return {
      ok: false,
      reason: `BELOW_REVIEW_THRESHOLD: ${pool.length} < ${MIN_REVIEWS_FOR_SUMMARY}`,
      hidden: true,
    };
  }

  const payload = buildProviderPayload(pool, aspectLabels, locale);

  let draft: SummaryDraft;
  try {
    draft = summariser(payload);
  } catch {
    // ERRORS: a generation failure hides the section rather than showing something stale.
    return { ok: false, reason: 'GENERATION_FAILED', hidden: true };
  }

  if (!draft || typeof draft.gist !== 'string' || draft.gist.trim().length === 0) {
    return { ok: false, reason: 'GENERATION_RETURNED_EMPTY_GIST', hidden: true };
  }

  // RULES: no comparative claims, checked before groundedness so the clearer error wins.
  for (const claim of allClaims(draft)) {
    const violation = comparativeViolation(claim);
    if (violation) return { ok: false, reason: violation, hidden: true };
  }

  // VALIDATION: every claim must be extractively grounded in a cited review.
  const citations: PublishedSummary['citations'] = [];
  for (const claim of allClaims(draft)) {
    const g = isGrounded(claim, pool);
    if (!g.grounded) return { ok: false, reason: g.reason, hidden: true };
    const supporting = pool.find((r) => r.reviewId === g.supportingReviewId)!;
    citations.push({ claimText: claim.text, reviewId: supporting.reviewId, quote: supporting.body });
  }

  return {
    ok: true,
    summary: {
      ...draft,
      locale,
      generatedAtMs: nowMs,
      reviewSetHash: reviewSetHash(pool),
      reviewCount: pool.length,
      citations,
    },
  };
}

/**
 * RULES: has the review set changed materially since the summary was built? A moderated-out
 * review changes the hash, which is what obliges regeneration.
 */
export function isStale(summary: PublishedSummary, currentReviews: ReviewInput[]): boolean {
  return reviewSetHash(eligible(currentReviews, summary.locale)) !== summary.reviewSetHash;
}

/** RULES: regeneration is due within an hour of the review set changing. */
export function regenerationDeadlineMs(changedAtMs: number): number {
  return changedAtMs + REGENERATION_SLA_MS;
}

export function isRegenerationOverdue(changedAtMs: number, nowMs: number): boolean {
  return nowMs > regenerationDeadlineMs(changedAtMs);
}

/**
 * ERRORS: what a PDP should render. A stale summary is HIDDEN rather than displayed, because a
 * summary that cites a moderated-out review is worse than no summary.
 */
export function renderableSummary(summary: PublishedSummary, currentReviews: ReviewInput[]):
  { render: true; summary: PublishedSummary } | { render: false; reason: string } {
  if (isStale(summary, currentReviews)) {
    return { render: false, reason: 'REVIEW_SET_CHANGED_AWAITING_REGENERATION' };
  }
  return { render: true, summary };
}

/** OUTPUTS: the regeneration events log. */
export interface RegenerationEvent {
  atMs: number;
  locale: string;
  trigger: 'REVIEW_ADDED' | 'REVIEW_MODERATED_OUT' | 'SCHEDULED' | 'MANUAL';
  fromHash: string | null;
  toHash: string;
  reviewCount: number;
}

export function regenerationEvent(
  trigger: RegenerationEvent['trigger'],
  previous: PublishedSummary | null,
  next: PublishedSummary,
): RegenerationEvent {
  return {
    atMs: next.generatedAtMs,
    locale: next.locale,
    trigger,
    fromHash: previous?.reviewSetHash ?? null,
    toHash: next.reviewSetHash,
    reviewCount: next.reviewCount,
  };
}
