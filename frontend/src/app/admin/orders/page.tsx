"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ExportButton } from "@/components/export-button";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { EmptyState, Input, PageLoader, Pagination, Select, StatusPill } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { dateTime, PAYMENT_STATUS_LABEL, rupees } from "@/lib/format";
import type { Paged } from "@/lib/types";

type Row = { id: string; number: string; customer: string; phone: string; status: string; payment_method: string; payment_status: string; grand_total: number; created_at: string; package_statuses: string[]; staff_tags?: string[] };
type Filters = { status: string; q: string; payment_method: string; payment_status: string; package_status: string; date_from: string; date_to: string; seller_id: string; customer_id: string; late: string; tag: string };
const KEYS: (keyof Filters)[] = ["status", "q", "payment_method", "payment_status", "package_status", "date_from", "date_to", "seller_id", "customer_id", "late", "tag"];

function Orders() {
  const sp = useSearchParams();
  const router = useRouter();
  // Filters live in the address bar, so links like /admin/orders?q=PC… or ?seller_id=… open filtered.
  const f = Object.fromEntries(KEYS.map((k) => [k, sp.get(k) ?? ""])) as Filters;
  const page = Number(sp.get("page") ?? "1") || 1;
  const [q, setQ] = useState(f.q);
  const [d, setD] = useState<Paged<Row> | null>(null);
  const set = (patch: Partial<Filters> & { page?: number }) => {
    const next = new URLSearchParams();
    for (const k of KEYS) { const v = (k in patch ? patch[k] : f[k]) ?? ""; if (v) next.set(k, String(v)); }
    if (patch.page && patch.page > 1) next.set("page", String(patch.page));
    router.replace(`/admin/orders${next.toString() ? `?${next}` : ""}`);
  };
  useEffect(() => {
    const t = setTimeout(() => { if (q !== f.q) set({ q }); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const query = KEYS.reduce((acc, k) => (f[k] ? { ...acc, [k]: f[k] } : acc), {} as Record<string, string>);
  const key = JSON.stringify({ query, page });
  useEffect(() => {
    api<Paged<Row>>("/api/admin/orders", { query: { ...JSON.parse(key).query, page } }).then(setD).catch(quietly);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const scoped = f.seller_id || f.customer_id;
  const anyFilter = KEYS.some((k) => k !== "status" && f[k]);

  return (
    <div>
      <PageHeader title="Orders" actions={<ExportButton scope="admin" name="orders" status={f.status === "cancelled" ? "cancelled" : undefined} />} />
      <Tabs value={f.status} onChange={(v) => set({ status: v, page: 1 })} items={[{ value: "", label: "All" }, { value: "placed", label: "Placed" }, { value: "pending_payment", label: "Awaiting payment" }, { value: "cancelled", label: "Cancelled" }]} />
      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input placeholder="Order or package no., AWB, name, mobile or email" value={q} onChange={(e) => setQ(e.target.value)} className="sm:col-span-2" aria-label="Search orders" />
        <Select value={f.package_status} onChange={(e) => set({ package_status: e.target.value, page: 1 })} aria-label="Package status">
          <option value="">Any package status</option>
          {["placed", "confirmed", "packed", "shipped", "delivered", "cancelled"].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </Select>
        <Input placeholder="Staff tag (exact)" maxLength={30} defaultValue={f.tag} onBlur={(e) => { if (e.target.value.trim() !== f.tag) set({ tag: e.target.value.trim(), page: 1 }); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} aria-label="Staff tag" />
        <label className="flex items-center gap-2 text-sm text-ink-soft"><input type="checkbox" checked={!!f.late} onChange={(e) => set({ late: e.target.checked ? "1" : "", page: 1 })} />Late to ship only</label>
        <Select value={f.payment_method} onChange={(e) => set({ payment_method: e.target.value, page: 1 })} aria-label="Payment method">
          <option value="">COD and online</option><option value="cod">Cash on delivery</option><option value="online">Paid online</option>
        </Select>
        <Select value={f.payment_status} onChange={(e) => set({ payment_status: e.target.value, page: 1 })} aria-label="Payment status">
          <option value="">Any payment status</option>
          {Object.entries(PAYMENT_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm text-ink-soft">From <Input type="date" value={f.date_from} onChange={(e) => set({ date_from: e.target.value, page: 1 })} aria-label="From date" /></label>
        <label className="flex items-center gap-2 text-sm text-ink-soft">To <Input type="date" value={f.date_to} onChange={(e) => set({ date_to: e.target.value, page: 1 })} aria-label="To date" /></label>
        {anyFilter && (
          <button type="button" onClick={() => { setQ(""); router.replace(`/admin/orders${f.status ? `?status=${f.status}` : ""}`); }} className="inline-flex h-10 items-center gap-1 justify-self-start px-2 text-sm font-semibold text-peacock">
            <X className="h-4 w-4" />Clear filters
          </button>
        )}
      </div>
      {scoped && <p className="mb-2 text-sm text-ink-soft">Showing orders {f.seller_id ? "of one seller" : "of one customer"} only.</p>}
      {!d ? <PageLoader /> : d.items.length === 0 ? <EmptyState title="No orders match" /> : (
        <>
          <Table head={["Order", "Customer", "Placed", "Payment", "Total", "Packages", "Order status"]}>
            {d.items.map((o) => (
              <tr key={o.id} className="hover:bg-mist/60">
                <td className="px-4 py-3"><Link href={`/admin/orders/${o.id}`} className="font-semibold text-peacock hover:underline">{o.number}</Link>{(o.staff_tags?.length ?? 0) > 0 && <span className="mt-1 flex flex-wrap gap-1">{o.staff_tags!.map((t) => <span key={t} className="rounded-full bg-mist px-2 text-xs text-ink-soft">{t}</span>)}</span>}</td>
                <td className="px-4 py-3">{o.customer}<p className="text-sm text-ink-faint">{o.phone}</p></td>
                <td className="px-4 py-3 text-sm">{dateTime(o.created_at)}</td>
                <td className="px-4 py-3 text-sm">{o.payment_method === "cod" ? "COD" : "Online"}, {PAYMENT_STATUS_LABEL[o.payment_status]}</td>
                <td className="px-4 py-3 font-semibold">{rupees(o.grand_total)}</td>
                <td className="px-4 py-3"><span className="flex flex-wrap gap-1">{o.package_statuses.map((s, i) => <StatusPill key={i} status={s} />)}</span></td>
                <td className="px-4 py-3"><StatusPill status={o.status} /></td>
              </tr>
            ))}
          </Table>
          <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={(p) => set({ page: p })} />
        </>
      )}
    </div>
  );
}

export default function AdminOrders() {
  return <Suspense fallback={<PageLoader />}><Orders /></Suspense>;
}
