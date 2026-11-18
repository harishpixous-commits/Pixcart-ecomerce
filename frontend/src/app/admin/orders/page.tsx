"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { EmptyState, Input, PageLoader, Pagination, StatusPill } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { dateTime, PAYMENT_STATUS_LABEL, rupees } from "@/lib/format";
import type { Paged } from "@/lib/types";
import { ExportButton } from "@/components/export-button";

type Row = { id: string; number: string; customer: string; phone: string; status: string; payment_method: string; payment_status: string; grand_total: number; created_at: string };

export default function AdminOrders() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Paged<Row> | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api<Paged<Row>>("/api/admin/orders", { query: { status: status || undefined, q, page } }).then(setD).catch(quietly), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [status, q, page]);
  return (
    <div>
      <PageHeader title="Orders" actions={<ExportButton scope="admin" name="orders" status={status === "cancelled" ? "cancelled" : undefined} />} />
      <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[{ value: "", label: "All" }, { value: "placed", label: "Placed" }, { value: "pending_payment", label: "Awaiting payment" }, { value: "cancelled", label: "Cancelled" }]} />
      <Input placeholder="Order number or customer mobile" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search orders" />
      {!d ? <PageLoader /> : d.items.length === 0 ? <EmptyState title="No orders" /> : (
        <>
          <Table head={["Order", "Customer", "Placed", "Payment", "Total", "Status"]}>
            {d.items.map((o) => (
              <tr key={o.id} className="hover:bg-mist/60">
                <td className="px-4 py-3"><Link href={`/admin/orders/${o.id}`} className="font-semibold text-peacock hover:underline">{o.number}</Link></td>
                <td className="px-4 py-3">{o.customer}<p className="text-sm text-ink-faint">{o.phone}</p></td>
                <td className="px-4 py-3 text-sm">{dateTime(o.created_at)}</td>
                <td className="px-4 py-3 text-sm">{o.payment_method === "cod" ? "COD" : "Online"}, {PAYMENT_STATUS_LABEL[o.payment_status]}</td>
                <td className="px-4 py-3 font-semibold">{rupees(o.grand_total)}</td>
                <td className="px-4 py-3"><StatusPill status={o.status} /></td>
              </tr>
            ))}
          </Table>
          <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
