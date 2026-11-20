"use client";

/*
 * Checkout: delivery address and instructions, the items by seller, "Did you forget?", coupons, a tip for the delivery
 * partner, a GSTIN for business purchases, "no bag", the bill, how to pay and the pay button. On desktop the bill and
 * the pay button sit in a sticky right-hand column; on phones and tablets a slide-to-pay bar stays at the bottom.
 *
 * Every amount comes from the server's quote. The quote is asked for again whenever something that changes it changes
 * (address, payment method, coupon, tip, the cart), and only the newest answer is applied.
 */

import clsx from "clsx";
import { Lock, MapPin, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BillDetails } from "@/components/bill";
import { AddressSection } from "@/components/checkout/address";
import { CARD } from "@/components/checkout/card";
import { BusinessSection, businessErrors, InstructionsSection, NoBagSection, TipSection } from "@/components/checkout/extras";
import { CouponSection, type OfferCoupon } from "@/components/checkout/offers";
import { CancellationNote, PayBar, PaymentMethods, type PayMethod } from "@/components/checkout/payment";
import { BillSkeleton, ItemsReview, ReviewSkeleton } from "@/components/checkout/review";
import { ProductRail } from "@/components/product";
import { Button, ButtonLink, EmptyState, ErrorNote, PageLoader, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { rupees } from "@/lib/format";
import { payWithRazorpay } from "@/lib/razorpay";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { Address, CartView, CheckoutPayload, OrderDetail, ProductCard } from "@/lib/types";

type Quote = CartView & {
  coupon: { code: string; discount: number; description?: string; error: string | null } | null;
  /** The chosen address's saved delivery instructions (and map pin). */
  address?: { instructions: string; lat: number | null; lng: number | null };
  address_id?: string;
};
type QuoteBody = { address_id: string; payment_method: PayMethod; coupon_code: string | null; tip_paise: number };
type QuoteResult = { ok: true; quote: Quote } | { ok: false; error: unknown };

function newIdempotencyKey() {
  return (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9-]/g, "");
}

/** What a quote was worked out for. The bill on screen is current when its key matches the choices on screen. */
function quoteKey(body: QuoteBody, cartCount: number): string {
  return [body.address_id, body.payment_method, body.coupon_code ?? "", body.tip_paise, cartCount].join("|");
}

function scrollToSection(id: string, focusSelector?: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  if (focusSelector) el.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
}

export default function CheckoutPage() {
  const router = useRouter();
  const toast = useToast();
  const site = useSite();
  const { user, ready, cartCount, refreshCart } = useSession();

  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [method, setMethod] = useState<PayMethod>("online");
  const [coupon, setCoupon] = useState<string | null>(null);
  const [couponError, setCouponError] = useState<{ code: string; message: string } | null>(null);
  const [offers, setOffers] = useState<OfferCoupon[]>([]);
  const [tip, setTip] = useState(0);

  const [quote, setQuote] = useState<Quote | null>(null);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [related, setRelated] = useState<ProductCard[]>([]);

  // Instructions typed for each address; an address nobody typed for shows its saved instructions.
  const [notes, setNotes] = useState<Record<string, string | undefined>>({});
  const [saveNote, setSaveNote] = useState(false);
  const [gstin, setGstin] = useState("");
  const [business, setBusiness] = useState("");
  const [bizOpen, setBizOpen] = useState(false);
  const [bizChecked, setBizChecked] = useState(false);
  const [bizServerError, setBizServerError] = useState<string | null>(null);
  const [noBag, setNoBag] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [done, setDone] = useState(false); // the order exists; the page is on its way out
  // One key per checkout visit: a double tap or a retry after a network error cannot create two orders.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [trackQuote] = useState(latestOnly);
  const [trackRelated] = useState(latestOnly);

  useEffect(() => {
    if (ready && !user) router.replace("/login?next=/checkout");
  }, [ready, user, router]);

  const loadAddresses = useCallback(
    () =>
      api<Address[]>("/api/addresses").then((list) => {
        setAddresses(list);
        setAddressId((cur) => cur ?? list.find((a) => a.is_default)?.id ?? list[0]?.id ?? null);
        if (!list.length) setAdding(true);
      }),
    [],
  );

  useEffect(() => {
    if (user) loadAddresses().catch((e) => setLoadError(e instanceof ApiError ? e.message : "Could not load your addresses"));
  }, [user, loadAddresses]);

  const runQuote = useCallback(
    (body: QuoteBody, key: string) =>
      trackQuote(
        api<Quote>("/api/checkout/quote", { method: "POST", body }).then(
          (q): QuoteResult => ({ ok: true, quote: q }),
          (err: unknown): QuoteResult => ({ ok: false, error: err }),
        ),
        (r) => {
          setSettledKey(key);
          if (!r.ok) {
            setQuoteError(r.error instanceof ApiError ? r.error.message : "Could not work out your bill. Try again.");
            return;
          }
          const q = r.quote;
          setQuote(q);
          setQuoteError(null);
          if (body.payment_method === "online" && !q.online_available) setMethod("cod");
          if (q.coupon?.error) {
            // Keep the reason on screen and stop sending the code.
            setCouponError({ code: q.coupon.code, message: q.coupon.error });
            setCoupon(null);
          }
        },
      ),
    [trackQuote],
  );

  // Adding a product from "Did you forget?" changes cartCount, so the bill is worked out again.
  useEffect(() => {
    if (!addressId || done) return;
    const body: QuoteBody = { address_id: addressId, payment_method: method, coupon_code: coupon, tip_paise: tip };
    runQuote(body, quoteKey(body, cartCount));
  }, [addressId, method, coupon, tip, cartCount, done, runQuote]);

  useEffect(() => {
    if (user && site.features.coupons) api<{ items: OfferCoupon[] }>("/api/checkout/coupons").then((r) => setOffers(r.items)).catch(() => {});
  }, [user, site.features.coupons]);

  // "Did you forget?": products from the same categories as the cart (the API takes up to 20 ids).
  const relatedIds = quote
    ? [...new Set(quote.groups.flatMap((g) => g.lines.map((l) => l.product_id ?? "")).filter(Boolean))].slice(0, 20).join(",")
    : "";
  useEffect(() => {
    if (!relatedIds) return;
    trackRelated(api<{ items: ProductCard[] }>("/api/catalog/related", { query: { ids: relatedIds, limit: 10 } }), (r) => setRelated(r.items)).catch(() => {});
  }, [relatedIds, trackRelated]);

  const showBar = !!quote && quote.groups.length > 0;
  // Moves the help button above the pay bar and hides the compare tray on phones (see globals.css).
  useEffect(() => {
    if (!showBar) return;
    document.body.dataset.buyBar = "1";
    return () => {
      delete document.body.dataset.buyBar;
    };
  }, [showBar]);

  if (!ready || !user) return <PageLoader />;
  if (addresses === null) {
    if (!loadError) return <PageLoader />;
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-12 text-center">
        <ErrorNote message={loadError} />
        <Button
          variant="secondary"
          onClick={() => {
            setLoadError(null);
            loadAddresses().catch((e) => setLoadError(e instanceof ApiError ? e.message : "Could not load your addresses"));
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (quote && quote.groups.length === 0 && !done) {
    return <EmptyState title="Your cart is empty" body="Add something you like, then come back here to check out." action={<ButtonLink href="/">Start shopping</ButtonLink>} />;
  }

  const opts = quote?.checkout;
  const summary = quote?.summary;
  const request: QuoteBody | null = addressId ? { address_id: addressId, payment_method: method, coupon_code: coupon, tip_paise: tip } : null;
  const currentKey = request ? quoteKey(request, cartCount) : null;
  const quoting = !!currentKey && !done && currentKey !== settledKey;

  const selected = addresses.find((a) => a.id === addressId) ?? null;
  const savedNote = (quote && quote.address_id === addressId && quote.address ? quote.address.instructions : selected?.instructions) ?? "";
  const noteText = (addressId ? notes[addressId] : undefined) ?? savedNote;

  const biz = businessErrors(gstin, business);
  const bizFilled = gstin.trim() !== "";
  const bizValid = bizFilled && !biz.gstin && !biz.business;

  const blocked = !addressId
    ? "Add a delivery address to continue."
    : !quote
      ? null
      : quote.summary.has_problems
        ? "Some items need your attention. Update your cart to continue."
        : quote.summary.item_count === 0
          ? "Your cart is empty."
          : method === "cod" && quote.cod_allowed === false
            ? "Choose online payment for this order."
            : null;
  const canPay = !!quote && !!addressId && !quoting && !blocked && !done;
  const payText = method === "online" ? (summary ? `Pay ${rupees(summary.grand_total)}` : "Pay") : "Place order";

  async function place() {
    if (!addressId || !quote || !canPay || placing) return;
    if (opts?.gstin_enabled && bizFilled && !bizValid) {
      setBizOpen(true);
      setBizChecked(true);
      setError("Check the GSTIN details, or remove them to continue.");
      requestAnimationFrame(() => scrollToSection("checkout-business", "input[aria-invalid='true']"));
      return;
    }
    setPlacing(true);
    setError(null);
    const instructions = opts?.instructions_enabled ? noteText.trim() : "";
    try {
      if (opts?.instructions_enabled && saveNote && instructions !== savedNote.trim()) {
        await api(`/api/addresses/${addressId}/instructions`, { method: "PATCH", body: { instructions } }).catch(() =>
          toast("Could not save the instructions for next time. They are still sent with this order.", "error"),
        );
      }
      const withBiz = !!opts?.gstin_enabled && bizValid;
      const r = await api<{ order: OrderDetail; payment: CheckoutPayload | null }>("/api/orders", {
        method: "POST",
        body: {
          address_id: addressId,
          payment_method: method,
          idempotency_key: idempotencyKey,
          expected_total: quote.summary.grand_total,
          coupon_code: quote.coupon && !quote.coupon.error ? quote.coupon.code : null,
          tip_paise: quote.summary.tip ?? 0,
          buyer_gstin: withBiz ? gstin.trim() : "",
          buyer_business: withBiz ? business.trim() : "",
          instructions,
          no_bag: !!opts?.no_bag_enabled && noBag,
        },
      });
      setDone(true);
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
      if (e instanceof ApiError) {
        if ((e.code === "total_changed" || e.code === "cart_changed") && request && currentKey) {
          runQuote(request, currentKey);
        } else if (e.code === "invalid_gstin") {
          setBizOpen(true);
          setBizServerError(e.message);
        } else if (e.code === "invalid_tip") {
          setTip(0);
        }
      }
      setPlacing(false);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        <h1 className="font-display text-2xl font-bold text-ink sm:text-[28px]">Checkout</h1>
        <p className="flex items-center gap-1.5 text-sm font-semibold text-leaf">
          <ShieldCheck className="h-4 w-4" aria-hidden /> Safe and secure payments
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-x-6">
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <AddressSection
            addresses={addresses}
            selectedId={addressId}
            onSelect={(id) => {
              setAddressId(id);
              setError(null);
            }}
            adding={adding}
            onAdd={() => setAdding(true)}
            onCancelAdd={addresses.length ? () => setAdding(false) : undefined}
            onSaved={async (a) => {
              setAdding(false);
              await loadAddresses();
              setAddressId(a.id);
            }}
          />

          {opts?.instructions_enabled && addressId && !adding && (
            <InstructionsSection
              text={noteText}
              onText={(t) => setNotes((n) => ({ ...n, [addressId]: t }))}
              save={saveNote}
              onSave={setSaveNote}
            />
          )}

          {quote ? <ItemsReview groups={quote.groups} itemCount={quote.summary.item_count} /> : addressId ? <ReviewSkeleton /> : null}

          {related.length > 0 && (
            // Wider product tiles than the rail's own full-width sizes, since here it sits in the narrower left column.
            <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 lg:[&_.snap-start]:w-1/3 xl:[&_.snap-start]:w-1/4" data-testid="checkout-forgot">
              <ProductRail title="Did you forget?" note="Often added with your items" items={related} showAdd />
            </div>
          )}

          {site.features.coupons && quote && (
            <CouponSection
              applied={quote.coupon && !quote.coupon.error ? quote.coupon : null}
              error={couponError}
              offers={offers}
              checking={quoting && coupon !== null}
              onApply={(code) => {
                setCouponError(null);
                setCoupon(code);
              }}
              onRemove={() => {
                setCoupon(null);
                setCouponError(null);
              }}
              onEdit={() => setCouponError(null)}
            />
          )}

          {opts?.tip_enabled && <TipSection presets={opts.tip_presets} max={opts.tip_max_paise} tip={tip} onTip={setTip} />}

          {opts?.gstin_enabled && (
            <BusinessSection
              gstin={gstin}
              business={business}
              onGstin={(v) => {
                setGstin(v);
                setBizServerError(null);
              }}
              onBusiness={(v) => {
                setBusiness(v);
                setBizServerError(null);
              }}
              open={bizOpen}
              onOpen={setBizOpen}
              showErrors={bizChecked}
              serverError={bizServerError}
            />
          )}

          {opts?.no_bag_enabled && <NoBagSection on={noBag} onChange={setNoBag} />}
        </div>

        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-36 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start" aria-label="Bill and payment">
          <div className={clsx(CARD, "flex flex-col gap-4")} data-testid="checkout-bill">
            {quote ? (
              <div aria-busy={quoting || undefined} className={clsx("transition-opacity duration-200", quoting && "opacity-60")}>
                <BillDetails
                  bill={{
                    ...quote.summary,
                    coupon_code: quote.coupon && !quote.coupon.error ? quote.coupon.code : null,
                    coupon_discount: quote.summary.coupon_discount ?? 0,
                  }}
                  deliveryLabel={quote.checkout?.delivery_label}
                  deliveryInfo={quote.checkout?.delivery_info}
                  hints={quote.hints ?? []}
                  totalLabel="To pay"
                />
              </div>
            ) : !addressId ? (
              <p className="flex items-center gap-2 text-sm text-ink-soft">
                <MapPin className="h-4 w-4 shrink-0 text-peacock" aria-hidden /> Add a delivery address to see your bill.
              </p>
            ) : !quoteError ? (
              <BillSkeleton />
            ) : null}
            {quoteError && (
              <div className="flex flex-col items-start gap-2">
                <ErrorNote message={quoteError} />
                <Button variant="ghost" size="sm" onClick={() => request && currentKey && runQuote(request, currentKey)}>
                  Try again
                </Button>
              </div>
            )}
            <div className="hidden flex-col gap-3 border-t border-line pt-4 lg:flex">
              <ErrorNote message={error} />
              {blocked && quote && <p className="text-sm font-medium text-vermilion">{blocked}</p>}
              <Button variant="buy" size="lg" className="w-full" loading={placing} disabled={!canPay} onClick={place} data-testid="checkout-pay">
                {payText}
              </Button>
              <p className="flex items-center justify-center gap-1.5 text-center text-xs text-ink-faint">
                <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden /> Prices include GST. Each seller issues their own tax invoice.
              </p>
            </div>
          </div>
          {opts?.cancellation_note && <CancellationNote note={opts.cancellation_note} />}
        </aside>

        <PaymentMethods
          className="lg:col-start-1 lg:row-start-2"
          method={method}
          onMethod={(m) => {
            setMethod(m);
            setError(null);
          }}
          onlineAvailable={quote ? quote.online_available : true}
          codAvailable={quote ? quote.cod_available : true}
          codAllowed={quote?.cod_allowed}
          codMax={quote?.cod_max_order_paise ?? 0}
          codFee={summary?.cod_fee ?? 0}
        />

        {showBar && (
          <PayBar
            method={method}
            total={summary ? summary.grand_total : null}
            onChange={() => scrollToSection("checkout-payment", 'input[name="pay"]:checked')}
            onConfirm={place}
            disabled={!canPay}
            loading={placing}
            notice={blocked}
            error={error}
          />
        )}
      </div>
    </div>
  );
}
