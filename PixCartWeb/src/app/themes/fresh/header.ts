/*
 * Fresh header (quick commerce). The announcement bar, then a sticky white bar: the logo with the delivery PIN, a big
 * soft search, wishlist, notifications, account and a solid cart button. Below it a strip with the All menu, the
 * categories as chips with their icons, and the marketplace's links. On phones the logo row scrolls away while the
 * search and the strip stay pinned, as in shopping apps; the cart is then in the tab bar and the floating cart pill.
 * Port of themes/fresh/header.tsx; behaviour comes from the shared parts (shop-chrome, shop-nav); this file arranges them.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from "@angular/core";
import { ChevronLeft, ChevronRight, Search, ShoppingCart } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { CategoryNode } from "../../core/types";
import { CategoryIcon } from "../../shared/chrome/category-icon";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { AccountMenu, AnnouncementBar, DeliverTo, Logo, NotificationBell, WishlistLink, CategoriesService } from "../../shared/shop/shop-chrome";
import { AllMenu, SearchBox } from "../../shared/shop/shop-nav";
import { itemsLabel } from "./parts";

/** The shopper asked their device for less motion (useReducedMotion). */
function reducedMotionSignal() {
  const reduced = signal<boolean>(typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false);
  if (typeof window !== "undefined") {
    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => reduced.set(e.matches));
  }
  return reduced.asReadonly();
}

/** The solid cart button (tablets and desktops; phones have the tab bar and the floating cart pill). */
@Component({
  selector: "pc-fresh-cart-button",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <a pcLink="/cart" [attr.aria-label]="'Cart, ' + items()" data-testid="header-cart"
      class="pc-press hidden h-11 shrink-0 items-center gap-2 rounded-xl bg-peacock px-3 font-bold text-white shadow-sm transition-colors hover:bg-peacock-dark sm:flex">
      <svg [pcIcon]="ShoppingCart" class="h-5 w-5" aria-hidden="true" />
      <span class="whitespace-nowrap text-sm">{{ session.cartCount() > 0 ? items() : "My cart" }}</span>
    </a>
  `,
})
export class FreshCartButton {
  protected readonly session = inject(SessionService);
  protected readonly ShoppingCart = ShoppingCart;
  protected readonly items = computed(() => itemsLabel(this.session.cartCount()));
}

/** A fade at the end of the strip that has more to show, with an arrow button for mouse users (tablets and up). */
@Component({
  selector: "pc-fresh-scroll-hint",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="'pointer-events-none absolute inset-y-0 flex w-14 items-center from-white via-white/85 to-transparent ' + (side() === 'left' ? 'left-0 justify-start bg-gradient-to-r' : 'right-0 justify-end bg-gradient-to-l')">
      <button type="button" (click)="go.emit()" tabindex="-1" aria-hidden="true"
        class="pointer-events-auto hidden h-8 w-8 items-center justify-center rounded-full bg-white text-ink shadow-md ring-1 ring-line transition-colors hover:bg-mist md:flex">
        <svg [pcIcon]="side() === 'left' ? ChevronLeft : ChevronRight" class="h-4 w-4" />
      </button>
    </div>
  `,
})
export class FreshScrollHint {
  readonly side = input.required<"left" | "right">();
  readonly go = output<void>();
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;
}

function containsSlug(c: CategoryNode, slug: string): boolean {
  return c.slug === slug || c.children.some((ch) => containsSlug(ch, slug));
}

const CHIP = "flex h-10 shrink-0 items-center whitespace-nowrap rounded-full text-[13px] font-semibold transition-colors md:h-9";
const PROMO_TONE = { accent: "bg-marigold text-ink", buy: "bg-vermilion text-white", primary: "bg-peacock text-white", dark: "bg-ink text-white" } as const;

/** The strip under the header: All menu, promotion, categories with icons, then the marketplace's links. */
@Component({
  selector: "pc-fresh-category-strip",
  imports: [Icon, PcLink, CategoryIcon, AllMenu, FreshScrollHint],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="border-b border-line bg-white">
      <div class="mx-auto flex h-12 max-w-shop items-center gap-1 px-3 sm:px-4">
        @if (nav()?.all_menu !== false) {
          <pc-all-menu [categories]="cats()" tone="light" />
          <span class="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden="true"></span>
        }
        <div class="relative min-w-0 flex-1">
          <nav #track aria-label="Shop" class="scroll-x flex items-center gap-1 overflow-x-auto">
            @if (promo(); as p) {
              @if (p.link) {
                <a [pcLink]="p.link" [class]="CHIP + ' px-3 font-bold hover:opacity-90 ' + toneOf(p.tone)" data-testid="nav-promo">{{ t(p.text) }}</a>
              } @else {
                <span [class]="CHIP + ' px-3 font-bold ' + toneOf(p.tone)" data-testid="nav-promo">{{ t(p.text) }}</span>
              }
            }
            @if (showCats()) {
              @for (c of cats(); track c.slug) {
                <a [pcLink]="'/c/' + c.slug" [attr.aria-current]="on(c) ? (current() === c.slug ? 'page' : 'true') : null"
                  [class]="CHIP + ' gap-1.5 pl-1 pr-3 ' + (on(c) ? 'bg-peacock-light text-peacock-dark' : 'text-ink-soft hover:bg-mist hover:text-ink')">
                  <span [class]="'flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-peacock ' + (on(c) ? 'bg-white' : 'bg-peacock-light')">
                    @if (c.image_url) {
                      <img [src]="c.image_url" alt="" class="h-full w-full object-cover" />
                    } @else {
                      <svg [pcCategoryIcon]="c.slug" class="h-4 w-4" />
                    }
                  </span>
                  {{ c.name }}
                </a>
              }
              @if (links().length > 0) {<span class="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true"></span>}
            }
            @for (l of links(); track l.href + l.label) {
              <a [pcLink]="l.href" [attr.aria-current]="linkOn(l.href) ? 'page' : null"
                [class]="CHIP + ' px-3 ' + (linkOn(l.href) ? 'bg-peacock-light text-peacock-dark' : 'text-ink-soft hover:bg-mist hover:text-ink')">
                {{ t(l.label) }}
              </a>
            }
          </nav>
          @if (!edges().start) {<pc-fresh-scroll-hint side="left" (go)="scroll(-1)" />}
          @if (!edges().end) {<pc-fresh-scroll-hint side="right" (go)="scroll(1)" />}
        </div>
        @if (site().header_links.length > 0) {
          <nav aria-label="More" class="ml-1 hidden shrink-0 items-center gap-1 border-l border-line pl-2 lg:flex">
            @for (l of site().header_links; track l.href + l.label) {
              <a [pcLink]="l.href" class="rounded-full px-3 py-1.5 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-mist hover:text-peacock">{{ t(l.label) }}</a>
            }
          </nav>
        }
      </div>
    </div>
  `,
})
export class FreshCategoryStrip {
  readonly cats = input.required<CategoryNode[]>();
  protected readonly site = inject(SiteService).site;
  protected readonly nav = computed(() => this.site().nav);
  private readonly path = inject(RouteState).pathname;
  private readonly trackRef = viewChild<ElementRef<HTMLElement>>("track");
  protected readonly CHIP = CHIP;
  protected readonly edges = signal({ start: true, end: true });
  protected readonly showCats = computed(() => this.nav()?.show_categories !== false && this.cats().length > 0);
  protected readonly links = computed(() => this.nav()?.links ?? []);
  protected readonly promo = computed(() => {
    const p = this.nav()?.promo;
    return p?.enabled && p.text ? p : null;
  });
  protected readonly current = computed(() => (this.path().startsWith("/c/") ? this.path().split("/")[2] ?? "" : ""));

  constructor() {
    // scroll edges (for the arrows and edge fades)
    effect((onCleanup) => {
      this.cats().length;
      this.links().length;
      const el = this.trackRef()?.nativeElement;
      if (!el) return;
      const update = () => {
        const start = el.scrollLeft <= 4;
        const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
        const e = this.edges();
        if (e.start !== start || e.end !== end) this.edges.set({ start, end });
      };
      const frame = requestAnimationFrame(update);
      el.addEventListener("scroll", update, { passive: true });
      const ro = new ResizeObserver(update);
      ro.observe(el);
      document.fonts?.ready.then(update).catch(() => {});
      onCleanup(() => {
        cancelAnimationFrame(frame);
        el.removeEventListener("scroll", update);
        ro.disconnect();
      });
    });
    // bring the chip of the page you are on into view
    effect(() => {
      this.path();
      this.cats().length;
      const el = this.trackRef()?.nativeElement;
      const chip = el?.querySelector<HTMLElement>("[aria-current]");
      if (!el || !chip) return;
      el.scrollTo({ left: Math.max(0, chip.offsetLeft - (el.clientWidth - chip.offsetWidth) / 2) });
    });
  }

  protected t(x: string): string {
    return fillTokens(x, this.site());
  }
  protected toneOf(tone: "accent" | "buy" | "primary" | "dark"): string {
    return PROMO_TONE[tone] ?? PROMO_TONE.accent;
  }
  protected on(c: CategoryNode): boolean {
    return this.current() !== "" && containsSlug(c, this.current());
  }
  protected linkOn(href: string): boolean {
    const p = this.path();
    return href !== "/" && (p === href || p.startsWith(`${href}/`));
  }
  protected scroll(dir: number): void {
    const el = this.trackRef()?.nativeElement;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: "smooth" });
  }
}

@Component({
  selector: "pc-fresh-header",
  imports: [AnnouncementBar, Logo, DeliverTo, SearchBox, WishlistLink, NotificationBell, AccountMenu, FreshCartButton, FreshCategoryStrip, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-announcement-bar />
    <!-- Phones: the 64 px logo row scrolls away (negative sticky top); the search and the strip stay pinned. -->
    <header class="sticky z-30 bg-white max-sm:-top-16 sm:top-0">
      <div class="border-b border-line">
        <div class="mx-auto flex max-w-shop flex-wrap items-center gap-x-2 px-3 sm:px-4 md:flex-nowrap md:gap-x-4">
          <div class="flex h-16 min-w-0 shrink-0 flex-col items-start justify-center lg:flex-row lg:items-center lg:gap-3">
            <a pcLogo pcLink="/" [light]="false"></a>
            @if (pin()) {
              <span class="hidden h-7 w-px bg-line lg:block" aria-hidden="true"></span>
              <div class="-ml-2.5 lg:ml-0"><pc-deliver-to tone="light" /></div>
            }
          </div>
          <!-- One search box for every width: its own row on phones, inline from tablets up. With the category
               picker showing, the search icon moves to the right end so it never sits over the picker. -->
          <div [class]="'relative order-last w-full min-w-0 pb-2.5 md:order-none md:w-auto md:max-w-3xl md:flex-1 md:pb-0' + (picker() ? ' max-sm:[&_select]:hidden sm:[&_select~input]:pl-3 sm:[&_select~input]:pr-11 sm:[&_select~svg]:hidden' : '')"
            (focusin)="paused.set(true)" (focusout)="paused.set(false)">
            <pc-search-box [categories]="cats()" variant="soft" shape="pill" button="plain" [placeholder]="placeholder()" />
            @if (picker()) {<svg [pcIcon]="Search" class="pointer-events-none absolute right-4 top-3 hidden h-5 w-5 text-ink-faint sm:block" aria-hidden="true" />}
          </div>
          <div class="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
            <pc-wishlist-link tone="light" />
            <pc-notification-bell [dark]="true" />
            <pc-account-menu tone="light" [compact]="true" />
            <pc-fresh-cart-button />
          </div>
        </div>
      </div>
      <pc-fresh-category-strip [cats]="cats()" />
    </header>
  `,
})
export class FreshHeader {
  private readonly categories = inject(CategoriesService);
  protected readonly site = inject(SiteService).site;
  protected readonly cats = this.categories.categories;
  protected readonly Search = Search;
  protected readonly pin = computed(() => this.site().pdp?.header_pincode !== false);
  /** The search's category picker (when on) shows from tablets up; phones get a plain search with its icon. */
  protected readonly picker = computed(() => this.site().nav?.search_categories !== false && this.cats().length > 0);
  private readonly reduced = reducedMotionSignal();
  protected readonly paused = signal(false);
  private readonly i = signal(0);
  private readonly terms = computed(() => this.site().nav?.trending ?? []);
  /** Cycles the search placeholder through the trending searches (paused while the search has focus or motion is reduced). */
  protected readonly placeholder = computed(() => {
    const terms = this.terms();
    const term = terms.length ? terms[this.i() % terms.length] : "";
    return term ? `Search for “${term}”` : undefined;
  });

  constructor() {
    effect((onCleanup) => {
      const count = this.terms().length;
      if (this.reduced() || this.paused() || count < 2) return;
      const id = setInterval(() => this.i.set((this.i() + 1) % count), 3200);
      onCleanup(() => clearInterval(id));
    });
  }
}
