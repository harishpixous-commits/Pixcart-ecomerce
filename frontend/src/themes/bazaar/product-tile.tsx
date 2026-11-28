"use client";

/*
 * Bazaar tile: a raised card with the photo inset on white, a discount ribbon, the rank as a medal, and a full-width
 * Add to cart button. What the tile does (links and ads, quick add, deal badge, price, delivery date) comes from
 * components/product-parts; this file only decides how it looks. Buttons sit beside the link, never inside it.
 * If the owner switches the product grid to hairline or airy, the card drops its own frame to suit.
 */

import clsx from "clsx";
import { Plus, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { DealBadge, TileDelivery, TileImage, TileLink, TilePrice, TileRating, useQuickAdd } from "@/components/product-parts";
import { WishlistHeart } from "@/lib/wishlist";
import { useLayout } from "@/themes/context";
import type { ProductTileProps, ThemeLayout } from "@/themes/types";

type Card = ProductTileProps["p"];

const FRAME: Record<ThemeLayout["productGrid"], string> = {
  cards: "pc-lift rounded-xl bg-white shadow-card",
  hairline: "bg-white",
  airy: "",
};

/** Full-width Add to cart, See options for products with versions, or a quiet "Out of stock". */
function AddButton({ p }: { p: Card }) {
  const { add, busy, canAdd, needsOptions, optionsHref } = useQuickAdd(p);
  if (needsOptions) {
    return (
      <Link href={optionsHref} className="pc-press flex h-9 w-full items-center justify-center rounded-lg border border-peacock/40 text-sm font-semibold text-peacock hover:border-peacock hover:bg-peacock/5">
        See options
      </Link>
    );
  }
  if (!canAdd) {
    // keeps the buttons of a row in line; the photo already says "Out of stock" to screen readers
    return <p className="flex h-9 items-center justify-center rounded-lg bg-mist text-sm font-semibold text-ink-faint" aria-hidden>Out of stock</p>;
  }
  return (
    <button type="button" onClick={add} disabled={busy} data-testid="quick-add"
      className="pc-press flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-marigold text-sm font-semibold text-ink hover:bg-marigold-dark disabled:opacity-60">
      <ShoppingCart className="h-4 w-4" aria-hidden /> {busy ? "Adding…" : "Add to cart"}
    </button>
  );
}

/** The round + over the photo (single-version products in stock). */
function PlusButton({ p }: { p: Card }) {
  const { add, busy, canAdd } = useQuickAdd(p);
  if (!canAdd) return null;
  return (
    <button type="button" onClick={add} disabled={busy} aria-label={`Add ${p.title} to cart`} data-testid="quick-add"
      className="pc-press pointer-events-auto absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-marigold text-ink shadow-md ring-2 ring-white hover:bg-marigold-dark disabled:opacity-60">
      <Plus className="h-5 w-5" strokeWidth={2.5} aria-hidden />
    </button>
  );
}

export function BazaarProductTile({ p, showAdd, rank, quickPlus }: ProductTileProps) {
  const grid = useLayout().productGrid;
  const ribbon = p.discount_pct > 0 && !p.deal;
  return (
    <div className={clsx("group relative flex h-full flex-col", FRAME[grid] ?? FRAME.cards)} data-testid="product-tile">
      <TileLink p={p} className={clsx("flex flex-1 flex-col p-2", grid === "cards" && "rounded-xl")}>
        <TileImage p={p} className="aspect-square rounded-lg bg-white" />
        <div className="flex flex-1 flex-col px-1 pb-1 pt-2.5">
          {p.sponsored && <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint" data-testid="sponsored-label">Sponsored</p>}
          {p.brand && <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{p.brand}</p>}
          <p className="mt-0.5 line-clamp-2 text-sm font-medium leading-snug text-ink transition-colors group-hover:text-peacock">{p.title}</p>
          <TileRating p={p} className="mt-1.5" />
          {p.bought && <p className="mt-1 text-xs text-ink-soft">{p.bought}</p>}
          {p.is_new && <p className="mt-1 text-xs font-semibold text-leaf" data-testid="new-badge">New</p>}
          {p.deal && <div className="mt-2"><DealBadge deal={p.deal} discount={p.discount_pct} /></div>}
          {/* the ribbon (or the deal badge) shows the discount, so the price line does not repeat it */}
          <TilePrice p={p} showDiscount={false} className="mt-auto pt-2" priceClass="font-display text-lg font-bold text-ink" />
          <TileDelivery p={p} />
        </div>
      </TileLink>
      {/* badges and buttons over the photo: an overlay the size of the photo, beside the link */}
      <div className="pointer-events-none absolute inset-x-2 top-2 aspect-square">
        {rank !== undefined && (
          <span className="absolute left-2 top-2 flex h-8 min-w-[2rem] items-center justify-center rounded-full bg-marigold px-1.5 font-display text-sm font-bold text-ink shadow-sm ring-2 ring-white">
            #{rank}
          </span>
        )}
        {ribbon && (
          <span className={clsx("absolute -left-2 rounded-r-md bg-vermilion py-0.5 pl-2 pr-2.5 text-xs font-bold leading-5 text-white shadow-sm", rank !== undefined ? "top-12" : "top-2.5")}>
            <span aria-hidden>-{p.discount_pct}%</span>
            <span className="sr-only">{p.discount_pct}% off</span>
          </span>
        )}
        <WishlistHeart productId={p.id}
          className="pointer-events-auto absolute right-1.5 top-1.5 flex h-9 w-9 items-center justify-center rounded-full bg-white/95 shadow-sm ring-1 ring-line transition-transform hover:scale-105" />
        {quickPlus && <PlusButton p={p} />}
      </div>
      {showAdd && (
        <div className="px-3 pb-3">
          <AddButton p={p} />
        </div>
      )}
    </div>
  );
}
