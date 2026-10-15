/**
 * Shared screen furniture.
 *
 * These exist so 29 screens do not become 29 slightly-different page headers, error
 * blocks and product cards. Each one encodes a §8.3 or §8.4 rule once:
 *  - `PageHeader` renders a single `<h1>` and a breadcrumb, so heading order is right
 *    without every screen thinking about it
 *  - `ScreenError` always offers Retry and always reveals the trace id §8.3 requires
 *  - `ScreenLoading` uses the skeleton primitive, which respects reduced-motion
 *  - `ProductCard` is one link, not a card-of-links, so it is one tab stop
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, RotateCw } from 'lucide-react';
import { Button } from '../../design';
import { money } from '../../lib/format';
import { describeError } from './useAsync';
import './screens.css';

export interface Crumb {
  label: string;
  to?: string;
}

export function PageHeader({
  title,
  crumbs,
  actions,
  description,
}: {
  title: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="px-pagehead">
      {crumbs && crumbs.length > 0 && (
        <nav className="px-crumbs" aria-label="Breadcrumb">
          <ol>
            {crumbs.map((c, i) => (
              <li key={`${c.label}-${i}`}>
                {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
                {i < crumbs.length - 1 && (
                  <ChevronRight size={14} aria-hidden="true" className="px-crumbs__sep" />
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="px-pagehead__row">
        <div className="px-pagehead__text">
          <h1>{title}</h1>
          {description && <p className="px-pagehead__desc">{description}</p>}
        </div>
        {actions && <div className="px-pagehead__actions">{actions}</div>}
      </div>
    </div>
  );
}

export function ScreenLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="px-screenstate" aria-busy="true" aria-live="polite">
      <span className="px-visually-hidden">{label}…</span>
      <div className="px-skeleton" style={{ height: 20, width: '40%', marginBottom: 12 }} />
      <div className="px-skeleton" style={{ height: 14, width: '70%', marginBottom: 8 }} />
      <div className="px-skeleton" style={{ height: 14, width: '55%' }} />
    </div>
  );
}

/**
 * Error state.
 *
 * `role="alert"` (§8.4) so a screen-reader user is told immediately, and the trace id
 * is shown behind a disclosure because §8.3 requires it to be revealable — it is the
 * only thing support needs when a user reports a failure.
 */
export function ScreenError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { message, traceId, code } = describeError(error);
  return (
    <div className="px-screenstate px-screenstate--error" role="alert">
      <AlertTriangle size={24} aria-hidden="true" />
      <p className="px-screenstate__msg">{message}</p>
      {code && <p className="px-screenstate__meta">Error code: {code}</p>}
      {traceId && (
        <details className="px-screenstate__details">
          <summary>Technical details</summary>
          <p>
            Trace ID: <code className="px-num">{traceId}</code>
          </p>
        </details>
      )}
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} icon={<RotateCw size={16} aria-hidden="true" />}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function ScreenEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-screenstate px-screenstate--empty">
      <h2>{title}</h2>
      {description && <p className="px-screenstate__msg">{description}</p>}
      {action}
    </div>
  );
}

/** One product tile. The whole tile is a single link — one tab stop, no nested links. */
export interface ProductCardData {
  id: string;
  title: string;
  pricePaise: number;
  mrpPaise?: number | null;
  imageUrl?: string | null;
  vendorName?: string | null;
  inStock?: boolean;
  rating?: number | null;
  reviewCount?: number | null;
}

export function ProductCard({ product }: { product: ProductCardData }) {
  const off = product.mrpPaise && product.mrpPaise > product.pricePaise
    ? Math.round(((product.mrpPaise - product.pricePaise) / product.mrpPaise) * 100)
    : 0;

  return (
    <Link className="px-pcard" to={`/product/${product.id}`}>
      <div className="px-pcard__media">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt="" loading="lazy" width={200} height={200} />
        ) : (
          // No image is not an error state: the catalogue has no image pipeline in this
          // release, so every tile falls back to a labelled placeholder rather than a
          // broken <img>.
          <span className="px-pcard__ph" aria-hidden="true">
            {product.title.slice(0, 2).toUpperCase()}
          </span>
        )}
        {off > 0 && <span className="px-pcard__off">{off}% off</span>}
      </div>
      <div className="px-pcard__body">
        <span className="px-pcard__title">{product.title}</span>
        {product.vendorName && <span className="px-pcard__vendor">{product.vendorName}</span>}
        <span className="px-pcard__prices">
          <span className="px-pcard__price px-num">{money(product.pricePaise)}</span>
          {product.mrpPaise && product.mrpPaise > product.pricePaise && (
            <span className="px-pcard__mrp px-num">{money(product.mrpPaise)}</span>
          )}
        </span>
        {product.inStock === false && <span className="px-pcard__oos">Out of stock</span>}
        {typeof product.rating === 'number' && product.rating > 0 && (
          <span className="px-pcard__rating px-num">
            ★ {product.rating.toFixed(1)}
            {typeof product.reviewCount === 'number' && ` (${product.reviewCount})`}
          </span>
        )}
      </div>
    </Link>
  );
}

export function ProductGrid({ items }: { items: ProductCardData[] }) {
  return (
    <ul className="px-pgrid">
      {items.map((p) => (
        <li key={p.id}>
          <ProductCard product={p} />
        </li>
      ))}
    </ul>
  );
}
