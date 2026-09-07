/**
 * Sentiment analysis & review intelligence — FR-AI-009.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "analyse verified reviews and support transcripts for sentiment and aspect
 *                extraction (quality, sizing, delivery, value), powering moderation pre-screens,
 *                PDP aspect chips, vendor quality alerts and trend dashboards."
 *   INPUTS:     "Review/transcript text (multilingual incl. Tanglish), aspect taxonomy per
 *                category."
 *   OUTPUTS:    "Sentiment + aspect labels with confidence, moderation risk flags
 *                (hate/PII/spam), aspect aggregates per listing, alert events
 *                (aspect-negative spike)."
 *   VALIDATION: "Multilingual eval set maintained (macro-F1 ≥ 0.8 gate); low-confidence routes to
 *                human moderation, never auto-reject."
 *   RULES:      "Labels never alter ratings maths (FR-CUS-024); PDP chips require ≥ 10 mentions
 *                of the aspect."
 *   ERRORS:     "Model outage → moderation falls back to keyword rules + human queue (throughput
 *                alert)."
 *   SECURITY:   "PII detected in text is masked before storage in analytics tier."
 *   ACCEPTANCE: "Given 30 new reviews with 12 negative 'sizing' mentions on a listing in 7 days,
 *                When the alert job runs, Then the [alert fires]."
 *
 * Three properties are enforced rather than assumed:
 *
 *  1. NEVER AUTO-REJECT. A low-confidence classification — including a low-confidence hate flag —
 *     routes to a human. The requirement says so explicitly, and it is the right call: an
 *     automated reject on a weak signal silences a legitimate customer with no recourse. There is
 *     no AUTO_REJECT outcome in the type at all, so the module cannot express one.
 *
 *  2. LABELS NEVER ALTER RATINGS MATHS. Sentiment is advisory metadata. This module exposes
 *     nothing that returns or adjusts a rating, and its analysis records carry no rating field —
 *     asserted by reflection, because the temptation to "improve" a star average with sentiment
 *     is exactly what FR-CUS-024's Bayesian smoothing exists to resist.
 *
 *  3. PII IS MASKED BEFORE THE ANALYTICS TIER. Masking happens on the way in, so the stored
 *     record never held the raw contact detail in the first place.
 *
 * Tanglish — Tamil written in Latin script — is a first-class input here, so the keyword fallback
 * carries both Tamil-script and romanised cues rather than assuming English.
 */

export type Aspect = 'QUALITY' | 'SIZING' | 'DELIVERY' | 'VALUE' | 'PACKAGING';

export type Sentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';

export type RiskFlag = 'HATE' | 'PII' | 'SPAM';

/** Below this confidence a classification may not act on its own. */
export const MIN_CONFIDENCE_FOR_AUTO = 0.70;
/** RULES: a PDP aspect chip needs at least this many mentions. */
export const PDP_CHIP_MIN_MENTIONS = 10;
/** VALIDATION: the eval-set quality gate. */
export const MACRO_F1_GATE = 0.80;
/** ACCEPTANCE: the alert window. */
export const ALERT_WINDOW_DAYS = 7;
/** Share of an aspect's mentions that must be negative for a spike alert. */
export const NEGATIVE_SPIKE_SHARE = 0.35;
/** Minimum mentions before a spike is statistically worth alerting on. */
export const NEGATIVE_SPIKE_MIN_MENTIONS = 10;

export interface AnalysisInput {
  textId: string;
  text: string;
  locale: string;
  createdAtMs: number;
  source: 'REVIEW' | 'SUPPORT_TRANSCRIPT';
}

export interface AspectLabel {
  aspect: Aspect;
  sentiment: Sentiment;
  confidence: number;
}

/** What the injected model returns. Deliberately contains no rating of any kind. */
export interface ModelOutput {
  overallSentiment: Sentiment;
  confidence: number;
  aspects: AspectLabel[];
  riskFlags: RiskFlag[];
}

export type SentimentModel = (input: AnalysisInput) => ModelOutput;

/** The record stored in the analytics tier. The text here is already masked. */
export interface Analysis {
  textId: string;
  locale: string;
  createdAtMs: number;
  source: AnalysisInput['source'];
  overallSentiment: Sentiment;
  confidence: number;
  aspects: AspectLabel[];
  riskFlags: RiskFlag[];
  /** SECURITY: masked before storage — the raw text is never persisted here. */
  maskedText: string;
  /** True when the label came from keyword rules because the model was unavailable. */
  fromKeywordFallback: boolean;
}

/**
 * Moderation outcomes. Note the absence of an auto-reject: VALIDATION forbids it, so the type
 * does not offer one.
 */
export type ModerationOutcome = 'AUTO_PUBLISH' | 'PENDING_HUMAN';

export interface ModerationDecision {
  outcome: ModerationOutcome;
  reasons: string[];
}

// ================================================= PII masking

const EMAIL_RE = /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/gu;
const PHONE_RE = /(\+?\d[\d\s-]{8,}\d)/g;

/** SECURITY: mask PII in free text before it reaches the analytics tier. */
export function maskPii(text: string): { masked: string; found: boolean } {
  let found = false;
  let out = text.replace(EMAIL_RE, () => {
    found = true;
    return '[email]';
  });
  out = out.replace(PHONE_RE, () => {
    found = true;
    return '[phone]';
  });
  return { masked: out, found };
}

// ================================================= keyword fallback

/**
 * ERRORS: when the model is unavailable, moderation falls back to keyword rules plus a human
 * queue. The cues cover Tamil script and Tanglish as well as English, because a fallback that
 * only understands English would misread most of this platform's negative feedback as neutral.
 */
const NEGATIVE_CUES = [
  // English
  'bad', 'poor', 'worst', 'broken', 'damaged', 'late', 'small', 'tight', 'loose', 'fake',
  'refund', 'return', 'cheap quality', 'not worth',
  // Tanglish (Tamil in Latin script)
  'mosam', 'romba mosam', 'nalla illa', 'velaikku agathu', 'chinna', 'periya',
  // Tamil script
  'மோசம்', 'நல்லா இல்ல', 'சிறியது',
];

const POSITIVE_CUES = [
  'good', 'great', 'excellent', 'lovely', 'perfect', 'fast', 'value for money', 'worth it',
  'romba nalla', 'super', 'arumai', 'nalla iruku',
  'நல்லது', 'அருமை',
];

const ASPECT_CUES: Readonly<Record<Aspect, string[]>> = {
  QUALITY: ['quality', 'fabric', 'stitch', 'material', 'thara', 'தரம்'],
  SIZING: ['size', 'sizing', 'fit', 'tight', 'loose', 'small', 'large', 'alavu', 'அளவு'],
  DELIVERY: ['delivery', 'shipping', 'arrived', 'courier', 'late', 'delay', 'வந்தது'],
  VALUE: ['price', 'value', 'worth', 'expensive', 'cheap', 'விலை'],
  PACKAGING: ['packaging', 'packed', 'box', 'wrap', 'பேக்கிங்'],
};

export function keywordAnalyse(input: AnalysisInput): ModelOutput {
  const lower = input.text.toLowerCase();
  const negativeHits = NEGATIVE_CUES.filter((c) => lower.includes(c)).length;
  const positiveHits = POSITIVE_CUES.filter((c) => lower.includes(c)).length;

  const overall: Sentiment = negativeHits > positiveHits ? 'NEGATIVE'
    : positiveHits > negativeHits ? 'POSITIVE'
      : 'NEUTRAL';

  const aspects: AspectLabel[] = [];
  for (const [aspect, cues] of Object.entries(ASPECT_CUES) as Array<[Aspect, string[]]>) {
    if (cues.some((c) => lower.includes(c))) {
      // a keyword rule cannot be confident, and that is the point: it routes to a human
      aspects.push({ aspect, sentiment: overall, confidence: 0.4 });
    }
  }
  return { overallSentiment: overall, confidence: 0.4, aspects, riskFlags: [] };
}

// ================================================= analysis

/**
 * Analyse one text. PII is masked BEFORE the model is called and before anything is stored, so
 * neither the provider nor the analytics tier ever sees the raw contact detail.
 */
export function analyse(input: AnalysisInput, model?: SentimentModel): Analysis {
  const { masked, found } = maskPii(input.text);
  const maskedInput: AnalysisInput = { ...input, text: masked };

  let output: ModelOutput;
  let fallback = false;
  if (!model) {
    output = keywordAnalyse(maskedInput);
    fallback = true;
  } else {
    try {
      output = model(maskedInput);
      if (!output || typeof output.confidence !== 'number' || !Number.isFinite(output.confidence)) {
        output = keywordAnalyse(maskedInput);
        fallback = true;
      }
    } catch {
      output = keywordAnalyse(maskedInput);
      fallback = true;
    }
  }

  const riskFlags = new Set<RiskFlag>(output.riskFlags ?? []);
  if (found) riskFlags.add('PII');

  return {
    textId: input.textId,
    locale: input.locale,
    createdAtMs: input.createdAtMs,
    source: input.source,
    overallSentiment: output.overallSentiment,
    confidence: output.confidence,
    aspects: output.aspects ?? [],
    riskFlags: [...riskFlags],
    maskedText: masked,
    fromKeywordFallback: fallback,
  };
}

/**
 * VALIDATION: low confidence routes to human moderation, NEVER auto-reject. A keyword-fallback
 * label always routes to a human too, because a keyword rule is not evidence enough to publish
 * on unattended.
 */
export function moderationDecision(analysis: Analysis): ModerationDecision {
  const reasons: string[] = [];

  if (analysis.fromKeywordFallback) reasons.push('KEYWORD_FALLBACK_REQUIRES_HUMAN_REVIEW');
  if (analysis.confidence < MIN_CONFIDENCE_FOR_AUTO) {
    reasons.push(`CONFIDENCE_BELOW_${MIN_CONFIDENCE_FOR_AUTO}`);
  }
  if (analysis.riskFlags.includes('HATE')) reasons.push('HATE_FLAG_REQUIRES_HUMAN_REVIEW');
  if (analysis.riskFlags.includes('SPAM')) reasons.push('SPAM_FLAG_REQUIRES_HUMAN_REVIEW');

  return {
    outcome: reasons.length === 0 ? 'AUTO_PUBLISH' : 'PENDING_HUMAN',
    reasons,
  };
}

/** ERRORS: a throughput alert when the human queue is filling from fallback volume. */
export function fallbackThroughputAlert(analyses: Analysis[], queueCapacityPerHour: number):
  { alert: boolean; fallbackCount: number; capacity: number } {
  const fallbackCount = analyses.filter((a) => a.fromKeywordFallback).length;
  return { alert: fallbackCount > queueCapacityPerHour, fallbackCount, capacity: queueCapacityPerHour };
}

// ================================================= aggregates & chips

export interface AspectAggregate {
  aspect: Aspect;
  mentions: number;
  positive: number;
  negative: number;
  neutral: number;
  /** RULES: a PDP chip needs at least 10 mentions. */
  chipDisplayable: boolean;
  negativeShare: number;
}

export function aspectAggregates(analyses: Analysis[]): AspectAggregate[] {
  const byAspect = new Map<Aspect, { positive: number; negative: number; neutral: number }>();
  for (const a of analyses) {
    for (const label of a.aspects) {
      const bucket = byAspect.get(label.aspect) ?? { positive: 0, negative: 0, neutral: 0 };
      if (label.sentiment === 'POSITIVE') bucket.positive++;
      else if (label.sentiment === 'NEGATIVE') bucket.negative++;
      else bucket.neutral++;
      byAspect.set(label.aspect, bucket);
    }
  }
  return [...byAspect.entries()]
    .map(([aspect, b]) => {
      const mentions = b.positive + b.negative + b.neutral;
      return {
        aspect,
        mentions,
        positive: b.positive,
        negative: b.negative,
        neutral: b.neutral,
        chipDisplayable: mentions >= PDP_CHIP_MIN_MENTIONS,
        negativeShare: mentions === 0 ? 0 : Math.round((b.negative / mentions) * 100) / 100,
      };
    })
    .sort((x, y) => y.mentions - x.mentions || x.aspect.localeCompare(y.aspect));
}

// ================================================= spike alerts

export interface SpikeAlert {
  aspect: Aspect;
  windowDays: number;
  mentions: number;
  negativeMentions: number;
  negativeShare: number;
}

/**
 * ACCEPTANCE: with 30 new reviews carrying 12 negative "sizing" mentions inside 7 days, the alert
 * job fires for SIZING. The share threshold matters as much as the count: 12 negatives out of 12
 * mentions and 12 out of 200 are very different signals, and only the first warrants waking a
 * vendor.
 */
export function negativeSpikeAlerts(
  analyses: Analysis[],
  nowMs: number,
  windowDays: number = ALERT_WINDOW_DAYS,
): SpikeAlert[] {
  const cutoff = nowMs - windowDays * 24 * 3600 * 1000;
  const inWindow = analyses.filter((a) => a.createdAtMs >= cutoff);
  const alerts: SpikeAlert[] = [];

  for (const agg of aspectAggregates(inWindow)) {
    if (agg.mentions < NEGATIVE_SPIKE_MIN_MENTIONS) continue;
    if (agg.negativeShare < NEGATIVE_SPIKE_SHARE) continue;
    alerts.push({
      aspect: agg.aspect,
      windowDays,
      mentions: agg.mentions,
      negativeMentions: agg.negative,
      negativeShare: agg.negativeShare,
    });
  }
  return alerts.sort((a, b) => b.negativeShare - a.negativeShare || a.aspect.localeCompare(b.aspect));
}

// ================================================= eval gate

/** VALIDATION: the multilingual eval set must clear a macro-F1 of 0.8 before a model ships. */
export function macroF1(perClassF1: number[]): number {
  if (perClassF1.length === 0) return 0;
  const mean = perClassF1.reduce((a, b) => a + b, 0) / perClassF1.length;
  return Math.round(mean * 1000) / 1000;
}

export function meetsEvalGate(perClassF1: number[]):
  { pass: boolean; macroF1: number; gate: number } {
  const score = macroF1(perClassF1);
  return { pass: score >= MACRO_F1_GATE, macroF1: score, gate: MACRO_F1_GATE };
}
