"use client";

import clsx from "clsx";
import { BadgeCheck, MapPin, RotateCcw, ShieldCheck, Truck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ProductGallery } from "@/components/product-gallery";
import { Button, Price, Rating, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date as fmtDate } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { ProductPage, ProductVideo } from "@/lib/types";
import { rememberViewed, WishlistHeart } from "@/lib/wishlist";

export function Gallery({ images, videos, title }: { images: string[]; videos?: ProductVideo[]; title: string }) {
  const site = useSite();
  return <ProductGallery images={images} videos={site.features.product_videos === false ? [] : videos ?? []} title={title}
    zoom={site.gallery?.zoom ?? true} zoomLevel={site.gallery?.zoom_level ?? 2.5} />;
}

function DeliveryCheck({ variantId }: { variantId?: string }) {
  const [pin, setPin] = useState("");
  const [res, setRes] = useState<{ serviceable: boolean; min_date?: string; max_date?: string; cod_available?: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pc_pin");
      if (saved) setPin(saved);
    } catch {
      /* ignore */
    }
  }, []);
  async function check(e?: React.FormEvent) {
    e?.preventDefault();
    if (!variantId || !/^[1-9]\d{5}$/.test(pin)) return setErr("Enter a 6-digit PIN code");
    setErr(null);
    try {
      localStorage.setItem("pc_pin", pin);
    } catch {
      /* ignore */
    }
    try {
      setRes(await api(`/api/catalog/delivery-estimate`, { query: { variant_id: variantId, pincode: pin } }));
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Could not check delivery");
    }
  }
  useEffect(() => {
    if (pin.length === 6 && variantId && !res) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantId, pin]);
  return (
    <div className="rounded-lg border border-line p-3">
      <form onSubmit={check} className="flex items-center gap-2">
        <label htmlFor="pin" className="text-sm font-semibold">Deliver to</label>
        <input id="pin" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setRes(null); }} placeholder="PIN code" className="h-9 w-28 rounded-md border border-line px-2" />
        <button type="submit" className="text-sm font-semibold text-peacock">Check</button>
      </form>
      {err && <p className="mt-1 text-sm text-vermilion">{err}</p>}
      {res && (res.serviceable ? (
        <p className="mt-1 text-sm">Delivery by <span className="font-semibold">{fmtDate(res.min_date!)}</span>{res.max_date !== res.min_date ? ` to ${fmtDate(res.max_date!)}` : ""}{res.cod_available ? ". Cash on delivery available." : "."}</p>
      ) : (
        <p className="mt-1 text-sm text-vermilion">This seller does not deliver to {pin} yet.</p>
      ))}
    </div>
  );
}

export function BuyBox({ p }: { p: ProductPage }) {
  const site = useSite();
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

  const variant = useMemo(
    () => p.variants.find((v) => Object.entries(chosen).every(([k, val]) => v.options[k] === val) && Object.keys(v.options).length === Object.keys(chosen).length),
    [p.variants, chosen],
  );

  function availability(axis: string, value: string) {
    // Is there an in-stock variant with this value, keeping the other chosen options?
    return p.variants.some((v) => v.options[axis] === value && v.in_stock && Object.entries(chosen).every(([k, val]) => k === axis || v.options[k] === val));
  }

  async function add(then: "cart" | "buy") {
    if (!variant || !variant.in_stock) return;
    setBusy(then);
    try {
      await addToCart({
        variant_id: variant.id,
        qty,
        title: p.title,
        image: p.images[0] ?? "",
        price: variant.price,
        mrp: variant.mrp,
        slug: p.slug,
        variant_label: variant.label,
        seller_name: p.seller.name,
      });
      api("/api/events", { method: "POST", body: { type: "add_to_cart", product_id: p.id } }).catch(() => {});
      if (then === "buy") router.push(user ? "/checkout" : "/login?next=/checkout");
      else toast("Added to your cart");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not add to cart", "error");
    } finally {
      setBusy(null);
    }
  }

  const shown = variant ?? firstAvailable;
  const maxQty = Math.min(10, variant?.stock_left ?? 10);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative pr-12">
        <WishlistHeart productId={p.id} className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center rounded-full bg-white ring-1 ring-line hover:bg-mist" />
        {p.brand && <p className="font-semibold text-peacock">{p.brand}</p>}
        <h1 className="text-2xl font-semibold sm:text-[28px]">{p.title}</h1>
        <div className="mt-2">
          <Rating value={p.rating_avg} count={p.rating_count} size="md" />
        </div>
      </div>

      {shown && <Price price={shown.price} mrp={shown.mrp} discount={shown.discount_pct} size="lg" />}
      <p className="-mt-3 text-sm text-ink-faint">Inclusive of all taxes</p>

      {axes.map(([axis, values]) => (
        <fieldset key={axis}>
          <legend className="mb-2 text-sm font-semibold">
            {axis}: <span className="font-normal text-ink-soft">{chosen[axis]}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {values.map((val) => {
              const ok = availability(axis, val);
              const selected = chosen[axis] === val;
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => setChosen((c) => ({ ...c, [axis]: val }))}
                  aria-pressed={selected}
                  className={clsx(
                    "min-w-[48px] rounded-lg border-2 px-3 py-1.5 text-[15px] font-medium",
                    selected ? "border-peacock bg-peacock-light text-peacock" : "border-line bg-white text-ink hover:border-peacock/50",
                    !ok && "text-ink-faint line-through decoration-1",
                  )}
                >
                  {val}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      {variant ? (
        variant.in_stock ? (
          <p className={clsx("text-sm font-semibold", variant.low_stock ? "text-vermilion" : "text-leaf")}>
            {variant.low_stock ? `Only ${variant.stock_left} left` : "In stock"}
          </p>
        ) : (
          <p className="text-sm font-semibold text-vermilion">This option is out of stock</p>
        )
      ) : (
        <p className="text-sm font-semibold text-vermilion">This combination is not available</p>
      )}

      <div className="flex items-center gap-3">
        <label htmlFor="qty" className="text-sm font-semibold">Quantity</label>
        <select id="qty" value={qty} onChange={(e) => setQty(Number(e.target.value))} className="h-10 rounded-lg border border-line bg-white px-3" disabled={!variant?.in_stock}>
          {Array.from({ length: Math.max(1, maxQty) }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Button variant="cart" size="lg" onClick={() => add("cart")} loading={busy === "cart"} disabled={!variant?.in_stock || busy !== null}>
          Add to cart
        </Button>
        <Button variant="buy" size="lg" onClick={() => add("buy")} loading={busy === "buy"} disabled={!variant?.in_stock || busy !== null}>
          Buy now
        </Button>
      </div>

      <DeliveryCheck variantId={variant?.id} />

      <ul className="flex flex-col gap-2.5 border-t border-line pt-4 text-sm text-ink-soft">
        <li className="flex gap-2.5"><Truck className="h-5 w-5 shrink-0 text-peacock" /> Ships from {p.seller.city}, {p.seller.state}</li>
        <li className="flex gap-2.5"><RotateCcw className="h-5 w-5 shrink-0 text-peacock" /> {p.return_window_days > 0 ? `${p.return_window_days}-day return window after delivery` : "Not returnable"}</li>
        <li className="flex gap-2.5"><ShieldCheck className="h-5 w-5 shrink-0 text-peacock" /> {site.online_payments && site.cod_enabled ? "Pay securely online (UPI, cards, net banking) or cash on delivery" : site.online_payments ? "Pay securely online: UPI, cards or net banking" : "Cash on delivery"}</li>
        <li className="flex gap-2.5"><MapPin className="h-5 w-5 shrink-0 text-peacock" /> Country of origin: {p.country_of_origin}</li>
      </ul>

      <div className="rounded-xl bg-mist p-4 text-sm">
        <p className="flex items-center gap-1.5 font-semibold">
          <BadgeCheck className="h-4 w-4 text-leaf" /> Sold by{" "}
          <Link href={`/store/${p.seller.slug}`} className="text-peacock hover:underline">{p.seller.name}</Link>
        </p>
        <p className="mt-1 text-ink-soft">{p.seller.legal_name}{p.seller.gstin ? `, GSTIN ${p.seller.gstin}` : ""}</p>
        <p className="text-ink-soft">
          Seller grievance officer: {p.seller.grievance_officer.name} ({p.seller.grievance_officer.email})
        </p>
      </div>
    </div>
  );
}
