"use client";

import clsx from "clsx";
import { Banknote, CreditCard, Tag } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AddressForm } from "@/components/address-form";
import { Button, ErrorNote, PageLoader, ProductImage } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { rupees } from "@/lib/format";
import { payWithRazorpay } from "@/lib/razorpay";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { Address, CartView, CheckoutPayload, OrderDetail } from "@/lib/types";

type Quote = CartView & { coupon: { code: string; discount: number; description?: string; error: string | null } | null };
function newIdempotencyKey() {
  return (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9-]/g, "");
}
type OfferCoupon = { code: string; description: string; min_order_paise: number };

export default function CheckoutPage() {
  const router = useRouter();
  const { user, ready, refreshCart } = useSession();
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState<"online" | "cod">("online");
  const [quote, setQuote] = useState<Quote | null>(null);
  const site = useSite();
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<string | null>(null);
  const [offers, setOffers] = useState<OfferCoupon[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  // One key per checkout visit: a double click or a retry after a network error cannot create two orders.
  const [idempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (ready && !user) router.replace("/login?next=/checkout");
  }, [ready, user, router]);

  const loadAddresses = useCallback(async () => {
    const list = await api<Address[]>("/api/addresses");
    setAddresses(list);
    setAddressId((cur) => cur ?? list.find((a) => a.is_default)?.id ?? list[0]?.id ?? null);
    if (!list.length) setAdding(true);
  }, []);

  useEffect(() => {
    if (user) loadAddresses().catch((e) => setError(e.message));
  }, [user, loadAddresses]);

  useEffect(() => {
    if (!addressId) return;
    api<Quote>("/api/checkout/quote", { method: "POST", body: { address_id: addressId, payment_method: method, coupon_code: coupon } })
      .then((q) => {
        setQuote(q);
        if (method === "online" && !q.online_available) setMethod("cod");
        if (q.coupon?.error) setCoupon(null);
      })
      .catch((e) => setError(e.message));
  }, [addressId, method, coupon]);

  useEffect(() => {
    if (user && site.features.coupons) api<{ items: OfferCoupon[] }>("/api/checkout/coupons").then((r) => setOffers(r.items)).catch(() => {});
  }, [user, site.features.coupons]);

  async function place() {
    if (!addressId || !quote) return;
    setPlacing(true);
    setError(null);
    try {
      const r = await api<{ order: OrderDetail; payment: CheckoutPayload | null }>("/api/orders", {
        method: "POST",
        body: { address_id: addressId, payment_method: method, idempotency_key: idempotencyKey, expected_total: quote.summary.grand_total, coupon_code: quote.coupon && !quote.coupon.error ? quote.coupon.code : null },
      });
      await refreshCart();
      if (r.payment) {
        try {
          const paid = await payWithRazorpay(r.payment);
          router.replace(paid ? `/orders/${r.order.id}?placed=1` : `/orders/${r.order.id}`);
        } catch (e) {
          router.replace(`/orders/${r.order.id}?payment_error=${encodeURIComponent(e instanceof Error ? e.message : "Payment failed")}`);
        }
      } else {
        router.replace(`/orders/${r.order.id}?placed=1`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not place the order");
      if (e instanceof ApiError && (e.code === "total_changed" || e.code === "cart_changed")) {
        setQuote(await api<Quote>("/api/checkout/quote", { method: "POST", body: { address_id: addressId, payment_method: method, coupon_code: coupon } }));
      }
      setPlacing(false);
    }
  }

  if (!ready || !user || addresses === null) return <PageLoader />;
  const s = quote?.summary;
  const empty = quote && quote.summary.item_count === 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="flex flex-col gap-4">
        <section className="rounded-xl bg-white p-4 sm:p-5">
          <h2 className="mb-3 text-xl font-semibold">Delivery address</h2>
          {adding ? (
            <AddressForm
              onSaved={async (a) => {
                setAdding(false);
                await loadAddresses();
                setAddressId(a.id);
              }}
              onCancel={addresses.length ? () => setAdding(false) : undefined}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {addresses.map((a) => (
                <label key={a.id} className={clsx("flex cursor-pointer gap-3 rounded-lg border-2 p-3", addressId === a.id ? "border-peacock bg-peacock-light/40" : "border-line")}>
                  <input type="radio" name="address" className="mt-1 accent-peacock" checked={addressId === a.id} onChange={() => setAddressId(a.id)} />
                  <span>
                    <span className="font-semibold">{a.full_name}</span> <span className="text-ink-soft">{a.phone}</span>
                    <span className="block text-ink-soft">
                      {[a.line1, a.line2, a.landmark, a.city].filter(Boolean).join(", ")}, {a.state} {a.pincode}
                    </span>
                  </span>
                </label>
              ))}
              <Button variant="ghost" className="self-start" onClick={() => setAdding(true)}>Add a new address</Button>
            </div>
          )}
        </section>

        <section className="rounded-xl bg-white p-4 sm:p-5">
          <h2 className="mb-3 text-xl font-semibold">Payment</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={clsx("flex cursor-pointer items-start gap-3 rounded-lg border-2 p-3", method === "online" ? "border-peacock bg-peacock-light/40" : "border-line", quote && !quote.online_available && "cursor-not-allowed opacity-50")}>
              <input type="radio" name="pay" className="mt-1 accent-peacock" checked={method === "online"} disabled={!!quote && !quote.online_available} onChange={() => setMethod("online")} />
              <span>
                <span className="flex items-center gap-2 font-semibold"><CreditCard className="h-4 w-4" /> Pay online</span>
                <span className="text-sm text-ink-soft">UPI, cards, net banking and wallets via Razorpay</span>
              </span>
            </label>
            <label className={clsx("flex cursor-pointer items-start gap-3 rounded-lg border-2 p-3", method === "cod" ? "border-peacock bg-peacock-light/40" : "border-line", quote && !quote.cod_available && "cursor-not-allowed opacity-50")}>
              <input type="radio" name="pay" className="mt-1 accent-peacock" checked={method === "cod"} disabled={!!quote && !quote.cod_available} onChange={() => setMethod("cod")} />
              <span>
                <span className="flex items-center gap-2 font-semibold"><Banknote className="h-4 w-4" /> Cash on delivery</span>
                <span className="text-sm text-ink-soft">Pay when each package arrives{s?.cod_fee ? ` (+${rupees(s.cod_fee)})` : ""}</span>
              </span>
            </label>
          </div>
          {method === "cod" && quote && quote.cod_allowed === false && (
            <p className="mt-2 text-sm text-vermilion">Cash on delivery is available up to {rupees(quote.cod_max_order_paise)}. Please pay online for this order.</p>
          )}
        </section>

        {site.features.coupons && quote && (
          <section className="rounded-xl bg-white p-4 sm:p-5">
            <h2 className="mb-3 flex items-center gap-2 text-xl font-semibold"><Tag className="h-5 w-5 text-peacock" /> Coupons and offers</h2>
            {quote.coupon && !quote.coupon.error ? (
              <div className="flex items-center justify-between gap-3 rounded-lg bg-leaf-light p-3">
                <p><span className="font-semibold text-leaf">{quote.coupon.code}</span> applied. You save {rupees(quote.coupon.discount)}.</p>
                <Button variant="ghost" size="sm" onClick={() => { setCoupon(null); setCouponInput(""); }}>Remove</Button>
              </div>
            ) : (
              <>
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (couponInput.trim()) setCoupon(couponInput.trim()); }}>
                  <label htmlFor="cpn" className="sr-only">Coupon code</label>
                  <input id="cpn" value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} placeholder="Enter coupon code" className="h-10 flex-1 rounded-lg border border-line px-3 uppercase" />
                  <Button type="submit" variant="secondary">Apply</Button>
                </form>
                {quote.coupon?.error && <p className="mt-1 text-sm text-vermilion">{quote.coupon.code}: {quote.coupon.error}</p>}
                {offers.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-2">
                    {offers.map((o) => (
                      <li key={o.code} className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-peacock/40 p-3">
                        <div>
                          <p className="font-semibold text-peacock">{o.code}</p>
                          <p className="text-sm text-ink-soft">{o.description}</p>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => { setCouponInput(o.code); setCoupon(o.code); }}>Apply</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}

        {quote && (
          <section className="rounded-xl bg-white p-4 sm:p-5">
            <h2 className="mb-3 text-xl font-semibold">Review items</h2>
            <p className="mb-3 text-sm text-ink-soft">
              Items from different sellers arrive in separate packages{quote.groups.length > 1 ? ` (${quote.groups.length} packages)` : ""}.
            </p>
            <div className="flex flex-col gap-4">
              {quote.groups.map((g) => (
                <div key={g.seller.id}>
                  <p className="mb-1 text-sm font-semibold text-ink-soft">From {g.seller.name}{g.shipping_fee ? `, delivery ${rupees(g.shipping_fee)}` : ", free delivery"}</p>
                  {g.lines.map((l) => (
                    <div key={l.id} className="flex items-center gap-3 py-1.5">
                      <ProductImage src={l.image} alt="" className="h-14 w-14 shrink-0" />
                      <div className="flex-1 text-[15px]">
                        <p className="line-clamp-1">{l.title}</p>
                        <p className="text-sm text-ink-faint">{l.variant_label ? `${l.variant_label}, ` : ""}qty {l.qty}</p>
                        {l.problem && <p className="text-sm font-semibold text-vermilion">{l.problem}</p>}
                      </div>
                      <p className="font-semibold">{rupees(l.line_total)}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <aside className="flex flex-col gap-3 self-start rounded-xl bg-white p-4 lg:sticky lg:top-36">
        <h2 className="text-lg font-semibold text-ink-soft">Order summary</h2>
        {s ? (
          <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[15px]">
            <dt>Items ({s.item_count})</dt>
            <dd>{rupees(s.items_total)}</dd>
            <dt>Delivery</dt>
            <dd>{s.shipping_total ? rupees(s.shipping_total) : <span className="text-leaf">Free</span>}</dd>
            {s.cod_fee ? (<><dt>Cash on delivery fee</dt><dd>{rupees(s.cod_fee)}</dd></>) : null}
            {quote?.coupon && !quote.coupon.error ? (<><dt className="text-leaf">Coupon {quote.coupon.code}</dt><dd className="text-leaf">−{rupees(quote.coupon.discount)}</dd></>) : null}
            <dt className="border-t border-dashed border-line pt-2 font-display text-lg font-semibold">Order total</dt>
            <dd className="border-t border-dashed border-line pt-2 font-display text-lg font-semibold">{rupees(s.grand_total)}</dd>
          </dl>
        ) : (
          <p className="text-ink-faint">Choose an address to see delivery charges.</p>
        )}
        <ErrorNote message={error} />
        {empty ? (
          <p className="text-ink-soft">Your cart is empty.</p>
        ) : (
          <Button
            variant="buy"
            size="lg"
            loading={placing}
            disabled={!addressId || !quote || quote.summary.has_problems || (method === "cod" && quote.cod_allowed === false)}
            onClick={place}
          >
            {method === "online" ? `Pay ${s ? rupees(s.grand_total) : ""}` : "Place order"}
          </Button>
        )}
        <p className="text-xs text-ink-faint">Prices include GST. Each seller issues their own tax invoice.</p>
      </aside>
    </div>
  );
}
