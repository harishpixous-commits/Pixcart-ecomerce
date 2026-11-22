"use client";

/*
 * Product cards, grids and rails used across the store: search, categories, home blocks, deals, bestsellers, product
 * pages. The tile itself comes from the active theme (src/themes/<id>/product-tile.tsx); the grid and rail follow the
 * theme's layout (hairline grid, raised cards or airy, and how many tiles fit a row). The shared parts (deal badge,
 * countdown, adding to the cart) live in product-parts.tsx.
 */

import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ProductCard as Card } from "@/lib/types";
import { useLayout } from "@/themes/context";
import { useSlots } from "@/themes/slots";
import type { ProductTileProps, ThemeLayout } from "@/themes/types";

export { DealBadge, DealCountdown } from "@/components/product-parts";

/** The active theme's product tile. */
export function ProductTile(props: ProductTileProps) {
  const { ProductTile: Tile } = useSlots();
  return <Tile {...props} />;
}

const COLS: Record<ThemeLayout["gridColumns"], string> = {
  4: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
};

const GRID: Record<ThemeLayout["productGrid"], string> = {
  hairline: "gap-px overflow-hidden rounded-xl bg-line",
  cards: "gap-2.5 sm:gap-4",
  airy: "gap-x-4 gap-y-8 sm:gap-x-6 sm:gap-y-10",
};

/** The grid classes for product lists in the active theme (search results use them too). */
export function useGridClass(dense?: boolean): string {
  const layout = useLayout();
  return clsx("grid", GRID[layout.productGrid], dense ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : COLS[layout.gridColumns]);
}

export function ProductGrid({ items, dense, showAdd, ranked }: { items: Card[]; dense?: boolean; showAdd?: boolean; ranked?: boolean }) {
  const cls = useGridClass(dense);
  return (
    <div className={cls}>
      {items.map((p, i) => (
        <ProductTile key={`${p.id}-${i}`} p={p} showAdd={showAdd} rank={ranked ? i + 1 : undefined} />
      ))}
    </div>
  );
}

const RAIL_ITEM: Record<ThemeLayout["productGrid"], Record<ThemeLayout["gridColumns"], string>> = {
  hairline: {
    4: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[25%]",
    5: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[16.66%]",
    6: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[16.66%]",
  },
  cards: {
    4: "w-[44%] sm:w-[30%] lg:w-[23.6%]",
    5: "w-[44%] sm:w-[30%] lg:w-[18.7%]",
    6: "w-[40%] sm:w-[28%] md:w-[23%] lg:w-[15.6%]",
  },
  airy: {
    4: "w-[47%] sm:w-[31%] lg:w-[23.2%]",
    5: "w-[47%] sm:w-[31%] lg:w-[18.4%]",
    6: "w-[47%] sm:w-[31%] lg:w-[15.2%]",
  },
};

const RAIL_TRACK: Record<ThemeLayout["productGrid"], string> = {
  hairline: "",
  cards: "gap-2.5 px-3 pb-3 pt-1 sm:gap-4 sm:px-4 sm:pb-4",
  airy: "gap-4 pb-2 sm:gap-6",
};

/** A horizontal row with arrow buttons (desktop) and swipe (phones). */
export function ProductRail({ title, items, href, linkText = "See all", showAdd, ranked, note, extra }: {
  title: string; items: Card[]; href?: string; linkText?: string; showAdd?: boolean; ranked?: boolean; note?: string; extra?: React.ReactNode;
}) {
  const layout = useLayout();
  const plain = layout.home.sections === "plain";
  const box = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const update = () => {
    const el = box.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = requestAnimationFrame(update);
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(first); el.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [items.length]);
  if (!items.length) return null;
  const go = (d: number) => box.current?.scrollBy({ left: d * box.current.clientWidth * 0.9, behavior: "smooth" });
  return (
    <section className="shop-panel" aria-label={title} data-testid="product-rail">
      <div className={clsx("flex items-baseline justify-between gap-3 pb-1", plain ? "px-0 pt-1" : "px-4 pt-4")}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className={clsx("font-semibold", plain ? "text-xl sm:text-2xl" : "text-xl")}>{title}</h2>
          {note && <span className="text-xs text-ink-faint">{note}</span>}
          {extra}
        </div>
        {href && <Link href={href} className="shrink-0 text-sm font-semibold text-peacock hover:underline">{linkText}</Link>}
      </div>
      <div className="group/rail relative">
        <div ref={box} className={clsx("scroll-x flex snap-x overflow-x-auto", RAIL_TRACK[layout.productGrid], plain && layout.productGrid === "cards" && "px-0 sm:px-0")}>
          {items.map((p, i) => (
            <div key={`${p.id}-${i}`} className={clsx("shrink-0 snap-start", RAIL_ITEM[layout.productGrid][layout.gridColumns])}>
              <ProductTile p={p} showAdd={showAdd} rank={ranked ? i + 1 : undefined} />
            </div>
          ))}
        </div>
        {!edges.start && (
          <button type="button" onClick={() => go(-1)} aria-label="Scroll left" className="absolute left-0 top-1/3 hidden h-20 w-10 items-center justify-center rounded-r-lg bg-white/95 shadow-md ring-1 ring-line hover:bg-mist lg:flex">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {!edges.end && (
          <button type="button" onClick={() => go(1)} aria-label="Scroll right" className="absolute right-0 top-1/3 hidden h-20 w-10 items-center justify-center rounded-l-lg bg-white/95 shadow-md ring-1 ring-line hover:bg-mist lg:flex">
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </section>
  );
}
