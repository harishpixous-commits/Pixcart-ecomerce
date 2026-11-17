"use client";

import clsx from "clsx";
import { CheckCircle2, FileText, LifeBuoy, Star } from "lucide-react";
import { openPdf, ReturnRequestModal, ReturnsList } from "@/components/order-returns";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Button, ErrorNote, Modal, PageLoader, ProductImage, StatusPill, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date, dateTime, PAYMENT_STATUS_LABEL, rupees, SUB_STATUS_LABEL } from "@/lib/format";
import { payWithRazorpay } from "@/lib/razorpay";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { OrderDetail, ReturnableItem, ReturnView, SubOrderView } from "@/lib/types";

const STEPS = ["placed", "confirmed", "packed", "shipped", "delivered"] as const;

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
  const [returnable, setReturnable] = useState<{ items: Record<string, ReturnableItem[]>; returns: ReturnView[]; needs_upi: boolean } | null>(null);
  const [returnSub, setReturnSub] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOrder(await api<OrderDetail>(`/api/orders/${id}`));
      setReturnable(await api(`/api/orders/${id}/returnable`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the order");
    }
  }, [id]);
  useEffect(() => {
    if (ready && !user) router.replace(`/login?next=/orders/${id}`);
    if (user) load();
  }, [ready, user, id, load, router]);

  async function pay() {
    if (!order?.payment) return;
    setBusy(true);
    setError(null);
    try {
      const paid = await payWithRazorpay(order.payment);
      if (paid) setOrder(paid);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!cancelSub) return;
    setBusy(true);
    try {
      setOrder(await api<OrderDetail>(`/api/orders/${id}/cancel`, { method: "POST", body: { sub_order_id: cancelSub.id, reason: reason.trim() || "Changed my mind" } }));
      toast(order?.payment_status === "paid" ? "Cancelled. Your refund has been started." : "Cancelled");
      setCancelSub(null);
      setReason("");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not cancel", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!order) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const a = order.ship_to;
  return (
    <div className="flex flex-col gap-4">
      {sp.get("placed") && order.status === "placed" && (
        <div className="flex items-center gap-3 rounded-xl bg-leaf-light p-4 text-leaf">
          <CheckCircle2 className="h-7 w-7 shrink-0" />
          <div>
            <p className="font-display text-xl font-semibold">Order placed</p>
            <p className="text-ink-soft">We have sent your order to the seller{order.sub_orders.length > 1 ? "s" : ""}. You can track each package below.</p>
          </div>
        </div>
      )}
      <ErrorNote message={error} />
      {order.status === "pending_payment" && order.payment && (
        <div className="flex flex-col gap-3 rounded-xl bg-marigold-light p-4 sm:flex-row sm:items-center">
          <p className="flex-1">Your payment is not complete. Items are held for you until {dateTime(order.payment_expires_at)}.</p>
          <Button variant="buy" onClick={pay} loading={busy}>Pay {rupees(order.grand_total)}</Button>
        </div>
      )}

      <section className="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-white p-4">
        <div>
          <h1 className="text-2xl font-semibold">Order {order.number}</h1>
          <p className="text-sm text-ink-faint">Placed {dateTime(order.created_at)}</p>
        </div>
        <div className="text-right">
          <p className="font-display text-2xl font-bold">{rupees(order.grand_total)}</p>
          <p className="text-sm text-ink-soft">
            {order.payment_method === "cod" ? "Cash on delivery" : "Paid online"}: {PAYMENT_STATUS_LABEL[order.payment_status] ?? order.payment_status}
          </p>
        </div>
      </section>

      {order.sub_orders.map((s, i) => (
        <section key={s.id} className="rounded-xl bg-white">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <p className="font-semibold">
              Package {i + 1} of {order.sub_orders.length}, sold by{" "}
              {s.seller ? <Link href={`/store/${s.seller.slug}`} className="text-peacock hover:underline">{s.seller.name}</Link> : "seller"}
            </p>
            <StatusPill status={s.status} label={SUB_STATUS_LABEL[s.status]} />
          </header>
          <div className="flex flex-col gap-4 p-4">
            <Progress sub={s} />
            {s.tracking_number && (
              <p className="text-sm">
                {s.courier_name} tracking number <span className="font-semibold">{s.tracking_number}</span>
                {s.tracking_url && (
                  <>
                    {" "}<a href={s.tracking_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-peacock hover:underline">Track package</a>
                  </>
                )}
              </p>
            )}
            {s.items.map((it, j) => (
              <div key={j} className="flex gap-3">
                <ProductImage src={it.image} alt={it.title} className="h-20 w-20 shrink-0" />
                <div className="flex-1">
                  <p className="font-medium">{it.title}</p>
                  {it.variant_label && <p className="text-sm text-ink-faint">{it.variant_label}</p>}
                  <p className="text-sm text-ink-soft">Qty {it.qty} at {rupees(it.unit_price)}</p>
                </div>
                <p className="font-semibold">{rupees(it.line_total)}</p>
              </div>
            ))}
            {s.expected_delivery_at && ["placed", "confirmed", "packed", "shipped"].includes(s.status) && (
              <p className="text-sm text-ink-soft">Expected by {date(s.expected_delivery_at)}</p>
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

      {returnable && (
        <ReturnsList
          returns={returnable.returns}
          onCancel={async (rid) => {
            await api(`/api/returns/${rid}/cancel`, { method: "POST" });
            toast("Return cancelled");
            load();
          }}
        />
      )}
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

      <section className="grid gap-4 rounded-xl bg-white p-4 sm:grid-cols-2">
        <div>
          <h2 className="mb-1 font-semibold">Delivery address</h2>
          <p className="text-ink-soft">{a.full_name}, {a.phone}<br />{[a.line1, a.line2, a.landmark].filter(Boolean).join(", ")}<br />{a.city}, {a.state} {a.pincode}</p>
        </div>
        <div>
          <h2 className="mb-1 font-semibold">Payment summary</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-[15px]">
            <dt>Items</dt><dd>{rupees(order.items_total)}</dd>
            <dt>Delivery</dt><dd>{order.shipping_total ? rupees(order.shipping_total) : "Free"}</dd>
            {order.cod_fee > 0 && (<><dt>Cash on delivery fee</dt><dd>{rupees(order.cod_fee)}</dd></>)}
            {(order.discount_total ?? 0) > 0 && (<><dt className="text-leaf">Coupon {order.coupon_code}</dt><dd className="text-leaf">−{rupees(order.discount_total ?? 0)}</dd></>)}
            <dt className="font-semibold">Total</dt><dd className="font-semibold">{rupees(order.grand_total)}</dd>
            {order.refunded_total > 0 && (<><dt className="text-leaf">Refunded</dt><dd className="text-leaf">{rupees(order.refunded_total)}</dd></>)}
          </dl>
          {order.refunds.length > 0 && (
            <p className="mt-2 text-sm text-ink-soft">Refunds reach your original payment method in 5 to 7 working days.</p>
          )}
        </div>
      </section>

      <a href={`/support/new?order=${order.id}&subject=${encodeURIComponent(`Help with order ${order.number}`)}`} className="inline-flex items-center gap-2 self-start rounded-lg px-1 font-semibold text-peacock hover:underline">
        <LifeBuoy className="h-4 w-4" /> Need help with this order?
      </a>

      <Modal open={!!cancelSub} onClose={() => setCancelSub(null)} title="Cancel this package?">
        <p className="mb-3 text-ink-soft">
          {order.payment_status === "paid" || order.payment_status === "partially_refunded"
            ? `We will refund ${cancelSub ? rupees(cancelSub.total) : ""} to your original payment method.`
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
