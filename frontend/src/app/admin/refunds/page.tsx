"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, PageLoader, StatusPill, useToast } from "@/components/ui";
import { api, latestOnly } from "@/lib/api";
import { dateTime, rupeesExact } from "@/lib/format";

type Row = { id: string; order_id: string; order_number: string; amount: number; status: string; reason: string; attempts: number; last_error: string; created_at: string };

export default function AdminRefunds() {
  const toast = useToast();
  const [status, setStatus] = useState("failed");
  const [rows, setRows] = useState<Row[] | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<{ items: Row[] }>("/api/admin/refunds", { query: { status: status || undefined } }), (d) => setRows(d.items)), [status, track]);
  useEffect(() => { load(); }, [load]);
  async function retry(id: string) {
    await api(`/api/admin/refunds/${id}/retry`, { method: "POST" });
    toast("Refund sent again");
    load();
  }
  return (
    <div>
      <PageHeader title="Refunds" sub="Failed refunds are retried automatically 8 times, then wait here for you." />
      <Tabs value={status} onChange={setStatus} items={[{ value: "failed", label: "Failed" }, { value: "pending", label: "In progress" }, { value: "processed", label: "Completed" }, { value: "", label: "All" }]} />
      {!rows ? <PageLoader /> : rows.length === 0 ? <EmptyState title="No refunds here" /> : (
        <Table head={["Order", "Amount", "Reason", "Attempts", "Created", "Status", ""]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-4 py-2.5"><Link href={`/admin/orders/${r.order_id}`} className="font-semibold text-peacock">{r.order_number}</Link></td>
              <td className="px-4 py-2.5">{rupeesExact(r.amount)}</td>
              <td className="px-4 py-2.5 text-sm">{r.reason}{r.last_error && <p className="text-vermilion">{r.last_error}</p>}</td>
              <td className="px-4 py-2.5">{r.attempts}</td>
              <td className="px-4 py-2.5 text-sm">{dateTime(r.created_at)}</td>
              <td className="px-4 py-2.5"><StatusPill status={r.status} /></td>
              <td className="px-4 py-2.5">{r.status === "failed" && <Button size="sm" variant="secondary" onClick={() => retry(r.id)}>Retry</Button>}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
