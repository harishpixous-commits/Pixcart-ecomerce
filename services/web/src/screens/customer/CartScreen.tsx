/**
 * SCR-007 — Cart (FR-CUS-007).
 *
 * One `GET /cart` renders the whole surface: active lines grouped by vendor
 * (BRU-03 splits the order at checkout, so the grouping is shown here too),
 * saved-for-later lines, and the server-computed totals. Every mutation returns
 * the full `CartView`, so the UI replaces its data with the server's answer
 * instead of recomputing money on the client — the cart total is never derived
 * in the browser.
 *
 * Mutations are keyed by listing ULID: the BFF routes cart writes as
 * `/cart/lines/:listingId` and the composite `CartLine.id` (`cartId:listingId`)
 * is a display key, not the route key. Quantity 0 is the server's remove, so
 * the stepper never offers it — removal is its own explicit action.
 *
 * A failed mutation keeps the previous cart on screen, surfaces the problem's
 * detail and trace id, and does not optimistically change any number.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CartLine, CartView } from '@contracts/dto';
import { Badge, Button, LinkButton, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { money, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import './customer.css';

function LineRow({
  line,
  busy,
  onQty,
  onRemove,
  onSave,
  onMove,
}: {
  line: CartLine;
  busy: boolean;
  onQty: (qty: number) => void;
  onRemove: () => void;
  onSave?: () => void;
  onMove?: () => void;
}) {
  return (
    <li className="pxcu-line">
      <div>
        <Link className="pxcu-line__title" to={`/product/${line.listingId}`}>
          {line.title || line.listingId}
        </Link>
        <span className="pxcu-line__meta">
          {line.vendorName || 'Seller'} · {money(line.pricePaise)} each
          {line.mrpPaise > line.pricePaise && <> · MRP {money(line.mrpPaise)}</>}
        </span>
        {!line.inStock && (
          <span className="pxcu-line__meta">
            <Badge tone="danger" size="sm">Out of stock</Badge>
          </span>
        )}
        <div className="pxcu-line__actions">
          {onSave && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onSave}>
              Save for later
            </Button>
          )}
          {onMove && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onMove}>
              Move to cart
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
      <div className="pxcu-line__side">
        {!line.savedForLater && (
          <div className="pxcu-qty">
            <Button
              aria-label={`Decrease quantity of ${line.title}`}
              size="sm"
              disabled={busy || line.qty <= 1}
              onClick={() => onQty(line.qty - 1)}
            >
              −
            </Button>
            <span className="pxcu-qty__value px-num">{line.qty}</span>
            <Button
              aria-label={`Increase quantity of ${line.title}`}
              size="sm"
              disabled={busy || line.qty >= line.maxQty}
              onClick={() => onQty(line.qty + 1)}
            >
              +
            </Button>
          </div>
        )}
        <span className="px-num" style={{ fontWeight: 'var(--px-fw-bold)' }}>
          {money(line.pricePaise * line.qty)}
        </span>
      </div>
    </li>
  );
}

function CartInner() {
  const toast = useToast();
  const cart = useAsync<CartView>(async (signal) => (await api.cart(signal)) as CartView, []);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ message: string; traceId?: string } | null>(null);

  function fail(err: unknown): void {
    if (err instanceof ApiProblem) {
      setActionError({ message: err.problem.detail || err.problem.title, traceId: err.traceId });
      toast.error(err.problem.detail || err.problem.title);
    } else {
      setActionError({ message: 'Could not reach the server. Check your connection and try again.' });
      toast.error('Could not reach the server. Check your connection and try again.');
    }
  }

  async function run(key: string, fn: () => Promise<CartView>): Promise<void> {
    if (busyLine) return;
    setBusyLine(key);
    setActionError(null);
    try {
      const next = await fn();
      cart.setData(() => next);
    } catch (err) {
      fail(err);
    } finally {
      setBusyLine(null);
    }
  }

  if (cart.status === 'loading') return <ScreenLoading label="Loading your cart" />;
  if (cart.status === 'error' && !cart.data) {
    return <ScreenError error={cart.error} onRetry={cart.reload} />;
  }

  const data = cart.data;
  if (!data) return <ScreenEmpty title="Your cart is empty" />;

  const active = data.lines.filter((l) => !l.savedForLater);
  const saved = data.lines.filter((l) => l.savedForLater);

  return (
    <div>
      <PageHeader
        title="Your cart"
        description={`${number(data.itemCount)} ${data.itemCount === 1 ? 'item' : 'items'} · ${money(data.itemTotalPaise)}`}
        actions={<LinkButton to="/search">Keep shopping</LinkButton>}
      />

      {actionError && (
        <div className="px-screenstate px-screenstate--error" role="alert" style={{ marginBottom: 'var(--px-space-4)' }}>
          <p className="px-screenstate__msg">{actionError.message}</p>
          {actionError.traceId && (
            <details className="px-screenstate__details">
              <summary>Technical details</summary>
              <p>
                Trace ID: <code className="px-num">{actionError.traceId}</code>
              </p>
            </details>
          )}
        </div>
      )}

      {active.length === 0 ? (
        <ScreenEmpty
          title="Nothing in your cart yet"
          description="Browse a category or search the catalogue to add something."
          action={<LinkButton to="/" variant="primary">Start shopping</LinkButton>}
        />
      ) : (
        <div className="px-split">
          <div>
            {/* Grouped per vendor because BRU-03 ships each vendor as its own
                sub-order; the shopper sees that split before checkout does. */}
            {data.byVendor.map((g) => (
              <section key={g.vendorId} className="px-panel" aria-labelledby={`cart-v-${g.vendorId}`}>
                <div className="px-panel__head">
                  <h2 id={`cart-v-${g.vendorId}`}>{g.vendorName || 'Seller'}</h2>
                  <span className="px-num">{money(g.subtotalPaise)}</span>
                </div>
                <ul className="pxcu-lines">
                  {g.lines
                    .filter((l) => !l.savedForLater)
                    .map((line) => (
                      <LineRow
                        key={line.id}
                        line={line}
                        busy={busyLine === line.listingId}
                        onQty={(qty) =>
                          run(line.listingId, () => api.patchLine(line.listingId, { qty }) as Promise<CartView>)
                        }
                        onRemove={() => run(line.listingId, () => api.removeLine(line.listingId) as Promise<CartView>)}
                        onSave={() =>
                          run(line.listingId, () => api.saveForLater(line.listingId) as Promise<CartView>)
                        }
                      />
                    ))}
                </ul>
              </section>
            ))}
          </div>

          <aside className="pxcu-summary" aria-labelledby="cart-sum">
            <h2 id="cart-sum" style={{ fontSize: 'var(--px-fs-18)', marginBottom: 'var(--px-space-3)' }}>
              Summary
            </h2>
            <div className="pxcu-summary__row">
              <span>Item total</span>
              <span className="px-num">{money(data.itemTotalPaise)}</span>
            </div>
            {data.savingsPaise > 0 && (
              <div className="pxcu-summary__row">
                <span>Savings vs MRP</span>
                <span className="px-num">−{money(data.savingsPaise)}</span>
              </div>
            )}
            <div className="pxcu-summary__row pxcu-summary__row--total">
              <span>To pay</span>
              <span className="px-num">{money(data.itemTotalPaise)}</span>
            </div>
            <p className="pxcu-muted" style={{ margin: 'var(--px-space-3) 0' }}>
              Tax, any coupon discount and per-vendor shipping are added by the server at
              checkout — this screen never computes them.
            </p>
            <LinkButton to="/checkout" variant="primary" className="px-btn--block">
              Proceed to checkout
            </LinkButton>
          </aside>
        </div>
      )}

      {saved.length > 0 && (
        <section className="px-panel" aria-labelledby="cart-saved" style={{ marginTop: 'var(--px-space-6)' }}>
          <div className="px-panel__head">
            <h2 id="cart-saved">Saved for later ({number(saved.length)})</h2>
          </div>
          <ul className="pxcu-lines">
            {saved.map((line) => (
              <LineRow
                key={line.id}
                line={line}
                busy={busyLine === line.listingId}
                onQty={() => undefined}
                onRemove={() => run(line.listingId, () => api.removeLine(line.listingId) as Promise<CartView>)}
                onMove={() =>
                  run(line.listingId, () => api.moveToCart(line.listingId) as Promise<CartView>)
                }
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function CartScreen() {
  return (
    <RequireCustomer>
      <CartInner />
    </RequireCustomer>
  );
}
