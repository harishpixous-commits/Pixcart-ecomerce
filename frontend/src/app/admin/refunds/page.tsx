"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Input, Modal, PageLoader, Pagination, Select, StatusPill, TextField, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { dateTime, rupeesExact } from "@/lib/format";

type Row = { id: string; order_id: string; order_number: string; amount: number; status: string; reason: string; attempts: number; last_error: string; created_at: string };

export default function AdminRefunds() {
  const toast = useToast();
  const [status, setStatus] = useState("failed");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<{ items: Row[]; total: number }>("/api/admin/refunds", { query: { status: status || undefined, q, page } }), (d) => { setRows(d.items); setTotal(d.total); }), [status, q, page, track]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  const [settling, setSettling] = useState<Row | null>(null);
  const [method, setMethod] = useState("upi");
  const [reference, setReference] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function settle() {
    if (!settling) return;
    setErr(null);
    try {
      await api(`/api/admin/refunds/${settling.id}/settle`, { method: "POST", body: { method, reference } });
      toast("Refund recorded. The customer has been told.");
      setSettling(null);
      setReference("");
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not record it");
    }
  }
  async function retry(id: string) {
    await api(`/api/admin/refunds/${id}/retry`, { method: "POST" });
    toast("Refund sent again");
    load();
  }
  return (
    <div>
      <PageHeader title="Refunds" sub="Failed refunds are retried automatically 8 times, then wait here for you." />
      <Input placeholder="Order number" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-xs" aria-label="Search refunds" />
      <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[{ value: "failed", label: "Failed" }, { value: "pending", label: "In progress" }, { value: "processed", label: "Completed" }, { value: "", label: "All" }]} />
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
              <td className="px-4 py-2.5"><span className="flex gap-1">{r.status === "failed" && <Button size="sm" variant="secondary" onClick={() => retry(r.id)}>Retry</Button>}{(r.status === "failed" || r.status === "pending") && <Button size="sm" variant="ghost" onClick={() => { setSettling(r); setErr(null); }}>Paid by hand</Button>}</span></td>
            </tr>
          ))}
        </Table>
      )}
      {rows && <Pagination page={page} pageSize={50} total={total} onPage={setPage} />}
      <Modal open={!!settling} onClose={() => setSettling(null)} title={`Record a refund paid by hand`}>
        {settling && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-soft">Use this when you paid {rupeesExact(settling.amount)} for order {settling.order_number} outside the payment gateway. The gateway is not called again.</p>
            <ErrorNote message={err} />
            <label className="flex flex-col gap-1 text-sm font-medium">How it was paid
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="upi">UPI</option><option value="neft">NEFT</option><option value="imps">IMPS</option><option value="rtgs">RTGS</option><option value="cheque">Cheque</option><option value="other">Other</option>
              </Select>
            </label>
            <TextField label="Reference (UTR / UPI ref no.)" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={40} />
            <Button onClick={settle} disabled={reference.trim().length < 4}>Record refund</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
