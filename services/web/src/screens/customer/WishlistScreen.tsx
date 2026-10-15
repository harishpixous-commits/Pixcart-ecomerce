/**
 * SCR-016 — Wishlist (FR-CUS-006).
 *
 * A grid of saved listings, each removable or movable into the cart. Every
 * mutation returns the full wishlist, so the list is replaced with the
 * server's answer rather than patched locally — there is no way for this
 * screen to disagree with the server about what is saved.
 *
 * "Move to cart" is a plain add (`POST /cart/lines`, qty 1) followed by a
 * remove from the wishlist, which is exactly what those two endpoints do; the
 * server refuses the add if the listing is gone or the vendor is suspended,
 * and that refusal is shown rather than a silent no-op.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ListingSummary } from '@contracts/dto';
import { Button, LinkButton, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { money, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ProductGrid, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import './customer.css';

interface WishlistPayload {
  items: ListingSummary[];
}

function WishlistInner() {
  const toast = useToast();
  const wish = useAsync<WishlistPayload>(
    async (signal) => (await api.wishlist(signal)) as WishlistPayload,
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);

  function fail(err: unknown): void {
    if (err instanceof ApiProblem) toast.error(err.problem.detail || err.problem.title);
    else toast.error('Could not reach the server. Check your connection and try again.');
  }

  async function remove(id: string, title: string): Promise<void> {
    if (busy) return;
    setBusy(id);
    try {
      const next = (await api.removeWishlist(id)) as WishlistPayload;
      wish.setData(() => next);
      toast.success(`Removed ${title} from your wishlist`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function moveToCart(item: ListingSummary): Promise<void> {
    if (busy) return;
    setBusy(item.id);
    try {
      await api.addLine({ listingId: item.id, qty: 1 });
      const next = (await api.removeWishlist(item.id)) as WishlistPayload;
      wish.setData(() => next);
      toast.success(`Moved ${item.title} to your cart`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  if (wish.status === 'loading') return <ScreenLoading label="Loading your wishlist" />;
  if (wish.status === 'error') return <ScreenError error={wish.error} onRetry={wish.reload} />;

  const items = wish.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Your wishlist"
        description={
          items.length > 0
            ? `${number(items.length)} saved ${items.length === 1 ? 'item' : 'items'}`
            : 'Items you save for later.'
        }
        actions={<LinkButton to="/search">Find something</LinkButton>}
      />

      {items.length === 0 ? (
        <ScreenEmpty
          title="Nothing saved yet"
          description="Tap “Save to wishlist” on any product to keep it here."
          action={<LinkButton to="/" variant="primary">Browse products</LinkButton>}
        />
      ) : (
        <>
          <ProductGrid items={items} />
          <ul className="pxcu-lines" style={{ marginTop: 'var(--px-space-6)' }}>
            {items.map((item) => (
              <li key={item.id} className="pxcu-line">
                <div>
                  <Link className="pxcu-line__title" to={`/product/${item.id}`}>
                    {item.title}
                  </Link>
                  <span className="pxcu-line__meta">
                    {item.vendorName} · {money(item.pricePaise)}
                    {item.mrpPaise > item.pricePaise && <> · MRP {money(item.mrpPaise)}</>}
                  </span>
                  {!item.inStock && (
                    <span className="pxcu-line__meta">Out of stock — saving it keeps it on file.</span>
                  )}
                </div>
                <div className="pxcu-line__side">
                  <span className="px-num" style={{ fontWeight: 'var(--px-fw-bold)' }}>
                    {money(item.pricePaise)}
                  </span>
                  <div className="pxcu-line__actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === item.id || !item.inStock}
                      loading={busy === item.id}
                      onClick={() => moveToCart(item)}
                    >
                      Move to cart
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === item.id}
                      onClick={() => remove(item.id, item.title)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function WishlistScreen() {
  return (
    <RequireCustomer>
      <WishlistInner />
    </RequireCustomer>
  );
}
