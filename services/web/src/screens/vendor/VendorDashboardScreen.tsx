/**
 * Vendor dashboard (FR-VEN-004).
 *
 * One fetch — `api.vendorDashboard` — and every tile, badge and attention item
 * below is derived from that response. Nothing on this screen is estimated:
 * revenue comes from the vendor's payable ledger, the low-stock count from
 * inv_item against safety_stock, and the approval counts from cat_listing /
 * ven_store state columns (services/bff/src/repos/vendor.ts, getDashboard).
 *
 * The dashboard also returns a 7-day sparkline of ledger credits. It is NOT
 * rendered here: each point carries only a day-of-month label ('%d') with no
 * month, so a chart of those points would be ambiguous — worse than absent.
 */
import { Link } from 'react-router-dom';
import type { VendorDashboard } from '@contracts/dto';
import { Badge, LinkButton } from '../../design';
import type { BadgeTone } from '../../design';
import { api } from '../../lib/api';
import { moneyCompact, number } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import { humanise, kycTone, storeStatusTone } from './common';
import './vendor.css';

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="px-kpi">
      <span className="px-kpi__label">{label}</span>
      <span className="px-kpi__value">{value}</span>
      {hint && <span className="px-kpi__hint">{hint}</span>}
    </div>
  );
}

interface AttentionItem {
  key: string;
  tone: BadgeTone;
  badge: string;
  text: string;
  to: string;
  linkLabel: string;
}

/** Derived purely from the dashboard counts — shown only when its count is non-zero. */
function attentionItems(d: VendorDashboard): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (d.ndrCount > 0) {
    items.push({
      key: 'ndr',
      tone: 'warning',
      badge: 'NDR',
      text: `${number(d.ndrCount)} sub-orders are in NDR and need a delivery decision.`,
      to: '/vendor/orders?state=NDR',
      linkLabel: 'Open the NDR queue',
    });
  }
  if (d.awaitingPickup > 0) {
    items.push({
      key: 'pickup',
      tone: 'progress',
      badge: 'Pickup',
      text: `${number(d.awaitingPickup)} packed sub-orders are awaiting pickup.`,
      to: '/vendor/orders?state=PACKED',
      linkLabel: 'Open packed orders',
    });
  }
  if (d.lowStockCount > 0) {
    items.push({
      key: 'stock',
      tone: 'warning',
      badge: 'Stock',
      text: `${number(d.lowStockCount)} SKUs are at or below their safety stock.`,
      to: '/vendor/inventory',
      linkLabel: 'Review inventory',
    });
  }
  if (d.pendingActionCount > 0) {
    items.push({
      key: 'approval',
      tone: 'info',
      badge: 'Approval',
      text: `${number(d.pendingActionCount)} listings are waiting for admin approval.`,
      to: '/vendor/products?state=SUBMITTED',
      linkLabel: 'View submitted listings',
    });
  }
  if (d.store.status !== 'APPROVED') {
    items.push({
      key: 'store-status',
      tone: storeStatusTone(d.store.status),
      badge: 'Store',
      text: `Store approval status is ${humanise(d.store.status)}.`,
      to: '/vendor/onboarding',
      linkLabel: 'Open store setup',
    });
  }
  if (d.store.kycState !== 'VERIFIED') {
    items.push({
      key: 'kyc',
      tone: kycTone(d.store.kycState),
      badge: 'KYC',
      text: `KYC is ${humanise(d.store.kycState)}.`,
      to: '/vendor/onboarding',
      linkLabel: 'Open store setup',
    });
  }
  return items;
}

export function VendorDashboardScreen() {
  const dash = useAsync<VendorDashboard>(
    async (signal) => (await api.vendorDashboard(signal)) as VendorDashboard,
    [],
  );

  // Keep last-good data visible during a background reload; show the skeleton
  // only when there has never been data.
  if (dash.status === 'loading' && !dash.data) {
    return (
      <div className="px-page">
        <PageHeader title="Vendor dashboard" />
        <ScreenLoading label="Loading dashboard" />
      </div>
    );
  }
  if (dash.status === 'error') {
    return (
      <div className="px-page">
        <PageHeader title="Vendor dashboard" />
        <ScreenError error={dash.error} onRetry={dash.reload} />
      </div>
    );
  }
  if (!dash.data) return null;

  const d = dash.data;
  const attention = attentionItems(d);

  return (
    <div className="px-page">
      <PageHeader
        title="Vendor dashboard"
        description={`${d.store.displayName} · ${d.store.slug}`}
        actions={<LinkButton to="/vendor/onboarding">Store setup</LinkButton>}
      />

      <div className="px-status-row">
        <Badge tone={storeStatusTone(d.store.status)}>Store {humanise(d.store.status)}</Badge>
        <Badge tone={kycTone(d.store.kycState)}>KYC {humanise(d.store.kycState)}</Badge>
      </div>

      <div className="px-kpis">
        <Kpi label="Revenue today" value={moneyCompact(d.revenueTodayPaise)} hint="Ledger credits recorded today" />
        <Kpi label="Revenue this month" value={moneyCompact(d.revenueMonthPaise)} hint="Ledger credits, current month" />
        <Kpi label="Commission this month" value={moneyCompact(d.commissionMonthPaise)} hint="Fees debited this month" />
        <Kpi label="Open orders" value={number(d.openOrders)} hint="Confirmed to out-for-delivery" />
        <Kpi label="Awaiting pickup" value={number(d.awaitingPickup)} hint="Packed sub-orders" />
        <Kpi label="NDR" value={number(d.ndrCount)} hint="Needs a delivery decision" />
        <Kpi label="Low stock" value={number(d.lowStockCount)} hint="SKUs at or below safety stock" />
        <Kpi label="Listings awaiting approval" value={number(d.pendingActionCount)} hint="Submitted to admin review" />
        <Kpi label="Store rating" value={d.ratingAvg.toFixed(1)} hint="Average across all ratings" />
        <Kpi label="On-time shipping" value={`${number(d.onTimePct)}%`} hint="Percentage points" />
      </div>

      <section className="px-panel" aria-labelledby="attention-h">
        <div className="px-panel__head">
          <h2 id="attention-h">Needs your attention</h2>
        </div>
        {attention.length === 0 ? (
          <ScreenEmpty
            title="Nothing needs your attention"
            description="No NDR sub-orders, no low-stock SKUs, no listings awaiting approval, and your store approval and KYC are both complete."
          />
        ) : (
          <ul className="px-attention">
            {attention.map((item) => (
              <li key={item.key}>
                <Badge tone={item.tone}>{item.badge}</Badge>
                <span className="px-attention__text">{item.text}</span>
                <Link to={item.to}>{item.linkLabel}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
