/*
 * Loading placeholders in the shape of what is coming, in the active storefront theme: corners, cards and the product
 * grid follow the theme (ThemeService.layout()), colours come from the theme's line and page colours (the `skeleton`
 * class in styles/_site.scss). Port of components/skeletons.tsx with the same markup and classes.
 *
 * Every exported skeleton is wrapped in <pc-delayed-fallback>: invisible for its first 180 ms (quick loads never flash),
 * then it fades in; it carries aria-busy and a "Loading" status for screen readers. Skeletons hand over to each other on
 * one clock (the route's skeleton, then the page's loader), so there is never a blank gap or a second fade between
 * them, and the content that finally replaces a visible skeleton fades in.
 *
 * Usage: <pc-page-skeleton />, <pc-list-skeleton [title]="true" />, <pc-admin-page-skeleton kind="dashboard" />,
 * <pc-shop-route-skeleton />. Extra classes for the outer element: skeletonClass="..."; delay="0" shows at once.
 * Outside the shop (admin, seller hub, delivery app) the default theme's layout is used, so these still render.
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, DestroyRef, Directive, ElementRef, afterNextRender, computed, inject, input } from "@angular/core";
import { RouteState } from "../../core/route-state";
import { ThemeService } from "../../themes/context";
import type { ThemeLayout } from "../../themes/types";
import { cx } from "./cx";

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

/** When the browser started this loader's wait, if it already has. */
function startedAt(el: HTMLElement): number | null {
  const anim = el.getAnimations?.().find((a) => (a as CSSAnimation).animationName === "pc-delayed-in");
  const t = anim?.startTime;
  return typeof t === "number" ? t : null;
}

/** An inline loader placed below the page's own heading leaves out its placeholder title (see the site styles). */
function markTitled(el: HTMLElement) {
  const heading = el.closest("main")?.querySelector("h1");
  if (heading && !el.contains(heading) && heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
    el.setAttribute("data-titled", "");
  }
}

/** The element that lays this loader out: skips component hosts drawn with display: contents. */
function layoutParent(el: HTMLElement): { parent: HTMLElement | null; gone: HTMLElement } {
  let gone: HTMLElement = el;
  let parent = el.parentElement;
  while (parent && parent !== document.body && getComputedStyle(parent).display === "contents") {
    gone = parent;
    parent = parent.parentElement;
  }
  return { parent, gone };
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
 * Shows its content after a short delay (CSS), fading it in. Taking over from a loader that is already showing, it
 * carries on from there (no blank gap, no second fade). The host is the reference's <div class="pc-delayed pc-bare">.
 */
@Component({
  selector: "pc-delayed-fallback",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cls()", "aria-busy": "true" },
  template: `<span class="sr-only" role="status">{{ label() }}</span><ng-content />`,
})
export class DelayedFallback {
  /** ms before it shows; 0 shows it at once */
  readonly delay = input(LOADER_DELAY);
  /** what screen readers hear */
  readonly label = input("Loading");
  readonly extra = input<string | undefined>(undefined, { alias: "skeletonClass" });
  protected readonly cls = computed(() => cx("pc-delayed pc-bare block", this.extra()));

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    let mounted = false;
    let parent: HTMLElement | null = null;
    let gone: HTMLElement = el;
    afterNextRender(() => {
      const delay = this.delay();
      if (delay !== LOADER_DELAY) el.style.animationDelay = `${delay}ms`;
      const now = performance.now();
      const own = startedAt(el);
      const shown = beginRun(own ?? now);
      // Following a loader that is already on its way: line this one's fade up with it (a negative delay starts part way).
      if (own === null && shown > 1) el.style.animationDelay = `${Math.round(delay - shown)}ms`;
      markTitled(el);
      ({ parent, gone } = layoutParent(el));
      mounted = true;
    });
    inject(DestroyRef).onDestroy(() => {
      if (!mounted) return;
      const wasShowing = performance.now() - runStart >= this.delay();
      endRun();
      if (wasShowing && parent) revealAfter(parent, gone);
    });
  }
}

/* ------------------------------------------------------------------ primitives */

/** Text bars round off with the theme's corners (soft in Fresh, nearly square in Luxe). */
const BAR = "rounded-[calc(var(--r-lg)*0.75)]";

type Rounded = "none" | "md" | "lg" | "xl" | "2xl" | "full";
const ROUNDED: Record<Rounded, string> = { none: "", md: "rounded-md", lg: "rounded-lg", xl: "rounded-xl", "2xl": "rounded-2xl", full: "rounded-full" };

/** One bar of text: <span pcLine class="h-4 w-24"></span>. */
@Directive({ selector: "span[pcLine]", host: { class: `skeleton block max-w-full ${BAR}`, "aria-hidden": "true" } })
export class SkLine {}

/** A block that sets its own corners: <span pcBone class="h-10 w-10 rounded-lg"></span>. */
@Directive({ selector: "span[pcBone]", host: { class: "skeleton block shrink-0", "aria-hidden": "true" } })
export class SkBone {}

/** A shimmering block: an image, a button, a card. Size it with class. */
@Component({
  selector: "pc-skeleton-block",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cls()", "aria-hidden": "true" },
  template: ``,
})
export class SkeletonBlock {
  readonly rounded = input<Rounded>("lg");
  readonly extra = input<string>("", { alias: "skeletonClass" });
  protected readonly cls = computed(() => cx("skeleton block shrink-0", ROUNDED[this.rounded()], this.extra()));
}

/** Lines of text; the last one is shorter. */
@Component({
  selector: "pc-skeleton-text",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cls()", "aria-hidden": "true" },
  template: `@for (i of rows(); track i) {<span [class]="lineCls(i)"></span>}`,
})
export class SkeletonText {
  readonly lines = input(3);
  readonly lineClassName = input("h-3.5");
  readonly last = input("w-2/3");
  readonly extra = input<string>("", { alias: "skeletonClass" });
  protected readonly cls = computed(() => cx("flex flex-col gap-2", this.extra()));
  protected readonly rows = computed(() => range(this.lines()));
  protected lineCls(i: number): string {
    const n = this.lines();
    return cx("skeleton block max-w-full", BAR, this.lineClassName(), i === n - 1 && n > 1 ? this.last() : "w-full");
  }
}

/** A round placeholder (an avatar, an icon). Size it with class (default h-10 w-10). */
@Component({
  selector: "pc-skeleton-circle",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "skeleton block shrink-0 rounded-full", "[class.h-10]": "!sized", "[class.w-10]": "!sized", "aria-hidden": "true" },
  template: ``,
})
export class SkeletonCircle {
  protected readonly sized = /(^|\s)(\S+:)*[hw]-/.test(inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.getAttribute("class") ?? "");
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/6", "w-2/5", "w-3/5"];

/** A white card as the theme draws cards on shop pages. */
const CARD = "rounded-2xl bg-white shadow-card";

const SHARED = [SkLine, SkBone] as const;

/** A page title with an optional line under it (left out when the page already shows its heading). */
@Component({
  selector: "pc-sk-title",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="pc-sk-title flex flex-col gap-2 px-1">
      <span pcLine class="h-7 w-48 sm:h-8 sm:w-60"></span>
      @if (sub()) {<span pcLine class="h-4 w-72"></span>}
    </div>
  `,
})
export class TitleShape {
  readonly sub = input(true);
}

/* ------------------------------------------------------------------ product tiles, grids and rails */

type Grid = ThemeLayout["productGrid"];
type Cols = ThemeLayout["gridColumns"];

/* The same grid and rail as gridClass and ProductRail (shared/product/product.ts). Keep the two in step. */
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
@Component({
  selector: "pc-sk-tile",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (grid() === "airy") {
      <div class="flex h-full flex-col gap-2.5">
        <span pcBone class="aspect-[4/5] w-full rounded-lg"></span>
        <span pcLine class="mt-1 h-2.5 w-1/4"></span>
        <span pcLine class="h-3.5 w-4/5"></span>
        <span pcLine class="h-3.5 w-1/3"></span>
      </div>
    } @else if (grid() === "cards") {
      <div class="flex h-full flex-col rounded-xl bg-white p-2 shadow-card">
        <span pcBone class="aspect-square w-full rounded-lg"></span>
        <div class="flex flex-1 flex-col gap-2 px-0.5 pt-2.5">
          <span pcLine class="h-3 w-16"></span>
          <span pcLine class="h-3 w-full"></span>
          <span pcLine class="h-3 w-3/4"></span>
        </div>
        <div class="mt-3 flex items-center justify-between gap-2 px-0.5">
          <span pcLine class="h-4 w-14"></span>
          <span pcBone class="h-9 w-[72px] rounded-lg"></span>
        </div>
      </div>
    } @else {
      <div class="flex h-full flex-col gap-2 bg-white p-3 sm:p-4">
        <span pcBone class="aspect-square w-full rounded-lg"></span>
        <span pcLine class="mt-1 h-3.5 w-11/12"></span>
        <span pcLine class="h-3.5 w-2/3"></span>
        <span pcLine class="h-4 w-12"></span>
        <span pcLine class="mt-1.5 h-5 w-1/2"></span>
        <span pcLine class="h-3 w-3/4"></span>
      </div>
    }
  `,
})
export class TileShape {
  readonly grid = input.required<Grid>();
}

/** A product grid in the theme's style. `dense` is the four-column grid beside a filter column. */
@Component({
  selector: "pc-sk-grid",
  imports: [TileShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="cls()">
      @for (i of items(); track i) {
        <div [class]="count() === undefined && i >= fill().from ? fill().hide : ''"><pc-sk-tile [grid]="layout().productGrid" /></div>
      }
    </div>
  `,
})
export class GridShape {
  readonly dense = input(false);
  readonly count = input<number | undefined>(undefined);
  protected readonly layout = inject(ThemeService).layout;
  private readonly cols = computed<Cols>(() => (this.dense() ? 4 : this.layout().gridColumns));
  protected readonly fill = computed(() => FILL[this.cols()]);
  protected readonly items = computed(() => range(this.count() ?? this.fill().count));
  protected readonly cls = computed(() => cx("grid", GRID[this.layout().productGrid], this.dense() ? DENSE : COLS[this.cols()]));
}

/** A titled row of tiles that runs off the right edge, like ProductRail. */
@Component({
  selector: "pc-sk-rail",
  imports: [SHARED, TileShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="shop-panel overflow-hidden">
      <div [class]="plain() ? 'flex items-center justify-between gap-3 pb-1 px-0 pb-3 pt-1' : 'flex items-center justify-between gap-3 pb-1 px-4 pt-4'">
        <span pcLine [class]="plain() ? 'h-7 w-52' : 'h-6 w-44'"></span>
        <span pcLine class="h-4 w-14"></span>
      </div>
      <div [class]="trackCls()">
        @for (i of items(); track i) {
          <div [class]="itemCls()"><pc-sk-tile [grid]="layout().productGrid" /></div>
        }
      </div>
    </section>
  `,
})
export class RailShape {
  readonly count = input(7);
  protected readonly layout = inject(ThemeService).layout;
  protected readonly plain = computed(() => this.layout().home.sections === "plain");
  protected readonly items = computed(() => range(this.count()));
  protected readonly trackCls = computed(() => {
    const grid = this.layout().productGrid;
    return cx("flex overflow-hidden", RAIL_TRACK[grid], this.plain() && grid === "cards" && "px-0 sm:px-0");
  });
  protected readonly itemCls = computed(() => cx("shrink-0", RAIL_ITEM[this.layout().productGrid][this.layout().gridColumns]));
}

@Component({
  selector: "pc-product-grid-skeleton",
  imports: [DelayedFallback, GridShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-delayed-fallback label="Loading products" [skeletonClass]="skeletonClass()" [delay]="delay()"><pc-sk-grid [dense]="dense()" [count]="count()" /></pc-delayed-fallback>`,
})
export class ProductGridSkeleton {
  readonly dense = input(false);
  readonly count = input<number | undefined>(undefined);
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
}

@Component({
  selector: "pc-rail-skeleton",
  imports: [DelayedFallback, RailShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-delayed-fallback label="Loading products" [skeletonClass]="skeletonClass()" [delay]="delay()"><pc-sk-rail [count]="count()" /></pc-delayed-fallback>`,
})
export class RailSkeleton {
  readonly count = input(7);
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
}

/* ------------------------------------------------------------------ home */

/** The hero banner with the outline of its heading, text and button. */
@Component({
  selector: "pc-sk-hero",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="skeleton relative aspect-[16/8] w-full overflow-hidden rounded-xl sm:aspect-[16/5]">
      <div class="absolute inset-y-0 left-0 flex w-3/4 flex-col justify-center gap-2.5 p-6 sm:w-1/2 sm:gap-3.5 sm:p-12">
        <span [class]="'block h-6 w-11/12 bg-white/50 sm:h-10 ' + BAR"></span>
        <span [class]="'block h-4 w-2/3 bg-white/40 sm:h-5 ' + BAR"></span>
        <span class="mt-1 block h-8 w-28 rounded-lg bg-white/50 sm:h-10 sm:w-36"></span>
      </div>
    </div>
  `,
})
export class HeroShape {
  protected readonly BAR = BAR;
}

/** The home category block in the theme's style: round icons, raised cards, dense squares or text chips. */
@Component({
  selector: "pc-sk-categories",
  imports: [SHARED, SkeletonCircle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @switch (style()) {
      @case ("chips") {
        <div class="shop-panel shop-panel-pad flex max-h-[5.75rem] flex-wrap justify-center gap-2 overflow-hidden px-4 py-3">
          @for (w of chipWidths; track $index) {<span pcBone [class]="'h-10 rounded-full ' + w"></span>}
        </div>
      }
      @case ("squares") {
        <div class="shop-panel shop-panel-pad grid grid-cols-4 gap-x-2.5 gap-y-4 p-3 sm:grid-cols-8 sm:p-4 lg:grid-cols-10">
          @for (i of ten; track i) {
            <div [class]="i >= 8 ? 'flex-col items-center gap-2 hidden lg:flex' : 'flex-col items-center gap-2 flex'">
              <span pcBone class="aspect-square w-full rounded-xl"></span>
              <span pcLine class="h-2.5 w-3/4"></span>
            </div>
          }
        </div>
      }
      @case ("cards") {
        <div class="shop-panel shop-panel-pad grid grid-cols-4 gap-2 p-3 sm:grid-cols-6 sm:gap-3 sm:p-4 lg:grid-cols-8">
          @for (i of eight; track i) {
            <div [class]="i >= 6 ? 'flex-col items-center gap-2 rounded-xl bg-white p-1.5 shadow-card sm:p-2 flex sm:hidden lg:flex' : 'flex-col items-center gap-2 rounded-xl bg-white p-1.5 shadow-card sm:p-2 flex'">
              <span pcBone class="aspect-square w-full rounded-lg"></span>
              <span pcLine class="mb-1 h-3 w-3/4"></span>
            </div>
          }
        </div>
      }
      @default {
        <div class="shop-panel flex gap-1 overflow-hidden px-2 py-3 sm:grid sm:grid-cols-8">
          @for (i of eight; track i) {
            <div class="flex w-[84px] shrink-0 flex-col items-center gap-2 px-1 py-2 sm:w-auto">
              <pc-skeleton-circle class="h-14 w-14" />
              <span pcLine class="h-3 w-14"></span>
            </div>
          }
        </div>
      }
    }
  `,
})
export class CategoryShape {
  readonly style = input.required<ThemeLayout["home"]["categories"]>();
  protected readonly chipWidths = ["w-20", "w-28", "w-24", "w-16", "w-24", "w-20", "w-28", "w-16"];
  protected readonly ten = range(10);
  protected readonly eight = range(8);
}

/** Home: the hero, the category block and two product rows. */
@Component({
  selector: "pc-home-skeleton",
  imports: [DelayedFallback, HeroShape, CategoryShape, RailShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading the store" [delay]="delay()" [skeletonClass]="cls()">
      <pc-sk-hero />
      <pc-sk-categories [style]="layout().home.categories" />
      <pc-sk-rail />
      <pc-sk-rail />
    </pc-delayed-fallback>
  `,
})
export class HomeSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly layout = inject(ThemeService).layout;
  protected readonly cls = computed(() => cx("flex flex-col", this.layout().home.sections === "plain" ? "gap-8 sm:gap-10" : "gap-4", this.skeletonClass()));
}

/* ------------------------------------------------------------------ category, search and store pages */

/** The filter column (Classic, Bazaar): a heading and groups of options. */
@Component({
  selector: "pc-sk-filters",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <aside class="shop-panel shop-panel-pad hidden self-start p-4 lg:block">
      <span pcLine class="mb-5 h-5 w-20"></span>
      <div class="flex flex-col gap-6">
        @for (rows of groups; track $index; let g = $index) {
          <div class="flex flex-col gap-2.5">
            <span pcLine class="h-4 w-24"></span>
            @for (r of rangeOf(rows); track r) {
              <div class="flex items-center gap-2">
                <span pcBone class="h-4 w-4 rounded"></span>
                <span pcLine [class]="'h-3.5 ' + widths[(g + r) % widths.length]"></span>
              </div>
            }
          </div>
        }
      </div>
    </aside>
  `,
})
export class FilterColumnShape {
  protected readonly groups = [3, 1, 4, 2, 2];
  protected readonly widths = WIDTHS;
  protected readonly rangeOf = range;
}

/** Results with the filters in a column on the left (or a Filters button on phones) and sort on the right. */
@Component({
  selector: "pc-sk-sidebar-listing",
  imports: [SHARED, FilterColumnShape, GridShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="'grid gap-4 ' + column()">
      <pc-sk-filters />
      <div class="flex min-w-0 flex-col gap-3">
        <div class="shop-panel shop-panel-pad flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div class="flex min-w-0 flex-col gap-2">
            @if (heading()) {<span pcLine class="h-7 w-44"></span>}
            <span pcLine class="h-3.5 w-36"></span>
          </div>
          <div class="flex items-center gap-2">
            <span pcBone class="h-8 w-24 rounded-lg lg:hidden"></span>
            <span pcBone class="h-9 w-36 rounded-lg sm:w-44"></span>
          </div>
        </div>
        <pc-sk-grid [dense]="true" />
      </div>
    </div>
  `,
})
export class SidebarListing {
  readonly heading = input(true);
  readonly column = input("lg:grid-cols-[250px_1fr]");
}

/** Results with a bar of filter buttons on top (Fresh, Luxe) and sort on the right. */
@Component({
  selector: "pc-sk-topbar-listing",
  imports: [SHARED, GridShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4">
      @if (heading()) {
        <div class="flex flex-col gap-2 px-1">
          <span pcLine class="h-8 w-56"></span>
          <span pcLine class="h-4 w-40"></span>
        </div>
      }
      <div class="flex items-center gap-2 overflow-hidden border-y border-line py-3">
        @for (w of pills; track $index; let i = $index) {<span pcBone [class]="pillCls(w, i)"></span>}
        <span pcBone class="ml-auto h-9 w-32 rounded-lg sm:w-40"></span>
      </div>
      <pc-sk-grid />
    </div>
  `,
})
export class TopbarListing {
  readonly heading = input(true);
  protected readonly pills = ["w-24", "w-20", "w-28", "w-24", "w-20"];
  protected pillCls(w: string, i: number): string {
    return cx("h-9 rounded-full", w, i > 1 && "hidden sm:block", i > 3 && "sm:hidden lg:block");
  }
}

@Component({
  selector: "pc-sk-listing",
  imports: [SHARED, SidebarListing, TopbarListing],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-3">
      @if (crumb()) {<span pcLine class="pc-sk-title ml-1 h-4 w-56"></span>}
      @if (layout().listing.filters === "topbar") {<pc-sk-topbar-listing [heading]="heading()" />} @else {<pc-sk-sidebar-listing [heading]="heading()" />}
    </div>
  `,
})
export class ListingShape {
  readonly crumb = input(false);
  readonly heading = input(true);
  protected readonly layout = inject(ThemeService).layout;
}

/** Category and search results: filters as a column or a bar on top, per the theme. */
@Component({
  selector: "pc-listing-skeleton",
  imports: [DelayedFallback, ListingShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-delayed-fallback label="Loading products" [skeletonClass]="skeletonClass()" [delay]="delay()"><pc-sk-listing [crumb]="crumb()" /></pc-delayed-fallback>`,
})
export class ListingSkeleton {
  readonly crumb = input(false);
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
}

/** A seller's store: the banner with its name, then the store's products. */
@Component({
  selector: "pc-store-skeleton",
  imports: [DelayedFallback, ListingShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading the store" [delay]="delay()" [skeletonClass]="cls()">
      <div class="skeleton flex min-h-[124px] flex-col justify-center gap-3 rounded-xl p-6">
        <span [class]="'block h-8 w-56 max-w-full bg-white/50 ' + BAR"></span>
        <span [class]="'block h-4 w-80 max-w-full bg-white/40 ' + BAR"></span>
      </div>
      <pc-sk-listing [heading]="false" />
    </pc-delayed-fallback>
  `,
})
export class StoreSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly BAR = BAR;
  protected readonly cls = computed(() => cx("flex flex-col gap-4", this.skeletonClass()));
}

/** All categories: a card per department with its sub-categories. */
@Component({
  selector: "pc-categories-skeleton",
  imports: [DelayedFallback, TitleShape, SHARED, SkeletonCircle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading categories" [delay]="delay()" [skeletonClass]="cls()">
      <pc-sk-title [sub]="false" />
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        @for (i of six; track i) {
          <div class="shop-panel shop-panel-pad flex flex-col gap-3 p-4">
            <div class="flex items-center gap-3">
              <pc-skeleton-circle class="h-11 w-11" />
              <span pcLine class="h-5 w-32"></span>
              <span pcLine class="ml-auto h-4 w-8"></span>
            </div>
            <div class="flex flex-wrap gap-2">
              @for (j of rangeOf(3 + (i % 3)); track j) {<span pcBone [class]="'h-7 rounded-full ' + chip[j % 3]"></span>}
            </div>
          </div>
        }
      </div>
    </pc-delayed-fallback>
  `,
})
export class CategoriesSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly six = range(6);
  protected readonly rangeOf = range;
  protected readonly chip = ["w-20", "w-16", "w-24"];
  protected readonly cls = computed(() => cx("flex flex-col gap-3", this.skeletonClass()));
}

/** Today's deals: the heading, the kinds of deals as pills, then the deals with their filters. */
@Component({
  selector: "pc-deals-skeleton",
  imports: [DelayedFallback, SHARED, TopbarListing, SidebarListing],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading deals" [delay]="delay()" [skeletonClass]="cls()">
      <div class="flex flex-col gap-2 px-1">
        <span pcLine class="h-8 w-52 sm:h-9"></span>
        <span pcLine class="h-4 w-full max-w-xl"></span>
      </div>
      <div class="flex gap-2 overflow-hidden">
        @for (w of pills; track $index) {<span pcBone [class]="'h-10 rounded-full ' + w"></span>}
      </div>
      @if (layout().listing.filters === "topbar") {
        <pc-sk-topbar-listing [heading]="false" />
      } @else {
        <pc-sk-sidebar-listing [heading]="false" column="lg:grid-cols-[230px_1fr]" />
      }
    </pc-delayed-fallback>
  `,
})
export class DealsSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly layout = inject(ThemeService).layout;
  protected readonly pills = ["w-24", "w-36", "w-32", "w-36", "w-28", "w-32"];
  protected readonly cls = computed(() => cx("flex flex-col gap-4", this.skeletonClass()));
}

/** Bestsellers and new releases: departments on the left, a heading card, then a ranked row per department. */
@Component({
  selector: "pc-top-list-skeleton",
  imports: [DelayedFallback, SHARED, RailShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading the list" [delay]="delay()" [skeletonClass]="cls()">
      <aside class="shop-panel shop-panel-pad hidden self-start p-3 lg:block">
        <span pcLine class="mx-2 mb-3 mt-1 h-4 w-32"></span>
        <div class="flex flex-col gap-3 px-2 pb-2">
          @for (i of nine; track i) {<span pcLine [class]="'h-3.5 ' + widths[i % widths.length]"></span>}
        </div>
      </aside>
      <div class="flex min-w-0 flex-col gap-4">
        <div class="shop-panel shop-panel-pad flex flex-col gap-2.5 p-4 sm:p-5">
          <span pcLine class="h-8 w-52 sm:h-9"></span>
          <span pcLine class="h-4 w-full max-w-lg"></span>
          <div class="mt-1 flex gap-2 overflow-hidden lg:hidden">
            @for (i of five; track i) {<span pcBone [class]="'h-7 rounded-full ' + chip[i % 3]"></span>}
          </div>
        </div>
        <pc-sk-rail />
        <pc-sk-rail />
      </div>
    </pc-delayed-fallback>
  `,
})
export class TopListSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly nine = range(9);
  protected readonly five = range(5);
  protected readonly widths = WIDTHS;
  protected readonly chip = ["w-20", "w-24", "w-16"];
  protected readonly cls = computed(() => cx("grid gap-4 lg:grid-cols-[230px_1fr]", this.skeletonClass()));
}

/* ------------------------------------------------------------------ product page */

@Component({
  selector: "pc-sk-dots",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<div class="flex justify-center gap-1.5">@for (i of four; track i) {<span pcBone [class]="i === 0 ? 'h-2 rounded-full w-5' : 'h-2 rounded-full w-2'"></span>}</div>`,
})
export class Dots {
  protected readonly four = range(4);
}

/** Title, rating, price, offers, options and "About this item". */
@Component({
  selector: "pc-sk-details",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex min-w-0 flex-col gap-3">
      <span pcLine [class]="editorial() ? 'h-3 w-24' : 'h-4 w-36'"></span>
      <div class="flex flex-col gap-2">
        <span pcLine [class]="editorial() ? 'h-8 w-full' : 'h-6 w-full sm:h-7'"></span>
        <span pcLine [class]="editorial() ? 'h-8 w-2/3' : 'h-6 w-3/4 sm:h-7'"></span>
      </div>
      <span pcLine class="h-4 w-52"></span>
      <div class="mt-1 flex flex-col gap-2 border-t border-line pt-4">
        <span pcLine class="h-9 w-44"></span>
        <span pcLine class="h-3.5 w-32"></span>
      </div>
      @if (!editorial()) {<span pcBone class="h-[72px] w-full rounded-lg"></span>}
      <div class="flex flex-col gap-2 pt-1">
        <span pcLine class="h-4 w-24"></span>
        <div class="flex flex-wrap gap-2">
          @for (i of four; track i) {<span pcBone class="h-11 w-16 rounded-lg"></span>}
        </div>
      </div>
      <div class="flex flex-col gap-2 pt-2">
        <span pcLine class="h-5 w-40"></span>
        <span pcLine class="h-3.5 w-full"></span>
        <span pcLine class="h-3.5 w-11/12"></span>
        <span pcLine class="h-3.5 w-4/5"></span>
      </div>
    </div>
  `,
})
export class DetailsShape {
  readonly editorial = input(false);
  protected readonly four = range(4);
}

/** Price, delivery, stock, quantity, the two buy buttons and who sells it. */
@Component({
  selector: "pc-sk-buy",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="'flex flex-col gap-3 ' + boxClass()">
      <span pcLine class="h-8 w-32"></span>
      <div class="flex flex-col gap-1.5">
        <span pcLine class="h-4 w-full"></span>
        <span pcLine class="h-4 w-2/3"></span>
      </div>
      <span pcLine class="h-5 w-24"></span>
      <div class="flex items-center gap-3">
        <span pcLine class="h-4 w-16"></span>
        <span pcBone class="h-10 w-20 rounded-lg"></span>
      </div>
      <span pcBone [class]="pill() ? 'h-12 w-full rounded-full' : 'h-12 w-full rounded-lg'"></span>
      <span pcBone [class]="pill() ? 'h-12 w-full rounded-full' : 'h-12 w-full rounded-lg'"></span>
      <div class="flex flex-col gap-2 pt-1">
        @for (i of four; track i) {
          <div class="grid grid-cols-[88px_1fr] gap-3">
            <span pcLine class="h-3 w-16"></span>
            <span pcLine [class]="'h-3 ' + widths[i % widths.length]"></span>
          </div>
        }
      </div>
    </div>
  `,
})
export class BuyShape {
  readonly boxClass = input("");
  readonly pill = input(false);
  protected readonly four = range(4);
  protected readonly widths = WIDTHS;
}

@Component({
  selector: "pc-sk-description",
  imports: [SHARED, SkeletonText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="shop-panel shop-panel-pad flex flex-col gap-3 p-4 sm:p-6">
      <span pcLine class="h-6 w-48"></span>
      <pc-skeleton-text [lines]="4" last="w-1/2" />
    </div>
  `,
})
export class DescriptionShape {}

/** Classic: gallery with thumbnails, details, and the buy box in a third column on wide screens. */
@Component({
  selector: "pc-sk-pdp-three",
  imports: [SHARED, Dots, DetailsShape, BuyShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="grid gap-6 rounded-xl bg-white p-4 sm:p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]">
      <div class="flex gap-3 lg:row-span-2 xl:row-span-1">
        <div class="hidden w-16 shrink-0 flex-col gap-2 sm:flex">
          @for (i of five; track i) {<span pcBone class="aspect-square w-full rounded-lg"></span>}
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-3">
          <span pcBone class="aspect-square w-full rounded-xl"></span>
          <div class="sm:hidden"><pc-sk-dots /></div>
        </div>
      </div>
      <pc-sk-details />
      <pc-sk-buy [pill]="true" boxClass="rounded-xl border border-line p-4 lg:col-start-2 xl:col-start-3" />
    </div>
  `,
})
export class PdpThree {
  protected readonly five = range(5);
}

/** Two columns: the gallery on the left, details and a buy panel (sticky on desktop) on the right. */
@Component({
  selector: "pc-sk-pdp-two",
  imports: [SHARED, Dots, DetailsShape, BuyShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-6">
      <div class="shop-panel flex flex-col gap-3 p-3 sm:p-4 lg:sticky lg:top-28">
        <span pcBone class="aspect-square w-full rounded-xl"></span>
        <div class="hidden gap-2 sm:flex">
          @for (i of five; track i) {<span pcBone class="h-16 w-16 rounded-lg"></span>}
        </div>
        <div class="sm:hidden"><pc-sk-dots /></div>
      </div>
      <div class="flex min-w-0 flex-col gap-4">
        <div class="shop-panel shop-panel-pad p-4 sm:p-6"><pc-sk-details /></div>
        <pc-sk-buy boxClass="shop-panel p-4 shadow-card sm:p-5" />
      </div>
    </div>
  `,
})
export class PdpTwo {
  protected readonly five = range(5);
}

/** Boutique: large photos in two columns on desktop (one swipe photo on phones), the details column beside them. */
@Component({
  selector: "pc-sk-pdp-gallery",
  imports: [SHARED, Dots, DetailsShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-10 xl:grid-cols-[minmax(0,1fr)_440px]">
      <div class="min-w-0">
        <div class="flex flex-col gap-3 lg:hidden">
          <span pcBone class="aspect-[4/5] w-full rounded-lg"></span>
          <pc-sk-dots />
        </div>
        <div class="hidden grid-cols-2 gap-2 lg:grid">
          @for (i of four; track i) {<span pcBone class="aspect-[4/5] w-full rounded-lg"></span>}
        </div>
      </div>
      <div class="flex min-w-0 flex-col gap-5 lg:sticky lg:top-28">
        <pc-sk-details [editorial]="true" />
        <span pcBone class="h-12 w-full rounded-lg"></span>
        <span pcBone class="h-12 w-full rounded-lg"></span>
        <div class="flex flex-col">
          @for (w of rows; track $index) {
            <div class="flex items-center justify-between border-b border-line py-4">
              <span pcLine [class]="'h-4 ' + w"></span>
              <span pcBone class="h-4 w-4 rounded"></span>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class PdpGallery {
  protected readonly four = range(4);
  protected readonly rows = ["w-40", "w-32", "w-36"];
}

/** A product page in the theme's arrangement: three columns, two columns, or a large gallery. */
@Component({
  selector: "pc-product-page-skeleton",
  imports: [DelayedFallback, SHARED, PdpThree, PdpTwo, PdpGallery, DescriptionShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading product" [delay]="delay()" [skeletonClass]="cls()">
      <span pcLine class="ml-1 h-4 w-72"></span>
      @switch (layout().pdp.layout) {
        @case ("gallery") {<pc-sk-pdp-gallery />}
        @case ("two") {<pc-sk-pdp-two />}
        @default {<pc-sk-pdp-three />}
      }
      <pc-sk-description />
    </pc-delayed-fallback>
  `,
})
export class ProductPageSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly layout = inject(ThemeService).layout;
  protected readonly cls = computed(() => cx("flex flex-col gap-4", this.skeletonClass()));
}

/* ------------------------------------------------------------------ cart and checkout */

@Component({
  selector: "pc-sk-cart-group",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="CARD + ' overflow-hidden'">
      <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <span pcBone class="h-4 w-4 rounded"></span>
          <span pcLine class="h-4 w-44"></span>
        </div>
        <span pcBone class="h-6 w-24 rounded-full"></span>
      </div>
      <div class="divide-y divide-line">
        @for (i of rows(); track i) {
          <div class="flex gap-3 p-4 sm:gap-4 sm:p-5">
            <span pcBone class="h-24 w-24 rounded-xl sm:h-28 sm:w-28"></span>
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <span pcLine class="h-4 w-full"></span>
              <span pcLine class="h-4 w-2/3"></span>
              <span pcLine class="h-3 w-24"></span>
              <span pcLine class="mt-1 h-5 w-28"></span>
              <div class="mt-1 flex flex-wrap items-center gap-2">
                <span pcBone class="h-9 w-28 rounded-lg"></span>
                <span pcBone class="h-9 w-20 rounded-lg"></span>
                <span pcBone class="hidden h-9 w-20 rounded-lg sm:block"></span>
              </div>
            </div>
          </div>
        }
      </div>
    </div>
  `,
})
export class CartGroupShape {
  readonly lines = input.required<number>();
  protected readonly CARD = CARD;
  protected readonly rows = computed(() => range(this.lines()));
}

/** The bill: price lines, the total, and (unless a bottom bar holds it) the buy button. */
@Component({
  selector: "pc-sk-bill",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="cls()">
      <span pcLine class="h-3 w-24"></span>
      <div class="flex flex-col gap-3">
        @for (w of widths; track $index) {
          <div class="flex justify-between gap-6">
            <span pcLine [class]="'h-4 ' + w"></span>
            <span pcLine class="h-4 w-16"></span>
          </div>
        }
      </div>
      <div class="flex justify-between gap-6 border-t border-dashed border-line pt-3">
        <span pcLine class="h-5 w-20"></span>
        <span pcLine class="h-5 w-24"></span>
      </div>
      @if (button()) {
        <span pcBone class="h-12 w-full rounded-lg"></span>
        <span pcLine class="mx-auto h-3 w-3/4"></span>
      }
    </div>
  `,
})
export class BillShape {
  readonly button = input(true);
  readonly boxClass = input("");
  protected readonly widths = ["w-1/2", "w-2/5", "w-1/3"];
  protected readonly cls = computed(() => cx(CARD, "flex flex-col gap-4 p-4 sm:p-5", this.boxClass()));
}

@Component({
  selector: "pc-sk-cart-head",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 px-1">
      <span pcLine class="h-8 w-48"></span>
      <span pcLine class="h-5 w-40"></span>
    </div>
  `,
})
export class CartHeadShape {}

/** The cart in the theme's arrangement: the bill in a side column, or one column with a total bar at the bottom. */
@Component({
  selector: "pc-cart-skeleton",
  imports: [DelayedFallback, SHARED, CartHeadShape, CartGroupShape, BillShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (layout().cart.summary === "sticky") {
      <pc-delayed-fallback label="Loading your cart" [delay]="delay()" [skeletonClass]="skeletonClass()">
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-3 pb-24">
          <pc-sk-cart-head />
          <pc-sk-cart-group [lines]="2" />
          <pc-sk-cart-group [lines]="1" />
          <pc-sk-bill [button]="false" />
        </div>
        <div class="fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white px-3 py-2.5 shadow-[0_-4px_16px_rgb(0_0_0/0.06)] sm:bottom-0">
          <div class="mx-auto flex max-w-3xl items-center gap-3">
            <div class="flex flex-1 flex-col gap-1.5">
              <span pcLine class="h-6 w-24"></span>
              <span pcLine class="h-3 w-16"></span>
            </div>
            <span pcBone class="h-11 w-40 rounded-lg"></span>
          </div>
        </div>
      </pc-delayed-fallback>
    } @else {
      <pc-delayed-fallback label="Loading your cart" [delay]="delay()" [skeletonClass]="sideCls()">
        <div class="flex min-w-0 flex-col gap-3">
          <pc-sk-cart-head />
          <pc-sk-cart-group [lines]="2" />
          <pc-sk-cart-group [lines]="1" />
        </div>
        <pc-sk-bill boxClass="lg:mt-12" />
      </pc-delayed-fallback>
    }
  `,
})
export class CartSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly layout = inject(ThemeService).layout;
  protected readonly sideCls = computed(() => cx("grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start", this.skeletonClass()));
}

/** A checkout step: an icon, a heading with a line under it, then its rows. */
@Component({
  selector: "pc-sk-step",
  imports: [SHARED, SkeletonCircle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="CARD + ' flex flex-col gap-4 p-4 sm:p-5'">
      <div class="flex items-center gap-3">
        <span pcBone class="h-9 w-9 rounded-xl"></span>
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <span pcLine class="h-5 w-40"></span>
          <span pcLine class="h-3 w-56"></span>
        </div>
      </div>
      @for (i of items(); track i) {
        <div class="flex items-start gap-3 rounded-xl border border-line p-3">
          <pc-skeleton-circle class="mt-0.5 h-5 w-5" />
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <span pcLine class="h-4 w-40"></span>
            <span pcLine [class]="'h-3.5 ' + widths[i % widths.length]"></span>
          </div>
        </div>
      }
    </div>
  `,
})
export class StepShape {
  readonly rows = input.required<number>();
  protected readonly CARD = CARD;
  protected readonly widths = WIDTHS;
  protected readonly items = computed(() => range(this.rows()));
}

/** Checkout: address, items and payment on the left, the bill on the right. */
@Component({
  selector: "pc-checkout-skeleton",
  imports: [DelayedFallback, SHARED, StepShape, BillShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading checkout" [delay]="delay()" [skeletonClass]="skeletonClass()">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1">
        <span pcLine class="h-8 w-36"></span>
        <span pcLine class="h-4 w-44"></span>
      </div>
      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-x-6">
        <div class="flex min-w-0 flex-col gap-4">
          <pc-sk-step [rows]="2" />
          <pc-sk-step [rows]="1" />
          <pc-sk-step [rows]="2" />
        </div>
        <pc-sk-bill />
      </div>
    </pc-delayed-fallback>
  `,
})
export class CheckoutSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
}

/* ------------------------------------------------------------------ orders, details, forms, lists */

/** Your orders: one card per order with its photos, number, total and status. */
@Component({
  selector: "pc-orders-skeleton",
  imports: [DelayedFallback, SHARED, TitleShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading your orders" [delay]="delay()" [skeletonClass]="cls()">
      <pc-sk-title [sub]="false" />
      @for (i of four; track i) {
        <div class="flex flex-col gap-3 rounded-xl bg-white p-4 sm:flex-row sm:items-center">
          <div class="flex -space-x-3">
            @for (j of rangeOf(i % 2 ? 1 : 3); track j) {<span pcBone class="h-16 w-16 rounded-lg border-2 border-white"></span>}
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <span pcLine [class]="'h-4 ' + widths[i % widths.length]"></span>
            <span pcLine class="h-3.5 w-56"></span>
          </div>
          <div class="flex items-center gap-4 sm:flex-col sm:items-end sm:gap-2">
            <span pcLine class="h-6 w-20"></span>
            <span pcBone class="h-5 w-20 rounded-full"></span>
          </div>
        </div>
      }
    </pc-delayed-fallback>
  `,
})
export class OrdersSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly four = range(4);
  protected readonly rangeOf = range;
  protected readonly widths = WIDTHS;
  protected readonly cls = computed(() => cx("flex flex-col gap-3", this.skeletonClass()));
}

@Component({
  selector: "pc-sk-detail",
  imports: [SHARED, SkeletonCircle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4">
      <div [class]="CARD + ' flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5'">
        <div class="flex min-w-0 flex-col gap-2">
          <span pcLine class="h-7 w-56"></span>
          <span pcLine class="h-4 w-40"></span>
        </div>
        <div class="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
          <span pcLine class="h-7 w-28"></span>
          <span pcLine class="h-4 w-36"></span>
        </div>
      </div>
      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <div class="flex min-w-0 flex-col gap-4">
          @for (i of two; track i) {
            <div [class]="CARD + ' overflow-hidden'">
              <div class="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
                <span pcLine class="h-4 w-56"></span>
                <span pcBone class="h-6 w-20 rounded-full"></span>
              </div>
              <div class="flex flex-col gap-4 p-4 sm:p-5">
                <div class="flex items-center gap-2" aria-hidden="true">
                  @for (j of four; track j) {
                    <div [class]="j < 3 ? 'flex items-center gap-2 flex-1' : 'flex items-center gap-2'">
                      <pc-skeleton-circle class="h-5 w-5" />
                      @if (j < 3) {<span class="skeleton block h-1 flex-1 rounded-full"></span>}
                    </div>
                  }
                </div>
                <div class="flex gap-3">
                  <span pcBone class="h-16 w-16 rounded-lg"></span>
                  <div class="flex min-w-0 flex-1 flex-col gap-2">
                    <span pcLine class="h-4 w-4/5"></span>
                    <span pcLine class="h-3.5 w-1/3"></span>
                  </div>
                  <span pcLine class="h-4 w-16"></span>
                </div>
              </div>
            </div>
          }
        </div>
        <div [class]="CARD + ' flex flex-col gap-3 p-4 sm:p-5'">
          <span pcLine class="h-5 w-32"></span>
          @for (i of five; track i) {
            <div class="flex justify-between gap-6">
              <span pcLine [class]="'h-4 ' + widths[i % widths.length]"></span>
              <span pcLine class="h-4 w-16"></span>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class DetailShape {
  protected readonly CARD = CARD;
  protected readonly two = range(2);
  protected readonly four = range(4);
  protected readonly five = range(5);
  protected readonly widths = WIDTHS;
}

/** A record's page (an order, a ticket): a header card, sections on the left and a summary on the right. */
@Component({
  selector: "pc-detail-skeleton",
  imports: [DelayedFallback, DetailShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-delayed-fallback [label]="label()" [delay]="delay()" [skeletonClass]="skeletonClass()"><pc-sk-detail /></pc-delayed-fallback>`,
})
export class DetailSkeleton {
  readonly label = input("Loading");
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
}

@Component({
  selector: "pc-sk-form",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="flex flex-col gap-4 rounded-xl bg-white p-5">
      <span pcLine class="h-7 w-44"></span>
      <div class="grid gap-4 sm:grid-cols-2">
        @for (wide of fields; track $index) {
          <div [class]="wide ? 'flex flex-col gap-2 sm:col-span-2' : 'flex flex-col gap-2'">
            <span pcLine class="h-3.5 w-28"></span>
            <span pcBone class="h-10 w-full rounded-lg"></span>
          </div>
        }
      </div>
      <span pcLine class="h-4 w-56"></span>
      <div class="flex gap-2">
        <span pcBone class="h-10 w-32 rounded-lg"></span>
        <span pcBone class="h-10 w-24 rounded-lg"></span>
      </div>
    </section>
    <section class="flex flex-col gap-4 rounded-xl bg-white p-5">
      <div class="flex items-center justify-between gap-3">
        <span pcLine class="h-6 w-40"></span>
        <span pcBone class="h-8 w-28 rounded-lg"></span>
      </div>
      @for (i of two; track i) {
        <div class="flex flex-col gap-2 border-t border-line pt-4">
          <span pcLine class="h-4 w-48"></span>
          <span pcLine [class]="'h-3.5 ' + widths[i % widths.length]"></span>
        </div>
      }
    </section>
  `,
})
export class FormShape {
  protected readonly fields = [false, false, true];
  protected readonly two = range(2);
  protected readonly widths = WIDTHS;
}

/** Settings and profile forms: sections of labelled fields. `narrow` centres it like the account page. */
@Component({
  selector: "pc-form-skeleton",
  imports: [DelayedFallback, FormShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-delayed-fallback label="Loading" [delay]="delay()" [skeletonClass]="cls()"><pc-sk-form /></pc-delayed-fallback>`,
})
export class FormSkeleton {
  readonly narrow = input(false);
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly cls = computed(() => cx("flex flex-col gap-4", this.narrow() && "mx-auto w-full max-w-3xl", this.skeletonClass()));
}

// Phones show two columns, tablets three, desktops five (the table itself scrolls sideways when it arrives).
const TABLE_COLS = "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1.6fr)_repeat(2,minmax(0,1fr))] lg:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))]";

@Component({
  selector: "pc-sk-table",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="overflow-hidden rounded-xl bg-white">
      <div [class]="COLS + ' border-b border-line px-4 py-3'">
        @for (i of five; track i) {<span pcLine [class]="headCls(i)"></span>}
      </div>
      <div class="divide-y divide-line">
        @for (r of items(); track r) {
          <div [class]="COLS + ' items-center px-4 py-3.5'">
            <div class="flex min-w-0 flex-col gap-1.5">
              <span pcLine class="h-4 w-28"></span>
              <span pcLine class="h-3 w-20"></span>
            </div>
            <span pcLine [class]="'h-4 ' + widths[r % widths.length]"></span>
            <span pcLine [class]="'hidden h-4 sm:block ' + widths[(r + 2) % widths.length]"></span>
            <span pcLine class="hidden h-4 w-16 lg:block"></span>
            <span pcBone class="hidden h-5 w-20 rounded-full lg:block"></span>
          </div>
        }
      </div>
    </div>
  `,
})
export class TableShape {
  readonly rows = input(8);
  protected readonly COLS = TABLE_COLS;
  protected readonly five = range(5);
  protected readonly widths = WIDTHS;
  protected readonly items = computed(() => range(this.rows()));
  protected headCls(i: number): string {
    return cx("h-3 w-16", i === 2 && "hidden sm:block", i > 2 && "hidden lg:block");
  }
}

/** Admin and seller tables: a header row and rows of cells. */
@Component({
  selector: "pc-table-skeleton",
  imports: [DelayedFallback, TableShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-delayed-fallback label="Loading" [delay]="delay()" [skeletonClass]="skeletonClass()"><pc-sk-table [rows]="rows()" /></pc-delayed-fallback>`,
})
export class TableSkeleton {
  readonly rows = input(8);
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
}

@Component({
  selector: "pc-sk-list",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="divide-y divide-line overflow-hidden rounded-xl bg-white">
      @for (i of items(); track i) {
        <div class="flex items-center gap-3 p-4">
          <span pcBone class="h-12 w-12 rounded-lg"></span>
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <span pcLine [class]="'h-4 ' + widths[i % widths.length]"></span>
            <span pcLine [class]="'h-3 ' + widths[(i + 3) % widths.length]"></span>
          </div>
          <span pcBone class="hidden h-6 w-20 rounded-full sm:block"></span>
        </div>
      }
    </div>
  `,
})
export class ListShape {
  readonly rows = input(6);
  protected readonly widths = WIDTHS;
  protected readonly items = computed(() => range(this.rows()));
}

/** A list of rows (tickets, messages, alerts, coupons): a thumbnail, two lines and a status. */
@Component({
  selector: "pc-list-skeleton",
  imports: [DelayedFallback, TitleShape, ListShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading" [delay]="delay()" [skeletonClass]="cls()">
      @if (title()) {<pc-sk-title [sub]="false" />}
      <pc-sk-list [rows]="rows()" />
    </pc-delayed-fallback>
  `,
})
export class ListSkeleton {
  readonly rows = input(6);
  readonly title = input(false);
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly cls = computed(() => cx("flex flex-col gap-3", this.skeletonClass()));
}

/** Any page: a title bar and a few blocks. What PageLoader shows by default. */
@Component({
  selector: "pc-page-skeleton",
  imports: [DelayedFallback, SHARED, TitleShape, SkeletonText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading" [delay]="delay()" [skeletonClass]="cls()">
      <pc-sk-title />
      <div class="flex flex-col gap-4 rounded-xl bg-white p-4 sm:p-5">
        @for (i of four; track i) {
          <div class="flex items-center gap-3">
            <span pcBone class="h-10 w-10 rounded-lg"></span>
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <span pcLine [class]="'h-4 ' + a[i]"></span>
              <span pcLine [class]="'h-3 ' + b[i]"></span>
            </div>
            <span pcLine class="hidden h-4 w-16 sm:block"></span>
          </div>
        }
      </div>
      <div class="grid gap-4 sm:grid-cols-2">
        @for (i of two; track i) {
          <div class="flex flex-col gap-3 rounded-xl bg-white p-4 sm:p-5">
            <span pcLine class="h-5 w-32"></span>
            <pc-skeleton-text [lines]="3" [last]="i ? 'w-1/2' : 'w-3/4'" />
          </div>
        }
      </div>
    </pc-delayed-fallback>
  `,
})
export class PageSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly four = range(4);
  protected readonly two = range(2);
  protected readonly a = ["w-2/5", "w-1/2", "w-1/3", "w-3/5"];
  protected readonly b = ["w-3/5", "w-2/5", "w-1/2", "w-1/3"];
  protected readonly cls = computed(() => cx("flex flex-col gap-4", this.skeletonClass()));
}

/** Wishlist: the heading and the saved products. */
@Component({
  selector: "pc-wishlist-skeleton",
  imports: [DelayedFallback, TitleShape, GridShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading your wishlist" [delay]="delay()" [skeletonClass]="cls()">
      <pc-sk-title [sub]="false" />
      <pc-sk-grid [dense]="true" />
    </pc-delayed-fallback>
  `,
})
export class WishlistSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly cls = computed(() => cx("flex flex-col gap-3", this.skeletonClass()));
}

/** Sign-in and sign-up in the theme's arrangement: a centred card, or a brand panel beside the form on large screens. */
@Component({
  selector: "pc-auth-skeleton",
  imports: [DelayedFallback, SHARED, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #card>
      <div [class]="CARD + ' mx-auto flex w-full max-w-md flex-col gap-4 p-6 sm:p-8'">
        <span pcLine class="h-7 w-40"></span>
        <span pcLine class="h-4 w-64"></span>
        <div class="mt-2 flex flex-col gap-2">
          <span pcLine class="h-3.5 w-28"></span>
          <span pcBone class="h-11 w-full rounded-lg"></span>
        </div>
        <span pcBone class="h-11 w-full rounded-lg"></span>
        <div class="mt-2 border-t border-line pt-4">
          <span pcLine class="mx-auto h-4 w-48"></span>
        </div>
      </div>
    </ng-template>
    <pc-delayed-fallback label="Loading" [delay]="delay()" [skeletonClass]="cls()">
      @if (layout().auth.layout === "split") {
        <div class="grid items-center gap-8 lg:grid-cols-2">
          <div class="skeleton hidden min-h-[460px] flex-col justify-end gap-3 rounded-2xl p-10 lg:flex">
            <span [class]="'block h-9 w-2/3 bg-white/50 ' + BAR"></span>
            <span [class]="'block h-4 w-1/2 bg-white/40 ' + BAR"></span>
          </div>
          <ng-container *ngTemplateOutlet="card" />
        </div>
      } @else {
        <ng-container *ngTemplateOutlet="card" />
      }
    </pc-delayed-fallback>
  `,
})
export class AuthSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly layout = inject(ThemeService).layout;
  protected readonly CARD = CARD;
  protected readonly BAR = BAR;
  protected readonly cls = computed(() => cx("py-4 sm:py-8", this.skeletonClass()));
}

/* ------------------------------------------------------------------ admin, seller hub, delivery app */

@Component({
  selector: "pc-sk-admin-head",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="flex flex-col gap-2">
        <span pcLine class="h-8 w-48 sm:h-9"></span>
        <span pcLine class="h-4 w-72"></span>
      </div>
      <span pcBone class="h-10 w-32 rounded-lg"></span>
    </div>
  `,
})
export class AdminHeadShape {}

@Component({
  selector: "pc-sk-stats",
  imports: [SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      @for (w of widths; track $index) {
        <div class="flex flex-col gap-2.5 rounded-xl bg-white p-4">
          <span pcLine [class]="'h-3.5 ' + w"></span>
          <span pcLine class="h-8 w-20"></span>
        </div>
      }
    </div>
  `,
})
export class StatsShape {
  protected readonly widths = ["w-24", "w-32", "w-20", "w-28"];
}

/**
 * An admin or seller page inside its panel: the page title, then
 *   table (default): tabs, filters and a table;  dashboard: figures, a chart and two cards;
 *   form: settings sections;  detail: a record's page.
 */
@Component({
  selector: "pc-admin-page-skeleton",
  imports: [DelayedFallback, SHARED, AdminHeadShape, StatsShape, FormShape, DetailShape, TableShape],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading" [delay]="delay()" [skeletonClass]="cls()">
      <pc-sk-admin-head />
      @switch (kind()) {
        @case ("dashboard") {
          <pc-sk-stats />
          <div class="flex flex-col gap-3 rounded-xl bg-white p-4">
            <span pcLine class="h-5 w-36"></span>
            <div class="flex h-48 items-end gap-1.5 sm:gap-2" aria-hidden="true">
              @for (h of bars; track $index; let i = $index) {
                <span [class]="i > 7 ? 'skeleton block flex-1 rounded-t-md hidden sm:block' : 'skeleton block flex-1 rounded-t-md'" [style.height.%]="h"></span>
              }
            </div>
          </div>
          <div class="grid gap-4 lg:grid-cols-2">
            @for (i of two; track i) {
              <div class="flex flex-col gap-3 rounded-xl bg-white p-4">
                <span pcLine class="h-5 w-32"></span>
                @for (j of four; track j) {<span pcLine [class]="'h-4 ' + widths[(i + j) % widths.length]"></span>}
              </div>
            }
          </div>
        }
        @case ("form") {<pc-sk-form />}
        @case ("detail") {<pc-sk-detail />}
        @default {
          <div class="flex gap-4 overflow-hidden border-b border-line pb-2.5">
            @for (w of tabs; track $index) {<span pcLine [class]="'h-4 shrink-0 ' + w"></span>}
          </div>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <span pcBone class="h-10 w-full rounded-lg sm:col-span-2"></span>
            <span pcBone class="hidden h-10 w-full rounded-lg sm:block"></span>
            <span pcBone class="hidden h-10 w-full rounded-lg sm:block"></span>
          </div>
          <pc-sk-stats />
          <pc-sk-table [rows]="6" />
        }
      }
    </pc-delayed-fallback>
  `,
})
export class AdminPageSkeleton {
  readonly kind = input<"table" | "dashboard" | "form" | "detail">("table");
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly bars = [38, 62, 45, 80, 55, 70, 42, 90, 64, 52, 76, 48];
  protected readonly two = range(2);
  protected readonly four = range(4);
  protected readonly widths = WIDTHS;
  protected readonly tabs = ["w-12", "w-20", "w-28", "w-20"];
  protected readonly cls = computed(() => cx("flex flex-col gap-4", this.skeletonClass()));
}

/** The delivery partner app: the status card, two figures and a list, in its rounded app style. */
@Component({
  selector: "pc-cards-skeleton",
  imports: [DelayedFallback, SHARED],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-delayed-fallback label="Loading" [delay]="delay()" [skeletonClass]="cls()">
      <div class="flex flex-col gap-3 rounded-3xl bg-white p-5 shadow-sm">
        <div class="flex items-center justify-between gap-3">
          <span pcLine class="h-6 w-40"></span>
          <span pcBone class="h-8 w-16 rounded-full"></span>
        </div>
        <span pcLine class="h-4 w-3/4"></span>
        <span pcBone class="mt-1 h-12 w-full rounded-2xl"></span>
      </div>
      <div class="grid grid-cols-2 gap-3">
        @for (i of two; track i) {
          <div class="flex flex-col gap-2.5 rounded-2xl bg-white p-4 shadow-sm">
            <span pcLine class="h-3.5 w-20"></span>
            <span pcLine class="h-7 w-24"></span>
          </div>
        }
      </div>
      <div class="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm">
        <span pcLine class="h-5 w-32"></span>
        @for (i of three; track i) {
          <div class="flex items-center gap-3">
            <span pcBone class="h-10 w-10 rounded-xl"></span>
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <span pcLine [class]="'h-4 ' + widths[i % widths.length]"></span>
              <span pcLine class="h-3 w-1/3"></span>
            </div>
          </div>
        }
      </div>
    </pc-delayed-fallback>
  `,
})
export class CardsSkeleton {
  readonly skeletonClass = input<string | undefined>(undefined);
  readonly delay = input(LOADER_DELAY);
  protected readonly two = range(2);
  protected readonly three = range(3);
  protected readonly widths = WIDTHS;
  protected readonly cls = computed(() => cx("flex flex-col gap-4", this.skeletonClass()));
}

/* ------------------------------------------------------------------ shop routes */

type ShopShape = "home" | "pdp" | "listing-crumb" | "listing" | "store" | "categories" | "deals" | "top" | "cart" | "checkout" | "orders"
  | "detail" | "form" | "wishlist" | "auth" | "list" | "table" | "page";

/** Which skeleton a shop address shows (the same choice as the reference's ShopRouteSkeleton). */
export function shopRouteShape(path: string): ShopShape {
  if (path === "/") return "home";
  if (path.startsWith("/p/")) return "pdp";
  if (path.startsWith("/c/")) return "listing-crumb";
  if (path.startsWith("/search")) return "listing";
  if (path.startsWith("/store/")) return "store";
  if (path.startsWith("/categories")) return "categories";
  if (path.startsWith("/deals")) return "deals";
  if (path.startsWith("/bestsellers") || path.startsWith("/new-releases")) return "top";
  if (path.startsWith("/cart")) return "cart";
  if (path.startsWith("/checkout")) return "checkout";
  if (path === "/orders") return "orders";
  if (path.startsWith("/orders/") || (/^\/support\/[^/]+$/.test(path) && path !== "/support/new")) return "detail";
  if (path.startsWith("/account")) return "form";
  if (path.startsWith("/wishlist")) return "wishlist";
  if (path.startsWith("/login") || path.startsWith("/signup")) return "auth";
  if (path.startsWith("/support/new")) return "form";
  if (["/support", "/notifications", "/alerts", "/coupons"].some((p) => path.startsWith(p))) return "list";
  if (path.startsWith("/compare")) return "table";
  return "page";
}

/**
 * The skeleton for a shop address. Pages with their own loader show the same one, so whichever loader shows first,
 * the shape never changes on the way in. Pass `path` to choose for another address (default: the current one).
 */
@Component({
  selector: "pc-shop-route-skeleton",
  imports: [
    HomeSkeleton, ProductPageSkeleton, ListingSkeleton, StoreSkeleton, CategoriesSkeleton, DealsSkeleton, TopListSkeleton, CartSkeleton,
    CheckoutSkeleton, OrdersSkeleton, DetailSkeleton, FormSkeleton, WishlistSkeleton, AuthSkeleton, ListSkeleton, TableSkeleton, PageSkeleton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @switch (shape()) {
      @case ("home") {<pc-home-skeleton />}
      @case ("pdp") {<pc-product-page-skeleton />}
      @case ("listing-crumb") {<pc-listing-skeleton [crumb]="true" />}
      @case ("listing") {<pc-listing-skeleton />}
      @case ("store") {<pc-store-skeleton />}
      @case ("categories") {<pc-categories-skeleton />}
      @case ("deals") {<pc-deals-skeleton />}
      @case ("top") {<pc-top-list-skeleton />}
      @case ("cart") {<pc-cart-skeleton />}
      @case ("checkout") {<pc-checkout-skeleton />}
      @case ("orders") {<pc-orders-skeleton />}
      @case ("detail") {<pc-detail-skeleton />}
      @case ("form") {<pc-form-skeleton [narrow]="true" />}
      @case ("wishlist") {<pc-wishlist-skeleton />}
      @case ("auth") {<pc-auth-skeleton />}
      @case ("list") {<pc-list-skeleton [title]="true" />}
      @case ("table") {<pc-table-skeleton />}
      @default {<pc-page-skeleton />}
    }
  `,
})
export class ShopRouteSkeleton {
  readonly path = input<string | undefined>(undefined);
  private readonly current = inject(RouteState).pathname;
  protected readonly shape = computed(() => shopRouteShape(this.path() ?? this.current() ?? "/"));
}

export const SKELETONS = [
  DelayedFallback, SkeletonBlock, SkeletonText, SkeletonCircle, ProductGridSkeleton, RailSkeleton, HomeSkeleton, ListingSkeleton, StoreSkeleton,
  CategoriesSkeleton, DealsSkeleton, TopListSkeleton, ProductPageSkeleton, CartSkeleton, CheckoutSkeleton, OrdersSkeleton, DetailSkeleton,
  FormSkeleton, TableSkeleton, ListSkeleton, PageSkeleton, WishlistSkeleton, AuthSkeleton, AdminPageSkeleton, CardsSkeleton, ShopRouteSkeleton,
] as const;
