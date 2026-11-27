"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { EmptyState, Input, PageLoader, Pagination, Pill, StatusPill } from "@/components/ui";
import { api, latestOnly } from "@/lib/api";
import { dateTime, rupees } from "@/lib/format";
import type { Paged, SellerOrder } from "@/lib/types";
import { ExportButton } from "@/components/export-button";

const TABS = [
  ["placed", "To confirm"],
  ["confirmed", "To pack"],
  ["packed", "To ship"],
  ["shipped", "In transit"],
  ["delivered", "Delivered"],
  ["cancelled", "Cancelled"],
  ["", "All"],
] as const;

function List() {
  const sp = useSearchParams();
  const router = useRouter();
  const status = sp.get("status") ?? "placed";
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<SellerOrder> | null>(null);

  const track = useMemo(() => latestOnly(), []);
  useEffect(() => {
    const t = setTimeout(() => track(api<Paged<SellerOrder>>("/api/seller/orders", { query: { status: status || undefined, q, page } }), setData), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [status, q, page, track]);

  const counts = data?.status_counts ?? {};
  return (
    <div>
      <PageHeader title="Orders" sub="Confirm, pack and ship each order. Customers can cancel until you ship." actions={<ExportButton scope="seller" name="orders" status={status || undefined} />} />
      {!!data?.late_count && (
        <p className="mb-3 rounded-lg bg-marigold-light px-3 py-2 text-sm text-ink" role="status">
          {data.late_count} open order{data.late_count === 1 ? " is" : "s are"} more than {data.late_after_days} day{data.late_after_days === 1 ? "" : "s"} old. Ship {data.late_count === 1 ? "it" : "them"} first.
        </p>
      )}
      <Tabs value={status} onChange={(v) => { setPage(1); router.push(`/seller/orders?status=${v}`); }} items={TABS.map(([v, l]) => ({ value: v, label: l, count: v ? counts[v] ?? 0 : undefined }))} />
      <Input placeholder="Search by order number" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search orders" />
      {!data ? (
        <PageLoader />
      ) : data.items.length === 0 ? (
        <EmptyState title="No orders here" body={status === "placed" ? "New orders appear here as soon as they are paid or placed with cash on delivery." : undefined} />
      ) : (
        <>
          <Table head={["Order", "Items", "Ship to", "Payment", "Amount", "Status"]}>
            {data.items.map((o) => (
              <tr key={o.id} className="hover:bg-mist/60">
                <td className="px-4 py-3">
                  <Link href={`/seller/orders/${o.id}`} className="font-semibold text-peacock hover:underline">{o.number}</Link>
                  <p className="text-sm text-ink-faint">{dateTime(o.created_at)}</p>
                </td>
                <td className="px-4 py-3">
                  <p className="line-clamp-1">{o.items[0]?.title}</p>
                  <p className="text-sm text-ink-faint">{o.items.map((i) => `${i.sku} × ${i.qty}`).join(", ")}</p>
                </td>
                <td className="px-4 py-3 text-sm">{o.ship_to_city} {o.ship_to_pincode}</td>
                <td className="px-4 py-3">{o.payment_method === "cod" ? <Pill tone="amber">COD</Pill> : <Pill tone="green">Prepaid</Pill>}</td>
                <td className="px-4 py-3 font-semibold">{rupees(o.total)}</td>
                <td className="px-4 py-3"><StatusPill status={o.status} /></td>
              </tr>
            ))}
          </Table>
          <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

export default function SellerOrdersPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <List />
    </Suspense>
  );
}
