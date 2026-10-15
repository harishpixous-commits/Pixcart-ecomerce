/**
 * SCR-010 — Category listing (FR-CUS-011).
 *
 * Vol. 8 §8.3: "filters and sort live in the URL". Every control on this screen
 * writes to the query string instead of component state, so a filtered view is
 * shareable, survives a reload, and Back undoes exactly one step. The request
 * is derived from the URL, never the other way round.
 *
 * Pagination is keyset: `?cursor=` carries the server's `nextCursor` and each
 * "Load more" appends a page, de-duplicated by listing id. Changing any filter
 * or the sort drops the cursor, because a cursor is only meaningful for the
 * query that produced it.
 *
 * Zero results is not a dead end: the BFF returns `relaxations` — the steps it
 * actually tried (drop a term, remove the price range, ignore the brand) — and
 * those are shown verbatim so the shopper knows which filter to relax.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams, useParams } from 'react-router-dom';
import type { ListingSummary } from '@contracts/dto';
import { Button, SelectField } from '../../design';
import { api } from '../../lib/api';
import { money, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import type { Crumb } from '../lib/Screen';
import {
  PageHeader,
  ProductGrid,
  ScreenEmpty,
  ScreenError,
  ScreenLoading,
} from '../lib/Screen';
import './customer.css';

/**
 * `GET /categories/:slug/products` payload. The route is declared by the web
 * client's typed API; it returns the same result envelope the search route
 * uses (items, total, zero-result relaxations, facets) plus a keyset cursor.
 * Members are read defensively because the BFF route is newer than this screen.
 */
interface CategoryProducts {
  items?: ListingSummary[];
  total?: number;
  nextCursor?: string | null;
  relaxations?: string[];
  facets?: {
    brand?: { name: string; count: number }[];
    priceBand?: { minPaise: number; maxPaise: number | null; count: number }[];
  };
}

/** Sort vocabulary accepted by the BFF's search edge (`SORTS` in validate.ts). */
const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'rating', label: 'Customer rating' },
  { value: 'newest', label: 'Newest first' },
];

export function CategoryScreen() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();

  const sort = params.get('sort') ?? 'relevance';
  const cursor = params.get('cursor');
  const brand = params.get('brand');
  const minPricePaise = params.get('minPricePaise');
  const maxPricePaise = params.get('maxPricePaise');

  const result = useAsync<CategoryProducts>(
    async (signal) =>
      (await api.categoryProducts(
        slug,
        {
          sort,
          cursor: cursor ?? undefined,
          brand: brand ?? undefined,
          minPricePaise: minPricePaise ?? undefined,
          maxPricePaise: maxPricePaise ?? undefined,
        },
        signal,
      )) as CategoryProducts,
    [slug, sort, cursor, brand, minPricePaise, maxPricePaise],
  );

  /**
   * Accumulate pages across cursors. `useAsync` replaces `data` on every run,
   * so the rows a shopper has already scrolled past are kept here; the cursor
   * decides whether a fresh payload starts the list or extends it.
   */
  const [rows, setRows] = useState<ListingSummary[]>([]);
  useEffect(() => {
    if (result.status !== 'success' || !result.data) return;
    const page = result.data.items ?? [];
    setRows((prev) =>
      cursor === null ? page : [...prev, ...page.filter((p) => !prev.some((x) => x.id === p.id))],
    );
  }, [result.status, result.data, cursor]);

  /** Write one or more query params; any filter/sort change clears the cursor. */
  function write(next: Record<string, string | null>, keepCursor = false): void {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') p.delete(k);
      else p.set(k, v);
    }
    if (!keepCursor) p.delete('cursor');
    setParams(p);
  }

  const data = result.data;
  const total = data?.total ?? rows.length;
  const relaxations = data?.relaxations ?? [];
  const brands = data?.facets?.brand ?? [];
  const bands = data?.facets?.priceBand ?? [];

  const priceLabel =
    minPricePaise !== null || maxPricePaise !== null
      ? `${minPricePaise !== null ? money(Number(minPricePaise)) : 'any'} – ${
          maxPricePaise !== null ? money(Number(maxPricePaise)) : 'any'
        }`
      : null;

  const crumbs: Crumb[] = [{ label: 'Home', to: '/' }, { label: slug }];

  const applied: { key: string; label: string; onRemove: () => void }[] = [];
  if (brand) applied.push({ key: 'brand', label: `Brand: ${brand}`, onRemove: () => write({ brand: null }) });
  if (priceLabel) {
    applied.push({
      key: 'price',
      label: `Price: ${priceLabel}`,
      onRemove: () => write({ minPricePaise: null, maxPricePaise: null }),
    });
  }

  if (result.status === 'loading' && rows.length === 0) {
    return (
      <div>
        <PageHeader title={slug} crumbs={crumbs} />
        <ScreenLoading label="Loading products" />
      </div>
    );
  }
  if (result.status === 'error' && rows.length === 0) {
    return (
      <div>
        <PageHeader title={slug} crumbs={crumbs} />
        <ScreenError error={result.error} onRetry={result.reload} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={slug}
        crumbs={crumbs}
        description={`${number(total)} ${total === 1 ? 'product' : 'products'}`}
      />

      <div className="pxcu-row">
        <SelectField
          label="Sort by"
          name="sort"
          value={sort}
          options={SORT_OPTIONS}
          onValueChange={(v) => write({ sort: v === 'relevance' ? null : v })}
        />
      </div>

      {brands.length > 0 && (
        <div className="pxcu-chips">
          <span className="pxcu-chips__label" id="cat-brand-label">
            Brand
          </span>
          <ul className="pxcu-chips__list" aria-labelledby="cat-brand-label">
            {brands.map((b) => (
              <li key={b.name}>
                <button
                  type="button"
                  className={`px-chip px-chip--button ${brand === b.name ? 'is-selected' : ''}`}
                  aria-pressed={brand === b.name}
                  onClick={() => write({ brand: brand === b.name ? null : b.name })}
                >
                  <span className="px-chip__text">
                    {b.name} ({number(b.count)})
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {bands.length > 0 && (
        <div className="pxcu-chips">
          <span className="pxcu-chips__label" id="cat-price-label">
            Price
          </span>
          <ul className="pxcu-chips__list" aria-labelledby="cat-price-label">
            {bands.map((band) => {
              const selected =
                minPricePaise === String(band.minPaise) &&
                (band.maxPaise === null || maxPricePaise === String(band.maxPaise));
              return (
                <li key={`${band.minPaise}-${band.maxPaise ?? 'max'}`}>
                  <button
                    type="button"
                    className={`px-chip px-chip--button ${selected ? 'is-selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() =>
                      write({
                        minPricePaise: selected ? null : String(band.minPaise),
                        maxPricePaise: selected || band.maxPaise === null ? null : String(band.maxPaise),
                      })
                    }
                  >
                    <span className="px-chip__text">
                      {money(band.minPaise)}–{band.maxPaise === null ? 'above' : money(band.maxPaise)} (
                      {number(band.count)})
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {applied.length > 0 && (
        <div className="pxcu-chips">
          <span className="pxcu-chips__label">Applied filters</span>
          <ul className="pxcu-chips__list">
            {applied.map((a) => (
              <li key={a.key}>
                {/* Removable chip: the remove control is the chip's only action,
                    so it is not also clickable (no nested buttons). */}
                <span className="px-chip">
                  <span className="px-chip__text">{a.label}</span>
                  <button
                    type="button"
                    className="px-chip__remove"
                    aria-label={`Remove filter ${a.label}`}
                    onClick={a.onRemove}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <Button variant="ghost" size="sm" onClick={() => setParams(new URLSearchParams())}>
            Clear all
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <ScreenEmpty
          title="No products match these filters"
          description={
            relaxations.length > 0
              ? `Nothing matched. The server relaxed the query as follows: ${relaxations.join(' · ')}`
              : 'Try removing a filter or changing the sort order.'
          }
          action={
            applied.length > 0 ? (
              <Button variant="secondary" onClick={() => setParams(new URLSearchParams())}>
                Clear all filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ProductGrid items={rows} />
          {result.status === 'error' && (
            // A failed "Load more": keep the rows already shown, surface the
            // failure, offer the trace id and a retry (§8.3).
            <ScreenError error={result.error} onRetry={result.reload} />
          )}
          {result.status !== 'error' && data?.nextCursor && (
            <div className="pxcu-row" style={{ marginTop: 'var(--px-space-6)' }}>
              <Button
                variant="secondary"
                loading={result.status === 'loading'}
                onClick={() => write({ cursor: data.nextCursor ?? null }, true)}
              >
                Load more
              </Button>
              <span className="pxcu-muted">
                Showing {number(rows.length)} of {number(total)}
              </span>
            </div>
          )}
        </>
      )}

      <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-6)' }}>
        Looking for something else?{' '}
        <Link to={`/search?category=${encodeURIComponent(slug)}`}>Search inside {slug}</Link>
      </p>
    </div>
  );
}
