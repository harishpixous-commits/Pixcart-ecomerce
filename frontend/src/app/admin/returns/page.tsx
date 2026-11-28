"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { RETURN_STATUS } from "@/components/order-returns";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Input, Modal, PageLoader, Pagination, ProductImage, StatusPill, Textarea, TextField, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError, latestOnly } from "@/lib/api";
import { dateTime, rupees } from "@/lib/format";
import type { ReturnView } from "@/lib/types";
import { ExportButton } from "@/components/export-button";

type AR = ReturnView & { refund_upi?: string | null; seller_name?: string; payment_method?: string };

function AdminReturnsInner() {
  const sellerId = useSearchParams().get("seller_id") ?? undefined;
  const toast = useToast();
  const canAct = useCan("refunds");
  const [status, setStatus] = useState("requested");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ items: AR[]; status_counts: Record<string, number>; total: number; page: number; page_size: number } | null>(null);
  const [act, setAct] = useState<{ r: AR; action: "reject" | "mark_refunded" } | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<typeof d>("/api/admin/returns", { query: { status: status || undefined, q, page, seller_id: sellerId } }), setD), [status, q, page, sellerId, track]);
  // Reloads always use the tab that is open now, even if it changed while an action was running.
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, refresh, q]);

  async function run(r: AR, action: string, extra: object = {}) {
    setError(null);
    try {
      await api(`/api/admin/returns/${r.id}`, { method: "POST", body: { action, ...extra } });
      toast("Return updated");
      setAct(null);
      setText("");
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update");
    }
  }
  const c = d?.status_counts ?? {};
  return (
    <div>
      <PageHeader title="Returns" sub="Step in when a seller doesn't respond, settle disputes, and record UPI refunds for cash-on-delivery returns. To open a return for a customer, use Open a return on their order." actions={<ExportButton scope="admin" name="returns" status={status || undefined} />} />
      <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[["requested", "Waiting for seller"], ["approved", "Approved"], ["picked_up", "Picked up"], ["received", "Received, refund due"], ["refunded", "Refunded"], ["rejected", "Rejected"], ["", "All"]].map(([v, l]) => ({ value: v, label: l, count: v ? c[v] ?? 0 : undefined }))} />
      <Input placeholder="Return or package number, customer name or mobile" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search returns" />
      {!canAct && <p className="mb-3 rounded-lg bg-mist p-3 text-sm text-ink-soft">You can see returns. Approving, rejecting and recording refunds needs the Refunds permission.</p>}
      <ErrorNote message={error} />
      {!d ? <PageLoader /> : d.items.length === 0 ? <EmptyState title="No returns here" /> : (
        <div className="flex flex-col gap-3">
          {d.items.map((r) => (
            <section key={r.id} className="rounded-xl bg-white p-4">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">{r.number} on <Link href={`/admin/orders/${r.order_id}`} className="text-peacock hover:underline">{r.sub_order_number}</Link>{r.seller_name ? `, ${r.seller_name}` : ""}</p>
                <StatusPill status={r.status === "refunded" ? "approved" : r.status === "rejected" ? "rejected" : "pending"} label={RETURN_STATUS[r.status]} />
              </div>
              {r.items.map((i, n) => (
                <div key={n} className="flex items-center gap-3 py-1">
                  <ProductImage src={i.image} alt="" className="h-10 w-10 shrink-0" />
                  <p className="flex-1 text-sm">{i.title} × {i.qty}</p>
                  <p className="text-sm font-semibold">{rupees(i.amount)}</p>
                </div>
              ))}
              <p className="text-ink-soft"><strong>{r.reason_label}.</strong> {r.comment}</p>
              {(r.photos ?? []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2" data-testid="return-photos">
                  {(r.photos ?? []).map((u) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={u} alt="Photo from the customer" className="h-16 w-16 rounded-lg border border-line object-cover" />
                    </a>
                  ))}
                </div>
              )}
              <p className="text-sm text-ink-faint">Requested {dateTime(r.created_at)}{r.refund_upi ? `. Refund to UPI ${r.refund_upi}` : ""}</p>
              {canAct && <div className="mt-2 flex flex-wrap gap-2">
                {r.status === "requested" && <><Button size="sm" onClick={() => run(r, "approve")}>Approve</Button><Button size="sm" variant="danger" onClick={() => setAct({ r, action: "reject" })}>Reject</Button></>}
                {(r.status === "approved" || r.status === "picked_up") && <Button size="sm" onClick={() => run(r, "received")}>Mark received</Button>}
                {r.status === "received" && <Button size="sm" onClick={() => setAct({ r, action: "mark_refunded" })}>Record UPI refund</Button>}
              </div>}
            </section>
          ))}
          <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </div>
      )}
      <Modal open={!!act} onClose={() => setAct(null)} title={act?.action === "reject" ? "Reject return" : "Record refund"}>
        {act && (
          <div className="flex flex-col gap-3">
            {act.action === "reject" ? (
              <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Reason the customer will see" aria-label="Reason" />
            ) : (
              <>
                <p className="text-ink-soft">Pay {rupees(act.r.refund_amount)} to UPI {act.r.refund_upi ?? "(not given)"}, then enter the UPI reference number.</p>
                <TextField label="UPI / bank reference" value={text} onChange={(e) => setText(e.target.value)} />
              </>
            )}
            <Button onClick={() => run(act.r, act.action, act.action === "reject" ? { note: text } : { reference: text })} disabled={text.trim().length < 4}>Save</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function AdminReturns() {
  return <Suspense fallback={<PageLoader />}><AdminReturnsInner /></Suspense>;
}
