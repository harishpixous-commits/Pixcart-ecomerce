/*
 * Luxe header: an editorial boutique header on white.
 *
 * The announcement bar and a thin utility row (delivery PIN, help, orders, the owner's header links; large screens)
 * scroll away. The sticky part is a three-column row (menu and featured links | centred logo | search, wishlist,
 * account, notifications, bag) and, on large screens, the categories with a gold rule under the active one, then the
 * promotion. Search opens a full-width panel under the header; phones and tablets also find the delivery PIN there.
 *
 * Behaviour comes from the shared parts (shop-chrome, shop-nav); this file only arranges and styles them.
 * Port of themes/luxe/header.tsx.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, viewChild } from "@angular/core";
import { ChevronLeft, ChevronRight, Search, ShoppingBag, X } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { CategoryNode } from "../../core/types";
import {
  AnnouncementBar,
  DeliverTo,
  Logo,
  NotificationBell,
  WishlistLink,
  AccountMenu,
  CategoriesService,
} from "../../shared/shop/shop-chrome";
import { AllMenu, SearchBox } from "../../shared/shop/shop-nav";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

/** The delivery PIN button in Luxe's small type (it sets its own size), its pin icon lined up with the page edge. */
const PIN_STYLE = "[&_[data-testid=deliver-to]]:text-[12px]";

/** Help, orders and the owner's header links, with the delivery PIN on the left (large screens; scrolls away). */
@Component({
  selector: "pc-luxe-utility-row",
  imports: [DeliverTo, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="hidden border-b border-line/70 bg-white [&_svg]:[stroke-width:1.5] lg:block">
      <div class="mx-auto flex h-9 max-w-shop items-center justify-between gap-6 px-3 sm:px-4">
        <div [class]="'-ml-2.5 min-w-0 ' + PIN_STYLE">@if (pinOn()) {<pc-deliver-to tone="light" />}</div>
        <nav aria-label="Help and orders" class="flex min-w-0 items-center gap-6 text-[11px] uppercase tracking-[0.18em] text-ink-soft">
          @for (l of links(); track l.href + l.label) {
            <a [pcLink]="l.href" class="whitespace-nowrap transition-colors hover:text-ink">{{ t(l.label) }}</a>
          }
        </nav>
      </div>
    </div>
  `,
})
export class LuxeUtilityRow {
  readonly pinOn = input.required<boolean>();
  protected readonly site = inject(SiteService).site;
  protected readonly PIN_STYLE = PIN_STYLE;
  protected readonly links = computed(() => [{ href: "/help", label: "Help" }, { href: "/orders", label: "Track order" }, ...this.site().header_links]);
  protected t(x: string): string {
    return fillTokens(x, this.site());
  }
}

/** The first nav links beside the menu on large screens (two on 1024 px, three from 1280 px); an underline draws in on hover. */
@Component({
  selector: "pc-luxe-featured-links",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (links().length) {
      <nav aria-label="Featured" class="hidden items-center gap-7 lg:flex">
        @for (l of links(); track l.href + l.label) {
          <a [pcLink]="l.href" [attr.aria-current]="on(l.href) ? 'page' : null"
            [class]="cx('group/nav relative whitespace-nowrap py-1.5 text-[12px] font-medium uppercase tracking-[0.16em] text-ink', $index === 2 && 'hidden xl:block')">
            {{ t(l.label) }}
            <span aria-hidden="true" [class]="cx('absolute inset-x-0 bottom-0.5 h-px origin-left bg-current transition-transform duration-300 ease-out', on(l.href) ? 'scale-x-100' : 'scale-x-0 group-hover/nav:scale-x-100 group-focus-visible/nav:scale-x-100')"></span>
          </a>
        }
      </nav>
    }
  `,
})
export class LuxeFeaturedLinks {
  protected readonly site = inject(SiteService).site;
  private readonly path = inject(RouteState).pathname;
  protected readonly cx = cx;
  protected readonly links = computed(() => (this.site().nav?.links ?? []).slice(0, 3));
  protected on(href: string): boolean {
    return this.path() === href.split("?")[0];
  }
  protected t(x: string): string {
    return fillTokens(x, this.site());
  }
}

/** The cart: a bag with the count in brackets ("Bag (2)" on large screens). */
@Component({
  selector: "pc-luxe-bag-link",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <a pcLink="/cart" [attr.aria-label]="'Cart, ' + session.cartCount() + ' items'" data-testid="header-cart"
      class="flex h-10 min-w-[40px] items-center justify-center gap-1.5 px-2 text-ink transition-colors hover:text-ink-soft">
      <svg [pcIcon]="ShoppingBag" class="h-5 w-5 shrink-0" />
      <span class="hidden text-[12px] font-medium uppercase tracking-[0.16em] lg:inline">Bag</span>
      @if (session.cartCount() > 0) {<span class="text-[12px] font-medium tabular-nums">({{ session.cartCount() > 99 ? "99+" : session.cartCount() }})</span>}
    </a>
  `,
})
export class LuxeBagLink {
  protected readonly session = inject(SessionService);
  protected readonly ShoppingBag = ShoppingBag;
}

/**
 * The search button and its full-width panel under the header: the search box with suggestions, trending searches and,
 * on phones, the delivery PIN. Escape, a click outside, a search or a new page close it.
 */
@Component({
  selector: "pc-luxe-search",
  imports: [Icon, PcLink, SearchBox, DeliverTo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button #btn type="button" (click)="toggle()" [attr.aria-expanded]="open()" [attr.aria-controls]="open() ? 'luxe-search' : null"
      [attr.aria-label]="open() ? 'Close search' : 'Search'" data-testid="header-search"
      class="flex h-10 w-10 shrink-0 items-center justify-center text-ink transition-colors hover:text-ink-soft">
      @if (open()) {<svg [pcIcon]="X" class="h-5 w-5" />} @else {<svg [pcIcon]="Search" class="h-5 w-5" />}
    </button>
    @if (open()) {
      <!-- dims the page under the header; the header's own background covers it inside the header -->
      <div aria-hidden="true" class="fixed inset-0 -z-20 animate-fade-in bg-ink/25"></div>
      <div #panel id="luxe-search" class="absolute inset-x-0 top-full animate-rise-in border-b border-line bg-white shadow-[0_32px_48px_-32px_rgb(0_0_0/0.35)]"
        (submit)="searched($event)">
        <div class="mx-auto max-w-3xl px-3 pb-6 pt-4 sm:px-4 sm:pb-10 sm:pt-8">
          <p class="mb-4 hidden text-center font-display text-2xl text-ink sm:block">What are you looking for?</p>
          <pc-search-box [categories]="categories()" variant="outline" button="plain" />
          @if (trending().length > 0) {
            <div class="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 sm:mt-6 sm:justify-center">
              <span class="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-faint">Trending</span>
              @for (t of trending(); track t) {
                <a [pcLink]="'/search?q=' + enc(t)"
                  class="inline-block py-1 font-display text-[15px] text-ink-soft underline-offset-4 transition-colors first-letter:uppercase hover:text-ink hover:underline">{{ t }}</a>
              }
            </div>
          }
          @if (pinOn()) {
            <div [class]="'-ml-2.5 mt-4 border-t border-line pt-3 lg:hidden ' + PIN_STYLE">
              <pc-deliver-to tone="light" />
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class LuxeSearch {
  readonly categories = input.required<CategoryNode[]>();
  readonly pinOn = input.required<boolean>();
  protected readonly site = inject(SiteService).site;
  protected readonly open = signal(false);
  protected readonly Search = Search;
  protected readonly X = X;
  protected readonly PIN_STYLE = PIN_STYLE;
  private readonly panel = viewChild<ElementRef<HTMLElement>>("panel");
  private readonly button = viewChild<ElementRef<HTMLElement>>("btn");
  protected readonly trending = computed(() => this.site().nav?.trending ?? []);

  constructor() {
    const state = inject(RouteState);
    // a new page or a new search: close the panel
    let first = true;
    effect(() => {
      state.pathname();
      state.search();
      if (first) { first = false; return; }
      this.open.set(false);
    });
    // Escape and clicks outside the panel or its button close it
    effect((onCleanup) => {
      if (!this.open()) return;
      const onDown = (e: MouseEvent) => {
        const t = e.target as Node;
        if (!this.panel()?.nativeElement.contains(t) && !this.button()?.nativeElement.contains(t)) this.open.set(false);
      };
      const esc = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        this.open.set(false);
        this.button()?.nativeElement.querySelector("button")?.focus();
      };
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", esc);
      onCleanup(() => {
        document.removeEventListener("mousedown", onDown);
        document.removeEventListener("keydown", esc);
      });
    });
  }

  protected toggle(): void {
    if (this.open()) {
      this.open.set(false);
      return;
    }
    this.open.set(true);
    // the panel renders now; focus lands in the search box within the tap (phones then show the keyboard)
    requestAnimationFrame(() => this.panel()?.nativeElement.querySelector<HTMLInputElement>("#site-search")?.focus());
  }

  protected searched(e: Event): void {
    if ((e.target as HTMLFormElement).querySelector("input")?.value.trim()) this.open.set(false);
  }

  protected enc(t: string): string {
    return encodeURIComponent(t);
  }
}

/** Large screens: the categories, centred, with a gold rule under the active or hovered one; then the promotion. */
@Component({
  selector: "pc-luxe-category-row",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (shown()) {
      <div class="relative mx-auto hidden max-w-shop px-3 sm:px-4 lg:block">
        <div #box class="scroll-x overflow-x-auto">
          <nav aria-label="Categories" class="mx-auto flex h-11 w-max items-stretch gap-x-6 xl:gap-x-8">
            @if (showCats()) {
              @for (c of categories(); track c.slug) {
                <a [pcLink]="'/c/' + c.slug" [attr.aria-current]="path() === '/c/' + c.slug ? 'page' : (on(c) ? 'true' : null)"
                  [class]="cx('group/cat relative flex items-center whitespace-nowrap text-[12px] uppercase tracking-[0.18em] transition-colors', on(c) ? 'text-ink' : 'text-ink-soft hover:text-ink')">
                  {{ c.name }}
                  <span aria-hidden="true" [class]="cx('absolute inset-x-0 bottom-0 h-0.5 bg-marigold transition-transform duration-300 ease-out', on(c) ? 'scale-x-100' : 'scale-x-0 group-hover/cat:scale-x-100 group-focus-visible/cat:scale-x-100')"></span>
                </a>
              }
            }
            @if (promo(); as p) {
              @if (showCats()) {<span aria-hidden="true" class="h-4 w-px self-center bg-line"></span>}
              @if (p.link) {
                <a [pcLink]="p.link" [class]="PROMO_CLASS + ' hover:underline'" data-testid="nav-promo">
                  <span aria-hidden="true" [class]="'h-1.5 w-1.5 shrink-0 rotate-45 ' + dot(p.tone)"></span>{{ t(p.text) }}
                </a>
              } @else {
                <span [class]="PROMO_CLASS" data-testid="nav-promo">
                  <span aria-hidden="true" [class]="'h-1.5 w-1.5 shrink-0 rotate-45 ' + dot(p.tone)"></span>{{ t(p.text) }}
                </span>
              }
            }
          </nav>
        </div>
        @if (!edges().start) {
          <button type="button" (click)="go(-1)" aria-label="Scroll categories left"
            class="absolute inset-y-0 left-0 flex w-14 items-center justify-start bg-gradient-to-r from-white via-white/90 to-transparent pl-2 text-ink-soft hover:text-ink">
            <svg [pcIcon]="ChevronLeft" class="h-4 w-4" />
          </button>
        }
        @if (!edges().end) {
          <button type="button" (click)="go(1)" aria-label="Scroll categories right"
            class="absolute inset-y-0 right-0 flex w-14 items-center justify-end bg-gradient-to-l from-white via-white/90 to-transparent pr-2 text-ink-soft hover:text-ink">
            <svg [pcIcon]="ChevronRight" class="h-4 w-4" />
          </button>
        }
      </div>
    }
  `,
})
export class LuxeCategoryRow {
  readonly categories = input.required<CategoryNode[]>();
  protected readonly site = inject(SiteService).site;
  protected readonly path = inject(RouteState).pathname;
  private readonly box = viewChild<ElementRef<HTMLElement>>("box");
  protected readonly cx = cx;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;
  protected readonly edges = signal({ start: true, end: true });
  protected readonly showCats = computed(() => this.site().nav?.show_categories !== false && this.categories().length > 0);
  protected readonly promo = computed(() => {
    const p = this.site().nav?.promo;
    return p?.enabled && p.text ? p : null;
  });
  protected readonly shown = computed(() => this.showCats() || !!this.promo());
  protected readonly PROMO_CLASS = "flex items-center gap-2 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-ink decoration-marigold decoration-2 underline-offset-[6px]";

  constructor() {
    effect((onCleanup) => {
      this.shown();
      this.categories().length;
      const el = this.box()?.nativeElement;
      if (!el) return;
      // arrows appear only when the row is wider than the screen (many or long category names)
      const update = () => this.edges.set({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
      const ro = new ResizeObserver(update);
      ro.observe(el);
      el.addEventListener("scroll", update, { passive: true });
      update();
      onCleanup(() => {
        ro.disconnect();
        el.removeEventListener("scroll", update);
      });
    });
  }

  protected on(c: CategoryNode): boolean {
    const p = this.path();
    return p === `/c/${c.slug}` || c.children.some((ch) => p === `/c/${ch.slug}`);
  }
  protected go(d: number): void {
    const el = this.box()?.nativeElement;
    if (el) el.scrollBy({ left: d * el.clientWidth * 0.6, behavior: "smooth" });
  }
  protected dot(tone: "accent" | "buy" | "primary" | "dark"): string {
    return ({ accent: "bg-marigold", buy: "bg-vermilion", primary: "bg-peacock", dark: "bg-ink" } as const)[tone] ?? "bg-marigold";
  }
  protected t(x: string): string {
    return fillTokens(x, this.site());
  }
}

@Component({
  selector: "pc-luxe-header",
  imports: [AnnouncementBar, LuxeUtilityRow, AllMenu, LuxeFeaturedLinks, Logo, LuxeSearch, WishlistLink, AccountMenu, NotificationBell, LuxeBagLink, LuxeCategoryRow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-announcement-bar />
    <pc-luxe-utility-row [pinOn]="pinOn()" />
    <!-- The header rises above the help button and tab bar while the All menu is open. Its frosted background is a
         separate layer: a backdrop filter on the header itself would trap the menu's full-screen drawer inside it. -->
    <header class="sticky top-0 z-30 has-[[role=dialog]]:z-[60] [&_svg]:[stroke-width:1.5]">
      <div aria-hidden="true" class="absolute inset-0 -z-10 border-b border-line bg-white/95 backdrop-blur-md"></div>
      <div class="mx-auto grid h-16 max-w-shop grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 sm:px-4 lg:h-20">
        <div class="flex min-w-0 items-center gap-5">
          @if (site().nav?.all_menu !== false) {
            <div class="-ml-2.5 shrink-0"><pc-all-menu [categories]="cats()" tone="light" [iconOnly]="true" /></div>
          }
          <pc-luxe-featured-links />
        </div>
        <div class="flex justify-center lg:[&>a]:text-[28px] lg:[&_img]:h-11">
          <a pcLogo pcLink="/" [light]="false"></a>
        </div>
        <div class="-mr-2 flex items-center justify-end gap-0.5 sm:gap-1">
          <pc-luxe-search [categories]="cats()" [pinOn]="pinOn()" />
          <pc-wishlist-link tone="light" />
          <!-- the tab bar has Account on phones; Luxe's small capitals for "Sign in" and the first name -->
          <div class="hidden sm:block [&_button>span]:text-[12px] [&_button>span]:font-medium [&_button>span]:uppercase [&_button>span]:tracking-[0.16em] [&_a>span]:text-[12px] [&_a>span]:font-medium [&_a>span]:uppercase [&_a>span]:tracking-[0.16em]">
            <pc-account-menu tone="light" [compact]="true" />
          </div>
          <!-- phones keep the bar to menu, logo, search and bag; notifications are under Account -->
          <div class="hidden sm:block"><pc-notification-bell [dark]="true" /></div>
          <pc-luxe-bag-link />
        </div>
      </div>
      <pc-luxe-category-row [categories]="cats()" />
    </header>
  `,
})
export class LuxeHeader {
  private readonly categories = inject(CategoriesService);
  protected readonly site = inject(SiteService).site;
  protected readonly cats = this.categories.categories;
  protected readonly pinOn = computed(() => this.site().pdp?.header_pincode !== false);
}
