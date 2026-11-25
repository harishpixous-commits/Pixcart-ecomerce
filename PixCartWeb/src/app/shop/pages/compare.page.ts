/* Compare products side by side (picked with "Add to compare"). Port of frontend/src/app/(shop)/compare/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import { Scale, ShoppingCart, X } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import type { ProductCard } from "../../core/types";
import { CompareService } from "../../shared/chrome/compare";
import { DealBadge } from "../../shared/product/product-parts";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { EmptyState, Toast } from "../../shared/ui/ui";

type Item = ProductCard & { specs: Record<string, string>; info: Record<string, string>; return_window_days: number; highlights: string[] };
type Data = { items: Item[]; spec_keys: string[]; info_keys: string[] };

const CELL = "border-b border-line px-3 py-2.5 align-top text-sm";

@Component({
  selector: "pc-shop-compare-page",
  imports: [Icon, PcLink, PageLoader, EmptyState, DealBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!ids()) {
      <pc-empty-state title="Nothing to compare yet" body="Tick “Add to compare” on two to four products, then open the compare tray at the bottom.">
        <a action pcLink="/search" class="rounded-full bg-peacock px-5 py-2 font-semibold text-white">Browse products</a>
      </pc-empty-state>
    } @else if (state().ids !== ids()) {
      <pc-page-loader />
    } @else if (state().error || !state().data) {
      <pc-empty-state title="Could not compare these products" [body]="state().error" [hasAction]="false" />
    } @else {
      <div class="flex flex-col gap-4">
        <header class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 sm:p-5">
          <h1 class="flex items-center gap-2 text-2xl font-semibold"><svg [pcIcon]="Scale" class="h-6 w-6 text-peacock" /> Compare products</h1>
          <label class="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="diffOnly()" (change)="diffOnly.set($any($event.target).checked)" /> Show only differences
          </label>
        </header>
        <div class="overflow-x-auto rounded-xl bg-white" data-testid="compare-table">
          <table class="w-full min-w-[640px] border-collapse">
            <thead>
              <tr>
                <th class="sticky left-0 z-10 w-40 bg-white"></th>
                @for (p of items(); track p.id) {
                  <th class="relative w-56 border-b border-line p-3 text-left align-top font-normal">
                    <button type="button" (click)="remove(p.id)" [attr.aria-label]="'Remove ' + p.title" class="absolute right-2 top-2 rounded-full p-1 text-ink-faint hover:bg-mist hover:text-vermilion"><svg [pcIcon]="X" class="h-4 w-4" /></button>
                    <a [pcLink]="'/p/' + p.slug" class="block">
                      <img [src]="p.image" alt="" class="mx-auto mb-2 aspect-square w-32 rounded-lg object-contain" />
                      <span class="line-clamp-2 text-sm font-medium hover:text-peacock">{{ p.title }}</span>
                    </a>
                    <p class="mt-1 font-display text-lg font-bold">{{ rupees(p.price) }} @if (p.mrp > p.price) {<span class="text-sm font-normal text-ink-faint line-through">{{ rupees(p.mrp) }}</span>}</p>
                    @if (p.deal) {
                      <div class="mt-1"><pc-deal-badge [deal]="p.deal" [discount]="p.discount_pct" /></div>
                    } @else if (p.discount_pct > 0) {
                      <p class="text-sm font-semibold text-leaf">{{ p.discount_pct }}% off</p>
                    }
                    @if (p.rating_count > 0) {<p class="mt-1 text-xs"><span class="rounded bg-leaf px-1.5 font-semibold text-white">{{ p.rating_avg.toFixed(1) }} ★</span>{{ " " }}<span class="text-ink-faint">({{ p.rating_count.toLocaleString("en-IN") }})</span></p>}
                    @if (p.variant_id && p.in_stock) {
                      <button type="button" (click)="add(p)" class="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-marigold py-1.5 text-sm font-semibold text-ink hover:bg-marigold-dark"><svg [pcIcon]="ShoppingCart" class="h-4 w-4" /> Add to cart</button>
                    } @else {
                      <a [pcLink]="'/p/' + p.slug" class="mt-2 block rounded-full border border-line py-1.5 text-center text-sm font-semibold hover:bg-mist">{{ p.in_stock ? "See options" : "Out of stock" }}</a>
                    }
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of shownRows(); track r.label) {
                <tr [class]="differs(r.values) ? 'bg-marigold-light/30' : ''">
                  <th scope="row" [class]="CELL + ' sticky left-0 z-10 bg-mist text-left font-semibold'">{{ r.label }}</th>
                  @for (v of r.values; track $index) {<td [class]="CELL + ' text-ink-soft'">{{ v }}</td>}
                </tr>
              }
              @if (shownRows().length === 0) {<tr><td [attr.colspan]="items().length + 1" class="p-6 text-center text-ink-soft">These products have the same details.</td></tr>}
            </tbody>
          </table>
        </div>
        @if (items().length < 4) {<p class="px-1 text-sm text-ink-soft">You can compare up to 4 products. Tick “Add to compare” on any product.</p>}
      </div>
    }
  `,
})
export class ShopComparePage {
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  private readonly session = inject(SessionService);
  private readonly compare = inject(CompareService);
  private readonly qp = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  protected readonly Scale = Scale;
  protected readonly ShoppingCart = ShoppingCart;
  protected readonly X = X;
  protected readonly CELL = CELL;
  protected readonly rupees = rupees;
  protected readonly ids = computed(() => this.qp().get("ids") ?? "");
  protected readonly state = signal<{ ids: string; data: Data | null; error: string }>({ ids: "", data: null, error: "" });
  protected readonly diffOnly = signal(false);
  protected readonly items = computed(() => this.state().data?.items ?? []);
  private readonly rows = computed(() => {
    const d = this.state().data;
    if (!d) return [];
    const { items, spec_keys, info_keys } = d;
    return [
      ...info_keys.map((k) => ({ label: k, values: items.map((x) => x.info[k] ?? "—") })),
      ...spec_keys.filter((k) => !info_keys.includes(k)).map((k) => ({ label: k, values: items.map((x) => x.specs[k] ?? "—") })),
      { label: "Returns", values: items.map((x) => (x.return_window_days > 0 ? `${x.return_window_days}-day returns` : "Not returnable")) },
      { label: "Sold by", values: items.map((x) => x.seller_name) },
    ];
  });
  protected readonly shownRows = computed(() => (this.diffOnly() ? this.rows().filter((r) => this.differs(r.values)) : this.rows()));

  constructor() {
    effect((onCleanup) => {
      const ids = this.ids();
      if (!ids) return;
      let live = true;
      api<Data>("/api/catalog/compare", { query: { ids } })
        .then((d) => { if (live) this.state.set({ ids, data: d, error: "" }); })
        .catch((e: Error) => { if (live) this.state.set({ ids, data: null, error: e.message }); });
      onCleanup(() => (live = false));
    });
  }

  protected differs(values: string[]) {
    return new Set(values.map((v) => v.trim().toLowerCase())).size > 1;
  }

  protected remove(id: string) {
    this.compare.remove(id);
    const left = this.items().filter((x) => x.id !== id).map((x) => x.id);
    void this.router.navigateByUrl(left.length ? `/compare?ids=${left.join(",")}` : "/compare", { replaceUrl: true });
  }

  protected async add(p: Item) {
    if (!p.variant_id) return;
    try {
      await this.session.addToCart({ variant_id: p.variant_id, qty: 1, title: p.title, image: p.image, price: p.price, mrp: p.mrp, slug: p.slug, variant_label: "", seller_name: p.seller_name });
      this.toast.show("Added to your cart");
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not add to cart", "error");
    }
  }
}
