"use client";

/*
 * Luxe tile (boutique): no card. A tall white photo frame (4:5, the whole product visible, a zoom on hover), then quiet
 * type underneath: the brand in small capitals, the title in the serif, the price with the M.R.P. struck through and
 * the discount, a fine star line, the deal and its countdown, and the delivery date.
 *
 * Adding to the cart is one button per tile: on phones and touch screens a small round + on the photo; on computers
 * (a mouse, tablet width and up) a "Quick add" bar that slides up over the bottom of the photo on hover or keyboard
 * focus. Products with versions offer "Choose options" (the product page) on computers. The controls are siblings of
 * the tile link, never inside it. Behaviour (adding to the cart, ad links, the countdown, the delivery date) comes from
 * components/product-parts.
 */

import clsx from "clsx";
import { Loader2, Plus, Star } from "lucide-react";
import Link from "next/link";
import { DealCountdown, TileDelivery, TileImage, TileLink, useQuickAdd } from "@/components/product-parts";
import { rupees } from "@/lib/format";
import type { ProductCard } from "@/lib/types";
import { WishlistHeart } from "@/lib/wishlist";
import { useLayout } from "@/themes/context";
import type { ProductTileProps, ThemeLayout } from "@/themes/types";

/** What both looks share: a control placed on the photo. */
const CONTROL = "pointer-events-auto absolute items-center justify-center transition duration-200";

/** Phones and touch screens: a small round + in the photo's bottom-right corner (a 44 px touch area). */
const TOUCH =
  "bottom-2 right-2 h-9 w-9 rounded-full bg-white text-ink shadow-sm ring-1 ring-line " +
  "before:absolute before:-inset-1 before:content-[''] active:scale-95 disabled:opacity-70";

/*
 * Computers (a mouse, 640 px and up): a full-width bar hidden under the photo's bottom edge that slides up on hover or
 * keyboard focus. The variant is written out on every class so Tailwind finds them.
 */
const BAR =
  "sm:[@media(hover:hover)]:inset-x-0 sm:[@media(hover:hover)]:bottom-0 sm:[@media(hover:hover)]:h-11 sm:[@media(hover:hover)]:w-auto " +
  "sm:[@media(hover:hover)]:gap-2 sm:[@media(hover:hover)]:rounded-none sm:[@media(hover:hover)]:bg-ink sm:[@media(hover:hover)]:text-white " +
  "sm:[@media(hover:hover)]:shadow-none sm:[@media(hover:hover)]:ring-0 sm:[@media(hover:hover)]:before:content-none " +
  "sm:[@media(hover:hover)]:text-[11px] sm:[@media(hover:hover)]:font-medium sm:[@media(hover:hover)]:uppercase sm:[@media(hover:hover)]:tracking-[0.16em] " +
  "sm:[@media(hover:hover)]:translate-y-full sm:[@media(hover:hover)]:opacity-0 sm:[@media(hover:hover)]:duration-300 sm:[@media(hover:hover)]:ease-out " +
  "sm:[@media(hover:hover)]:hover:bg-ink/90 sm:[@media(hover:hover)]:active:scale-100 sm:[@media(hover:hover)]:disabled:opacity-100 " +
  "sm:[@media(hover:hover)]:group-hover:translate-y-0 sm:[@media(hover:hover)]:group-hover:opacity-100 " +
  "sm:[@media(hover:hover)]:group-has-[:focus-visible]:translate-y-0 sm:[@media(hover:hover)]:group-has-[:focus-visible]:opacity-100 " +
  "sm:[@media(hover:hover)]:focus-visible:outline-white sm:[@media(hover:hover)]:focus-visible:[outline-offset:-4px]";

function QuickAdd({ p }: { p: ProductCard }) {
  const { add, busy, canAdd, needsOptions, optionsHref } = useQuickAdd(p);
  if (needsOptions) {
    return (
      <Link href={optionsHref} className={clsx(CONTROL, "hidden sm:[@media(hover:hover)]:flex", BAR)}
        aria-label={`Choose options for ${p.title}`} data-testid="tile-options">
        Choose options
      </Link>
    );
  }
  if (!canAdd) return null;
  return (
    <button type="button" onClick={add} disabled={busy} aria-label={`Quick add ${p.title} to cart`} data-testid="quick-add"
      className={clsx(CONTROL, "flex", TOUCH, BAR)}>
      {busy
        ? <Loader2 className="h-4 w-4 animate-spin sm:[@media(hover:hover)]:h-3.5 sm:[@media(hover:hover)]:w-3.5" aria-hidden />
        : <Plus className="h-4 w-4 sm:[@media(hover:hover)]:hidden" strokeWidth={1.75} aria-hidden />}
      <span className="sr-only sm:[@media(hover:hover)]:not-sr-only">{busy ? "Adding" : "Quick add"}</span>
    </button>
  );
}

/** Five fine stars filled to the average, the average and the number of ratings. */
function StarLine({ p }: { p: ProductCard }) {
  if (p.rating_count <= 0) return null;
  const pct = Math.max(0, Math.min(100, (p.rating_avg / 5) * 100));
  const count = p.rating_count.toLocaleString("en-IN");
  const row = (cls: string) => (
    <span className={clsx("flex", cls)}>
      {[0, 1, 2, 3, 4].map((i) => <Star key={i} className="h-3 w-3 shrink-0 fill-current" strokeWidth={0} />)}
    </span>
  );
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-[12px] leading-none text-ink-soft">
      <span className="sr-only">Rated {p.rating_avg.toFixed(1)} out of 5 from {count} ratings</span>
      <span aria-hidden className="relative">
        {row("text-ink/15")}
        <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${pct}%` }}>{row("text-ink")}</span>
      </span>
      <span aria-hidden>{p.rating_avg.toFixed(1)}</span>
      <span aria-hidden className="text-ink-faint">({count})</span>
    </p>
  );
}

/** The deal in small capitals with its countdown and, when the seller shows it, a fine "claimed" line. */
function DealLine({ deal }: { deal: NonNullable<ProductCard["deal"]> }) {
  const timed = deal.kind !== "limited" && deal.show_countdown !== false;
  return (
    <div className="mt-1.5" data-testid="deal-badge">
      <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] font-medium uppercase leading-4 tracking-[0.14em] text-vermilion">
        <span>{deal.label}</span>
        {timed && <DealCountdown endsAt={deal.ends_at} className="tabular-nums tracking-[0.06em]" />}
      </p>
      {deal.claimed_pct !== null && (
        <p className="mt-1 flex items-center gap-2 text-[11px] leading-4 text-ink-soft">
          <span aria-hidden className="h-0.5 max-w-[96px] flex-1 bg-line">
            <span className="block h-full bg-vermilion" style={{ width: `${Math.max(4, Math.min(100, deal.claimed_pct))}%` }} />
          </span>
          {deal.claimed_pct}% claimed
        </p>
      )}
    </div>
  );
}

/*
 * Luxe's own look is "airy": no card, the photo and type straight on the page. When the owner picks another product
 * grid for Luxe (Theme and layout → Layout), the tile takes that grid's surface: white cells between hairlines, or
 * raised cards, with the same inner spacing.
 */
const FRAME: Record<ThemeLayout["productGrid"], string> = {
  airy: "",
  hairline: "bg-white p-3 sm:p-4",
  cards: "pc-lift rounded-xl bg-white p-3 shadow-card sm:p-4",
};

export function LuxeProductTile({ p, rank }: ProductTileProps) {
  const grid = useLayout().productGrid;
  return (
    <div className={clsx("group relative flex h-full flex-col", FRAME[grid] ?? "")} data-testid="product-tile">
      <div className="relative flex flex-1 flex-col">
        <TileLink p={p} className="flex flex-1 flex-col outline-offset-4">
          <div className="relative">
            {/* TileImage's own "Out of stock" band is hidden: Luxe says "Sold out" in its own type below */}
            <TileImage p={p} className="aspect-[4/5] bg-white [&>span]:hidden" imgClass={clsx("p-3 sm:p-5 lg:p-6", !p.in_stock && "opacity-50")} />
            {rank !== undefined && (
              <span className="absolute left-2.5 top-3 text-[11px] font-medium uppercase tracking-[0.16em] text-ink sm:left-3.5">No. {rank}</span>
            )}
            {!p.in_stock && (
              <span className="absolute inset-x-0 bottom-0 bg-white/90 py-2.5 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-ink">Sold out</span>
            )}
          </div>
          <div className="flex flex-1 flex-col pt-3">
            {/* always one line, so titles and prices line up along a row even when a brand is missing */}
            <div className="flex min-h-[1rem] items-baseline justify-between gap-2 text-[11px] uppercase leading-4 tracking-[0.16em] text-ink-faint">
              <span className="truncate">{p.brand}</span>
              {p.sponsored && <span className="shrink-0" data-testid="sponsored-label">Sponsored</span>}
            </div>
            <p className="mt-1 line-clamp-2 min-h-[2.75em] font-display text-[15px] leading-snug text-ink decoration-ink/40 underline-offset-[3px] group-hover:underline">
              {p.title}
            </p>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2 font-sans text-[14px] leading-5">
              <span className="font-medium text-ink">{rupees(p.price)}</span>
              {p.mrp > p.price && (
                <span className="text-[13px] text-ink-faint line-through"><span className="sr-only">M.R.P. </span>{rupees(p.mrp)}</span>
              )}
              {p.discount_pct > 0 && (
                <span className="text-[13px] font-medium text-vermilion">
                  <span aria-hidden>-{p.discount_pct}%</span><span className="sr-only">{p.discount_pct}% off</span>
                </span>
              )}
            </p>
            {p.unit_price && <p className="text-[12px] text-ink-soft">{rupees(p.unit_price.paise)}/{p.unit_price.per}</p>}
            {p.deal && <DealLine deal={p.deal} />}
            <StarLine p={p} />
            {p.bought && <p className="mt-1 text-[12px] text-ink-soft">{p.bought}</p>}
            {p.is_new && <p className="mt-1 text-xs font-semibold text-leaf" data-testid="new-badge">New</p>}
            <div className="mt-1.5">
              <TileDelivery p={p} />
            </div>
          </div>
        </TileLink>
        {/* the photo's area, holding the controls that sit on it (siblings of the link) */}
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-[4/5] overflow-hidden">
          <WishlistHeart productId={p.id}
            className="pointer-events-auto absolute right-1.5 top-1.5 flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-ink/5 [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:[stroke-width:1.5]" />
          <QuickAdd p={p} />
        </div>
      </div>
    </div>
  );
}
