/*
 * Search, category and store results. Filters sit in a left column or in a bar on top with drop-downs (the theme's
 * "filters" layout option); the results follow the theme's product grid. Every filter lives in the address, so a
 * filtered page can be shared, bookmarked and reloaded. Port of components/search-view.tsx:
 *   <pc-search-view [category]="slug" />   <pc-search-view [seller]="slug" />   <pc-search-view />
 */

import { NgTemplateOutlet } from "@angular/common";
import {
  ChangeDetectionStrategy, Component, ElementRef, TemplateRef, computed, contentChild, effect, inject, input, output, signal, untracked,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import { ChevronDown, MapPin, SlidersHorizontal, Truck, X, Zap } from "lucide-angular";
import { api, latestOnly } from "../../core/api";
import { currencySymbol, paiseToShown, rupees, shownToPaise } from "../../core/format";
import { PincodeService, isPincode, setPincode } from "../../core/pincode";
import type { ProductCard, SearchResult } from "../../core/types";
import { CompareToggle } from "../../shared/chrome/compare";
import { GridFrame, ProductRail, ProductTileOutlet } from "../../shared/product/product";
import { SaveSearchButton } from "../../shared/shop/save-search";
import { closeOnOutside } from "../../shared/shop/shop-chrome";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { ListingSkeleton } from "../../shared/ui/skeletons";
import { Button, EmptyState, Modal, Pagination, Select } from "../../shared/ui/ui";
import { ThemeService } from "../../themes/context";
import { navigateKeepScroll } from "./keep-scroll";

export type Result = SearchResult & { sponsored?: ProductCard[]; sponsored_rail?: ProductCard[]; categories?: { name: string; slug: string; count: number }[] };
/** Query changes applied together in one navigation; null removes the parameter. */
export type QueryChanges = Record<string, string | string[] | null>;
export type FilterProps = { data: Result; params: URLSearchParams; set: (changes: QueryChanges) => void; inCategory: boolean };

const SORTS = [
  ["relevance", "Featured"],
  ["popular", "Best sellers"],
  ["price_asc", "Price: low to high"],
  ["price_desc", "Price: high to low"],
  ["rating", "Avg. customer review"],
  ["newest", "Newest arrivals"],
  ["discount", "Biggest discount"],
] as const;

const DELIVERY = [["1", "Get it by tomorrow"], ["2", "Get it in 2 days"], ["4", "Get it in 4 days"]] as const;

@Component({
  selector: "pc-pin-inline",
  imports: [Icon, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form class="flex flex-col gap-1" (submit)="submit($event)">
      <span class="flex items-center gap-1 text-sm text-ink-soft"><svg [pcIcon]="MapPin" class="h-4 w-4" /> Enter your PIN code to see delivery days</span>
      <span class="flex gap-2">
        <input inputmode="numeric" maxlength="6" [value]="v()" (input)="onInput($event)" aria-label="PIN code" placeholder="PIN code" class="h-9 w-28 rounded-md border border-line px-2" />
        <button pcButton size="sm" type="submit" variant="secondary">Apply</button>
      </span>
      @if (err()) {<span class="text-xs text-vermilion">{{ err() }}</span>}
    </form>
  `,
})
export class PinInline {
  protected readonly MapPin = MapPin;
  protected readonly v = signal("");
  protected readonly err = signal("");
  protected onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const v = el.value.replace(/\D/g, "");
    el.value = v;
    this.v.set(v);
    this.err.set("");
  }
  protected submit(e: Event) {
    e.preventDefault();
    if (!isPincode(this.v())) return this.err.set("Enter a 6-digit PIN code");
    setPincode(this.v());
  }
}

/* ---------------------------------------------------------------- filter sections (used by the column, the drawer and the bar) */

@Component({
  selector: "pc-delivery-filter",
  imports: [PinInline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!pin()) {
      <pc-pin-inline />
    } @else {
      <div class="flex flex-col">
        @for (d of DELIVERY; track d[0]) {
          <label class="flex cursor-pointer items-center gap-2 py-0.5">
            <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="fp().params.get('delivery') === d[0]" (change)="fp().set({ delivery: $any($event.target).checked ? d[0] : null })" /> {{ d[1] }}
          </label>
        }
        <p class="mt-1 text-xs text-ink-faint">To PIN {{ pin() }}</p>
      </div>
    }
  `,
})
export class DeliveryFilter {
  readonly fp = input.required<FilterProps>();
  protected readonly pin = inject(PincodeService).pin;
  protected readonly DELIVERY = DELIVERY;
}

@Component({
  selector: "pc-department-filter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-1" },
  template: `
    @for (c of fp().data.categories ?? []; track c.slug) {
      <button type="button" (click)="fp().set({ category: fp().params.get('category') === c.slug ? null : c.slug })"
        [class]="fp().params.get('category') === c.slug ? 'text-left text-[15px] hover:text-peacock font-semibold text-peacock' : 'text-left text-[15px] hover:text-peacock'">
        {{ c.name }} <span class="text-ink-faint">({{ c.count }})</span>
      </button>
    }
  `,
})
export class DepartmentFilter {
  readonly fp = input.required<FilterProps>();
}

@Component({
  selector: "pc-brand-filter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex max-h-64 flex-col gap-1.5 overflow-y-auto" },
  template: `
    @for (b of fp().data.facets.brands; track b.name) {
      <label class="flex cursor-pointer items-center gap-2 text-[15px]">
        <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="brands().includes(b.name)" (change)="toggle(b.name, $any($event.target).checked)" />
        {{ b.name }} <span class="text-ink-faint">({{ b.count }})</span>
      </label>
    }
  `,
})
export class BrandFilter {
  readonly fp = input.required<FilterProps>();
  protected readonly brands = computed(() => this.fp().params.getAll("brand"));
  protected toggle(name: string, on: boolean) {
    const brands = this.brands();
    this.fp().set({ brand: on ? [...brands, name] : brands.filter((x) => x !== name) });
  }
}

@Component({
  selector: "pc-price-filter",
  imports: [Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <form class="flex items-center gap-2" (submit)="submit($event)">
      <input aria-label="Minimum price" inputmode="decimal" [value]="min()" (input)="min.set($any($event.target).value)" [placeholder]="'Min ' + sym" class="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
      <span class="text-ink-faint">to</span>
      <input aria-label="Maximum price" inputmode="decimal" [value]="max()" (input)="max.set($any($event.target).value)" [placeholder]="'Max ' + sym" class="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
      <button pcButton size="sm" type="submit">Go</button>
    </form>
    @if (fp().data.facets.price_max > 0) {
      <p class="mt-1 text-xs text-ink-faint">From {{ rupees(fp().data.facets.price_min) }} to {{ rupees(fp().data.facets.price_max) }}</p>
    }
  `,
})
export class PriceFilter {
  readonly fp = input.required<FilterProps>();
  protected readonly min = signal("");
  protected readonly max = signal("");
  protected readonly sym = currencySymbol();
  protected readonly rupees = rupees;
  ngOnInit() {
    const p = this.fp().params;
    this.min.set(p.get("min_price") ? paiseToShown(Number(p.get("min_price"))) : "");
    this.max.set(p.get("max_price") ? paiseToShown(Number(p.get("max_price"))) : "");
  }
  protected submit(e: Event) {
    e.preventDefault();
    const lo = this.min() ? shownToPaise(this.min()) : null;
    const hi = this.max() ? shownToPaise(this.max()) : null;
    this.fp().set({ min_price: lo !== null ? String(lo) : null, max_price: hi !== null ? String(hi) : null });
  }
}

@Component({
  selector: "pc-rating-filter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col" },
  template: `
    @for (r of ["4", "3"]; track r) {
      <label class="flex cursor-pointer items-center gap-2 py-0.5">
        <input type="radio" name="rating" class="accent-peacock" [checked]="fp().params.get('min_rating') === r" (change)="fp().set({ min_rating: r })" />
        {{ r }}★ &amp; up
      </label>
    }
  `,
})
export class RatingFilter {
  readonly fp = input.required<FilterProps>();
}

@Component({
  selector: "pc-discount-filter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col" },
  template: `
    @for (d of ["10", "25", "50", "70"]; track d) {
      <label class="flex cursor-pointer items-center gap-2 py-0.5">
        <input type="radio" name="discount" class="accent-peacock" [checked]="fp().params.get('min_discount') === d" (change)="fp().set({ min_discount: d })" />
        {{ d }}% off or more
      </label>
    }
  `,
})
export class DiscountFilter {
  readonly fp = input.required<FilterProps>();
}

/** Every filter stacked: the left column, and the Filters drawer. */
@Component({
  selector: "pc-filters",
  imports: [Icon, DeliveryFilter, DepartmentFilter, BrandFilter, PriceFilter, RatingFilter, DiscountFilter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-6" },
  template: `
    <fieldset class="min-w-0">
      <legend class="mb-2 flex items-center gap-1.5 font-semibold"><svg [pcIcon]="Truck" class="h-4 w-4 text-peacock" /> Delivery day</legend>
      <pc-delivery-filter [fp]="fp()" />
    </fieldset>
    <label class="flex cursor-pointer items-center gap-2 font-semibold">
      <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="fp().params.get('deal') === 'true'" (change)="fp().set({ deal: $any($event.target).checked ? 'true' : null })" />
      <svg [pcIcon]="Zap" class="h-4 w-4 text-vermilion" /> Today's deals
    </label>
    @if (!fp().inCategory && (fp().data.categories?.length ?? 0) > 0) {
      <fieldset class="min-w-0">
        <legend class="mb-2 font-semibold">Department</legend>
        <pc-department-filter [fp]="fp()" />
      </fieldset>
    }
    @if (fp().data.facets.brands.length > 0) {
      <fieldset class="min-w-0">
        <legend class="mb-2 font-semibold">Brand</legend>
        <pc-brand-filter [fp]="fp()" />
      </fieldset>
    }
    <fieldset class="min-w-0">
      <legend class="mb-2 font-semibold">Price</legend>
      <pc-price-filter [fp]="fp()" />
    </fieldset>
    <fieldset class="min-w-0">
      <legend class="mb-2 font-semibold">Customer reviews</legend>
      <pc-rating-filter [fp]="fp()" />
    </fieldset>
    <fieldset class="min-w-0">
      <legend class="mb-2 font-semibold">Discount</legend>
      <pc-discount-filter [fp]="fp()" />
    </fieldset>
    <label class="flex cursor-pointer items-center gap-2">
      <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="fp().params.get('in_stock') === 'true'" (change)="fp().set({ in_stock: $any($event.target).checked ? 'true' : null })" />
      Hide out of stock items
    </label>
  `,
})
export class Filters {
  readonly fp = input.required<FilterProps>();
  protected readonly Truck = Truck;
  protected readonly Zap = Zap;
}

/* ---------------------------------------------------------------- the bar on top */

/**
 * A filter button with a drop-down panel (closes on Escape, a click outside, or choosing). The panel's content is an
 * <ng-template>, created each time the panel opens (as the reference mounts it).
 */
@Component({
  selector: "pc-filter-menu",
  imports: [Icon, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative shrink-0" },
  template: `
    <button type="button" (click)="open.set(!open())" [attr.aria-expanded]="open()" aria-haspopup="true"
      [class]="active() ? 'pc-press flex h-9 items-center gap-1 rounded-full border px-3 text-sm font-medium border-peacock bg-peacock-light text-peacock' : 'pc-press flex h-9 items-center gap-1 rounded-full border px-3 text-sm font-medium border-line bg-white text-ink hover:border-ink/40'">
      {{ label() }}<svg [pcIcon]="ChevronDown" [class]="open() ? 'h-4 w-4 transition-transform rotate-180' : 'h-4 w-4 transition-transform'" />
    </button>
    @if (open()) {
      <div class="absolute left-0 top-11 z-30 w-72 max-w-[calc(100vw-2rem)] animate-rise-in rounded-xl bg-white p-4 text-[15px] shadow-xl ring-1 ring-line" (click)="panelClick($event)">
        <ng-container [ngTemplateOutlet]="content() ?? null" />
      </div>
    }
  `,
})
export class FilterMenu {
  readonly label = input.required<string>();
  readonly active = input(false);
  protected readonly content = contentChild(TemplateRef);
  protected readonly open = signal(false);
  protected readonly ChevronDown = ChevronDown;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  constructor() {
    closeOnOutside(() => this.open(), () => this.open.set(false), () => this.host);
  }
  protected panelClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest("input[type=radio],input[type=checkbox],button[type=button]")) setTimeout(() => this.open.set(false), 120);
  }
}

@Component({
  selector: "pc-toggle-chip",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button type="button" [attr.aria-pressed]="on()" (click)="toggle.emit(!on())"
      [class]="on() ? 'pc-press flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium border-peacock bg-peacock text-white' : 'pc-press flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium border-line bg-white text-ink hover:border-ink/40'">
      @if (icon()) {<svg [pcIcon]="icon()!" class="h-4 w-4" />}{{ label() }}
    </button>
  `,
})
export class ToggleChip {
  readonly label = input.required<string>();
  readonly on = input(false);
  readonly icon = input<typeof Zap | null>(null);
  readonly toggle = output<boolean>();
}

@Component({
  selector: "pc-filter-bar",
  imports: [Icon, NgTemplateOutlet, FilterMenu, ToggleChip, DeliveryFilter, DepartmentFilter, BrandFilter, PriceFilter, RatingFilter, DiscountFilter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-center gap-2", "aria-label": "Filters", role: "toolbar" },
  template: `
    <div class="scroll-x flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 sm:overflow-visible sm:flex-wrap">
      <button type="button" (click)="all.emit()" class="pc-press flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-ink bg-ink px-3 text-sm font-semibold text-white hover:bg-ink/90">
        <svg [pcIcon]="SlidersHorizontal" class="h-4 w-4" /> Filters{{ count() ? " (" + count() + ")" : "" }}
      </button>
      <pc-toggle-chip label="Today's deals" [on]="fp().params.get('deal') === 'true'" (toggle)="fp().set({ deal: $event ? 'true' : null })" [icon]="Zap" />
      <span class="hidden sm:contents">
        <pc-filter-menu label="Delivery day" [active]="!!fp().params.get('delivery')"><ng-template><pc-delivery-filter [fp]="fp()" /></ng-template></pc-filter-menu>
        @if (!fp().inCategory && (fp().data.categories?.length ?? 0) > 0) {
          <pc-filter-menu label="Department" [active]="!!fp().params.get('category')"><ng-template><pc-department-filter [fp]="fp()" /></ng-template></pc-filter-menu>
        }
        @if (fp().data.facets.brands.length > 0) {
          <pc-filter-menu label="Brand" [active]="fp().params.getAll('brand').length > 0"><ng-template><pc-brand-filter [fp]="fp()" /></ng-template></pc-filter-menu>
        }
        <pc-filter-menu label="Price" [active]="!!(fp().params.get('min_price') || fp().params.get('max_price'))"><ng-template><pc-price-filter [fp]="fp()" /></ng-template></pc-filter-menu>
        <pc-filter-menu label="Reviews" [active]="!!fp().params.get('min_rating')"><ng-template><pc-rating-filter [fp]="fp()" /></ng-template></pc-filter-menu>
        <pc-filter-menu label="Discount" [active]="!!fp().params.get('min_discount')"><ng-template><pc-discount-filter [fp]="fp()" /></ng-template></pc-filter-menu>
        <pc-toggle-chip label="In stock" [on]="fp().params.get('in_stock') === 'true'" (toggle)="fp().set({ in_stock: $event ? 'true' : null })" />
      </span>
    </div>
    <div class="shrink-0"><ng-container [ngTemplateOutlet]="sort()" /></div>
  `,
})
export class FilterBar {
  readonly fp = input.required<FilterProps>();
  readonly count = input(0);
  readonly sort = input.required<TemplateRef<unknown>>();
  readonly all = output<void>();
  protected readonly SlidersHorizontal = SlidersHorizontal;
  protected readonly Zap = Zap;
}

/* ---------------------------------------------------------------- results */

@Component({
  selector: "pc-result-grid",
  imports: [GridFrame, ProductTileOutlet, CompareToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-grid-frame [dense]="!wide()" testid="search-results">
      @for (p of items(); track p.id + "-" + $index) {
        <div [class]="hairline() ? 'flex flex-col bg-white' : 'flex flex-col'">
          <div class="flex-1"><ng-container [pcProductTile]="p" [showAdd]="true" /></div>
          <div [class]="hairline() ? 'px-3 pb-3 sm:px-4' : 'pt-1.5'"><pc-compare-toggle [item]="{ id: p.id, slug: p.slug, title: p.title, image: p.image }" /></div>
        </div>
      }
    </pc-grid-frame>
  `,
})
export class ResultGrid {
  readonly items = input.required<ProductCard[]>();
  readonly wide = input(false);
  private readonly layout = inject(ThemeService).layout;
  protected readonly hairline = computed(() => this.layout().productGrid === "hairline");
}

@Component({
  selector: "pc-filter-chip",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "inline-flex items-center gap-1 rounded-full bg-peacock-light py-1 pl-3 pr-1 text-peacock" },
  template: `
    {{ label() }}
    <button type="button" (click)="clear.emit()" [attr.aria-label]="'Remove filter ' + label()" class="rounded-full p-0.5 hover:bg-white"><svg [pcIcon]="X" class="h-3.5 w-3.5" /></button>
  `,
})
export class Chip {
  readonly label = input.required<string>();
  readonly clear = output<void>();
  protected readonly X = X;
}

@Component({
  selector: "pc-search-view",
  imports: [
    NgTemplateOutlet, Icon, PcLink, Filters, FilterBar, ResultGrid, Chip, ProductRail, ListingSkeleton, Button, EmptyState, Modal, Pagination, Select, SaveSearchButton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (error() && error()!.key === fetchKey()) {
      <pc-empty-state title="Search is unavailable right now" [body]="error()!.message" [hasAction]="false" />
    } @else if (!data()) {
      <pc-listing-skeleton />
    } @else {
      <div class="flex flex-col gap-3">
        @if (data()!.breadcrumbs.length > 0) {
          <nav class="text-sm text-ink-faint" aria-label="Breadcrumb">
            <a pcLink="/" class="hover:text-peacock">Home</a>
            @for (b of data()!.breadcrumbs; track b.slug) {<span> › <a [pcLink]="'/c/' + b.slug" class="hover:text-peacock">{{ b.name }}</a></span>}
          </nav>
        }
        @if (topbar()) {
          <div class="flex min-w-0 flex-col gap-3">
            <div class="shop-panel shop-panel-pad px-4 py-3"><ng-container [ngTemplateOutlet]="titleTpl" /></div>
            @for (k of [priceKey()]; track k) {
              <pc-filter-bar [fp]="fp()" [count]="activeCount()" (all)="showFilters.set(true)" [sort]="sortTpl" />
            }
            <ng-container [ngTemplateOutlet]="chipsTpl" />
            <ng-container [ngTemplateOutlet]="bodyTpl" />
          </div>
        } @else {
          <div class="grid gap-4 lg:grid-cols-[250px_1fr]">
            <aside class="hidden self-start rounded-xl bg-white p-4 lg:sticky lg:top-40 lg:block" aria-label="Filters">
              <h2 class="mb-4 text-lg font-semibold">Filters</h2>
              @for (k of [priceKey()]; track k) {<pc-filters [fp]="fp()" />}
            </aside>
            <div class="flex min-w-0 flex-col gap-3">
              <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-3">
                <ng-container [ngTemplateOutlet]="titleTpl" />
                <div class="flex items-center gap-2">
                  <button pcButton variant="secondary" size="sm" class="lg:hidden" (click)="showFilters.set(true)">
                    <svg [pcIcon]="SlidersHorizontal" class="h-4 w-4" /> Filters{{ activeFilters() ? " (on)" : "" }}
                  </button>
                  <ng-container [ngTemplateOutlet]="sortTpl" />
                </div>
              </div>
              @if (showDepartments()) {
                <div class="scroll-x flex gap-2 overflow-x-auto" aria-label="Departments">
                  @for (c of data()!.categories!; track c.slug) {
                    <button type="button" (click)="set({ category: params().get('category') === c.slug ? null : c.slug })" [attr.aria-pressed]="params().get('category') === c.slug"
                      [class]="params().get('category') === c.slug ? 'shrink-0 rounded-full border px-3 py-1 text-sm border-peacock bg-peacock text-white' : 'shrink-0 rounded-full border px-3 py-1 text-sm border-line bg-white hover:border-peacock'">
                      {{ c.name }} <span [class]="params().get('category') === c.slug ? 'text-white/80' : 'text-ink-faint'">({{ c.count }})</span>
                    </button>
                  }
                </div>
              }
              <ng-container [ngTemplateOutlet]="chipsTpl" />
              <ng-container [ngTemplateOutlet]="bodyTpl" />
            </div>
          </div>
        }
        <pc-modal [open]="showFilters()" (close)="showFilters.set(false)" title="Filters">
          @for (k of [priceKey()]; track k) {<pc-filters [fp]="drawerFp()" />}
        </pc-modal>
      </div>
    }

    <ng-template #sortTpl>
      <label class="sr-only" for="sort">Sort by</label>
      <select pcSelect id="sort" (change)="set({ sort: $any($event.target).value })" class="h-9 w-auto text-sm">
        @for (s of SORTS; track s[0]) {<option [value]="s[0]" [selected]="s[0] === sortValue()">Sort by: {{ s[1] }}</option>}
      </select>
    </ng-template>

    <ng-template #titleTpl>
      <div class="min-w-0">
        @if (heading()) {<h1 class="text-2xl font-semibold">{{ heading() }}</h1>}
        <p [class]="heading() ? 'text-sm text-ink-faint' : 'text-[15px]'" data-testid="results-count">
          {{ countText() }}@if (q()) { for <span class="font-semibold text-vermilion">&ldquo;{{ q() }}&rdquo;</span>}
        </p>
        @if (q()) {<pc-save-search-button [query]="q()!" [maxPaise]="maxPaiseParam()" />}
      </div>
    </ng-template>

    <ng-template #chipsTpl>
      @if (activeFilters()) {
        <div class="flex flex-wrap items-center gap-2 text-sm">
          @if (params().get("deal")) {<pc-filter-chip label="Today's deals" (clear)="set({ deal: null })" />}
          @if (params().get("delivery")) {<pc-filter-chip [label]="params().get('delivery') === '1' ? 'Get it by tomorrow' : 'Get it in ' + params().get('delivery') + ' days'" (clear)="set({ delivery: null })" />}
          @if (!category() && params().get("category")) {<pc-filter-chip [label]="departmentName()" (clear)="set({ category: null })" />}
          @for (b of params().getAll("brand"); track b) {<pc-filter-chip [label]="b" (clear)="removeBrand(b)" />}
          @if (priceLabel()) {<pc-filter-chip [label]="priceLabel()!" (clear)="set({ min_price: null, max_price: null })" />}
          @if (params().get("min_rating")) {<pc-filter-chip [label]="params().get('min_rating') + '★ & up'" (clear)="set({ min_rating: null })" />}
          @if (params().get("min_discount")) {<pc-filter-chip [label]="params().get('min_discount') + '% off or more'" (clear)="set({ min_discount: null })" />}
          @if (params().get("in_stock")) {<pc-filter-chip label="In stock" (clear)="set({ in_stock: null })" />}
          <button type="button" (click)="clearAll()" class="font-semibold text-peacock hover:underline">Clear all</button>
        </div>
      }
    </ng-template>

    <ng-template #bodyTpl>
      @if (results().length === 0) {
        @if (activeFilters()) {
          <pc-empty-state title="No products match" body="Try removing a filter or two.">
            <button pcButton action variant="secondary" (click)="clearAll()">Clear filters</button>
          </pc-empty-state>
        } @else {
          <pc-empty-state title="No products match" body="Try a different word, or browse the categories above." [hasAction]="false" />
        }
      } @else {
        <pc-result-grid [items]="results()" [wide]="topbar()" />
      }
      <pc-pagination [page]="data()!.page" [pageSize]="data()!.page_size" [total]="data()!.total" (pageChange)="set({ page: '' + $event })" />
      @if (data()!.page === 1 && railItems().length > 0) {
        <pc-product-rail [title]="q() ? 'Sponsored products related to your search' : 'Sponsored products'" [items]="railItems()" note="Sponsored" />
      }
    </ng-template>
  `,
})
export class SearchView {
  readonly category = input<string | undefined>(undefined);
  readonly seller = input<string | undefined>(undefined);
  private readonly router = inject(Router);
  private readonly qp = toSignal(inject(ActivatedRoute).queryParamMap, { requireSync: true });
  private readonly pin = inject(PincodeService).pin;
  private readonly layout = inject(ThemeService).layout;
  protected readonly SORTS = SORTS;
  protected readonly SlidersHorizontal = SlidersHorizontal;
  protected readonly topbar = computed(() => this.layout().listing.filters === "topbar");
  protected readonly data = signal<Result | null>(null);
  protected readonly error = signal<{ key: string; message: string } | null>(null);
  protected readonly showFilters = signal(false);
  private readonly track = latestOnly();

  /** the query string as URLSearchParams (useSearchParams) */
  protected readonly params = computed(() => {
    const m = this.qp();
    const u = new URLSearchParams();
    for (const k of m.keys) for (const v of m.getAll(k)) u.append(k, v);
    return u;
  });
  private readonly key = computed(() => this.params().toString());
  protected readonly fetchKey = computed(() => `${this.key()}|${this.category() ?? ""}|${this.seller() ?? ""}|${this.pin()}`);

  protected readonly q = computed(() => this.params().get("q"));
  protected readonly maxPaiseParam = computed(() => this.paise(this.params().get("max_price")));
  protected readonly sortValue = computed(() => this.params().get("sort") ?? "relevance");
  protected readonly heading = computed(() => this.data()?.category?.name ?? (this.seller() ? "Products from this store" : this.q() ? null : "All products"));
  protected readonly countText = computed(() => {
    const d = this.data()!;
    const from = d.total ? (d.page - 1) * d.page_size + 1 : 0;
    const to = Math.min(d.total, d.page * d.page_size);
    return d.total ? `${from}-${to} of ${d.total.toLocaleString("en-IN")} results` : "No results";
  });
  protected readonly activeCount = computed(() => {
    const keys = ["brand", "min_price", "max_price", "min_rating", "min_discount", "in_stock", "deal", "delivery", ...(this.category() ? [] : ["category"])];
    return keys.filter((k) => this.params().get(k)).length;
  });
  protected readonly activeFilters = computed(() => this.activeCount() > 0);
  protected readonly results = computed(() => {
    const d = this.data()!;
    const sponsored = d.page === 1 ? d.sponsored ?? [] : [];
    const seen = new Set(sponsored.map((p) => p.id));
    return [...sponsored, ...d.items.filter((p) => !seen.has(p.id))];
  });
  protected readonly railItems = computed(() => {
    const shown = new Set(this.results().map((p) => p.id));
    return (this.data()!.sponsored_rail ?? []).filter((p) => !shown.has(p.id));
  });
  private paise(v: string | null) {
    return v && /^\d+$/.test(v) ? Number(v) : null;
  }
  protected readonly priceLabel = computed(() => {
    const lo = this.paise(this.params().get("min_price"));
    const hi = this.paise(this.params().get("max_price"));
    return lo !== null && hi !== null ? `${rupees(lo)} to ${rupees(hi)}` : lo !== null ? `${rupees(lo)} and above` : hi !== null ? `Up to ${rupees(hi)}` : null;
  });
  /** the price boxes start again from the applied range when a chip or Clear all changes it */
  protected readonly priceKey = computed(() => `${this.paise(this.params().get("min_price"))}-${this.paise(this.params().get("max_price"))}`);
  protected readonly departmentName = computed(() => this.data()?.categories?.find((c) => c.slug === this.params().get("category"))?.name ?? "Department");
  protected readonly showDepartments = computed(() => !this.category() && (this.data()?.categories?.length ?? 0) > 1 && !this.topbar());
  protected readonly fp = computed<FilterProps>(() => ({ data: this.data()!, params: this.params(), set: (c) => this.set(c), inCategory: Boolean(this.category()) }));
  protected readonly drawerFp = computed<FilterProps>(() => ({ ...this.fp(), set: (c) => { this.set(c); this.showFilters.set(false); } }));

  constructor() {
    effect(() => {
      const fetchKey = this.fetchKey();
      const params = new URLSearchParams(this.key());
      const category = this.category();
      const seller = this.seller();
      const pin = this.pin();
      untracked(() => {
        this.track(api<Result>("/api/catalog/products", {
          query: {
            q: params.get("q"), category: category ?? params.get("category"), seller, brand: params.getAll("brand"),
            min_price: params.get("min_price"), max_price: params.get("max_price"), min_rating: params.get("min_rating"), min_discount: params.get("min_discount"),
            in_stock: params.get("in_stock"), deal: params.get("deal"), pincode: pin || undefined, delivery: pin ? params.get("delivery") : undefined,
            sort: params.get("sort") ?? "relevance", page: params.get("page") ?? 1,
          },
        }), (d) => this.data.set(d)).catch((e: Error) => this.error.set({ key: fetchKey, message: e.message }));
      });
    });
  }

  // Every change goes into one navigation: two pushes would each start from the current query, and the last would win.
  set(changes: QueryChanges): void {
    const next = new URLSearchParams(this.key());
    for (const [k, v] of Object.entries(changes)) {
      next.delete(k);
      if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
      else if (v) next.set(k, v);
    }
    const paging = "page" in changes;
    if (!paging) next.delete("page");
    const url = `${location.pathname}?${next.toString()}`;
    if (paging) void this.router.navigateByUrl(url);
    else navigateKeepScroll(this.router, url);
  }

  protected removeBrand(b: string) {
    this.set({ brand: this.params().getAll("brand").filter((x) => x !== b) });
  }

  protected clearAll() {
    const q = this.q();
    void this.router.navigateByUrl(q ? `${location.pathname}?q=${encodeURIComponent(q)}` : location.pathname);
  }
}
