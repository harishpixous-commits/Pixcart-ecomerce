/**
 * Vendor order queue (FR-VEN-007).
 *
 * The list comes from `api.vendorOrders` → `{ items: VendorOrderRow[] }`.
 * The state-advance control offers ONLY the legal successors of the current
 * state: the transition table below is copied verbatim from
 * services/bff/src/repos/vendor.ts (LEGAL_TRANSITIONS), which is what the
 * server enforces — the UI merely mirrors it so illegal options are never
 * offered. A sub-order that can go no further says so instead of showing a
 * dead control.
 *
 * A transition is confirmed in a modal when it cannot be undone — i.e. when
 * there is no legal path from the target state back to the current one
 * (NDR ↔ OUT_FOR_DELIVERY is the only reversible edge pair in the graph, so
 * almost every vendor action is one-way and the confirmation is the norm, not
 * the exception).
 *
 * The write goes through `api.vendorOrderState(id, { state })`; on success the
 * toast repeats what the server answered ({ from, to }), and the list is
 * re-read. On refusal (ILLEGAL_TRANSITION, ownership, missing sub-order) the
 * server's message is shown verbatim under the row.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { SubOrderState, VendorOrderRow } from '@contracts/dto';
import { Badge, Button, DataTable, Modal, SelectField, useToast } from '../../design';
import type { BadgeTone, Column } from '../../design';
import { api } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { describeError, useAsync } from '../lib/useAsync';
import { humanise, type ItemsResponse } from './common';
import './vendor.css';

/**
 * Legal successor edges — verbatim from services/bff/src/repos/vendor.ts
 * (FR-VEN-007 / UML-STM-01), matching V004's state vocabulary. The server
 * refuses anything else with ILLEGAL_TRANSITION; this map only shapes the UI.
 */
const LEGAL_TRANSITIONS: Record<SubOrderState, SubOrderState[]> = {
  CONFIRMED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED'],
  SHIPPED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'NDR'],
  DELIVERED: [],
  NDR: ['RTO_INITIATED', 'OUT_FOR_DELIVERY'],
  RTO_INITIATED: ['RTO_RECEIVED'],
  RTO_RECEIVED: ['CLOSED'],
  RETURN_REQUESTED: ['RETURN_PICKED_UP', 'RETURN_REJECTED'],
  RETURN_PICKED_UP: ['QC'],
  QC: ['REFUNDED', 'RETURN_REJECTED'],
  REFUNDED: ['CLOSED'],
  RETURN_REJECTED: ['CLOSED'],
  CANCELLED: [],
  CLOSED: [],
};

/** All 16 states — V004 ck_sub_order_state. Used for the filter select. */
const SUB_ORDER_STATES = Object.keys(LEGAL_TRANSITIONS) as SubOrderState[];

/** V004 vocabulary for the filter; unknown server values still badge as neutral. */
const STATE_TONE: Record<string, BadgeTone> = {
  CONFIRMED: 'progress',
  ACCEPTED: 'progress',
  PACKED: 'progress',
  SHIPPED: 'info',
  OUT_FOR_DELIVERY: 'info',
  DELIVERED: 'success',
  NDR: 'warning',
  RTO_INITIATED: 'warning',
  RTO_RECEIVED: 'warning',
  RETURN_REQUESTED: 'warning',
  RETURN_PICKED_UP: 'warning',
  QC: 'warning',
  REFUNDED: 'neutral',
  RETURN_REJECTED: 'neutral',
  CANCELLED: 'danger',
  CLOSED: 'neutral',
};

function stateTone(state: string): BadgeTone {
  return STATE_TONE[state] ?? 'neutral';
}

/** Is there any legal path from `to` back to `from`? If not, the move is one-way. */
function canReturn(from: SubOrderState, to: SubOrderState): boolean {
  const seen = new Set<SubOrderState>();
  const queue: SubOrderState[] = [to];
  while (queue.length > 0) {
    const s = queue.shift() as SubOrderState;
    if (s === from) return true;
    if (seen.has(s)) continue;
    seen.add(s);
    queue.push(...(LEGAL_TRANSITIONS[s] ?? []));
  }
  return false;
}

/** What POST /vendor/orders/:id/state answers in the BFF ({ from, to }). */
interface TransitionResult {
  from: SubOrderState;
  to: SubOrderState;
}

/* ------------------------------------------------------------------ *
 * Per-row state advance
 * ------------------------------------------------------------------ */

function StateActions({ row, onDone }: { row: VendorOrderRow; onDone: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = LEGAL_TRANSITIONS[row.state] ?? [];

  if (options.length === 0) {
    return <span className="px-text-muted">No further actions</span>;
  }

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await api.vendorOrderState(row.id, { state: to })) as TransitionResult;
      toast.success(`Sub-order moved ${humanise(res.from)} → ${humanise(res.to)}.`);
      setTo('');
      setConfirmOpen(false);
      onDone();
    } catch (err) {
      // Illegal transition, wrong owner, missing sub-order — the server decides,
      // and its message is shown verbatim. Nothing is applied optimistically.
      const { message } = describeError(err);
      setError(message);
      toast.error(message);
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const onApply = () => {
    if (!to) {
      setError('Choose the state to move to.');
      return;
    }
    if (canReturn(row.state, to as SubOrderState)) void apply();
    else setConfirmOpen(true);
  };

  return (
    <div className="px-row-actions">
      <SelectField
        label={`New state for sub-order ${row.id}`}
        hideLabel
        name={`advance-${row.id}`}
        value={to}
        onValueChange={(v) => {
          setTo(v);
          setError(null);
        }}
        options={[
          { value: '', label: 'Choose a state…' },
          ...options.map((s) => ({ value: s, label: humanise(s) })),
        ]}
      />
      <Button size="sm" variant="primary" loading={busy} onClick={onApply}>
        Apply
      </Button>
      {error && (
        <p className="px-row-actions__error" role="alert">
          {error}
        </p>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`Confirm ${humanise(row.state)} → ${humanise(to)}`}
        description={`This move cannot be undone: there is no legal path from ${humanise(
          to || 'the chosen state',
        )} back to ${humanise(row.state)}.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Go back
            </Button>
            <Button variant="danger" loading={busy} onClick={apply}>
              Confirm and apply
            </Button>
          </>
        }
      >
        <p>
          Sub-order <code className="px-num">{row.id}</code> will move from{' '}
          <strong>{humanise(row.state)}</strong> to <strong>{humanise(to)}</strong>.
        </p>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

export function VendorOrdersScreen() {
  const [params, setParams] = useSearchParams();
  const stateFilter = params.get('state') ?? '';

  const orders = useAsync<ItemsResponse<VendorOrderRow>>(
    async (signal) => (await api.vendorOrders(signal)) as ItemsResponse<VendorOrderRow>,
    [],
  );

  const setStateFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('state', value);
    else next.delete('state');
    setParams(next, { replace: true });
  };

  const rows = (orders.data?.items ?? []).filter((r) => stateFilter === '' || r.state === stateFilter);

  const columns: Column<VendorOrderRow>[] = [
    {
      key: 'suborder',
      header: 'Sub-order',
      value: (r) => r.id,
      render: (r) => <code className="px-num">{r.id}</code>,
    },
    {
      key: 'order',
      header: 'Order',
      secondary: true,
      value: (r) => r.orderId,
      render: (r) => <code className="px-num">{r.orderId}</code>,
    },
    {
      key: 'city',
      header: 'Destination',
      value: (r) => r.customerCity,
      render: (r) => r.customerCity || '—',
    },
    {
      key: 'amount',
      header: 'Your share',
      align: 'end',
      sortable: true,
      value: (r) => r.amountPaise,
      render: (r) => <span className="px-num">{money(r.amountPaise)}</span>,
    },
    {
      key: 'state',
      header: 'State',
      value: (r) => r.state,
      render: (r) => <Badge tone={stateTone(r.state)}>{humanise(r.state)}</Badge>,
    },
    {
      key: 'placed',
      header: 'Placed',
      secondary: true,
      sortable: true,
      value: (r) => r.placedAt,
      render: (r) => dateTime(r.placedAt),
    },
    {
      key: 'sla',
      header: 'Ship by',
      value: (r) => r.slaShipBy,
      render: (r) => (
        <div className="px-row-actions">
          <span className="px-num">{dateTime(r.slaShipBy)}</span>
          {r.breachRisk && <Badge tone="warning">Past ship-by SLA</Badge>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Advance state',
      render: (r) => <StateActions row={r} onDone={orders.reload} />,
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Orders"
        description="Your sub-orders and the state machine that moves them. Only legal transitions are offered, and irreversible moves ask for confirmation."
        crumbs={[{ label: 'Vendor', to: '/vendor' }, { label: 'Orders' }]}
      />

      <form
        className="px-filterbar"
        aria-label="Filter orders"
        onSubmit={(e) => e.preventDefault()}
      >
        <SelectField
          label="State"
          name="order-state"
          value={stateFilter}
          onValueChange={setStateFilter}
          options={[
            { value: '', label: 'All states' },
            ...SUB_ORDER_STATES.map((s) => ({ value: s, label: humanise(s) })),
          ]}
        />
      </form>

      {orders.status === 'loading' && !orders.data && <ScreenLoading label="Loading orders" />}
      {orders.status === 'error' && <ScreenError error={orders.error} onRetry={orders.reload} />}

      {orders.data &&
        (rows.length === 0 ? (
          <ScreenEmpty
            title={stateFilter ? `No sub-orders in ${humanise(stateFilter)}` : 'No sub-orders yet'}
            description={
              stateFilter
                ? 'Orders appear here as soon as a customer buys one of your listings.'
                : 'Sub-orders appear here as soon as a customer buys one of your listings.'
            }
            action={
              stateFilter ? (
                <Button onClick={() => setStateFilter('')}>Show all states</Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            caption="Your sub-orders"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            denseByDefault
          />
        ))}
    </div>
  );
}
