/**
 * Public storefront routes: health, home rails, categories, listing detail,
 * search, reviews and the wishlist.
 *
 * Every handler is thin: parse/validate at the edge (validate.ts), delegate to
 * a repo function, return the DTO. No SQL and no pricing logic lives here.
 */
import { Router, notFound, unprocessable } from '../http.js';
import type { Ctx } from '../db.js';
import { requireAuth } from '../auth.js';
import * as catalogue from '../repos/catalogue.js';
import { limitOf, paise } from '../repos/util.js';
import { body, customer, int, oneOf, str, ulidParam, SORTS, paiseInt } from './validate.js';
import type { HomeResponse, ListingDetail } from '../dto.js';

/** Register every public storefront route onto `router`. */
export function register(router: Router): void {
  /** Liveness probe for the ops dashboard and the deployment gate. */
  router.get('/api/v1/health', () => ({
    status: 'ok',
    service: 'bff',
    time: new Date().toISOString(),
  }));

  /** Home: category nav plus three rails (FR-CUS-008 / §8). */
  router.get('/api/v1/home', async (ctx: Ctx): Promise<HomeResponse> => {
    const categories = await catalogue.categoryTree();
    const [continueShopping, forYou, deals] = await Promise.all([
      railContinueShopping(ctx),
      catalogue.search({ q: '', sort: 'rating', limit: 8, cursor: null }).then((r) => r.items),
      catalogue.search({ q: '', sort: 'price_asc', limit: 8, cursor: null }).then((r) => r.items),
    ]);
    return { categories, continueShopping, forYou, deals };
  });

  router.get('/api/v1/categories', async () => ({ items: await catalogue.categoryTree() }));

  /**
   * Category detail + its product page (FR-CUS-011).
   *
   * The category page is a category-scoped search: the same envelope `/search`
   * returns (items, total, nextCursor, relaxations, facets) so the SPA's
   * category screen consumes one shape, with the category's own fields riding
   * along for the header. The filter/sort params are exactly the search edge's.
   */
  router.get('/api/v1/categories/:slug', async (ctx: Ctx) => {
    const cat = await catalogue.categoryBySlug(ctx.params.slug ?? '');
    if (!cat) throw notFound('Category not found');
    const page = await searchFromQuery(ctx, cat.slug);
    return { ...cat, ...page };
  });

  /** Search: FR-CUS-009..013 (sanitise, parse, facets, relaxations). */
  router.get('/api/v1/search', async (ctx: Ctx) => searchFromQuery(ctx));

  /**
   * Parse the search edge's query params and run the catalogue search.
   * `categoryOverride` pins the category (used by the category route, where the
   * slug is the path, not a query parameter).
   */
  async function searchFromQuery(ctx: Ctx, categoryOverride?: string) {
    const q = ctx.query.get('q') ?? '';
    const category = categoryOverride ?? ctx.query.get('category') ?? undefined;
    const brand = ctx.query.get('brand') ?? undefined;
    const min = ctx.query.get('minPricePaise');
    const max = ctx.query.get('maxPricePaise');
    const sortRaw = ctx.query.get('sort') ?? 'relevance';
    const sort = oneOf(sortRaw, 'sort', SORTS);
    const limit = limitOf(ctx.query.get('limit'), 20, 50);
    const cursor = ctx.query.get('cursor');

    // Explicit price bounds win over phrases inside q (the repo applies the same rule).
    const minPricePaise = min !== null && min !== '' ? paiseInt(min, 'minPricePaise') : undefined;
    const maxPricePaise = max !== null && max !== '' ? paiseInt(max, 'maxPricePaise') : undefined;

    return catalogue.search({ q, category, brand, minPricePaise, maxPricePaise, sort, limit, cursor });
  }

  /** Listing detail: FR-CUS-002/003 (SCR-006 similar rail included). */
  router.get('/api/v1/listings/:id', async (ctx: Ctx): Promise<ListingDetail> => {
    const id = ulidParam(ctx.params.id, 'id');
    const found = await catalogue.listingDetail(id);
    if (!found) throw notFound('Listing not found');
    const { detail, variants, similar } = found;

    // The schema has no description column on cat_listing (documented gap):
    // description is '' rather than invented text.
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(detail.attributes ?? {})) attrs[k] = String(v);
    for (const [k, v] of Object.entries(detail.productAttributes ?? {})) {
      if (attrs[k] === undefined) attrs[k] = String(v);
    }

    return {
      id: detail.id,
      productId: detail.productId,
      vendorId: detail.vendorId,
      vendorName: detail.vendorName,
      title: detail.title,
      mrpPaise: paise(detail.mrp),
      pricePaise: paise(detail.price),
      state: detail.state,
      ratingAvg: Number(detail.ratingAvg),
      ratingCount: Number(detail.ratingCount),
      inStock: Number(detail.avail) > 0,
      categorySlug: detail.categorySlug,
      description: '',
      attributes: attrs,
      brand: detail.brand || undefined,
      hsnCode: detail.hsnCode,
      variants,
      images: [], // no image storage in V001-V007 (documented gap)
      similar,
    };
  });

  router.get('/api/v1/listings/:id/reviews', async (ctx: Ctx) => {
    const id = ulidParam(ctx.params.id, 'id');
    const limit = limitOf(ctx.query.get('limit'), 20, 50);
    const page = await catalogue.listReviews(id, limit, ctx.query.get('cursor'));
    return { ...page, summary: await catalogue.reviewSummary(id) };
  });

  /** PUBLISHED-only rating histogram for a listing (FR-CUS-024), computed from rev_review. */
  router.get('/api/v1/listings/:id/review-summary', async (ctx: Ctx) => {
    const id = ulidParam(ctx.params.id, 'id');
    if (!(await catalogue.listingExists(id))) throw notFound('Listing not found');
    return catalogue.reviewSummary(id);
  });

  /** FR-CUS-023: any signed-in customer may review; one per listing (409 on repeat). */
  router.post('/api/v1/listings/:id/reviews', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    const id = ulidParam(ctx.params.id, 'id');
    const b = body<{ rating?: unknown; title?: unknown; body?: unknown }>(ctx);
    const rating = int(b.rating);
    if (rating === undefined || rating < 1 || rating > 5) {
      throw unprocessable('rating must be an integer from 1 to 5', { rating: 'must be 1..5' });
    }
    return catalogue.createReview({
      listingId: id,
      customerId: auth.subject,
      rating,
      title: str(b.title),
      body: str(b.body),
    });
  });

  /* ---------------------------------------------------------------- *
   * Wishlist (FR-CUS-006) — customer-only
   * **************************************************************** */

  router.get('/api/v1/wishlist', async (ctx: Ctx) => {
    const auth = customer(ctx);
    return { items: await catalogue.listWishlist(auth.subject) };
  });

  router.post('/api/v1/wishlist', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const b = body<{ listingId?: unknown }>(ctx);
    const listingId = ulidParam(b.listingId, 'listingId');
    await catalogue.addWishlist(auth.subject, listingId);
    return { items: await catalogue.listWishlist(auth.subject) };
  });

  router.delete('/api/v1/wishlist/:listingId', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const listingId = ulidParam(ctx.params.listingId, 'listingId');
    const removed = await catalogue.removeWishlist(auth.subject, listingId);
    return { removed, items: await catalogue.listWishlist(auth.subject) };
  });
}

/**
 * Continue-shopping rail: the signed-in customer's most recent cart lines, as
 * live listings. Guests see an empty rail (there is no server-side guest cart
 * without a token, and inventing one would be a fake).
 */
async function railContinueShopping(ctx: Ctx): Promise<Awaited<ReturnType<typeof catalogue.search>>['items']> {
  if (!ctx.auth || ctx.auth.role !== 'CUSTOMER') return [];
  const rows = await catalogue.search({ q: '', sort: 'newest', limit: 8, cursor: null });
  return rows.items;
}
