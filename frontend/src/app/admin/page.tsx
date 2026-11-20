"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DailyBars, Delta, HBar } from "@/components/charts";
import { usePolling } from "@/components/delivery/trip";
import { PageHeader, Stat } from "@/components/portal-shell";
import { AiBadge, type AiRun } from "@/components/ai";
import { Button, ErrorNote, PageLoader, Select } from "@/components/ui";
import { useAdmin, useCan } from "@/lib/admin";
import { api, ApiError, quietly } from "@/lib/api";
import type { DeliveryOverview } from "@/lib/delivery-types";
import { hoursLabel, rupees } from "@/lib/format";

type D = { sellers_pending_review: number; products_pending_review: number; orders_today: number; gmv_30d: number; orders_30d: number; commission_30d: number; refunds_needing_attention: number; active_sellers: number; customers: number; live_products: number };
type K = {
  gmv: number; gmv_prev: number; orders: number; orders_prev: number; aov: number; units: number; commission: number; discounts: number;
  cancellation_rate: number; return_rate: number; returned_value: number; avg_hours_to_ship: number | null; views: number; add_to_cart: number;
  conversion_rate: number; cart_rate: number; series: { date: string; orders: number; gmv: number }[];
  top_products: { product_id: string; title: string; units: number; revenue: number }[];
  top_sellers?: { name: string; gmv: number; packages: number }[];
  top_categories?: { name: string; gmv: number }[];
  payment_mix?: Record<string, number>;
  new_customers?: number; buyers?: number; repeat_buyer_rate?: number; tickets_ack_overdue?: number;
};

type Setup = { done: number; total: number; items: { key: string; label: string; done: boolean; href: string }[] };

function SetupChecklist() {
  const [d, setD] = useState<Setup | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api<Setup>("/api/admin/setup-status").then(setD).catch(() => {});
  }, []);
  if (!d || d.done === d.total) return null;
  const todo = d.items.filter((i) => !i.done);
  return (
    <section className="rounded-xl border border-marigold bg-marigold-light p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold">Before you go live: {d.done} of {d.total} done</p>
          <p className="text-sm text-ink-soft">Legal details, policies and payments the shop still needs.</p>
        </div>
        <button className="text-sm font-semibold text-peacock" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide" : `Show ${todo.length} to do`}</button>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-leaf" style={{ width: `${(d.done / d.total) * 100}%` }} /></div>
      {open && (
        <ul className="mt-3 flex flex-col gap-1">
          {todo.map((i) => <li key={i.key}><Link href={i.href} className="text-peacock hover:underline">{i.label}</Link></li>)}
        </ul>
      )}
    </section>
  );
}

function BusinessBrief({ days }: { days: number }) {
  const me = useAdmin();
  const [run, setRun] = useState<AiRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me?.permissions.includes("dashboard")) return null;
  async function write() {
    setBusy(true);
    setError(null);
    try {
      setRun(await api<AiRun>("/api/admin/ai/tasks/business_brief", { method: "POST", body: { subject_id: String(days) } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not write the brief");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Business brief</h2>
        {run && <AiBadge mode={run.mode} />}
        <Button size="sm" variant="secondary" className="ml-auto" onClick={write} loading={busy}><Sparkles className="h-4 w-4" /> {run ? "Write again" : `Summarise the last ${days} days`}</Button>
      </div>
      <ErrorNote message={error} />
      {run ? <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed">{run.output.text}</p> : <p className="mt-1 text-sm text-ink-soft">A plain-language summary of the numbers below, with suggested next steps. Written from these figures only.</p>}
    </section>
  );
}

/** The own delivery fleet at a glance, live: partners online now, packages waiting, trips moving, stuck trips. */
function FleetGlance() {
  const can = useCan("delivery");
  const [o, setO] = useState<DeliveryOverview | null>(null);
  const load = useCallback(() => {
    api<DeliveryOverview>("/api/admin/delivery/overview").then(setO).catch(() => {});
  }, []);
  usePolling(load, 30_000, can);
  if (!can || !o || !o.enabled || o.fleet_mode === "off") return null;
  const tiles = [
    { label: "Partners online now", value: o.online, href: "/admin/delivery/live", tone: "text-leaf" },
    { label: "Waiting for a partner", value: o.queue, href: "/admin/delivery/queue", tone: o.queue ? "text-[#8A5A00]" : "text-ink" },
    { label: "On a trip", value: o.on_trip, href: "/admin/delivery/trips?status=active", tone: "text-peacock" },
    { label: "Stuck trips", value: o.stuck, href: "/admin/delivery/live", tone: o.stuck ? "text-vermilion" : "text-ink" },
    { label: "Delivered today", value: o.delivered_today, href: "/admin/delivery/trips?status=delivered", tone: "text-ink" },
  ];
  return (
    <section className="rounded-xl bg-white p-4" data-testid="fleet-glance">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className="relative flex h-2.5 w-2.5">{o.online > 0 && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-leaf/60 motion-reduce:animate-none" />}<span className={o.online > 0 ? "relative inline-flex h-2.5 w-2.5 rounded-full bg-leaf" : "relative inline-flex h-2.5 w-2.5 rounded-full bg-line"} /></span>
          Delivery fleet, live
        </h2>
        <Link href="/admin/delivery/live" className="text-sm font-semibold text-peacock">See who is online</Link>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className="rounded-lg bg-mist px-3 py-2 hover:ring-2 hover:ring-peacock/20">
            <p className={`font-display text-2xl font-bold ${t.tone}`}>{t.value}</p>
            <p className="text-xs text-ink-soft">{t.label}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default function AdminHome() {
  const [d, setD] = useState<D | null>(null);
  // analytics for the chosen period; while another period loads, the loader shows instead of old numbers
  const [kv, setKv] = useState<{ days: number; data: K } | null>(null);
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"gmv" | "orders">("gmv");
  useEffect(() => {
    api<D>("/api/admin/dashboard").then(setD).catch(() => {});
  }, []);
  useEffect(() => {
    api<K>("/api/admin/analytics", { query: { days } }).then((data) => setKv({ days, data })).catch(quietly);
  }, [days]);
  const k = kv && kv.days === days ? kv.data : null;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Overview" actions={
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto" aria-label="Period">
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 12 months</option>
        </Select>
      } />
      <SetupChecklist />
      <FleetGlance />
      <BusinessBrief days={days} />
      {d && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Sellers waiting for verification" value={d.sellers_pending_review} href="/admin/sellers?status=submitted" />
          <Stat label="Listings waiting for review" value={d.products_pending_review} href="/admin/products" />
          <Stat label="Refunds that failed" value={d.refunds_needing_attention} href="/admin/refunds?status=failed" />
          {k?.tickets_ack_overdue !== undefined ? <Stat label="Tickets past the 48-hour reply limit" value={k.tickets_ack_overdue} href="/admin/support?overdue=1" /> : <Stat label="Orders today" value={d.orders_today} href="/admin/orders" />}
        </div>
      )}
      {!k ? <PageLoader /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-xl bg-white p-4"><p className="text-sm text-ink-soft">Sales (GMV)</p><p className="font-display text-3xl font-bold">{rupees(k.gmv)}</p><Delta now={k.gmv} before={k.gmv_prev} /></div>
            <div className="rounded-xl bg-white p-4"><p className="text-sm text-ink-soft">Orders</p><p className="font-display text-3xl font-bold">{k.orders.toLocaleString("en-IN")}</p><Delta now={k.orders} before={k.orders_prev} /></div>
            <Stat label="Commission earned" value={rupees(k.commission)} hint={`Coupons cost ${rupees(k.discounts)}`} />
            <Stat label="Average order value" value={rupees(k.aov)} hint={`${k.units.toLocaleString("en-IN")} units sold`} />
            <Stat label="Views that became orders" value={`${k.conversion_rate}%`} hint={`${k.views.toLocaleString("en-IN")} product views, ${k.cart_rate}% added to cart`} />
            <Stat label="Cancelled packages" value={`${k.cancellation_rate}%`} />
            <Stat label="Returned after delivery" value={`${k.return_rate}%`} hint={`${rupees(k.returned_value)} refunded`} />
            <Stat label="Average time to ship" value={hoursLabel(k.avg_hours_to_ship)} />
            {k.new_customers !== undefined && <Stat label="New customers" value={k.new_customers} hint={k.repeat_buyer_rate !== undefined ? `${k.repeat_buyer_rate}% of ${k.buyers} buyers ordered more than once` : undefined} />}
            {k.payment_mix && <Stat label="Paid online" value={`${Math.round(((k.payment_mix.online ?? 0) * 100) / Math.max(1, (k.payment_mix.online ?? 0) + (k.payment_mix.cod ?? 0)))}%`} hint={`${k.payment_mix.cod ?? 0} cash-on-delivery orders`} />}
            {d && <Stat label="Active sellers" value={d.active_sellers} hint={`${d.live_products} live listings`} />}
          </div>
          <section className="rounded-xl bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Daily {metric === "gmv" ? "sales" : "orders"}</h2>
              <div className="flex rounded-lg bg-mist p-1 text-sm">
                {(["gmv", "orders"] as const).map((m) => (
                  <button key={m} onClick={() => setMetric(m)} className={metric === m ? "rounded-md bg-white px-3 py-1 font-semibold text-peacock shadow-sm" : "px-3 py-1 text-ink-soft"}>{m === "gmv" ? "Sales" : "Orders"}</button>
                ))}
              </div>
            </div>
            <DailyBars series={k.series} valueKey={metric} money={metric === "gmv"} height={200} />
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl bg-white p-4">
              <h2 className="mb-3 text-lg font-semibold">Top products</h2>
              {k.top_products.length ? <HBar items={k.top_products.map((p) => ({ label: p.title, value: p.revenue, display: `${rupees(p.revenue)} · ${p.units} sold` }))} /> : <p className="text-ink-faint">No sales in this period.</p>}
            </section>
            {k.top_sellers && (
              <section className="rounded-xl bg-white p-4">
                <h2 className="mb-3 text-lg font-semibold">Top sellers</h2>
                {k.top_sellers.length ? <HBar items={k.top_sellers.map((s) => ({ label: s.name, value: s.gmv, display: `${rupees(s.gmv)} · ${s.packages} packages` }))} /> : <p className="text-ink-faint">No sales in this period.</p>}
              </section>
            )}
            {k.top_categories && (
              <section className="rounded-xl bg-white p-4">
                <h2 className="mb-3 text-lg font-semibold">Sales by category</h2>
                {k.top_categories.length ? <HBar items={k.top_categories.map((c) => ({ label: c.name, value: c.gmv, display: rupees(c.gmv) }))} /> : <p className="text-ink-faint">No sales in this period.</p>}
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
