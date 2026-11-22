"use client";

/* Classic tile: white, hairline-separated, photo on top, rating chip, deal badge, price, delivery date. */

import { Plus, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { DealBadge, TileDelivery, TileImage, TileLink, TilePrice, TileRating, useQuickAdd } from "@/components/product-parts";
import type { ProductTileProps } from "@/themes/types";
import { WishlistHeart } from "@/lib/wishlist";

function QuickAdd({ p, compact }: { p: ProductTileProps["p"]; compact?: boolean }) {
  const { add, busy, canAdd, needsOptions, optionsHref } = useQuickAdd(p);
  if (needsOptions) {
    return compact ? null : <Link href={optionsHref} className="mt-2 block rounded-full border border-line py-1.5 text-center text-sm font-semibold hover:bg-mist">See options</Link>;
  }
  if (!canAdd) return null;
  if (compact) {
    return (
      <button type="button" onClick={add} disabled={busy} aria-label={`Add ${p.title} to cart`} data-testid="quick-add"
        className="pc-press absolute bottom-2 right-2 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-marigold text-ink shadow-md ring-2 ring-white hover:bg-marigold-dark disabled:opacity-60">
        <Plus className="h-5 w-5" />
      </button>
    );
  }
  return (
    <button type="button" onClick={add} disabled={busy} data-testid="quick-add"
      className="pc-press mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-marigold py-1.5 text-sm font-semibold text-ink hover:bg-marigold-dark disabled:opacity-60">
      <ShoppingCart className="h-4 w-4" /> {busy ? "Adding…" : "Add to cart"}
    </button>
  );
}

export function ClassicProductTile({ p, showAdd, rank, quickPlus }: ProductTileProps) {
  return (
    <div className="relative flex h-full flex-col bg-white" data-testid="product-tile">
      <WishlistHeart productId={p.id} />
      <TileLink p={p} className="group flex h-full flex-col bg-white p-3 outline-offset-[-2px] sm:p-4">
        <div className="relative mb-2">
          <TileImage p={p} className="aspect-square rounded-lg bg-white" />
          {rank !== undefined && <span className="absolute left-0 top-0 rounded-br-lg bg-marigold px-2 py-0.5 text-sm font-bold text-ink">#{rank}</span>}
        </div>
        {p.sponsored && <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint" data-testid="sponsored-label">Sponsored</p>}
        {p.brand && <p className="text-xs font-semibold text-ink-faint">{p.brand}</p>}
        <p className="line-clamp-2 text-[15px] leading-snug text-ink group-hover:text-peacock">{p.title}</p>
        <TileRating p={p} className="mt-1" />
        {p.bought && <p className="mt-0.5 text-xs text-ink-soft">{p.bought}</p>}
        {p.deal && <div className="mt-1.5"><DealBadge deal={p.deal} discount={p.discount_pct} /></div>}
        <TilePrice p={p} className="mt-auto pt-1.5" />
        <TileDelivery p={p} />
      </TileLink>
      {quickPlus && <QuickAdd p={p} compact />}
      {showAdd && <div className="px-3 pb-3 sm:px-4 sm:pb-4"><QuickAdd p={p} /></div>}
    </div>
  );
}
