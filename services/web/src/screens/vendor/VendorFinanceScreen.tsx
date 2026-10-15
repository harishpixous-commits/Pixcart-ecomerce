/**
 * Vendor finance (FR-FIN-*): the vendor's slice of the ledger and the monthly
 * settlement summary.
 *
 * Two tabs, one fetch at a time — switching tabs re-keys the single `useAsync`
 * so the previous request is aborted rather than racing the new one. Ledger
 * rows come from `api.vendorLedger` → `{ items: LedgerRow[] }`, settlements
 * from `api.vendorSettlements` → `{ items: SettlementSummary[] }`. Every amount
 * is integer paise formatted with `money()`.
 *
 * There is deliberately NO payout / "request settlement" button: the platform
 * has no payment provider bound (LIMITATIONS §0) and neither the API client nor
 * the BFF exposes a settlement action. A dead or fake button would be worse
 * than the honest note under the settlements table.
 *
 * The ledger's optional `period` filter is not offered here because the typed
 * client's `vendorLedger` call accepts no query parameters; the period column
 * is shown instead so rows can still be read by month.
 */
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { LedgerRow, SettlementSummary } from '@contracts/dto';
import { Badge, DataTable } from '../../design';
import type { BadgeTone, Column } from '../../design';
import { api } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import type { ItemsResponse } from './common';
import './vendor.css';

type FinanceView = 'ledger' | 'settlements';

type FinanceData = { ledger: LedgerRow[] } | { settlements: SettlementSummary[] };

const SETTLEMENT_TONE: Record<string, BadgeTone> = {
  PENDING: 'progress',
  IN_PROGRESS: 'info',
  PAID: 'success',
};

export function VendorFinanceScreen() {
  const [view, setView] = useState<FinanceView>('ledger');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // One request at a time: switching tabs aborts the in-flight one via useAsync.
  const finance = useAsync<FinanceData>(async (signal) => {
    if (view === 'ledger') {
      const res = (await api.vendorLedger(signal)) as ItemsResponse<LedgerRow>;
      return { ledger: res.items };
    }
    const res = (await api.vendorSettlements(signal)) as ItemsResponse<SettlementSummary>;
    return { settlements: res.items };
  }, [view]);

  const selectTab = (next: FinanceView, index: number) => {
    setView(next);
    tabRefs.current[index]?.focus();
  };

  // Two tabs: ArrowRight/ArrowLeft both wrap to the other one.
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    if (index === 0) selectTab('settlements', 1);
    else selectTab('ledger', 0);
  };

  const ledgerColumns: Column<LedgerRow>[] = [
    {
      key: 'when',
      header: 'When',
      sortable: true,
      value: (r) => r.createdAt,
      render: (r) => dateTime(r.createdAt),
    },
    {
      key: 'period',
      header: 'Period',
      value: (r) => r.period,
      render: (r) => <span className="px-num">{r.period}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      value: (r) => r.refType,
      render: (r) => r.refType,
    },
    {
      key: 'ref',
      header: 'Reference',
      secondary: true,
      value: (r) => r.refId,
      render: (r) => <code className="px-num">{r.refId}</code>,
    },
    {
      key: 'memo',
      header: 'Memo',
      secondary: true,
      value: (r) => r.memo ?? '',
      render: (r) => r.memo ?? '—',
    },
    {
      key: 'debit',
      header: 'Debit',
      align: 'end',
      sortable: true,
      value: (r) => r.debitPaise,
      render: (r) => <span className="px-num">{money(r.debitPaise)}</span>,
    },
    {
      key: 'credit',
      header: 'Credit',
      align: 'end',
      sortable: true,
      value: (r) => r.creditPaise,
      render: (r) => <span className="px-num">{money(r.creditPaise)}</span>,
    },
  ];

  const settlementColumns: Column<SettlementSummary>[] = [
    {
      key: 'period',
      header: 'Period',
      sortable: true,
      value: (r) => r.period,
      render: (r) => <span className="px-num">{r.period}</span>,
    },
    {
      key: 'gross',
      header: 'Gross',
      align: 'end',
      sortable: true,
      value: (r) => r.grossPaise,
      render: (r) => <span className="px-num">{money(r.grossPaise)}</span>,
    },
    {
      key: 'commission',
      header: 'Commission',
      align: 'end',
      sortable: true,
      value: (r) => r.commissionPaise,
      render: (r) => <span className="px-num">{money(r.commissionPaise)}</span>,
    },
    {
      key: 'tds',
      header: 'TDS',
      align: 'end',
      secondary: true,
      value: (r) => r.tdsPaise,
      render: (r) => <span className="px-num">{money(r.tdsPaise)}</span>,
    },
    {
      key: 'net',
      header: 'Net',
      align: 'end',
      sortable: true,
      value: (r) => r.netPaise,
      render: (r) => <span className="px-num">{money(r.netPaise)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.status,
      render: (r) => <Badge tone={SETTLEMENT_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>,
    },
    {
      key: 'expected',
      header: 'Expected',
      secondary: true,
      value: (r) => r.expectedAt ?? '',
      render: (r) => (r.expectedAt ? dateTime(r.expectedAt) : '—'),
    },
  ];

  const loading = finance.status === 'loading' && !finance.data;
  const error = finance.status === 'error';
  const isLedger = view === 'ledger';

  return (
    <div className="px-page">
      <PageHeader
        title="Finance"
        description="Your payable ledger and the monthly settlement summary. All amounts are in rupees."
        crumbs={[{ label: 'Vendor', to: '/vendor' }, { label: 'Finance' }]}
      />

      <div className="px-tabs" role="tablist" aria-label="Finance views">
        <button
          ref={(el) => {
            tabRefs.current[0] = el;
          }}
          type="button"
          role="tab"
          id="vendor-finance-tab-ledger"
          aria-selected={isLedger}
          aria-controls="vendor-finance-panel"
          className="px-tabs__tab"
          onClick={() => setView('ledger')}
          onKeyDown={(e) => onTabKeyDown(e, 0)}
        >
          Ledger
        </button>
        <button
          ref={(el) => {
            tabRefs.current[1] = el;
          }}
          type="button"
          role="tab"
          id="vendor-finance-tab-settlements"
          aria-selected={!isLedger}
          aria-controls="vendor-finance-panel"
          className="px-tabs__tab"
          onClick={() => setView('settlements')}
          onKeyDown={(e) => onTabKeyDown(e, 1)}
        >
          Settlements
        </button>
      </div>

      <div
        id="vendor-finance-panel"
        role="tabpanel"
        aria-labelledby={isLedger ? 'vendor-finance-tab-ledger' : 'vendor-finance-tab-settlements'}
      >
        {loading && <ScreenLoading label={isLedger ? 'Loading ledger' : 'Loading settlements'} />}
        {error && <ScreenError error={finance.error} onRetry={finance.reload} />}

        {finance.data &&
          (isLedger ? (
            'ledger' in finance.data ? (
              finance.data.ledger.length === 0 ? (
                <ScreenEmpty
                  title="No ledger entries yet"
                  description="Entries appear here as orders settle against your payable account."
                />
              ) : (
                <DataTable
                  caption="Your payable ledger"
                  columns={ledgerColumns}
                  rows={finance.data.ledger}
                  rowKey={(r) => r.id}
                  denseByDefault
                />
              )
            ) : null
          ) : 'settlements' in finance.data ? (
            finance.data.settlements.length === 0 ? (
              <ScreenEmpty
                title="No settlements yet"
                description="A settlement summary is produced for each month with ledger activity."
              />
            ) : (
              <>
                <DataTable
                  caption="Monthly settlement summaries"
                  columns={settlementColumns}
                  rows={finance.data.settlements}
                  rowKey={(r) => r.period}
                  denseByDefault
                />
                <p className="px-form__aside">
                  Settlement totals are reported from your payable ledger. Requesting or
                  scheduling a payout is not available in this release — no payment provider is
                  bound to the platform yet — so there is no action to take here.
                </p>
              </>
            )
          ) : null)}
      </div>
    </div>
  );
}
