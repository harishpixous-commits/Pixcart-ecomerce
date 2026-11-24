/*
 * "Page not found" and "Something went wrong" for every part of the app: the shop (inside the active theme's header and
 * footer, in its colours), the admin panel, the seller hub and the delivery partner app. The shop's titles, messages,
 * search box and suggestions are set in Admin → Marketplace settings → Error pages. Port of components/error-pages.tsx:
 * <pc-not-found-view area="shop|admin|seller|delivery" />, <pc-error-view [error] (retry) area="..." />.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import { Router } from "@angular/router";
import { House, RotateCcw, Search, SearchX, TriangleAlert } from "lucide-angular";
import { api } from "../../core/api";
import { SiteService } from "../../core/site";
import type { ErrorPageSettings, ProductCard } from "../../core/types";
import { ProductRail } from "../product/product";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";

export type Area = "shop" | "admin" | "seller" | "delivery";

export const ERROR_PAGE_DEFAULTS: ErrorPageSettings = {
  not_found_title: "We couldn't find that page",
  not_found_message: "The link may be old, or the product is no longer sold. Try a search, or pick from what other shoppers are buying.",
  not_found_search: true,
  not_found_suggestions: true,
  error_title: "Something went wrong on our side",
  error_message: "Please try again. If it keeps happening, contact us and quote the reference shown below.",
};

const HOME: Record<Area, { href: string; label: string }> = {
  shop: { href: "/", label: "Go to the home page" },
  admin: { href: "/admin", label: "Back to the overview" },
  seller: { href: "/seller", label: "Back to your dashboard" },
  delivery: { href: "/delivery", label: "Back to your trips" },
};

@Component({
  selector: "pc-suggestions",
  imports: [ProductRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (items()?.length) {<div class="mt-2 w-full text-left"><pc-product-rail title="Popular right now" [items]="items()!" href="/bestsellers" /></div>}`,
})
export class Suggestions {
  protected readonly items = signal<ProductCard[] | null>(null);
  constructor() {
    api<{ items?: ProductCard[]; sections?: { items: ProductCard[] }[] }>("/api/catalog/top", { query: { list: "bestsellers" } })
      .then((d) => this.items.set((d.items ?? d.sections?.flatMap((s) => s.items) ?? []).slice(0, 12)))
      .catch(() => this.items.set([]));
  }
}

/** 404: the page or product does not exist. */
@Component({
  selector: "pc-not-found-view",
  imports: [Icon, PcLink, Suggestions],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4" },
  template: `
    <section class="mx-auto flex w-full max-w-xl flex-col items-center px-2 py-10 text-center sm:py-16" data-testid="not-found">
      <span class="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-peacock/10 text-peacock"><svg [pcIcon]="SearchX" class="h-8 w-8" /></span>
      <h1 class="font-display text-2xl font-bold text-ink sm:text-3xl">{{ shop() ? cfg().not_found_title : "Page not found" }}</h1>
      <p class="mt-3 text-ink-soft">{{ shop() ? cfg().not_found_message : "This page does not exist, or you followed an old link. Use the menu to find what you need." }}</p>
      @if (shop() && cfg().not_found_search) {
        <form role="search" (submit)="search($event)"
          class="mt-6 flex w-full max-w-md overflow-hidden rounded-xl border border-line bg-white focus-within:border-peacock focus-within:ring-2 focus-within:ring-peacock/20">
          <label for="nf-search" class="sr-only">Search products</label>
          <input id="nf-search" [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Search products" class="h-11 min-w-0 flex-1 bg-transparent px-4 text-[16px] focus:outline-none" />
          <button type="submit" class="flex w-12 items-center justify-center bg-marigold text-ink" aria-label="Search"><svg [pcIcon]="Search" class="h-5 w-5" /></button>
        </form>
      }
      <a [pcLink]="home().href" class="mt-6 inline-flex items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 font-semibold text-white hover:bg-peacock-dark">
        <svg [pcIcon]="House" class="h-4 w-4" /> {{ home().label }}
      </a>
    </section>
    @if (shop() && cfg().not_found_suggestions) {<pc-suggestions />}
  `,
})
export class NotFoundView {
  readonly area = input<Area>("shop");
  private readonly site = inject(SiteService).site;
  private readonly router = inject(Router);
  protected readonly cfg = computed(() => ({ ...ERROR_PAGE_DEFAULTS, ...(this.site().error_pages ?? {}) }));
  protected readonly shop = computed(() => this.area() === "shop");
  protected readonly home = computed(() => HOME[this.area()]);
  protected readonly q = signal("");
  protected readonly SearchX = SearchX;
  protected readonly Search = Search;
  protected readonly House = House;
  protected search(e: Event): void {
    e.preventDefault();
    if (this.q().trim()) void this.router.navigateByUrl(`/search?q=${encodeURIComponent(this.q().trim())}`);
  }
}

/** An error page: what happened in plain words, a retry, and a reference to quote to support. */
@Component({
  selector: "pc-error-view",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="mx-auto flex w-full max-w-xl flex-col items-center px-2 py-10 text-center sm:py-16" data-testid="error-page">
      <span class="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-vermilion/10 text-vermilion"><svg [pcIcon]="TriangleAlert" class="h-8 w-8" /></span>
      <h1 class="font-display text-2xl font-bold text-ink sm:text-3xl">{{ offline ? "You are offline" : shop() ? cfg().error_title : "This page could not load" }}</h1>
      <p class="mt-3 text-ink-soft">{{ offline ? "Check your internet connection, then try again." : shop() ? cfg().error_message : "Try again. If it keeps happening, tell the team and quote the reference below." }}</p>
      <div class="mt-6 flex flex-wrap justify-center gap-2">
        @if (canRetry()) {
          <button type="button" (click)="retry.emit()" class="inline-flex items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 font-semibold text-white hover:bg-peacock-dark">
            <svg [pcIcon]="RotateCcw" class="h-4 w-4" /> Try again
          </button>
        }
        <a [pcLink]="home().href" class="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-4 py-2.5 font-semibold text-ink hover:bg-mist">
          <svg [pcIcon]="House" class="h-4 w-4" /> {{ home().label }}
        </a>
      </div>
      @if (digest()) {<p class="mt-5 text-xs text-ink-faint">Reference: <span class="font-mono select-all">{{ digest() }}</span></p>}
    </section>
  `,
})
export class ErrorView {
  readonly error = input<unknown>(null);
  readonly area = input<Area>("shop");
  readonly canRetry = input(true);
  /** a reference to quote to support */
  readonly digest = input<string | undefined>(undefined);
  readonly retry = output<void>();
  private readonly site = inject(SiteService).site;
  protected readonly cfg = computed(() => ({ ...ERROR_PAGE_DEFAULTS, ...(this.site().error_pages ?? {}) }));
  protected readonly shop = computed(() => this.area() === "shop");
  protected readonly home = computed(() => HOME[this.area()]);
  protected readonly offline = typeof navigator !== "undefined" && navigator.onLine === false;
  protected readonly TriangleAlert = TriangleAlert;
  protected readonly RotateCcw = RotateCcw;
  protected readonly House = House;
  constructor() {
    effect(() => { const e = this.error(); if (e) console.error(e); });
  }
}
