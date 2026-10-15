/**
 * Vendor inventory (FR-VEN-008).
 *
 * One fetch — `api.vendorInventory` → `{ items: InventoryRow[] }` — rendered in a
 * DataTable with a per-row stock editor. The editor changes ON-HAND only:
 * `reserved` is held by the platform for carts and orders, and the BFF's
 * inventory write path only ever adjusts on-hand
 * (services/bff/src/repos/vendor.ts, adjustInventory), so offering an edit for
 * reserved would be a lie.
 *
 * Every save calls `api.patchInventory(sku, { onHand })` and then RE-READS the
 * server (`reload`). There is no optimistic update: if the server refuses —
 * e.g. the change would take on-hand below reserved — its message is shown
 * verbatim under the row (role="alert") and the table keeps the server's truth.
 *
 * Bulk edit is out of scope for this release and is stated on the screen rather
 * than faked with a disabled button.
 */
import { useState } from 'react';
import type { InventoryRow } from '@contracts/dto';
import { Badge, Button, DataTable, useToast } from '../../design';
import type { Column } from '../../design';
import { api } from '../../lib/api';
import { number } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { describeError, useAsync } from '../lib/useAsync';
import type { ItemsResponse } from './common';
import './vendor.css';

/**
 * Per-row editor. Mounts once per row and keeps its own draft; after a save the
 * parent reloads the list, and this component simply stays mounted with the
 * value the server confirmed.
 */
function StockEditor({ row, onSaved }: { row: InventoryRow; onSaved: () => void }) {
  const toast = useToast();
  const [onHand, setOnHand] = useState(String(row.onHand));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = /^\d+$/.test(onHand.trim()) ? Number(onHand.trim()) : null;
  const draftAvailable = parsed === null ? null : parsed - row.reserved;

  const save = async () => {
    if (saving) return;
    if (parsed === null) {
      setError('Enter a whole number of units.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.patchInventory(row.variantSku, { onHand: parsed });
      toast.success(`${row.variantSku}: on-hand is now ${number(parsed)}.`);
      onSaved();
    } catch (err) {
      // The server owns the constraint (never below reserved, never negative):
      // show its message verbatim, and keep the draft so the user can correct it.
      const { message } = describeError(err);
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="px-inv-edit">
        <label className="px-visually-hidden" htmlFor={`onhand-${row.variantSku}`}>
          On-hand for {row.variantSku} at {row.locationName}
        </label>
        <input
          id={`onhand-${row.variantSku}`}
          className="px-input px-inv-edit__input px-num"
          inputMode="numeric"
          value={onHand}
          onChange={(e) => setOnHand(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
        <Button size="sm" variant="primary" loading={saving} onClick={save}>
          Save
        </Button>
        {draftAvailable !== null && (
          <p className="px-inv-edit__hint">
            Available after save: {number(draftAvailable)}
            {draftAvailable <= row.safetyStock ? ' (at or below safety stock)' : ''}
          </p>
        )}
      </div>
      {error && (
        <p className="px-row-actions__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function VendorInventoryScreen() {
  const inv = useAsync<ItemsResponse<InventoryRow>>(
    async (signal) => (await api.vendorInventory(signal)) as ItemsResponse<InventoryRow>,
    [],
  );

  const columns: Column<InventoryRow>[] = [
    {
      key: 'sku',
      header: 'SKU',
      sortable: true,
      value: (r) => r.variantSku,
      render: (r) => <code className="px-num">{r.variantSku}</code>,
    },
    {
      key: 'title',
      header: 'Listing',
      sortable: true,
      value: (r) => r.listingTitle,
      render: (r) => r.listingTitle,
    },
    {
      key: 'location',
      header: 'Location',
      secondary: true,
      value: (r) => r.locationName,
      render: (r) => r.locationName,
    },
    {
      key: 'onhand',
      header: 'On-hand (edit)',
      render: (r) => <StockEditor row={r} onSaved={inv.reload} />,
    },
    {
      key: 'reserved',
      header: 'Reserved',
      align: 'end',
      value: (r) => r.reserved,
      render: (r) => <span className="px-num">{number(r.reserved)}</span>,
    },
    {
      key: 'available',
      header: 'Available',
      align: 'end',
      value: (r) => r.available,
      render: (r) => <span className="px-num">{number(r.available)}</span>,
    },
    {
      key: 'safety',
      header: 'Safety stock',
      align: 'end',
      secondary: true,
      value: (r) => r.safetyStock,
      render: (r) => <span className="px-num">{number(r.safetyStock)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => (r.belowSafety ? 'Below safety stock' : 'OK'),
      render: (r) =>
        r.belowSafety ? (
          <Badge tone="warning">At or below safety</Badge>
        ) : (
          <Badge tone="success">OK</Badge>
        ),
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="Inventory"
        description="Adjust on-hand stock per SKU and location. Reserved units are held by the platform for carts and orders and cannot be edited here; the server refuses any change that would take on-hand below reserved. Bulk editing is not available in this release."
        crumbs={[{ label: 'Vendor', to: '/vendor' }, { label: 'Inventory' }]}
      />

      {inv.status === 'loading' && !inv.data && <ScreenLoading label="Loading inventory" />}
      {inv.status === 'error' && <ScreenError error={inv.error} onRetry={inv.reload} />}

      {inv.data &&
        (inv.data.items.length === 0 ? (
          <ScreenEmpty
            title="No inventory yet"
            description="Stock rows appear here once your listings have variants with inventory records."
          />
        ) : (
          <DataTable
            caption="Your inventory by SKU and location"
            columns={columns}
            rows={inv.data.items}
            rowKey={(r) => `${r.variantSku}|${r.locationName}`}
            denseByDefault
          />
        ))}
    </div>
  );
}
