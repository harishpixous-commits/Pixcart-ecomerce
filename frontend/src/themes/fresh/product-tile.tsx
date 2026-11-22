"use client";

/*
 * Fresh tile (quick commerce): a compact white card with the photo on a tinted square, a discount or deal tag, the
 * delivery date as a chip, the title and rating, and the price with an ADD button at the bottom. The ADD button is
 * always there when the product can be added, whatever the list asks for: it is this theme's identity.
 * Behaviour (adding to the cart, ad links, the deal countdown, the out-of-stock band) comes from product-parts.
 *
 * The whole card opens the product (the link's ::after covers it); the wishlist heart and the ADD button sit above
 * that layer and are siblings of the link, never inside it.
 */

import { Clock, Loader2, Star } from "lucide-react";
import Link from "next/link";
import { DealCountdown, TileImage, TileLink, useQuickAdd } from "@/components/product-parts";
import { rupees } from "@/lib/format";
import type { ProductCard } from "@/lib/types";
import { WishlistHeart } from "@/lib/wishlist";
import type { ProductTileProps } from "@/themes/types";

const IST = "Asia/Kolkata";
const dayFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: IST });
const startFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: IST });

/*
 * Tiles narrower than 150 px inside (rails on phones) use a slimmer ADD button and price so both fit on one line;
 * the row still wraps (the button then takes the full width) if a long price does not fit.
 */
const ADD =
  "pc-press relative z-10 flex h-9 min-w-[72px] shrink-0 grow items-center justify-center rounded-lg border border-peacock bg-peacock-light px-3 " +
  "text-sm font-extrabold uppercase tracking-wide text-peacock-dark transition-colors hover:bg-peacock hover:text-white disabled:opacity-70 " +
  "[@container(max-width:149px)]:min-w-[58px] [@container(max-width:149px)]:px-2";

function AddButton({ p }: { p: ProductCard }) {
  const { add, busy, canAdd, needsOptions, optionsHref } = useQuickAdd(p);
  if (needsOptions) {
    const n = p.variant_count ?? 0;
    return (
      <Link href={optionsHref} className={`${ADD} flex-col gap-1 leading-none`} aria-label={`See options for ${p.title}`} data-testid="tile-options">
        <span aria-hidden>Add</span>
        <span className="text-[11px] font-semibold normal-case tracking-normal" aria-hidden>{n > 1 ? `${n} options` : "options"}</span>
      </Link>
    );
  }
  if (!canAdd) {
    return (
      <span className="flex h-9 shrink-0 grow items-center justify-center rounded-lg bg-mist px-2 text-center text-xs font-bold leading-tight text-ink-soft">
        Out of stock
      </span>
    );
  }
  return (
    <button type="button" onClick={add} disabled={busy} aria-label={`Add ${p.title} to cart`} data-testid="quick-add" className={ADD}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : "Add"}
    </button>
  );
}

/**
 * Tags over the top-left of the photo: the rank, then the deal's label (the compact deal badge; its countdown is
 * under the title) or else the discount.
 */
function Tags({ p, rank }: { p: ProductCard; rank?: number }) {
  if (rank === undefined && !p.deal && !(p.discount_pct > 0)) return null;
  const tag = "max-w-full truncate rounded-md px-1.5 py-1 text-[11px] font-extrabold leading-none";
  return (
    <div className="absolute left-1.5 top-1.5 flex max-w-[calc(100%-3rem)] flex-col items-start gap-1">
      {rank !== undefined && <span className={`${tag} bg-marigold text-ink`}>#{rank}</span>}
      {p.deal ? (
        <span className={`${tag} bg-vermilion text-white`} data-testid="deal-badge">{p.deal.label}</span>
      ) : p.discount_pct > 0 && (
        <span className={`${tag} bg-peacock uppercase text-white`}>{p.discount_pct}% off</span>
      )}
    </div>
  );
}

export function FreshProductTile({ p, rank }: ProductTileProps) {
  return (
    <div className="pc-lift group relative flex h-full flex-col rounded-xl bg-white p-2 shadow-card [container-type:inline-size]" data-testid="product-tile">
      <TileLink p={p}
        className="flex flex-1 flex-col rounded-lg after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-peacock">
        <div className="relative">
          <TileImage p={p} className="aspect-square rounded-lg bg-mist" imgClass="p-1.5 mix-blend-multiply" />
          <Tags p={p} rank={rank} />
        </div>
        <div className="flex flex-1 flex-col px-0.5 pt-2">
          {p.delivery_by && (
            <span className="mb-1.5 inline-flex w-fit max-w-full items-center gap-1 rounded-md bg-mist px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft">
              <Clock className="h-3 w-3 shrink-0 text-peacock" aria-hidden />
              <span className="truncate">By {dayFmt.format(new Date(p.delivery_by))}</span>
            </span>
          )}
          {p.sponsored && <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft" data-testid="sponsored-label">Sponsored</span>}
          <p className="line-clamp-2 min-h-[2.75em] text-[13px] font-semibold leading-snug text-ink">{p.title}</p>
          {p.unit_price && <p className="mt-0.5 text-[11px] text-ink-soft">{rupees(p.unit_price.paise)}/{p.unit_price.per}</p>}
          {p.rating_count > 0 && (
            <p className="mt-1 flex items-center gap-1 text-[11px] leading-none">
              <span className="sr-only">Rated {p.rating_avg.toFixed(1)} out of 5 from {p.rating_count.toLocaleString("en-IN")} ratings</span>
              <span className="font-bold text-leaf" aria-hidden>{p.rating_avg.toFixed(1)}</span>
              <Star className="h-3 w-3 fill-leaf text-leaf" aria-hidden />
              <span className="text-ink-soft" aria-hidden>({p.rating_count.toLocaleString("en-IN")})</span>
            </p>
          )}
          {p.deal && p.deal.kind !== "limited" && <DealCountdown endsAt={p.deal.ends_at} className="mt-1 text-[11px] font-semibold text-vermilion" />}
          {p.starts_at && <p className="mt-1 text-[11px] font-semibold text-peacock">Starts {startFmt.format(new Date(p.starts_at))}</p>}
        </div>
      </TileLink>
      <WishlistHeart productId={p.id}
        className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 shadow-sm before:absolute before:-inset-1 before:content-[''] hover:bg-white" />
      <div className="mt-2 flex flex-wrap items-center gap-1.5 px-0.5">
        <div className="shrink-0 grow-[100] leading-tight">
          <p className="font-display text-[15px] font-bold text-ink [@container(max-width:149px)]:text-sm">{rupees(p.price)}</p>
          {p.mrp > p.price && (
            <p className="text-xs text-ink-soft line-through"><span className="sr-only">M.R.P. </span>{rupees(p.mrp)}</p>
          )}
        </div>
        <AddButton p={p} />
      </div>
    </div>
  );
}
