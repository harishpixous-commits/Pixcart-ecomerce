import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute } from "@angular/router";
import { map } from "rxjs";
import { api } from "../../core/api";
import type { ProductCard } from "../../core/types";
import { ProductGrid } from "../../shared/product/product";
import { PageLoader } from "../../shared/ui/page-loader";
import { ButtonLink, EmptyState } from "../../shared/ui/ui";

/** A wishlist someone shared with a private link. No sign-in needed. */
@Component({
  selector: "pc-shop-wishlist-shared-page",
  imports: [ProductGrid, PageLoader, ButtonLink, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (gone()) {
      <pc-empty-state title="This wishlist is not shared any more" body="The link was switched off or is not right.">
        <a pcButtonLink href="/" action>Browse products</a>
      </pc-empty-state>
    } @else if (data(); as d) {
      <div class="flex flex-col gap-3">
        <h1 class="px-1 text-2xl font-semibold">{{ d.owner ? d.owner + "'s wishlist" : "A shared wishlist" }} <span class="text-base font-normal text-ink-faint">({{ d.items.length }})</span></h1>
        @if (d.items.length === 0) {
          <pc-empty-state title="Nothing here right now" body="The products on this list are not available at the moment." />
        } @else { <pc-product-grid [items]="d.items" [dense]="true" /> }
      </div>
    } @else { <pc-page-loader /> }
  `,
})
export class ShopWishlistSharedPage {
  private readonly token = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => p.get("token") ?? "")), { initialValue: "" });
  protected readonly data = signal<{ owner: string; items: ProductCard[] } | null>(null);
  protected readonly gone = signal(false);
  constructor() {
    api<{ owner: string; items: ProductCard[] }>(`/api/wishlist/shared/${encodeURIComponent(this.token())}`).then((x) => this.data.set(x)).catch(() => this.gone.set(true));
  }
}
