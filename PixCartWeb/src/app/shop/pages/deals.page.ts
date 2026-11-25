/* Today's Deals: lightning deals, deals of the day, limited time deals, upcoming deals and top discounts, with filters in
 * the address. Port of frontend/src/app/(shop)/deals/page.tsx (+ layout.tsx: the title). */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import { Clock, Percent, SlidersHorizontal, Star, X, Zap, type LucideIconData } from "lucide-angular";
import { api, latestOnly, quietly } from "../../core/api";
import { setPageTitle } from "../../core/brand";
import { currencySymbol, paiseToShown, shownToPaise } from "../../core/format";
import type { ProductCard } from "../../core/types";
import { ProductTileOutlet } from "../../shared/product/product";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Pagination, Select } from "../../shared/ui/ui";
import { navigateKeepScroll } from "../browse/keep-scroll";

type DealsData = {
  items: ProductCard[]; total: number; page: number; page_size: number; tab: "live" | "upcoming" | "discounts"; enabled: boolean;
  facets: { departments?: { name: string; slug: string; count: number }[]; kinds?: Record<string, number>; upcoming?: number };
};

const PILLS: { key: string; label: string; tab: string; kind?: string; icon?: LucideIconData }[] = [
  { key: "all", label: "All deals", tab: "live" },
  { key: "lightning", label: "Lightning deals", tab: "live", kind: "lightning", icon: Zap },
  { key: "deal_of_day", label: "Deal of the Day", tab: "live", kind: "deal_of_day" },
  { key: "limited", label: "Limited time deals", tab: "live", kind: "limited" },
  { key: "upcoming", label: "Upcoming", tab: "upcoming", icon: Clock },
  { key: "discounts", label: "Top discounts", tab: "discounts", icon: Percent },
];

const DISCOUNTS = [["", "Any"], ["10", "10% off or more"], ["25", "25% off or more"], ["50", "50% off or more"], ["70", "70% off or more"]] as const;

@Component({
  selector: "pc-shop-deals-page",
  imports: [NgTemplateOutlet, Icon, PcLink, Pagination, Select, ProductTileOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h1 class="text-2xl font-semibold sm:text-3xl">Today's Deals</h1>
          <p class="text-ink-soft">Lightning deals, deals of the day and limited time offers from verified sellers. Prices change when a deal ends.</p>
        </div>
      </div>
      <nav class="scroll-x -mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Kinds of deals">
        @for (p of PILLS; track p.key) {
          <button type="button" (click)="set({ tab: p.tab === 'live' ? null : p.tab, kind: p.kind ?? null })" [attr.aria-pressed]="activePill() === p.key"
            [class]="activePill() === p.key ? 'flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold border-peacock bg-peacock text-white' : 'flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold border-line bg-white hover:border-peacock'">
            @if (p.icon) {<svg [pcIcon]="p.icon" class="h-4 w-4" />}{{ p.label }}@if (pillCount(p.key) !== undefined) {<span [class]="activePill() === p.key ? 'text-white/80' : 'text-ink-faint'">({{ pillCount(p.key) }})</span>}
          </button>
        }
      </nav>
      <div class="grid gap-4 lg:grid-cols-[230px_1fr]">
        <aside class="hidden self-start rounded-xl bg-white p-4 lg:sticky lg:top-40 lg:block" aria-label="Filters"><ng-container [ngTemplateOutlet]="filters" /></aside>
        <div class="flex min-w-0 flex-col gap-3">
          <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-4 py-2.5">
            <p class="text-sm text-ink-soft">{{ data() ? data()!.total.toLocaleString("en-IN") + " " + (tab() === "upcoming" ? "upcoming deals" : tab() === "discounts" ? "discounted products" : "deals") : "Loading deals…" }}</p>
            <div class="flex items-center gap-2">
              <button type="button" (click)="drawer.set(true)" class="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold lg:hidden"><svg [pcIcon]="SlidersHorizontal" class="h-4 w-4" /> Filters</button>
              @if (tab() !== "upcoming") {
                <label for="deal-sort" class="sr-only">Sort deals</label>
                <select pcSelect id="deal-sort" (change)="sortPicked($event)" class="h-9 w-auto text-sm">
                  <option value="featured" [selected]="sort() === 'featured'">Featured</option>
                  @if (tab() === "live") {<option value="ending" [selected]="sort() === 'ending'">Ending soonest</option>}
                  <option value="discount" [selected]="sort() === 'discount'">Discount: high to low</option>
                  <option value="price_asc" [selected]="sort() === 'price_asc'">Price: low to high</option>
                  <option value="price_desc" [selected]="sort() === 'price_desc'">Price: high to low</option>
                  <option value="rating" [selected]="sort() === 'rating'">Customer rating</option>
                </select>
              }
            </div>
          </div>
          @if (!data()) {
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" aria-busy="true">
              @for (i of SK; track i) {<div class="rounded-xl bg-white p-3"><div class="skeleton mb-3 aspect-square rounded-lg"></div><div class="skeleton mb-2 h-4 rounded"></div><div class="skeleton h-4 w-1/2 rounded"></div></div>}
            </div>
          } @else if (!data()!.enabled && tab() !== "discounts") {
            <div class="rounded-xl bg-white p-8 text-center">
              <p class="text-lg font-semibold">Deals are not running on the store right now</p>
              <button type="button" (click)="set({ tab: 'discounts', kind: null })" class="mt-2 font-semibold text-peacock hover:underline">See the top discounts instead</button>
            </div>
          } @else if (data()!.items.length === 0) {
            <div class="rounded-xl bg-white p-8 text-center">
              <p class="text-lg font-semibold">{{ tab() === "upcoming" ? "No deals are scheduled for the next 7 days" : "No deals match these filters" }}</p>
              <p class="mt-1 text-ink-soft">Try another department or discount, or browse the biggest price drops.</p>
              <div class="mt-3 flex justify-center gap-3">
                <button type="button" (click)="set({ category: null, min_discount: null, min_rating: null, min_price: null, max_price: null, kind: null, tab: null })" class="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:bg-mist">All deals</button>
                <button type="button" (click)="set({ tab: 'discounts', kind: null })" class="rounded-full bg-peacock px-4 py-2 text-sm font-semibold text-white">Top discounts</button>
              </div>
            </div>
          } @else {
            <div class="grid gap-px overflow-hidden rounded-xl bg-line sm:grid-cols-3 xl:grid-cols-4 grid-cols-2" data-testid="deals-grid">
              @for (p of data()!.items; track p.id) {<ng-container [pcProductTile]="p" [quickPlus]="true" />}
            </div>
          }
          @if (data() && data()!.total > data()!.page_size) {<pc-pagination [page]="page()" [pageSize]="data()!.page_size" [total]="data()!.total" (pageChange)="set({ page: '' + $event })" />}
          <p class="px-1 text-xs text-ink-faint">Deal prices are set by sellers and checked by our team. A deal price applies while the timer runs (lightning deals: while units last). <a pcLink="/coupons" class="font-semibold text-peacock">See coupons</a></p>
        </div>
      </div>
      @if (drawer()) {
        <div class="fixed inset-0 z-[60] flex lg:hidden" role="dialog" aria-modal="true" aria-label="Filters">
          <div class="absolute inset-0 bg-ink/50" (click)="drawer.set(false)"></div>
          <div class="relative ml-auto h-full w-[85%] max-w-sm overflow-y-auto bg-white p-5">
            <div class="mb-4 flex items-center justify-between"><p class="text-lg font-semibold">Filters</p><button type="button" (click)="drawer.set(false)" aria-label="Close filters"><svg [pcIcon]="X" class="h-5 w-5" /></button></div>
            <ng-container [ngTemplateOutlet]="filters" />
            <button type="button" (click)="drawer.set(false)" class="mt-6 w-full rounded-full bg-peacock py-2.5 font-semibold text-white">Show results</button>
          </div>
        </div>
      }
    </div>

    <ng-template #filters>
      <div class="flex flex-col gap-5 text-[15px]">
        @if ((data()?.facets?.departments?.length ?? 0) > 0) {
          <fieldset>
            <legend class="mb-2 font-semibold">Department</legend>
            @for (d of departments(); track d.slug || "all") {
              <label class="flex cursor-pointer items-center gap-2 py-1">
                <input type="radio" name="dept" class="accent-peacock" [checked]="category() === d.slug" (change)="set({ category: d.slug || null })" />
                <span>{{ d.name }}</span>@if (d.count > 0) {<span class="text-xs text-ink-faint">({{ d.count }})</span>}
              </label>
            }
          </fieldset>
        }
        <fieldset>
          <legend class="mb-2 font-semibold">Discount</legend>
          @for (o of DISCOUNTS; track o[0] || "any") {
            <label class="flex cursor-pointer items-center gap-2 py-1">
              <input type="radio" name="disc" class="accent-peacock" [checked]="minDiscount() === o[0]" (change)="set({ min_discount: o[0] || null })" /> {{ o[1] }}
            </label>
          }
        </fieldset>
        <fieldset>
          <legend class="mb-2 font-semibold">Customer reviews</legend>
          <label class="flex cursor-pointer items-center gap-2 py-1">
            <input type="checkbox" class="accent-peacock" [checked]="minRating() === '4'" (change)="set({ min_rating: $any($event.target).checked ? '4' : null })" />
            <span class="flex items-center gap-0.5 text-marigold">@for (n of [1, 2, 3, 4]; track n) {<svg [pcIcon]="Star" class="h-4 w-4 fill-current" />}<svg [pcIcon]="Star" class="h-4 w-4" /></span>
            <span>&amp; up</span>
          </label>
        </fieldset>
        <fieldset>
          <legend class="mb-2 font-semibold">Price</legend>
          <form class="flex items-center gap-2" (submit)="applyPrice($event)">
            <input inputmode="numeric" aria-label="Minimum price" [placeholder]="sym + ' Min'" [value]="price().min" (input)="priceInput($event, 'min')" class="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
            <span>to</span>
            <input inputmode="numeric" aria-label="Maximum price" [placeholder]="sym + ' Max'" [value]="price().max" (input)="priceInput($event, 'max')" class="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
            <button type="submit" class="h-9 rounded-md border border-line px-3 font-semibold hover:bg-mist">Go</button>
          </form>
        </fieldset>
        @if (category() || minDiscount() || minRating() || params().get("min_price") || params().get("max_price")) {
          <button type="button" (click)="clearFilters()" class="self-start text-sm font-semibold text-peacock hover:underline">Clear all filters</button>
        }
      </div>
    </ng-template>
  `,
})
export class ShopDealsPage {
  private readonly router = inject(Router);
  private readonly qp = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  protected readonly PILLS = PILLS;
  protected readonly DISCOUNTS = DISCOUNTS;
  protected readonly SK = [0, 1, 2, 3, 4, 5, 6, 7];
  protected readonly Star = Star;
  protected readonly X = X;
  protected readonly SlidersHorizontal = SlidersHorizontal;
  protected readonly sym = currencySymbol();
  protected readonly data = signal<DealsData | null>(null);
  protected readonly drawer = signal(false);
  private readonly track = latestOnly();
  protected readonly params = computed(() => {
    const m = this.qp();
    const u = new URLSearchParams();
    for (const k of m.keys) for (const v of m.getAll(k)) u.append(k, v);
    return u;
  });
  private readonly key = computed(() => this.params().toString());
  protected readonly tab = computed(() => this.params().get("tab") ?? "live");
  protected readonly kind = computed(() => this.params().get("kind") ?? "");
  protected readonly category = computed(() => this.params().get("category") ?? "");
  protected readonly minDiscount = computed(() => this.params().get("min_discount") ?? "");
  protected readonly minRating = computed(() => this.params().get("min_rating") ?? "");
  protected readonly sort = computed(() => this.params().get("sort") ?? "featured");
  protected readonly page = computed(() => Number(this.params().get("page") ?? 1));
  protected readonly price = signal({ min: "", max: "" });
  protected readonly activePill = computed(() => (this.tab() === "upcoming" ? "upcoming" : this.tab() === "discounts" ? "discounts" : this.kind() || "all"));
  protected readonly departments = computed(() => [{ name: "All", slug: "", count: 0 }, ...(this.data()?.facets.departments ?? [])]);

  constructor() {
    setPageTitle("Today's Deals");
    const p = this.params();
    this.price.set({ min: p.get("min_price") ? paiseToShown(Number(p.get("min_price"))) : "", max: p.get("max_price") ? paiseToShown(Number(p.get("max_price"))) : "" });
    effect(() => {
      const q = new URLSearchParams(this.key());
      untracked(() => {
        this.track(api<DealsData>("/api/catalog/deals", {
          query: { tab: q.get("tab") ?? "live", kind: q.get("kind") || undefined, category: q.get("category") || undefined, min_discount: q.get("min_discount") || undefined,
            min_rating: q.get("min_rating") || undefined, min_price: q.get("min_price") || undefined, max_price: q.get("max_price") || undefined,
            sort: q.get("sort") ?? "featured", page: q.get("page") ?? 1 },
        }), (d) => this.data.set(d)).catch(quietly);
      });
    });
  }

  protected pillCount(k: string): number | undefined {
    const kinds = this.data()?.facets.kinds ?? {};
    return k === "upcoming" ? this.data()?.facets.upcoming : k in kinds ? kinds[k] : undefined;
  }

  protected set(changes: Record<string, string | null>) {
    const q = new URLSearchParams(this.key());
    for (const [k, v] of Object.entries(changes)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    if (!("page" in changes)) q.delete("page");
    navigateKeepScroll(this.router, `${location.pathname}?${q.toString()}`);
  }

  protected sortPicked(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    this.set({ sort: v === "featured" ? null : v });
  }

  protected priceInput(e: Event, which: "min" | "max") {
    const el = e.target as HTMLInputElement;
    const v = el.value.replace(/[^\d.]/g, "");
    el.value = v;
    this.price.update((p) => ({ ...p, [which]: v }));
  }

  protected applyPrice(e: Event) {
    e.preventDefault();
    const { min, max } = this.price();
    this.set({ min_price: min ? String(shownToPaise(min) ?? "") || null : null, max_price: max ? String(shownToPaise(max) ?? "") || null : null });
    this.drawer.set(false);
  }

  protected clearFilters() {
    this.price.set({ min: "", max: "" });
    this.set({ category: null, min_discount: null, min_rating: null, min_price: null, max_price: null });
  }
}
