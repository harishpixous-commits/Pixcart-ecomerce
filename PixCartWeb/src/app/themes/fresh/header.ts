/*
 * Fresh header (quick commerce). The announcement bar, then a sticky white bar: the logo with the delivery PIN, a big
 * soft search, wishlist, notifications, account and a solid cart button. Below it a strip with the All menu, the
 * categories as chips with their icons, and the marketplace's links. On phones the logo row scrolls away while the
 * search and the strip stay pinned, as in shopping apps; the cart is then in the tab bar and the floating cart pill.
 * Behaviour comes from the shared parts (shop-chrome, shop-nav); this file only arranges them. Port of themes/fresh/header.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from "@angular/core";
import { ChevronLeft, ChevronRight, Search, ShoppingCart } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { CategoryNode } from "../../core/types";
import { CategoryIcon } from "../../shared/chrome/category-icon";
import { AccountMenu, AnnouncementBar, CategoriesService, DeliverTo, Logo, NotificationBell, WishlistLink } from "../../shared/shop/shop-chrome";
import { AllMenu, SearchBox } from "../../shared/shop/shop-nav";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { itemsLabel } from "./parts";

/** The shopper asked their device for less motion (follows the setting). */
function reducedMotionSignal() {
  const m = window.matchMedia("(prefers-reduced-motion: reduce)");
  const s = signal(m.matches);
  const onChange = () => s.set(m.matches);
  m.addEventListener("change", onChange);
  inject(DestroyRef).onDestroy(() => m.removeEventListener("change", onChange));
  return s.asReadonly();
}

function containsSlug(c: CategoryNode, slug: string): boolean {
  return c.slug === slug || c.children.some((ch) => containsSlug(ch, slug));
}

const CHIP = "flex h-10 shrink-0 items-center whitespace-nowrap rounded-full text-[13px] font-semibold transition-colors md:h-9";
const PROMO_TONE: Record<string, string> = { accent: "bg-marigold text-ink", buy: "bg-vermilion text-white", primary: "bg-peacock text-white", dark: "bg-ink text-white" };
const HINT = "pointer-events-none absolute inset-y-0 flex w-14 items-center from-white via-white/85 to-transparent";
const HINT_BTN = "pointer-events-auto hidden h-8 w-8 items-center justify-center rounded-full bg-white text-ink shadow-md ring-1 ring-line transition-colors hover:bg-mist md:flex";

/** The strip under the header: All menu, promotion, categories with icons, then the marketplace's links. */
@Component({
  selector: "pc-fresh-category-strip",
  imports: [Icon, PcLink, AllMenu, CategoryIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="border-b border-line bg-white">
      <div class="mx-auto flex h-12 max-w-shop items-center gap-1 px-3 sm:px-4">
        @if (site().nav?.all_menu !== false) {
          <pc-all-menu [categories]="cats()" tone="light" />
          <span class="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden="true"></span>
        }
        <div class="relative min-w-0 flex-1">
          <nav #track aria-label="Shop" class="scroll-x flex items-center gap-1 overflow-x-auto" (scroll)="update()">
            @if (promo(); as pr) {
              @if (pr.link) {
                <a [pcLink]="pr.link" [class]="CHIP + ' px-3 font-bold hover:opacity-90 ' + promoTone()" data-testid="nav-promo">{{ t(pr.text) }}</a>
              } @else {
                <span [class]="CHIP + ' px-3 font-bold ' + promoTone()" data-testid="nav-promo">{{ t(pr.text) }}</span>
              }
            }
            @if (showCats()) {
              @for (c of cats(); track c.slug) {
                <a [pcLink]="'/c/' + c.slug" [attr.aria-current]="on(c) ? (current() === c.slug ? 'page' : 'true') : null"
                  [class]="CHIP + ' gap-1.5 pl-1 pr-3 ' + (on(c) ? 'bg-peacock-light text-peacock-dark' : 'text-ink-soft hover:bg-mist hover:text-ink')">
                  <span [class]="on(c) ? 'flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-peacock bg-white' : 'flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-peacock bg-peacock-light'">
                    @if (c.image_url) {<img [src]="c.image_url" alt="" class="h-full w-full object-cover" />}
                    @else {<svg [pcCategoryIcon]="c.slug" class="h-4 w-4" />}
                  </span>
                  {{ c.name }}
                </a>
              }
            }
            @if (showCats() && links().length > 0) {<span class="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true"></span>}
            @for (l of links(); track l.href + l.label) {
              <a [pcLink]="l.href" [attr.aria-current]="linkOn(l.href) ? 'page' : null"
                [class]="CHIP + ' px-3 ' + (linkOn(l.href) ? 'bg-peacock-light text-peacock-dark' : 'text-ink-soft hover:bg-mist hover:text-ink')">{{ t(l.label) }}</a>
            }
          </nav>
          @if (!edges().start) {
            <div [class]="HINT + ' left-0 justify-start bg-gradient-to-r'">
              <button type="button" (click)="scroll(-1)" tabindex="-1" aria-hidden="true" [class]="HINT_BTN"><svg [pcIcon]="ChevronLeft" class="h-4 w-4" /></button>
            </div>
          }
          @if (!edges().end) {
            <div [class]="HINT + ' right-0 justify-end bg-gradient-to-l'">
              <button type="button" (click)="scroll(1)" tabindex="-1" aria-hidden="true" [class]="HINT_BTN"><svg [pcIcon]="ChevronRight" class="h-4 w-4" /></button>
            </div>
          }
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
  protected readonly site = inject(SiteService).site;
  protected readonly cats = inject(CategoriesService).categories;
  private readonly path = inject(RouteState).pathname;
  private readonly track = viewChild<ElementRef<HTMLElement>>("track");
  protected readonly edges = signal({ start: true, end: true });
  protected readonly CHIP = CHIP;
  protected readonly HINT = HINT;
  protected readonly HINT_BTN = HINT_BTN;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;
  protected readonly showCats = computed(() => this.site().nav?.show_categories !== false && this.cats().length > 0);
  protected readonly links = computed(() => this.site().nav?.links ?? []);
  protected readonly current = computed(() => (this.path().startsWith("/c/") ? this.path().split("/")[2] ?? "" : ""));
  protected readonly promo = computed(() => (this.site().nav?.promo?.enabled && this.site().nav?.promo?.text ? this.site().nav!.promo : null));
  protected readonly promoTone = computed(() => PROMO_TONE[this.promo()?.tone ?? "accent"] ?? PROMO_TONE["accent"]);

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.track()?.nativeElement;
      if (!el) return;
      const ro = new ResizeObserver(() => this.update());
      ro.observe(el);
      requestAnimationFrame(() => this.update());
      document.fonts?.ready.then(() => this.update()).catch(() => {});
      destroy.onDestroy(() => ro.disconnect());
    });
    // Bring the chip of the page you are on into view (a category far along the strip, say).
    effect(() => {
      this.path();
      this.cats().length;
      this.links().length;
      untracked(() => requestAnimationFrame(() => {
        const el = this.track()?.nativeElement;
        this.update();
        const chip = el?.querySelector<HTMLElement>("[aria-current]");
        if (!el || !chip) return;
        el.scrollTo({ left: Math.max(0, chip.offsetLeft - (el.clientWidth - chip.offsetWidth) / 2) });
      }));
    });
  }

  protected update(): void {
    const el = this.track()?.nativeElement;
    if (!el) return;
    const start = el.scrollLeft <= 4;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    const e = this.edges();
    if (e.start !== start || e.end !== end) this.edges.set({ start, end });
  }

  protected on(c: CategoryNode): boolean {
    return this.current() !== "" && containsSlug(c, this.current());
  }

  protected linkOn(href: string): boolean {
    const p = this.path();
    return href !== "/" && (p === href || p.startsWith(`${href}/`));
  }

  protected t(x: string): string {
    return fillTokens(x, this.site());
  }

  protected scroll(dir: number): void {
    const el = this.track()?.nativeElement;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: "smooth" });
  }
}

@Component({
  selector: "pc-fresh-header",
  imports: [Icon, PcLink, Logo, AnnouncementBar, DeliverTo, SearchBox, WishlistLink, NotificationBell, AccountMenu, FreshCategoryStrip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-announcement-bar />
    <header class="sticky z-30 bg-white max-sm:-top-16 sm:top-0">
      <div class="border-b border-line">
        <div class="mx-auto flex max-w-shop flex-wrap items-center gap-x-2 px-3 sm:px-4 md:flex-nowrap md:gap-x-4">
          <div class="flex h-16 min-w-0 shrink-0 flex-col items-start justify-center lg:flex-row lg:items-center lg:gap-3">
            <a pcLogo [light]="false"></a>
            @if (pin()) {
              <span class="hidden h-7 w-px bg-line lg:block" aria-hidden="true"></span>
              <div class="-ml-2.5 lg:ml-0"><pc-deliver-to tone="light" /></div>
            }
          </div>
          <div [class]="searchCls()" (focusin)="paused.set(true)" (focusout)="paused.set(false)">
            <form pcSearchBox [categories]="cats()" variant="soft" shape="pill" button="plain" [placeholder]="placeholder()"></form>
            @if (picker()) {<svg [pcIcon]="Search" class="pointer-events-none absolute right-4 top-3 hidden h-5 w-5 text-ink-faint sm:block" />}
          </div>
          <div class="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
            <pc-wishlist-link tone="light" />
            <pc-notification-bell [dark]="true" />
            <pc-account-menu tone="light" [compact]="true" />
            <a pcLink="/cart" [attr.aria-label]="'Cart, ' + items()" data-testid="header-cart"
              class="pc-press hidden h-11 shrink-0 items-center gap-2 rounded-xl bg-peacock px-3 font-bold text-white shadow-sm transition-colors hover:bg-peacock-dark sm:flex">
              <svg [pcIcon]="ShoppingCart" class="h-5 w-5" />
              <span class="whitespace-nowrap text-sm">{{ session.cartCount() > 0 ? items() : "My cart" }}</span>
            </a>
          </div>
        </div>
      </div>
      <pc-fresh-category-strip />
    </header>
  `,
})
export class FreshHeader {
  protected readonly cats = inject(CategoriesService).categories;
  private readonly site = inject(SiteService).site;
  protected readonly session = inject(SessionService);
  private readonly reduced = reducedMotionSignal();
  protected readonly paused = signal(false);
  private readonly i = signal(0);
  protected readonly Search = Search;
  protected readonly ShoppingCart = ShoppingCart;
  protected readonly pin = computed(() => this.site().pdp?.header_pincode !== false);
  // The search's category picker (when on) shows from tablets up; phones get a plain search with its icon.
  protected readonly picker = computed(() => this.site().nav?.search_categories !== false && this.cats().length > 0);
  protected readonly items = computed(() => itemsLabel(this.session.cartCount()));
  private readonly terms = computed(() => this.site().nav?.trending ?? []);
  /** Cycles the search placeholder through the trending searches (paused while the search has focus or motion is reduced). */
  protected readonly placeholder = computed(() => {
    const terms = this.terms();
    const term = terms.length ? terms[this.i() % terms.length] : "";
    return term ? `Search for “${term}”` : undefined;
  });
  protected readonly searchCls = computed(() =>
    cx("relative order-last w-full min-w-0 pb-2.5 md:order-none md:w-auto md:max-w-3xl md:flex-1 md:pb-0",
      this.picker() && "max-sm:[&_select]:hidden sm:[&_select~input]:pl-3 sm:[&_select~input]:pr-11 sm:[&_select~svg]:hidden"));

  constructor() {
    effect((onCleanup) => {
      if (this.reduced() || this.paused() || this.terms().length < 2) return;
      const count = this.terms().length;
      const id = setInterval(() => this.i.update((x) => (x + 1) % count), 3200);
      onCleanup(() => clearInterval(id));
    });
  }
}
