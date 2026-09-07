/**
 * FR-AI-013 AI content generation. The tests that matter most are the ones where a plausible but
 * wrong draft is BLOCKED: a copilot that hands a vendor copy contradicting their own catalogue data
 * creates a misleading-advertising exposure the vendor carries under the T&C, so the gate must hold
 * regardless of how confident the model is.
 */
import { describe, expect, it } from 'vitest';
import * as ContentGeneration from '../src/domain/content-generation.js';
import {
  acceptSuggestion,
  findContradictions,
  generateContent,
  imageUsable,
  MIN_IMAGE_EDGE_PX,
  MIN_IMAGE_QUALITY,
  prohibitedClaimFound,
  SUPPORTED_LOCALES,
  telemetrySummary,
  TranslationMemory,
  type AttributeVocabulary,
  type Draft,
  type GenerationRequest,
  type Generator,
  type ImageAsset,
  type Suggestion,
  type TelemetryEntry,
} from '../src/domain/content-generation.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

const goodImage: ImageAsset = { ref: 'img://1', qualityScore: 0.9, widthPx: 1200, heightPx: 1600 };

const vocabulary: AttributeVocabulary = {
  fabric: ['cotton', 'silk', 'linen', 'polyester'],
  colour: ['navy', 'red', 'ivory'],
  sleeve: ['full sleeve', 'half sleeve'],
};

/** The authoritative catalogue attributes: a cotton, navy, half-sleeve item. */
const attributes = { fabric: 'cotton', colour: 'navy', sleeve: 'half sleeve' };

const PROHIBITED = ['cures', 'clinically proven', 'guaranteed weight loss', 'fda approved'];

const req = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  kind: 'LISTING_DESCRIPTION',
  attributes,
  attributeVocabulary: vocabulary,
  images: [goodImage],
  targetLocale: 'en',
  prohibitedClaimPatterns: PROHIBITED,
  ...over,
});

const gen = (text: string, over: Partial<Draft> = {}): Generator => () => ({
  text,
  confidence: 0.82,
  provenance: { model: 'copy-v3', promptVersion: 'p-2026-08-01' },
  ...over,
});

// ================================================= contradiction gate

describe('generated specs may not contradict structured attributes (VALIDATION)', () => {
  it('BLOCKS copy asserting a fabric the catalogue does not list', () => {
    const res = generateContent(req(), gen('Luxurious pure silk saree in navy, half sleeve'));
    expect(res.outcome).toBe('BLOCKED');
    if (res.outcome !== 'BLOCKED') return;
    expect(res.reason).toBe('GENERATED_SPEC_CONTRADICTS_STRUCTURED_ATTRIBUTES');
    expect(res.contradictions).toEqual([
      { attribute: 'fabric', structuredValue: 'cotton', contradictingValue: 'silk' },
    ]);
  });

  it('reports EVERY contradiction, not just the first', () => {
    const res = generateContent(req(), gen('Elegant linen kurta in ivory with a full sleeve cut'));
    expect(res.outcome).toBe('BLOCKED');
    if (res.outcome !== 'BLOCKED') return;
    const attrs = res.contradictions!.map((c) => c.attribute).sort();
    expect(attrs).toEqual(['colour', 'fabric', 'sleeve']);
  });

  it('permits copy that states the correct values', () => {
    const res = generateContent(req(), gen('Breathable cotton kurta in navy with a half sleeve'));
    expect(res.outcome).toBe('SUGGESTION');
  });

  it('silence about an attribute is not a contradiction', () => {
    const res = generateContent(req(), gen('A comfortable everyday kurta with neat stitching'));
    expect(res.outcome).toBe('SUGGESTION');
    expect(findContradictions('A comfortable everyday kurta', attributes, vocabulary)).toEqual([]);
  });

  it('mentioning both the real value and another is not flagged, since the truth is stated', () => {
    // "cotton, not silk" is legitimate copy and must not be blocked
    expect(findContradictions('Pure cotton, not silk', attributes, vocabulary)).toEqual([]);
  });

  it('an attribute with no vocabulary cannot be checked and is skipped rather than guessed', () => {
    const noVocab = findContradictions('a fine silk piece', { fabric: 'cotton' }, {});
    expect(noVocab).toEqual([]);
  });

  it('multi-word attribute values are matched as a whole', () => {
    const c = findContradictions('a full sleeve cotton kurta in navy', attributes, vocabulary);
    expect(c).toEqual([
      { attribute: 'sleeve', structuredValue: 'half sleeve', contradictingValue: 'full sleeve' },
    ]);
  });
});

// ================================================= compliance filter

describe('prohibited claims are blocked pre-display (VALIDATION)', () => {
  it('blocks a medical claim before it can be shown', () => {
    const res = generateContent(req(), gen('This cotton wrap cures back pain in navy'));
    expect(res.outcome).toBe('BLOCKED');
    if (res.outcome === 'BLOCKED') expect(res.reason).toContain('PROHIBITED_CLAIM');
  });

  it('checks every pattern on the supplied list, case-insensitively', () => {
    for (const claim of PROHIBITED) {
      expect(prohibitedClaimFound(`Some copy that is ${claim.toUpperCase()} indeed`, PROHIBITED)).toBe(claim);
    }
    expect(prohibitedClaimFound('Ordinary cotton copy', PROHIBITED)).toBeNull();
  });

  it('the list is supplied by compliance rather than hard-coded, so an empty list blocks nothing', () => {
    const res = generateContent(req({ prohibitedClaimPatterns: [] }),
      gen('This cotton wrap cures back pain in navy'));
    expect(res.outcome).toBe('SUGGESTION');
    expect(prohibitedClaimFound('anything', [])).toBeNull();
    expect(prohibitedClaimFound('anything', ['  '])).toBeNull();
  });
});

// ================================================= low-quality image

describe('a low-quality image yields guidance, not hallucinated specs (ERRORS)', () => {
  it('advises instead of describing when quality is below threshold', () => {
    const res = generateContent(
      req({ images: [{ ref: 'i', qualityScore: 0.2, widthPx: 1200, heightPx: 1200 }] }),
      gen('Pure cotton kurta in navy, half sleeve'));
    expect(res.outcome).toBe('GUIDANCE');
    if (res.outcome === 'GUIDANCE') {
      expect(res.guidance).toContain('too low');
      expect(res.guidance).toContain(String(MIN_IMAGE_EDGE_PX));
      expect(res.guidance).toContain('manually');
    }
  });

  it('advises when the image is too small even at good quality', () => {
    const res = generateContent(
      req({ images: [{ ref: 'i', qualityScore: 0.95, widthPx: 400, heightPx: 1200 }] }),
      gen('Pure cotton kurta'));
    expect(res.outcome).toBe('GUIDANCE');
  });

  it('the generator is never called for an unusable image, so no spec can be invented', () => {
    let called = false;
    const spy: Generator = () => {
      called = true;
      return { text: 'invented spec', confidence: 1, provenance: { model: 'm', promptVersion: 'v' } };
    };
    generateContent(req({ images: [] }), spy);
    expect(called).toBe(false);
  });

  it('one usable image among several is enough', () => {
    const res = generateContent(req({
      images: [
        { ref: 'a', qualityScore: 0.1, widthPx: 100, heightPx: 100 },
        goodImage,
      ],
    }), gen('Cotton kurta in navy, half sleeve'));
    expect(res.outcome).toBe('SUGGESTION');
    expect(imageUsable([goodImage])).toBe(true);
    expect(imageUsable([])).toBe(false);
  });

  it('the quality and size boundaries are exact', () => {
    expect(imageUsable([{ ref: 'i', qualityScore: MIN_IMAGE_QUALITY, widthPx: MIN_IMAGE_EDGE_PX, heightPx: 900 }])).toBe(true);
    expect(imageUsable([{ ref: 'i', qualityScore: MIN_IMAGE_QUALITY - 0.01, widthPx: 900, heightPx: 900 }])).toBe(false);
    expect(imageUsable([{ ref: 'i', qualityScore: 0.9, widthPx: MIN_IMAGE_EDGE_PX - 1, heightPx: 900 }])).toBe(false);
  });

  it('marketing copy and translations do not depend on an image', () => {
    expect(generateContent(req({ kind: 'MARKETING_COPY', images: [] }),
      gen('Festive picks for the season')).outcome).toBe('SUGGESTION');
    expect(generateContent(req({ kind: 'TRANSLATION', images: [] }),
      gen('பருத்தி குர்தா')).outcome).toBe('SUGGESTION');
  });
});

// ================================================= generation failure

describe('generation failure leaves the form fully manual and does NOT block (ERRORS)', () => {
  it('a throwing generator falls back to manual, explicitly non-blocking', () => {
    const broken: Generator = () => { throw new Error('provider down'); };
    const res = generateContent(req(), broken);
    expect(res.outcome).toBe('MANUAL_FALLBACK');
    if (res.outcome === 'MANUAL_FALLBACK') {
      expect(res.reason).toBe('GENERATION_FAILED');
      expect(res.blocking).toBe(false);
    }
  });

  it('empty output falls back to manual rather than showing a blank suggestion', () => {
    const res = generateContent(req(), gen('   '));
    expect(res.outcome).toBe('MANUAL_FALLBACK');
    if (res.outcome === 'MANUAL_FALLBACK') expect(res.reason).toBe('GENERATION_RETURNED_EMPTY');
  });

  it('missing provenance falls back to manual, because untraceable copy cannot be offered', () => {
    const noProv: Generator = () => ({
      text: 'Cotton kurta in navy', confidence: 0.9,
      provenance: { model: '', promptVersion: '' },
    });
    const res = generateContent(req(), noProv);
    expect(res.outcome).toBe('MANUAL_FALLBACK');
    if (res.outcome === 'MANUAL_FALLBACK') expect(res.reason).toBe('GENERATION_MISSING_PROVENANCE');
  });
});

// ================================================= suggestions only

describe('everything is a suggestion requiring human acceptance (RULES)', () => {
  it('the module exposes no publish path', () => {
    const suspicious = Object.keys(ContentGeneration).filter((n) => {
      const l = n.toLowerCase();
      return l.startsWith('publish') || l.startsWith('autoapply') || l.startsWith('commit')
        || l.startsWith('golive');
    });
    expect(suspicious).toEqual([]);
  });

  it('a successful draft carries AWAITING_HUMAN_ACCEPTANCE with confidence and provenance', () => {
    const res = generateContent(req(), gen('Cotton kurta in navy with a half sleeve'));
    expect(res.outcome).toBe('SUGGESTION');
    if (res.outcome !== 'SUGGESTION') return;
    expect(res.suggestion.status).toBe('AWAITING_HUMAN_ACCEPTANCE');
    expect(res.suggestion.confidence).toBe(0.82);
    expect(res.suggestion.provenance).toEqual({ model: 'copy-v3', promptVersion: 'p-2026-08-01' });
    expect(res.suggestion.fromTranslationMemory).toBe(false);
  });
});

// ================================================= acceptance & edits

describe('acceptance tags ai-assisted and re-gates human edits (RULES)', () => {
  const suggestion = (): Suggestion => {
    const res = generateContent(req(), gen('Cotton kurta in navy with a half sleeve'));
    if (res.outcome !== 'SUGGESTION') throw new Error('expected a suggestion');
    return res.suggestion;
  };

  const gateCtx = { attributes, attributeVocabulary: vocabulary, prohibitedClaimPatterns: PROHIBITED };

  it('an unchanged acceptance is ACCEPTED and tagged ai-assisted with the vendor responsible', () => {
    const s = suggestion();
    const r = acceptSuggestion(s, s.text, 'VEN-USER-1', NOW, gateCtx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content.disposition).toBe('ACCEPTED');
    expect(r.content.aiAssisted).toBe(true);
    expect(r.content.legallyResponsibleParty).toBe('VENDOR');
    expect(r.content.provenance.model).toBe('copy-v3');
    expect(r.content.acceptedByUserId).toBe('VEN-USER-1');
    expect(r.content.acceptedAtMs).toBe(NOW);
  });

  it('a modified acceptance is recorded as EDITED', () => {
    const s = suggestion();
    const r = acceptSuggestion(s, 'Soft cotton kurta in navy, half sleeve, everyday wear',
      'VEN-USER-1', NOW, gateCtx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content.disposition).toBe('EDITED');
  });

  it('a human edit introducing a contradiction is REFUSED — the gate is not bypassable by editing', () => {
    const s = suggestion();
    const r = acceptSuggestion(s, 'Beautiful pure silk kurta', 'VEN-USER-1', NOW, gateCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EDIT_CONTRADICTS_STRUCTURED_ATTRIBUTES');
  });

  it('a human edit introducing a prohibited claim is REFUSED', () => {
    const s = suggestion();
    const r = acceptSuggestion(s, 'Cotton kurta that cures back pain', 'VEN-USER-1', NOW, gateCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('PROHIBITED_CLAIM_IN_EDIT');
  });

  it('acceptance requires a named user and non-empty text', () => {
    const s = suggestion();
    expect(acceptSuggestion(s, s.text, '  ', NOW, gateCtx).ok).toBe(false);
    expect(acceptSuggestion(s, '   ', 'VEN-USER-1', NOW, gateCtx).ok).toBe(false);
  });
});

// ================================================= locales & translation memory

describe('the 11-language framework and translation memory (OUTPUTS)', () => {
  it('supports exactly eleven locales', () => {
    expect(SUPPORTED_LOCALES).toHaveLength(11);
    expect(SUPPORTED_LOCALES).toContain('en');
    expect(SUPPORTED_LOCALES).toContain('ta');
    expect(SUPPORTED_LOCALES).toContain('hi');
  });

  it('an unsupported locale is blocked', () => {
    const res = generateContent(req({ targetLocale: 'fr' as never }), gen('anything'));
    expect(res.outcome).toBe('BLOCKED');
    if (res.outcome === 'BLOCKED') expect(res.reason).toContain('UNSUPPORTED_LOCALE');
  });

  it('a remembered translation is reused instead of regenerated', () => {
    const memory = new TranslationMemory();
    memory.remember('Cotton kurta in navy', 'ta', 'நேவி நிற பருத்தி குர்தா');

    let generatorCalled = false;
    const spy: Generator = () => {
      generatorCalled = true;
      return { text: 'fresh', confidence: 0.5, provenance: { model: 'm', promptVersion: 'v' } };
    };
    const res = generateContent(
      req({ kind: 'TRANSLATION', targetLocale: 'ta', brief: 'Cotton kurta in navy', images: [] }),
      spy, memory);

    expect(generatorCalled).toBe(false);
    expect(res.outcome).toBe('SUGGESTION');
    if (res.outcome !== 'SUGGESTION') return;
    expect(res.suggestion.text).toBe('நேவி நிற பருத்தி குர்தா');
    expect(res.suggestion.fromTranslationMemory).toBe(true);
    // still a suggestion awaiting a human, even from memory
    expect(res.suggestion.status).toBe('AWAITING_HUMAN_ACCEPTANCE');
  });

  it('memory lookup is case- and whitespace-insensitive but locale-specific', () => {
    const memory = new TranslationMemory();
    memory.remember('Cotton Kurta', 'ta', 'பருத்தி குர்தா');
    expect(memory.lookup('  cotton kurta  ', 'ta')).toBe('பருத்தி குர்தா');
    expect(memory.lookup('Cotton Kurta', 'hi')).toBeUndefined();
    expect(memory.size()).toBe(1);
  });

  it('a remembered translation still passes the compliance filter', () => {
    const memory = new TranslationMemory();
    memory.remember('source', 'hi', 'यह उत्पाद cures back pain');
    const res = generateContent(
      req({ kind: 'TRANSLATION', targetLocale: 'hi', brief: 'source', images: [] }),
      gen('unused'), memory);
    expect(res.outcome).toBe('BLOCKED');
    if (res.outcome === 'BLOCKED') expect(res.reason).toContain('PROHIBITED_CLAIM');
  });

  it('a memory miss falls through to generation', () => {
    const memory = new TranslationMemory();
    const res = generateContent(
      req({ kind: 'TRANSLATION', targetLocale: 'ta', brief: 'unseen', images: [] }),
      gen('புதிய மொழிபெயர்ப்பு'), memory);
    expect(res.outcome).toBe('SUGGESTION');
    if (res.outcome === 'SUGGESTION') expect(res.suggestion.fromTranslationMemory).toBe(false);
  });
});

// ================================================= telemetry

describe('accept/edit/reject telemetry (OUTPUTS)', () => {
  const entry = (disposition: TelemetryEntry['disposition']): TelemetryEntry => ({
    kind: 'LISTING_DESCRIPTION', locale: 'en', disposition,
    model: 'copy-v3', promptVersion: 'p-2026-08-01', atMs: NOW,
  });

  it('counts each disposition and treats an edit as useful', () => {
    const s = telemetrySummary([
      entry('ACCEPTED'), entry('ACCEPTED'), entry('EDITED'), entry('REJECTED'),
    ]);
    expect(s.total).toBe(4);
    expect(s.byDisposition).toEqual({ ACCEPTED: 2, EDITED: 1, REJECTED: 1 });
    // an edited draft still saved the vendor work, so it counts alongside a clean accept
    expect(s.acceptanceRate).toBe(0.75);
  });

  it('an empty telemetry set does not divide by zero', () => {
    expect(telemetrySummary([])).toEqual({
      total: 0, byDisposition: { ACCEPTED: 0, EDITED: 0, REJECTED: 0 }, acceptanceRate: 0,
    });
  });

  it('all rejected yields a zero rate rather than NaN', () => {
    expect(telemetrySummary([entry('REJECTED'), entry('REJECTED')]).acceptanceRate).toBe(0);
  });
});
