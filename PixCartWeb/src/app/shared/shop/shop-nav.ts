/*
 * Header navigation: search with a category picker and recent/trending suggestions, the "All" side menu and the
 * second bar with the marketplace's links and an optional promotion. All of it is set in Admin → Storefront → Navigation.
 * Port of components/shop-nav.tsx:
 *   <pc-search-box [categories] variant shape button [placeholder]>, <pc-all-menu [categories] tone [label] [iconOnly]>,
 *   <pc-nav-bar [categories]> (project the deliver-to button), <pc-returns-orders tone>.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, type WritableSignal } from "@angular/core";
import { Router } from "@angular/router";
import { ChevronRight, Clock, LayoutGrid, Menu, Search, TrendingUp, User as UserIcon, X } from "lucide-angular";
import { api } from "../../core/api";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { CategoryNode } from "../../core/types";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";

const RECENT = "pc_recent_searches";

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) || "[]");
  } catch {
    return [];
  }
}

function saveRecent(q: string, max: number) {
  if (max <= 0) return;
  try {
    const list = [q, ...readRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, max);
    localStorage.setItem(RECENT, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

interface Suggest {
  products: { title: string; slug: string }[];
  categories: { name: string; slug: string }[];
}

/**
 * The search box with suggestions. Themes pick its look:
 * variant "solid" (white, on a coloured header), "soft" (grey, on a white header) or "outline" (white with a border);
 * shape "rounded" or "pill"; button "accent" (a coloured search button) or "plain" (an icon only).
 */
@Component({
  selector: "pc-search-box",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="go(q(), $event)" role="search" [class]="formCls()">
      @if (site().nav?.search_categories !== false && categories().length > 0) {
        <label for="search-cat" class="sr-only">Search in</label>
        <select id="search-cat" [value]="cat()" (change)="cat.set($any($event.target).value)" [class]="selectCls()">
          <option value="">All</option>
          @for (c of categories(); track c.slug) {<option [value]="c.slug" [selected]="c.slug === cat()">{{ c.name }}</option>}
        </select>
      }
      @if (button() === "plain") {<svg [pcIcon]="Search" class="pointer-events-none absolute left-3.5 top-3 h-5 w-5 text-ink-faint" aria-hidden="true" />}
      <label for="site-search" class="sr-only">Search products</label>
      <input
        id="site-search"
        [value]="q()"
        (input)="onChange($any($event.target).value)"
        (focus)="onFocus()"
        (blur)="onBlur()"
        [placeholder]="placeholder() ?? 'Search ' + (site().brand_name || 'the store')"
        autocomplete="off"
        [class]="inputCls()"
      />
      @if (button() === "accent") {
        <button type="submit" aria-label="Search" [class]="'pc-press absolute right-1 top-1 flex h-9 w-10 items-center justify-center bg-marigold text-ink hover:bg-marigold-dark ' + (pill() ? 'rounded-full' : 'rounded-md')">
          <svg [pcIcon]="Search" class="h-5 w-5" />
        </button>
      }
      @if (open() && (empty() ? recent().length > 0 || trending().length > 0 : sugg().products.length > 0 || sugg().categories.length > 0)) {
        <div class="absolute left-0 right-0 top-12 z-40 animate-rise-in overflow-hidden rounded-lg bg-white py-1 text-ink shadow-xl ring-1 ring-line" data-testid="search-suggestions">
          @if (empty()) {
            @if (recent().length > 0) {
              <div>
                <p class="flex items-center justify-between px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Recent searches
                  <button type="button" (mousedown)="clearRecent($event)" class="normal-case tracking-normal text-peacock">Clear</button>
                </p>
                @for (r of recent(); track r) {
                  <button type="button" (mousedown)="pick(r, $event)" class="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-mist">
                    <svg [pcIcon]="Clock" class="h-4 w-4 text-ink-faint" /> {{ r }}
                  </button>
                }
              </div>
            }
            @if (trending().length > 0) {
              <div>
                <p class="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Trending</p>
                @for (t of trending(); track t) {
                  <button type="button" (mousedown)="pick(t, $event)" class="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-mist">
                    <svg [pcIcon]="TrendingUp" class="h-4 w-4 text-ink-faint" /> {{ t }}
                  </button>
                }
              </div>
            }
          } @else {
            <ul>
              @for (c of sugg().categories; track c.slug) {
                <li><a [pcLink]="'/c/' + c.slug" class="flex items-center gap-2 px-4 py-2 hover:bg-mist"><svg [pcIcon]="LayoutGrid" class="h-4 w-4 text-ink-faint" />{{ c.name }}</a></li>
              }
              @for (p of sugg().products; track p.slug) {
                <li>
                  <a [pcLink]="'/p/' + p.slug" (mousedown)="saveRecent(q().trim(), lists().recent_searches_max)" class="flex items-center gap-2 px-4 py-2 hover:bg-mist">
                    <svg [pcIcon]="Search" class="h-4 w-4 text-ink-faint" /><span class="truncate">{{ p.title }}</span>
                  </a>
                </li>
              }
            </ul>
          }
        </div>
      }
    </form>
  `,
})
export class SearchBox {
  readonly categories = input<CategoryNode[]>([]);
  readonly variant = input<"solid" | "soft" | "outline">("solid");
  readonly shape = input<"rounded" | "pill">("rounded");
  readonly button = input<"accent" | "plain">("accent");
  readonly placeholder = input<string>();
  protected readonly site = inject(SiteService).site;
  protected readonly lists = inject(SiteService).lists;
  private readonly route = inject(RouteState);
  private readonly router = inject(Router);
  protected readonly q = signal(this.route.param("q") ?? "");
  protected readonly cat = signal(this.route.param("category") ?? "");
  protected readonly open = signal(false);
  protected readonly recent = signal<string[]>([]);
  protected readonly sugg = signal<Suggest>({ products: [], categories: [] });
  private timer: ReturnType<typeof setTimeout> | undefined;
  protected readonly Search = Search;
  protected readonly Clock = Clock;
  protected readonly TrendingUp = TrendingUp;
  protected readonly LayoutGrid = LayoutGrid;
  protected readonly empty = computed(() => this.q().trim().length < 2);
  protected readonly trending = computed(() => this.site().nav?.trending ?? []);
  protected readonly pill = computed(() => this.shape() === "pill");
  protected readonly formCls = computed(() => cx("relative flex w-full focus-within:ring-2", this.pill() ? "rounded-full" : "rounded-lg",
    this.variant() === "solid" && "bg-white focus-within:ring-marigold",
    this.variant() === "soft" && "bg-mist ring-1 ring-line focus-within:bg-white focus-within:ring-peacock",
    this.variant() === "outline" && "bg-white ring-1 ring-line focus-within:ring-ink"));
  protected readonly selectCls = computed(() => cx("h-11 max-w-[30%] shrink-0 cursor-pointer border-r border-line px-2 text-[13px] text-ink-soft hover:bg-line/60 focus:outline-none sm:max-w-[160px]",
    this.pill() ? "rounded-l-full pl-4" : "rounded-l-lg", this.variant() === "soft" ? "bg-transparent" : "bg-mist"));
  protected readonly inputCls = computed(() => cx("h-11 min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-faint focus:outline-none",
    this.button() === "plain" ? "pl-11 pr-4" : "pl-3 pr-12", this.pill() && this.button() !== "plain" && "pl-4"));
  protected readonly saveRecent = saveRecent;

  constructor() {
    // the address changed (back button, a link): show its search
    let shown = this.q();
    effect(() => {
      const pq = this.route.params().get("q") ?? "";
      if (pq !== shown) {
        shown = pq;
        this.q.set(pq);
      }
    });
  }

  protected onChange(v: string): void {
    this.q.set(v);
    this.open.set(true);
    clearTimeout(this.timer);
    if (v.trim().length < 2) {
      this.sugg.set({ products: [], categories: [] });
      return;
    }
    this.timer = setTimeout(() => {
      api<Suggest>("/api/catalog/suggest", { query: { q: v.trim() } }).then((s) => this.sugg.set(s)).catch(() => {});
    }, 160);
  }

  protected onFocus(): void {
    this.recent.set(readRecent().slice(0, this.lists().recent_searches_max));
    this.open.set(true);
  }

  protected onBlur(): void {
    setTimeout(() => this.open.set(false), 150);
  }

  protected pick(text: string, e: Event): void {
    e.preventDefault();
    this.q.set(text);
    this.go(text, e);
  }

  protected clearRecent(e: Event): void {
    e.preventDefault();
    try {
      localStorage.removeItem(RECENT);
    } catch {
      /* ignore */
    }
    this.recent.set([]);
  }

  protected go(text: string, e?: Event): void {
    e?.preventDefault();
    const t = text.trim();
    this.open.set(false);
    if (!t) return;
    saveRecent(t, this.lists().recent_searches_max);
    const target = `/search?q=${encodeURIComponent(t)}${this.cat() ? `&category=${encodeURIComponent(this.cat())}` : ""}`;
    if (location.pathname + location.search !== target) window.dispatchEvent(new Event("route-progress:start"));
    void this.router.navigateByUrl(target);
  }
}

/**
 * The "All" side menu: account, popular pages, every category, programmes and help.
 * tone "dark" for a trigger on a coloured header; label changes the trigger text; iconOnly shows just the icon.
 */
@Component({
  selector: "pc-all-menu",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button type="button" (click)="open.set(true)" aria-haspopup="dialog" data-testid="all-menu" [attr.aria-label]="iconOnly() ? 'Menu' : null" [class]="triggerCls()">
      <svg [pcIcon]="Menu" class="h-5 w-5" /> @if (!iconOnly()) { {{ label() }} }
    </button>
    @if (open()) {
      <div class="fixed inset-0 z-[60] flex" role="dialog" aria-modal="true" aria-label="All categories and pages">
        <div class="absolute inset-0 animate-fade-in bg-ink/60" (click)="open.set(false)"></div>
        <nav class="relative flex h-full w-[86%] max-w-[365px] animate-rise-in flex-col overflow-y-auto bg-white shadow-2xl">
          <div class="sticky top-0 z-10 flex items-center gap-2 bg-peacock px-6 py-4 text-white">
            <svg [pcIcon]="UserIcon" class="h-7 w-7 rounded-full bg-white/20 p-1" />
            @if (session.user()) {
              <span class="text-lg font-semibold">Hello, {{ first() || "there" }}</span>
            } @else {
              <a [pcLink]="'/login?next=' + enc(path())" class="text-lg font-semibold">Hello, sign in</a>
            }
          </div>
          @if (site().nav?.links?.length) {
            <section class="border-b border-line py-2">
              <h2 class="px-6 py-2 text-lg font-semibold">Trending</h2>
              @for (l of site().nav!.links; track l.href) {<a [pcLink]="l.href" [class]="row">{{ t(l.label) }}</a>}
            </section>
          }
          <section class="border-b border-line py-2">
            <h2 class="px-6 py-2 text-lg font-semibold">Shop by category</h2>
            @for (c of categories(); track c.slug) {
              <div>
                @if (c.children.length) {
                  <button type="button" [class]="row" [attr.aria-expanded]="expanded() === c.slug" (click)="expanded.set(expanded() === c.slug ? null : c.slug)">
                    {{ c.name }}<svg [pcIcon]="ChevronRight" [class]="'h-4 w-4 text-ink-faint transition' + (expanded() === c.slug ? ' rotate-90' : '')" />
                  </button>
                } @else {
                  <a [pcLink]="'/c/' + c.slug" [class]="row">{{ c.name }}</a>
                }
                @if (expanded() === c.slug) {
                  <div class="bg-mist/60 pb-1">
                    <a [pcLink]="'/c/' + c.slug" class="block px-9 py-2 text-sm font-semibold text-peacock hover:underline">All of {{ c.name }}</a>
                    @for (ch of c.children; track ch.slug) {<a [pcLink]="'/c/' + ch.slug" class="block px-9 py-2 text-sm hover:bg-mist">{{ ch.name }}</a>}
                  </div>
                }
              </div>
            }
          </section>
          <section class="border-b border-line py-2">
            <h2 class="px-6 py-2 text-lg font-semibold">Programs and features</h2>
            @for (l of site().nav?.drawer_links ?? []; track l.href + l.label) {<a [pcLink]="l.href" [class]="row">{{ t(l.label) }}</a>}
            @if (site().features.wishlist) {<a pcLink="/wishlist" [class]="row">Your wishlist</a>}
          </section>
          <section class="py-2">
            <h2 class="px-6 py-2 text-lg font-semibold">Help and settings</h2>
            <a pcLink="/account" [class]="row">Your account</a>
            <a pcLink="/orders" [class]="row">Your orders</a>
            <a pcLink="/help" [class]="row">Customer service</a>
            @if (session.user()) {
              <button type="button" (click)="open.set(false); session.signOut()" [class]="row">Sign out</button>
            } @else {
              <a [pcLink]="'/login?next=' + enc(path())" [class]="row">Sign in</a>
            }
          </section>
        </nav>
        <button type="button" (click)="open.set(false)" aria-label="Close menu" class="relative ml-2 mt-3 h-10 w-10 rounded-full text-white hover:bg-white/10"><svg [pcIcon]="X" class="mx-auto h-7 w-7" /></button>
      </div>
    }
  `,
})
export class AllMenu {
  readonly categories = input<CategoryNode[]>([]);
  readonly tone = input<"dark" | "light">("light");
  readonly label = input("All");
  readonly iconOnly = input(false);
  protected readonly site = inject(SiteService).site;
  protected readonly session = inject(SessionService);
  protected readonly path = inject(RouteState).pathname;
  protected readonly open = signal(false);
  protected readonly expanded = signal<string | null>(null);
  protected readonly Menu = Menu;
  protected readonly X = X;
  protected readonly UserIcon = UserIcon;
  protected readonly ChevronRight = ChevronRight;
  protected readonly enc = encodeURIComponent;
  protected readonly row = "flex w-full items-center justify-between px-6 py-2.5 text-left text-[15px] hover:bg-mist";
  protected readonly first = computed(() => this.session.user()?.name?.split(" ")[0] ?? "");
  protected readonly triggerCls = computed(() => cx("flex shrink-0 items-center gap-1 rounded px-2 py-1 font-semibold",
    this.tone() === "dark" ? "text-white hover:bg-white/10" : "text-ink hover:bg-peacock-light hover:text-peacock", this.iconOnly() && "h-10 w-10 justify-center px-0"));

  constructor() {
    closeOnEscapeAndLockBody(this.open);
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
  }

  protected t(x: string): string {
    return fillTokens(x, this.site());
  }
}

/** Escape closes + body scroll locks while `open()` is true (the reference's menu effect). */
function closeOnEscapeAndLockBody(open: WritableSignal<boolean>) {
  effect((onCleanup) => {
    if (!open()) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") open.set(false);
    };
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    });
  });
}

/** The second header bar: All menu, delivery PIN, the marketplace's links, categories and a promotion. */
@Component({
  selector: "pc-nav-bar",
  imports: [Icon, PcLink, AllMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="mx-auto flex max-w-shop items-center gap-1 px-3 pb-2 pt-4 sm:px-4">
      @if (nav()?.all_menu !== false) {<pc-all-menu [categories]="categories()" />}
      <ng-content />
      <span class="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true"></span>
      <nav class="scroll-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Shop">
        @for (l of nav()?.links ?? []; track l.href + l.label) {
          <a [pcLink]="l.href" class="shrink-0 rounded-full px-3 py-1 text-[15px] font-semibold text-ink hover:bg-peacock-light hover:text-peacock">{{ t(l.label) }}</a>
        }
        @if (nav()?.show_categories !== false) {
          @for (c of categories(); track c.slug) {
            <a [pcLink]="'/c/' + c.slug" class="shrink-0 rounded-full px-3 py-1 text-[15px] font-medium text-ink-soft hover:bg-peacock-light hover:text-peacock">{{ c.name }}</a>
          }
        }
      </nav>
      @if (nav()?.promo?.enabled && nav()!.promo.text) {
        @if (nav()!.promo.link) {
          <a [pcLink]="nav()!.promo.link" [class]="promoCls()" data-testid="nav-promo">{{ t(nav()!.promo.text) }}</a>
        } @else {
          <span [class]="promoCls()" data-testid="nav-promo">{{ t(nav()!.promo.text) }}</span>
        }
      }
    </div>
  `,
})
export class NavBar {
  readonly categories = input<CategoryNode[]>([]);
  protected readonly site = inject(SiteService).site;
  protected readonly nav = computed(() => this.site().nav);
  protected readonly promoCls = computed(() => {
    const tone = { accent: "bg-marigold text-ink", buy: "bg-vermilion text-white", primary: "bg-peacock text-white", dark: "bg-ink text-white" }[
      this.nav()?.promo?.tone ?? "accent"
    ];
    return cx("hidden shrink-0 rounded-full px-3 py-1 text-sm font-bold lg:block", tone);
  });

  protected t(x: string): string {
    return fillTokens(x, this.site());
  }
}

@Component({
  selector: "pc-returns-orders",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <a pcLink="/orders" [class]="cls()">
      <span [class]="'text-xs ' + (tone() === 'dark' ? 'text-white/80' : 'text-ink-faint')">Returns</span>
      <span class="text-sm font-semibold">&amp; Orders</span>
    </a>
  `,
})
export class ReturnsOrders {
  readonly tone = input<"dark" | "light">("dark");
  protected readonly cls = computed(() =>
    cx("hidden h-10 flex-col justify-center rounded-lg px-2 leading-tight lg:flex", this.tone() === "dark" ? "text-white hover:bg-white/10" : "text-ink hover:bg-mist"));
}
