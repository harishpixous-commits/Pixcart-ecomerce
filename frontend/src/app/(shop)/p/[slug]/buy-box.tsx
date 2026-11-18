"use client";

import clsx from "clsx";
import { Award, BadgeCheck, Banknote, Clock, MapPin, Package } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AboutThisItem, AskAboutProduct, KeySpecs, OffersBlock, RecentlyViewedRail, ReportProduct, SellerSnapshotCard, ServiceIcons, ShareButton,
  StickyBuyBar, UnitPrice,
} from "@/components/pdp";
import { ProductGallery } from "@/components/product-gallery";
import { CustomerMediaStrip, Stars } from "@/components/reviews";
import { Button, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date as fmtDate, rupees } from "@/lib/format";
import { isPincode, setPincode, usePincode } from "@/lib/pincode";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { ProductPage, ProductVideo, PublicVariant } from "@/lib/types";
import { rememberViewed, WishlistHeart } from "@/lib/wishlist";

export function Gallery({ images, videos, title }: { images: string[]; videos?: ProductVideo[]; title: string }) {
  const site = useSite();
  return <ProductGallery images={images} videos={site.features.product_videos === false ? [] : videos ?? []} title={title}
    zoom={site.gallery?.zoom ?? true} zoomLevel={site.gallery?.zoom_level ?? 2.5} />;
}

type Estimate = {
  serviceable: boolean; min_date?: string; max_date?: string; cod_available?: boolean; order_within_min?: number | null;
  delivery_fee_paise?: number; free_delivery_from_paise?: number; state?: string;
};

function within(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} hr${h > 1 ? "s" : ""} ${m} min${m === 1 ? "" : "s"}` : `${m} min${m === 1 ? "" : "s"}`;
}

/** Delivery date, charge, cut-off countdown and cash on delivery for the shopper's PIN code. */
function Delivery({ variant }: { variant?: PublicVariant }) {
  const site = useSite();
  const pin = usePincode();
  // the answer is kept with the variant and PIN it belongs to, so a stale one is never shown
  const [answer, setAnswer] = useState<{ key: string; data: Estimate } | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const key = variant && isPincode(pin) ? `${variant.id}:${pin}` : "";
  const res = answer && answer.key === key ? answer.data : null;

  useEffect(() => {
    if (!key || !variant) return;
    let live = true;
    api<Estimate>("/api/catalog/delivery-estimate", { query: { variant_id: variant.id, pincode: pin } })
      .then((r) => { if (live) { setAnswer({ key, data: r }); setLeft(r.order_within_min ?? null); setErr(null); } })
      .catch((x) => { if (live) setErr(x instanceof ApiError ? x.message : "Could not check delivery"); });
    return () => { live = false; };
  }, [key, variant, pin]);
  // the countdown ticks once a minute
  useEffect(() => {
    if (left === null) return;
    const t = setInterval(() => setLeft((x) => (x !== null && x > 1 ? x - 1 : null)), 60_000);
    return () => clearInterval(t);
  }, [left]);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    if (!isPincode(value)) return setErr("Enter a valid 6-digit PIN code");
    setPincode(value);
    setEditing(false);
  }
  const showForm = editing || !pin;
  return (
    <div className="flex flex-col gap-1.5 text-[15px]" data-testid="delivery">
      {res?.serviceable && (
        <>
          <p>
            {res.delivery_fee_paise === 0 ? <span className="font-semibold text-leaf">FREE delivery</span> : <span>{rupees(res.delivery_fee_paise ?? 0)} delivery</span>}{" "}
            <span className="font-semibold">{fmtDate(res.min_date!)}</span>{res.max_date !== res.min_date ? <> – <span className="font-semibold">{fmtDate(res.max_date!)}</span></> : null}.
          </p>
          {res.delivery_fee_paise !== 0 && res.free_delivery_from_paise ? (
            <p className="text-sm text-ink-soft">Free delivery when you buy {rupees(res.free_delivery_from_paise)} or more from this seller.</p>
          ) : null}
          {left !== null && site.pdp?.delivery_countdown !== false && (
            <p className="flex items-center gap-1.5 text-sm"><Clock className="h-4 w-4 text-leaf" /> Order within <span className="font-semibold text-leaf">{within(left)}</span> to get it by this date.</p>
          )}
          {res.cod_available && <p className="flex items-center gap-1.5 text-sm text-ink-soft"><Banknote className="h-4 w-4" /> Cash on delivery available</p>}
        </>
      )}
      {res && !res.serviceable && <p className="text-sm text-vermilion">This seller does not deliver to {pin} yet.</p>}
      {pin && !showForm && (
        <button type="button" onClick={() => { setValue(pin); setEditing(true); }} className="flex items-center gap-1 self-start text-sm text-peacock hover:underline">
          <MapPin className="h-4 w-4" /> Delivering to {pin}{res?.state ? `, ${res.state}` : ""} – Change
        </button>
      )}
      {showForm && (
        <form onSubmit={apply} className="flex items-center gap-2">
          <MapPin className="h-4 w-4 shrink-0 text-peacock" />
          <label htmlFor="pin" className="sr-only">PIN code</label>
          <input id="pin" inputMode="numeric" maxLength={6} value={value} onChange={(e) => { setValue(e.target.value.replace(/\D/g, "")); setErr(null); }}
            placeholder="Enter PIN for delivery date" className="h-9 min-w-0 flex-1 rounded-md border border-line px-2 text-sm" />
          <button type="submit" className="text-sm font-semibold text-peacock">Check</button>
        </form>
      )}
      {err && <p className="text-sm text-vermilion">{err}</p>}
    </div>
  );
}

export function ProductMain({ p }: { p: ProductPage }) {
  const site = useSite();
  const pdp = site.pdp;
  useEffect(() => {
    rememberViewed({ id: p.id, slug: p.slug, title: p.title, image: p.images[0] ?? "", price: p.price, mrp: p.mrp });
    api("/api/events", { method: "POST", body: { type: "view", product_id: p.id } }).catch(() => {});
  }, [p.id, p.slug, p.title, p.images, p.price, p.mrp]);
  const router = useRouter();
  const toast = useToast();
  const { addToCart, user } = useSession();
  const axes = Object.entries(p.option_axes);
  const firstAvailable = p.variants.find((v) => v.in_stock) ?? p.variants[0];
  const [chosen, setChosen] = useState<Record<string, string>>(firstAvailable?.options ?? {});
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState<"cart" | "buy" | null>(null);
  const buttons = useRef<HTMLDivElement>(null);

  const variant = useMemo(
    () => p.variants.find((v) => Object.entries(chosen).every(([k, val]) => v.options[k] === val) && Object.keys(v.options).length === Object.keys(chosen).length),
    [p.variants, chosen],
  );
  function availability(axis: string, value: string) {
    return p.variants.some((v) => v.options[axis] === value && v.in_stock && Object.entries(chosen).every(([k, val]) => k === axis || v.options[k] === val));
  }
  function variantFor(axis: string, value: string) {
    return p.variants.find((v) => v.options[axis] === value && Object.entries(chosen).every(([k, val]) => k === axis || v.options[k] === val));
  }
  const pricesDiffer = new Set(p.variants.map((v) => v.price)).size > 1;

  async function add(then: "cart" | "buy") {
    if (!variant || !variant.in_stock) return;
    setBusy(then);
    try {
      await addToCart({
        variant_id: variant.id, qty, title: p.title, image: p.images[0] ?? "", price: variant.price, mrp: variant.mrp, slug: p.slug,
        variant_label: variant.label, seller_name: p.seller.name,
      });
      api("/api/events", { method: "POST", body: { type: "add_to_cart", product_id: p.id } }).catch(() => {});
      if (then === "buy") {
        window.dispatchEvent(new Event("route-progress:start"));
        router.push(user ? "/checkout" : "/login?next=/checkout");
      } else toast("Added to your cart");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not add to cart", "error");
    } finally {
      setBusy(null);
    }
  }

  const shown = variant ?? firstAvailable;
  const maxQty = Math.min(10, variant?.stock_left ?? 10);
  const netRow = shown?.net_quantity ? [{ label: "Net quantity", value: shown.net_quantity }] : [];
  const stock = variant ? (variant.in_stock
    ? <p className={clsx("text-lg font-semibold", variant.low_stock ? "text-vermilion" : "text-leaf")}>{variant.low_stock ? `Only ${variant.stock_left} left in stock` : "In stock"}</p>
    : <p className="text-lg font-semibold text-vermilion">Currently unavailable</p>)
    : <p className="font-semibold text-vermilion">This combination is not available</p>;

  return (
    <>
      <div className="grid gap-6 rounded-xl bg-white p-4 sm:p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]">
        {/* z-10: the hover-zoom panel opens over the product details, under the site header (z-30). */}
        <div className="relative z-10 lg:sticky lg:top-36 lg:row-span-2 lg:self-start xl:row-span-1">
          <Gallery images={p.images} videos={p.videos} title={p.title} />
          {pdp.customer_media && <CustomerMediaStrip slug={p.slug} />}
        </div>

        {/* centre: what it is */}
        <div className="flex min-w-0 flex-col gap-3">
          {p.brand && (
            <Link href={`/search?brand=${encodeURIComponent(p.brand)}`} className="self-start text-sm font-semibold text-peacock hover:underline">
              Visit the {p.brand} store
            </Link>
          )}
          <h1 className="text-[22px] font-semibold leading-snug sm:text-[26px]">{p.title}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {p.rating_count > 0 ? (
              <a href="#reviews" className="flex items-center gap-1.5 hover:text-peacock">
                <span className="font-semibold">{p.rating_avg.toFixed(1)}</span><Stars value={p.rating_avg} />
                <span className="text-peacock">({p.rating_count.toLocaleString("en-IN")} {p.rating_count === 1 ? "rating" : "ratings"})</span>
              </a>
            ) : site.features.reviews ? <a href="#reviews" className="text-ink-faint hover:text-peacock">No ratings yet</a> : null}
            {pdp.ask_assistant && <><span className="text-line" aria-hidden>|</span><AskAboutProduct title={p.title} /></>}
          </div>
          {p.bought_last_month && <p className="text-sm font-semibold" data-testid="bought">{p.bought_last_month}</p>}
          {(p.bestseller && p.bestseller.rank <= 10) || p.seller_snapshot?.top_seller ? (
            <div className="flex flex-wrap gap-2">
              {p.bestseller && p.bestseller.rank <= 10 && (
                <Link href={`/c/${p.bestseller.slug}?sort=popular`} className="rounded bg-marigold px-2 py-0.5 text-xs font-bold text-ink hover:bg-marigold-dark" data-testid="bestseller">
                  #{p.bestseller.rank} Best seller <span className="font-normal">in {p.bestseller.category}</span>
                </Link>
              )}
              {p.seller_snapshot?.top_seller && <span className="flex items-center gap-1 rounded bg-peacock px-2 py-0.5 text-xs font-bold text-white"><Award className="h-3.5 w-3.5" /> Top seller</span>}
            </div>
          ) : null}

          <div className="border-t border-line pt-3">
            {shown && (
              <>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  {shown.discount_pct > 0 && <span className="text-2xl font-light text-vermilion">-{shown.discount_pct}%</span>}
                  <span className="font-display text-[32px] font-bold leading-none">{rupees(shown.price)}</span>
                  <UnitPrice up={pdp.unit_price ? shown.unit_price : null} className="text-sm" />
                </div>
                {shown.mrp > shown.price && <p className="mt-1 text-sm text-ink-faint">M.R.P.: <span className="line-through">{rupees(shown.mrp)}</span></p>}
              </>
            )}
            <p className="text-sm text-ink-soft">Inclusive of all taxes</p>
          </div>

          {pdp.offers && (p.offers?.length ?? 0) > 0 && <OffersBlock offers={p.offers!} />}
          {pdp.service_icons && shown && <div className="border-y border-line py-2"><ServiceIcons p={p} price={shown.price} /></div>}

          {axes.map(([axis, values]) => (
            <fieldset key={axis}>
              <legend className="mb-2 text-sm font-semibold">{axis}: <span className="font-normal text-ink-soft">{chosen[axis]}</span></legend>
              <div className="flex flex-wrap gap-2">
                {values.map((val) => {
                  const ok = availability(axis, val);
                  const selected = chosen[axis] === val;
                  const v = variantFor(axis, val);
                  return (
                    <button key={val} type="button" onClick={() => setChosen((c) => ({ ...c, [axis]: val }))} aria-pressed={selected}
                      className={clsx("min-w-[56px] rounded-lg border-2 px-3 py-1.5 text-left text-[15px]",
                        selected ? "border-peacock bg-peacock-light" : "border-line bg-white hover:border-peacock/50", !ok && "border-dashed text-ink-faint")}>
                      <span className={clsx("block font-medium", selected && "text-peacock", !ok && "line-through decoration-1")}>{val}</span>
                      {pricesDiffer && v && <span className="block text-xs text-ink">{rupees(v.price)}</span>}
                      {pdp.unit_price && v?.unit_price && <span className="block text-[11px] text-ink-faint">{rupees(v.unit_price.paise)}/{v.unit_price.per}</span>}
                      {!ok && <span className="block text-[11px]">Unavailable</span>}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}

          {pdp.key_specs && <KeySpecs rows={p.key_specs ?? []} extra={netRow} />}
          <AboutThisItem items={p.highlights} />
          {pdp.seller_snapshot && p.seller_snapshot && <div className="xl:hidden"><SellerSnapshotCard seller={p.seller} snap={p.seller_snapshot} /></div>}
        </div>

        {/* right: buy */}
        <aside className="flex flex-col gap-4 lg:col-start-2 xl:col-start-3" aria-label="Buy">
          <div className="flex flex-col gap-3 rounded-xl border border-line p-4 shadow-sm">
            {shown && (
              <div>
                <span className="font-display text-[28px] font-bold leading-none">{rupees(shown.price)}</span>{" "}
                <UnitPrice up={pdp.unit_price ? shown.unit_price : null} className="text-sm" />
              </div>
            )}
            <Delivery variant={variant} />
            {stock}
            <div className="flex items-center gap-3">
              <label htmlFor="qty" className="text-sm font-semibold">Quantity</label>
              <select id="qty" value={qty} onChange={(e) => setQty(Number(e.target.value))} className="h-10 rounded-lg border border-line bg-mist px-3" disabled={!variant?.in_stock}>
                {Array.from({ length: Math.max(1, maxQty) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div ref={buttons} className="flex flex-col gap-2">
              <Button variant="cart" size="lg" onClick={() => add("cart")} loading={busy === "cart"} disabled={!variant?.in_stock || busy !== null} className="w-full rounded-full">Add to cart</Button>
              <Button variant="buy" size="lg" onClick={() => add("buy")} loading={busy === "buy"} disabled={!variant?.in_stock || busy !== null} className="w-full rounded-full">Buy now</Button>
            </div>
            <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-ink-faint">Ships from</dt><dd>{p.seller.city}{p.seller.state ? `, ${p.seller.state}` : ""}</dd>
              <dt className="text-ink-faint">Sold by</dt><dd><Link href={`/store/${p.seller.slug}`} className="text-peacock hover:underline">{p.seller.name}</Link></dd>
              <dt className="text-ink-faint">Returns</dt><dd>{p.return_window_days > 0 ? `${p.return_window_days}-day return after delivery` : "Not returnable"}</dd>
              <dt className="text-ink-faint">Payment</dt><dd>{site.online_payments === false ? "Cash on delivery" : site.cod_enabled ? "Secure online payment or cash on delivery" : "Secure online payment"}</dd>
            </dl>
            <div className="flex items-center gap-2 border-t border-line pt-3">
              {site.features.wishlist && <WishlistHeart productId={p.id} className="flex h-10 w-10 items-center justify-center rounded-full ring-1 ring-line hover:bg-mist" />}
              {site.features.wishlist && <span className="text-sm text-ink-soft">Save for later</span>}
              {pdp.share && <div className="ml-auto"><ShareButton title={p.title} /></div>}
            </div>
          </div>
          {pdp.seller_snapshot && p.seller_snapshot && <div className="hidden xl:block"><SellerSnapshotCard seller={p.seller} snap={p.seller_snapshot} /></div>}
          <div className="flex flex-col gap-2 rounded-xl bg-mist p-4 text-[13px] text-ink-soft">
            <p className="flex items-center gap-1.5 font-semibold text-ink"><BadgeCheck className="h-4 w-4 text-leaf" /> {p.seller.legal_name || p.seller.name}</p>
            {p.seller.gstin && <p>GSTIN {p.seller.gstin}</p>}
            <p>Grievance officer: {p.seller.grievance_officer.name} ({p.seller.grievance_officer.email})</p>
            <p className="flex items-center gap-1.5"><Package className="h-3.5 w-3.5" /> Country of origin: {p.country_of_origin}</p>
          </div>
          {pdp.report && <ReportProduct slug={p.slug} />}
        </aside>
      </div>
      {pdp.sticky_bar && shown && (
        <StickyBuyBar watch={buttons} price={shown.price} mrp={shown.mrp} title={p.title} image={p.images[0] ?? ""}
          onAdd={() => add("cart")} onBuy={() => add("buy")} disabled={!variant?.in_stock || busy !== null} busy={busy} />
      )}
    </>
  );
}

export function BrowsingHistory({ currentId }: { currentId: string }) {
  const site = useSite();
  return site.pdp.recently_viewed ? <RecentlyViewedRail currentId={currentId} /> : null;
}
