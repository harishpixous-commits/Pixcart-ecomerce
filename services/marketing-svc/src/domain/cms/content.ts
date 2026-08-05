/**
 * CMS — pages, banners and content blocks — FR-ADM-007.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "CMS for static pages (policies, help), home/PLP banner slots with scheduling
 *                & targeting (segment, geo, language), content blocks, preview, and versioned
 *                publish with rollback."
 *   RULES:      "Emergency unpublish ≤ 1 min propagation; A/B banner variants supported with
 *                traffic split; accessibility lint (alt text mandatory)."
 *   ACCEPTANCE: "Given a scheduled banner (Fri 00:00–Sun 23:59, TA-language users), When
 *                window opens, Then only matching users see it, and it auto-retires at window
 *                end without redeploy."
 *   VALIDATION: "Link checker on publish; image slot dimension enforcement; policy pages
 *                require legal-review flag before publish."
 *
 * Pure and deterministic. Publishing is gated: every gate is a refusal that names the
 * violation, so a page cannot go live missing alt text, with a broken link, at the wrong
 * image dimensions, or — for a policy page — without a recorded legal review. Scheduling is
 * evaluated at read time, which is what makes the acceptance criterion's "auto-retires at
 * window end without redeploy" true by construction: nothing has to run at the boundary.
 */

export type ContentKind = 'STATIC_PAGE' | 'BANNER' | 'CONTENT_BLOCK';
export type PageCategory = 'POLICY' | 'HELP' | 'OTHER';

export interface ImageAsset {
  url: string;
  /** RULES: accessibility lint — alt text is mandatory. */
  altText?: string;
  widthPx: number;
  heightPx: number;
}

/** VALIDATION: image slot dimension enforcement. */
export interface SlotSpec {
  slotId: string;
  requiredWidthPx: number;
  requiredHeightPx: number;
}

export interface Targeting {
  /** BCP-47 language prefixes, e.g. ["ta"] for Tamil. Empty/absent = all languages. */
  languages?: string[];
  /** State codes, e.g. ["TN", "KA"]. Empty/absent = everywhere. */
  geoStates?: string[];
  segments?: string[];
}

/** Half-open window [fromMs, toMs): the banner retires the instant toMs is reached. */
export interface Schedule {
  fromMs: number;
  toMs: number;
}

export interface Variant {
  variantId: string;
  /** Traffic share in percent; variants must sum to 100. */
  weightPercent: number;
  image?: ImageAsset;
  bodyHtml?: string;
}

export interface ContentDraft {
  kind: ContentKind;
  pageCategory?: PageCategory;
  bodyHtml?: string;
  links: string[];
  images: ImageAsset[];
  variants: Variant[];
  schedule?: Schedule;
  targeting?: Targeting;
  /** VALIDATION: policy pages require a legal review before publish. */
  legalReviewedBy?: string;
}

export interface ViewerContext {
  userId: string;
  language: string;   // e.g. "ta-IN"
  geoState?: string;
  segments?: string[];
}

/** An injected link checker — CI/ops supplies the real reachability probe. */
export type LinkChecker = (url: string) => boolean;

export const EMERGENCY_UNPUBLISH_PROPAGATION = 60_000;   // ≤ 1 min (RULES)

/** Gate results are named violations, never silent downgrades. */
export function validateForPublish(draft: ContentDraft, slot: SlotSpec | undefined, linkOk: LinkChecker): string[] {
  const v: string[] = [];

  // accessibility lint: every image, including variant images, needs alt text
  const allImages = [...draft.images, ...draft.variants.flatMap((x) => (x.image ? [x.image] : []))];
  for (const img of allImages) {
    if (!img.altText || img.altText.trim().length === 0) v.push(`ALT_TEXT_MISSING: ${img.url}`);
  }

  // image slot dimension enforcement
  if (slot) {
    for (const img of allImages) {
      if (img.widthPx !== slot.requiredWidthPx || img.heightPx !== slot.requiredHeightPx) {
        v.push(`IMAGE_DIMENSION_MISMATCH: ${img.url} is ${img.widthPx}x${img.heightPx}, slot ${slot.slotId} requires ${slot.requiredWidthPx}x${slot.requiredHeightPx}`);
      }
    }
  }

  // link checker on publish
  for (const url of draft.links) {
    if (!linkOk(url)) v.push(`BROKEN_LINK: ${url}`);
  }

  // policy pages require a recorded legal review
  if (draft.kind === 'STATIC_PAGE' && draft.pageCategory === 'POLICY'
      && (!draft.legalReviewedBy || draft.legalReviewedBy.trim().length === 0)) {
    v.push('LEGAL_REVIEW_REQUIRED_FOR_POLICY_PAGE');
  }

  // A/B traffic split must be exhaustive
  if (draft.variants.length > 0) {
    const sum = draft.variants.reduce((a, x) => a + x.weightPercent, 0);
    if (sum !== 100) v.push(`VARIANT_WEIGHTS_MUST_SUM_TO_100 (got ${sum})`);
    if (draft.variants.some((x) => x.weightPercent <= 0)) v.push('VARIANT_WEIGHT_MUST_BE_POSITIVE');
  }

  if (draft.schedule && draft.schedule.toMs <= draft.schedule.fromMs) {
    v.push('SCHEDULE_WINDOW_INVERTED');
  }
  return v;
}

export interface PublishedVersion {
  version: number;
  draft: ContentDraft;
  publishedAtMs: number;
  publishedBy: string;
}

export type PublishResult =
  | { ok: true; version: number }
  | { ok: false; violations: string[] };

/**
 * A CMS item with its version history. Publishing is atomic; rollback re-publishes a prior
 * version as a NEW version so the history stays append-only and auditable.
 */
export class ContentItem {
  private readonly history: PublishedVersion[] = [];
  private liveVersion: number | null = null;
  private unpublishedAtMs: number | null = null;
  private unpublishReason: string | null = null;

  constructor(readonly contentId: string, readonly slot?: SlotSpec) {}

  publish(draft: ContentDraft, publishedBy: string, nowMs: number, linkOk: LinkChecker): PublishResult {
    const violations = validateForPublish(draft, this.slot, linkOk);
    if (violations.length > 0) return { ok: false, violations };
    const version = this.history.length + 1;
    this.history.push({ version, draft, publishedAtMs: nowMs, publishedBy });
    this.liveVersion = version;
    this.unpublishedAtMs = null;
    this.unpublishReason = null;
    return { ok: true, version };
  }

  /** Roll back to a prior version, recorded as a new version (never a history rewrite). */
  rollbackTo(version: number, publishedBy: string, nowMs: number, linkOk: LinkChecker): PublishResult {
    const prior = this.history.find((h) => h.version === version);
    if (!prior) return { ok: false, violations: [`UNKNOWN_VERSION: ${version}`] };
    return this.publish(prior.draft, publishedBy, nowMs, linkOk);
  }

  /**
   * Emergency unpublish. Takes effect immediately in the domain; the propagation deadline
   * (≤ 1 min) is returned so ops can assert cache invalidation happened in time.
   */
  emergencyUnpublish(reason: string, nowMs: number): { propagateByMs: number } | { error: string } {
    if (this.liveVersion === null) return { error: 'NOTHING_LIVE' };
    if (!reason || reason.trim().length === 0) return { error: 'REASON_REQUIRED' };
    this.unpublishedAtMs = nowMs;
    this.unpublishReason = reason;
    this.liveVersion = null;
    return { propagateByMs: nowMs + EMERGENCY_UNPUBLISH_PROPAGATION };
  }

  live(): PublishedVersion | null {
    return this.liveVersion === null ? null : this.history.find((h) => h.version === this.liveVersion) ?? null;
  }

  versions(): PublishedVersion[] {
    return [...this.history];
  }

  unpublishedReason(): string | null {
    return this.unpublishReason;
  }

  /**
   * ACCEPTANCE: only matching users see the item, and it retires at the window end with no
   * redeploy — the schedule is evaluated here, at read time.
   */
  isVisibleTo(ctx: ViewerContext, nowMs: number): boolean {
    const liveVersion = this.live();
    if (!liveVersion) return false;
    const d = liveVersion.draft;

    if (d.schedule) {
      if (nowMs < d.schedule.fromMs) return false;          // before the window opens
      if (nowMs >= d.schedule.toMs) return false;           // auto-retired
    }
    const t = d.targeting;
    if (t?.languages && t.languages.length > 0) {
      const prefix = ctx.language.split('-')[0].toLowerCase();
      if (!t.languages.map((l) => l.split('-')[0].toLowerCase()).includes(prefix)) return false;
    }
    if (t?.geoStates && t.geoStates.length > 0) {
      if (!ctx.geoState || !t.geoStates.includes(ctx.geoState)) return false;
    }
    if (t?.segments && t.segments.length > 0) {
      const mine = new Set(ctx.segments ?? []);
      if (!t.segments.some((s) => mine.has(s))) return false;
    }
    return true;
  }

  /**
   * Deterministic A/B assignment: the same user always lands in the same variant for this
   * item, and the distribution follows the declared weights.
   */
  variantFor(userId: string): Variant | null {
    const liveVersion = this.live();
    if (!liveVersion || liveVersion.draft.variants.length === 0) return null;
    const bucket = stableBucket(`${this.contentId}:${userId}`);   // 0..99
    let cumulative = 0;
    for (const v of liveVersion.draft.variants) {
      cumulative += v.weightPercent;
      if (bucket < cumulative) return v;
    }
    return liveVersion.draft.variants[liveVersion.draft.variants.length - 1];
  }
}

/** FNV-1a folded to 0..99 — stable across processes and languages. */
export function stableBucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}
