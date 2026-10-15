/**
 * Admin console — platform overview (FR-ADM-001).
 *
 * Data source: GET /api/v1/admin/overview (`api.adminOverview`), whose response
 * shape is `AdminOverview` in contracts/dto.ts and services/bff/src/dto.ts —
 * identical field for field.
 *
 * Two deliberate choices:
 *  - The endpoint also returns a pre-formatted `kpis[]` array whose `valueText`
 *    carries the server's own "Rs.x" formatting. We do NOT render it: money in
 *    this client is integer paise formatted exactly once via `money()`
 *    (CLAUDE.md §6), and the raw `gmvPaise` field is right there. The tiles are
 *    built from the raw fields instead.
 *  - The 14-day `series` is rendered as a real `<table>` (via DataTable, which is
 *    a table by construction), not a decorative SVG — §8.4 requires a data-table
 *    alternative for any chart, and a plain table of values is the honest
 *    minimal form. Every column header names its unit.
 */
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import type { AdminOverview } from '@contracts/dto';
import { DataTable } from '../../design';
import type { Column } from '../../design';
import { api } from '../../lib/api';
import { money, number } from '../../lib/format';
import { PageHeader, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import './admin.css';

type SeriesPoint = AdminOverview['series'][number];

const SERIES_COLUMNS: Column<SeriesPoint>[] = [
  {
    key: 'label',
    header: 'Date',
    sortable: true,
    value: (r) => r.label,
    render: (r) => <span className="px-num">{r.label}</span>,
  },
  {
    key: 'gmv',
    header: 'GMV (₹)',
    align: 'end',
    sortable: true,
    value: (r) => r.gmvPaise,
    render: (r) => <span className="px-num">{money(r.gmvPaise)}</span>,
  },
  {
    key: 'orders',
    header: 'Orders (count)',
    align: 'end',
    sortable: true,
    value: (r) => r.orders,
    render: (r) => <span className="px-num">{number(r.orders)}</span>,
  },
];

/** Trend is never colour-only (§8.4): glyph + word, taken from the payload. */
function TrendGlyph({ trend }: { trend: 'up' | 'down' | 'flat' }) {
  if (trend === 'up') return <ArrowUp size={14} aria-hidden="true" />;
  if (trend === 'down') return <ArrowDown size={14} aria-hidden="true" />;
  return <Minus size={14} aria-hidden="true" />;
}

function Kpi({ label, value, hint, trend }: { label: string; value: string; hint: string; trend?: 'up' | 'down' | 'flat' }) {
  return (
    <div className="px-kpi">
      <span className="px-kpi__label">{label}</span>
      <span className="px-kpi__value px-num">
        {trend && (
          <span className="px-visually-hidden">Trend {trend}. </span>
        )}
        {trend && <TrendGlyph trend={trend} />}
        {value}
      </span>
      <span className="px-kpi__hint">{hint}</span>
    </div>
  );
}

export function AdminOverviewScreen() {
  const { status, data, error, reload } = useAsync<AdminOverview>(
    (signal) => api.adminOverview(signal) as Promise<AdminOverview>,
    [],
  );

  return (
    <div className="px-page">
      <PageHeader
        title="Platform overview"
        description="Live totals from the order, catalogue and fulfilment tables. Money is integer paise on the wire and formatted here."
      />

      {status === 'loading' && <ScreenLoading label="Loading platform overview" />}
      {status === 'error' && <ScreenError error={error} onRetry={reload} />}

      {status === 'success' && data && (
        <>
          <div className="px-kpis">
            <Kpi
              label="GMV (₹)"
              value={money(data.gmvPaise)}
              hint="Gross merchandise value of all non-cancelled orders, lifetime"
              trend={data.kpis.find((k) => k.key === 'gmv')?.trend}
            />
            <Kpi
              label="Orders today (count)"
              value={number(data.ordersToday)}
              hint="Orders placed on the server's current date"
              trend={data.kpis.find((k) => k.key === 'orders')?.trend}
            />
            <Kpi
              label="Pending vendor approvals (count)"
              value={number(data.pendingVendorApprovals)}
              hint="Vendor stores still in PENDING status"
            />
            <Kpi
              label="Pending product approvals (count)"
              value={number(data.pendingProductApprovals)}
              hint="Listings in SUBMITTED state awaiting review"
            />
            <Kpi
              label="Open NDR (count)"
              value={number(data.ndrOpen)}
              hint="Sub-orders in non-delivery-report state"
              trend={data.kpis.find((k) => k.key === 'ndr')?.trend}
            />
            <Kpi
              label="Open risk cases (count)"
              value={number(data.openRiskCases)}
              hint="No risk-case table exists in this schema revision; this is always 0"
            />
          </div>

          <section className="px-panel" aria-labelledby="admin-overview-series">
            <div className="px-panel__head">
              <h2 id="admin-overview-series">Daily GMV and orders — last 14 days</h2>
            </div>
            <p className="px-admin-sub">
              One row per day, straight from the order table. Shown as a table rather than a chart so
              every value is readable and exportable.
            </p>
            <DataTable
              columns={SERIES_COLUMNS}
              rows={data.series}
              rowKey={(r) => r.label}
              caption="Daily gross merchandise value in rupees and order count for the last 14 days"
              emptyMessage="No orders were placed in the last 14 days"
            />
          </section>
        </>
      )}
    </div>
  );
}
