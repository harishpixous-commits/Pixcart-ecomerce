"use client";

import clsx from "clsx";
import { Bike, FileText, KeyRound, PackageCheck, Phone, Printer, Truck } from "lucide-react";
import { openPdf } from "@/components/order-returns";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { telUrl, usePolling } from "@/components/delivery/trip";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Modal, PageLoader, ProductImage, Select, StatusPill, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateTime, pct, rupees, rupeesExact, SUB_STATUS_LABEL } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { SellerFleet, SellerOrder } from "@/lib/types";

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
  const [keepIds, setKeepIds] = useState<string[]>([]); // out of stock: items the seller unticked (they still have stock)
  const [rtoOpen, setRtoOpen] = useState(false); // the seller's courier brought the package back (RTO)
  const [rtoNote, setRtoNote] = useState("");
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
  // while our delivery partner is on the way, keep the partner and step fresh
  const following = !!o?.fleet?.active && ["packed", "shipped"].includes(o.status);
  usePolling(load, 20_000, following);

  async function act(path: string, body?: object, msg?: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/seller/orders/${id}/${path}`, { method: "POST", body });
      await load();
      toast(msg ?? "Updated");
      setShipOpen(false);
      setRejectOpen(false);
      setRtoOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update");
    } finally {
      setBusy(false);
    }
  }

  if (!o) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const a = o.ship_to;
  const b = o.breakdown;
  const f = o.fleet;
  // Our own delivery partners carry this order: either it is already with the fleet, or the fleet must take it.
  const fleetOnly = !!f && (f.active || (f.eligible && !f.choice));
  const canHandOver = !!f && f.eligible && !f.active && ["confirmed", "packed"].includes(o.status);
  return (
    <div className="flex flex-col gap-4">
      <div className="print:hidden">
        <PageHeader
          back={{ href: "/seller/orders", label: "Orders" }}
          title={`Order ${o.number}`}
          sub={`Placed ${dateTime(o.created_at)}, ${o.payment_method === "cod" ? "cash on delivery: collect " + rupees(o.cod_to_collect ?? o.total) : "prepaid"}`}
          actions={
            <>
              {o.status === "placed" && <Button onClick={() => act("confirm", undefined, "Order confirmed")} loading={busy}>Confirm order</Button>}
              {canHandOver && (
                <Button onClick={() => act("ready-for-pickup", undefined, "Ready for pickup. A delivery partner is on the way.")} loading={busy} data-testid="ready-for-pickup">
                  <PackageCheck className="h-4 w-4" /> Ready for pickup
                </Button>
              )}
              {o.status === "confirmed" && <Button variant={canHandOver ? "secondary" : "primary"} onClick={() => act("pack", undefined, "Marked as packed")} loading={busy}>Mark as packed</Button>}
              {o.status === "packed" && !fleetOnly && provider === "shiprocket" && <Button variant={canHandOver ? "secondary" : "primary"} onClick={bookCourier} loading={busy}><Truck className="h-4 w-4" /> Book courier pickup</Button>}
              {o.status === "packed" && !fleetOnly && <Button variant={provider === "shiprocket" || canHandOver ? "secondary" : "primary"} onClick={() => setShipOpen(true)}>{provider === "shiprocket" ? "Ship on my own" : "Add shipping details"}</Button>}
              {f?.active && f.choice && o.status === "packed" && !f.partner && (
                <Button variant="secondary" onClick={() => act("use-courier", undefined, "Taken back from the delivery partners. Ship it by courier.")} loading={busy}><Truck className="h-4 w-4" /> Use courier instead</Button>
              )}
              {o.label_url && <a href={o.label_url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-4 font-semibold">Shipping label</a>}
              {o.invoice_number && <Button variant="secondary" onClick={() => openPdf(`/api/seller/orders/${o.id}/invoice.pdf`, (m) => toast(m, "error"))}><FileText className="h-4 w-4" /> Invoice {o.invoice_number}</Button>}
              {o.status === "shipped" && !f?.active && <Button onClick={() => act("deliver", undefined, "Marked as delivered")} loading={busy}>Mark as delivered</Button>}
              {o.status === "shipped" && o.shipping_provider === "manual" && (
                <Button variant="secondary" onClick={() => setRtoOpen(true)} data-testid="rto">Returned to me</Button>
              )}
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
            {f && (f.active || f.eligible) && !["cancelled", "pending_payment"].includes(o.status) && <FleetCard f={f} status={o.status} />}
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
        <p>Order {o.number} ({o.order_number}), {dateTime(o.created_at)}, {o.payment_method === "cod" ? `COD: collect ${rupeesExact(o.cod_to_collect ?? o.total)}` : "Prepaid"}</p>
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
      <Modal open={rtoOpen} onClose={() => setRtoOpen(false)} title="Package returned to you?">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); act("rto", { note: rtoNote }, "Marked as returned. The order is cancelled."); }}>
          <ErrorNote message={error} />
          <p className="text-ink-soft">
            Use this when your courier brought the package back undelivered (refused, nobody at home, address not found). The order is cancelled, the
            stock goes back to your warehouse{o.payment_method === "online" ? " and the customer is refunded" : ""}. No sale is paid for it.
          </p>
          <TextField label="What happened (optional)" value={rtoNote} onChange={(e) => setRtoNote(e.target.value)} maxLength={200} placeholder="For example: customer refused the package" />
          <Button type="submit" variant="danger" loading={busy}>Mark as returned to me</Button>
        </form>
      </Modal>
      <Modal open={rejectOpen} onClose={() => setRejectOpen(false)} title="Cancel this order?">
        <p className="mb-3 text-ink-soft">The customer is notified and refunded in full. Frequent cancellations affect your seller rating.</p>
        <form className="flex flex-col gap-3" onSubmit={(e) => {
          e.preventDefault();
          const ids = o.items.map((it) => it.id).filter((x): x is string => !!x);
          const gone = ids.filter((x) => !keepIds.includes(x));
          if (reject.reason === "out_of_stock" && ids.length > 1 && gone.length === 0) return setError("Tick the items that are out of stock");
          act("reject", reject.reason === "out_of_stock" && ids.length > 1 ? { ...reject, out_of_stock_items: gone } : reject, "Order cancelled");
        }}>
          <ErrorNote message={error} />
          <Field label="Reason" htmlFor="rr">
            <Select id="rr" value={reject.reason} onChange={(e) => setReject({ ...reject, reason: e.target.value })}>
              {REJECT_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          {reject.reason === "out_of_stock" && (o.items.length > 1 ? (
            <fieldset className="flex flex-col gap-1.5" data-testid="oos-items">
              <legend className="mb-1 text-sm font-medium">Which items are out of stock?</legend>
              {o.items.map((it) => it.id && (
                <label key={it.id} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-peacock" checked={!keepIds.includes(it.id)}
                    onChange={(e) => setKeepIds((k) => e.target.checked ? k.filter((x) => x !== it.id) : [...k, it.id!])} />
                  <span>{it.title}{it.variant_label ? `, ${it.variant_label}` : ""}</span>
                </label>
              ))}
              <p className="text-sm text-ink-soft">Their stock in this order&apos;s warehouse is set to 0 so they stop selling. Other items keep their stock.</p>
            </fieldset>
          ) : (
            <p className="text-sm text-ink-soft">Its stock in this order&apos;s warehouse is set to 0 so it stops selling.</p>
          ))}
          <TextField label="Note (optional)" value={reject.note} onChange={(e) => setReject({ ...reject, note: e.target.value })} maxLength={200} />
          <Button type="submit" variant="buy" loading={busy}>Cancel order</Button>
        </form>
      </Modal>
    </div>
  );
}

/** Our own delivery partner on the seller's order: what happens next, the pickup code and who is coming. */
function FleetCard({ f, status }: { f: SellerFleet; status: string }) {
  const step = f.step;
  const delivered = status === "delivered";
  return (
    <section className="overflow-hidden rounded-xl bg-white ring-1 ring-peacock/20" data-testid="fleet-card">
      <div className="flex items-center gap-3 bg-peacock-light/60 px-4 py-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-peacock text-white"><Bike className="h-5 w-5" aria-hidden /></span>
        <div className="min-w-0">
          <h2 className="font-semibold">Delivered by our partner</h2>
          <p className="text-sm text-ink-soft">
            {!f.active
              ? f.choice
                ? "Hand it to our delivery partner (tap Ready for pickup), or ship it by courier yourself."
                : "Pack the order and tap Ready for pickup. Our delivery partner collects it from you."
              : delivered
                ? "Delivered to the customer."
                : step?.label ?? "With the delivery team"}
          </p>
        </div>
      </div>
      {f.active && !delivered && (
        <div className="flex flex-col gap-3 p-4">
          {f.pickup_code && (
            <div className="flex items-center gap-3 rounded-xl bg-marigold-light/70 p-3">
              <KeyRound className="h-5 w-5 shrink-0 text-marigold-dark" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Pickup code</p>
                <p className="font-mono text-3xl font-bold tracking-[0.3em]" data-testid="pickup-code-seller">{f.pickup_code}</p>
                <p className="text-xs text-ink-soft">Tell this to the delivery partner only when you hand over the package.</p>
              </div>
            </div>
          )}
          {f.partner ? (
            <div className="flex items-center gap-3">
              {f.partner.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.partner.photo} alt="" className="h-12 w-12 rounded-full object-cover" />
              ) : (
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-peacock-light font-bold text-peacock">{f.partner.name.slice(0, 1)}</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{f.partner.name}</p>
                <p className="text-sm text-ink-soft">{f.partner.vehicle}{f.partner.vehicle_no ? ` · ${f.partner.vehicle_no}` : ""}</p>
              </div>
              <a href={telUrl(f.partner.phone)} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-peacock px-3 text-sm font-semibold text-white"><Phone className="h-4 w-4" aria-hidden /> Call</a>
            </div>
          ) : (
            <p className={clsx("flex items-center gap-2 text-sm", step?.status === "offered" ? "text-marigold-dark" : "text-ink-soft")}>
              <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-marigold/60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-marigold" /></span>
              Finding a delivery partner near you…
            </p>
          )}
          {f.ready_for_pickup_at && <p className="text-xs text-ink-faint">Ready for pickup since {dateTime(f.ready_for_pickup_at)}</p>}
        </div>
      )}
    </section>
  );
}
