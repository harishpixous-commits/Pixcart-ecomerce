/*
 * Bazaar tile: a raised card with the photo inset on white, a discount ribbon, the rank as a medal, and a full-width
 * Add to cart button. Behaviour comes from shared/product/product-parts; this file only decides how it looks.
 * If the owner switches the product grid to hairline or airy, the card drops its own frame to suit.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { Plus, ShoppingCart } from "lucide-angular";
import type { ProductCard } from "../../core/types";
import { DealBadge, TileDelivery, TileImage, TileLink, TilePrice, TileRating, quickAdd } from "../../shared/product/product-parts";
import { WishlistHeart } from "../../shared/product/wishlist-heart";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { ThemeService } from "../context";
import type { ThemeLayout } from "../types";

const FRAME: Record<ThemeLayout["productGrid"], string> = {
  cards: "pc-lift rounded-xl bg-white shadow-card",
  hairline: "bg-white",
  airy: "",
};

@Component({
  selector: "pc-bazaar-tile",
  imports: [Icon, PcLink, DealBadge, TileDelivery, TileImage, TileLink, TilePrice, TileRating, WishlistHeart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "root()", "data-testid": "product-tile" },
  template: `
    <a [pcTileLink]="p()" [class]="grid() === 'cards' ? 'flex flex-1 flex-col p-2 rounded-xl' : 'flex flex-1 flex-col p-2'">
      <pc-tile-image [p]="p()" class="aspect-square rounded-lg bg-white" />
      <div class="flex flex-1 flex-col px-1 pb-1 pt-2.5">
        @if (p().sponsored) {<p class="text-[11px] font-medium uppercase tracking-wide text-ink-faint" data-testid="sponsored-label">Sponsored</p>}
        @if (p().brand) {<p class="truncate text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{{ p().brand }}</p>}
        <p class="mt-0.5 line-clamp-2 text-sm font-medium leading-snug text-ink transition-colors group-hover:text-peacock">{{ p().title }}</p>
        <pc-tile-rating [p]="p()" ratingClass="mt-1.5" />
        @if (p().bought) {<p class="mt-1 text-xs text-ink-soft">{{ p().bought }}</p>}
        @if (p().deal) {<div class="mt-2"><pc-deal-badge [deal]="p().deal!" [discount]="p().discount_pct" /></div>}
        <pc-tile-price [p]="p()" [showDiscount]="false" class="mt-auto pt-2" priceClass="font-display text-lg font-bold text-ink" />
        <pc-tile-delivery [p]="p()" />
      </div>
    </a>
    <div class="pointer-events-none absolute inset-x-2 top-2 aspect-square">
      @if (rank() !== undefined) {
        <span class="absolute left-2 top-2 flex h-8 min-w-[2rem] items-center justify-center rounded-full bg-marigold px-1.5 font-display text-sm font-bold text-ink shadow-sm ring-2 ring-white">#{{ rank() }}</span>
      }
      @if (ribbon()) {
        <span [class]="'absolute -left-2 rounded-r-md bg-vermilion py-0.5 pl-2 pr-2.5 text-xs font-bold leading-5 text-white shadow-sm ' + (rank() !== undefined ? 'top-12' : 'top-2.5')">
          <span aria-hidden="true">-{{ p().discount_pct }}%</span>
          <span class="sr-only">{{ p().discount_pct }}% off</span>
        </span>
      }
      <pc-wishlist-heart [productId]="p().id"
        heartClass="pointer-events-auto absolute right-1.5 top-1.5 flex h-9 w-9 items-center justify-center rounded-full bg-white/95 shadow-sm ring-1 ring-line transition-transform hover:scale-105" />
      @if (quickPlus() && q.canAdd()) {
        <button type="button" (click)="q.add($event)" [disabled]="q.busy()" [attr.aria-label]="'Add ' + p().title + ' to cart'" data-testid="quick-add"
          class="pc-press pointer-events-auto absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-marigold text-ink shadow-md ring-2 ring-white hover:bg-marigold-dark disabled:opacity-60">
          <svg [pcIcon]="Plus" class="h-5 w-5" strokeWidth="2.5" />
        </button>
      }
    </div>
    @if (showAdd()) {
      <div class="px-3 pb-3">
        @if (q.needsOptions()) {
          <a [pcLink]="q.optionsHref()" class="pc-press flex h-9 w-full items-center justify-center rounded-lg border border-peacock/40 text-sm font-semibold text-peacock hover:border-peacock hover:bg-peacock/5">See options</a>
        } @else if (!q.canAdd()) {
          <p class="flex h-9 items-center justify-center rounded-lg bg-mist text-sm font-semibold text-ink-faint" aria-hidden="true">Out of stock</p>
        } @else {
          <button type="button" (click)="q.add($event)" [disabled]="q.busy()" data-testid="quick-add"
            class="pc-press flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-marigold text-sm font-semibold text-ink hover:bg-marigold-dark disabled:opacity-60">
            <svg [pcIcon]="ShoppingCart" class="h-4 w-4" /> {{ q.busy() ? "Adding…" : "Add to cart" }}
          </button>
        }
      </div>
    }
  `,
})
export class BazaarProductTile {
  readonly p = input.required<ProductCard>();
  readonly showAdd = input(false);
  readonly rank = input<number | undefined>(undefined);
  readonly quickPlus = input(false);
  protected readonly q = quickAdd(this.p);
  private readonly theme = inject(ThemeService);
  protected readonly grid = computed(() => this.theme.layout().productGrid);
  protected readonly ribbon = computed(() => this.p().discount_pct > 0 && !this.p().deal);
  protected readonly root = computed(() => cx("group relative flex h-full flex-col", FRAME[this.theme.layout().productGrid] ?? FRAME.cards));
  protected readonly Plus = Plus;
  protected readonly ShoppingCart = ShoppingCart;
}
