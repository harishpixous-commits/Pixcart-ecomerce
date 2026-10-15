/**
 * SCR-012 — Order placed (FR-CUS-015).
 *
 * Reached only from a successful `POST /checkout/orders`, but it never trusts
 * that: it re-fetches `GET /orders/:id` and renders what the server says the
 * order is. If the fetch fails the page says so with a trace id and offers the
 * orders list, rather than showing a green tick over money that may not have
 * moved.
 *
 * A replayed placement (same Idempotency-Key, same order) carries
 * `state.replay` from checkout; the page says the order was already placed,
 * because silently presenting a replay as a fresh order is how people
 * double-buy.
 */
import { Link, useLocation, useParams } from 'react-router-dom';
import type { OrderDetail } from '@contracts/dto';
import { Badge } from '../../design';
import { api } from '../../lib/api';
import { money, dateTime, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { LinkButton } from '../../design';
import { PageHeader, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import { orderTone } from './status';
import './customer.css';

function ConfirmedInner() {
  const { id = '' } = useParams();
  const location = useLocation();
  const replay = (location.state as { replay?: boolean } | null)?.replay === true;

  const order = useAsync<OrderDetail>(
    async (signal) => (await api.order(id, signal)) as OrderDetail,
    [id],
  );

  if (order.status === 'loading') return <ScreenLoading label="Loading your order" />;
  if (order.status === 'error' || !order.data) {
    return (
      <div>
        <PageHeader title="Order confirmation" />
        <ScreenError error={order.error} onRetry={order.reload} />
        <p style={{ marginTop: 'var(--px-space-4)' }}>
          Your orders are also listed under <Link to="/orders">Order history</Link>.
        </p>
      </div>
    );
  }

  const o = order.data;

  return (
    <div>
      <PageHeader
        title={replay ? 'Order already placed' : 'Order placed'}
        description={
          replay
            ? 'This confirmation is for an order that had already been accepted — the idempotency key matched, so nothing new was charged or created.'
            : 'Thank you. The order is with the sellers now.'
        }
      />

      <section className="px-panel" aria-labelledby="confirmed-sum">
        <div className="px-panel__head">
          <h2 id="confirmed-sum">Order {o.id}</h2>
          <Badge tone={orderTone(o.status)}>{o.status}</Badge>
        </div>
        <dl className="px-dl">
          <dt>Placed</dt>
          <dd>{dateTime(o.placedAt)}</dd>
          <dt>Sellers</dt>
          <dd>{o.vendorNames.length > 0 ? o.vendorNames.join(', ') : '—'}</dd>
          <dt>Payment</dt>
          <dd>
            {o.paymentMethod || '—'}
            {o.paymentStatus && <> · {o.paymentStatus}</>}
          </dd>
          <dt>Ships to</dt>
          <dd>
            {o.address.line1}
            {o.address.line2 ? `, ${o.address.line2}` : ''}, {o.address.city}, {o.address.state}{' '}
            {o.address.pincode}
          </dd>
          <dt>Grand total</dt>
          <dd className="px-num">{money(o.grandTotalPaise)}</dd>
          {o.itemCount > 0 && (
            <>
              <dt>Items</dt>
              <dd>{number(o.itemCount)}</dd>
            </>
          )}
        </dl>
        <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-4)' }}>
          Each seller ships as its own sub-order. Tracking appears on the order page once a
          seller marks a sub-order shipped.
        </p>
      </section>

      <div className="pxcu-row" style={{ marginTop: 'var(--px-space-5)' }}>
        <LinkButton to={`/order/${o.id}`} variant="primary">
          View order
        </LinkButton>
        <LinkButton to="/orders">Order history</LinkButton>
        <LinkButton to="/" variant="ghost">
          Continue shopping
        </LinkButton>
      </div>
    </div>
  );
}

export function OrderConfirmedScreen() {
  return (
    <RequireCustomer>
      <ConfirmedInner />
    </RequireCustomer>
  );
}
