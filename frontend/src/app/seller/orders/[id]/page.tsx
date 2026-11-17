"use client";

import { FileText, Printer, Truck } from "lucide-react";
import { openPdf } from "@/components/order-returns";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Modal, PageLoader, ProductImage, Select, StatusPill, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateTime, pct, rupees, rupeesExact, SUB_STATUS_LABEL } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { SellerOrder } from "@/lib/types";

const REJECT_REASONS = [
  ["out_of_stock", "Out of stock"],
  ["cannot_ship_to_pincode", "Cannot deliver to this PIN code"],
  ["pricing_error", "Pricing error in the listing"],
  ["other", "Other reason"],
];

export default function SellerOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { user } = useSession();
  const [o, setO] = useState<SellerOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shipOpen, setShipOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [ship, setShip] = useState({ courier_name: "", tracking_number: "", tracking_url: "" });
  const [reject, setReject] = useState({ reason: "out_of_stock", note: "" });
  const [provider, setProvider] = useState("manual");
  useEffect(() => {
    api<{ provider: string }>("/api/seller/shipping").then((r) => setProvider(r.provider)).catch(() => {});
  }, []);

  async function bookCourier() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ courier_name: string; tracking_number: string }>(`/api/seller/orders/${id}/book-courier`, { method: "POST" });
      await load();
      toast(`Booked with ${r.courier_name}, AWB ${r.tracking_number}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not book the courier");
    } finally {
      setBusy(false);
    }
  }

  const load = useCallback(() => api<SellerOrder>(`/api/seller/orders/${id}`).then(setO).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  async function act(path: string, body?: object, msg?: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/seller/orders/${id}/${path}`, { method: "POST", body });
      await load();
      toast(msg ?? "Updated");
      setShipOpen(false);
      setRejectOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update");
    } finally {
      setBusy(false);
    }
  }

  if (!o) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const a = o.ship_to;
  const b = o.breakdown;
  return (
    <div className="flex flex-col gap-4">
      <div className="print:hidden">
        <PageHeader
          title={`Order ${o.number}`}
          sub={`Placed ${dateTime(o.created_at)}, ${o.payment_method === "cod" ? "cash on delivery: collect " + rupees(o.total) : "prepaid"}`}
          actions={
            <>
              {o.status === "placed" && <Button onClick={() => act("confirm", undefined, "Order confirmed")} loading={busy}>Confirm order</Button>}
              {o.status === "confirmed" && <Button onClick={() => act("pack", undefined, "Marked as packed")} loading={busy}>Mark as packed</Button>}
              {o.status === "packed" && provider === "shiprocket" && <Button onClick={bookCourier} loading={busy}><Truck className="h-4 w-4" /> Book courier pickup</Button>}
              {o.status === "packed" && <Button variant={provider === "shiprocket" ? "secondary" : "primary"} onClick={() => setShipOpen(true)}>{provider === "shiprocket" ? "Ship on my own" : "Add shipping details"}</Button>}
              {o.label_url && <a href={o.label_url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-4 font-semibold">Shipping label</a>}
              {o.invoice_number && <Button variant="secondary" onClick={() => openPdf(`/api/seller/orders/${o.id}/invoice.pdf`, (m) => toast(m, "error"))}><FileText className="h-4 w-4" /> Invoice {o.invoice_number}</Button>}
              {o.status === "shipped" && <Button onClick={() => act("deliver", undefined, "Marked as delivered")} loading={busy}>Mark as delivered</Button>}
              {["confirmed", "packed", "shipped", "delivered"].includes(o.status) && (
                <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Packing slip</Button>
              )}
              {["placed", "confirmed", "packed"].includes(o.status) && <Button variant="danger" onClick={() => setRejectOpen(true)}>Cancel order</Button>}
            </>
          }
        />
        <ErrorNote message={error} />
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <section className="self-start rounded-xl bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Items</h2>
              <StatusPill status={o.status} label={SUB_STATUS_LABEL[o.status]} />
            </div>
            {o.items.map((it, i) => (
              <div key={i} className="flex gap-3 border-t border-line py-3">
                <ProductImage src={it.image} alt="" className="h-16 w-16 shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">{it.title}</p>
                  <p className="text-sm text-ink-faint">{it.variant_label ? `${it.variant_label}, ` : ""}SKU {it.sku}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">× {it.qty}</p>
                  <p className="text-sm text-ink-soft">{rupees(it.line_total)}</p>
                </div>
              </div>
            ))}
            {o.tracking_number && <p className="border-t border-line pt-3 text-sm">Shipped with {o.courier_name}, tracking {o.tracking_number}</p>}
            {o.cancel_reason && <p className="border-t border-line pt-3 text-sm text-vermilion">Cancelled: {o.cancel_reason}</p>}
          </section>
          <div className="flex flex-col gap-4">
            <section className="rounded-xl bg-white p-4">
              <h2 className="mb-2 text-lg font-semibold">Ship to</h2>
              {a ? (
                <p className="text-ink-soft">{a.full_name}, {a.phone}<br />{[a.line1, a.line2, a.landmark].filter(Boolean).join(", ")}<br />{a.city}, {a.state} {a.pincode}</p>
              ) : <p className="text-ink-faint">Address shown once the order is placed.</p>}
            </section>
            {b && (
              <section className="rounded-xl bg-white p-4">
                <h2 className="mb-2 text-lg font-semibold">Your earnings</h2>
                <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-[15px]">
                  <dt>Order value</dt><dd>{rupeesExact(b.gross)}</dd>
                  <dt>Commission</dt><dd>−{rupeesExact(b.commission)}</dd>
                  <dt>GST on commission</dt><dd>−{rupeesExact(b.commission_gst)}</dd>
                  <dt>TCS (GST)</dt><dd>−{rupeesExact(b.tcs)}</dd>
                  <dt>TDS (income tax)</dt><dd>−{rupeesExact(b.tds)}</dd>
                  <dt className="border-t border-line pt-1 font-semibold">You receive</dt><dd className="border-t border-line pt-1 font-semibold">{rupeesExact(b.payout)}</dd>
                </dl>
                <p className="mt-2 text-xs text-ink-faint">Paid after the return window closes. TCS and TDS can be claimed in your GST and income-tax returns.</p>
              </section>
            )}
            {o.timeline && (
              <section className="rounded-xl bg-white p-4">
                <h2 className="mb-2 text-lg font-semibold">History</h2>
                <ol className="flex flex-col gap-1.5 text-sm">
                  {o.timeline.map((e, i) => (
                    <li key={i}><span className="text-ink-faint">{dateTime(e.at)}</span> {SUB_STATUS_LABEL[e.to] ?? e.to}{e.note ? `: ${e.note}` : ""}</li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        </div>
      </div>

      {/* Packing slip / tax summary, printed on A4 */}
      <div className="hidden print:block">
        <h1 className="text-2xl font-bold">Packing slip and tax summary</h1>
        <p>Order {o.number} ({o.order_number}), {dateTime(o.created_at)}, {o.payment_method === "cod" ? `COD: collect ${rupeesExact(o.total)}` : "Prepaid"}</p>
        <p className="mt-2"><strong>Sold by:</strong> {user?.seller?.display_name}</p>
        {a && <p><strong>Ship to:</strong> {a.full_name}, {a.phone}, {[a.line1, a.line2, a.landmark, a.city, a.state, a.pincode].filter(Boolean).join(", ")}</p>}
        <table className="mt-3 w-full border-collapse text-sm">
          <thead><tr>{["Item", "SKU", "HSN", "Qty", "Taxable", "GST", "CGST", "SGST", "IGST", "Total"].map((h) => <th key={h} className="border border-ink p-1 text-left">{h}</th>)}</tr></thead>
          <tbody>
            {o.items.map((it, i) => {
              const t = o.items_tax?.[i];
              return (
                <tr key={i}>
                  <td className="border border-ink p-1">{it.title}{it.variant_label ? ` (${it.variant_label})` : ""}</td>
                  <td className="border border-ink p-1">{it.sku}</td>
                  <td className="border border-ink p-1">{t?.hsn_code}</td>
                  <td className="border border-ink p-1">{it.qty}</td>
                  <td className="border border-ink p-1">{t && rupeesExact(t.taxable_value)}</td>
                  <td className="border border-ink p-1">{t && pct(t.gst_bps)}</td>
                  <td className="border border-ink p-1">{t && rupeesExact(t.cgst)}</td>
                  <td className="border border-ink p-1">{t && rupeesExact(t.sgst)}</td>
                  <td className="border border-ink p-1">{t && rupeesExact(t.igst)}</td>
                  <td className="border border-ink p-1">{rupeesExact(it.line_total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2">Delivery charge: {rupeesExact(o.shipping_fee)}. Order total: {rupeesExact(o.total)}.</p>
      </div>

      <Modal open={shipOpen} onClose={() => setShipOpen(false)} title="Shipping details">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); act("ship", { ...ship, tracking_url: ship.tracking_url || null }, "Marked as shipped"); }}>
          <TextField label="Courier" value={ship.courier_name} onChange={(e) => setShip({ ...ship, courier_name: e.target.value })} placeholder="e.g. Delhivery, DTDC, India Post" required />
          <TextField label="Tracking number (AWB)" value={ship.tracking_number} onChange={(e) => setShip({ ...ship, tracking_number: e.target.value })} required />
          <TextField label="Tracking link (optional)" type="url" value={ship.tracking_url} onChange={(e) => setShip({ ...ship, tracking_url: e.target.value })} placeholder="https://" />
          <ErrorNote message={error} />
          <Button type="submit" loading={busy}>Mark as shipped</Button>
        </form>
      </Modal>
      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title="Cancel this order?">
        <p className="mb-3 text-ink-soft">The customer is notified and refunded in full. Frequent cancellations affect your seller rating.</p>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); act("reject", reject, "Order cancelled"); }}>
          <Field label="Reason" htmlFor="rr">
            <Select id="rr" value={reject.reason} onChange={(e) => setReject({ ...reject, reason: e.target.value })}>
              {REJECT_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          {reject.reason === "out_of_stock" && <p className="text-sm text-ink-soft">Stock for these items will be set to 0 so they stop selling.</p>}
          <TextField label="Note (optional)" value={reject.note} onChange={(e) => setReject({ ...reject, note: e.target.value })} maxLength={200} />
          <Button type="submit" variant="buy" loading={busy}>Cancel order</Button>
        </form>
      </Modal>
    </div>
  );
}
