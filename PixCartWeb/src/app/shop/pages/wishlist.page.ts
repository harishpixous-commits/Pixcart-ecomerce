import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { api } from "../../core/api";
import { SessionService } from "../../core/session";
import type { ProductCard } from "../../core/types";
import { WishlistService } from "../../core/wishlist";
import { ProductGrid } from "../../shared/product/product";
import { PageLoader } from "../../shared/ui/page-loader";
import { ButtonLink, EmptyState } from "../../shared/ui/ui";

@Component({
  selector: "pc-shop-wishlist-page",
  imports: [ProductGrid, PageLoader, ButtonLink, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (items() === null) { <pc-page-loader /> }
    @else {
      <div class="flex flex-col gap-3">
        <h1 class="px-1 text-2xl font-semibold">Your wishlist <span class="text-base font-normal text-ink-faint">({{ shown().length }})</span></h1>
        @if (shown().length === 0) {
          <pc-empty-state title="Nothing saved yet" body="Tap the heart on any product to save it here for later.">
            <a pcButtonLink href="/" action>Browse products</a>
          </pc-empty-state>
        } @else { <pc-product-grid [items]="shown()" [dense]="true" /> }
      </div>
    }
  `,
})
export class ShopWishlistPage {
  private readonly session = inject(SessionService);
  private readonly wishlist = inject(WishlistService);
  private readonly router = inject(Router);
  readonly items = signal<ProductCard[] | null>(null);
  readonly shown = computed(() => (this.items() ?? []).filter(product => this.wishlist.ids().has(product.id)));
  constructor() {
    effect(() => {
      const user = this.session.user();
      if (this.session.ready() && !user) void this.router.navigateByUrl('/login?next=/wishlist', { replaceUrl: true });
      if (user) api<{ items: ProductCard[] }>('/api/wishlist').then(response => this.items.set(response.items)).catch(() => {});
    });
  }
}
