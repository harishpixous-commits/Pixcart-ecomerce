/**
 * SEO management — FR-MKT-008.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "implement SEO foundations — clean canonical URLs, server-rendered PDP/PLP meta &
 *                structured data (Product, Offer, AggregateRating, Breadcrumb), XML sitemaps
 *                (auto, segmented), robots controls, hreflang for locales — plus an editorial
 *                console for meta overrides and redirect management."
 *   INPUTS:     "Catalogue/state events (drive sitemap + structured data), meta overrides,
 *                redirect rules (301 map), robots directives."
 *   OUTPUTS:    "Rendered head/meta + JSON-LD validated against schema.org, sitemaps refreshed
 *                ≤ 24 h, redirect engine (loop-safe), Core-Web-Vitals & index-coverage dashboard
 *                feeds."
 *   VALIDATION: "Meta length lint; structured-data validator gate in CI; redirect chains ≤ 2
 *                blocked."
 *   RULES:      "Out-of-stock PDPs stay indexable with availability=OutOfStock for 30 days then
 *                noindex (config); duplicate content canonicalised to primary listing."
 *
 * Two rules here are more subtle than they look, and getting either wrong costs organic traffic
 * that takes months to earn back:
 *
 *  1. AN OUT-OF-STOCK PAGE STAYS INDEXABLE FOR 30 DAYS. The reflex is to noindex it immediately,
 *     which throws away accumulated ranking for a product that will be restocked next week. The
 *     opposite reflex — leaving it indexed for ever — sends shoppers to a page they cannot buy
 *     from. So the page stays indexed with availability=OutOfStock while there is a realistic
 *     chance of restock, and only then drops out.
 *
 *  2. AggregateRating IS OMITTED WHEN THERE ARE NO RATINGS. Emitting the markup with a zero count
 *     is a schema.org violation that earns a manual action, and a structured-data block that
 *     invites a penalty is worse than none. The builder therefore cannot express an empty
 *     AggregateRating — it leaves the property out.
 *
 * Redirect loop-safety is enforced at INSERT rather than at resolve. A loop discovered at request
 * time is already serving an infinite redirect to a crawler; refusing the rule that would create
 * it means the loop never exists.
 */

/** VALIDATION: a redirect chain longer than this is refused. */
export const MAX_REDIRECT_HOPS = 2;
/** RULES: how long an out-of-stock PDP stays indexable. Configurable per the requirement. */
export const OUT_OF_STOCK_INDEXABLE_DAYS = 30;
/** VALIDATION: meta length lint bounds, in characters. */
export const TITLE_MAX_CHARS = 60;
export const TITLE_MIN_CHARS = 15;
export const DESCRIPTION_MAX_CHARS = 160;
export const DESCRIPTION_MIN_CHARS = 50;
/** OUTPUTS: sitemap segmentation, per the sitemaps.org limit. */
export const SITEMAP_MAX_URLS = 50_000;
/** OUTPUTS: sitemap freshness. */
export const SITEMAP_MAX_AGE_MS = 24 * 3_600_000;

export type Availability = 'InStock' | 'OutOfStock' | 'PreOrder' | 'Discontinued';

export type IndexDirective = 'INDEX_FOLLOW' | 'NOINDEX_FOLLOW' | 'NOINDEX_NOFOLLOW';

export interface Violation {
  code: string;
  detail: string;
}

// ================================================= redirects

export type RedirectResult =
  | { ok: true; hops: number }
  | { ok: false; reason: string; detail: string };

/**
 * The 301 redirect map. Loop and chain safety are enforced when a rule is ADDED, so an unsafe
 * configuration cannot exist to be served.
 */
export class RedirectMap {
  private readonly rules = new Map<string, string>();

  private normalise(path: string): string {
    const trimmed = path.trim();
    // a trailing slash is the same page, and treating it otherwise is itself a duplicate-content bug
    const withoutTrailing = trimmed.length > 1 && trimmed.endsWith('/')
      ? trimmed.slice(0, -1)
      : trimmed;
    return withoutTrailing.toLowerCase();
  }

  /**
   * Add a 301. Refused when it would create a self-redirect, a loop, or a chain longer than the
   * limit — including a chain formed by an EXISTING rule now pointing into the new one.
   */
  add(from: string, to: string): RedirectResult {
    const f = this.normalise(from);
    const t = this.normalise(to);

    if (f.length === 0 || t.length === 0) {
      return { ok: false, reason: 'PATH_REQUIRED', detail: `${from} -> ${to}` };
    }
    if (f === t) {
      return { ok: false, reason: 'SELF_REDIRECT', detail: f };
    }
    if (this.rules.has(f)) {
      return { ok: false, reason: 'REDIRECT_ALREADY_EXISTS_FOR_SOURCE', detail: f };
    }

    // would following the destination come back to the source?
    let cursor = t;
    const seen = new Set<string>([f]);
    while (this.rules.has(cursor)) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      cursor = this.normalise(this.rules.get(cursor)!);
      if (cursor === f) {
        return { ok: false, reason: 'WOULD_CREATE_REDIRECT_LOOP', detail: `${f} -> ${t} -> ... -> ${f}` };
      }
    }

    // The chain through the new edge is everything that already leads INTO the source, plus the
    // new hop, plus everything the destination already leads to. The inbound side must be walked
    // TRANSITIVELY: checking only direct predecessors misses /a -> /b -> /c -> /d, where adding
    // the last edge lengthens a chain two steps upstream of the source.
    const inbound = this.longestInboundHops(f);
    const outbound = this.longestOutboundHops(t);
    const totalHops = inbound + 1 + outbound;
    if (totalHops > MAX_REDIRECT_HOPS) {
      return {
        ok: false,
        reason: 'WOULD_EXCEED_MAX_REDIRECT_HOPS',
        detail: `${f} -> ${t} would sit in a ${totalHops}-hop chain, limit ${MAX_REDIRECT_HOPS}`,
      };
    }

    this.rules.set(f, t);
    return { ok: true, hops: totalHops };
  }

  /** Longest chain of existing redirects that terminates at this node. */
  private longestInboundHops(node: string): number {
    let best = 0;
    for (const [from, to] of this.rules) {
      if (this.normalise(to) !== node) continue;
      const guard = new Set<string>([node]);
      let depth = 1;
      let cursor = this.normalise(from);
      // walk further upstream while a predecessor exists and we have not looped
      for (;;) {
        let predecessor: string | undefined;
        for (const [f2, t2] of this.rules) {
          if (this.normalise(t2) === cursor && !guard.has(this.normalise(f2))) {
            predecessor = this.normalise(f2);
            break;
          }
        }
        if (predecessor === undefined) break;
        guard.add(cursor);
        cursor = predecessor;
        depth++;
      }
      best = Math.max(best, depth);
    }
    return best;
  }

  /** Longest chain of existing redirects that starts at this node. */
  private longestOutboundHops(node: string): number {
    let cursor = node;
    const seen = new Set<string>();
    let hops = 0;
    while (this.rules.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = this.normalise(this.rules.get(cursor)!);
      hops++;
    }
    return hops;
  }

  /**
   * Resolve a path to its final destination. Loop-safe by construction, but the guard remains
   * because a resolver that can hang is not worth the assumption.
   */
  resolve(path: string): { destination: string; hops: number; looped: boolean } {
    let cursor = this.normalise(path);
    const seen = new Set<string>();
    let hops = 0;
    while (this.rules.has(cursor)) {
      if (seen.has(cursor)) return { destination: cursor, hops, looped: true };
      seen.add(cursor);
      cursor = this.normalise(this.rules.get(cursor)!);
      hops++;
      if (hops > MAX_REDIRECT_HOPS + 1) return { destination: cursor, hops, looped: true };
    }
    return { destination: cursor, hops, looped: false };
  }

  remove(from: string): boolean {
    return this.rules.delete(this.normalise(from));
  }

  size(): number {
    return this.rules.size;
  }
}

// ================================================= indexability

export interface PdpState {
  listingId: string;
  slug: string;
  approved: boolean;
  availability: Availability;
  /** When the listing most recently went out of stock, if it is. */
  outOfStockSinceMs?: number;
  /** Slice-59 near-duplicate cluster, if the listing is in one. */
  duplicateClusterId?: string;
  /** The cluster's primary listing, which duplicates canonicalise to. */
  primaryListingIdInCluster?: string;
}

export interface Indexability {
  directive: IndexDirective;
  availability: Availability;
  reason: string;
  /** RULES: the canonical this page points at. */
  canonicalPath: string;
}

/**
 * RULES: indexability and canonicalisation.
 *
 * The out-of-stock grace period is the substance. A page whose product may come back keeps its
 * ranking; a page whose product has been gone a month stops wasting a shopper's click.
 */
export function indexability(state: PdpState, nowMs: number,
                             gracePeriodDays = OUT_OF_STOCK_INDEXABLE_DAYS): Indexability {
  // RULES: duplicate content canonicalises to the primary listing
  const isDuplicate = state.duplicateClusterId !== undefined
    && state.primaryListingIdInCluster !== undefined
    && state.primaryListingIdInCluster !== state.listingId;
  const canonicalPath = isDuplicate
    ? `/p/${state.primaryListingIdInCluster}`
    : `/p/${state.slug}`;

  if (!state.approved) {
    return {
      directive: 'NOINDEX_NOFOLLOW',
      availability: state.availability,
      reason: 'LISTING_NOT_APPROVED',
      canonicalPath,
    };
  }
  if (state.availability === 'Discontinued') {
    return {
      directive: 'NOINDEX_FOLLOW',
      availability: 'Discontinued',
      reason: 'DISCONTINUED_PRODUCT',
      canonicalPath,
    };
  }
  if (state.availability === 'OutOfStock') {
    const since = state.outOfStockSinceMs;
    if (since === undefined) {
      // no clock means we cannot tell how long: keep it indexed rather than discarding ranking
      // on an unknown, and say so
      return {
        directive: 'INDEX_FOLLOW',
        availability: 'OutOfStock',
        reason: 'OUT_OF_STOCK_DURATION_UNKNOWN_RETAINED',
        canonicalPath,
      };
    }
    const elapsedDays = (nowMs - since) / (24 * 3_600_000);
    if (elapsedDays >= gracePeriodDays) {
      return {
        directive: 'NOINDEX_FOLLOW',
        availability: 'OutOfStock',
        reason: `OUT_OF_STOCK_BEYOND_${gracePeriodDays}_DAYS`,
        canonicalPath,
      };
    }
    return {
      directive: 'INDEX_FOLLOW',
      availability: 'OutOfStock',
      reason: 'OUT_OF_STOCK_WITHIN_GRACE_PERIOD',
      canonicalPath,
    };
  }

  return {
    directive: 'INDEX_FOLLOW',
    availability: state.availability,
    reason: isDuplicate ? 'DUPLICATE_CANONICALISED_TO_PRIMARY' : 'IN_STOCK',
    canonicalPath,
  };
}

// ================================================= meta lint

export interface Meta {
  title: string;
  description: string;
}

/** VALIDATION: meta length lint. Bounds are advisory in search but hard here, so drift is caught. */
export function lintMeta(meta: Meta): Violation[] {
  const v: Violation[] = [];
  const title = meta.title?.trim() ?? '';
  const description = meta.description?.trim() ?? '';

  if (title.length === 0) v.push({ code: 'TITLE_REQUIRED', detail: '' });
  else if (title.length > TITLE_MAX_CHARS) {
    v.push({ code: 'TITLE_TOO_LONG', detail: `${title.length} > ${TITLE_MAX_CHARS}` });
  } else if (title.length < TITLE_MIN_CHARS) {
    v.push({ code: 'TITLE_TOO_SHORT', detail: `${title.length} < ${TITLE_MIN_CHARS}` });
  }

  if (description.length === 0) v.push({ code: 'DESCRIPTION_REQUIRED', detail: '' });
  else if (description.length > DESCRIPTION_MAX_CHARS) {
    v.push({ code: 'DESCRIPTION_TOO_LONG', detail: `${description.length} > ${DESCRIPTION_MAX_CHARS}` });
  } else if (description.length < DESCRIPTION_MIN_CHARS) {
    v.push({ code: 'DESCRIPTION_TOO_SHORT', detail: `${description.length} < ${DESCRIPTION_MIN_CHARS}` });
  }
  return v;
}

// ================================================= structured data

export interface Offer {
  pricePaise: number;
  priceCurrency: 'INR';
  availability: Availability;
  /** Offers must state a validity, or the markup is a snapshot with no shelf life. */
  priceValidUntilIso: string;
}

export interface RatingSummary {
  ratingValue: number;
  reviewCount: number;
}

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export interface ProductJsonLdInput {
  listingId: string;
  name: string;
  description: string;
  imageUrls: string[];
  brand?: string;
  sku: string;
  offer: Offer;
  /** Omitted from the output entirely when there are no reviews. */
  rating?: RatingSummary;
  breadcrumbs: BreadcrumbItem[];
}

export type JsonLd = Record<string, unknown>;

/**
 * Build the Product JSON-LD.
 *
 * AggregateRating is OMITTED when there are no ratings rather than emitted with a zero count.
 * Zero-count AggregateRating is a schema.org violation that earns a manual action, and markup that
 * invites a penalty is worse than no markup at all.
 */
export function buildProductJsonLd(input: ProductJsonLdInput): JsonLd {
  const jsonLd: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: input.name,
    description: input.description,
    sku: input.sku,
    image: [...input.imageUrls],
    offers: {
      '@type': 'Offer',
      price: (input.offer.pricePaise / 100).toFixed(2),
      priceCurrency: input.offer.priceCurrency,
      availability: `https://schema.org/${input.offer.availability}`,
      priceValidUntil: input.offer.priceValidUntilIso,
    },
  };
  if (input.brand) {
    jsonLd.brand = { '@type': 'Brand', name: input.brand };
  }
  // the property is added only when it can be populated honestly
  if (input.rating && input.rating.reviewCount > 0) {
    jsonLd.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: input.rating.ratingValue.toFixed(1),
      reviewCount: input.rating.reviewCount,
    };
  }
  return jsonLd;
}

export function buildBreadcrumbJsonLd(items: BreadcrumbItem[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((b, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: b.name,
      item: b.path,
    })),
  };
}

/** VALIDATION: the structured-data validator gate wired into CI. */
export function validateProductJsonLd(jsonLd: JsonLd): Violation[] {
  const v: Violation[] = [];
  if (jsonLd['@context'] !== 'https://schema.org') {
    v.push({ code: 'MISSING_SCHEMA_ORG_CONTEXT', detail: String(jsonLd['@context']) });
  }
  if (jsonLd['@type'] !== 'Product') {
    v.push({ code: 'TYPE_MUST_BE_PRODUCT', detail: String(jsonLd['@type']) });
  }
  for (const required of ['name', 'sku', 'offers']) {
    if (jsonLd[required] === undefined) {
      v.push({ code: 'REQUIRED_PROPERTY_MISSING', detail: required });
    }
  }
  const images = jsonLd.image;
  if (!Array.isArray(images) || images.length === 0) {
    v.push({ code: 'AT_LEAST_ONE_IMAGE_REQUIRED', detail: '' });
  }
  const offers = jsonLd.offers as Record<string, unknown> | undefined;
  if (offers) {
    if (!offers.priceValidUntil) {
      v.push({ code: 'OFFER_MISSING_PRICE_VALID_UNTIL', detail: '' });
    }
    if (typeof offers.availability !== 'string'
        || !String(offers.availability).startsWith('https://schema.org/')) {
      v.push({ code: 'OFFER_AVAILABILITY_MUST_BE_A_SCHEMA_URL', detail: String(offers.availability) });
    }
  }
  const rating = jsonLd.aggregateRating as Record<string, unknown> | undefined;
  if (rating !== undefined) {
    const count = Number(rating.reviewCount);
    if (!Number.isFinite(count) || count <= 0) {
      v.push({ code: 'AGGREGATE_RATING_WITH_NO_REVIEWS', detail: String(rating.reviewCount) });
    }
  }
  return v;
}

// ================================================= hreflang

export interface HreflangAlternate {
  hreflang: string;
  href: string;
}

/**
 * OUTPUTS: hreflang alternates. Every set includes an x-default, because without one a search
 * engine has to guess which locale to serve an unmatched visitor.
 */
export function buildHreflang(basePath: string, locales: string[], defaultLocale: string):
  { ok: true; alternates: HreflangAlternate[] } | { ok: false; reason: string } {
  if (locales.length === 0) return { ok: false, reason: 'AT_LEAST_ONE_LOCALE_REQUIRED' };
  if (!locales.includes(defaultLocale)) {
    return { ok: false, reason: 'DEFAULT_LOCALE_NOT_IN_LOCALE_SET' };
  }
  const alternates: HreflangAlternate[] = locales
    .slice()
    .sort()
    .map((l) => ({ hreflang: l, href: `/${l}${basePath}` }));
  alternates.push({ hreflang: 'x-default', href: `/${defaultLocale}${basePath}` });
  return { ok: true, alternates };
}

// ================================================= sitemaps

export interface SitemapEntry {
  path: string;
  lastModifiedMs: number;
  changeFrequency: 'daily' | 'weekly' | 'monthly';
}

export interface SitemapSegment {
  segmentName: string;
  entries: SitemapEntry[];
}

export interface SitemapIndex {
  segments: SitemapSegment[];
  generatedAtMs: number;
  totalUrls: number;
}

/**
 * OUTPUTS: segmented sitemaps. Only indexable pages are included — listing a noindexed URL in a
 * sitemap tells a crawler to fetch a page whose own header then tells it to forget it, which
 * spends crawl budget to achieve nothing.
 */
export function buildSitemap(pages: Array<{ state: PdpState; lastModifiedMs: number }>,
                             nowMs: number, maxPerSegment = SITEMAP_MAX_URLS): SitemapIndex {
  const indexable = pages
    .filter((p) => indexability(p.state, nowMs).directive === 'INDEX_FOLLOW')
    // a page canonicalised elsewhere is not its own canonical, so it does not belong in a sitemap
    .filter((p) => {
      const idx = indexability(p.state, nowMs);
      return idx.canonicalPath === `/p/${p.state.slug}`;
    })
    .map((p) => ({
      path: `/p/${p.state.slug}`,
      lastModifiedMs: p.lastModifiedMs,
      changeFrequency: 'daily' as const,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const segments: SitemapSegment[] = [];
  for (let i = 0; i < indexable.length; i += maxPerSegment) {
    segments.push({
      segmentName: `products-${Math.floor(i / maxPerSegment) + 1}.xml`,
      entries: indexable.slice(i, i + maxPerSegment),
    });
  }
  return { segments, generatedAtMs: nowMs, totalUrls: indexable.length };
}

/** OUTPUTS: sitemaps must be refreshed within 24 hours. */
export function isSitemapStale(index: SitemapIndex, nowMs: number): boolean {
  return nowMs - index.generatedAtMs > SITEMAP_MAX_AGE_MS;
}
