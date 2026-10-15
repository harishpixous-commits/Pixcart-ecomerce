/**
 * Admin notifications — truthful empty state.
 *
 * This release has NO outbound notification endpoint for administrators.
 * Verified against the full BFF route table (services/bff/src/routes/*.ts,
 * registered by routes/index.ts): the admin surface (routes/admin.ts) exposes
 * overview, approvals, categories, coupons, CMS, finance, staff and audit —
 * nothing for composing or broadcasting messages. The web API client
 * (services/web/src/lib/api.ts) likewise has no `adminNotifications` call.
 *
 * The only notification surface in the product is the CUSTOMER's own feed
 * (/api/v1/account/notifications), which customers read for their own orders;
 * those messages are emitted by the platform, not composed by staff here.
 *
 * Per the brief: a truthful empty state beats a fake compose box. Nothing on
 * this screen fetches, and nothing on it claims a capability the server does
 * not have. When an admin messaging endpoint is added, replace this screen
 * with a real useAsync-backed list/compose surface.
 */
import { PageHeader, ScreenEmpty } from '../lib/Screen';
import './admin.css';

export function AdminNotificationsScreen() {
  return (
    <div className="px-page">
      <PageHeader
        title="Notifications"
        description="Outbound messaging for the platform."
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'Notifications' }]}
      />

      <ScreenEmpty
        title="Outbound notification composition is not part of this release"
        description="The server exposes no admin endpoint for composing or broadcasting notifications — the admin API covers overview, approvals, catalogue, orders, marketing, finance, staff, CMS and the audit log, and nothing else. Customer notifications (order, payment, return events) are emitted by the platform into each customer's own feed; staff do not compose them here. This screen will gain a real interface when the server gains the endpoint — it will not pretend one exists."
      />
    </div>
  );
}
