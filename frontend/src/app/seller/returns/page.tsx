"use client";

import { FileText } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RETURN_STATUS, openPdf } from "@/components/order-returns";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Modal, PageLoader, ProductImage, StatusPill, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { dateTime, rupees } from "@/lib/format";
import type { ReturnView } from "@/lib/types";
import { ExportButton } from "@/components/export-button";

export default function SellerReturns() {
  const toast = useToast();
  const [status, setStatus] = useState("requested");
  const [data, setData] = useState<{ items: ReturnView[]; status_counts: Record<string, number> } | null>(null);
  const [act, setAct] = useState<{ r: ReturnView; action: "reject" | "picked_up" } | null>(null);
  const [note, setNote] = useState("");
  const [courier, setCourier] = useState("");
  const [tracking, setTracking] = useState("");
  const [error, setError] = useState<string | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<typeof data>("/api/seller/returns", { query: { status: status || undefined } }), setData), [status, track]);
  // Reloads always use the tab that is open now, even if it changed while an action was running.
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { load(); }, [load, refresh]);

  async function run(r: ReturnView, action: string, body: object = {}) {
    setError(null);
    try {
      await api(`/api/seller/returns/${r.id}`, { method: "POST", body: { action, ...body } });
      toast("Return updated");
      setAct(null);
      setNote("");
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update");
    }
  }

  const c = data?.status_counts ?? {};
  return (
    <div>
      <PageHeader title="Returns" sub="Approve returns, arrange the pickup, and mark them received. The refund is issued when you mark a return received." actions={<ExportButton scope="seller" name="returns" status={status || undefined} />} />
      <Tabs value={status} onChange={setStatus} items={[["requested", "To review"], ["approved", "Awaiting pickup"], ["picked_up", "In transit"], ["received", "Received"], ["refunded", "Refunded"], ["rejected", "Rejected"], ["", "All"]].map(([v, l]) => ({ value: v, label: l, count: v ? c[v] ?? 0 : undefined }))} />
      <ErrorNote message={error} />
      {!data ? <PageLoader /> : data.items.length === 0 ? <EmptyState title="No returns here" /> : (
        <div className="flex flex-col gap-3">
          {data.items.map((r) => (
            <section key={r.id} className="rounded-xl bg-white p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">{r.number} on order {r.sub_order_number}</p>
                <StatusPill status={r.status === "refunded" ? "approved" : r.status === "rejected" ? "rejected" : "pending"} label={RETURN_STATUS[r.status]} />
              </div>
              {r.items.map((i, n) => (
                <div key={n} className="flex items-center gap-3 py-1">
                  <ProductImage src={i.image} alt="" className="h-12 w-12 shrink-0" />
                  <p className="flex-1">{i.title}{i.variant_label ? ` (${i.variant_label})` : ""} × {i.qty}</p>
                  <p className="font-semibold">{rupees(i.amount)}</p>
                </div>
              ))}
              <p className="mt-2 text-ink-soft"><strong>{r.reason_label}.</strong> {r.comment}</p>
              <p className="text-sm text-ink-faint">Requested {dateTime(r.created_at)}</p>
              {r.fleet_pickup?.requested && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-peacock-light/50 p-3 text-sm ring-1 ring-peacock/15" data-testid="seller-return-pickup">
                  <span className="font-semibold text-peacock-dark">Our delivery partner collects this return{r.fleet_pickup.label ? `: ${r.fleet_pickup.label}` : ""}</span>
                  {r.fleet_pickup.partner && <span className="text-ink-soft">{r.fleet_pickup.partner.name}{r.fleet_pickup.partner.vehicle_no ? ` · ${r.fleet_pickup.partner.vehicle_no}` : ""}</span>}
                  {r.fleet_pickup.code && (
                    <span className="flex items-center gap-2">
                      <span className="text-ink-soft">Give pickup code</span>
                      <span className="rounded-lg bg-white px-2 py-0.5 font-mono text-lg font-bold tracking-[0.3em] ring-1 ring-line">{r.fleet_pickup.code}</span>
                      <span className="text-ink-soft">when you receive it</span>
                    </span>
                  )}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {r.status === "requested" && (
                  <>
                    <Button size="sm" onClick={() => run(r, "approve")}>Approve return</Button>
                    <Button size="sm" variant="danger" onClick={() => setAct({ r, action: "reject" })}>Reject</Button>
                  </>
                )}
                {r.status === "approved" && (
                  <Button size="sm" variant="secondary" onClick={() => setAct({ r, action: "picked_up" })}>{r.fleet_pickup?.requested ? "Use my own courier instead" : "Pickup booked"}</Button>
                )}
                {(r.status === "approved" || r.status === "picked_up") && <Button size="sm" onClick={() => run(r, "received")}>Mark received and refund</Button>}
                {r.credit_note_number && (
                  <Button size="sm" variant="ghost" onClick={() => openPdf(`/api/seller/returns/${r.id}/credit-note.pdf`, (m) => toast(m, "error"))}><FileText className="h-4 w-4" /> Credit note {r.credit_note_number}</Button>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      <Modal open={!!act} onClose={() => setAct(null)} title={act?.action === "reject" ? "Reject this return" : "Pickup details"}>
        {act?.action === "reject" ? (
          <div className="flex flex-col gap-3">
            <p className="text-ink-soft">The customer sees your reason and can contact support if they disagree.</p>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The item was used and the tags are removed" aria-label="Reason" />
            <Button variant="buy" disabled={note.trim().length < 10} onClick={() => run(act.r, "reject", { note })}>Reject return</Button>
          </div>
        ) : act ? (
          <div className="flex flex-col gap-3">
            <TextField label="Courier" value={courier} onChange={(e) => setCourier(e.target.value)} />
            <TextField label="Pickup tracking number" value={tracking} onChange={(e) => setTracking(e.target.value)} />
            <Button onClick={() => run(act.r, "picked_up", { courier, tracking })}>Save</Button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
