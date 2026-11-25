/* A seller's store: its banner, then its products in the search view. Port of frontend/src/app/(shop)/store/[slug]/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from "@angular/core";
import { api } from "../../core/api";
import { date } from "../../core/format";
import { SiteService } from "../../core/site";
import { ShopNotFound } from "../../shared/chrome/not-found-pages";
import { ShopRouteSkeleton } from "../../shared/ui/skeletons";
import { keepPageTitle } from "../browse/page-title";
import { SearchView } from "../browse/search-view";

type Store = { name: string; slug: string; description: string; city: string; state: string; since: string | null; product_count: number };

@Component({
  selector: "pc-shop-store-slug-page",
  imports: [SearchView, ShopNotFound, ShopRouteSkeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (state() === "missing") {
      <pc-shop-not-found />
    } @else if (store(); as s) {
      <div class="flex flex-col gap-4">
        <section class="rounded-xl bg-peacock p-6 text-white">
          <h1 class="text-3xl font-bold">{{ s.name }}</h1>
          <p class="text-white/80">{{ s.city }}, {{ s.state }}{{ s.since ? ". Selling on " + brand() + " since " + fmtDate(s.since) : "" }}. {{ s.product_count }} products.</p>
          @if (s.description) {<p class="mt-2 max-w-2xl text-white/90">{{ s.description }}</p>}
        </section>
        <pc-search-view [seller]="s.slug" />
      </div>
    } @else {
      <pc-shop-route-skeleton />
    }
  `,
})
export class ShopStoreSlugPage {
  readonly slug = input.required<string>();
  protected readonly store = signal<Store | null>(null);
  protected readonly state = signal<"loading" | "ready" | "missing">("loading");
  private readonly site = inject(SiteService).site;
  protected readonly brand = () => this.site().brand_name;
  protected readonly fmtDate = date;

  constructor() {
    keepPageTitle(() => (this.store() ? `${this.store()!.name} store` : this.state() === "missing" ? "Store" : null));
    effect(() => {
      const slug = this.slug();
      untracked(() => {
        this.store.set(null);
        this.state.set("loading");
      });
      api<Store>(`/api/catalog/stores/${encodeURIComponent(slug)}`)
        .then((s) => {
          if (slug !== this.slug()) return;
          this.store.set(s);
          this.state.set("ready");
        })
        .catch(() => {
          if (slug !== this.slug()) return;
          this.state.set("missing");
        });
    });
  }
}
