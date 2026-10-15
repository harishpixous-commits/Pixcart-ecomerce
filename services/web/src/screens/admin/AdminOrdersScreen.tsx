/**
 * Platform-wide order list (admin console).
 *
 * Data: `api.adminOrders` → GET /api/v1/admin/orders. NOTE: the BFF in this
 * repository does not yet register that route (routes/admin.ts has no admin
 * orders endpoint), so against this BFF the screen renders the server's error
 * verbatim — it does not fall back to mock rows. The row type is the
 * canonical OrderSummary from contracts/dto.ts, the same wire shape the
 * customer order list uses (routes/cart.ts GET /orders → Page<OrderSummary>).
 *
 * Search and status filters live in the URL (?q=&status=) so a filtered view
 * is shareable and survives reload. Filtering happens client-side over the
 * loaded rows because the endpoint takes no query parameters.
 *
 * Every row links to the customer order-detail route (/order/:id), which
 * exists in App.tsx; status renders as a Badge (glyph + text, §8.4), never
 * colour alone.
 */
import { Link, useSearchParams } from 'react-router-dom';
import type { OrderSummary } from '@contracts/dto';
import { Badge, Button, DataTable, SelectField, TextField } from '../../design';
import type { BadgeTone, Column } from '../../design';
import { api } from '../../lib/api';
import { dateTime, money, number } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import { humanise, type ItemsResponse } from './common';
import './admin.css';

/**
 * Tone map: only the vocabulary evidenced in the BFF (repos/commerce.ts sets
 * ord_order.status = 'CANCELLED' on cancel). Any other status the server may
 * return still badges as neutral — glyph + text, never colour-only.
 */
const ORDER_STATUS_TONE: Record<string, BadgeTone> = {
  CANCELLED: 'danger',
};

function orderStatusTone(status: string): BadgeTone {
  return ORDER_STATUS_TONE[status] ?? 'neutral';
}

export function AdminOrdersScreen() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const statusFilter = params.get('status') ?? '';

  const orders = useAsync<ItemsResponse<OrderSummary>>(
    async (signal) => (await api.adminOrders(signal)) as ItemsResponse<OrderSummary>,
    [],
  );

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const allRows = orders.data?.items ?? [];

  // Status options come from the loaded data, not from a hard-coded list.
  const statusOptions = [...new Set(allRows.map((r) => r.status))].sort();

  const needle = q.trim().toLowerCase();
  const rows = allRows.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (!needle) return true;
    return (
      r.id.toLowerCase().includes(needle) ||
      r.vendorNames.some((v) => v.toLowerCase().includes(needle))
    );
  });

  const columns: Column<OrderSummary>[] = [
    {
      key: 'order',
      header: 'Order',
      value: (r) => r.id,
      render: (r) => (
        // Route exists in App.tsx: /order/:id (customer order detail).
        <Link to={`/order/${r.id}`}>
          <code className="px-num">{r.id}</code>
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.status,
      render: (r) => <Badge tone={orderStatusTone(r.status)}>{humanise(r.status)}</Badge>,
    },
    {
      key: 'total',
      header: 'Grand total (₹)',
      align: 'end',
      sortable: true,
      value: (r) => r.grandTotalPaise,
      render: (r) => <span className="px-num">{money(r.grandTotalPaise)}</span>,
    },
    {
      key: 'items',
      header: 'Items (count)',
      align: 'end',
      sortable: true,
      value: (r) => r.itemCount,
      render: (r) => <span className="px-num">{number(r.itemCount)}</span>,
    },
    {
      key: 'vendors',
      header: 'Vendors',
      secondary: true,
      value: (r) => r.vendorNames.join(', '),
      render: (r) => (r.vendorNames.length > 0 ? r.vendorNames.join(', ') : '—'),
    },
    {
      key: 'placed',
      header: 'Placed',
      sortable: true,
      value: (r) => r.placedAt,
      render: (r) => <span className="px-num">{dateTime(r.placedAt)}</span>,
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Orders"
        description="All platform orders as the server returned them. Search and status filters are kept in the address bar; each row opens the order detail."
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'Orders' }]}
      />

      <form
        className="px-filterbar"
        aria-label="Filter orders"
        onSubmit={(e) => e.preventDefault()}
      >
        <TextField
          label="Search order id or vendor"
          name="order-q"
          type="search"
          value={q}
          onValueChange={(v) => setParam('q', v)}
        />
        <SelectField
          label="Status"
          name="order-status"
          value={statusFilter}
          onValueChange={(v) => setParam('status', v)}
          options={[
            { value: '', label: 'All statuses' },
            ...statusOptions.map((s) => ({ value: s, label: humanise(s) })),
          ]}
        />
      </form>

      {orders.status === 'loading' && !orders.data && <ScreenLoading label="Loading orders" />}
      {orders.status === 'error' && <ScreenError error={orders.error} onRetry={orders.reload} />}

      {orders.data &&
        (rows.length === 0 ? (
          <ScreenEmpty
            title={
              needle || statusFilter
                ? 'No orders match the current filters'
                : 'No orders yet'
            }
            description={
              needle || statusFilter
                ? 'The server returned orders, but none match the search text and status selected above.'
                : 'The server returned an empty order list.'
            }
            action={
              needle || statusFilter ? (
                <Button variant="secondary" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            caption="Platform orders"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            denseByDefault
          />
        ))}
    </div>
  );
}
