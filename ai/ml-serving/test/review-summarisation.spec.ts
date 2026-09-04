/**
 * FR-AI-014 AI review summarisation. The test that matters most is the one where a fabricating
 * summariser is REJECTED: "strictly extractive-grounded" is only meaningful if an ungrounded claim
 * cannot reach a product page, and that must hold without relying on the model behaving.
 */
import { describe, expect, it } from 'vitest';
import {
  buildProviderPayload,
  comparativeViolation,
  contentWords,
  generateSummary,
  GROUNDEDNESS_OVERLAP_THRESHOLD,
  isGrounded,
  isRegenerationOverdue,
  isStale,
  MIN_REVIEWS_FOR_SUMMARY,
  REGENERATION_SLA_MS,
  regenerationEvent,
  renderableSummary,
  reviewSetHash,
  type Claim,
  type ReviewInput,
  type SummaryDraft,
  type Summariser,
} from '../src/domain/review-summarisation.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

const review = (id: string, body: string, over: Partial<ReviewInput> = {}): ReviewInput => ({
  reviewId: id, stars: 4, body, locale: 'en-IN', verified: true, published: true, ...over,
});

/** Six eligible reviews, one of which speaks to battery life. */
const reviewPool = (): ReviewInput[] => [
  review('R1', 'The battery easily lasts two days on a single charge'),
  review('R2', 'Fabric quality is excellent and the stitching is neat'),
  review('R3', 'Delivery was quick and the packaging was secure'),
  review('R4', 'Colour is slightly duller than the photographs suggest', { stars: 3 }),
  review('R5', 'Sizing runs small, order one size up', { stars: 3 }),
  review('R6', 'Screen brightness is good even outdoors'),
];

const draft = (over: Partial<SummaryDraft> = {}): SummaryDraft => ({
  gist: 'Buyers praise the battery and build, with some noting the sizing runs small',
  pros: [{ text: 'battery lasts two days', citedReviewIds: ['R1'] }],
  cons: [{ text: 'sizing runs small', citedReviewIds: ['R5'] }],
  aspects: [{ aspect: 'display', claim: { text: 'screen brightness is good outdoors', citedReviewIds: ['R6'] } }],
  ...over,
});

const summariser = (d: SummaryDraft = draft()): Summariser => () => d;

// ================================================= the acceptance criterion

describe('the documented acceptance case: opening a citation shows a supporting review', () => {
  it('a summary claiming "battery lasts two days" cites a review containing that substance', () => {
    const res = generateSummary(reviewPool(), ['display', 'battery'], 'en-IN', summariser(), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const citation = res.summary.citations.find((c) => c.claimText === 'battery lasts two days');
    expect(citation).toBeDefined();
    expect(citation!.reviewId).toBe('R1');
    // the quote a reader taps through to genuinely contains the claim's substance
    expect(citation!.quote).toBe('The battery easily lasts two days on a single charge');
    expect(citation!.quote.toLowerCase()).toContain('battery');
    expect(citation!.quote.toLowerCase()).toContain('two days');
  });

  it('every claim in the published summary has a citation', () => {
    const res = generateSummary(reviewPool(), ['display'], 'en-IN', summariser(), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const claimCount = res.summary.pros.length + res.summary.cons.length + res.summary.aspects.length;
    expect(res.summary.citations).toHaveLength(claimCount);
    expect(res.summary.citations.every((c) => c.reviewId.length > 0)).toBe(true);
  });

  it('carries a freshness stamp and the review count it was built from', () => {
    const res = generateSummary(reviewPool(), [], 'en-IN', summariser(), NOW);
    if (!res.ok) throw new Error('expected a summary');
    expect(res.summary.generatedAtMs).toBe(NOW);
    expect(res.summary.reviewCount).toBe(6);
    expect(res.summary.reviewSetHash).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ================================================= groundedness enforcement

describe('a fabricating summariser cannot publish (VALIDATION)', () => {
  it('rejects a claim whose cited review does not support it', () => {
    // cites R2 (fabric) for a battery claim — the classic hallucinated citation
    const fabricated = draft({
      pros: [{ text: 'battery lasts two days', citedReviewIds: ['R2'] }],
    });
    const res = generateSummary(reviewPool(), [], 'en-IN', summariser(fabricated), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('CLAIM_NOT_SUPPORTED_BY_ANY_CITED_REVIEW');
      expect(res.hidden).toBe(true);
    }
  });

  it('rejects a claim with no citation at all', () => {
    const uncited = draft({ pros: [{ text: 'waterproof to fifty metres', citedReviewIds: [] }] });
    const res = generateSummary(reviewPool(), [], 'en-IN', summariser(uncited), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('CLAIM_HAS_NO_CITATION');
  });

  it('rejects a citation to a review outside the eligible set', () => {
    const phantom = draft({ pros: [{ text: 'battery lasts two days', citedReviewIds: ['R-DOES-NOT-EXIST'] }] });
    const res = generateSummary(reviewPool(), [], 'en-IN', summariser(phantom), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('CITED_REVIEW_NOT_IN_ELIGIBLE_SET');
  });

  it('checks aspect claims too, not just pros and cons', () => {
    const badAspect = draft({
      aspects: [{ aspect: 'waterproofing', claim: { text: 'survives full immersion', citedReviewIds: ['R3'] } }],
    });
    const res = generateSummary(reviewPool(), ['waterproofing'], 'en-IN', summariser(badAspect), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('CLAIM_NOT_SUPPORTED');
  });

  it('a light rephrase is grounded, because extractive does not mean verbatim', () => {
    const pool = reviewPool();
    // "battery lasts two days" vs "The battery easily lasts two days on a single charge"
    const g = isGrounded({ text: 'battery lasts two days', citedReviewIds: ['R1'] }, pool);
    expect(g.grounded).toBe(true);
    if (g.grounded) expect(g.supportingReviewId).toBe('R1');
  });

  it('a claim that adds substance the review lacks is not grounded', () => {
    const pool = reviewPool();
    const g = isGrounded(
      { text: 'battery lasts two weeks in airplane mode', citedReviewIds: ['R1'] }, pool);
    expect(g.grounded).toBe(false);
  });

  it('a claim with multiple citations is grounded if ANY of them supports it', () => {
    const pool = reviewPool();
    const g = isGrounded({ text: 'sizing runs small', citedReviewIds: ['R2', 'R5'] }, pool);
    expect(g.grounded).toBe(true);
    if (g.grounded) expect(g.supportingReviewId).toBe('R5');
  });

  it('a substance-free claim is rejected rather than trivially grounded', () => {
    const pool = reviewPool();
    const g = isGrounded({ text: 'it is very the a', citedReviewIds: ['R1'] }, pool);
    expect(g.grounded).toBe(false);
    if (!g.grounded) expect(g.reason).toContain('CLAIM_HAS_NO_SUBSTANCE');
  });

  it('the overlap threshold is a real fraction, not a token gesture', () => {
    expect(GROUNDEDNESS_OVERLAP_THRESHOLD).toBeGreaterThan(0.5);
    expect(GROUNDEDNESS_OVERLAP_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it('content-word extraction drops stopwords and punctuation', () => {
    expect(contentWords('The battery, it is very good!')).toEqual(['battery', 'good']);
    expect(contentWords('a the is of')).toEqual([]);
  });
});

// ================================================= comparative claims

describe('summaries never introduce comparative claims (RULES)', () => {
  it('detects the comparative forms a summariser reaches for', () => {
    for (const text of [
      'better than the competing model',
      'worse than other sarees',
      'compared to similar products it excels',
      'unlike other brands the finish is even',
      'best in class battery life',
      'beats the alternatives on price',
      'outperforms rival handsets',
      'cheaper than comparable options',
      'superior to anything else available',
    ]) {
      expect(comparativeViolation({ text, citedReviewIds: ['R1'] })).not.toBeNull();
    }
  });

  it('does not flag ordinary praise', () => {
    for (const text of ['battery lasts two days', 'sizing runs small', 'colour is duller than photographs']) {
      expect(comparativeViolation({ text, citedReviewIds: ['R1'] })).toBeNull();
    }
  });

  it('a comparative claim hides the section even when it is otherwise grounded', () => {
    const pool = [...reviewPool(), review('R7', 'This is better than the model I owned before')];
    const comparative = draft({
      pros: [{ text: 'better than the model I owned before', citedReviewIds: ['R7'] }],
    });
    const res = generateSummary(pool, [], 'en-IN', summariser(comparative), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // grounded in a real review, yet still refused: the platform must not make the comparison
      expect(res.reason).toContain('COMPARATIVE_CLAIM_NOT_PERMITTED');
      expect(res.hidden).toBe(true);
    }
  });
});

// ================================================= threshold suppression

describe('summaries are suppressed below the review threshold (VALIDATION)', () => {
  it('requires at least five eligible reviews', () => {
    expect(MIN_REVIEWS_FOR_SUMMARY).toBe(5);
    const four = reviewPool().slice(0, 4);
    const res = generateSummary(four, [], 'en-IN', summariser(), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain('BELOW_REVIEW_THRESHOLD');
      expect(res.hidden).toBe(true);
    }
    expect(generateSummary(reviewPool().slice(0, 5), [], 'en-IN',
      summariser(draft({ aspects: [] })), NOW).ok).toBe(true);
  });

  it('unverified, unpublished and other-locale reviews do not count towards the threshold', () => {
    const pool = [
      review('R1', 'The battery easily lasts two days on a single charge'),
      review('R2', 'Fabric quality is excellent', { verified: false }),
      review('R3', 'Delivery was quick', { published: false }),
      review('R4', 'நல்ல தரம்', { locale: 'ta-IN' }),
      review('R5', 'Sizing runs small'),
    ];
    const res = generateSummary(pool, [], 'en-IN', summariser(), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('BELOW_REVIEW_THRESHOLD');
  });

  it('a locale with its own eligible reviews summarises independently', () => {
    const tamil = Array.from({ length: 5 }, (_, i) =>
      review(`T${i}`, 'பேட்டரி இரண்டு நாட்கள் நீடிக்கும்', { locale: 'ta-IN' }));
    const tamilDraft: SummaryDraft = {
      gist: 'பேட்டரி பற்றி நல்ல கருத்து',
      pros: [{ text: 'பேட்டரி இரண்டு நாட்கள் நீடிக்கும்', citedReviewIds: ['T0'] }],
      cons: [],
      aspects: [],
    };
    const res = generateSummary(tamil, [], 'ta-IN', summariser(tamilDraft), NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.summary.locale).toBe('ta-IN');
  });
});

// ================================================= generation failure

describe('generation failure hides the section (ERRORS)', () => {
  it('a throwing summariser yields no summary', () => {
    const broken: Summariser = () => { throw new Error('provider timeout'); };
    const res = generateSummary(reviewPool(), [], 'en-IN', broken, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('GENERATION_FAILED');
      expect(res.hidden).toBe(true);
    }
  });

  it('an empty gist is treated as a failure rather than published', () => {
    const res = generateSummary(reviewPool(), [], 'en-IN', summariser(draft({ gist: '   ' })), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('GENERATION_RETURNED_EMPTY_GIST');
  });
});

// ================================================= PII-free prompts

describe('provider calls are PII-free (SECURITY)', () => {
  it('the payload carries review bodies keyed by id, with no reviewer identity field', () => {
    const payload = buildProviderPayload(reviewPool(), ['battery'], 'en-IN');
    expect(payload.reviews).toHaveLength(6);
    for (const r of payload.reviews) {
      expect(Object.keys(r).sort()).toEqual(['body', 'reviewId', 'stars']);
    }
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('customerId');
    expect(serialised).not.toContain('verified');
  });

  it('the summariser receives only the payload, so identity cannot leak through the call', () => {
    let seenKeys: string[] = [];
    const inspecting: Summariser = (payload) => {
      seenKeys = Object.keys(payload).sort();
      return draft();
    };
    generateSummary(reviewPool(), ['battery'], 'en-IN', inspecting, NOW);
    expect(seenKeys).toEqual(['aspectLabels', 'locale', 'reviews']);
  });
});

// ================================================= regeneration

describe('review-set changes trigger regeneration (RULES)', () => {
  it('the hash changes when a review is moderated out', () => {
    const before = reviewPool();
    const after = before.filter((r) => r.reviewId !== 'R4');
    expect(reviewSetHash(after)).not.toBe(reviewSetHash(before));
  });

  it('the hash is stable for the same set regardless of order', () => {
    const a = reviewPool();
    const b = [...a].reverse();
    expect(reviewSetHash(b)).toBe(reviewSetHash(a));
  });

  it('a summary goes stale when its review set changes, and is then HIDDEN', () => {
    const res = generateSummary(reviewPool(), [], 'en-IN', summariser(), NOW);
    if (!res.ok) throw new Error('expected a summary');
    const summary = res.summary;

    expect(isStale(summary, reviewPool())).toBe(false);
    expect(renderableSummary(summary, reviewPool()).render).toBe(true);

    // R1 — the battery review this summary cites — is moderated out
    const moderated = reviewPool().map((r) =>
      r.reviewId === 'R1' ? { ...r, published: false } : r);
    expect(isStale(summary, moderated)).toBe(true);
    const render = renderableSummary(summary, moderated);
    expect(render.render).toBe(false);
    if (!render.render) expect(render.reason).toBe('REVIEW_SET_CHANGED_AWAITING_REGENERATION');
  });

  it('regeneration is due within an hour of the change', () => {
    expect(REGENERATION_SLA_MS).toBe(3_600_000);
    expect(isRegenerationOverdue(NOW, NOW + REGENERATION_SLA_MS)).toBe(false);
    expect(isRegenerationOverdue(NOW, NOW + REGENERATION_SLA_MS + 1)).toBe(true);
  });

  it('a regeneration event records the trigger and both hashes', () => {
    const first = generateSummary(reviewPool(), [], 'en-IN', summariser(), NOW);
    if (!first.ok) throw new Error('expected a summary');

    const smaller = reviewPool().filter((r) => r.reviewId !== 'R4');
    const second = generateSummary(smaller, [], 'en-IN', summariser(), NOW + 60_000);
    if (!second.ok) throw new Error('expected a regenerated summary');

    const ev = regenerationEvent('REVIEW_MODERATED_OUT', first.summary, second.summary);
    expect(ev.trigger).toBe('REVIEW_MODERATED_OUT');
    expect(ev.fromHash).toBe(first.summary.reviewSetHash);
    expect(ev.toHash).toBe(second.summary.reviewSetHash);
    expect(ev.fromHash).not.toBe(ev.toHash);
    expect(ev.reviewCount).toBe(5);
    expect(ev.atMs).toBe(NOW + 60_000);
  });

  it('a first generation records a null previous hash rather than a fabricated one', () => {
    const res = generateSummary(reviewPool(), [], 'en-IN', summariser(), NOW);
    if (!res.ok) throw new Error('expected a summary');
    expect(regenerationEvent('SCHEDULED', null, res.summary).fromHash).toBeNull();
  });
});
