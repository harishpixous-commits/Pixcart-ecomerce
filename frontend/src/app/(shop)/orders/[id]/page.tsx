"use client";

import clsx from "clsx";
import { Building2, ChevronRight, FileText, Leaf, LifeBuoy, MapPin, RotateCcw, Star, Truck } from "lucide-react";
import { OrderPayment, type PaymentArrival } from "@/components/order-payment";
import { openPdf, ReturnRequestModal, ReturnsList } from "@/components/order-returns";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { BillDetails } from "@/components/bill";
import { DeliveryTracking } from "@/components/delivery/tracking";
import { usePolling } from "@/components/delivery/trip";
import { PushPrompt } from "@/components/push-prompt";
import { Button, ErrorNote, Modal, PageLoader, Pill, ProductImage, StatusPill, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date, dateTime, PAYMENT_STATUS_LABEL, rupees, SUB_STATUS_LABEL } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { OrderDetail, ReturnableItem, ReturnView, SubOrderView } from "@/lib/types";

const SURFACE = "rounded-2xl bg-white shadow-sm ring-1 ring-black/5";
const CARD = `${SURFACE} p-4 sm:p-5`;
const STEPS = ["placed", "confirmed", "packed", "shipped", "delivered"] as const;

type Returnable = { items: Record<string, ReturnableItem[]>; returns: ReturnView[]; needs_upi: boolean };

/** The delivery address kept on the order. Older orders have no label, instructions or no_bag. */
function shipTo(raw: Record<string, unknown>) {
  const text = (key: string) => {
    const v = raw[key];
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    name: text("full_name"),
    phone: text("phone"),
    street: [text("line1"), text("line2"), text("landmark")].filter(Boolean).join(", "),
    place: [text("city"), [text("state"), text("pincode")].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    label: text("label") || (raw.kind === "home" ? "Home" : raw.kind === "work" ? "Work" : ""),
    instructions: text("instructions"),
    noBag: raw.no_bag === true,
  };
}

function Progress({ sub }: { sub: SubOrderView }) {
  if (sub.status === "cancelled") {
    return <p className="text-sm text-vermilion">Cancelled{sub.cancelled_at ? ` on ${date(sub.cancelled_at)}` : ""}{sub.cancel_reason ? `: ${sub.cancel_reason}` : ""}</p>;
  }
  if (sub.status === "pending_payment") return <p className="text-sm text-[#8A5A00]">Waiting for payment</p>;
  const idx = STEPS.indexOf(sub.status as (typeof STEPS)[number]);
  return (
    <ol className="grid grid-cols-5 gap-1" aria-label="Delivery progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex flex-col gap-1">
          <span className={clsx("h-1.5 rounded-full", i <= idx ? "bg-leaf" : "bg-line")} />
          <span className={clsx("text-[11px] leading-tight sm:text-xs", i <= idx ? "font-semibold text-ink" : "text-ink-faint")}>{SUB_STATUS_LABEL[s].replace(" by seller", "")}</span>
        </li>
      ))}
    </ol>
  );
}

function OrderView() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { user, ready } = useSession();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(sp.get("payment_error"));
  const [cancelSub, setCancelSub] = useState<SubOrderView | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const site = useSite();
  const [returnable, setReturnable] = useState<Returnable | null>(null);
  const [returnSub, setReturnSub] = useState<string | null>(null);
  // What the address said on arrival (from checkout, or back from Razorpay), read once: the address is then tidied so a
  // reload does not open the payment window again.
  const [arrival] = useState<PaymentArrival>(() => ({ outcome: sp.get("payment") ?? "", reason: sp.get("reason") ?? "", open: sp.get("pay") === "1" }));
  const [placed] = useState(() => sp.get("placed") === "1");
  useEffect(() => {
    if (sp.get("pay") || sp.get("payment") || sp.get("reason") || sp.get("placed")) router.replace(`/orders/${id}`, { scroll: false });
  }, [sp, id, router]);

  const load = useCallback(() => {
    api<OrderDetail>(`/api/orders/${id}`)
      .then((o) => {
        setOrder(o);
        return api<Returnable>(`/api/orders/${id}/returnable`).then(setReturnable);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the order"));
  }, [id]);
  useEffect(() => {
    if (ready && !user) router.replace(`/login?next=/orders/${id}`);
    if (user) load();
  }, [ready, user, id, load, router]);

  // While our delivery partner has a package (or one is being assigned), follow along every 15 seconds.
  const followFleet = !!order?.fleet && Object.entries(order.fleet).some(([sid, f]) => {
    const sub = order.sub_orders.find((x) => x.id === sid);
    return !!sub && ["packed", "shipped"].includes(sub.status) && (!!f.ready_for_pickup_at || !!f.assignment);
  });
  const refreshOrder = useCallback(() => {
    api<OrderDetail>(`/api/orders/${id}`).then(setOrder).catch(() => {});
  }, [id]);
  usePolling(refreshOrder, 15_000, followFleet);

  async function cancel() {
    if (!cancelSub) return;
    setBusy(true);
    try {
      const refundBefore = order?.refunded_total ?? 0;
      const next = await api<OrderDetail>(`/api/orders/${id}/cancel`, { method: "POST", body: { sub_order_id: cancelSub.id, reason: reason.trim() || "Changed my mind" } });
      setOrder(next);
      const refunded = (next.refunded_total ?? 0) - refundBefore;
      toast(refunded > 0 ? `Cancelled. A refund of ${rupees(refunded)} has been started.` : "Cancelled");
      setCancelSub(null);
      setReason("");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not cancel", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!order) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const a = shipTo(order.ship_to);
  return (
    <div className="flex flex-col gap-4">
      <OrderPayment order={order} onOrder={setOrder} arrival={arrival} placed={placed} />
      <ErrorNote message={error} />
      {order.sub_orders.some((s) => ["placed", "confirmed", "packed", "shipped"].includes(s.status)) && (
        <PushPrompt app="shop" title="Get delivery updates as notifications" text="Know the moment your package is picked up, on the way, or at your door, with the OTP to share." />
      )}

      <section className={CARD}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold">Order {order.number}</h1>
            <p className="text-sm text-ink-faint">Placed {dateTime(order.created_at)}</p>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-dashed border-line pt-3 sm:flex-col sm:items-end sm:gap-1 sm:border-0 sm:pt-0">
            <p className="font-display text-2xl font-bold leading-tight tabular-nums">{rupees(order.grand_total)}</p>
            <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-sm text-ink-soft">
              <span>{order.payment_method === "cod" ? "Cash on delivery" : "Online payment"}</span>
              {order.payment_status !== "cod" && <StatusPill status={order.payment_status} label={PAYMENT_STATUS_LABEL[order.payment_status]} />}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {order.sub_orders.map((s, i) => (
            <section key={s.id} className={clsx(SURFACE, "overflow-hidden")}>
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
                <p className="min-w-0 font-semibold">
                  Package {i + 1} of {order.sub_orders.length}, sold by{" "}
                  {s.seller ? <Link href={`/store/${s.seller.slug}`} className="text-peacock hover:underline">{s.seller.name}</Link> : "seller"}
                </p>
                <StatusPill status={s.status} label={SUB_STATUS_LABEL[s.status]} />
              </header>
              <div className="flex flex-col gap-4 p-4 sm:p-5">
                <Progress sub={s} />
                {order.fleet?.[s.id] && s.status !== "cancelled" && (
                  <DeliveryTracking orderId={order.id} subId={s.id} f={order.fleet[s.id]} packageStatus={s.status} onChanged={refreshOrder} />
                )}
                {s.tracking_number && !order.fleet?.[s.id] && (
                  <p className="flex items-start gap-2 rounded-xl bg-mist px-3 py-2 text-sm">
                    <Truck className="mt-0.5 h-4 w-4 shrink-0 text-peacock" aria-hidden />
                    <span className="min-w-0 break-words">
                      {s.courier_name} tracking number <span className="font-semibold">{s.tracking_number}</span>
                      {s.tracking_url && (
                        <>
                          {" "}<a href={s.tracking_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-peacock hover:underline">Track package</a>
                        </>
                      )}
                    </span>
                  </p>
                )}
                <ul className="flex flex-col gap-3">
                  {s.items.map((it, j) => (
                    <li key={j} className="flex gap-3">
                      <ProductImage src={it.image} alt={it.title} className="h-16 w-16 shrink-0 rounded-xl sm:h-20 sm:w-20" />
                      <div className="min-w-0 flex-1">
                        {it.product_slug ? (
                          <Link href={`/p/${it.product_slug}`} className="line-clamp-2 font-medium leading-snug hover:text-peacock">{it.title}</Link>
                        ) : (
                          <p className="line-clamp-2 font-medium leading-snug">{it.title}</p>
                        )}
                        {it.variant_label && <p className="text-sm text-ink-faint">{it.variant_label}</p>}
                        <p className="text-sm text-ink-soft">Qty {it.qty} at {rupees(it.unit_price)}</p>
                      </div>
                      <p className="font-semibold tabular-nums">{rupees(it.line_total)}</p>
                    </li>
                  ))}
                </ul>
                {s.expected_delivery_at && ["placed", "confirmed", "packed", "shipped"].includes(s.status) && (
                  <p className="text-sm text-ink-soft">Expected by <span className="font-semibold text-ink">{date(s.expected_delivery_at)}</span></p>
                )}
                <div className="flex flex-wrap gap-2">
                  {s.can_cancel && <Button variant="danger" size="sm" onClick={() => setCancelSub(s)}>Cancel this package</Button>}
                  {site.features.returns && (returnable?.items[s.id] ?? []).some((i) => i.eligible) && (
                    <Button variant="secondary" size="sm" onClick={() => setReturnSub(s.id)}>Return items</Button>
                  )}
                  {s.invoice_number && (
                    <Button variant="ghost" size="sm" onClick={() => openPdf(`/api/invoices/${s.id}.pdf`, (m) => toast(m, "error"))}>
                      <FileText className="h-4 w-4" /> Invoice {s.invoice_number}
                    </Button>
                  )}
                  {site.features.reviews && s.status === "delivered" && s.items[0]?.product_slug && (
                    <a href={`/p/${s.items[0].product_slug}#reviews`} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-peacock hover:bg-peacock-light">
                      <Star className="h-4 w-4" /> Rate this product
                    </a>
                  )}
                </div>
              </div>
            </section>
          ))}

          {returnable && returnable.returns.length > 0 && (
            <div className="overflow-hidden rounded-2xl shadow-sm ring-1 ring-black/5">
              <ReturnsList
                returns={returnable.returns}
                onCancel={async (rid) => {
                  await api(`/api/returns/${rid}/cancel`, { method: "POST" });
                  toast("Return cancelled");
                  load();
                }}
              />
            </div>
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <section className={CARD} aria-labelledby="ship-h">
            <div className="flex items-center justify-between gap-2">
              <h2 id="ship-h" className="flex items-center gap-2 text-lg font-semibold">
                <MapPin className="h-5 w-5 text-peacock" aria-hidden /> Delivery address
              </h2>
              {a.label && <Pill tone="blue">{a.label}</Pill>}
            </div>
            <p className="mt-2 break-words font-semibold" translate="no">
              {a.name}
              {a.phone && <span className="font-normal text-ink-soft">, {a.phone}</span>}
            </p>
            <p className="break-words text-ink-soft" translate="no">
              {a.street}
              {a.street && a.place && <br />}
              {a.place}
            </p>
            {(a.instructions || a.noBag) && (
              <div className="mt-3 flex flex-col items-start gap-2">
                {a.instructions && (
                  <p className="w-full break-words rounded-xl bg-mist px-3 py-2 text-sm text-ink-soft">
                    <span className="font-semibold text-ink">Instructions:</span> {a.instructions}
                  </p>
                )}
                {a.noBag && <Pill tone="green"><Leaf className="mr-1 h-3.5 w-3.5" aria-hidden />No bag</Pill>}
              </div>
            )}
            {order.buyer_gstin && (
              <div className="mt-4 rounded-xl bg-peacock-light/60 p-3 ring-1 ring-inset ring-peacock/15" data-testid="business-purchase">
                <p className="flex items-center gap-2 font-semibold text-peacock-dark">
                  <Building2 className="h-4 w-4 shrink-0" aria-hidden /> Business purchase
                </p>
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  {order.buyer_business && (
                    <>
                      <dt className="text-ink-soft">Business</dt>
                      <dd className="break-words font-semibold">{order.buyer_business}</dd>
                    </>
                  )}
                  <dt className="text-ink-soft">GSTIN</dt>
                  <dd className="break-all font-semibold tracking-wide">{order.buyer_gstin}</dd>
                </dl>
                <p className="mt-2 text-xs text-ink-faint">The tax invoices for this order are billed to this business.</p>
              </div>
            )}
          </section>

          <section className={clsx(CARD, "flex flex-col gap-3")}>
            <BillDetails
              bill={{
                items_total: order.items_total,
                shipping_total: order.shipping_total,
                cod_fee: order.cod_fee,
                fees: order.fees,
                tip: order.tip,
                coupon_code: order.coupon_code,
                coupon_discount: order.discount_total,
                grand_total: order.grand_total,
              }}
              totalLabel="Order total"
              deliveryLabel="Delivery"
            />
            {order.refunded_total > 0 && (
              <p className="flex items-center justify-between gap-3 border-t border-dashed border-line pt-3 text-[15px] font-semibold text-leaf" data-testid="order-refunded">
                <span className="inline-flex items-center gap-1.5">
                  <RotateCcw className="h-4 w-4" aria-hidden /> Refunded
                </span>
                <span className="tabular-nums">{rupees(order.refunded_total)}</span>
              </p>
            )}
            {order.refunds.length > 0 && (
              <p className="text-sm text-ink-soft">Refunds reach your original payment method in 5 to 7 working days.</p>
            )}
            {order.fee_invoice_number && (
              <Button variant="ghost" size="sm" className="self-start" data-testid="fee-invoice"
                onClick={() => openPdf(`/api/orders/${order.id}/fee-invoice.pdf`, (m) => toast(m, "error"))}>
                <FileText className="h-4 w-4" /> Invoice for the fees {order.fee_invoice_number}
              </Button>
            )}
          </section>

          <a href={`/support/new?order=${order.id}&subject=${encodeURIComponent(`Help with order ${order.number}`)}`}
            className={clsx(SURFACE, "flex items-center gap-3 px-4 py-3 font-semibold text-peacock transition-colors hover:bg-peacock-light/50 sm:px-5")}>
            <LifeBuoy className="h-5 w-5 shrink-0" aria-hidden /> Need help with this order?
            <ChevronRight className="ml-auto h-4 w-4 shrink-0" aria-hidden />
          </a>
        </aside>
      </div>

      {returnSub && returnable && (
        <ReturnRequestModal
          subId={returnSub}
          items={returnable.items[returnSub] ?? []}
          needsUpi={returnable.needs_upi}
          open
          onClose={() => setReturnSub(null)}
          onDone={() => { setReturnSub(null); load(); }}
        />
      )}

      <Modal open={!!cancelSub} onClose={() => setCancelSub(null)} title="Cancel this package?">
        <p className="mb-3 text-ink-soft">
          {(cancelSub?.refund_if_cancelled ?? 0) > 0
            ? `We will refund ${rupees(cancelSub!.refund_if_cancelled!)} to your original payment method.`
            : order.payment_method === "online" && order.payment_status === "pending"
              ? "The payment for this order is not complete, so nothing is refunded."
              : "Nothing has been charged for this package."}
        </p>
        <label htmlFor="reason" className="text-sm font-medium">Reason (optional)</label>
        <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="For example: ordered by mistake" />
        <div className="mt-4 flex gap-2">
          <Button variant="buy" onClick={cancel} loading={busy}>Cancel package</Button>
          <Button variant="ghost" onClick={() => setCancelSub(null)}>Keep it</Button>
        </div>
      </Modal>
    </div>
  );
}

export default function OrderPage() {
  return (
    <Suspense fallback={<PageLoader />}>
      <OrderView />
    </Suspense>
  );
}
