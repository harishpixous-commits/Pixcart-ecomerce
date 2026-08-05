/**
 * FR-ADM-007 as tests. The documented acceptance scenario — a Friday-to-Sunday banner
 * targeted at Tamil-language users — is encoded verbatim, including the "auto-retires at
 * window end without redeploy" property.
 */
import { describe, expect, it } from 'vitest';
import {
  ContentItem,
  EMERGENCY_UNPUBLISH_PROPAGATION,
  stableBucket,
  validateForPublish,
  type ContentDraft,
  type LinkChecker,
  type SlotSpec,
  type ViewerContext,
} from '../src/domain/cms/content.js';

const allLinksOk: LinkChecker = () => true;
const allLinksBroken: LinkChecker = () => false;

const SLOT: SlotSpec = { slotId: 'HOME_HERO', requiredWidthPx: 1600, requiredHeightPx: 600 };

const banner = (over: Partial<ContentDraft> = {}): ContentDraft => ({
  kind: 'BANNER',
  links: [],
  images: [{ url: 'cdn://hero.jpg', altText: 'Diwali sale on silk sarees', widthPx: 1600, heightPx: 600 }],
  variants: [],
  ...over,
});

const page = (over: Partial<ContentDraft> = {}): ContentDraft => ({
  kind: 'STATIC_PAGE',
  pageCategory: 'OTHER',
  bodyHtml: '<p>Help content</p>',
  links: [],
  images: [],
  variants: [],
  ...over,
});

describe('publish gates (RULES / VALIDATION)', () => {
  it('refuses an image without alt text (accessibility lint)', () => {
    const v = validateForPublish(
      banner({ images: [{ url: 'cdn://x.jpg', widthPx: 1600, heightPx: 600 }] }), SLOT, allLinksOk);
    expect(v.some((x) => x.startsWith('ALT_TEXT_MISSING'))).toBe(true);
  });

  it('lints variant images too, not just the top-level ones', () => {
    const v = validateForPublish(banner({
      variants: [
        { variantId: 'A', weightPercent: 50, image: { url: 'cdn://a.jpg', altText: 'ok', widthPx: 1600, heightPx: 600 } },
        { variantId: 'B', weightPercent: 50, image: { url: 'cdn://b.jpg', widthPx: 1600, heightPx: 600 } },
      ],
    }), SLOT, allLinksOk);
    expect(v.some((x) => x.includes('cdn://b.jpg'))).toBe(true);
  });

  it('enforces slot dimensions', () => {
    const v = validateForPublish(
      banner({ images: [{ url: 'cdn://small.jpg', altText: 'a', widthPx: 800, heightPx: 300 }] }), SLOT, allLinksOk);
    expect(v.some((x) => x.startsWith('IMAGE_DIMENSION_MISMATCH'))).toBe(true);
  });

  it('runs the link checker on publish', () => {
    const v = validateForPublish(banner({ links: ['https://example.invalid/offer'] }), SLOT, allLinksBroken);
    expect(v).toContain('BROKEN_LINK: https://example.invalid/offer');
    expect(validateForPublish(banner({ links: ['https://ok/offer'] }), SLOT, allLinksOk)).toEqual([]);
  });

  it('requires a legal review on a policy page but not on other pages', () => {
    const policy = validateForPublish(page({ pageCategory: 'POLICY' }), undefined, allLinksOk);
    expect(policy).toContain('LEGAL_REVIEW_REQUIRED_FOR_POLICY_PAGE');
    const reviewed = validateForPublish(
      page({ pageCategory: 'POLICY', legalReviewedBy: '01LEGAL' }), undefined, allLinksOk);
    expect(reviewed).toEqual([]);
    expect(validateForPublish(page({ pageCategory: 'HELP' }), undefined, allLinksOk)).toEqual([]);
  });

  it('requires A/B weights to sum to 100 and be positive', () => {
    const short = validateForPublish(banner({
      variants: [{ variantId: 'A', weightPercent: 40 }, { variantId: 'B', weightPercent: 40 }],
    }), SLOT, allLinksOk);
    expect(short.some((x) => x.startsWith('VARIANT_WEIGHTS_MUST_SUM_TO_100'))).toBe(true);
    const zero = validateForPublish(banner({
      variants: [{ variantId: 'A', weightPercent: 100 }, { variantId: 'B', weightPercent: 0 }],
    }), SLOT, allLinksOk);
    expect(zero).toContain('VARIANT_WEIGHT_MUST_BE_POSITIVE');
  });

  it('rejects an inverted schedule window', () => {
    const v = validateForPublish(banner({ schedule: { fromMs: 2000, toMs: 1000 } }), SLOT, allLinksOk);
    expect(v).toContain('SCHEDULE_WINDOW_INVERTED');
  });

  it('a failing gate blocks the publish entirely', () => {
    const item = new ContentItem('C1', SLOT);
    const r = item.publish(banner({ images: [{ url: 'cdn://x.jpg', widthPx: 1600, heightPx: 600 }] }),
      '01ADM', 1000, allLinksOk);
    expect(r.ok).toBe(false);
    expect(item.live()).toBeNull();
    expect(item.versions()).toHaveLength(0);
  });
});

describe('the documented acceptance scenario: Fri 00:00–Sun 23:59, Tamil-language users', () => {
  // Fri 2026-08-21 00:00 IST → Sun 2026-08-23 23:59:59.999 IST. Window is half-open, so it
  // ends at Mon 00:00 IST = Sun 18:30 UTC.
  const FRI_OPEN = Date.UTC(2026, 7, 20, 18, 30, 0);   // Fri 00:00 IST
  const MON_CLOSE = Date.UTC(2026, 7, 23, 18, 30, 0);  // Mon 00:00 IST

  const item = new ContentItem('WEEKEND_TA', SLOT);
  const draft = banner({
    schedule: { fromMs: FRI_OPEN, toMs: MON_CLOSE },
    targeting: { languages: ['ta'] },
    images: [{ url: 'cdn://ta-hero.jpg', altText: 'விடுமுறை சிறப்பு சேலை தள்ளுபடி', widthPx: 1600, heightPx: 600 }],
  });
  const published = item.publish(draft, '01MKT', FRI_OPEN - 86_400_000, allLinksOk);

  const tamil: ViewerContext = { userId: 'U1', language: 'ta-IN' };
  const english: ViewerContext = { userId: 'U2', language: 'en-IN' };

  it('publishes cleanly with Tamil alt text', () => {
    expect(published.ok).toBe(true);
  });

  it('is invisible before the window opens', () => {
    expect(item.isVisibleTo(tamil, FRI_OPEN - 1)).toBe(false);
  });

  it('only Tamil-language users see it once the window opens', () => {
    expect(item.isVisibleTo(tamil, FRI_OPEN)).toBe(true);
    expect(item.isVisibleTo(english, FRI_OPEN)).toBe(false);
    // mid-window, still only Tamil
    const saturday = FRI_OPEN + 36 * 3600 * 1000;
    expect(item.isVisibleTo(tamil, saturday)).toBe(true);
    expect(item.isVisibleTo(english, saturday)).toBe(false);
  });

  it('auto-retires exactly at the window end, with no redeploy', () => {
    expect(item.isVisibleTo(tamil, MON_CLOSE - 1)).toBe(true);
    expect(item.isVisibleTo(tamil, MON_CLOSE)).toBe(false);
    // nothing was published, unpublished or mutated to make that happen
    expect(item.versions()).toHaveLength(1);
    expect(item.live()).not.toBeNull();
  });

  it('language matching is on the prefix, so ta-LK also matches ta', () => {
    expect(item.isVisibleTo({ userId: 'U3', language: 'ta-LK' }, FRI_OPEN)).toBe(true);
  });
});

describe('targeting by geo and segment', () => {
  const item = new ContentItem('GEO', SLOT);
  item.publish(banner({ targeting: { geoStates: ['TN'], segments: ['NEW_USER'] } }), '01MKT', 0, allLinksOk);

  it('requires every declared dimension to match', () => {
    expect(item.isVisibleTo({ userId: 'U', language: 'en-IN', geoState: 'TN', segments: ['NEW_USER'] }, 10)).toBe(true);
    expect(item.isVisibleTo({ userId: 'U', language: 'en-IN', geoState: 'KA', segments: ['NEW_USER'] }, 10)).toBe(false);
    expect(item.isVisibleTo({ userId: 'U', language: 'en-IN', geoState: 'TN', segments: ['RETURNING'] }, 10)).toBe(false);
    expect(item.isVisibleTo({ userId: 'U', language: 'en-IN' }, 10)).toBe(false);
  });

  it('an untargeted item is visible to everyone in-window', () => {
    const open = new ContentItem('OPEN', SLOT);
    open.publish(banner(), '01MKT', 0, allLinksOk);
    expect(open.isVisibleTo({ userId: 'U', language: 'hi-IN' }, 10)).toBe(true);
  });
});

describe('versioned publish and rollback', () => {
  it('rollback republishes a prior version as a NEW version, never rewriting history', () => {
    const item = new ContentItem('P1');
    const v1 = item.publish(page({ bodyHtml: '<p>v1</p>' }), '01ADM', 1000, allLinksOk);
    const v2 = item.publish(page({ bodyHtml: '<p>v2</p>' }), '01ADM', 2000, allLinksOk);
    expect(v1).toEqual({ ok: true, version: 1 });
    expect(v2).toEqual({ ok: true, version: 2 });
    expect(item.live()!.draft.bodyHtml).toBe('<p>v2</p>');

    const rolled = item.rollbackTo(1, '01ADM', 3000, allLinksOk);
    expect(rolled).toEqual({ ok: true, version: 3 });
    expect(item.live()!.draft.bodyHtml).toBe('<p>v1</p>');
    expect(item.versions()).toHaveLength(3);          // history is append-only
    expect(item.versions()[1].draft.bodyHtml).toBe('<p>v2</p>');  // v2 still recorded
  });

  it('rollback to an unknown version is refused', () => {
    const item = new ContentItem('P2');
    item.publish(page(), '01ADM', 1000, allLinksOk);
    const r = item.rollbackTo(99, '01ADM', 2000, allLinksOk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]).toContain('UNKNOWN_VERSION');
  });

  it('rollback re-runs the publish gates', () => {
    const item = new ContentItem('P3');
    item.publish(page({ links: ['https://ok'] }), '01ADM', 1000, allLinksOk);
    // the link has since gone dead: rolling back must not resurrect a broken page
    const r = item.rollbackTo(1, '01ADM', 2000, allLinksBroken);
    expect(r.ok).toBe(false);
  });
});

describe('emergency unpublish (≤ 1 min propagation)', () => {
  it('takes the item down immediately and reports the propagation deadline', () => {
    const item = new ContentItem('E1', SLOT);
    item.publish(banner(), '01MKT', 5000, allLinksOk);
    const r = item.emergencyUnpublish('incorrect pricing claim', 5000);
    expect(r).toEqual({ propagateByMs: 5000 + EMERGENCY_UNPUBLISH_PROPAGATION });
    expect(item.live()).toBeNull();
    expect(item.isVisibleTo({ userId: 'U', language: 'ta-IN' }, 6000)).toBe(false);
    expect(item.unpublishedReason()).toBe('incorrect pricing claim');
    expect(EMERGENCY_UNPUBLISH_PROPAGATION).toBeLessThanOrEqual(60_000);
  });

  it('requires a reason and refuses when nothing is live', () => {
    const item = new ContentItem('E2', SLOT);
    expect(item.emergencyUnpublish('x', 1)).toEqual({ error: 'NOTHING_LIVE' });
    item.publish(banner(), '01MKT', 1, allLinksOk);
    expect(item.emergencyUnpublish('  ', 2)).toEqual({ error: 'REASON_REQUIRED' });
  });

  it('a later publish brings it back', () => {
    const item = new ContentItem('E3', SLOT);
    item.publish(banner(), '01MKT', 1, allLinksOk);
    item.emergencyUnpublish('typo', 2);
    expect(item.publish(banner(), '01MKT', 3, allLinksOk)).toEqual({ ok: true, version: 2 });
    expect(item.live()).not.toBeNull();
  });
});

describe('A/B traffic split', () => {
  const item = new ContentItem('AB', SLOT);
  item.publish(banner({
    variants: [
      { variantId: 'A', weightPercent: 70, image: { url: 'cdn://a.jpg', altText: 'a', widthPx: 1600, heightPx: 600 } },
      { variantId: 'B', weightPercent: 30, image: { url: 'cdn://b.jpg', altText: 'b', widthPx: 1600, heightPx: 600 } },
    ],
  }), '01MKT', 0, allLinksOk);

  it('is deterministic per user', () => {
    const first = item.variantFor('user-42')!.variantId;
    for (let i = 0; i < 5; i++) expect(item.variantFor('user-42')!.variantId).toBe(first);
  });

  it('approximates the declared split across many users', () => {
    let a = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (item.variantFor(`u${i}`)!.variantId === 'A') a++;
    const share = a / n;
    expect(share).toBeGreaterThan(0.65);
    expect(share).toBeLessThan(0.75);
  });

  it('returns null when the item has no variants', () => {
    const plain = new ContentItem('PLAIN', SLOT);
    plain.publish(banner(), '01MKT', 0, allLinksOk);
    expect(plain.variantFor('u1')).toBeNull();
  });

  it('the bucket function is stable and in range', () => {
    expect(stableBucket('abc')).toBe(stableBucket('abc'));
    for (const k of ['a', 'bb', 'ccc', 'user-9999']) {
      const b = stableBucket(k);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});
