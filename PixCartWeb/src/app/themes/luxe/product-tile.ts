/*
 * Luxe tile (boutique): no card. A tall white photo frame (4:5, the whole product visible, a zoom on hover), then quiet
 * type underneath: the brand in small capitals, the title in the serif, the price with the M.R.P. struck through and
 * the discount, a fine star line, the deal and its countdown, and the delivery date. Adding to the cart is a small
 * round + on phones and touch screens, and a "Quick add" bar sliding up over the photo on computers.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { Loader2, Plus, Star } from "lucide-angular";
import { rupees } from "../../core/format";
import type { ProductCard } from "../../core/types";
import { DealCountdown, TileDelivery, TileImage, TileLink, quickAdd } from "../../shared/product/product-parts";
import { WishlistHeart } from "../../shared/product/wishlist-heart";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { ThemeService } from "../context";
import type { ThemeLayout } from "../types";

/** What both looks share: a control placed on the photo. */
const CONTROL = "pointer-events-auto absolute items-center justify-center transition duration-200";

/** Phones and touch screens: a small round + in the photo's bottom-right corner (a 44 px touch area). */
const TOUCH =
  "bottom-2 right-2 h-9 w-9 rounded-full bg-white text-ink shadow-sm ring-1 ring-line " +
  "before:absolute before:-inset-1 before:content-[''] active:scale-95 disabled:opacity-70";

/* Computers (a mouse, 640 px and up): a full-width bar hidden under the photo's bottom edge that slides up on hover or focus. */
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

/*
 * Luxe's own look is "airy": no card. When the owner picks another product grid for Luxe, the tile takes that grid's
 * surface: white cells between hairlines, or raised cards, with the same inner spacing.
 */
const FRAME: Record<ThemeLayout["productGrid"], string> = {
  airy: "",
  hairline: "bg-white p-3 sm:p-4",
  cards: "pc-lift rounded-xl bg-white p-3 shadow-card sm:p-4",
};

@Component({
  selector: "pc-luxe-tile",
  imports: [Icon, PcLink, DealCountdown, TileDelivery, TileImage, TileLink, WishlistHeart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "root()", "data-testid": "product-tile" },
  template: `
    <div class="relative flex flex-1 flex-col">
      <a [pcTileLink]="p()" class="flex flex-1 flex-col outline-offset-4">
        <div class="relative">
          <pc-tile-image [p]="p()" class="aspect-[4/5] bg-white [&>span]:hidden" [imgClass]="p().in_stock ? 'p-3 sm:p-5 lg:p-6' : 'p-3 sm:p-5 lg:p-6 opacity-50'" />
          @if (rank() !== undefined) {<span class="absolute left-2.5 top-3 text-[11px] font-medium uppercase tracking-[0.16em] text-ink sm:left-3.5">No. {{ rank() }}</span>}
          @if (!p().in_stock) {<span class="absolute inset-x-0 bottom-0 bg-white/90 py-2.5 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-ink">Sold out</span>}
        </div>
        <div class="flex flex-1 flex-col pt-3">
          <div class="flex min-h-[1rem] items-baseline justify-between gap-2 text-[11px] uppercase leading-4 tracking-[0.16em] text-ink-faint">
            <span class="truncate">{{ p().brand }}</span>
            @if (p().sponsored) {<span class="shrink-0" data-testid="sponsored-label">Sponsored</span>}
          </div>
          <p class="mt-1 line-clamp-2 min-h-[2.75em] font-display text-[15px] leading-snug text-ink decoration-ink/40 underline-offset-[3px] group-hover:underline">{{ p().title }}</p>
          <p class="mt-2 flex flex-wrap items-baseline gap-x-2 font-sans text-[14px] leading-5">
            <span class="font-medium text-ink">{{ fmt(p().price) }}</span>
            @if (p().mrp > p().price) {<span class="text-[13px] text-ink-faint line-through"><span class="sr-only">M.R.P. </span>{{ fmt(p().mrp) }}</span>}
            @if (p().discount_pct > 0) {
              <span class="text-[13px] font-medium text-vermilion"><span aria-hidden="true">-{{ p().discount_pct }}%</span><span class="sr-only">{{ p().discount_pct }}% off</span></span>
            }
          </p>
          @if (p().unit_price) {<p class="text-[12px] text-ink-soft">{{ fmt(p().unit_price!.paise) }}/{{ p().unit_price!.per }}</p>}
          @if (p().deal; as deal) {
            <div class="mt-1.5" data-testid="deal-badge">
              <p class="flex flex-wrap items-baseline gap-x-2 text-[11px] font-medium uppercase leading-4 tracking-[0.14em] text-vermilion">
                <span>{{ deal.label }}</span>
                @if (deal.kind !== "limited") {<pc-deal-countdown [endsAt]="deal.ends_at" spanClass="tabular-nums tracking-[0.06em]" />}
              </p>
              @if (deal.claimed_pct !== null) {
                <p class="mt-1 flex items-center gap-2 text-[11px] leading-4 text-ink-soft">
                  <span aria-hidden="true" class="h-0.5 max-w-[96px] flex-1 bg-line"><span class="block h-full bg-vermilion" [style.width.%]="claimed(deal.claimed_pct)"></span></span>
                  {{ deal.claimed_pct }}% claimed
                </p>
              }
            </div>
          }
          @if (p().rating_count > 0) {
            <p class="mt-1.5 flex items-center gap-1.5 text-[12px] leading-none text-ink-soft">
              <span class="sr-only">Rated {{ p().rating_avg.toFixed(1) }} out of 5 from {{ count() }} ratings</span>
              <span aria-hidden="true" class="relative">
                <span class="flex text-ink/15">@for (i of five; track i) {<svg [pcIcon]="Star" class="h-3 w-3 shrink-0 fill-current" strokeWidth="0" />}</span>
                <span class="absolute inset-y-0 left-0 overflow-hidden" [style.width.%]="pct()"><span class="flex text-ink">@for (i of five; track i) {<svg [pcIcon]="Star" class="h-3 w-3 shrink-0 fill-current" strokeWidth="0" />}</span></span>
              </span>
              <span aria-hidden="true">{{ p().rating_avg.toFixed(1) }}</span>
              <span aria-hidden="true" class="text-ink-faint">({{ count() }})</span>
            </p>
          }
          @if (p().bought) {<p class="mt-1 text-[12px] text-ink-soft">{{ p().bought }}</p>}
          <div class="mt-1.5"><pc-tile-delivery [p]="p()" /></div>
        </div>
      </a>
      <div class="pointer-events-none absolute inset-x-0 top-0 aspect-[4/5] overflow-hidden">
        <pc-wishlist-heart [productId]="p().id"
          heartClass="pointer-events-auto absolute right-1.5 top-1.5 flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-ink/5 [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:[stroke-width:1.5]" />
        @if (q.needsOptions()) {
          <a [pcLink]="q.optionsHref()" [class]="OPTIONS" [attr.aria-label]="'Choose options for ' + p().title" data-testid="tile-options">Choose options</a>
        } @else if (q.canAdd()) {
          <button type="button" (click)="q.add($event)" [disabled]="q.busy()" [attr.aria-label]="'Quick add ' + p().title + ' to cart'" data-testid="quick-add" [class]="ADDBTN">
            @if (q.busy()) {
              <svg [pcIcon]="Loader2" class="h-4 w-4 animate-spin sm:[@media(hover:hover)]:h-3.5 sm:[@media(hover:hover)]:w-3.5" />
            } @else {
              <svg [pcIcon]="Plus" class="h-4 w-4 sm:[@media(hover:hover)]:hidden" strokeWidth="1.75" />
            }
            <span class="sr-only sm:[@media(hover:hover)]:not-sr-only">{{ q.busy() ? "Adding" : "Quick add" }}</span>
          </button>
        }
      </div>
    </div>
  `,
})
export class LuxeProductTile {
  readonly p = input.required<ProductCard>();
  readonly showAdd = input(false);
  readonly rank = input<number | undefined>(undefined);
  readonly quickPlus = input(false);
  private readonly theme = inject(ThemeService);
  protected readonly q = quickAdd(this.p);
  protected readonly fmt = rupees;
  protected readonly five = [0, 1, 2, 3, 4];
  protected readonly Loader2 = Loader2;
  protected readonly Plus = Plus;
  protected readonly Star = Star;
  protected readonly OPTIONS = cx(CONTROL, "hidden sm:[@media(hover:hover)]:flex", BAR);
  protected readonly ADDBTN = cx(CONTROL, "flex", TOUCH, BAR);
  protected readonly root = computed(() => cx("group relative flex h-full flex-col", FRAME[this.theme.layout().productGrid] ?? ""));
  protected readonly pct = computed(() => Math.max(0, Math.min(100, (this.p().rating_avg / 5) * 100)));
  protected readonly count = computed(() => this.p().rating_count.toLocaleString("en-IN"));
  protected claimed(n: number) {
    return Math.max(4, Math.min(100, n));
  }
}
