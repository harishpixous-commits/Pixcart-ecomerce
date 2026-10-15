/**
 * Finance overview (FR-FIN-*).
 *
 * Data: `api.adminFinance` → GET /api/v1/admin/finance/overview →
 * FinanceOverview (routes/admin.ts → repos/admin.ts getFinanceOverview()).
 * Every amount is integer paise, formatted once with `money()`.
 *
 * Payout execution is deliberately absent: no payment provider is bound in
 * this release (docs/LIMITATIONS.md), so there is no endpoint that can move
 * money and therefore no "Pay out" control — not even a disabled one. The
 * pending-payout figure is shown as state, with a plain note that it cannot
 * be actioned from this console.
 */
import type { FinanceOverview } from '@contracts/dto';
import { Badge, DataTable } from '../../design';
import type { Column } from '../../design';
import { api } from '../../lib/api';
import { money, number } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import './admin.css';

interface PeriodRow {
  period: string;
  gmvPaise: number;
  commissionPaise: number;
  closed: boolean;
}

export function AdminFinanceScreen() {
  const finance = useAsync<FinanceOverview>(
    (signal) => api.adminFinance(signal) as Promise<FinanceOverview>,
    [],
  );

  const data = finance.data;

  const periodColumns: Column<PeriodRow>[] = [
    {
      key: 'period',
      header: 'Period',
      value: (r) => r.period,
      render: (r) => <code className="px-num">{r.period}</code>,
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
      key: 'commission',
      header: 'Commission (₹)',
      align: 'end',
      sortable: true,
      value: (r) => r.commissionPaise,
      render: (r) => <span className="px-num">{money(r.commissionPaise)}</span>,
    },
    {
      key: 'closed',
      header: 'Period state',
      value: (r) => (r.closed ? 'Closed' : 'Open'),
      render: (r) => (
        <Badge tone={r.closed ? 'success' : 'progress'}>{r.closed ? 'Closed' : 'Open'}</Badge>
      ),
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Finance"
        description="Platform money totals from the ledger. All amounts are integer paise on the wire, shown here in rupees."
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'Finance' }]}
      />

      {finance.status === 'loading' && !data && <ScreenLoading label="Loading finance overview" />}
      {finance.status === 'error' && <ScreenError error={finance.error} onRetry={finance.reload} />}

      {data && (
        <>
          <div className="px-kpis">
            <div className="px-kpi">
              <span className="px-kpi__label">GMV (₹)</span>
              <span className="px-kpi__value">{money(data.gmvPaise)}</span>
              <span className="px-kpi__hint">non-cancelled orders, lifetime</span>
            </div>
            <div className="px-kpi">
              <span className="px-kpi__label">Commission (₹)</span>
              <span className="px-kpi__value">{money(data.commissionPaise)}</span>
              <span className="px-kpi__hint">sum of FEE ledger credits</span>
            </div>
            <div className="px-kpi">
              <span className="px-kpi__label">Refunds (₹)</span>
              <span className="px-kpi__value">{money(data.refundsPaise)}</span>
              <span className="px-kpi__hint">refunded returns</span>
            </div>
            <div className="px-kpi">
              <span className="px-kpi__label">Tax collected (₹)</span>
              <span className="px-kpi__value">{money(data.taxCollectedPaise)}</span>
              <span className="px-kpi__hint">TAX_PAYABLE ledger credits</span>
            </div>
            <div className="px-kpi">
              <span className="px-kpi__label">Pending payouts (₹)</span>
              <span className="px-kpi__value">{money(data.pendingPayoutsPaise)}</span>
              <span className="px-kpi__hint">vendor payable, not yet settled</span>
            </div>
            <div className="px-kpi">
              <span className="px-kpi__label">Unsettled vendors (count)</span>
              <span className="px-kpi__value">{number(data.unsettledVendors)}</span>
              <span className="px-kpi__hint">accounts with sub-order credits and no payout</span>
            </div>
            <div className="px-kpi">
              <span className="px-kpi__label">Reconciliation breaks (count)</span>
              <span className="px-kpi__value">{number(data.reconBreaks)}</span>
              <span className="px-kpi__hint">owned by the nightly journal-balance check</span>
            </div>
          </div>

          <div className="px-note" role="note">
            <p>
              <strong>Payouts cannot be actioned from this console.</strong> No payment provider is
              bound in this release, so no endpoint can move money. The pending-payout figure above
              is the ledger state only; settlement runs outside this interface.
            </p>
          </div>

          <section className="px-panel" aria-labelledby="fin-periods-h">
            <div className="px-panel__head">
              <h2 id="fin-periods-h">Ledger periods</h2>
              <span className="px-text-muted">Most recent periods as returned by the server</span>
            </div>
            {data.periods.length === 0 ? (
              <ScreenEmpty
                title="No ledger periods yet"
                description="The server returned an empty period breakdown: no ledger entry exists."
              />
            ) : (
              <DataTable
                caption="Ledger periods with GMV and commission"
                columns={periodColumns}
                rows={data.periods}
                rowKey={(r) => r.period}
                denseByDefault
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
