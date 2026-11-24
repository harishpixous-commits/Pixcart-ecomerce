/*
 * Product cards, grids and rails used across the store: search, categories, home blocks, deals, bestsellers, product
 * pages. The tile itself comes from the active theme (themes/<id>/product-tile.ts); the grid and rail follow the
 * theme's layout. Port of components/product.tsx:
 *   <ng-container [pcProductTile]="p" [showAdd]="x" [rank]="n" />   the theme's tile (no wrapper element)
 *   <pc-grid-frame [dense]="x"> ...tiles... </pc-grid-frame>        a framed hairline grid, raised cards or airy tiles
 *   <pc-product-grid [items] [dense] [showAdd] [ranked] />
 *   <pc-product-rail title="..." [items] href="/deals" linkText="See all deals" note="Sponsored"><span extra>..</span></pc-product-rail>
 *   gridClass(layout, dense)                                         the grid classes (useGridClass)
 */

import {
  ChangeDetectionStrategy, Component, ComponentRef, DestroyRef, Directive, ElementRef, ViewContainerRef, afterNextRender, computed, effect, inject,
  input, signal, untracked, viewChild,
} from "@angular/core";
import { ChevronLeft, ChevronRight } from "lucide-angular";
import type { ProductCard as Card } from "../../core/types";
import { ThemeService } from "../../themes/context";
import { SLOTS } from "../../themes/slots";
import type { ThemeLayout } from "../../themes/types";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";

export { DealBadge, DealCountdown } from "./product-parts";

/** The active theme's product tile, created in place (its host element is the tile's root, as in the reference). */
@Directive({ selector: "ng-container[pcProductTile]" })
export class ProductTileOutlet {
  readonly pcProductTile = input.required<Card>();
  readonly showAdd = input(false);
  readonly rank = input<number | undefined>(undefined);
  readonly quickPlus = input(false);
  private readonly vcr = inject(ViewContainerRef);
  private readonly theme = inject(ThemeService);
  private ref: ComponentRef<unknown> | null = null;
  private type: unknown = null;

  constructor() {
    effect(() => {
      const type = (SLOTS[this.theme.active().data.id] ?? SLOTS.classic).ProductTile;
      const inputs = { p: this.pcProductTile(), showAdd: this.showAdd(), rank: this.rank(), quickPlus: this.quickPlus() };
      untracked(() => {
        if (type !== this.type) {
          this.vcr.clear();
          this.ref = this.vcr.createComponent(type);
          this.type = type;
        }
        for (const [k, v] of Object.entries(inputs)) this.ref!.setInput(k, v);
      });
    });
    inject(DestroyRef).onDestroy(() => this.vcr.clear());
  }
}

// One more column on very wide screens (2xl, 1536 px and up) so tiles keep a sensible size when the page fills the screen.
const COLS: Record<ThemeLayout["gridColumns"], string> = {
  4: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6",
  6: "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7",
};
const DENSE = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5";

// Hairline: cells draw their right and bottom lines and the frame (GridFrame) clips the outer ones, so a short last
// row leaves white space, not a grey block.
const GRID: Record<ThemeLayout["productGrid"], string> = {
  hairline: "-mb-px -mr-px [&>*]:border-b [&>*]:border-r [&>*]:border-line",
  cards: "gap-2.5 sm:gap-4",
  airy: "gap-x-4 gap-y-8 sm:gap-x-6 sm:gap-y-10",
};

/** The grid classes for product lists in the active theme (wrap the grid in GridFrame). */
export function gridClass(layout: ThemeLayout, dense?: boolean): string {
  return cx("grid", GRID[layout.productGrid], dense ? DENSE : COLS[layout.gridColumns]);
}

/** A product grid in the active theme: a framed hairline grid, raised cards or airy tiles. Extra classes: gridClass input. */
@Component({
  selector: "pc-grid-frame",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "hairline() ? 'block overflow-hidden rounded-xl bg-white ring-1 ring-line' : 'contents'" },
  template: `<div [class]="cls()" [attr.data-testid]="testid() || null"><ng-content /></div>`,
})
export class GridFrame {
  readonly dense = input(false);
  readonly extra = input<string>("", { alias: "gridClass" });
  readonly testid = input<string>("");
  private readonly layout = inject(ThemeService).layout;
  protected readonly hairline = computed(() => this.layout().productGrid === "hairline");
  protected readonly cls = computed(() => cx(gridClass(this.layout(), this.dense()), this.extra()));
}

@Component({
  selector: "pc-product-grid",
  imports: [GridFrame, ProductTileOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-grid-frame [dense]="dense()">
      @for (p of items(); track p.id + "-" + $index) {
        <ng-container [pcProductTile]="p" [showAdd]="showAdd()" [rank]="ranked() ? $index + 1 : undefined" />
      }
    </pc-grid-frame>
  `,
})
export class ProductGrid {
  readonly items = input.required<Card[]>();
  readonly dense = input(false);
  readonly showAdd = input(false);
  readonly ranked = input(false);
}

const RAIL_ITEM: Record<ThemeLayout["productGrid"], Record<ThemeLayout["gridColumns"], string>> = {
  hairline: {
    4: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[25%] 2xl:w-[20%]",
    5: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[16.66%] 2xl:w-[14.28%]",
    6: "w-[46%] border-r border-line last:border-r-0 sm:w-[30%] lg:w-[16.66%] 2xl:w-[12.5%]",
  },
  cards: {
    4: "w-[44%] sm:w-[30%] lg:w-[23.6%] 2xl:w-[18.7%]",
    5: "w-[44%] sm:w-[30%] lg:w-[18.7%] 2xl:w-[15.6%]",
    6: "w-[40%] sm:w-[28%] md:w-[23%] lg:w-[15.6%] 2xl:w-[13.3%]",
  },
  airy: {
    4: "w-[47%] sm:w-[31%] lg:w-[23.2%] 2xl:w-[18.4%]",
    5: "w-[47%] sm:w-[31%] lg:w-[18.4%] 2xl:w-[15.2%]",
    6: "w-[47%] sm:w-[31%] lg:w-[15.2%] 2xl:w-[13%]",
  },
};

const RAIL_TRACK: Record<ThemeLayout["productGrid"], string> = {
  hairline: "",
  // scroll padding matches the side padding, so snapping never shifts the first card (and shows a stray arrow)
  cards: "gap-2.5 px-3 pb-3 pt-1 scroll-px-3 sm:gap-4 sm:px-4 sm:pb-4 sm:scroll-px-4",
  airy: "gap-4 pb-2 sm:gap-6",
};

/** A horizontal row with arrow buttons (desktop) and swipe (phones). Anything with the `extra` attribute goes beside the title. */
@Component({
  selector: "pc-product-rail",
  imports: [Icon, PcLink, ProductTileOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (items().length) {
      <section class="shop-panel" [attr.aria-label]="title()" data-testid="product-rail">
        <div [class]="plain() ? 'flex items-baseline justify-between gap-3 pb-1 px-0 pt-1' : 'flex items-baseline justify-between gap-3 pb-1 px-4 pt-4'">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 [class]="plain() ? 'font-semibold text-xl sm:text-2xl' : 'font-semibold text-xl'">{{ title() }}</h2>
            @if (note()) {<span class="text-xs text-ink-faint">{{ note() }}</span>}
            <ng-content select="[extra]" />
          </div>
          @if (href()) {<a [pcLink]="href()!" class="shrink-0 text-sm font-semibold text-peacock hover:underline">{{ linkText() }}</a>}
        </div>
        <div class="group/rail relative">
          <div #box [class]="trackCls()" (scroll)="update()">
            @for (p of items(); track p.id + "-" + $index) {
              <div [class]="itemCls()">
                <ng-container [pcProductTile]="p" [showAdd]="showAdd()" [rank]="ranked() ? $index + 1 : undefined" />
              </div>
            }
          </div>
          @if (!edges().start) {
            <button type="button" (click)="go(-1)" aria-label="Scroll left" class="absolute left-0 top-1/3 hidden h-20 w-10 items-center justify-center rounded-r-lg bg-white/95 shadow-md ring-1 ring-line hover:bg-mist lg:flex">
              <svg [pcIcon]="ChevronLeft" class="h-6 w-6" />
            </button>
          }
          @if (!edges().end) {
            <button type="button" (click)="go(1)" aria-label="Scroll right" class="absolute right-0 top-1/3 hidden h-20 w-10 items-center justify-center rounded-l-lg bg-white/95 shadow-md ring-1 ring-line hover:bg-mist lg:flex">
              <svg [pcIcon]="ChevronRight" class="h-6 w-6" />
            </button>
          }
        </div>
      </section>
    }
  `,
})
export class ProductRail {
  readonly title = input.required<string>();
  readonly items = input.required<Card[]>();
  readonly href = input<string | undefined>(undefined);
  readonly linkText = input("See all");
  readonly showAdd = input(false);
  readonly ranked = input(false);
  readonly note = input<string | undefined>(undefined);
  private readonly layout = inject(ThemeService).layout;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;
  private readonly box = viewChild<ElementRef<HTMLDivElement>>("box");
  protected readonly edges = signal({ start: true, end: false });
  protected readonly plain = computed(() => this.layout().home.sections === "plain");
  protected readonly trackCls = computed(() =>
    cx("scroll-x flex snap-x overflow-x-auto", RAIL_TRACK[this.layout().productGrid], this.plain() && this.layout().productGrid === "cards" && "px-0 sm:px-0"));
  protected readonly itemCls = computed(() => cx("shrink-0 snap-start", RAIL_ITEM[this.layout().productGrid][this.layout().gridColumns]));

  constructor() {
    const onResize = () => this.update();
    window.addEventListener("resize", onResize);
    inject(DestroyRef).onDestroy(() => window.removeEventListener("resize", onResize));
    afterNextRender(() => requestAnimationFrame(() => this.update()));
    effect(() => {
      this.items();
      untracked(() => requestAnimationFrame(() => this.update()));
    });
  }

  protected update(): void {
    const el = this.box()?.nativeElement;
    if (!el) return;
    const next = { start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 };
    const cur = this.edges();
    if (cur.start !== next.start || cur.end !== next.end) this.edges.set(next);
  }

  protected go(d: number): void {
    const el = this.box()?.nativeElement;
    el?.scrollBy({ left: d * el.clientWidth * 0.9, behavior: "smooth" });
  }
}
