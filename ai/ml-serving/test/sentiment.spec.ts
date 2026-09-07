/**
 * FR-AI-009 sentiment analysis & review intelligence, including the documented alert scenario —
 * 30 reviews with 12 negative "sizing" mentions in 7 days — and the two properties that protect
 * customers and vendors: never auto-reject, and labels never touch the ratings maths.
 */
import { describe, expect, it } from 'vitest';
import * as SentimentModule from '../src/domain/sentiment.js';
import {
  ALERT_WINDOW_DAYS,
  analyse,
  aspectAggregates,
  fallbackThroughputAlert,
  keywordAnalyse,
  MACRO_F1_GATE,
  macroF1,
  maskPii,
  meetsEvalGate,
  MIN_CONFIDENCE_FOR_AUTO,
  moderationDecision,
  negativeSpikeAlerts,
  NEGATIVE_SPIKE_SHARE,
  PDP_CHIP_MIN_MENTIONS,
  type Analysis,
  type AnalysisInput,
  type ModelOutput,
  type SentimentModel,
} from '../src/domain/sentiment.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);
const DAY = 24 * 3600 * 1000;

const input = (over: Partial<AnalysisInput> = {}): AnalysisInput => ({
  textId: 'R1', text: 'The fabric quality is excellent', locale: 'en-IN',
  createdAtMs: NOW, source: 'REVIEW', ...over,
});

const model = (out: Partial<ModelOutput> = {}): SentimentModel => () => ({
  overallSentiment: 'POSITIVE', confidence: 0.9, aspects: [], riskFlags: [], ...out,
});

// ================================================= never auto-reject

describe('low confidence routes to a human and NEVER auto-rejects (VALIDATION)', () => {
  it('there is no auto-reject outcome to express', () => {
    // The union is AUTO_PUBLISH | PENDING_HUMAN. A reject outcome would have to be added to the
    // type, which this assertion documents as a deliberate absence.
    const decision = moderationDecision(analyse(input(), model({ confidence: 0.1 })));
    expect(decision.outcome).toBe('PENDING_HUMAN');
    expect(['AUTO_PUBLISH', 'PENDING_HUMAN']).toContain(decision.outcome);
  });

  it('a low-confidence HATE flag goes to a human rather than being auto-rejected', () => {
    const a = analyse(input({ text: 'some borderline text' }),
      model({ confidence: 0.35, riskFlags: ['HATE'] }));
    const d = moderationDecision(a);
    expect(d.outcome).toBe('PENDING_HUMAN');
    expect(d.reasons).toContain('HATE_FLAG_REQUIRES_HUMAN_REVIEW');
    expect(d.reasons.some((r) => r.startsWith('CONFIDENCE_BELOW'))).toBe(true);
  });

  it('even a HIGH-confidence hate flag goes to a human, not to an automatic reject', () => {
    const a = analyse(input(), model({ confidence: 0.99, riskFlags: ['HATE'] }));
    expect(moderationDecision(a).outcome).toBe('PENDING_HUMAN');
  });

  it('a confident, clean classification may auto-publish', () => {
    const d = moderationDecision(analyse(input(), model({ confidence: 0.95 })));
    expect(d.outcome).toBe('AUTO_PUBLISH');
    expect(d.reasons).toEqual([]);
  });

  it('the confidence boundary is exact', () => {
    expect(moderationDecision(analyse(input(), model({ confidence: MIN_CONFIDENCE_FOR_AUTO }))).outcome)
      .toBe('AUTO_PUBLISH');
    expect(moderationDecision(analyse(input(), model({ confidence: MIN_CONFIDENCE_FOR_AUTO - 0.01 }))).outcome)
      .toBe('PENDING_HUMAN');
  });

  it('a spam flag also routes to a human', () => {
    const d = moderationDecision(analyse(input(), model({ confidence: 0.99, riskFlags: ['SPAM'] })));
    expect(d.outcome).toBe('PENDING_HUMAN');
    expect(d.reasons).toContain('SPAM_FLAG_REQUIRES_HUMAN_REVIEW');
  });
});

// ================================================= labels never alter ratings

describe('labels never alter ratings maths (RULES)', () => {
  it('the module exposes nothing that returns or adjusts a rating', () => {
    const suspicious = Object.keys(SentimentModule).filter((n) => {
      const l = n.toLowerCase();
      return l.includes('rating') || l.includes('stars') || l.includes('adjustscore');
    });
    expect(suspicious).toEqual([]);
  });

  it('an analysis record carries no rating field', () => {
    const a = analyse(input(), model());
    expect(Object.keys(a).sort()).toEqual([
      'aspects', 'confidence', 'createdAtMs', 'fromKeywordFallback', 'locale',
      'maskedText', 'overallSentiment', 'riskFlags', 'source', 'textId',
    ]);
    expect(JSON.stringify(a)).not.toContain('rating');
    expect(JSON.stringify(a)).not.toContain('stars');
  });
});

// ================================================= PII masking

describe('PII is masked before storage in the analytics tier (SECURITY)', () => {
  it('masks emails and phone numbers, flagging that PII was present', () => {
    const r = maskPii('Contact me at harish@pixoustech.com or +91 98765 43210 please');
    expect(r.found).toBe(true);
    expect(r.masked).toContain('[email]');
    expect(r.masked).toContain('[phone]');
    expect(r.masked).not.toContain('harish@pixoustech.com');
    expect(r.masked).not.toContain('98765');
  });

  it('leaves ordinary text untouched and reports no PII', () => {
    const r = maskPii('The fabric quality is excellent');
    expect(r.found).toBe(false);
    expect(r.masked).toBe('The fabric quality is excellent');
  });

  it('the stored analysis holds only the masked text, and raises a PII risk flag', () => {
    const a = analyse(input({ text: 'call me on +91 98765 43210' }), model());
    expect(a.maskedText).toContain('[phone]');
    expect(a.maskedText).not.toContain('98765');
    expect(a.riskFlags).toContain('PII');
  });

  it('the model never receives the raw text either', () => {
    let seen = '';
    const spy: SentimentModel = (i) => {
      seen = i.text;
      return { overallSentiment: 'NEUTRAL', confidence: 0.9, aspects: [], riskFlags: [] };
    };
    analyse(input({ text: 'reach me at a@b.com' }), spy);
    expect(seen).toContain('[email]');
    expect(seen).not.toContain('a@b.com');
  });
});

// ================================================= keyword fallback

describe('model outage falls back to keyword rules plus a human queue (ERRORS)', () => {
  it('a throwing model degrades to keyword rules and is marked as such', () => {
    const broken: SentimentModel = () => { throw new Error('model down'); };
    const a = analyse(input({ text: 'the size is too tight and quality is bad' }), broken);
    expect(a.fromKeywordFallback).toBe(true);
    expect(a.overallSentiment).toBe('NEGATIVE');
    // and a fallback label always routes to a human
    expect(moderationDecision(a).reasons).toContain('KEYWORD_FALLBACK_REQUIRES_HUMAN_REVIEW');
    expect(moderationDecision(a).outcome).toBe('PENDING_HUMAN');
  });

  it('an absent model uses the fallback rather than failing', () => {
    const a = analyse(input({ text: 'delivery was late' }));
    expect(a.fromKeywordFallback).toBe(true);
    expect(a.aspects.map((x) => x.aspect)).toContain('DELIVERY');
  });

  it('a model returning nonsense confidence degrades to the fallback', () => {
    const rogue: SentimentModel = () => ({
      overallSentiment: 'POSITIVE', confidence: Number.NaN, aspects: [], riskFlags: [],
    });
    expect(analyse(input(), rogue).fromKeywordFallback).toBe(true);
  });

  it('the fallback understands Tanglish, not only English', () => {
    // "romba mosam" = very bad; "alavu" = size
    const tanglish = keywordAnalyse(input({ text: 'alavu romba mosam iruku', locale: 'ta-IN' }));
    expect(tanglish.overallSentiment).toBe('NEGATIVE');
    expect(tanglish.aspects.map((a) => a.aspect)).toContain('SIZING');

    const positive = keywordAnalyse(input({ text: 'thara romba nalla iruku', locale: 'ta-IN' }));
    expect(positive.overallSentiment).toBe('POSITIVE');
    expect(positive.aspects.map((a) => a.aspect)).toContain('QUALITY');
  });

  it('the fallback understands Tamil script', () => {
    const tamil = keywordAnalyse(input({ text: 'அளவு மோசம்', locale: 'ta-IN' }));
    expect(tamil.overallSentiment).toBe('NEGATIVE');
    expect(tamil.aspects.map((a) => a.aspect)).toContain('SIZING');
  });

  it('keyword confidence is deliberately low so it cannot auto-publish', () => {
    const out = keywordAnalyse(input({ text: 'quality is good' }));
    expect(out.confidence).toBeLessThan(MIN_CONFIDENCE_FOR_AUTO);
  });

  it('a throughput alert fires when fallback volume exceeds the human queue capacity', () => {
    const fallbacks: Analysis[] = Array.from({ length: 12 }, (_, i) =>
      analyse(input({ textId: `R${i}`, text: 'bad quality' })));
    expect(fallbackThroughputAlert(fallbacks, 10).alert).toBe(true);
    expect(fallbackThroughputAlert(fallbacks, 20).alert).toBe(false);
    expect(fallbackThroughputAlert(fallbacks, 10).fallbackCount).toBe(12);
  });
});

// ================================================= chips

describe('PDP aspect chips require at least ten mentions (RULES)', () => {
  const withAspect = (n: number, aspect: 'SIZING' | 'QUALITY', sentiment: 'NEGATIVE' | 'POSITIVE') =>
    Array.from({ length: n }, (_, i) =>
      analyse(input({ textId: `${aspect}-${i}` }),
        model({ confidence: 0.9, aspects: [{ aspect, sentiment, confidence: 0.9 }] })));

  it('nine mentions is not enough, ten is', () => {
    expect(PDP_CHIP_MIN_MENTIONS).toBe(10);
    const nine = aspectAggregates(withAspect(9, 'SIZING', 'NEGATIVE'));
    expect(nine[0].mentions).toBe(9);
    expect(nine[0].chipDisplayable).toBe(false);

    const ten = aspectAggregates(withAspect(10, 'SIZING', 'NEGATIVE'));
    expect(ten[0].chipDisplayable).toBe(true);
  });

  it('aggregates split sentiment and compute the negative share', () => {
    const mixed = [...withAspect(6, 'QUALITY', 'POSITIVE'), ...withAspect(4, 'QUALITY', 'NEGATIVE')];
    const agg = aspectAggregates(mixed)[0];
    expect(agg.mentions).toBe(10);
    expect(agg.positive).toBe(6);
    expect(agg.negative).toBe(4);
    expect(agg.negativeShare).toBe(0.4);
  });

  it('aspects are ordered by mention volume', () => {
    const mixed = [...withAspect(12, 'SIZING', 'NEGATIVE'), ...withAspect(3, 'QUALITY', 'POSITIVE')];
    expect(aspectAggregates(mixed).map((a) => a.aspect)).toEqual(['SIZING', 'QUALITY']);
  });

  it('no analyses yields no aggregates', () => {
    expect(aspectAggregates([])).toEqual([]);
  });
});

// ================================================= the acceptance scenario

describe('the documented alert scenario: 30 reviews, 12 negative sizing mentions in 7 days', () => {
  const scenario = (): Analysis[] => {
    const out: Analysis[] = [];
    // 12 reviews mentioning sizing negatively
    for (let i = 0; i < 12; i++) {
      out.push(analyse(input({ textId: `NEG-${i}`, createdAtMs: NOW - i * 6 * 3600 * 1000 }),
        model({ confidence: 0.9, aspects: [{ aspect: 'SIZING', sentiment: 'NEGATIVE', confidence: 0.9 }] })));
    }
    // 6 reviews mentioning sizing positively
    for (let i = 0; i < 6; i++) {
      out.push(analyse(input({ textId: `POS-${i}`, createdAtMs: NOW - i * 6 * 3600 * 1000 }),
        model({ confidence: 0.9, aspects: [{ aspect: 'SIZING', sentiment: 'POSITIVE', confidence: 0.9 }] })));
    }
    // 12 further reviews about other things
    for (let i = 0; i < 12; i++) {
      out.push(analyse(input({ textId: `OTH-${i}`, createdAtMs: NOW - i * 6 * 3600 * 1000 }),
        model({ confidence: 0.9, aspects: [{ aspect: 'DELIVERY', sentiment: 'POSITIVE', confidence: 0.9 }] })));
    }
    return out;
  };

  it('fires a SIZING negative-spike alert', () => {
    const alerts = negativeSpikeAlerts(scenario(), NOW);
    const sizing = alerts.find((a) => a.aspect === 'SIZING');
    expect(sizing).toBeDefined();
    expect(sizing!.negativeMentions).toBe(12);
    expect(sizing!.mentions).toBe(18);
    expect(sizing!.negativeShare).toBeCloseTo(0.67, 2);
    expect(sizing!.windowDays).toBe(ALERT_WINDOW_DAYS);
  });

  it('does not fire for the healthy DELIVERY aspect', () => {
    expect(negativeSpikeAlerts(scenario(), NOW).map((a) => a.aspect)).not.toContain('DELIVERY');
  });

  it('reviews outside the 7-day window do not count towards the spike', () => {
    const old = scenario().map((a) => ({ ...a, createdAtMs: NOW - 30 * DAY }));
    expect(negativeSpikeAlerts(old, NOW)).toEqual([]);
  });

  it('the share threshold matters as much as the count', () => {
    // 12 negatives among 200 mentions is a very different signal from 12 among 18
    const diluted: Analysis[] = [];
    for (let i = 0; i < 12; i++) {
      diluted.push(analyse(input({ textId: `N${i}` }),
        model({ confidence: 0.9, aspects: [{ aspect: 'SIZING', sentiment: 'NEGATIVE', confidence: 0.9 }] })));
    }
    for (let i = 0; i < 188; i++) {
      diluted.push(analyse(input({ textId: `P${i}` }),
        model({ confidence: 0.9, aspects: [{ aspect: 'SIZING', sentiment: 'POSITIVE', confidence: 0.9 }] })));
    }
    const alerts = negativeSpikeAlerts(diluted, NOW);
    expect(alerts.find((a) => a.aspect === 'SIZING')).toBeUndefined();
    expect(12 / 200).toBeLessThan(NEGATIVE_SPIKE_SHARE);
  });

  it('a high share on too few mentions does not alert', () => {
    // 3 of 3 negative is 100% but far too thin to wake a vendor
    const thin: Analysis[] = Array.from({ length: 3 }, (_, i) =>
      analyse(input({ textId: `T${i}` }),
        model({ confidence: 0.9, aspects: [{ aspect: 'SIZING', sentiment: 'NEGATIVE', confidence: 0.9 }] })));
    expect(negativeSpikeAlerts(thin, NOW)).toEqual([]);
  });
});

// ================================================= eval gate

describe('the multilingual eval gate (VALIDATION)', () => {
  it('requires a macro-F1 of at least 0.8', () => {
    expect(MACRO_F1_GATE).toBe(0.8);
    expect(meetsEvalGate([0.85, 0.82, 0.79, 0.88]).pass).toBe(true);
    expect(meetsEvalGate([0.85, 0.82, 0.79, 0.88]).macroF1).toBeCloseTo(0.835, 3);
    expect(meetsEvalGate([0.9, 0.9, 0.4, 0.5]).pass).toBe(false);
  });

  it('macro-F1 is an unweighted mean, so one weak class cannot be hidden by volume', () => {
    // a class scoring 0.2 drags the macro average even if the others are strong
    expect(macroF1([1.0, 1.0, 1.0, 0.2])).toBeCloseTo(0.8, 3);
    expect(macroF1([])).toBe(0);
  });

  it('the boundary is inclusive', () => {
    expect(meetsEvalGate([0.8, 0.8]).pass).toBe(true);
    expect(meetsEvalGate([0.79, 0.8]).pass).toBe(false);
  });
});
