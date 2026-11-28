/* Classic tile: white, hairline-separated, photo on top, rating chip, deal badge, price, delivery date. */

import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { Plus, ShoppingCart } from "lucide-angular";
import type { ProductCard } from "../../core/types";
import { DealBadge, TileDelivery, TileImage, TileLink, TilePrice, TileRating, quickAdd } from "../../shared/product/product-parts";
import { WishlistHeart } from "../../shared/product/wishlist-heart";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

@Component({
  selector: "pc-classic-tile",
  imports: [Icon, PcLink, DealBadge, TileDelivery, TileImage, TileLink, TilePrice, TileRating, WishlistHeart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative flex h-full flex-col bg-white", "data-testid": "product-tile" },
  template: `
    <pc-wishlist-heart [productId]="p().id" />
    <a [pcTileLink]="p()" class="group flex h-full flex-col bg-white p-3 outline-offset-[-2px] sm:p-4">
      <div class="relative mb-2">
        <pc-tile-image [p]="p()" class="aspect-square rounded-lg bg-white" />
        @if (rank() !== undefined) {<span class="absolute left-0 top-0 rounded-br-lg bg-marigold px-2 py-0.5 text-sm font-bold text-ink">#{{ rank() }}</span>}
      </div>
      @if (p().sponsored) {<p class="text-[11px] font-medium uppercase tracking-wide text-ink-faint" data-testid="sponsored-label">Sponsored</p>}
      @if (p().brand) {<p class="text-xs font-semibold text-ink-faint">{{ p().brand }}</p>}
      <p class="line-clamp-2 text-[15px] leading-snug text-ink group-hover:text-peacock">{{ p().title }}</p>
      <pc-tile-rating [p]="p()" ratingClass="mt-1" />
      @if (p().bought) {<p class="mt-0.5 text-xs text-ink-soft">{{ p().bought }}</p>}
      @if (p().is_new) {<p class="mt-0.5 text-xs font-semibold text-leaf" data-testid="new-badge">New</p>}
      @if (p().deal) {<div class="mt-1.5"><pc-deal-badge [deal]="p().deal!" [discount]="p().discount_pct" /></div>}
      <pc-tile-price [p]="p()" class="mt-auto pt-1.5" />
      <pc-tile-delivery [p]="p()" />
    </a>
    @if (quickPlus()) {
      @if (q.canAdd() && !q.needsOptions()) {
        <button type="button" (click)="q.add($event)" [disabled]="q.busy()" [attr.aria-label]="'Add ' + p().title + ' to cart'" data-testid="quick-add"
          class="pc-press absolute bottom-2 right-2 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-marigold text-ink shadow-md ring-2 ring-white hover:bg-marigold-dark disabled:opacity-60">
          <svg [pcIcon]="Plus" class="h-5 w-5" />
        </button>
      }
    }
    @if (showAdd()) {
      <div class="px-3 pb-3 sm:px-4 sm:pb-4">
        @if (q.needsOptions()) {
          <a [pcLink]="q.optionsHref()" class="mt-2 block rounded-full border border-line py-1.5 text-center text-sm font-semibold hover:bg-mist">See options</a>
        } @else if (q.canAdd()) {
          <button type="button" (click)="q.add($event)" [disabled]="q.busy()" data-testid="quick-add"
            class="pc-press mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-marigold py-1.5 text-sm font-semibold text-ink hover:bg-marigold-dark disabled:opacity-60">
            <svg [pcIcon]="ShoppingCart" class="h-4 w-4" /> {{ q.busy() ? "Adding…" : "Add to cart" }}
          </button>
        }
      </div>
    }
  `,
})
export class ClassicProductTile {
  readonly p = input.required<ProductCard>();
  readonly showAdd = input(false);
  readonly rank = input<number | undefined>(undefined);
  readonly quickPlus = input(false);
  protected readonly q = quickAdd(this.p);
  protected readonly Plus = Plus;
  protected readonly ShoppingCart = ShoppingCart;
}
