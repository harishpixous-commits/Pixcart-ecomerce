"use client";

import { Bike, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ReturnRequestModal } from "@/components/order-returns";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Modal, PageLoader, StatusPill, Textarea, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError, quietly } from "@/lib/api";
import { dateTime, PAYMENT_STATUS_LABEL, rupeesExact, SUB_STATUS_LABEL } from "@/lib/format";
import type { FleetTracking, OrderDetail, ReturnableItem } from "@/lib/types";
import { CustomerMessage } from "./message";
import { StaffNotes } from "./notes";
import { PaymentCheck } from "./payment-check";
import { RiskBrief } from "@/components/ai";
import { openPdf } from "@/components/order-returns";

export default function AdminOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const canRefund = useCan("refunds"); // retrying a failed refund needs the Refunds permission
  const [o, setO] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<OrderDetail>(`/api/admin/orders/${id}`).then(setO).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  // what the customer can still return, package by package: staff can open a return for them
  const [returnable, setReturnable] = useState<{ items: Record<string, ReturnableItem[]>; needs_upi: boolean } | null>(null);
  const [returnFor, setReturnFor] = useState<string | null>(null);
  const loadReturnable = useCallback(() => api<typeof returnable>(`/api/admin/orders/${id}/returnable`).then(setReturnable).catch(quietly), [id]);
  useEffect(() => { loadReturnable(); }, [loadReturnable]);

  async function act(path: string, body?: object, msg = "Updated") {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST", body });
      await load();
      toast(msg);
      setCancelId(null);
      setReason("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!o) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const a = o.ship_to;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader back={{ href: "/admin/orders", label: "Orders" }} title={`Order ${o.number}`} sub={`${dateTime(o.created_at)}, ${o.payment_method === "cod" ? "cash on delivery" : "online"}: ${PAYMENT_STATUS_LABEL[o.payment_status]}`} />
      <ErrorNote message={error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <RiskBrief path={`/api/admin/ai/briefs/order/${o.id}`} title="Order risk" />
        <CustomerMessage orderId={o.id} />
        <StaffNotes orderId={o.id} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl bg-white p-4"><h2 className="mb-1 font-semibold">Customer</h2><p>{o.customer?.name}</p><p className="text-ink-soft">{o.customer?.phone} {o.customer?.email}</p></section>
        <section className="rounded-xl bg-white p-4"><h2 className="mb-1 font-semibold">Ship to</h2><p className="text-ink-soft">{a.full_name}, {a.phone}, {a.line1}, {a.city}, {a.state} {a.pincode}</p>{a.gift_message && <p className="mt-1 text-sm"><strong>Gift message:</strong> {a.gift_message}</p>}{a.delivery_slot && <p className="mt-1 text-sm"><strong>Preferred delivery time:</strong> {a.delivery_slot}</p>}</section>
        <section className="rounded-xl bg-white p-4">
          <h2 className="mb-1 font-semibold">Totals</h2><p>Order {rupeesExact(o.grand_total)}</p>{o.refunded_total > 0 && <p className="text-leaf">Refunded {rupeesExact(o.refunded_total)}</p>}
          {o.fee_invoice_number && (
            <button type="button" className="mt-1 text-sm font-semibold text-peacock hover:underline" onClick={() => openPdf(`/api/admin/orders/${o.id}/fee-invoice.pdf`, (m) => toast(m, "error"))}>
              Fee invoice {o.fee_invoice_number}
            </button>
          )}
        </section>
      </div>
      {o.payment_method === "online" && <PaymentCheck order={o} onChecked={load} />}
      {o.sub_orders.map((s) => (
        <section key={s.id} className="rounded-xl bg-white p-4">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <h2 className="font-semibold">{s.number}, {s.seller?.name}</h2>
            <StatusPill status={s.status} label={SUB_STATUS_LABEL[s.status]} />
            <div className="ml-auto flex gap-2">
              {s.status === "shipped" && (
                <Button size="sm" loading={busy} onClick={() => {
                  const withPartner = !!o.fleet?.[s.id]?.assignment && !["delivered", "failed"].includes(o.fleet[s.id].assignment!.status);
                  if (withPartner && !window.confirm("Our delivery partner has this package. Mark it delivered without the customer's OTP? Do this only when you know it was handed over; the partner's trip is closed and any cash counts as collected by them.")) return;
                  act(`/api/admin/sub-orders/${s.id}/deliver`, undefined, "Marked delivered");
                }}>Mark delivered</Button>
              )}
              {["pending_payment", "placed", "confirmed", "packed"].includes(s.status) && <Button size="sm" variant="danger" onClick={() => setCancelId(s.id)}>Cancel and refund</Button>}
              {(returnable?.items[s.id] ?? []).some((i) => i.eligible) && <Button size="sm" variant="secondary" onClick={() => setReturnFor(s.id)}>Open a return</Button>}
            </div>
          </div>
          <ul className="mb-2 text-[15px]">
            {s.items.map((it, i) => <li key={i}>{it.title}{it.variant_label ? ` (${it.variant_label})` : ""} × {it.qty}: {rupeesExact(it.line_total)}</li>)}
          </ul>
          <p className="text-sm text-ink-soft">
            Total {rupeesExact(s.total)}; commission {rupeesExact(s.commission ?? 0)} + GST {rupeesExact(s.commission_gst ?? 0)}; TCS {rupeesExact(s.tcs ?? 0)}; TDS {rupeesExact(s.tds ?? 0)}; seller payout {rupeesExact(s.seller_payout ?? 0)} ({s.settlement_status})
          </p>
          {s.tracking_number && <p className="text-sm">Tracking: {s.courier_name} {s.tracking_number}</p>}
          {o.fleet?.[s.id] && <FleetLine f={o.fleet[s.id]} />}
          {s.cancel_reason && <p className="text-sm text-vermilion">Cancelled by {s.cancelled_by}: {s.cancel_reason}</p>}
        </section>
      ))}
      {o.refunds.length > 0 && (
        <section className="rounded-xl bg-white p-4">
          <h2 className="mb-2 font-semibold">Refunds</h2>
          {o.refunds.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 border-t border-line py-2 text-[15px]">
              <span>{rupeesExact(r.amount)}</span><StatusPill status={r.status} /><span className="text-ink-soft">{r.reason}</span>
              {r.last_error && <span className="text-sm text-vermilion">{r.last_error}</span>}
              {r.status === "failed" && r.id && (canRefund
                ? <Button size="sm" variant="secondary" className="ml-auto" onClick={() => act(`/api/admin/refunds/${r.id}/retry`, undefined, "Refund retried")}>Retry</Button>
                : <span className="ml-auto text-sm text-ink-soft">Ask Finance, or anyone with the Refunds permission, to retry this refund.</span>)}
            </div>
          ))}
        </section>
      )}
      <section className="rounded-xl bg-white p-4">
        <h2 className="mb-2 font-semibold">Timeline</h2>
        <ol className="text-sm">{o.timeline.map((e, i) => <li key={i}><span className="text-ink-faint">{dateTime(e.at)}</span> {e.from ? `${e.from} to ` : ""}{e.to} by {e.actor}{e.note ? `: ${e.note}` : ""}</li>)}</ol>
      </section>
      <Modal open={!!cancelId} onClose={() => setCancelId(null)} title="Cancel this part of the order">
        <p className="mb-2 text-ink-soft">Stock is returned to the seller. If the customer paid online, a refund is sent to Razorpay.</p>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason shown to the customer and seller" aria-label="Reason" />
        <Button className="mt-3" variant="buy" disabled={reason.trim().length < 5} loading={busy} onClick={() => act(`/api/admin/sub-orders/${cancelId}/cancel`, { reason }, "Cancelled")}>Cancel and refund</Button>
      </Modal>
      {returnFor && returnable && (
        <ReturnRequestModal staff subId={returnFor} items={returnable.items[returnFor] ?? []} needsUpi={returnable.needs_upi} open onClose={() => setReturnFor(null)}
          onDone={() => { setReturnFor(null); loadReturnable(); }} />
      )}
    </div>
  );
}

/** Own delivery fleet on the admin order: the step, the partner, and a link to the trip (or the assignment queue). */
function FleetLine({ f }: { f: FleetTracking }) {
  const a = f.assignment;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-peacock-light/50 px-3 py-2 text-sm" data-testid="admin-order-fleet">
      <Bike className="h-4 w-4 shrink-0 text-peacock" aria-hidden />
      <span className="font-semibold">Own delivery partner:</span>
      {a ? (
        <>
          <span>{a.status_label}</span>
          {f.partner && <span className="text-ink-soft">· {f.partner.name}{f.partner.vehicle_no ? `, ${f.partner.vehicle_no}` : ""}</span>}
          <Link href={`/admin/delivery/trips/${a.id}`} className="ml-auto inline-flex items-center gap-0.5 font-semibold text-peacock">Open trip <ChevronRight className="h-4 w-4" aria-hidden /></Link>
        </>
      ) : f.ready_for_pickup_at ? (
        <>
          <span>Ready for pickup, waiting for a partner</span>
          <Link href="/admin/delivery/queue" className="ml-auto inline-flex items-center gap-0.5 font-semibold text-peacock">Assign <ChevronRight className="h-4 w-4" aria-hidden /></Link>
        </>
      ) : (
        <span>the seller has not handed it over yet</span>
      )}
    </div>
  );
}
