/**
 * SCR-008 — Storefront home (FR-CUS-008).
 *
 * One `GET /home` call renders the whole page: the category tree, then up to
 * three product rails (continue-shopping, for-you, deals). A guest gets a
 * working home — there is no login wall here, and the server already answers a
 * guest with an empty continue-shopping rail rather than a 401, so the rails a
 * visitor can actually see are the public ones.
 *
 * Rails that came back empty are not rendered: an empty grid is not a state the
 * shopper can act on, and inventing filler tiles would be a lie about the
 * catalogue. If *everything* came back empty the page falls back to the shared
 * empty state instead of a blank rectangle.
 */
import { Link } from 'react-router-dom';
import type { Category, ListingSummary } from '@contracts/dto';
import { LinkButton } from '../../design';
import { api } from '../../lib/api';
import { number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import {
  PageHeader,
  ProductGrid,
  ScreenEmpty,
  ScreenError,
  ScreenLoading,
} from '../lib/Screen';
import './customer.css';

/**
 * `GET /home` payload. The BFF names this `HomeResponse`; it is declared here
 * rather than in `contracts/dto.ts` because the canonical contracts file does
 * not carry it (the BFF's own dto.ts documents the same gap).
 */
interface HomeResponse {
  categories: Category[];
  continueShopping: ListingSummary[];
  forYou: ListingSummary[];
  deals: ListingSummary[];
}

function Rail({ title, items, moreTo, moreLabel }: {
  title: string;
  items: ListingSummary[];
  moreTo?: string;
  moreLabel?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="px-rail" aria-labelledby={`rail-${title.replace(/\W+/g, '-')}`}>
      <div className="px-rail__head">
        <h2 id={`rail-${title.replace(/\W+/g, '-')}`}>{title}</h2>
        {moreTo && moreLabel && (
          <Link className="px-rail__more" to={moreTo}>
            {moreLabel}
          </Link>
        )}
      </div>
      <ProductGrid items={items} />
    </section>
  );
}

export function HomeScreen() {
  const home = useAsync<HomeResponse>(async (signal) => (await api.home(signal)) as HomeResponse, []);

  if (home.status === 'loading') return <ScreenLoading label="Loading the storefront" />;
  if (home.status === 'error') return <ScreenError error={home.error} onRetry={home.reload} />;

  const { categories, continueShopping, forYou, deals } = home.data ?? {
    categories: [],
    continueShopping: [],
    forYou: [],
    deals: [],
  };
  const nothingToShow =
    categories.length === 0 &&
    continueShopping.length === 0 &&
    forYou.length === 0 &&
    deals.length === 0;

  return (
    <div>
      <PageHeader
        title="Home"
        description="Browse categories, picks ranked by rating, and the lowest-priced listings."
      />

      {nothingToShow ? (
        <ScreenEmpty
          title="Nothing to show yet"
          description="The catalogue has no products to display right now. Search is the fastest way to check whether that is an empty catalogue or a filter problem."
          action={<LinkButton to="/search">Search the catalogue</LinkButton>}
        />
      ) : (
        <>
          {categories.length > 0 && (
            <section aria-labelledby="home-cats">
              <h2 id="home-cats">Shop by category</h2>
              <ul className="pxcu-cats">
                {categories.map((c) => (
                  <li key={c.id}>
                    <Link className="pxcu-cat" to={`/category/${c.slug}`}>
                      {c.name}
                      {typeof c.productCount === 'number' && (
                        <span className="pxcu-cat__count">{number(c.productCount)}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <Rail title="Continue shopping" items={continueShopping} />
          <Rail title="Picks for you" items={forYou} />
          <Rail title="Deals" items={deals} moreTo="/deals" moreLabel="See all deals" />
        </>
      )}
    </div>
  );
}
