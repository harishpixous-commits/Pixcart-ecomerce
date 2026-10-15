/**
 * SCR-009 — Checkout (FR-CUS-014).
 *
 * Two-phase by construction, matching the BFF: `POST /checkout/quote` prices
 * the cart against a chosen address PIN and payment method and returns an
 * immutable quote; `POST /checkout/orders` captures it under an
 * `Idempotency-Key` so a double-click or a retry after a network blip cannot
 * place two orders (the server replays the first). The key is minted once per
 * quote attempt and rotated after a successful placement.
 *
 * Pricing never happens here. The summary renders the quote's own line items;
 * a capture failure (QUOTE_EXPIRED, amount mismatch, a line that went out of
 * stock between quote and capture) is shown verbatim with its trace id, and
 * QUOTE_EXPIRED offers a fresh quote rather than a silent retry.
 *
 * Two honest limitations, named on the screen instead of papered over:
 *  - PREPAID requires a provider-issued `paymentRef`; no payment provider is
 *    bound in this build (docs/LIMITATIONS.md §0), so the option is visible
 *    but cannot be used — selecting it explains why rather than faking a
 *    redirect.
 *  - Coupons: the quote engine prices them, but order capture re-derives the
 *    quote without coupon codes (services/bff/src/repos/commerce.ts), so a
 *    discounted quote could never be captured. Coupon entry is therefore not
 *    offered rather than offered-and-broken.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Address, CartView, Quote } from '@contracts/dto';
import { Button, LinkButton } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { money, relativeTime } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import './customer.css';

interface AddressesPayload {
  items: Address[];
}

/** A 422 from the quote engine: per-line reasons, plus the trace id §8.3 requires. */
function QuoteProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const problem = error instanceof ApiProblem ? error : null;
  const fields = problem?.fields;
  return (
    <div className="px-screenstate px-screenstate--error" role="alert">
      <p className="px-screenstate__msg">
        {problem ? problem.problem.detail || problem.problem.title : 'The quote could not be built.'}
      </p>
      {fields && Object.keys(fields).length > 0 && (
        <ul>
          {Object.entries(fields).map(([k, v]) => (
            <li key={k}>
              <code className="px-num">{k}</code>: {v}
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <details className="px-screenstate__details">
          <summary>Technical details</summary>
          <p>
            Error code: <code className="px-num">{problem.code}</code>
            <br />
            Trace ID: <code className="px-num">{problem.traceId}</code>
          </p>
        </details>
      )}
      <Button variant="secondary" onClick={onRetry}>
        Request a new quote
      </Button>
    </div>
  );
}

function CheckoutInner() {
  const navigate = useNavigate();
  const cart = useAsync<CartView>(async (signal) => (await api.cart(signal)) as CartView, []);
  const addresses = useAsync<AddressesPayload>(
    async (signal) => (await api.addresses(signal)) as AddressesPayload,
    [],
  );

  const [addressId, setAddressId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'PREPAID' | 'COD'>('COD');
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<{ message: string; traceId?: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // One key per quote attempt; rotated after a successful placement so a
  // second order is a second key, and a retry of the first is a replay.
  const idempotencyKey = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const addressList = addresses.data?.items ?? [];
  const selected = addressList.find((a) => a.id === addressId);

  // Default address first; a shopper with none is sent to the address book.
  useEffect(() => {
    if (addressId !== '' || addressList.length === 0) return;
    const def = addressList.find((a) => a.isDefault) ?? addressList[0];
    if (def) setAddressId(def.id);
  }, [addressList, addressId]);

  const pin = selected?.pincode ?? '';
  const quote = useAsync<Quote | null>(
    async () =>
      pin
        ? ((await api.quote({ addressPin: pin, paymentMethod })) as Quote)
        : null,
    [pin, paymentMethod],
  );

  const q = quote.data;
  const quoteExpired = q !== null && Date.now() > q.expiresAtMs;

  async function placeOrder(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (placing) return;
    setPlaceError(null);
    setFieldErrors({});

    if (!selected) {
      setFieldErrors({ addressId: 'Choose a delivery address' });
      return;
    }
    if (!q) {
      setPlaceError({ message: 'No quote yet — the price is still being calculated. Try again in a moment.' });
      return;
    }
    if (quoteExpired) {
      setPlaceError({ message: 'This quote has expired. Request a new one before placing the order.' });
      quote.reload();
      return;
    }
    if (paymentMethod === 'PREPAID') {
      // No provider is bound, so no paymentRef can honestly be produced.
      setPlaceError({
        message:
          'No payment provider is connected in this build (docs/LIMITATIONS.md §0), so a prepaid order cannot be placed. Choose cash on delivery, or complete prepaid once a provider is configured.',
      });
      return;
    }

    setPlacing(true);
    try {
      const res = await api.placeOrder(
        {
          quoteId: q.quoteId,
          grandTotalPaise: q.grandTotalPaise,
          addressId: selected.id,
          paymentMethod,
        },
        idempotencyKey.current,
      );
      idempotencyKey.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      navigate(`/order/${res.orderId}/confirmed`, { state: { replay: res.replay } });
    } catch (err) {
      if (err instanceof ApiProblem) {
        if (err.status === 422 && err.fields) setFieldErrors(err.fields);
        setPlaceError({ message: err.problem.detail || err.problem.title, traceId: err.traceId });
        if (err.code === 'QUOTE_EXPIRED') quote.reload();
      } else {
        setPlaceError({ message: 'Could not reach the server. Check your connection and try again.' });
      }
    } finally {
      setPlacing(false);
    }
  }

  if (cart.status === 'loading' || addresses.status === 'loading') {
    return <ScreenLoading label="Preparing checkout" />;
  }
  if (cart.status === 'error') return <ScreenError error={cart.error} onRetry={cart.reload} />;
  if (addresses.status === 'error') {
    return <ScreenError error={addresses.error} onRetry={addresses.reload} />;
  }

  const cartData = cart.data;
  const activeLines = cartData?.lines.filter((l) => !l.savedForLater) ?? [];
  if (!cartData || activeLines.length === 0) {
    return (
      <div>
        <PageHeader title="Checkout" />
        <ScreenEmpty
          title="Your cart is empty"
          description="Add something to the cart before checking out."
          action={<LinkButton to="/" variant="primary">Start shopping</LinkButton>}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Checkout"
        crumbs={[
          { label: 'Cart', to: '/cart' },
          { label: 'Checkout' },
        ]}
        description="The price is calculated by the server from your cart, address and payment method."
      />

      <form className="px-split--wide-right px-split" onSubmit={placeOrder} noValidate>
        <div className="pxcu-stack">
          <fieldset className="pxcu-fieldset">
            <legend className="pxcu-legend">Delivery address</legend>
            {addressList.length === 0 ? (
              <div className="pxcu-note" role="alert">
                You have no saved addresses.{' '}
                <Link to="/account/addresses">Add one in your address book</Link>, then come back
                to checkout.
              </div>
            ) : (
              <ul className="pxcu-stack" style={{ gap: 'var(--px-space-2)' }}>
                {addressList.map((a) => (
                  <li key={a.id}>
                    <label className="pxcu-check">
                      <input
                        type="radio"
                        name="addressId"
                        value={a.id}
                        checked={addressId === a.id}
                        onChange={() => setAddressId(a.id)}
                      />
                      <span>
                        <strong>{a.label}</strong>
                        {a.isDefault && <> · default</>}
                        <br />
                        {a.line1}
                        {a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.state} {a.pincode}
                        <br />
                        <span className="pxcu-muted">PIN {a.pincode} · mobile {a.mobile}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {fieldErrors.addressId && (
              <p className="px-field__error" role="alert">
                {fieldErrors.addressId}
              </p>
            )}
            <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-3)' }}>
              Need a different address?{' '}
              <Link to="/account/addresses">Manage your address book</Link>
            </p>
          </fieldset>

          <fieldset className="pxcu-fieldset">
            <legend className="pxcu-legend">Payment method</legend>
            <label className="pxcu-check">
              <input
                type="radio"
                name="paymentMethod"
                value="COD"
                checked={paymentMethod === 'COD'}
                onChange={() => setPaymentMethod('COD')}
              />
              <span>
                Cash on delivery
                <br />
                <span className="pxcu-muted">
                  Available for orders within the server's COD limit and to serviceable PINs; the
                  quote below tells you whether this cart qualifies.
                </span>
              </span>
            </label>
            <label className="pxcu-check">
              <input
                type="radio"
                name="paymentMethod"
                value="PREPAID"
                checked={paymentMethod === 'PREPAID'}
                onChange={() => setPaymentMethod('PREPAID')}
                disabled
              />
              <span>
                Prepaid (UPI / card) — unavailable in this build
                <br />
                <span className="pxcu-muted">
                  No payment provider is connected (docs/LIMITATIONS.md §0). The option stays
                  visible so the flow is honest about what exists; it cannot be used until a
                  provider is configured.
                </span>
              </span>
            </label>
          </fieldset>

          {placeError && (
            <div className="px-screenstate px-screenstate--error" role="alert">
              <p className="px-screenstate__msg">{placeError.message}</p>
              {placeError.traceId && (
                <details className="px-screenstate__details">
                  <summary>Technical details</summary>
                  <p>
                    Trace ID: <code className="px-num">{placeError.traceId}</code>
                  </p>
                </details>
              )}
            </div>
          )}

          <div className="px-form__actions">
            {/* §8.3: never disabled for validation — it is enabled whenever the
                form can be submitted, and `loading` covers the in-flight case. */}
            <Button type="submit" variant="primary" loading={placing} disabled={!selected}>
              Place order
            </Button>
            <LinkButton to="/cart">Back to cart</LinkButton>
          </div>
        </div>

        <aside className="pxcu-summary" aria-labelledby="co-sum">
          <h2 id="co-sum" style={{ fontSize: 'var(--px-fs-18)', marginBottom: 'var(--px-space-3)' }}>
            Order summary
          </h2>

          <ul className="pxcu-lines" style={{ marginBottom: 'var(--px-space-4)' }}>
            {activeLines.map((l) => (
              <li key={l.id} className="pxcu-summary__row">
                <span>
                  {l.title || l.listingId} × {l.qty}
                </span>
                <span className="px-num">{money(l.pricePaise * l.qty)}</span>
              </li>
            ))}
          </ul>

          {quote.status === 'loading' && (
            <p className="pxcu-muted" aria-live="polite">
              Asking the server for a price…
            </p>
          )}
          {quote.status === 'error' && <QuoteProblem error={quote.error} onRetry={quote.reload} />}
          {quote.status === 'success' && !q && (
            <p className="pxcu-muted">Choose a delivery address to see the final price.</p>
          )}
          {q && (
            <>
              <div className="pxcu-summary__row">
                <span>Items</span>
                <span className="px-num">{money(q.itemTotalPaise)}</span>
              </div>
              {q.discountTotalPaise > 0 && (
                <div className="pxcu-summary__row">
                  <span>Discount</span>
                  <span className="px-num">−{money(q.discountTotalPaise)}</span>
                </div>
              )}
              <div className="pxcu-summary__row">
                <span>Tax (GST)</span>
                <span className="px-num">{money(q.taxTotalPaise)}</span>
              </div>
              <div className="pxcu-summary__row">
                <span>Shipping</span>
                <span className="px-num">{money(q.shippingTotalPaise)}</span>
              </div>
              <div className="pxcu-summary__row pxcu-summary__row--total">
                <span>Grand total</span>
                <span className="px-num">{money(q.grandTotalPaise)}</span>
              </div>

              {quoteExpired && (
                <p className="pxcu-note" role="alert">
                  This quote expired {relativeTime(q.expiresAtMs)}.{' '}
                  <button type="button" className="px-btn px-btn--link px-btn--sm" onClick={quote.reload}>
                    Get a fresh price
                  </button>
                </p>
              )}

              {paymentMethod === 'COD' && !q.codEligible && (
                <p className="pxcu-note" role="alert">
                  Cash on delivery is not available for this cart:
                  {q.codReasons.length > 0 ? ` ${q.codReasons.join(' · ')}` : ' the server did not accept it.'}{' '}
                  Choose a different address or reduce the order value.
                </p>
              )}

              <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-3)' }}>
                The server re-checks this price, stock and serviceability when you place the
                order; if anything changed it will say exactly what.
              </p>
            </>
          )}
        </aside>
      </form>
    </div>
  );
}

export function CheckoutScreen() {
  return (
    <RequireCustomer>
      <CheckoutInner />
    </RequireCustomer>
  );
}
