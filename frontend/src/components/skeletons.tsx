"use client";

/*
 * Loading placeholders in the shape of what is coming, in the active storefront theme: corners, cards and the product
 * grid follow the theme (useLayout()), colours come from the theme's line and page colours (the `skeleton` class in
 * globals.css). No screen is ever blank or a lone spinner:
 *   - every route's loading.tsx shows its screen's skeleton while the next page is fetched;
 *   - PageLoader (components/ui.tsx) shows one while a page loads its own data.
 *
 * Every exported skeleton is wrapped in DelayedFallback: invisible for its first 180 ms (quick loads never flash), then
 * it fades in; it carries aria-busy and a "Loading" status for screen readers. Skeletons hand over to each other on
 * one clock (the route's skeleton, then the page's loader), so there is never a blank gap or a second fade between
 * them, and the content that finally replaces a visible skeleton fades in.
 *
 * Outside the shop (admin, seller hub, delivery app) useLayout() reports the default theme, so these still render.
 */

import clsx from "clsx";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import { useLayout } from "@/themes/context";
import type { ThemeLayout } from "@/themes/types";

/* ------------------------------------------------------------------ timing */

/** How long a loader stays invisible before it fades in: loads quicker than this show nothing at all. */
export const LOADER_DELAY = 180;
/** A loader that follows another within this many ms carries on its run instead of starting a new wait. */
const HANDOVER = 150;
/** How long content takes to fade in when it replaces a loader that was showing. */
const REVEAL_MS = 220;

// One clock for a run of skeletons that follow each other (route skeleton → page loader → section loader).
let mountedNow = 0;
let runStart = 0;
let runEnd = Number.NEGATIVE_INFINITY;

/** A skeleton that appeared at `since` mounts; returns how long the current run of skeletons has been going (ms). */
function beginRun(since: number): number {
  const now = performance.now();
  if (mountedNow === 0 && now - runEnd > HANDOVER) runStart = since;
  else runStart = Math.min(runStart, since);
  mountedNow += 1;
  return now - runStart;
}

function endRun() {
  mountedNow = Math.max(0, mountedNow - 1);
  if (mountedNow === 0) runEnd = performance.now();
}

/** When the browser started this loader's wait, if it already has (a server-rendered loader starts before hydration). */
function startedAt(el: HTMLElement): number | null {
  const anim = el.getAnimations?.().find((a) => (a as CSSAnimation).animationName === "pc-delayed-in");
  const t = anim?.startTime;
  return typeof t === "number" ? t : null;
}

/** An inline loader placed below the page's own heading leaves out its placeholder title (see globals.css). */
function markTitled(el: HTMLElement) {
  const heading = el.closest("main")?.querySelector("h1");
  if (heading && !el.contains(heading) && heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
    el.setAttribute("data-titled", "");
  }
}

/** Fades in what replaces a loader that was showing (new children of its parent that are not loaders themselves). */
function revealAfter(parent: HTMLElement, gone: HTMLElement) {
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const before = new Set(Array.from(parent.children));
  before.delete(gone);
  queueMicrotask(() => {
    for (const child of Array.from(parent.children)) {
      if (before.has(child) || !(child instanceof HTMLElement) || typeof child.animate !== "function") continue;
      if (child.classList.contains("pc-delayed") || child.querySelector(".pc-delayed")) continue;
      child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REVEAL_MS, easing: "ease-out" });
    }
  });
}

/**
 * Shows its children after a short delay (CSS, so it works before the page's scripts load too), fading them in.
 * Taking over from a loader that is already showing, it carries on from there (no blank gap, no second fade).
 */
export function DelayedFallback({ children, delay = LOADER_DELAY, label = "Loading", className }: {
  children: React.ReactNode;
  /** ms before it shows; 0 shows it at once */
  delay?: number;
  /** what screen readers hear */
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const now = performance.now();
    const own = startedAt(el);
    const shown = beginRun(own ?? now);
    // Following a loader that is already on its way: line this one's fade up with it (a negative delay starts part way).
    if (own === null && shown > 1) el.style.animationDelay = `${Math.round(delay - shown)}ms`;
    markTitled(el);
    const parent = el.parentElement;
    return () => {
      const wasShowing = performance.now() - runStart >= delay;
      endRun();
      if (wasShowing && parent) revealAfter(parent, el);
    };
  }, [delay]);
  return (
    <div
      ref={ref}
      aria-busy="true"
      className={clsx("pc-delayed pc-bare", className)}
      style={delay === LOADER_DELAY ? undefined : { animationDelay: `${delay}ms` }}
    >
      <span className="sr-only" role="status">{label}</span>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ primitives */

/** Text bars round off with the theme's corners (soft in Fresh, nearly square in Luxe). */
const BAR = "rounded-[calc(var(--r-lg)*0.75)]";

type Rounded = "none" | "md" | "lg" | "xl" | "2xl" | "full";
const ROUNDED: Record<Rounded, string> = { none: "", md: "rounded-md", lg: "rounded-lg", xl: "rounded-xl", "2xl": "rounded-2xl", full: "rounded-full" };

/** A shimmering block: an image, a button, a card. Size it with className. */
export function SkeletonBlock({ className, rounded = "lg" }: { className?: string; rounded?: Rounded }) {
  return <span aria-hidden className={clsx("skeleton block shrink-0", ROUNDED[rounded], className)} />;
}

/** Lines of text; the last one is shorter. */
export function SkeletonText({ lines = 3, className, lineClassName = "h-3.5", last = "w-2/3" }: {
  lines?: number; className?: string; lineClassName?: string; last?: string;
}) {
  return (
    <span aria-hidden className={clsx("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className={clsx("skeleton block max-w-full", BAR, lineClassName, i === lines - 1 && lines > 1 ? last : "w-full")} />
      ))}
    </span>
  );
}

export function SkeletonCircle({ className }: { className?: string }) {
  return <span aria-hidden className={clsx("skeleton block shrink-0 rounded-full", className ?? "h-10 w-10")} />;
}

/** One bar of text: set its height and width. */
function Line({ className }: { className?: string }) {
  return <span aria-hidden className={clsx("skeleton block max-w-full", BAR, className)} />;
}

/** A block that sets its own corners. */
function Bone({ className }: { className?: string }) {
  return <span aria-hidden className={clsx("skeleton block shrink-0", className)} />;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5", "w-3/5"];

/** Props every exported skeleton takes. */
interface SkeletonProps {
  className?: string;
  /** ms before it shows (default 180; 0 shows it at once) */
  delay?: number;
}

/** A white card as the theme draws cards on shop pages. */
const CARD = "rounded-2xl bg-white shadow-card";

/** A page title with an optional line under it (left out when the page already shows its heading). */
function TitleShape({ sub = true, className }: { sub?: boolean; className?: string }) {
  return (
    <div className={clsx("pc-sk-title flex flex-col gap-2 px-1", className)}>
      <Line className="h-7 w-48 sm:h-8 sm:w-60" />
      {sub && <Line className="h-4 w-72" />}
    </div>
  );
}

/* ------------------------------------------------------------------ product tiles, grids and rails */

type Grid = ThemeLayout["productGrid"];
type Cols = ThemeLayout["gridColumns"];

/*
 * The same grid and rail as useGridClass and ProductRail (components/product.tsx). They are mirrored here because
 * product.tsx loads every theme's components and imports ui.tsx, which imports this file: loaders stay light and there
 * is no import cycle. Keep the two in step.
 */
const GRID: Record<Grid, string> = {
  hairline: "gap-px overflow-hidden rounded-xl bg-line",
  cards: "gap-2.5 sm:gap-4",
  airy: "gap-x-4 gap-y-8 sm:gap-x-6 sm:gap-y-10",
};
const COLS: Record<Cols, string> = {
  4: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
};
const DENSE = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4";
/** Two full rows at the widest size; the tiles that would leave a row half full are hidden at the sizes in between. */
const FILL: Record<Cols, { count: number; from: number; hide: string }> = {
  4: { count: 8, from: 6, hide: "sm:hidden lg:block" },
  5: { count: 10, from: 9, hide: "sm:hidden lg:block" },
  6: { count: 12, from: 10, hide: "lg:hidden xl:block" },
};
const RAIL_ITEM: Record<Grid, Record<Cols, string>> = {
  hairline: {
    4: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[25%]",
    5: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[16.66%]",
    6: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[16.66%]",
  },
  cards: { 4: "w-[44%] sm:w-[30%] lg:w-[23.6%]", 5: "w-[44%] sm:w-[30%] lg:w-[18.7%]", 6: "w-[40%] sm:w-[28%] md:w-[23%] lg:w-[15.6%]" },
  airy: { 4: "w-[47%] sm:w-[31%] lg:w-[23.2%]", 5: "w-[47%] sm:w-[31%] lg:w-[18.4%]", 6: "w-[47%] sm:w-[31%] lg:w-[15.2%]" },
};
const RAIL_TRACK: Record<Grid, string> = {
  hairline: "",
  cards: "gap-2.5 px-3 pb-3 pt-1 sm:gap-4 sm:px-4 sm:pb-4",
  airy: "gap-4 pb-2 sm:gap-6",
};

/** One product tile: a hairline cell (Classic), a raised card with its add button (Bazaar, Fresh) or a tall airy photo (Luxe). */
function TileShape({ grid }: { grid: Grid }) {
  if (grid === "airy") {
    return (
      <div className="flex h-full flex-col gap-2.5">
        <Bone className="aspect-[4/5] w-full rounded-lg" />
        <Line className="mt-1 h-2.5 w-1/4" />
        <Line className="h-3.5 w-4/5" />
        <Line className="h-3.5 w-1/3" />
      </div>
    );
  }
  if (grid === "cards") {
    return (
      <div className="flex h-full flex-col rounded-xl bg-white p-2 shadow-card">
        <Bone className="aspect-square w-full rounded-lg" />
        <div className="flex flex-1 flex-col gap-2 px-0.5 pt-2.5">
          <Line className="h-3 w-16" />
          <Line className="h-3 w-full" />
          <Line className="h-3 w-3/4" />
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 px-0.5">
          <Line className="h-4 w-14" />
          <Bone className="h-9 w-[72px] rounded-lg" />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col gap-2 bg-white p-3 sm:p-4">
      <Bone className="aspect-square w-full rounded-lg" />
      <Line className="mt-1 h-3.5 w-11/12" />
      <Line className="h-3.5 w-2/3" />
      <Line className="h-4 w-12" />
      <Line className="mt-1.5 h-5 w-1/2" />
      <Line className="h-3 w-3/4" />
    </div>
  );
}

/** A product grid in the theme's style. `dense` is the four-column grid beside a filter column. */
function GridShape({ dense, count }: { dense?: boolean; count?: number }) {
  const layout = useLayout();
  const cols: Cols = dense ? 4 : layout.gridColumns;
  const fill = FILL[cols];
  const n = count ?? fill.count;
  return (
    <div className={clsx("grid", GRID[layout.productGrid], dense ? DENSE : COLS[cols])}>
      {range(n).map((i) => (
        <div key={i} className={clsx(count === undefined && i >= fill.from && fill.hide)}>
          <TileShape grid={layout.productGrid} />
        </div>
      ))}
    </div>
  );
}

/** A titled row of tiles that runs off the right edge, like ProductRail. */
function RailShape({ count = 7 }: { count?: number }) {
  const layout = useLayout();
  const plain = layout.home.sections === "plain";
  const grid = layout.productGrid;
  return (
    <section className="shop-panel overflow-hidden">
      <div className={clsx("flex items-center justify-between gap-3 pb-1", plain ? "px-0 pb-3 pt-1" : "px-4 pt-4")}>
        <Line className={plain ? "h-7 w-52" : "h-6 w-44"} />
        <Line className="h-4 w-14" />
      </div>
      <div className={clsx("flex overflow-hidden", RAIL_TRACK[grid], plain && grid === "cards" && "px-0 sm:px-0")}>
        {range(count).map((i) => (
          <div key={i} className={clsx("shrink-0", RAIL_ITEM[grid][layout.gridColumns])}>
            <TileShape grid={grid} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ProductGridSkeleton({ dense, count, className, delay }: SkeletonProps & { dense?: boolean; count?: number }) {
  return (
    <DelayedFallback label="Loading products" className={className} delay={delay}>
      <GridShape dense={dense} count={count} />
    </DelayedFallback>
  );
}

export function RailSkeleton({ count, className, delay }: SkeletonProps & { count?: number }) {
  return (
    <DelayedFallback label="Loading products" className={className} delay={delay}>
      <RailShape count={count} />
    </DelayedFallback>
  );
}

/* ------------------------------------------------------------------ home */

/** The hero banner with the outline of its heading, text and button. */
function HeroShape() {
  return (
    <div className="skeleton relative aspect-[16/8] w-full overflow-hidden rounded-xl sm:aspect-[16/5]">
      <div className="absolute inset-y-0 left-0 flex w-3/4 flex-col justify-center gap-2.5 p-6 sm:w-1/2 sm:gap-3.5 sm:p-12">
        <span className={clsx("block h-6 w-11/12 bg-white/50 sm:h-10", BAR)} />
        <span className={clsx("block h-4 w-2/3 bg-white/40 sm:h-5", BAR)} />
        <span className="mt-1 block h-8 w-28 rounded-lg bg-white/50 sm:h-10 sm:w-36" />
      </div>
    </div>
  );
}

/** The home category block in the theme's style: round icons, raised cards, dense squares or text chips. */
function CategoryShape({ style }: { style: ThemeLayout["home"]["categories"] }) {
  if (style === "chips") {
    const widths = ["w-20", "w-28", "w-24", "w-16", "w-24", "w-20", "w-28", "w-16"];
    return (
      <div className="shop-panel shop-panel-pad flex max-h-[5.75rem] flex-wrap justify-center gap-2 overflow-hidden px-4 py-3">
        {widths.map((w, i) => <Bone key={i} className={clsx("h-10 rounded-full", w)} />)}
      </div>
    );
  }
  if (style === "squares") {
    return (
      <div className="shop-panel shop-panel-pad grid grid-cols-4 gap-x-2.5 gap-y-4 p-3 sm:grid-cols-8 sm:p-4 lg:grid-cols-10">
        {range(10).map((i) => (
          <div key={i} className={clsx("flex-col items-center gap-2", i >= 8 ? "hidden lg:flex" : "flex")}>
            <Bone className="aspect-square w-full rounded-xl" />
            <Line className="h-2.5 w-3/4" />
          </div>
        ))}
      </div>
    );
  }
  if (style === "cards") {
    return (
      <div className="shop-panel shop-panel-pad grid grid-cols-4 gap-2 p-3 sm:grid-cols-6 sm:gap-3 sm:p-4 lg:grid-cols-8">
        {range(8).map((i) => (
          <div key={i} className={clsx("flex-col items-center gap-2 rounded-xl bg-white p-1.5 shadow-card sm:p-2", i >= 6 ? "flex sm:hidden lg:flex" : "flex")}>
            <Bone className="aspect-square w-full rounded-lg" />
            <Line className="mb-1 h-3 w-3/4" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="shop-panel flex gap-1 overflow-hidden px-2 py-3 sm:grid sm:grid-cols-8">
      {range(8).map((i) => (
        <div key={i} className="flex w-[84px] shrink-0 flex-col items-center gap-2 px-1 py-2 sm:w-auto">
          <SkeletonCircle className="h-14 w-14" />
          <Line className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

/** Home: the hero, the category block and two product rows. */
export function HomeSkeleton({ className, delay }: SkeletonProps) {
  const layout = useLayout();
  const plain = layout.home.sections === "plain";
  return (
    <DelayedFallback label="Loading the store" delay={delay} className={clsx("flex flex-col", plain ? "gap-8 sm:gap-10" : "gap-4", className)}>
      <HeroShape />
      <CategoryShape style={layout.home.categories} />
      <RailShape />
      <RailShape />
    </DelayedFallback>
  );
}

/* ------------------------------------------------------------------ category, search and store pages */

function Crumb() {
  return <Line className="pc-sk-title ml-1 h-4 w-56" />;
}

/** The filter column (Classic, Bazaar): a heading and groups of options. */
function FilterColumnShape() {
  return (
    <aside className="shop-panel shop-panel-pad hidden self-start p-4 lg:block">
      <Line className="mb-5 h-5 w-20" />
      <div className="flex flex-col gap-6">
        {[3, 1, 4, 2, 2].map((rows, g) => (
          <div key={g} className="flex flex-col gap-2.5">
            <Line className="h-4 w-24" />
            {range(rows).map((r) => (
              <div key={r} className="flex items-center gap-2">
                <Bone className="h-4 w-4 rounded" />
                <Line className={clsx("h-3.5", WIDTHS[(g + r) % WIDTHS.length])} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Results with the filters in a column on the left (or a Filters button on phones) and sort on the right. */
function SidebarListing({ heading = true, column = "lg:grid-cols-[250px_1fr]" }: { heading?: boolean; column?: string }) {
  return (
    <div className={clsx("grid gap-4", column)}>
      <FilterColumnShape />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="shop-panel shop-panel-pad flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col gap-2">
            {heading && <Line className="h-7 w-44" />}
            <Line className="h-3.5 w-36" />
          </div>
          <div className="flex items-center gap-2">
            <Bone className="h-8 w-24 rounded-lg lg:hidden" />
            <Bone className="h-9 w-36 rounded-lg sm:w-44" />
          </div>
        </div>
        <GridShape dense />
      </div>
    </div>
  );
}

/** Results with a bar of filter buttons on top (Fresh, Luxe) and sort on the right. */
function TopbarListing({ heading = true }: { heading?: boolean }) {
  const pills = ["w-24", "w-20", "w-28", "w-24", "w-20"];
  return (
    <div className="flex flex-col gap-4">
      {heading && (
        <div className="flex flex-col gap-2 px-1">
          <Line className="h-8 w-56" />
          <Line className="h-4 w-40" />
        </div>
      )}
      <div className="flex items-center gap-2 overflow-hidden border-y border-line py-3">
        {pills.map((w, i) => <Bone key={i} className={clsx("h-9 rounded-full", w, i > 1 && "hidden sm:block", i > 3 && "sm:hidden lg:block")} />)}
        <Bone className="ml-auto h-9 w-32 rounded-lg sm:w-40" />
      </div>
      <GridShape />
    </div>
  );
}

function ListingShape({ crumb, heading = true }: { crumb?: boolean; heading?: boolean }) {
  const layout = useLayout();
  return (
    <div className="flex flex-col gap-3">
      {crumb && <Crumb />}
      {layout.listing.filters === "topbar" ? <TopbarListing heading={heading} /> : <SidebarListing heading={heading} />}
    </div>
  );
}

/** Category and search results: filters as a column or a bar on top, per the theme. */
export function ListingSkeleton({ crumb, className, delay }: SkeletonProps & { crumb?: boolean }) {
  return (
    <DelayedFallback label="Loading products" className={className} delay={delay}>
      <ListingShape crumb={crumb} />
    </DelayedFallback>
  );
}

/** A seller's store: the banner with its name, then the store's products. */
export function StoreSkeleton({ className, delay }: SkeletonProps) {
  return (
    <DelayedFallback label="Loading the store" delay={delay} className={clsx("flex flex-col gap-4", className)}>
      <div className="skeleton flex min-h-[124px] flex-col justify-center gap-3 rounded-xl p-6">
        <span className={clsx("block h-8 w-56 max-w-full bg-white/50", BAR)} />
        <span className={clsx("block h-4 w-80 max-w-full bg-white/40", BAR)} />
      </div>
      <ListingShape heading={false} />
    </DelayedFallback>
  );
}

/** All categories: a card per department with its sub-categories. */
export function CategoriesSkeleton({ className, delay }: SkeletonProps) {
  return (
    <DelayedFallback label="Loading categories" delay={delay} className={clsx("flex flex-col gap-3", className)}>
      <TitleShape sub={false} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {range(6).map((i) => (
          <div key={i} className="shop-panel shop-panel-pad flex flex-col gap-3 p-4">
            <div className="flex items-center gap-3">
              <SkeletonCircle className="h-11 w-11" />
              <Line className="h-5 w-32" />
              <Line className="ml-auto h-4 w-8" />
            </div>
            <div className="flex flex-wrap gap-2">
              {range(3 + (i % 3)).map((j) => <Bone key={j} className={clsx("h-7 rounded-full", ["w-20", "w-16", "w-24"][j % 3])} />)}
            </div>
          </div>
        ))}
      </div>
    </DelayedFallback>
  );
}

/** Today's deals: the heading, the kinds of deals as pills, then the deals with their filters. */
export function DealsSkeleton({ className, delay }: SkeletonProps) {
  const layout = useLayout();
  const pills = ["w-24", "w-36", "w-32", "w-36", "w-28", "w-32"];
  return (
    <DelayedFallback label="Loading deals" delay={delay} className={clsx("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-2 px-1">
        <Line className="h-8 w-52 sm:h-9" />
        <Line className="h-4 w-full max-w-xl" />
      </div>
      <div className="flex gap-2 overflow-hidden">
        {pills.map((w, i) => <Bone key={i} className={clsx("h-10 rounded-full", w)} />)}
      </div>
      {layout.listing.filters === "topbar" ? <TopbarListing heading={false} /> : <SidebarListing heading={false} column="lg:grid-cols-[230px_1fr]" />}
    </DelayedFallback>
  );
}

/** Bestsellers and new releases: departments on the left, a heading card, then a ranked row per department. */
export function TopListSkeleton({ className, delay }: SkeletonProps) {
  return (
    <DelayedFallback label="Loading the list" delay={delay} className={clsx("grid gap-4 lg:grid-cols-[230px_1fr]", className)}>
      <aside className="shop-panel shop-panel-pad hidden self-start p-3 lg:block">
        <Line className="mx-2 mb-3 mt-1 h-4 w-32" />
        <div className="flex flex-col gap-3 px-2 pb-2">
          {range(9).map((i) => <Line key={i} className={clsx("h-3.5", WIDTHS[i % WIDTHS.length])} />)}
        </div>
      </aside>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="shop-panel shop-panel-pad flex flex-col gap-2.5 p-4 sm:p-5">
          <Line className="h-8 w-52 sm:h-9" />
          <Line className="h-4 w-full max-w-lg" />
          <div className="mt-1 flex gap-2 overflow-hidden lg:hidden">
            {range(5).map((i) => <Bone key={i} className={clsx("h-7 rounded-full", ["w-20", "w-24", "w-16"][i % 3])} />)}
          </div>
        </div>
        <RailShape />
        <RailShape />
      </div>
    </DelayedFallback>
  );
}

/* ------------------------------------------------------------------ product page */

function Dots() {
  return (
    <div className="flex justify-center gap-1.5">
      {range(4).map((i) => <Bone key={i} className={clsx("h-2 rounded-full", i === 0 ? "w-5" : "w-2")} />)}
    </div>
  );
}

/** Title, rating, price, offers, options and "About this item". */
function DetailsShape({ editorial }: { editorial?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Line className={editorial ? "h-3 w-24" : "h-4 w-36"} />
      <div className="flex flex-col gap-2">
        <Line className={editorial ? "h-8 w-full" : "h-6 w-full sm:h-7"} />
        <Line className={editorial ? "h-8 w-2/3" : "h-6 w-3/4 sm:h-7"} />
      </div>
      <Line className="h-4 w-52" />
      <div className="mt-1 flex flex-col gap-2 border-t border-line pt-4">
        <Line className="h-9 w-44" />
        <Line className="h-3.5 w-32" />
      </div>
      {!editorial && <Bone className="h-[72px] w-full rounded-lg" />}
      <div className="flex flex-col gap-2 pt-1">
        <Line className="h-4 w-24" />
        <div className="flex flex-wrap gap-2">
          {range(4).map((i) => <Bone key={i} className={clsx("h-11 w-16", editorial ? "rounded-lg" : "rounded-lg")} />)}
        </div>
      </div>
      <div className="flex flex-col gap-2 pt-2">
        <Line className="h-5 w-40" />
        <Line className="h-3.5 w-full" />
        <Line className="h-3.5 w-11/12" />
        <Line className="h-3.5 w-4/5" />
      </div>
    </div>
  );
}

/** Price, delivery, stock, quantity, the two buy buttons and who sells it. */
function BuyShape({ className, pill }: { className?: string; pill?: boolean }) {
  return (
    <div className={clsx("flex flex-col gap-3", className)}>
      <Line className="h-8 w-32" />
      <div className="flex flex-col gap-1.5">
        <Line className="h-4 w-full" />
        <Line className="h-4 w-2/3" />
      </div>
      <Line className="h-5 w-24" />
      <div className="flex items-center gap-3">
        <Line className="h-4 w-16" />
        <Bone className="h-10 w-20 rounded-lg" />
      </div>
      <Bone className={clsx("h-12 w-full", pill ? "rounded-full" : "rounded-lg")} />
      <Bone className={clsx("h-12 w-full", pill ? "rounded-full" : "rounded-lg")} />
      <div className="flex flex-col gap-2 pt-1">
        {range(4).map((i) => (
          <div key={i} className="grid grid-cols-[88px_1fr] gap-3">
            <Line className="h-3 w-16" />
            <Line className={clsx("h-3", WIDTHS[i % WIDTHS.length])} />
          </div>
        ))}
      </div>
    </div>
  );
}

function DescriptionShape() {
  return (
    <div className="shop-panel shop-panel-pad flex flex-col gap-3 p-4 sm:p-6">
      <Line className="h-6 w-48" />
      <SkeletonText lines={4} last="w-1/2" />
    </div>
  );
}

/** Classic: gallery with thumbnails, details, and the buy box in a third column on wide screens. */
function PdpThree() {
  return (
    <div className="grid gap-6 rounded-xl bg-white p-4 sm:p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]">
      <div className="flex gap-3 lg:row-span-2 xl:row-span-1">
        <div className="hidden w-16 shrink-0 flex-col gap-2 sm:flex">
          {range(5).map((i) => <Bone key={i} className="aspect-square w-full rounded-lg" />)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Bone className="aspect-square w-full rounded-xl" />
          <div className="sm:hidden"><Dots /></div>
        </div>
      </div>
      <DetailsShape />
      <BuyShape pill className="rounded-xl border border-line p-4 lg:col-start-2 xl:col-start-3" />
    </div>
  );
}

/** Two columns: the gallery on the left, details and a buy panel (sticky on desktop) on the right. */
function PdpTwo() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-6">
      <div className="shop-panel flex flex-col gap-3 p-3 sm:p-4 lg:sticky lg:top-28">
        <Bone className="aspect-square w-full rounded-xl" />
        <div className="hidden gap-2 sm:flex">
          {range(5).map((i) => <Bone key={i} className="h-16 w-16 rounded-lg" />)}
        </div>
        <div className="sm:hidden"><Dots /></div>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="shop-panel shop-panel-pad p-4 sm:p-6"><DetailsShape /></div>
        <BuyShape className="shop-panel p-4 shadow-card sm:p-5" />
      </div>
    </div>
  );
}

/** Boutique: large photos in two columns on desktop (one swipe photo on phones), the details column beside them. */
function PdpGallery() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-10 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="min-w-0">
        <div className="flex flex-col gap-3 lg:hidden">
          <Bone className="aspect-[4/5] w-full rounded-lg" />
          <Dots />
        </div>
        <div className="hidden grid-cols-2 gap-2 lg:grid">
          {range(4).map((i) => <Bone key={i} className="aspect-[4/5] w-full rounded-lg" />)}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-28">
        <DetailsShape editorial />
        <Bone className="h-12 w-full rounded-lg" />
        <Bone className="h-12 w-full rounded-lg" />
        <div className="flex flex-col">
          {range(3).map((i) => (
            <div key={i} className="flex items-center justify-between border-b border-line py-4">
              <Line className={clsx("h-4", ["w-40", "w-32", "w-36"][i])} />
              <Bone className="h-4 w-4 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A product page in the theme's arrangement: three columns, two columns, or a large gallery. */
export function ProductPageSkeleton({ className, delay }: SkeletonProps) {
  const layout = useLayout();
  const arrangement = layout.pdp.layout;
  return (
    <DelayedFallback label="Loading product" delay={delay} className={clsx("flex flex-col gap-4", className)}>
      <Line className="ml-1 h-4 w-72" />
      {arrangement === "gallery" ? <PdpGallery /> : arrangement === "two" ? <PdpTwo /> : <PdpThree />}
      <DescriptionShape />
    </DelayedFallback>
  );
}

/* ------------------------------------------------------------------ cart and checkout */

function CartGroupShape({ lines }: { lines: number }) {
  return (
    <div className={clsx(CARD, "overflow-hidden")}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Bone className="h-4 w-4 rounded" />
          <Line className="h-4 w-44" />
        </div>
        <Bone className="h-6 w-24 rounded-full" />
      </div>
      <div className="divide-y divide-line">
        {range(lines).map((i) => (
          <div key={i} className="flex gap-3 p-4 sm:gap-4 sm:p-5">
            <Bone className="h-24 w-24 rounded-xl sm:h-28 sm:w-28" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Line className="h-4 w-full" />
              <Line className="h-4 w-2/3" />
              <Line className="h-3 w-24" />
              <Line className="mt-1 h-5 w-28" />
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Bone className="h-9 w-28 rounded-lg" />
                <Bone className="h-9 w-20 rounded-lg" />
                <Bone className="hidden h-9 w-20 rounded-lg sm:block" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The bill: price lines, the total, and (unless a bottom bar holds it) the buy button. */
function BillShape({ button = true, className }: { button?: boolean; className?: string }) {
  return (
    <div className={clsx(CARD, "flex flex-col gap-4 p-4 sm:p-5", className)}>
      <Line className="h-3 w-24" />
      <div className="flex flex-col gap-3">
        {range(3).map((i) => (
          <div key={i} className="flex justify-between gap-6">
            <Line className={clsx("h-4", ["w-1/2", "w-2/5", "w-1/3"][i])} />
            <Line className="h-4 w-16" />
          </div>
        ))}
      </div>
      <div className="flex justify-between gap-6 border-t border-dashed border-line pt-3">
        <Line className="h-5 w-20" />
        <Line className="h-5 w-24" />
      </div>
      {button && (
        <>
          <Bone className="h-12 w-full rounded-lg" />
          <Line className="mx-auto h-3 w-3/4" />
        </>
      )}
    </div>
  );
}

function CartHeadShape() {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 px-1">
      <Line className="h-8 w-48" />
      <Line className="h-5 w-40" />
    </div>
  );
}

/** The cart in the theme's arrangement: the bill in a side column, or one column with a total bar at the bottom. */
export function CartSkeleton({ className, delay }: SkeletonProps) {
  const layout = useLayout();
  if (layout.cart.summary === "sticky") {
    return (
      <DelayedFallback label="Loading your cart" delay={delay} className={className}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pb-24">
          <CartHeadShape />
          <CartGroupShape lines={2} />
          <CartGroupShape lines={1} />
          <BillShape button={false} />
        </div>
        <div className="fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white px-3 py-2.5 shadow-[0_-4px_16px_rgb(0_0_0/0.06)] sm:bottom-0">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Line className="h-6 w-24" />
              <Line className="h-3 w-16" />
            </div>
            <Bone className="h-11 w-40 rounded-lg" />
          </div>
        </div>
      </DelayedFallback>
    );
  }
  return (
    <DelayedFallback label="Loading your cart" delay={delay} className={clsx("grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start", className)}>
      <div className="flex min-w-0 flex-col gap-3">
        <CartHeadShape />
        <CartGroupShape lines={2} />
        <CartGroupShape lines={1} />
      </div>
      <BillShape className="lg:mt-12" />
    </DelayedFallback>
  );
}

/** A checkout step: an icon, a heading with a line under it, then its rows. */
function StepShape({ rows }: { rows: number }) {
  return (
    <div className={clsx(CARD, "flex flex-col gap-4 p-4 sm:p-5")}>
      <div className="flex items-center gap-3">
        <Bone className="h-9 w-9 rounded-xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Line className="h-5 w-40" />
          <Line className="h-3 w-56" />
        </div>
      </div>
      {range(rows).map((i) => (
        <div key={i} className="flex items-start gap-3 rounded-xl border border-line p-3">
          <SkeletonCircle className="mt-0.5 h-5 w-5" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Line className="h-4 w-40" />
            <Line className={clsx("h-3.5", WIDTHS[i % WIDTHS.length])} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Checkout: address, items and payment on the left, the bill on the right. */
export function CheckoutSkeleton({ className, delay }: SkeletonProps) {
  return (
    <DelayedFallback label="Loading checkout" delay={delay} className={className}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
        <Line className="h-8 w-36" />
        <Line className="h-4 w-44" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-x-6">
        <div className="flex min-w-0 flex-col gap-4">
          <StepShape rows={2} />
          <StepShape rows={1} />
          <StepShape rows={2} />
        </div>
        <BillShape />
      </div>
    </DelayedFallback>
  );
}

/* ------------------------------------------------------------------ orders, details, forms, lists */

/** Your orders: one card per order with its photos, number, total and status. */
export function OrdersSkeleton({ className, delay }: SkeletonProps) {
  return (
    <DelayedFallback label="Loading your orders" delay={delay} className={clsx("flex flex-col gap-3", className)}>
      <TitleShape sub={false} />
      {range(4).map((i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl bg-white p-4 sm:flex-row sm:items-center">
          <div className="flex -space-x-3">
            {range(i % 2 ? 1 : 3).map((j) => <Bone key={j} className="h-16 w-16 rounded-lg border-2 border-white" />)}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Line className={clsx("h-4", WIDTHS[i % WIDTHS.length])} />
            <Line className="h-3.5 w-56" />
          </div>
          <div className="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-2">
            <Line className="h-6 w-20" />
            <Bone className="h-5 w-20 rounded-full" />
          </div>
        </div>
      ))}
    </DelayedFallback>
  );
}

function DetailShape() {
  return (
    <div className="flex flex-col gap-4">
      <div className={clsx(CARD, "flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5")}>
        <div className="flex min-w-0 flex-col gap-2">
          <Line className="h-7 w-56" />
          <Line className="h-4 w-40" />
        </div>
        <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
          <Line className="h-7 w-28" />
          <Line className="h-4 w-36" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {range(2).map((i) => (
            <div key={i} className={clsx(CARD, "overflow-hidden")}>
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
                <Line className="h-4 w-56" />
                <Bone className="h-6 w-20 rounded-full" />
              </div>
              <div className="flex flex-col gap-4 p-4 sm:p-5">
                <div className="flex items-center gap-2" aria-hidden>
                  {range(4).map((j) => (
                    <div key={j} className={clsx("flex items-center gap-2", j < 3 && "flex-1")}>
                      <SkeletonCircle className="h-5 w-5" />
                      {j < 3 && <span className="skeleton block h-1 flex-1 rounded-full" />}
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <Bone className="h-16 w-16 rounded-lg" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Line className="h-4 w-4/5" />
                    <Line className="h-3.5 w-1/3" />
                  </div>
                  <Line className="h-4 w-16" />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className={clsx(CARD, "flex flex-col gap-3 p-4 sm:p-5")}>
          <Line className="h-5 w-32" />
          {range(5).map((i) => (
            <div key={i} className="flex justify-between gap-6">
              <Line className={clsx("h-4", WIDTHS[i % WIDTHS.length])} />
              <Line className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A record's page (an order, a ticket): a header card, sections on the left and a summary on the right. */
export function DetailSkeleton({ className, delay, label = "Loading" }: SkeletonProps & { label?: string }) {
  return (
    <DelayedFallback label={label} delay={delay} className={className}>
      <DetailShape />
    </DelayedFallback>
  );
}

function FieldShape({ wide }: { wide?: boolean }) {
  return (
    <div className={clsx("flex flex-col gap-2", wide && "sm:col-span-2")}>
      <Line className="h-3.5 w-28" />
      <Bone className="h-10 w-full rounded-lg" />
    </div>
  );
}

function FormShape() {
  return (
    <>
      <section className="flex flex-col gap-4 rounded-xl bg-white p-5">
        <Line className="h-7 w-44" />
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShape />
          <FieldShape />
          <FieldShape wide />
        </div>
        <Line className="h-4 w-56" />
        <div className="flex gap-2">
          <Bone className="h-10 w-32 rounded-lg" />
          <Bone className="h-10 w-24 rounded-lg" />
        </div>
      </section>
      <section className="flex flex-col gap-4 rounded-xl bg-white p-5">
        <div className="flex items-center justify-between gap-3">
          <Line className="h-6 w-40" />
          <Bone className="h-8 w-28 rounded-lg" />
        </div>
        {range(2).map((i) => (
          <div key={i} className="flex flex-col gap-2 border-t border-line pt-4">
            <Line className="h-4 w-48" />
            <Line className={clsx("h-3.5", WIDTHS[i % WIDTHS.length])} />
          </div>
        ))}
      </section>
    </>
  );
}

/** Settings and profile forms: sections of labelled fields. `narrow` centres it like the account page. */
export function FormSkeleton({ narrow, className, delay }: SkeletonProps & { narrow?: boolean }) {
  return (
    <DelayedFallback label="Loading" delay={delay} className={clsx("flex flex-col gap-4", narrow && "mx-auto w-full max-w-3xl", className)}>
      <FormShape />
    </DelayedFallback>
  );
}

function TableShape({ rows = 8 }: { rows?: number }) {
  // Phones show two columns, tablets three, desktops five (the table itself scrolls sideways when it arrives).
  const cols = "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,1fr))] lg:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))]";
  return (
    <div className="overflow-hidden rounded-xl bg-white">
      <div className={clsx(cols, "border-b border-line px-4 py-3")}>
        {range(5).map((i) => <Line key={i} className={clsx("h-3 w-16", i === 2 && "hidden sm:block", i > 2 && "hidden lg:block")} />)}
      </div>
      <div className="divide-y divide-line">
        {range(rows).map((r) => (
          <div key={r} className={clsx(cols, "items-center px-4 py-3.5")}>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Line className="h-4 w-28" />
              <Line className="h-3 w-20" />
            </div>
            <Line className={clsx("h-4", WIDTHS[r % WIDTHS.length])} />
            <Line className={clsx("hidden h-4 sm:block", WIDTHS[(r + 2) % WIDTHS.length])} />
            <Line className="hidden h-4 w-16 lg:block" />
            <Bone className="hidden h-5 w-20 rounded-full lg:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Admin and seller tables: a header row and rows of cells. */
export function TableSkeleton({ rows, className, delay }: SkeletonProps & { rows?: number }) {
  return (
    <DelayedFallback label="Loading" delay={delay} className={className}>
      <TableShape rows={rows} />
    </DelayedFallback>
  );
}

function ListShape({ rows = 6 }: { rows?: number }) {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl bg-white">
      {range(rows).map((i) => (
        <div key={i} className="flex items-center gap-3 p-4">
          <Bone className="h-12 w-12 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Line className={clsx("h-4", WIDTHS[i % WIDTHS.length])} />
            <Line className={clsx("h-3", WIDTHS[(i + 3) % WIDTHS.length])} />
          </div>
          <Bone className="hidden h-6 w-20 rounded-full sm:block" />
        </div>
      ))}
    </div>
  );
}

/** A list of rows (tickets, messages, alerts, coupons): a thumbnail, two lines and a status. */
export function ListSkeleton({ rows, title, className, delay }: SkeletonProps & { rows?: number; title?: boolean }) {
  return (
    <DelayedFallback label="Loading" delay={delay} className={clsx("flex flex-col gap-3", className)}>
      {title && <TitleShape sub={false} />}
      <ListShape rows={rows} />
    </DelayedFallback>
  );
}

/** Any page: a title bar and a few blocks. What PageLoader shows by default. */
export function PageSkeleton({ className, delay }: SkeletonProps) {
  return (
    <DelayedFallback label="Loading" delay={delay} className={clsx("flex flex-col gap-4", className)}>
      <TitleShape />
      <div className="flex flex-col gap-4 rounded-xl bg-white p-4 sm:p-5">
        {range(4).map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Bone className="h-10 w-10 rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Line className={clsx("h-4", ["w-2/5", "w-1/2", "w-1/3", "w-3/5"][i])} />
              <Line className={clsx("h-3", ["w-3/5", "w-2/5", "w-1/2", "w-1/3"][i])} />
            </div>
            <Line className="hidden h-4 w-16 sm:block" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {range(2).map((i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl bg-white p-4 sm:p-5">
            <Line className="h-5 w-32" />
            <SkeletonText lines={3} last={i ? "w-1/2" : "w-3/4"} />
          </div>
        ))}
      </div>
    </DelayedFallback>
  );
}

/** Wishlist: the heading and the saved products. */
export function WishlistSkeleton({ className, delay }: SkeletonProps) {
  return (
    <DelayedFallback label="Loading your wishlist" delay={delay} className={clsx("flex flex-col gap-3", className)}>
      <TitleShape sub={false} />
      <GridShape dense />
    </DelayedFallback>
  );
}

/** Sign-in and sign-up in the theme's arrangement: a centred card, or a brand panel beside the form on large screens. */
export function AuthSkeleton({ className, delay }: SkeletonProps) {
  const layout = useLayout();
  const split = layout.auth.layout === "split";
  const card = (
    <div className={clsx(CARD, "mx-auto flex w-full max-w-md flex-col gap-4 p-6 sm:p-8")}>
      <Line className="h-7 w-40" />
      <Line className="h-4 w-64" />
      <div className="mt-2 flex flex-col gap-2">
        <Line className="h-3.5 w-28" />
        <Bone className="h-11 w-full rounded-lg" />
      </div>
      <Bone className="h-11 w-full rounded-lg" />
      <div className="mt-2 border-t border-line pt-4">
        <Line className="mx-auto h-4 w-48" />
      </div>
    </div>
  );
  return (
    <DelayedFallback label="Loading" delay={delay} className={clsx("py-4 sm:py-8", className)}>
      {split ? (
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <div className="skeleton hidden min-h-[460px] flex-col justify-end gap-3 rounded-2xl p-10 lg:flex">
            <span className={clsx("block h-9 w-2/3 bg-white/50", BAR)} />
            <span className={clsx("block h-4 w-1/2 bg-white/40", BAR)} />
          </div>
          {card}
        </div>
      ) : card}
    </DelayedFallback>
  );
}

/* ------------------------------------------------------------------ admin, seller hub, delivery app */

function AdminHeadShape() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-2">
        <Line className="h-8 w-48 sm:h-9" />
        <Line className="h-4 w-72" />
      </div>
      <Bone className="h-10 w-32 rounded-lg" />
    </div>
  );
}

function StatsShape() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {range(4).map((i) => (
        <div key={i} className="flex flex-col gap-2.5 rounded-xl bg-white p-4">
          <Line className={clsx("h-3.5", ["w-24", "w-32", "w-20", "w-28"][i])} />
          <Line className="h-8 w-20" />
        </div>
      ))}
    </div>
  );
}

/**
 * An admin or seller page inside its panel: the page title, then
 *   table (default): tabs, filters and a table;  dashboard: figures, a chart and two cards;
 *   form: settings sections;  detail: a record's page.
 */
export function AdminPageSkeleton({ kind = "table", className, delay }: SkeletonProps & { kind?: "table" | "dashboard" | "form" | "detail" }) {
  return (
    <DelayedFallback label="Loading" delay={delay} className={clsx("flex flex-col gap-4", className)}>
      <AdminHeadShape />
      {kind === "dashboard" ? (
        <>
          <StatsShape />
          <div className="flex flex-col gap-3 rounded-xl bg-white p-4">
            <Line className="h-5 w-36" />
            <div className="flex h-48 items-end gap-1.5 sm:gap-2" aria-hidden>
              {[38, 62, 45, 80, 55, 70, 42, 90, 64, 52, 76, 48].map((h, i) => (
                <span key={i} className={clsx("skeleton block flex-1 rounded-t-md", i > 7 && "hidden sm:block")} style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {range(2).map((i) => (
              <div key={i} className="flex flex-col gap-3 rounded-xl bg-white p-4">
                <Line className="h-5 w-32" />
                {range(4).map((j) => <Line key={j} className={clsx("h-4", WIDTHS[(i + j) % WIDTHS.length])} />)}
              </div>
            ))}
          </div>
        </>
      ) : kind === "form" ? (
        <FormShape />
      ) : kind === "detail" ? (
        <DetailShape />
      ) : (
        <>
          <div className="flex gap-4 overflow-hidden border-b border-line pb-2.5">
            {["w-12", "w-20", "w-28", "w-20"].map((w, i) => <Line key={i} className={clsx("h-4 shrink-0", w)} />)}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Bone className="h-10 w-full rounded-lg sm:col-span-2" />
            <Bone className="hidden h-10 w-full rounded-lg sm:block" />
            <Bone className="hidden h-10 w-full rounded-lg sm:block" />
          </div>
          <StatsShape />
          <TableShape rows={6} />
        </>
      )}
    </DelayedFallback>
  );
}

/** The delivery partner app: the status card, two figures and a list, in its rounded app style. */
export function CardsSkeleton({ className, delay }: SkeletonProps) {
  return (
    <DelayedFallback label="Loading" delay={delay} className={clsx("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-3 rounded-3xl bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <Line className="h-6 w-40" />
          <Bone className="h-8 w-16 rounded-full" />
        </div>
        <Line className="h-4 w-3/4" />
        <Bone className="mt-1 h-12 w-full rounded-2xl" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {range(2).map((i) => (
          <div key={i} className="flex flex-col gap-2.5 rounded-2xl bg-white p-4 shadow-sm">
            <Line className="h-3.5 w-20" />
            <Line className="h-7 w-24" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm">
        <Line className="h-5 w-32" />
        {range(3).map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Bone className="h-10 w-10 rounded-xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Line className={clsx("h-4", WIDTHS[i % WIDTHS.length])} />
              <Line className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </DelayedFallback>
  );
}

/* ------------------------------------------------------------------ shop routes */

/**
 * The skeleton for a shop address. Routes with their own loading.tsx show the same one, so whichever loading
 * boundary shows first, the shape never changes on the way in.
 */
export function ShopRouteSkeleton() {
  const path = usePathname() ?? "/";
  if (path === "/") return <HomeSkeleton />;
  if (path.startsWith("/p/")) return <ProductPageSkeleton />;
  if (path.startsWith("/c/")) return <ListingSkeleton crumb />;
  if (path.startsWith("/search")) return <ListingSkeleton />;
  if (path.startsWith("/store/")) return <StoreSkeleton />;
  if (path.startsWith("/categories")) return <CategoriesSkeleton />;
  if (path.startsWith("/deals")) return <DealsSkeleton />;
  if (path.startsWith("/bestsellers") || path.startsWith("/new-releases")) return <TopListSkeleton />;
  if (path.startsWith("/cart")) return <CartSkeleton />;
  if (path.startsWith("/checkout")) return <CheckoutSkeleton />;
  if (path === "/orders") return <OrdersSkeleton />;
  if (path.startsWith("/orders/") || /^\/support\/[^/]+$/.test(path) && path !== "/support/new") return <DetailSkeleton />;
  if (path.startsWith("/account")) return <FormSkeleton narrow />;
  if (path.startsWith("/wishlist")) return <WishlistSkeleton />;
  if (path.startsWith("/login") || path.startsWith("/signup")) return <AuthSkeleton />;
  if (path.startsWith("/support/new")) return <FormSkeleton narrow />;
  if (["/support", "/notifications", "/alerts", "/coupons"].some((p) => path.startsWith(p))) return <ListSkeleton title />;
  if (path.startsWith("/compare")) return <TableSkeleton />;
  return <PageSkeleton />;
}
