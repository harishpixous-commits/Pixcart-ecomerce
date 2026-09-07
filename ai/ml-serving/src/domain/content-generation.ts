/**
 * AI content generation — listing & marketing copilot — FR-AI-013.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "generate draft content — listing titles/bullets/descriptions from
 *                photos+attributes, translations across the 11-language framework, marketing copy
 *                variants, banner alt-text — always as suggestions requiring human acceptance,
 *                with brand/style and compliance filters."
 *   INPUTS:     "Source assets (images, attributes, briefs), style guides, prohibited-claims list
 *                (e.g., medical claims), target locales."
 *   OUTPUTS:    "Draft content with confidence + provenance (model, prompt version),
 *                accept/edit/reject telemetry, translation memory reuse."
 *   VALIDATION: "Compliance filter blocks prohibited claims pre-display; generated specs must not
 *                contradict structured attributes (consistency check)."
 *   RULES:      "Accepted content tagged ai-assisted internally (analytics); takedown supports
 *                provenance; vendor remains legally responsible (T&C)."
 *   ERRORS:     "Generation failure → form remains fully manual (no blocking); low-quality image
 *                input → guidance instead of hallucinated specs."
 *
 * Three properties are structural rather than advisory:
 *
 *  1. GENERATED SPECS MAY NOT CONTRADICT STRUCTURED ATTRIBUTES. If the catalogue says the fabric
 *     is cotton, copy describing "pure silk" is blocked with the contradiction named. This is the
 *     failure mode that turns a helpful copilot into a misleading-advertising exposure, and the
 *     vendor carries that liability under the T&C — so the platform must not hand them copy that
 *     contradicts their own data.
 *
 *  2. A LOW-QUALITY IMAGE YIELDS GUIDANCE, NOT SPECS. Asked to describe a product from an
 *     unusable photo, the honest output is "upload a clearer image", not an invented
 *     specification. The check runs before the generator is called, so there is no path on which
 *     a bad image produces a confident description.
 *
 *  3. EVERYTHING IS A SUGGESTION. There is no publish path in this module — output is always a
 *     draft awaiting human acceptance, asserted by reflection so it cannot be quietly added.
 *
 * The generator is injected, as with every other model in the platform.
 */
import { contentWords } from './review-summarisation.js';

/** The 11-language framework the requirement refers to. */
export const SUPPORTED_LOCALES = [
  'en', 'hi', 'ta', 'te', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'or',
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Minimum image quality score (0..1) below which we advise rather than describe. */
export const MIN_IMAGE_QUALITY = 0.5;
export const MIN_IMAGE_EDGE_PX = 600;

export type ContentKind =
  | 'LISTING_TITLE'
  | 'LISTING_BULLETS'
  | 'LISTING_DESCRIPTION'
  | 'MARKETING_COPY'
  | 'BANNER_ALT_TEXT'
  | 'TRANSLATION';

export interface ImageAsset {
  ref: string;
  /** Quality score from the image pipeline, 0..1. */
  qualityScore: number;
  widthPx: number;
  heightPx: number;
}

/**
 * The attribute vocabulary for the category: the permissible values for each attribute. This is
 * what makes contradiction detectable — without it we could not tell "silk" from a stray adjective.
 * It comes from the FR-ADM-005 category attribute schema.
 */
export type AttributeVocabulary = Record<string, string[]>;

export interface GenerationRequest {
  kind: ContentKind;
  /** The structured, authoritative attributes from the catalogue. */
  attributes: Record<string, string>;
  attributeVocabulary: AttributeVocabulary;
  images: ImageAsset[];
  brief?: string;
  styleGuideRef?: string;
  targetLocale: Locale;
  /** INPUTS: the prohibited-claims list, supplied by compliance rather than hard-coded. */
  prohibitedClaimPatterns: string[];
}

export interface Provenance {
  model: string;
  promptVersion: string;
}

export interface Draft {
  text: string;
  /** 0..1 as reported by the generator. */
  confidence: number;
  provenance: Provenance;
}

export type Generator = (req: GenerationRequest) => Draft;

export type DraftStatus = 'AWAITING_HUMAN_ACCEPTANCE';

export interface Suggestion {
  kind: ContentKind;
  locale: Locale;
  text: string;
  confidence: number;
  provenance: Provenance;
  /** RULES: never published by this module — always awaiting a human. */
  status: DraftStatus;
  /** True when the text was served from translation memory rather than generated afresh. */
  fromTranslationMemory: boolean;
}

export interface Contradiction {
  attribute: string;
  structuredValue: string;
  contradictingValue: string;
}

export type GenerationResult =
  | { outcome: 'SUGGESTION'; suggestion: Suggestion }
  /** ERRORS: low-quality image — guidance, never invented specs. */
  | { outcome: 'GUIDANCE'; guidance: string }
  /** ERRORS: generation failed — the form stays fully manual and is not blocked. */
  | { outcome: 'MANUAL_FALLBACK'; reason: string; blocking: false }
  /** VALIDATION: blocked pre-display. */
  | { outcome: 'BLOCKED'; reason: string; contradictions?: Contradiction[] };

/**
 * VALIDATION: does the generated copy contradict the structured attributes?
 *
 * For each attribute with a known value, if the copy asserts a DIFFERENT value drawn from that
 * attribute's own vocabulary, that is a contradiction. Mentioning the correct value is fine, and
 * mentioning nothing about an attribute is fine — silence is not a contradiction.
 */
export function findContradictions(
  text: string,
  attributes: Record<string, string>,
  vocabulary: AttributeVocabulary,
): Contradiction[] {
  const words = new Set(contentWords(text));
  const out: Contradiction[] = [];

  for (const [attribute, structuredValue] of Object.entries(attributes)) {
    const permissible = vocabulary[attribute];
    if (!permissible || permissible.length === 0) continue;

    const structuredTokens = contentWords(structuredValue);
    const structuredMentioned = structuredTokens.length > 0
      && structuredTokens.every((t) => words.has(t));

    for (const candidate of permissible) {
      if (candidate.toLowerCase() === structuredValue.toLowerCase()) continue;
      const candidateTokens = contentWords(candidate);
      if (candidateTokens.length === 0) continue;
      const candidateMentioned = candidateTokens.every((t) => words.has(t));
      // asserting another permissible value while not asserting the real one is a contradiction
      if (candidateMentioned && !structuredMentioned) {
        out.push({ attribute, structuredValue, contradictingValue: candidate });
      }
    }
  }
  return out;
}

/** VALIDATION: the compliance filter. Patterns come from the prohibited-claims list. */
export function prohibitedClaimFound(text: string, patterns: string[]): string | null {
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (!p || p.trim().length === 0) continue;
    if (lower.includes(p.toLowerCase())) return p;
  }
  return null;
}

/** ERRORS: is the image good enough to describe from? */
export function imageUsable(images: ImageAsset[]): boolean {
  return images.some((i) =>
    i.qualityScore >= MIN_IMAGE_QUALITY
    && Math.min(i.widthPx, i.heightPx) >= MIN_IMAGE_EDGE_PX);
}

/** Kinds that describe the product itself, and therefore depend on a usable image. */
const IMAGE_DEPENDENT: ReadonlySet<ContentKind> = new Set<ContentKind>([
  'LISTING_TITLE', 'LISTING_BULLETS', 'LISTING_DESCRIPTION', 'BANNER_ALT_TEXT',
]);

/** OUTPUTS: translation memory, keyed by source text and target locale. */
export class TranslationMemory {
  private readonly store = new Map<string, string>();

  private key(sourceText: string, locale: Locale): string {
    return `${locale}::${sourceText.trim().toLowerCase()}`;
  }

  remember(sourceText: string, locale: Locale, translation: string): void {
    this.store.set(this.key(sourceText, locale), translation);
  }

  lookup(sourceText: string, locale: Locale): string | undefined {
    return this.store.get(this.key(sourceText, locale));
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * Generate a draft. Every gate runs before anything is returned for display, and the order is
 * deliberate: image usability first (so a bad image never reaches the generator), then generation,
 * then compliance, then consistency.
 */
export function generateContent(
  req: GenerationRequest,
  generator: Generator,
  memory?: TranslationMemory,
): GenerationResult {
  if (!SUPPORTED_LOCALES.includes(req.targetLocale)) {
    return { outcome: 'BLOCKED', reason: `UNSUPPORTED_LOCALE: ${req.targetLocale}` };
  }

  // ERRORS: a low-quality image yields guidance rather than a hallucinated specification.
  if (IMAGE_DEPENDENT.has(req.kind) && !imageUsable(req.images)) {
    return {
      outcome: 'GUIDANCE',
      guidance: `Image quality is too low to describe this product reliably. `
        + `Upload a photo of at least ${MIN_IMAGE_EDGE_PX}px on the shorter edge, well lit and in focus. `
        + `Until then, please write the ${req.kind.toLowerCase().replace(/_/g, ' ')} manually.`,
    };
  }

  // OUTPUTS: translation memory reuse — an exact prior translation is served rather than regenerated.
  if (req.kind === 'TRANSLATION' && memory && req.brief) {
    const hit = memory.lookup(req.brief, req.targetLocale);
    if (hit) {
      const blockedTm = prohibitedClaimFound(hit, req.prohibitedClaimPatterns);
      if (blockedTm) {
        return { outcome: 'BLOCKED', reason: `PROHIBITED_CLAIM: "${blockedTm}"` };
      }
      return {
        outcome: 'SUGGESTION',
        suggestion: {
          kind: req.kind, locale: req.targetLocale, text: hit, confidence: 1,
          provenance: { model: 'translation-memory', promptVersion: 'n/a' },
          status: 'AWAITING_HUMAN_ACCEPTANCE', fromTranslationMemory: true,
        },
      };
    }
  }

  let draft: Draft;
  try {
    draft = generator(req);
  } catch {
    // ERRORS: the form remains fully manual and is explicitly NOT blocked.
    return { outcome: 'MANUAL_FALLBACK', reason: 'GENERATION_FAILED', blocking: false };
  }

  if (!draft || typeof draft.text !== 'string' || draft.text.trim().length === 0) {
    return { outcome: 'MANUAL_FALLBACK', reason: 'GENERATION_RETURNED_EMPTY', blocking: false };
  }
  if (!draft.provenance || !draft.provenance.model || !draft.provenance.promptVersion) {
    return { outcome: 'MANUAL_FALLBACK', reason: 'GENERATION_MISSING_PROVENANCE', blocking: false };
  }

  // VALIDATION: compliance filter blocks prohibited claims PRE-DISPLAY.
  const claim = prohibitedClaimFound(draft.text, req.prohibitedClaimPatterns);
  if (claim) {
    return { outcome: 'BLOCKED', reason: `PROHIBITED_CLAIM: "${claim}"` };
  }

  // VALIDATION: generated specs must not contradict the structured attributes.
  const contradictions = findContradictions(draft.text, req.attributes, req.attributeVocabulary);
  if (contradictions.length > 0) {
    return {
      outcome: 'BLOCKED',
      reason: 'GENERATED_SPEC_CONTRADICTS_STRUCTURED_ATTRIBUTES',
      contradictions,
    };
  }

  return {
    outcome: 'SUGGESTION',
    suggestion: {
      kind: req.kind,
      locale: req.targetLocale,
      text: draft.text,
      confidence: draft.confidence,
      provenance: draft.provenance,
      status: 'AWAITING_HUMAN_ACCEPTANCE',
      fromTranslationMemory: false,
    },
  };
}

// ================================================= acceptance & telemetry

export type Disposition = 'ACCEPTED' | 'EDITED' | 'REJECTED';

/** RULES: accepted content is tagged ai-assisted internally, with provenance retained. */
export interface AcceptedContent {
  kind: ContentKind;
  locale: Locale;
  finalText: string;
  disposition: Extract<Disposition, 'ACCEPTED' | 'EDITED'>;
  /** RULES: internal analytics tag; not a public label. */
  aiAssisted: true;
  provenance: Provenance;
  /** RULES: the vendor remains legally responsible under the T&C. */
  legallyResponsibleParty: 'VENDOR';
  acceptedByUserId: string;
  acceptedAtMs: number;
}

export type AcceptResult =
  | { ok: true; content: AcceptedContent }
  | { ok: false; reason: string };

/**
 * A human accepts a suggestion, optionally having edited it. An edit is re-run through the
 * compliance and consistency gates, because a human edit can introduce exactly the problems the
 * gates exist to catch — accepting an edit unchecked would be a hole straight through them.
 */
export function acceptSuggestion(
  suggestion: Suggestion,
  finalText: string,
  userId: string,
  nowMs: number,
  req: Pick<GenerationRequest, 'attributes' | 'attributeVocabulary' | 'prohibitedClaimPatterns'>,
): AcceptResult {
  if (!userId || userId.trim().length === 0) return { ok: false, reason: 'ACCEPTING_USER_REQUIRED' };
  if (!finalText || finalText.trim().length === 0) return { ok: false, reason: 'FINAL_TEXT_REQUIRED' };

  const claim = prohibitedClaimFound(finalText, req.prohibitedClaimPatterns);
  if (claim) return { ok: false, reason: `PROHIBITED_CLAIM_IN_EDIT: "${claim}"` };

  const contradictions = findContradictions(finalText, req.attributes, req.attributeVocabulary);
  if (contradictions.length > 0) {
    return { ok: false, reason: 'EDIT_CONTRADICTS_STRUCTURED_ATTRIBUTES' };
  }

  return {
    ok: true,
    content: {
      kind: suggestion.kind,
      locale: suggestion.locale,
      finalText,
      disposition: finalText.trim() === suggestion.text.trim() ? 'ACCEPTED' : 'EDITED',
      aiAssisted: true,
      provenance: suggestion.provenance,
      legallyResponsibleParty: 'VENDOR',
      acceptedByUserId: userId,
      acceptedAtMs: nowMs,
    },
  };
}

/** OUTPUTS: accept/edit/reject telemetry. */
export interface TelemetryEntry {
  kind: ContentKind;
  locale: Locale;
  disposition: Disposition;
  model: string;
  promptVersion: string;
  atMs: number;
}

export function telemetrySummary(entries: TelemetryEntry[]):
  { total: number; byDisposition: Record<Disposition, number>; acceptanceRate: number } {
  const byDisposition: Record<Disposition, number> = { ACCEPTED: 0, EDITED: 0, REJECTED: 0 };
  for (const e of entries) byDisposition[e.disposition]++;
  const total = entries.length;
  // an edited draft still helped, so it counts towards usefulness alongside a clean accept
  const useful = byDisposition.ACCEPTED + byDisposition.EDITED;
  return {
    total,
    byDisposition,
    acceptanceRate: total === 0 ? 0 : Math.round((useful / total) * 100) / 100,
  };
}
