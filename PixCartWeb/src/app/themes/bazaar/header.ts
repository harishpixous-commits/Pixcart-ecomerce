/*
 * Bazaar header: a bold, two-tier big-store header.
 * Tier 1 (brand colour): logo, delivery PIN, a large centred search, notifications, account, orders, wishlist, cart.
 * Tier 2 (the darker brand colour): an all-categories mega menu (large screens), the marketplace's links and the
 * promotion. Phones: menu, logo, account and cart, then the search; the delivery PIN and the links follow as a strip
 * that scrolls sideways and scrolls away with the page, so the part that stays on screen is compact.
 * Behaviour comes from the shared header parts (shared/shop/shop-chrome, shared/shop/shop-nav); this file arranges them.
 * Port of themes/bazaar/header.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, input, signal, viewChild } from "@angular/core";
import { ChevronDown, ChevronRight, Flame, LayoutGrid, Sparkles, Trophy, type LucideIconData } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { CategoryNode, LinkItem, Site } from "../../core/types";
import { CategoryIcon } from "../../shared/chrome/category-icon";
import { AccountMenu, AnnouncementBar, CartLink, CategoriesService, DeliverTo, Logo, NotificationBell, WishlistLink, closeOnNavigate, closeOnOutside } from "../../shared/shop/shop-chrome";
import { AllMenu, ReturnsOrders, SearchBox } from "../../shared/shop/shop-nav";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

/* Phones get the delivery PIN, the links and the promotion in a strip under the header; larger screens get them in the header. */
const PHONE = "(max-width: 767.98px)";

/** true on phones, false on larger screens (follows the window). */
function phoneSignal() {
  const m = window.matchMedia(PHONE);
  const s = signal(m.matches);
  const onChange = () => s.set(m.matches);
  m.addEventListener("change", onChange);
  inject(DestroyRef).onDestroy(() => m.removeEventListener("change", onChange));
  return s.asReadonly();
}

/** The marketplace's links (Admin → Storefront → Navigation), then the header links. */
function navLinks(site: Site): LinkItem[] {
  return [...(site.nav?.links ?? []), ...(site.header_links ?? [])];
}

function isCurrent(pathname: string, href: string): boolean {
  if (href.includes("?") || href.includes("#") || href === "/") return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

@Component({
  selector: "pc-bazaar-nav-links",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @for (l of links(); track l.href + "-" + $index) {
      <a [pcLink]="l.href" [attr.aria-current]="current(l.href) ? 'page' : null" [class]="cls()">{{ label(l.label) }}</a>
    }
  `,
})
export class BazaarNavLinks {
  readonly links = input.required<LinkItem[]>();
  readonly small = input(false);
  private readonly site = inject(SiteService).site;
  private readonly path = inject(RouteState).pathname;
  protected readonly cls = computed(() =>
    cx("flex h-full shrink-0 items-center whitespace-nowrap px-2.5 font-medium text-white/90 decoration-marigold decoration-2 hover:text-white hover:underline aria-[current=page]:text-white aria-[current=page]:underline",
      this.small() ? "text-[13px] underline-offset-[5px]" : "text-sm underline-offset-[7px]"));
  protected current(href: string): boolean {
    return isCurrent(this.path(), href);
  }
  protected label(x: string): string {
    return fillTokens(x, this.site());
  }
}

const PROMO_TONE: Record<string, string> = {
  accent: "bg-marigold text-ink",
  buy: "bg-vermilion text-white",
  primary: "bg-peacock text-white ring-1 ring-white/30",
  dark: "bg-ink text-white",
};

/** The promotion pill (Admin → Storefront → Navigation → Promotion). */
@Component({
  selector: "pc-bazaar-promo",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (promo()?.enabled && promo()?.text) {
      @if (promo()!.link) {
        <a [pcLink]="promo()!.link" [class]="cls() + ' hover:opacity-90'" data-testid="nav-promo">{{ text() }}</a>
      } @else {
        <span [class]="cls()" data-testid="nav-promo">{{ text() }}</span>
      }
    }
  `,
})
export class BazaarPromo {
  readonly promoClass = input<string>("");
  private readonly site = inject(SiteService).site;
  protected readonly promo = computed(() => this.site().nav?.promo);
  protected readonly cls = computed(() =>
    cx("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1 font-bold", PROMO_TONE[this.promo()?.tone ?? "accent"] ?? PROMO_TONE["accent"], this.promoClass()));
  protected readonly text = computed(() => fillTokens(this.promo()?.text ?? "", this.site()));
}

let megaId = 0;

/** "All categories": a full-width panel under the header with every category, its sub-categories and shortcuts. */
@Component({
  selector: "pc-bazaar-mega-menu",
  imports: [Icon, PcLink, CategoryIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div #box class="flex h-full items-end" (focusout)="onFocusOut($event)">
      <button #trigger type="button" (click)="open.set(!open())" [attr.aria-expanded]="open()" aria-haspopup="true" [attr.aria-controls]="open() ? panelId : null"
        (keydown)="onKey($event)" [class]="triggerCls()" data-testid="mega-menu">
        <svg [pcIcon]="LayoutGrid" class="h-[18px] w-[18px]" />
        All categories
        <svg [pcIcon]="ChevronDown" [class]="open() ? 'h-4 w-4 transition-transform duration-200 rotate-180' : 'h-4 w-4 transition-transform duration-200'" />
      </button>
      @if (open()) {
        <div class="absolute inset-x-0 top-full h-screen animate-fade-in bg-ink/30" (click)="close()" aria-hidden="true"></div>
        <div [id]="panelId" tabindex="-1" class="absolute inset-x-0 top-full animate-rise-in border-t border-line bg-white text-ink shadow-xl outline-none">
          <div class="mx-auto grid max-h-[calc(100vh-9rem)] max-w-shop grid-cols-[minmax(0,1fr)_16rem] gap-8 overflow-y-auto px-4 py-6">
            <div>
              <div class="mb-5 flex items-baseline justify-between gap-4">
                <p class="font-display text-lg font-bold">Shop by category</p>
                <a pcLink="/categories" (click)="close()" class="inline-flex items-center gap-0.5 text-sm font-semibold text-peacock hover:underline">
                  Every category <svg [pcIcon]="ChevronRight" class="h-4 w-4" />
                </a>
              </div>
              @if (categories().length) {
                <ul class="grid grid-cols-3 gap-x-6 gap-y-7 xl:grid-cols-4">
                  @for (c of categories(); track c.slug) {
                    <li class="min-w-0">
                      <a [pcLink]="'/c/' + c.slug" (click)="close()" class="group/cat flex items-center gap-3">
                        <span class="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-peacock/10 text-peacock transition-colors group-hover/cat:bg-peacock group-hover/cat:text-white">
                          @if (c.image_url) {<img [src]="c.image_url" alt="" class="h-full w-full object-cover" />}
                          @else {<svg [pcCategoryIcon]="c.slug" class="h-5 w-5" />}
                        </span>
                        <span class="min-w-0">
                          <span class="block truncate font-display text-[15px] font-semibold leading-snug group-hover/cat:text-peacock">{{ c.name }}</span>
                          @if (c.product_count > 0) {<span class="block text-xs text-ink-faint">{{ c.product_count.toLocaleString("en-IN") }} {{ c.product_count === 1 ? "product" : "products" }}</span>}
                        </span>
                      </a>
                      @if (c.children.length > 0) {
                        <ul class="mt-2.5 flex flex-col gap-1 pl-14">
                          @for (ch of c.children.slice(0, 6); track ch.slug) {
                            <li><a [pcLink]="'/c/' + ch.slug" (click)="close()" class="block truncate text-sm text-ink-soft hover:text-peacock hover:underline">{{ ch.name }}</a></li>
                          }
                        </ul>
                      }
                      <a [pcLink]="'/c/' + c.slug" (click)="close()" class="ml-14 mt-2 inline-flex items-center gap-0.5 text-sm font-semibold text-peacock hover:underline">
                        See all <span class="sr-only">in {{ c.name }}</span><svg [pcIcon]="ChevronRight" class="h-4 w-4" />
                      </a>
                    </li>
                  }
                </ul>
              } @else {
                <div class="grid grid-cols-3 gap-6 xl:grid-cols-4" aria-hidden="true">
                  @for (i of eight; track i) {<div class="skeleton h-28 rounded-lg"></div>}
                </div>
              }
            </div>
            <aside class="flex flex-col gap-1 border-l border-line pl-6" aria-label="Shop more">
              <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">Shop more</p>
              @for (s of shortcuts(); track s.href) {
                <a [pcLink]="s.href" (click)="close()" class="group/more -mx-2 flex items-center gap-3 rounded-lg p-2 hover:bg-mist">
                  <span [class]="'flex h-10 w-10 shrink-0 items-center justify-center rounded-full ' + s.tint"><svg [pcIcon]="s.icon" class="h-5 w-5" /></span>
                  <span class="min-w-0">
                    <span class="block text-sm font-semibold group-hover/more:text-peacock">{{ s.label }}</span>
                    <span class="block text-xs text-ink-faint">{{ s.note }}</span>
                  </span>
                </a>
              }
              @if (extra().length > 0) {
                <div class="mt-3 flex flex-col gap-0.5 border-t border-line pt-3">
                  @for (l of extra(); track l.href + "-" + $index) {
                    <a [pcLink]="l.href" (click)="close()" class="-mx-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-mist hover:text-peacock">{{ label(l.label) }}</a>
                  }
                </div>
              }
            </aside>
          </div>
        </div>
      }
    </div>
  `,
})
export class BazaarMegaMenu {
  readonly categories = input.required<CategoryNode[]>();
  private readonly site = inject(SiteService).site;
  private readonly box = viewChild<ElementRef<HTMLElement>>("box");
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>("trigger");
  protected readonly open = signal(false);
  protected readonly panelId = `mega-${++megaId}`;
  protected readonly eight = [0, 1, 2, 3, 4, 5, 6, 7];
  protected readonly LayoutGrid = LayoutGrid;
  protected readonly ChevronDown = ChevronDown;
  protected readonly ChevronRight = ChevronRight;
  protected readonly triggerCls = computed(() =>
    cx("flex h-9 items-center gap-2 rounded-t-lg px-3.5 text-sm font-semibold transition-colors", this.open() ? "bg-white text-peacock" : "bg-white/10 text-white hover:bg-white/20"));
  protected readonly shortcuts = computed<{ href: string; label: string; note: string; icon: LucideIconData; tint: string }[]>(() => [
    ...(this.site().features.deals !== false ? [{ href: "/deals", label: "Today's deals", note: "Limited-time prices", icon: Flame, tint: "bg-vermilion/10 text-vermilion" }] : []),
    { href: "/bestsellers", label: "Bestsellers", note: "Most bought right now", icon: Trophy, tint: "bg-marigold/25 text-ink" },
    { href: "/new-releases", label: "New releases", note: "Just arrived", icon: Sparkles, tint: "bg-leaf/10 text-leaf" },
  ]);
  protected readonly extra = computed(() => this.site().nav?.drawer_links ?? []);

  constructor() {
    closeOnNavigate(() => this.open.set(false));
    closeOnOutside(this.open, () => this.open.set(false), () => this.box()?.nativeElement);
    // Escape also returns focus to the trigger
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && this.open()) this.trigger()?.nativeElement.focus(); };
    document.addEventListener("keydown", esc);
    inject(DestroyRef).onDestroy(() => document.removeEventListener("keydown", esc));
  }

  protected close(): void {
    this.open.set(false);
  }

  protected label(x: string): string {
    return fillTokens(x, this.site());
  }

  protected onFocusOut(e: FocusEvent): void {
    const box = e.currentTarget as HTMLElement;
    if (this.open() && !box.contains(e.relatedTarget as Node | null)) this.open.set(false);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    this.open.set(true);
    requestAnimationFrame(() => document.getElementById(this.panelId)?.querySelector<HTMLElement>("a")?.focus());
  }
}

@Component({
  selector: "pc-bazaar-header",
  imports: [Logo, AnnouncementBar, SearchBox, NotificationBell, AccountMenu, ReturnsOrders, WishlistLink, CartLink, DeliverTo, AllMenu, BazaarMegaMenu, BazaarNavLinks, BazaarPromo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-announcement-bar />
    <header class="sticky top-0 z-30 shadow-md has-[[aria-modal=true]]:z-[60]">
      <div class="bg-peacock text-white">
        <div class="mx-auto flex max-w-shop flex-wrap items-center gap-x-1 gap-y-1.5 px-3 pb-2.5 pt-1.5 sm:gap-x-2 sm:px-4 md:gap-y-2 md:pb-3 md:pt-2 lg:flex-nowrap lg:gap-x-4 lg:py-3">
          @if (allMenu() && phone()) {
            <div class="-ml-2 md:hidden"><pc-all-menu [categories]="cats()" tone="dark" [iconOnly]="true" /></div>
          }
          <a pcLogo></a>
          @if (pinOn() && !phone()) {
            <div class="hidden md:block"><pc-deliver-to tone="dark" /></div>
          }
          <div class="order-last w-full min-w-0 lg:order-none lg:mx-auto lg:w-auto lg:max-w-3xl lg:flex-1">
            <form pcSearchBox [categories]="cats()" variant="solid" shape="pill" button="accent"></form>
          </div>
          <div class="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1 lg:ml-0">
            <pc-notification-bell />
            <pc-account-menu tone="dark" [compact]="phone()" />
            <div class="hidden xl:block"><pc-returns-orders tone="dark" /></div>
            <pc-wishlist-link tone="dark" />
            <pc-cart-link tone="dark" [label]="!phone()" />
          </div>
        </div>
      </div>
      @if (!phone()) {
        <div class="relative hidden bg-peacock-dark text-white md:block">
          <div class="mx-auto flex h-11 max-w-shop items-center gap-2 px-3 sm:px-4">
            @if (allMenu()) {
              <div class="-ml-2 shrink-0 lg:hidden"><pc-all-menu [categories]="cats()" tone="dark" label="All" /></div>
            }
            <div class="hidden h-full shrink-0 lg:block"><pc-bazaar-mega-menu [categories]="cats()" /></div>
            @if (links().length > 0) {
              <nav aria-label="Shop" class="scroll-x flex h-full min-w-0 flex-1 items-center overflow-x-auto lg:pl-1">
                <pc-bazaar-nav-links [links]="links()" />
              </nav>
            }
            <pc-bazaar-promo promoClass="ml-auto text-sm" />
          </div>
        </div>
      }
    </header>
    @if (phone() && (links().length || pinOn() || promoOn())) {
      <div class="bg-peacock-dark text-white md:hidden">
        <div class="flex h-10 items-center pl-0.5">
          @if (pinOn()) {
            <div class="[&_[data-testid=deliver-to]]:min-h-10"><pc-deliver-to tone="dark" /></div>
            <span class="mx-0.5 h-4 w-px shrink-0 bg-white/25" aria-hidden="true"></span>
          }
          <nav aria-label="Shop" class="scroll-x flex h-full min-w-0 flex-1 items-center overflow-x-auto pr-2">
            <pc-bazaar-promo promoClass="mx-1 py-0.5 text-[13px]" />
            <pc-bazaar-nav-links [links]="links()" [small]="true" />
          </nav>
        </div>
      </div>
    }
  `,
})
export class BazaarHeader {
  protected readonly cats = inject(CategoriesService).categories;
  private readonly site = inject(SiteService).site;
  protected readonly phone = phoneSignal();
  protected readonly pinOn = computed(() => this.site().pdp?.header_pincode !== false);
  protected readonly allMenu = computed(() => this.site().nav?.all_menu !== false);
  protected readonly links = computed(() => navLinks(this.site()));
  protected readonly promoOn = computed(() => Boolean(this.site().nav?.promo?.enabled && this.site().nav?.promo?.text));
}
