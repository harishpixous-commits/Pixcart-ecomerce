/**
 * SCR-011 — Search (FR-CUS-009..013).
 *
 * The query, the facets, the price bounds and the sort all live in the URL
 * (§8.3), so a search can be shared and Back restores it. Each facet is a chip
 * toggle: pressing a chip writes that facet into the query string and pressing
 * it again clears it. Nothing about the result set is held in component state.
 *
 * Two honest empty states:
 *  - no query at all → a prompt, not a spinner over a request nobody made
 *  - zero results → the shared empty state plus the relaxations the BFF
 *    actually applied, quoted verbatim (dropping a term, removing the price
 *    range, ignoring the brand, searching outside the category)
 *
 * `/deals` is routed to this screen. It carries no `q`, so it runs the same
 * empty-query search the BFF's own "deals" home rail runs (lowest price first)
 * and says so, rather than showing a search prompt under a Deals heading.
 */
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { SearchResponse } from '@contracts/dto';
import { SelectField } from '../../design';
import { api } from '../../lib/api';
import { money, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ProductGrid, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import './customer.css';

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'rating', label: 'Customer rating' },
  { value: 'newest', label: 'Newest first' },
];

export function SearchScreen() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const isDeals = location.pathname === '/deals';

  const q = (params.get('q') ?? '').trim();
  const category = params.get('category');
  const brand = params.get('brand');
  const minPricePaise = params.get('minPricePaise');
  const maxPricePaise = params.get('maxPricePaise');
  const sort = params.get('sort') ?? (isDeals && q === '' ? 'price_asc' : 'relevance');

  const hasQuery = q !== '' || isDeals;

  // `null` (not a fetch) when nothing has been asked for yet: the no-query
  // prompt below is a real state, not a loading one.
  const search = useAsync<SearchResponse | null>(
    async (signal) =>
      hasQuery
        ? ((await api.search(
            {
              q,
              category: category ?? undefined,
              brand: brand ?? undefined,
              minPricePaise: minPricePaise ?? undefined,
              maxPricePaise: maxPricePaise ?? undefined,
              sort,
            },
            signal,
          )) as SearchResponse)
        : null,
    [hasQuery, q, category, brand, minPricePaise, maxPricePaise, sort],
  );

  function write(next: Record<string, string | null>): void {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') p.delete(k);
      else p.set(k, v);
    }
    setParams(p);
  }

  const data = search.data;
  const facets = data?.facets;
  const relaxations = data?.relaxations ?? [];
  const total = data?.total ?? 0;

  const title = isDeals ? 'Deals' : q === '' ? 'Search' : `Results for “${q}”`;
  const description = isDeals
    ? 'Lowest price first — the same ordering the home page deals rail uses.'
    : q === ''
      ? 'Search by product, brand or category.'
      : `${number(total)} ${total === 1 ? 'result' : 'results'}`;

  // Applied filters, as removable chips (§8.3). Single-select facets toggle.
  const applied: { key: string; label: string; clear: () => void }[] = [];
  if (category) applied.push({ key: 'category', label: `Category: ${category}`, clear: () => write({ category: null }) });
  if (brand) applied.push({ key: 'brand', label: `Brand: ${brand}`, clear: () => write({ brand: null }) });
  if (minPricePaise !== null || maxPricePaise !== null) {
    applied.push({
      key: 'price',
      label: `Price: ${minPricePaise !== null ? money(Number(minPricePaise)) : 'any'} – ${
        maxPricePaise !== null ? money(Number(maxPricePaise)) : 'any'
      }`,
      clear: () => write({ minPricePaise: null, maxPricePaise: null }),
    });
  }

  if (!hasQuery) {
    return (
      <div>
        <PageHeader title="Search" description="Search by product, brand or category." />
        <ScreenEmpty
          title="What are you looking for?"
          description="Type a product, brand or category in the search box at the top of the page. Filters you pick are kept in the address bar, so you can share the result."
        />
      </div>
    );
  }

  if (search.status === 'loading') {
    return (
      <div>
        <PageHeader title={title} description={description} />
        <ScreenLoading label="Searching" />
      </div>
    );
  }
  if (search.status === 'error') {
    return (
      <div>
        <PageHeader title={title} description={description} />
        <ScreenError error={search.error} onRetry={search.reload} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={title} description={description} />

      <div className="pxcu-row">
        <SelectField
          label="Sort by"
          name="sort"
          value={sort}
          options={SORT_OPTIONS}
          onValueChange={(v) => write({ sort: v === 'relevance' ? null : v })}
        />
      </div>

      {facets && (facets.category.length > 0 || facets.brand.length > 0 || facets.priceBand.length > 0) && (
        <div className="pxcu-chips">
          <span className="pxcu-chips__label" id="search-facets">
            Filters
          </span>
          <ul className="pxcu-chips__list" aria-labelledby="search-facets">
            {facets.category.map((c) => (
              <li key={`cat-${c.slug}`}>
                <button
                  type="button"
                  className={`px-chip px-chip--button ${category === c.slug ? 'is-selected' : ''}`}
                  aria-pressed={category === c.slug}
                  onClick={() => write({ category: category === c.slug ? null : c.slug })}
                >
                  <span className="px-chip__text">
                    {c.name} ({number(c.count)})
                  </span>
                </button>
              </li>
            ))}
            {facets.brand.map((b) => (
              <li key={`brand-${b.name}`}>
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
            {facets.priceBand.map((band) => {
              const selected =
                minPricePaise === String(band.minPaise) && maxPricePaise === String(band.maxPaise);
              return (
                <li key={`price-${band.minPaise}-${band.maxPaise}`}>
                  <button
                    type="button"
                    className={`px-chip px-chip--button ${selected ? 'is-selected' : ''}`}
                    aria-pressed={selected}
                    onClick={() =>
                      write({
                        minPricePaise: selected ? null : String(band.minPaise),
                        maxPricePaise: selected ? null : String(band.maxPaise),
                      })
                    }
                  >
                    <span className="px-chip__text">
                      {money(band.minPaise)}–{money(band.maxPaise)} ({number(band.count)})
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
                <span className="px-chip">
                  <span className="px-chip__text">{a.label}</span>
                  <button
                    type="button"
                    className="px-chip__remove"
                    aria-label={`Remove filter ${a.label}`}
                    onClick={a.clear}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && data.items.length === 0 ? (
        <>
          <ScreenEmpty
            title="No results"
            description={
              relaxations.length > 0
                ? `Nothing matched${q ? ` “${q}”` : ' these filters'}. The server relaxed the query as follows:`
                : `Nothing matched${q ? ` “${q}”` : ' these filters'}. Try fewer words, a different brand, or a wider price range.`
            }
          />
          {relaxations.length > 0 && (
            <section className="px-panel" aria-labelledby="search-relax">
              <h2 id="search-relax">What the search relaxed</h2>
              <ul>
                {relaxations.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        data && (
          <>
            <ProductGrid items={data.items} />
            <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-6)' }}>
              Showing {number(data.items.length)} of {number(total)}. Search only returns the first
              page in this release — narrow the query or a filter to see the rest.{' '}
              <Link to="/">Back to home</Link>
            </p>
          </>
        )
      )}
    </div>
  );
}
