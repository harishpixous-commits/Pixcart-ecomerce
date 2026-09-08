/**
 * FR-MKT-008 SEO management. The two subtle rules get the most attention: the out-of-stock grace
 * period, where both reflexes are wrong, and the omission of AggregateRating, where the markup
 * most people emit is the markup that earns a penalty.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBreadcrumbJsonLd,
  buildHreflang,
  buildProductJsonLd,
  buildSitemap,
  DESCRIPTION_MAX_CHARS,
  indexability,
  isSitemapStale,
  lintMeta,
  MAX_REDIRECT_HOPS,
  OUT_OF_STOCK_INDEXABLE_DAYS,
  RedirectMap,
  SITEMAP_MAX_AGE_MS,
  TITLE_MAX_CHARS,
  validateProductJsonLd,
  type PdpState,
  type ProductJsonLdInput,
} from '../src/domain/seo/seo.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const DAY = 24 * 3_600_000;

const pdp = (over: Partial<PdpState> = {}): PdpState => ({
  listingId: 'LST-1',
  slug: 'kanchipuram-silk-saree-navy',
  approved: true,
  availability: 'InStock',
  ...over,
});

const productInput = (over: Partial<ProductJsonLdInput> = {}): ProductJsonLdInput => ({
  listingId: 'LST-1',
  name: 'Kanchipuram Silk Saree',
  description: 'Handwoven Kanchipuram silk saree in navy with a contrast border.',
  imageUrls: ['https://cdn.pixcart.in/1.jpg'],
  brand: 'Kanchi Weaves',
  sku: 'SKU-1',
  offer: {
    pricePaise: 2_400_00,
    priceCurrency: 'INR',
    availability: 'InStock',
    priceValidUntilIso: '2026-12-31',
  },
  breadcrumbs: [{ name: 'Sarees', path: '/c/sarees' }, { name: 'Silk', path: '/c/sarees/silk' }],
  ...over,
});

// ============================================ redirect safety

describe('the redirect engine is loop-safe AT INSERT (VALIDATION)', () => {
  it('accepts a simple redirect and resolves it', () => {
    const m = new RedirectMap();
    expect(m.add('/old-saree', '/p/new-saree').ok).toBe(true);
    const r = m.resolve('/old-saree');
    expect(r.destination).toBe('/p/new-saree');
    expect(r.hops).toBe(1);
    expect(r.looped).toBe(false);
  });

  it('REFUSES a rule that would close a loop', () => {
    const m = new RedirectMap();
    m.add('/a', '/b');
    m.add('/b', '/c');
    // a loop discovered at request time is already serving an infinite redirect to a crawler
    const closing = m.add('/c', '/a');
    expect(closing.ok).toBe(false);
    if (!closing.ok) expect(closing.reason).toBe('WOULD_CREATE_REDIRECT_LOOP');
    expect(m.resolve('/a').looped).toBe(false);
  });

  it('refuses a two-node loop and a self-redirect', () => {
    const m = new RedirectMap();
    m.add('/a', '/b');
    const back = m.add('/b', '/a');
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.reason).toBe('WOULD_CREATE_REDIRECT_LOOP');

    const self = m.add('/x', '/x');
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.reason).toBe('SELF_REDIRECT');
  });

  it('refuses a chain longer than the hop limit', () => {
    const m = new RedirectMap();
    expect(m.add('/a', '/b').ok).toBe(true);
    expect(m.add('/b', '/c').ok).toBe(true);          // /a -> /b -> /c is 2 hops, allowed
    const third = m.add('/c', '/d');                  // /a -> /b -> /c -> /d would be 3
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe('WOULD_EXCEED_MAX_REDIRECT_HOPS');
    expect(MAX_REDIRECT_HOPS).toBe(2);
  });

  it('catches a chain formed by an EXISTING rule pointing into the new one', () => {
    const m = new RedirectMap();
    m.add('/a', '/b');
    m.add('/b', '/c');
    // adding /c -> /d lengthens the pre-existing /a chain, which is the case a
    // forward-only check would miss
    expect(m.add('/c', '/d').ok).toBe(false);
  });

  it('refuses a second rule for the same source rather than silently replacing it', () => {
    const m = new RedirectMap();
    m.add('/a', '/b');
    const dup = m.add('/a', '/z');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe('REDIRECT_ALREADY_EXISTS_FOR_SOURCE');
    expect(m.resolve('/a').destination).toBe('/b');
  });

  it('treats a trailing slash as the same page, since doing otherwise IS a duplicate-content bug', () => {
    const m = new RedirectMap();
    m.add('/old-saree/', '/p/new');
    expect(m.resolve('/old-saree').destination).toBe('/p/new');
    expect(m.resolve('/OLD-SAREE').destination).toBe('/p/new');
    expect(m.add('/old-saree', '/p/other').ok).toBe(false);
  });

  it('resolves an unmapped path to itself', () => {
    const r = new RedirectMap().resolve('/p/live-page');
    expect(r.destination).toBe('/p/live-page');
    expect(r.hops).toBe(0);
  });

  it('a removed rule stops redirecting', () => {
    const m = new RedirectMap();
    m.add('/a', '/b');
    expect(m.remove('/a')).toBe(true);
    expect(m.resolve('/a').destination).toBe('/a');
    expect(m.remove('/a')).toBe(false);
    expect(m.size()).toBe(0);
  });

  it('refuses empty paths', () => {
    const m = new RedirectMap();
    expect(m.add('  ', '/b').ok).toBe(false);
    expect(m.add('/a', '').ok).toBe(false);
  });
});

// ============================================ out-of-stock grace period

describe('an out-of-stock PDP stays indexable for 30 days, then noindex (RULES)', () => {
  it('keeps it indexed with availability=OutOfStock inside the window', () => {
    const r = indexability(pdp({ availability: 'OutOfStock', outOfStockSinceMs: NOW - 10 * DAY }), NOW);
    // noindexing immediately would throw away ranking for a product restocked next week
    expect(r.directive).toBe('INDEX_FOLLOW');
    expect(r.availability).toBe('OutOfStock');
    expect(r.reason).toBe('OUT_OF_STOCK_WITHIN_GRACE_PERIOD');
  });

  it('drops it from the index once the window closes', () => {
    const r = indexability(
      pdp({ availability: 'OutOfStock', outOfStockSinceMs: NOW - OUT_OF_STOCK_INDEXABLE_DAYS * DAY }), NOW);
    // leaving it indexed for ever sends shoppers to a page they cannot buy from
    expect(r.directive).toBe('NOINDEX_FOLLOW');
    expect(r.reason).toContain('BEYOND_30_DAYS');
    expect(OUT_OF_STOCK_INDEXABLE_DAYS).toBe(30);
  });

  it('the boundary is exact', () => {
    const justInside = indexability(
      pdp({ availability: 'OutOfStock', outOfStockSinceMs: NOW - (30 * DAY - 1) }), NOW);
    expect(justInside.directive).toBe('INDEX_FOLLOW');
  });

  it('honours a configured grace period over the default', () => {
    const state = pdp({ availability: 'OutOfStock', outOfStockSinceMs: NOW - 10 * DAY });
    expect(indexability(state, NOW, 7).directive).toBe('NOINDEX_FOLLOW');
    expect(indexability(state, NOW, 60).directive).toBe('INDEX_FOLLOW');
  });

  it('with no out-of-stock clock it stays indexed rather than discarding ranking on an unknown', () => {
    const r = indexability(pdp({ availability: 'OutOfStock' }), NOW);
    expect(r.directive).toBe('INDEX_FOLLOW');
    expect(r.reason).toBe('OUT_OF_STOCK_DURATION_UNKNOWN_RETAINED');
  });

  it('a DISCONTINUED product is noindexed at once, since it is not coming back', () => {
    const r = indexability(pdp({ availability: 'Discontinued' }), NOW);
    expect(r.directive).toBe('NOINDEX_FOLLOW');
    expect(r.reason).toBe('DISCONTINUED_PRODUCT');
  });

  it('an unapproved listing is noindex AND nofollow', () => {
    const r = indexability(pdp({ approved: false }), NOW);
    expect(r.directive).toBe('NOINDEX_NOFOLLOW');
    expect(r.reason).toBe('LISTING_NOT_APPROVED');
  });

  it('an in-stock approved listing indexes normally', () => {
    const r = indexability(pdp(), NOW);
    expect(r.directive).toBe('INDEX_FOLLOW');
    expect(r.canonicalPath).toBe('/p/kanchipuram-silk-saree-navy');
  });
});

// ============================================ canonicalisation

describe('duplicate content canonicalises to the primary listing (RULES)', () => {
  it('points a duplicate at its cluster primary', () => {
    const r = indexability(pdp({
      listingId: 'LST-DUP',
      duplicateClusterId: 'dup:LST-PRIMARY',
      primaryListingIdInCluster: 'LST-PRIMARY',
    }), NOW);
    // the Slice-59 near-duplicate cluster decides which listing is canonical
    expect(r.canonicalPath).toBe('/p/LST-PRIMARY');
    expect(r.reason).toBe('DUPLICATE_CANONICALISED_TO_PRIMARY');
  });

  it('a cluster PRIMARY is its own canonical', () => {
    const r = indexability(pdp({
      listingId: 'LST-PRIMARY',
      slug: 'primary-slug',
      duplicateClusterId: 'dup:LST-PRIMARY',
      primaryListingIdInCluster: 'LST-PRIMARY',
    }), NOW);
    expect(r.canonicalPath).toBe('/p/primary-slug');
    expect(r.reason).toBe('IN_STOCK');
  });

  it('a listing in no cluster is its own canonical', () => {
    expect(indexability(pdp(), NOW).canonicalPath).toBe('/p/kanchipuram-silk-saree-navy');
  });
});

// ============================================ structured data

describe('AggregateRating is OMITTED when there are no ratings (OUTPUTS)', () => {
  it('leaves the property out entirely with no reviews', () => {
    const jsonLd = buildProductJsonLd(productInput({ rating: undefined }));
    // zero-count AggregateRating is a schema.org violation that earns a manual action
    expect('aggregateRating' in jsonLd).toBe(false);
    expect(validateProductJsonLd(jsonLd)).toEqual([]);
  });

  it('leaves it out when a rating object exists but the count is zero', () => {
    const jsonLd = buildProductJsonLd(productInput({ rating: { ratingValue: 0, reviewCount: 0 } }));
    expect('aggregateRating' in jsonLd).toBe(false);
  });

  it('includes it once there are real reviews', () => {
    const jsonLd = buildProductJsonLd(productInput({ rating: { ratingValue: 4.3, reviewCount: 27 } }));
    const rating = jsonLd.aggregateRating as Record<string, unknown>;
    expect(rating['@type']).toBe('AggregateRating');
    expect(rating.ratingValue).toBe('4.3');
    expect(rating.reviewCount).toBe(27);
    expect(validateProductJsonLd(jsonLd)).toEqual([]);
  });

  it('the validator CATCHES a hand-built zero-review AggregateRating', () => {
    const bad = {
      ...buildProductJsonLd(productInput()),
      aggregateRating: { '@type': 'AggregateRating', ratingValue: '0.0', reviewCount: 0 },
    };
    const v = validateProductJsonLd(bad);
    expect(v.some((x) => x.code === 'AGGREGATE_RATING_WITH_NO_REVIEWS')).toBe(true);
  });
});

describe('the structured-data validator gate (VALIDATION)', () => {
  it('accepts well-formed Product markup', () => {
    expect(validateProductJsonLd(buildProductJsonLd(productInput()))).toEqual([]);
  });

  it('renders price in rupees from paise, with two decimals', () => {
    const jsonLd = buildProductJsonLd(productInput({
      offer: { pricePaise: 2_400_50, priceCurrency: 'INR', availability: 'InStock', priceValidUntilIso: '2026-12-31' },
    }));
    const offers = jsonLd.offers as Record<string, unknown>;
    expect(offers.price).toBe('2400.50');
    expect(offers.priceCurrency).toBe('INR');
  });

  it('emits availability as a schema.org URL, not a bare word', () => {
    const jsonLd = buildProductJsonLd(productInput({
      offer: { pricePaise: 100, priceCurrency: 'INR', availability: 'OutOfStock', priceValidUntilIso: '2026-12-31' },
    }));
    const offers = jsonLd.offers as Record<string, unknown>;
    expect(offers.availability).toBe('https://schema.org/OutOfStock');

    const bare = { ...jsonLd, offers: { ...offers, availability: 'OutOfStock' } };
    expect(validateProductJsonLd(bare).some((v) => v.code === 'OFFER_AVAILABILITY_MUST_BE_A_SCHEMA_URL'))
      .toBe(true);
  });

  it('requires at least one image, a name, a sku and offers', () => {
    const noImage = buildProductJsonLd(productInput({ imageUrls: [] }));
    expect(validateProductJsonLd(noImage).some((v) => v.code === 'AT_LEAST_ONE_IMAGE_REQUIRED')).toBe(true);

    const stripped = { '@context': 'https://schema.org', '@type': 'Product', image: ['x'] };
    const v = validateProductJsonLd(stripped);
    expect(v.filter((x) => x.code === 'REQUIRED_PROPERTY_MISSING').map((x) => x.detail).sort())
      .toEqual(['name', 'offers', 'sku']);
  });

  it('requires the offer to state a validity', () => {
    const jsonLd = buildProductJsonLd(productInput());
    const offers = jsonLd.offers as Record<string, unknown>;
    delete offers.priceValidUntil;
    expect(validateProductJsonLd(jsonLd).some((v) => v.code === 'OFFER_MISSING_PRICE_VALID_UNTIL'))
      .toBe(true);
  });

  it('rejects a wrong @type or missing @context', () => {
    expect(validateProductJsonLd({ '@type': 'Product' })
      .some((v) => v.code === 'MISSING_SCHEMA_ORG_CONTEXT')).toBe(true);
    expect(validateProductJsonLd({ '@context': 'https://schema.org', '@type': 'Thing' })
      .some((v) => v.code === 'TYPE_MUST_BE_PRODUCT')).toBe(true);
  });

  it('omits brand when there is none rather than emitting an empty one', () => {
    expect('brand' in buildProductJsonLd(productInput({ brand: undefined }))).toBe(false);
    expect('brand' in buildProductJsonLd(productInput())).toBe(true);
  });

  it('numbers breadcrumb positions from one, in order', () => {
    const jsonLd = buildBreadcrumbJsonLd([
      { name: 'Sarees', path: '/c/sarees' },
      { name: 'Silk', path: '/c/sarees/silk' },
    ]);
    const items = jsonLd.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].position).toBe(1);
    expect(items[1].position).toBe(2);
    expect(items[1].name).toBe('Silk');
  });
});

// ============================================ meta lint

describe('meta length lint (VALIDATION)', () => {
  it('accepts well-sized meta', () => {
    expect(lintMeta({
      title: 'Kanchipuram Silk Saree in Navy | PixCart',
      description: 'Handwoven Kanchipuram silk saree in navy with a contrast zari border. Free delivery.',
    })).toEqual([]);
  });

  it('flags an over-long title and description with the actual lengths', () => {
    const v = lintMeta({ title: 'a'.repeat(TITLE_MAX_CHARS + 1), description: 'b'.repeat(DESCRIPTION_MAX_CHARS + 1) });
    expect(v.some((x) => x.code === 'TITLE_TOO_LONG')).toBe(true);
    expect(v.some((x) => x.code === 'DESCRIPTION_TOO_LONG')).toBe(true);
    expect(v.find((x) => x.code === 'TITLE_TOO_LONG')!.detail).toContain(String(TITLE_MAX_CHARS + 1));
  });

  it('flags too-short meta, which wastes the slot rather than merely being tidy', () => {
    const v = lintMeta({ title: 'Saree', description: 'Buy now.' });
    expect(v.some((x) => x.code === 'TITLE_TOO_SHORT')).toBe(true);
    expect(v.some((x) => x.code === 'DESCRIPTION_TOO_SHORT')).toBe(true);
  });

  it('flags missing meta distinctly from short meta', () => {
    const v = lintMeta({ title: '  ', description: '' });
    expect(v.some((x) => x.code === 'TITLE_REQUIRED')).toBe(true);
    expect(v.some((x) => x.code === 'DESCRIPTION_REQUIRED')).toBe(true);
    expect(v.some((x) => x.code === 'TITLE_TOO_SHORT')).toBe(false);
  });

  it('accepts exactly at the boundaries', () => {
    expect(lintMeta({ title: 'a'.repeat(TITLE_MAX_CHARS), description: 'b'.repeat(DESCRIPTION_MAX_CHARS) }))
      .toEqual([]);
  });
});

// ============================================ hreflang

describe('hreflang alternates always include x-default (OUTPUTS)', () => {
  it('emits one alternate per locale plus x-default', () => {
    const r = buildHreflang('/p/saree', ['en', 'ta', 'hi'], 'en');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alternates.map((a) => a.hreflang)).toEqual(['en', 'hi', 'ta', 'x-default']);
    // without x-default a search engine has to guess which locale to serve an unmatched visitor
    expect(r.alternates.find((a) => a.hreflang === 'x-default')!.href).toBe('/en/p/saree');
    expect(r.alternates.find((a) => a.hreflang === 'ta')!.href).toBe('/ta/p/saree');
  });

  it('refuses a default outside the locale set, and an empty set', () => {
    const wrong = buildHreflang('/p/x', ['ta', 'hi'], 'en');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe('DEFAULT_LOCALE_NOT_IN_LOCALE_SET');
    expect(buildHreflang('/p/x', [], 'en').ok).toBe(false);
  });
});

// ============================================ sitemaps

describe('sitemaps list only pages that are their own canonical AND indexable (OUTPUTS)', () => {
  const page = (state: PdpState) => ({ state, lastModifiedMs: NOW - DAY });

  it('excludes a noindexed page', () => {
    // listing a noindexed URL tells a crawler to fetch a page whose header then says forget it
    const index = buildSitemap([
      page(pdp({ slug: 'live' })),
      page(pdp({ slug: 'unapproved', approved: false })),
      page(pdp({ slug: 'gone', availability: 'Discontinued' })),
    ], NOW);
    expect(index.totalUrls).toBe(1);
    expect(index.segments[0].entries[0].path).toBe('/p/live');
  });

  it('excludes a page canonicalised elsewhere, since it is not its own canonical', () => {
    const index = buildSitemap([
      page(pdp({ slug: 'primary', listingId: 'LST-P' })),
      page(pdp({
        slug: 'duplicate', listingId: 'LST-D',
        duplicateClusterId: 'dup:LST-P', primaryListingIdInCluster: 'LST-P',
      })),
    ], NOW);
    expect(index.totalUrls).toBe(1);
    expect(index.segments[0].entries.map((e) => e.path)).toEqual(['/p/primary']);
  });

  it('INCLUDES an out-of-stock page still inside its grace period', () => {
    const index = buildSitemap([
      page(pdp({ slug: 'oos-recent', availability: 'OutOfStock', outOfStockSinceMs: NOW - 5 * DAY })),
      page(pdp({ slug: 'oos-old', availability: 'OutOfStock', outOfStockSinceMs: NOW - 40 * DAY })),
    ], NOW);
    expect(index.segments[0].entries.map((e) => e.path)).toEqual(['/p/oos-recent']);
  });

  it('segments beyond the per-file limit', () => {
    const pages = Array.from({ length: 5 }, (_, i) => page(pdp({ slug: `p-${i}` })));
    const index = buildSitemap(pages, NOW, 2);
    expect(index.segments).toHaveLength(3);
    expect(index.segments[0].segmentName).toBe('products-1.xml');
    expect(index.segments[0].entries).toHaveLength(2);
    expect(index.segments[2].entries).toHaveLength(1);
    expect(index.totalUrls).toBe(5);
  });

  it('an all-noindex catalogue yields an empty sitemap rather than a broken one', () => {
    const index = buildSitemap([page(pdp({ approved: false }))], NOW);
    expect(index.totalUrls).toBe(0);
    expect(index.segments).toEqual([]);
  });

  it('flags a sitemap older than 24 hours', () => {
    const index = buildSitemap([page(pdp())], NOW);
    expect(isSitemapStale(index, NOW + SITEMAP_MAX_AGE_MS)).toBe(false);
    expect(isSitemapStale(index, NOW + SITEMAP_MAX_AGE_MS + 1)).toBe(true);
    expect(SITEMAP_MAX_AGE_MS).toBe(24 * 3_600_000);
  });
});
