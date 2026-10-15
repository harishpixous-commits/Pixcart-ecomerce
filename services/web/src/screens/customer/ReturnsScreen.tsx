/**
 * SCR-015 — Returns desk (FR-CUS-017/018).
 *
 * Two honest constraints shape this screen, both from disclosed schema gaps
 * rather than design preference:
 *
 *  1. **No order-line table.** An order's detail carries sub-orders but no
 *     listing rows, so the form cannot enumerate "which item in this order".
 *     The shopper pastes the listing id (the 26-character id in the product
 *     URL, `/product/<id>`); the server then proves the listing belongs to the
 *     chosen sub-order's vendor. The hint says exactly that — a silent
 *     free-text field here would just fail at submit with "vendor mismatch".
 *
 *  2. **No cancel-return route.** The BFF has no `POST /returns/:id/cancel`,
 *     so no cancel button is offered. One that always 404s would be worse than
 *     saying nothing.
 *
 * Admission is the server's call: only DELIVERED sub-orders pass its check, so
 * only those are selectable. The reason vocabulary is the BFF's own
 * (`RMA_REASONS` in services/bff/src/routes/validate.ts), not an invention.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { OrderDetail, OrderSummary, RmaRequest } from '@contracts/dto';
import { Badge, Button, LinkButton, SelectField, TextAreaField, TextField, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { money, dateTime, relativeTime, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import { rmaTone } from './status';
import './customer.css';

interface OrdersPage {
  items: OrderSummary[];
  nextCursor: string | null;
}

interface ReturnsPayload {
  items: RmaRequest[];
}

/** Verbatim from the BFF's RMA_REASONS set — do not extend client-side. */
const RMA_REASON_OPTIONS = [
  { value: 'DAMAGED', label: 'Damaged in transit' },
  { value: 'WRONG_ITEM', label: 'Wrong item delivered' },
  { value: 'MISSING_PARTS', label: 'Missing parts' },
  { value: 'NOT_AS_DESCRIBED', label: 'Not as described' },
  { value: 'SIZE_ISSUE', label: 'Size does not fit' },
  { value: 'CHANGED_MIND', label: 'Changed my mind' },
  { value: 'LATE_DELIVERY', label: 'Delivered too late' },
  { value: 'QUALITY_ISSUE', label: 'Quality problem' },
];

function ReturnsInner() {
  const toast = useToast();
  const returns = useAsync<ReturnsPayload>(
    async (signal) => (await api.returns(signal)) as ReturnsPayload,
    [],
  );
  const orders = useAsync<OrdersPage>(async (signal) => (await api.orders(null, signal)) as OrdersPage, []);

  const [orderId, setOrderId] = useState('');
  const [subOrderId, setSubOrderId] = useState('');
  const [listingId, setListingId] = useState('');
  const [qty, setQty] = useState('1');
  const [reasonCode, setReasonCode] = useState('DAMAGED');
  const [reasonText, setReasonText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);

  // Only the chosen order's detail is needed to list its DELIVERED sub-orders.
  const detail = useAsync<OrderDetail | null>(
    async () => (orderId ? ((await api.order(orderId)) as OrderDetail) : null),
    [orderId],
  );

  function resetForm(): void {
    setSubOrderId('');
    setListingId('');
    setQty('1');
    setReasonCode('DAMAGED');
    setReasonText('');
    setFieldErrors({});
    setFormError(null);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFieldErrors({});
    setFormError(null);

    const errors: Record<string, string> = {};
    if (!subOrderId) errors.subOrderId = 'Choose the delivered sub-order you are returning from';
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(listingId.trim())) {
      errors.listingId = 'Paste the 26-character listing id from the product page address';
    }
    const qtyNum = Number(qty);
    if (!Number.isInteger(qtyNum) || qtyNum < 1) errors.qty = 'Quantity must be a whole number of 1 or more';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setSubmitting(false);
      return;
    }

    try {
      await api.createReturn({
        subOrderId,
        listingId: listingId.trim(),
        qty: qtyNum,
        reasonCode,
        reasonText: reasonText.trim() || undefined,
      });
      setSubmitting(false);
      resetForm();
      orders.reload();
      returns.reload();
      toast.success('Return requested. The seller reviews it and the status appears below.');
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiProblem) {
        if (err.status === 422 && err.fields) setFieldErrors(err.fields);
        setFormError({ message: err.problem.detail || err.problem.title, traceId: err.traceId });
      } else {
        setFormError({ message: 'Could not reach the server. Check your connection and try again.' });
      }
    }
  }

  const deliveredSubs = (detail.data?.subOrders ?? []).filter((s) => s.state === 'DELIVERED');
  const orderItems = orders.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Returns"
        description="Request a return for a delivered item. The seller reviews every request."
        actions={<LinkButton to="/orders">Order history</LinkButton>}
      />

      <div className="px-split">
        <section className="px-panel" aria-labelledby="ret-new">
          <div className="px-panel__head">
            <h2 id="ret-new">Start a return</h2>
          </div>

          {orders.status === 'loading' && <ScreenLoading label="Loading your orders" />}
          {orders.status === 'error' && <ScreenError error={orders.error} onRetry={orders.reload} />}
          {orders.status === 'success' && orderItems.length === 0 && (
            <p className="pxcu-muted">
              You have no orders yet, so there is nothing to return.{' '}
              <Link to="/orders">Order history</Link>
            </p>
          )}

          {orderItems.length > 0 && (
            <form className="px-form" onSubmit={submit} noValidate>
              {formError && (
                <div className="px-screenstate px-screenstate--error" role="alert">
                  <p className="px-screenstate__msg">{formError.message}</p>
                  {formError.traceId && (
                    <details className="px-screenstate__details">
                      <summary>Technical details</summary>
                      <p>
                        Trace ID: <code className="px-num">{formError.traceId}</code>
                      </p>
                    </details>
                  )}
                </div>
              )}

              <SelectField
                label="Order"
                name="orderId"
                value={orderId}
                options={[
                  { value: '', label: 'Choose an order…' },
                  ...orderItems.map((o) => ({
                    value: o.id,
                    label: `${dateTime(o.placedAt)} · ${o.id} · ${money(o.grandTotalPaise)}`,
                  })),
                ]}
                onValueChange={(v) => {
                  setOrderId(v);
                  setSubOrderId('');
                }}
                required
                error={fieldErrors.orderId}
              />

              {orderId && detail.status === 'loading' && <ScreenLoading label="Loading the order" />}
              {orderId && detail.status === 'error' && (
                <ScreenError error={detail.error} onRetry={detail.reload} />
              )}
              {orderId && detail.status === 'success' && deliveredSubs.length === 0 && (
                <p className="pxcu-note" role="status">
                  No part of this order is delivered yet. Returns open once a seller marks a
                  sub-order DELIVERED.
                </p>
              )}

              {deliveredSubs.length > 0 && (
                <SelectField
                  label="Delivered sub-order (seller)"
                  name="subOrderId"
                  value={subOrderId}
                  options={[
                    { value: '', label: 'Choose a seller…' },
                    ...deliveredSubs.map((s) => ({ value: s.id, label: `${s.vendorName} · ${s.state}` })),
                  ]}
                  onValueChange={setSubOrderId}
                  required
                  error={fieldErrors.subOrderId}
                />
              )}

              <TextField
                label="Listing id"
                name="listingId"
                value={listingId}
                onValueChange={setListingId}
                required
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                hint="Open the product you received and copy the id from the end of its address (/product/<id>). This release does not store which items were in an order, so the server matches your entry against the seller's catalogue."
                serverError={fieldErrors.listingId}
              />

              <TextField
                label="Quantity returning"
                name="qty"
                type="number"
                min={1}
                step={1}
                value={qty}
                onValueChange={setQty}
                required
                serverError={fieldErrors.qty}
              />

              <SelectField
                label="Reason"
                name="reasonCode"
                value={reasonCode}
                options={RMA_REASON_OPTIONS}
                onValueChange={setReasonCode}
                required
                error={fieldErrors.reasonCode}
              />

              <TextAreaField
                label="Anything else we should know?"
                name="reasonText"
                value={reasonText}
                onValueChange={setReasonText}
                rows={3}
                maxLength={1000}
                hint="Optional. Damaged or wrong-item returns may need photo evidence once the seller reviews them."
              />

              <div className="px-form__actions">
                {/* §8.3: enabled always, `loading` only while submitting. */}
                <Button type="submit" variant="primary" loading={submitting}>
                  Request return
                </Button>
                <Button variant="ghost" onClick={resetForm} disabled={submitting}>
                  Clear
                </Button>
              </div>
            </form>
          )}
        </section>

        <section aria-labelledby="ret-list">
          <h2 id="ret-list" style={{ fontSize: 'var(--px-fs-18)', marginBottom: 'var(--px-space-3)' }}>
            Your returns
          </h2>
          {returns.status === 'loading' && <ScreenLoading label="Loading your returns" />}
          {returns.status === 'error' && <ScreenError error={returns.error} onRetry={returns.reload} />}
          {returns.status === 'success' &&
            (returns.data && returns.data.items.length > 0 ? (
              <ul className="pxcu-lines">
                {returns.data.items.map((r) => (
                  <li key={r.id} className="pxcu-line">
                    <div>
                      <strong>{r.listingTitle || r.listingId}</strong>
                      <span className="pxcu-line__meta">
                        Requested {relativeTime(r.requestedAt)} · {r.reasonCode}
                        {r.reasonText && <> · {r.reasonText}</>}
                      </span>
                      <span className="pxcu-line__meta">
                        Order <Link to={`/order/${r.orderId}`}>{r.orderId}</Link> · qty {r.qty}
                      </span>
                      {typeof r.refundPaise === 'number' && (
                        <span className="pxcu-line__meta">
                          Refund {money(r.refundPaise)}
                          {r.refundMethod && <> to {r.refundMethod === 'WALLET' ? 'wallet' : 'original payment method'}</>}
                        </span>
                      )}
                      {r.events.length > 0 && (
                        <ul className="pxcu-timeline" style={{ marginTop: 'var(--px-space-2)' }}>
                          {r.events.map((ev, i) => (
                            <li key={`${r.id}-${i}`}>
                              <span className="pxcu-timeline__at">{dateTime(ev.at)}</span>
                              {ev.toState}
                              {ev.note && <> — {ev.note}</>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="pxcu-line__side">
                      <Badge tone={rmaTone(r.state)}>{r.state}</Badge>
                      <span className="pxcu-muted">{number(r.events.length)} updates</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <ScreenEmpty
                title="No returns"
                description="Returns you request appear here with their review status and refund."
              />
            ))}
        </section>
      </div>
    </div>
  );
}

export function ReturnsScreen() {
  return (
    <RequireCustomer>
      <ReturnsInner />
    </RequireCustomer>
  );
}
