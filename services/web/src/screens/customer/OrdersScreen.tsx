/**
 * SCR-013 — Order history (FR-CUS-016).
 *
 * Keyset pagination exactly as the BFF serves it: each "Load more" asks for the
 * page after the last cursor and appends de-duplicated by order id. There are
 * no page numbers anywhere in this release (Vol. 7 §7.3).
 *
 * Cancellation is offered only while the order status is CONFIRMED, which is
 * the only state the BFF's `cancelOrder` will accept — a later refusal (the
 * seller already accepted) is surfaced as the server's own message with its
 * trace id, not swallowed.
 *
 * `itemCount` is not shown: the schema has no order-line table, so the BFF
 * reports 0 by construction (disclosed in services/bff/src/repos/commerce.ts).
 * Printing a number the server admits it cannot know would be a fabrication.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OrderSummary } from '@contracts/dto';
import { Badge, Button, LinkButton, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { money, dateTime, number } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { RequireCustomer } from './RequireCustomer';
import { orderTone } from './status';
import './customer.css';

interface OrdersPage {
  items: OrderSummary[];
  nextCursor: string | null;
}

function OrdersInner() {
  const toast = useToast();
  const [cursor, setCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<OrderSummary[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const page = useAsync<OrdersPage>(
    async (signal) => (await api.orders(cursor, signal)) as OrdersPage,
    [cursor],
  );

  // useAsync replaces `data` per cursor; accumulate across cursors here.
  useEffect(() => {
    if (page.status !== 'success' || !page.data) return;
    const items = page.data.items;
    setRows((prev) =>
      cursor === null ? items : [...prev, ...items.filter((o) => !prev.some((x) => x.id === o.id))],
    );
  }, [page.status, page.data, cursor]);

  async function cancel(id: string): Promise<void> {
    if (cancelling) return;
    setCancelling(id);
    try {
      await api.cancelOrder(id);
      toast.success('Order cancelled');
      setRows([]);
      setCursor(null);
      page.reload();
    } catch (err) {
      if (err instanceof ApiProblem) {
        toast.error(err.problem.detail || err.problem.title);
      } else {
        toast.error('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setCancelling(null);
    }
  }

  if (page.status === 'loading' && rows.length === 0) {
    return <ScreenLoading label="Loading your orders" />;
  }
  if (page.status === 'error' && rows.length === 0) {
    return <ScreenError error={page.error} onRetry={page.reload} />;
  }

  return (
    <div>
      <PageHeader
        title="Your orders"
        description="Every order you have placed, newest first."
        actions={<LinkButton to="/returns">Returns</LinkButton>}
      />

      {rows.length === 0 ? (
        <ScreenEmpty
          title="No orders yet"
          description="Orders you place appear here with their delivery status."
          action={<LinkButton to="/" variant="primary">Start shopping</LinkButton>}
        />
      ) : (
        <>
          <ul className="pxcu-lines">
            {rows.map((o) => (
              <li key={o.id} className="pxcu-line">
                <div>
                  <Link className="pxcu-line__title" to={`/order/${o.id}`}>
                    Order {o.id}
                  </Link>
                  <span className="pxcu-line__meta">
                    {dateTime(o.placedAt)}
                    {o.vendorNames.length > 0 && <> · {o.vendorNames.join(', ')}</>}
                    {o.etaText && <> · {o.etaText}</>}
                  </span>
                  {o.thumbnailUrl && (
                    <img
                      src={o.thumbnailUrl}
                      alt=""
                      width={48}
                      height={48}
                      style={{ borderRadius: 'var(--px-radius-card)', marginTop: 'var(--px-space-2)' }}
                    />
                  )}
                </div>
                <div className="pxcu-line__side">
                  <Badge tone={orderTone(o.status)}>{o.status}</Badge>
                  <span className="px-num" style={{ fontWeight: 'var(--px-fw-bold)' }}>
                    {money(o.grandTotalPaise)}
                  </span>
                  <span className="pxcu-muted">{number(o.vendorNames.length)} seller{s(o.vendorNames.length)}</span>
                  {o.status === 'CONFIRMED' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={cancelling === o.id}
                      onClick={() => cancel(o.id)}
                    >
                      Cancel order
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {page.status === 'error' && <ScreenError error={page.error} onRetry={page.reload} />}
          {page.status !== 'error' && page.data?.nextCursor && (
            <div className="pxcu-row" style={{ marginTop: 'var(--px-space-6)' }}>
              <Button
                variant="secondary"
                loading={page.status === 'loading'}
                onClick={() => setCursor(page.data?.nextCursor ?? null)}
              >
                Load more
              </Button>
              <span className="pxcu-muted">Showing {number(rows.length)} orders</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** "1 seller" / "2 sellers" without a pluralisation library. */
function s(n: number): string {
  return n === 1 ? '' : 's';
}

export function OrdersScreen() {
  return (
    <RequireCustomer>
      <OrdersInner />
    </RequireCustomer>
  );
}
