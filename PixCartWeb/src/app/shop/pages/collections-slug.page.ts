/* A collection: a page of chosen products. Port of frontend/src/app/(shop)/collections/[slug]/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, input, signal } from "@angular/core";
import { ApiError, api } from "../../core/api";
import type { ProductCard } from "../../core/types";
import { ProductGrid } from "../../shared/product/product";

type Data = { slug: string; title: string; description: string; image_url: string; products: ProductCard[] };

@Component({
  selector: "pc-shop-collections-slug-page",
  imports: [ProductGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (error()) {
      <p class="rounded-xl bg-white p-6 text-ink-soft">{{ error() }}</p>
    } @else if (!data()) {
      <p class="rounded-xl bg-white p-6 text-ink-soft">Loading…</p>
    } @else {
      <div class="flex flex-col gap-4">
        <header class="rounded-xl bg-white p-4 sm:p-5">
          @if (data()!.image_url) { <img [src]="data()!.image_url" alt="" class="mb-3 max-h-48 w-full rounded-lg object-cover" /> }
          <h1 class="text-2xl font-semibold">{{ data()!.title }}</h1>
          @if (data()!.description) { <p class="mt-1 text-ink-soft">{{ data()!.description }}</p> }
        </header>
        @if (data()!.products.length) { <pc-product-grid [items]="data()!.products" [showAdd]="true" /> }
        @else { <p class="rounded-xl bg-white p-6 text-ink-soft">Nothing here yet. Check back soon.</p> }
      </div>
    }
  `,
})
export class ShopCollectionsSlugPage {
  readonly slug = input.required<string>();
  readonly data = signal<Data | null>(null);
  readonly error = signal("");
  constructor() {
    effect(() => {
      const slug = this.slug();
      this.data.set(null);
      this.error.set("");
      api<Data>(`/api/catalog/collections/${slug}`).then((d) => this.data.set(d)).catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load this collection"));
    });
  }
}
