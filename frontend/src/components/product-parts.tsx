"use client";

/*
 * Building blocks every theme's product tile uses (src/themes/<id>/product-tile.tsx), so behaviour stays the same
 * in every theme: the deal badge and countdown, adding to the cart (with the stock and per-item limits and the
 * "added" toast), the link (ads go through the click counter), the rating, the price line and the delivery date.
 * A theme changes how a tile looks, never what it does.
 */

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { date as fmtDate, rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { DealInfo, ProductCard as Card } from "@/lib/types";

function left(ms: number): string {
  if (ms <= 0) return "Ended";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  if (d >= 2) return `${d} days`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** "Ends in 02:13:44", ticking every second (rendered after hydration so server and browser agree). */
export function DealCountdown({ endsAt, prefix = "Ends in", doneText = "Deal ended", className }: { endsAt: string; prefix?: string; doneText?: string; className?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, []);
  if (now === null) return <span className={className}>&nbsp;</span>;
  const ms = new Date(endsAt).getTime() - now;
  return <span className={className} suppressHydrationWarning>{ms > 0 ? `${prefix} ${left(ms)}` : doneText}</span>;
}

export function DealBadge({ deal, discount, size = "sm" }: { deal: DealInfo; discount: number; size?: "sm" | "md" }) {
  const timed = deal.kind !== "limited" && deal.show_countdown !== false;
  return (
    <div className={clsx("flex flex-col gap-1", size === "md" && "gap-1.5")} data-testid="deal-badge">
      <div className="flex flex-wrap items-center gap-1.5">
        {discount > 0 && <span className={clsx("rounded bg-vermilion font-semibold text-white", size === "md" ? "px-2 py-0.5 text-sm" : "px-1.5 text-xs leading-5")}>{discount}% off</span>}
        <span className={clsx("font-semibold text-vermilion", size === "md" ? "text-sm" : "text-xs")}>{deal.label}</span>
      </div>
      {timed && <DealCountdown endsAt={deal.ends_at} className={clsx("font-medium text-vermilion", size === "md" ? "text-sm" : "text-xs")} />}
      {deal.claimed_pct !== null && (
        <div className="flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-vermilion-light"><span className="block h-full bg-vermilion" style={{ width: `${Math.max(4, deal.claimed_pct)}%` }} /></span>
          <span className="shrink-0 text-[11px] text-ink-faint">{deal.claimed_pct}% claimed</span>
        </div>
      )}
    </div>
  );
}

/** Where a tile leads: ads go through the click counter (a plain link, never prefetched, so no false clicks). */
export function tileHref(p: Card): { href: string; external: boolean } {
  const external = Boolean(p.sponsored && p.href);
  return { href: external ? p.href! : `/p/${p.slug}`, external };
}

export function TileLink({ p, className, children, ariaLabel }: { p: Card; className?: string; children: React.ReactNode; ariaLabel?: string }) {
  const { href, external } = tileHref(p);
  return external
    ? <a href={href} className={className} rel="sponsored" aria-label={ariaLabel}>{children}</a>
    : <Link href={href} className={className} aria-label={ariaLabel}>{children}</Link>;
}

/** Adding one unit of a single-version product, with the cart's notices ("only 2 left") as a toast. */
export function useQuickAdd(p: Card) {
  const { addToCart } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const canAdd = p.in_stock && Boolean(p.variant_id);
  async function add(e?: React.MouseEvent) {
    e?.preventDefault();
    e?.stopPropagation();
    if (!canAdd || busy) return;
    setBusy(true);
    try {
      const note = await addToCart({ variant_id: p.variant_id!, qty: 1, title: p.title, image: p.image, price: p.price, mrp: p.mrp, slug: p.slug, variant_label: "", seller_name: p.seller_name });
      toast(note ?? "Added to your cart");
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not add to cart", "error");
    } finally {
      setBusy(false);
    }
  }
  /** products with several versions open the product page to choose one */
  const needsOptions = p.in_stock && !p.variant_id;
  return { add, busy, canAdd, needsOptions, optionsHref: p.href && !p.sponsored ? p.href : `/p/${p.slug}` };
}

/** The rating chip: "4.3 ★ (1,204)". */
export function TileRating({ p, className }: { p: Card; className?: string }) {
  if (p.rating_count <= 0) return null;
  return (
    <p className={clsx("flex items-center gap-1.5", className)}>
      <span className="rounded bg-leaf px-1.5 text-xs font-semibold leading-5 text-white">{p.rating_avg.toFixed(1)} ★</span>
      <span className="text-xs text-ink-faint">({p.rating_count.toLocaleString("en-IN")})</span>
    </p>
  );
}

/** Price, unit price, M.R.P. struck through and the discount. */
export function TilePrice({ p, className, priceClass = "font-display text-lg font-bold", showDiscount = true }: { p: Card; className?: string; priceClass?: string; showDiscount?: boolean }) {
  return (
    <div className={clsx("flex flex-wrap items-baseline gap-x-1.5", className)}>
      <span className={priceClass}>{rupees(p.price)}</span>
      {p.unit_price && <span className="text-xs text-ink-soft">({rupees(p.unit_price.paise)}/{p.unit_price.per})</span>}
      {p.mrp > p.price && <span className="text-sm text-ink-faint line-through">{rupees(p.mrp)}</span>}
      {showDiscount && p.discount_pct > 0 && !p.deal && <span className="text-sm font-semibold text-leaf">{p.discount_pct}% off</span>}
    </div>
  );
}

/** "Get it by Thu, 12 Dec" and, for a deal that has not started, when it starts. */
export function TileDelivery({ p }: { p: Card }) {
  return (
    <>
      {p.delivery_by && <p className="text-xs text-ink-soft">Get it by <span className="font-semibold text-ink">{fmtDate(p.delivery_by)}</span></p>}
      {p.starts_at && <p className="text-xs font-semibold text-peacock">Starts {new Date(p.starts_at).toLocaleString("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit" })}</p>}
    </>
  );
}

/** The product photo (or a blank square), with the "out of stock" band. */
export function TileImage({ p, className, imgClass, fit = "contain" }: { p: Card; className?: string; imgClass?: string; fit?: "contain" | "cover" }) {
  return (
    <div className={clsx("relative overflow-hidden", className)}>
      {p.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.image} alt={p.title} loading="lazy"
          className={clsx("h-full w-full transition-transform duration-300 motion-safe:group-hover:scale-[1.03]", fit === "cover" ? "object-cover" : "object-contain", imgClass)} />
      ) : (
        <div className="h-full w-full bg-mist" />
      )}
      {!p.in_stock && <span className="absolute inset-x-0 bottom-0 bg-ink/75 py-1 text-center text-xs font-semibold text-white">Out of stock</span>}
    </div>
  );
}
