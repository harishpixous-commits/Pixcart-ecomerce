/*
 * Bazaar header: a bold, two-tier big-store header.
 * Tier 1 (brand colour): logo, delivery PIN, a large centred search, notifications, account, orders, wishlist, cart.
 * Tier 2 (the darker brand colour): an all-categories mega menu (large screens), the marketplace's links and the
 * promotion. Phones: menu, logo, account and cart, then the search; the delivery PIN and the links follow as a strip
 * that scrolls sideways and scrolls away with the page, so the part that stays on screen is compact.
 * Port of themes/bazaar/header.tsx; behaviour comes from the shared parts (shared/shop/shop-chrome, shared/shop/shop-nav).
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal } from "@angular/core";
import { ChevronDown, ChevronRight, Flame, LayoutGrid, Sparkles, Trophy } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { CategoryNode, LinkItem, Site } from "../../core/types";
import { CategoryIcon } from "../../shared/chrome/category-icon";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { AccountMenu, AnnouncementBar, CartLink, CategoriesService, DeliverTo, Logo, NotificationBell, WishlistLink } from "../../shared/shop/shop-chrome";
import { AllMenu, ReturnsOrders, SearchBox } from "../../shared/shop/shop-nav";

/* Phones get the delivery PIN, the links and the promotion in a strip under the header; larger screens get them in the
 * header. Each part is mounted once (tests and screen readers find one of each). */
const PHONE = "(max-width: 767.98px)";

/** true on phones, false on larger screens (usePhone). */
function phoneSignal() {
  const matches = signal<boolean>(typeof window !== "undefined" ? window.matchMedia(PHONE).matches : false);
  if (typeof window !== "undefined") {
    const m = window.matchMedia(PHONE);
    const onChange = () => matches.set(m.matches);
    m.addEventListener("change", onChange);
    inject(ElementRef).nativeElement.ownerDocument.defaultView?.addEventListener("unload", () => m.removeEventListener("change", onChange), { once: true });
  }
  return matches.asReadonly();
}

/** The marketplace's links (Admin → Storefront → Navigation), then the header links. */
function navLinks(site: Site): LinkItem[] {
  return [...(site.nav?.links ?? []), ...(site.header_links ?? [])];
}

function isCurrent(pathname: string, href: string): boolean {
  if (href.includes("?") || href.includes("#") || href === "/") return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

const PROMO_TONE = {
  accent: "bg-marigold text-ink",
  buy: "bg-vermilion text-white",
  primary: "bg-peacock text-white ring-1 ring-white/30",
  dark: "bg-ink text-white",
} as const;

/** The promotion pill (Admin → Storefront → Navigation → Promotion). Usage: <pc-bazaar-promo class="..." />. */
@Component({
  selector: "pc-bazaar-promo",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (promo(); as p) {
      @if (p.link) {
        <a [pcLink]="p.link" [class]="cls() + ' hover:opacity-90'" data-testid="nav-promo">{{ text() }}</a>
      } @else {
        <span [class]="cls()" data-testid="nav-promo">{{ text() }}</span>
      }
    }
  `,
})
export class BazaarPromo {
  private readonly site = inject(SiteService).site;
  protected readonly promo = computed(() => {
    const p = this.site().nav?.promo;
    return p?.enabled && p.text ? p : null;
  });
  protected readonly text = computed(() => fillTokens(this.promo()!.text, this.site()));
  private readonly hostCls = (inject(ElementRef).nativeElement as HTMLElement).getAttribute("class")?.replace(/\bcontents\b/g, "") ?? "";
  protected readonly cls = computed(
    () => "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1 font-bold " + (PROMO_TONE[this.promo()!.tone] ?? PROMO_TONE.accent) + " " + this.hostCls);
}

/** The marketplace + header links row. */
@Component({
  selector: "pc-bazaar-nav-links",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @for (l of links(); track l.href + $index) {
      <a [pcLink]="l.href" [attr.aria-current]="current(l.href) ? 'page' : null"
        [class]="'flex h-full shrink-0 items-center whitespace-nowrap px-2.5 font-medium text-white/90 decoration-marigold decoration-2 hover:text-white hover:underline aria-[current=page]:text-white aria-[current=page]:underline ' + (small() ? 'text-[13px] underline-offset-[5px]' : 'text-sm underline-offset-[7px]')">
        {{ label(l.label) }}
      </a>
    }
  `,
})
export class BazaarNavLinks {
  readonly links = input.required<LinkItem[]>();
  readonly small = input(false);
  private readonly site = inject(SiteService).site;
  private readonly path = inject(RouteState).pathname;
  protected current(href: string): boolean {
    return isCurrent(this.path(), href);
  }
  protected label(x: string): string {
    return fillTokens(x, this.site());
  }
}

/** "All categories": a full-width panel under the header with every category, its sub-categories and shortcuts. */
@Component({
  selector: "pc-bazaar-mega-menu",
  imports: [Icon, PcLink, CategoryIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "flex h-full items-end",
    "(blur)": "onBlur($event)",
  },
  template: `
    <button #trigger type="button" (click)="open.set(!open())" [attr.aria-expanded]="open()" aria-haspopup="true" [attr.aria-controls]="open() ? panelId : null"
      (keydown)="onTriggerKey($event)"
      [class]="triggerCls()" data-testid="mega-menu">
      <svg [pcIcon]="LayoutGrid" class="h-[18px] w-[18px]" aria-hidden="true" />
      All categories
      <svg [pcIcon]="ChevronDown" [class]="'h-4 w-4 transition-transform duration-200' + (open() ? ' rotate-180' : '')" aria-hidden="true" />
    </button>
    @if (open()) {
      <div class="absolute inset-x-0 top-full h-screen animate-fade-in bg-ink/30" (click)="open.set(false)" aria-hidden="true"></div>
      <div [id]="panelId" tabindex="-1" class="absolute inset-x-0 top-full animate-rise-in border-t border-line bg-white text-ink shadow-xl outline-none">
        <div class="mx-auto grid max-h-[calc(100vh-9rem)] max-w-shop grid-cols-[minmax(0,1fr)_16rem] gap-8 overflow-y-auto px-4 py-6">
          <div>
            <div class="mb-5 flex items-baseline justify-between gap-4">
              <p class="font-display text-lg font-bold">Shop by category</p>
              <a pcLink="/categories" (click)="open.set(false)" class="inline-flex items-center gap-0.5 text-sm font-semibold text-peacock hover:underline">
                Every category <svg [pcIcon]="ChevronRight" class="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
            @if (categories().length) {
              <ul class="grid grid-cols-3 gap-x-6 gap-y-7 xl:grid-cols-4">
                @for (c of categories(); track c.slug) {
                  <li class="min-w-0">
                    <a [pcLink]="'/c/' + c.slug" (click)="open.set(false)" class="group/cat flex items-center gap-3">
                      <span class="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-peacock/10 text-peacock transition-colors group-hover/cat:bg-peacock group-hover/cat:text-white">
                        @if (c.image_url) {
                          <img [src]="c.image_url" alt="" class="h-full w-full object-cover" />
                        } @else {
                          <svg [pcCategoryIcon]="c.slug" class="h-5 w-5" />
                        }
                      </span>
                      <span class="min-w-0">
                        <span class="block truncate font-display text-[15px] font-semibold leading-snug group-hover/cat:text-peacock">{{ c.name }}</span>
                        @if (c.product_count > 0) {<span class="block text-xs text-ink-faint">{{ count(c.product_count) }} {{ c.product_count === 1 ? "product" : "products" }}</span>}
                      </span>
                    </a>
                    @if (c.children.length > 0) {
                      <ul class="mt-2.5 flex flex-col gap-1 pl-14">
                        @for (ch of c.children.slice(0, 6); track ch.slug) {
                          <li><a [pcLink]="'/c/' + ch.slug" (click)="open.set(false)" class="block truncate text-sm text-ink-soft hover:text-peacock hover:underline">{{ ch.name }}</a></li>
                        }
                      </ul>
                    }
                    <a [pcLink]="'/c/' + c.slug" (click)="open.set(false)" class="ml-14 mt-2 inline-flex items-center gap-0.5 text-sm font-semibold text-peacock hover:underline">
                      See all <span class="sr-only">in {{ c.name }}</span><svg [pcIcon]="ChevronRight" class="h-4 w-4" aria-hidden="true" />
                    </a>
                  </li>
                }
              </ul>
            } @else {
              <div class="grid grid-cols-3 gap-6 xl:grid-cols-4" aria-hidden="true">
                @for (i of [0,1,2,3,4,5,6,7]; track i) {<div class="skeleton h-28 rounded-lg"></div>}
              </div>
            }
          </div>
          <aside class="flex flex-col gap-1 border-l border-line pl-6" aria-label="Shop more">
            <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">Shop more</p>
            @for (s of shortcuts(); track s.href) {
              <a [pcLink]="s.href" (click)="open.set(false)" class="group/more -mx-2 flex items-center gap-3 rounded-lg p-2 hover:bg-mist">
                <span [class]="'flex h-10 w-10 shrink-0 items-center justify-center rounded-full ' + s.tint"><svg [pcIcon]="s.icon" class="h-5 w-5" aria-hidden="true" /></span>
                <span class="min-w-0">
                  <span class="block text-sm font-semibold group-hover/more:text-peacock">{{ s.label }}</span>
                  <span class="block text-xs text-ink-faint">{{ s.note }}</span>
                </span>
              </a>
            }
            @if (extra().length > 0) {
              <div class="mt-3 flex flex-col gap-0.5 border-t border-line pt-3">
                @for (l of extra(); track l.href + $index) {
                  <a [pcLink]="l.href" (click)="open.set(false)" class="-mx-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-mist hover:text-peacock">{{ fill(l.label) }}</a>
                }
              </div>
            }
          </aside>
        </div>
      </div>
    }
  `,
})
export class BazaarMegaMenu {
  readonly categories = input.required<CategoryNode[]>();
  private readonly site = inject(SiteService).site;
  private readonly path = inject(RouteState).pathname;
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly open = signal(false);
  protected readonly panelId = "mega-panel-" + Math.random().toString(36).slice(2, 9);
  protected readonly LayoutGrid = LayoutGrid;
  protected readonly ChevronDown = ChevronDown;
  protected readonly ChevronRight = ChevronRight;
  protected readonly triggerCls = computed(() => cx("flex h-9 items-center gap-2 rounded-t-lg px-3.5 text-sm font-semibold transition-colors",
    this.open() ? "bg-white text-peacock" : "bg-white/10 text-white hover:bg-white/20"));
  protected readonly shortcuts = computed(() => [
    ...(this.site().features.deals !== false ? [{ href: "/deals", label: "Today's deals", note: "Limited-time prices", icon: Flame, tint: "bg-vermilion/10 text-vermilion" }] : []),
    { href: "/bestsellers", label: "Bestsellers", note: "Most bought right now", icon: Trophy, tint: "bg-marigold/25 text-ink" },
    { href: "/new-releases", label: "New releases", note: "Just arrived", icon: Sparkles, tint: "bg-leaf/10 text-leaf" },
  ]);
  protected readonly extra = computed(() => this.site().nav?.drawer_links ?? []);

  constructor() {
    // a new page: close the menu
    let first = true;
    effect(() => {
      this.path();
      if (first) {
        first = false;
        return;
      }
      this.open.set(false);
    });
    // outside click / Escape closes (Escape returns focus to the trigger)
    effect((onCleanup) => {
      if (!this.open()) return;
      const outside = (e: MouseEvent) => {
        if (!this.el.contains(e.target as Node)) this.open.set(false);
      };
      const esc = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        this.open.set(false);
        this.el.querySelector<HTMLButtonElement>("button")?.focus();
      };
      document.addEventListener("mousedown", outside);
      document.addEventListener("keydown", esc);
      onCleanup(() => {
        document.removeEventListener("mousedown", outside);
        document.removeEventListener("keydown", esc);
      });
    });
  }

  protected count(n: number): string {
    return n.toLocaleString("en-IN");
  }
  protected fill(x: string): string {
    return fillTokens(x, this.site());
  }
  protected onBlur(e: FocusEvent): void {
    if (this.open() && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) this.open.set(false);
  }
  protected onTriggerKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    this.open.set(true);
    requestAnimationFrame(() => document.getElementById(this.panelId)?.querySelector<HTMLElement>("a")?.focus());
  }
}

/** Tier 2 on tablets and computers: the All menu (tablets) or the mega menu (computers), links, promotion. */
@Component({
  selector: "pc-bazaar-tier-two",
  imports: [AllMenu, BazaarMegaMenu, BazaarNavLinks, BazaarPromo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="relative hidden bg-peacock-dark text-white md:block">
      <div class="mx-auto flex h-11 max-w-shop items-center gap-2 px-3 sm:px-4">
        @if (allMenu()) {
          <div class="-ml-2 shrink-0 lg:hidden"><pc-all-menu [categories]="categories()" tone="dark" label="All" /></div>
        }
        <div class="hidden h-full shrink-0 lg:block"><pc-bazaar-mega-menu [categories]="categories()" /></div>
        @if (links().length > 0) {
          <nav aria-label="Shop" class="scroll-x flex h-full min-w-0 flex-1 items-center overflow-x-auto lg:pl-1">
            <pc-bazaar-nav-links [links]="links()" />
          </nav>
        }
        @if (!phone()) {<pc-bazaar-promo class="ml-auto text-sm" />}
      </div>
    </div>
  `,
})
export class BazaarTierTwo {
  readonly categories = input.required<CategoryNode[]>();
  readonly links = input.required<LinkItem[]>();
  readonly allMenu = input.required<boolean>();
  readonly phone = input.required<boolean>();
}

/** Phones: the delivery PIN, the promotion and the links in a strip that scrolls sideways. */
@Component({
  selector: "pc-bazaar-phone-strip",
  imports: [DeliverTo, BazaarNavLinks, BazaarPromo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (links().length || pinOn() || promoOn()) {
      <div class="bg-peacock-dark text-white md:hidden">
        <div class="flex h-10 items-center pl-0.5">
          @if (pinOn()) {
            <!-- the PIN button is a full-height touch target in the strip -->
            <div class="[&_[data-testid=deliver-to]]:min-h-10"><pc-deliver-to tone="dark" /></div>
            <span class="mx-0.5 h-4 w-px shrink-0 bg-white/25" aria-hidden="true"></span>
          }
          <nav aria-label="Shop" class="scroll-x flex h-full min-w-0 flex-1 items-center overflow-x-auto pr-2">
            <pc-bazaar-promo class="mx-1 py-0.5 text-[13px]" />
            <pc-bazaar-nav-links [links]="links()" [small]="true" />
          </nav>
        </div>
      </div>
    }
  `,
})
export class BazaarPhoneStrip {
  readonly links = input.required<LinkItem[]>();
  readonly pinOn = input.required<boolean>();
  private readonly site = inject(SiteService).site;
  protected readonly promoOn = computed(() => Boolean(this.site().nav?.promo?.enabled && this.site().nav!.promo.text));
}

@Component({
  selector: "pc-bazaar-header",
  imports: [AnnouncementBar, Logo, DeliverTo, SearchBox, NotificationBell, AccountMenu, ReturnsOrders, WishlistLink, CartLink, AllMenu, BazaarTierTwo, BazaarPhoneStrip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-announcement-bar />
    <!-- the All menu drawer opens inside the header, so the header rises above the phone tab bar while it is open -->
    <header class="sticky top-0 z-30 shadow-md has-[[aria-modal=true]]:z-[60]">
      <div class="bg-peacock text-white">
        <div class="mx-auto flex max-w-shop flex-wrap items-center gap-x-1 gap-y-1.5 px-3 pb-2.5 pt-1.5 sm:gap-x-2 sm:px-4 md:gap-y-2 md:pb-3 md:pt-2 lg:flex-nowrap lg:gap-x-4 lg:py-3">
          <!-- phones: the All menu as an icon here; tablets have it in tier 2 -->
          @if (allMenu()) {
            <div class="-ml-2 md:hidden"><pc-all-menu [categories]="cats()" tone="dark" [iconOnly]="true" /></div>
          }
          <a pcLogo pcLink="/"></a>
          @if (pinOn() && !phone()) {
            <div class="hidden md:block"><pc-deliver-to tone="dark" /></div>
          }
          <!-- one search box: full width on its own row on phones and tablets, centred in the row on computers -->
          <div class="order-last w-full min-w-0 lg:order-none lg:mx-auto lg:w-auto lg:max-w-3xl lg:flex-1">
            <pc-search-box [categories]="cats()" variant="solid" shape="pill" button="accent" />
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
      @if (!phone()) {<pc-bazaar-tier-two [categories]="cats()" [links]="links()" [allMenu]="allMenu()" [phone]="phone()" />}
    </header>
    <pc-bazaar-phone-strip [links]="links()" [pinOn]="pinOn()" />
  `,
})
export class BazaarHeader {
  private readonly categories = inject(CategoriesService);
  protected readonly site = inject(SiteService).site;
  protected readonly cats = this.categories.categories;
  protected readonly phone = phoneSignal();
  protected readonly pinOn = computed(() => this.site().pdp?.header_pincode !== false);
  protected readonly allMenu = computed(() => this.site().nav?.all_menu !== false);
  protected readonly links = computed(() => navLinks(this.site()));
}
