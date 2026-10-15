/**
 * SCR-014 — Order detail (FR-CUS-016).
 *
 * The full server-side view of one order: money breakdown, ship-to address,
 * payment state, one block per sub-order (BRU-03: one per seller) with its SLA
 * clocks and tracking if the seller supplied any, and the event timeline.
 *
 * Cancel is offered only at CONFIRMED, matching the BFF's own guard; a refusal
 * after a seller has accepted is shown as the server's message with its trace
 * id. Returns are raised from here once a sub-order is DELIVERED — the link
 * carries no state, because the returns screen re-checks on the server.
 *
 * Disclosed gap, stated on the page: this release has no order-line table, so
 * per-item rows and per-sub-order amounts are not stored and are not shown.
 * `amountPaise` on each sub-order is 0 in the BFF by construction, so it is
 * not rendered as money.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { OrderDetail } from '@contracts/dto';
import { Badge, Button, LinkButton, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { money, dateTime, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import type { Crumb } from '../lib/Screen';
import { PageHeader, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import { orderTone } from './status';
import './customer.css';

function DetailInner() {
  const { id = '' } = useParams();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; traceId?: string } | null>(null);

  const order = useAsync<OrderDetail>(
    async (signal) => (await api.order(id, signal)) as OrderDetail,
    [id],
  );

  async function cancel(): Promise<void> {
    if (cancelling) return;
    setCancelling(true);
    setActionError(null);
    try {
      await api.cancelOrder(id);
      toast.success('Order cancelled');
      order.reload();
    } catch (err) {
      if (err instanceof ApiProblem) {
        setActionError({ message: err.problem.detail || err.problem.title, traceId: err.traceId });
        toast.error(err.problem.detail || err.problem.title);
      } else {
        setActionError({ message: 'Could not reach the server. Check your connection and try again.' });
        toast.error('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setCancelling(false);
    }
  }

  if (order.status === 'loading') return <ScreenLoading label="Loading the order" />;
  if (order.status === 'error' || !order.data) {
    return <ScreenError error={order.error} onRetry={order.reload} />;
  }

  const o = order.data;
  const crumbs: Crumb[] = [{ label: 'Orders', to: '/orders' }, { label: o.id }];
  const anyDelivered = o.subOrders.some((s) => s.state === 'DELIVERED');

  return (
    <div>
      <PageHeader
        title={`Order ${o.id}`}
        crumbs={crumbs}
        description={`Placed ${dateTime(o.placedAt)}`}
        actions={
          <>
            {o.status === 'CONFIRMED' && (
              <Button variant="ghost" loading={cancelling} onClick={cancel}>
                Cancel order
              </Button>
            )}
            {anyDelivered && <LinkButton to="/returns">Start a return</LinkButton>}
          </>
        }
      />

      <div className="pxcu-row" style={{ marginBottom: 'var(--px-space-4)' }}>
        <Badge tone={orderTone(o.status)}>{o.status}</Badge>
        <Badge tone={o.paymentStatus === 'AUTHORISED' || o.paymentStatus === 'CAPTURED' ? 'success' : 'neutral'}>
          Payment {o.paymentStatus || 'unknown'} ({o.paymentMethod || 'method unknown'})
        </Badge>
      </div>

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

      <p className="pxcu-note">
        This release stores no order-line rows (schema V001–V007), so the individual items and
        per-seller amounts are not kept and are not shown here. The order-level totals below are
        what the server captured at placement.
      </p>

      <div className="px-split">
        <div className="pxcu-stack">
          <section className="px-panel" aria-labelledby="od-subs">
            <div className="px-panel__head">
              <h2 id="od-subs">Sellers ({number(o.subOrders.length)})</h2>
            </div>
            <ul className="pxcu-lines">
              {o.subOrders.map((s) => (
                <li key={s.id} className="pxcu-line">
                  <div>
                    <strong>{s.vendorName}</strong>
                    <span className="pxcu-line__meta">
                      Accept by {dateTime(s.slaAcceptBy)} · Ship by {dateTime(s.slaShipBy)}
                    </span>
                    {s.tracking && (
                      <span className="pxcu-line__meta">
                        {s.tracking.carrier} · AWB <code className="px-num">{s.tracking.awb}</code>
                      </span>
                    )}
                  </div>
                  <div className="pxcu-line__side">
                    <Badge tone={orderTone(s.state)}>{s.state}</Badge>
                  </div>
                </li>
              ))}
            </ul>

            {o.subOrders.some((s) => s.tracking && s.tracking.events.length > 0) && (
              <section aria-labelledby="od-track" style={{ marginTop: 'var(--px-space-5)' }}>
                <h3 id="od-track">Tracking</h3>
                {o.subOrders
                  .filter((s) => s.tracking && s.tracking.events.length > 0)
                  .map((s) => (
                    <div key={s.id} style={{ marginBottom: 'var(--px-space-4)' }}>
                      <p className="pxcu-line__meta">{s.vendorName}</p>
                      <ul className="pxcu-timeline">
                        {s.tracking!.events.map((e, i) => (
                          <li key={`${s.id}-${i}`}>
                            <span className="pxcu-timeline__at">{dateTime(e.at)}</span>
                            {e.label}
                            {e.location && <> — {e.location}</>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </section>
            )}
          </section>

          {o.timeline.length > 0 && (
            <section className="px-panel" aria-labelledby="od-timeline">
              <div className="px-panel__head">
                <h2 id="od-timeline">Timeline</h2>
              </div>
              <ul className="pxcu-timeline">
                {o.timeline.map((t, i) => (
                  <li key={`${t.at}-${i}`}>
                    <span className="pxcu-timeline__at">{dateTime(t.at)}</span>
                    {t.label}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="pxcu-summary" aria-labelledby="od-money">
          <h2 id="od-money" style={{ fontSize: 'var(--px-fs-18)', marginBottom: 'var(--px-space-3)' }}>
            Payment
          </h2>
          <div className="pxcu-summary__row">
            <span>Items</span>
            <span className="px-num">{money(o.itemTotalPaise)}</span>
          </div>
          {o.discountTotalPaise > 0 && (
            <div className="pxcu-summary__row">
              <span>Discount</span>
              <span className="px-num">−{money(o.discountTotalPaise)}</span>
            </div>
          )}
          <div className="pxcu-summary__row">
            <span>Tax</span>
            <span className="px-num">{money(o.taxTotalPaise)}</span>
          </div>
          <div className="pxcu-summary__row">
            <span>Shipping</span>
            <span className="px-num">{money(o.shippingTotalPaise)}</span>
          </div>
          <div className="pxcu-summary__row pxcu-summary__row--total">
            <span>Grand total</span>
            <span className="px-num">{money(o.grandTotalPaise)}</span>
          </div>

          <h2 style={{ fontSize: 'var(--px-fs-18)', margin: 'var(--px-space-5) 0 var(--px-space-3)' }}>
            Shipped to
          </h2>
          <address style={{ fontStyle: 'normal', fontSize: 'var(--px-fs-14)' }}>
            {o.address.line1}
            {o.address.line2 && <>, {o.address.line2}</>}
            {o.address.landmark && <>, {o.address.landmark}</>}
            <br />
            {o.address.city}, {o.address.state} {o.address.pincode}
            <br />
            Mobile {o.address.mobile}
          </address>

          <p className="pxcu-muted" style={{ marginTop: 'var(--px-space-4)' }}>
            Need to return something? <Link to="/returns">Open the returns desk</Link> once the
            seller marks it delivered.
          </p>
        </aside>
      </div>
    </div>
  );
}

export function OrderDetailScreen() {
  return (
    <RequireCustomer>
      <DetailInner />
    </RequireCustomer>
  );
}
