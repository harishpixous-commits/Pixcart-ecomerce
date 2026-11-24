/*
 * Header navigation: search with a category picker and recent/trending suggestions, the "All" side menu and the
 * second bar with the marketplace's links and an optional promotion. All of it is set in Admin → Storefront → Navigation.
 * Port of components/shop-nav.tsx: <pc-search-box>, <pc-all-menu>, <pc-nav-bar>, <pc-returns-orders>.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
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
import { closeOnNavigate } from "./shop-chrome";

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

type Sugg = { products: { title: string; slug: string }[]; categories: { name: string; slug: string }[] };

/**
 * The search box with suggestions. Themes pick its look: variant "solid" (white, on a coloured header), "soft" (grey, on
 * a white header) or "outline" (white with a border); shape "rounded" or "pill"; button "accent" or "plain" (an icon only).
 * The host is the <form> (role=search), as in the reference.
 */
@Component({
  selector: "form[pcSearchBox]",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: "search", "[class]": "formCls()", "(submit)": "submit($event)" },
  template: `
    @if (site().nav?.search_categories !== false && categories().length > 0) {
      <label for="search-cat" class="sr-only">Search in</label>
      <select id="search-cat" [value]="cat()" (change)="cat.set($any($event.target).value)" [class]="selectCls()">
        <option value="" [selected]="cat() === ''">All</option>
        @for (c of categories(); track c.slug) {<option [value]="c.slug" [selected]="c.slug === cat()">{{ c.name }}</option>}
      </select>
    }
    @if (button() === "plain") {<svg [pcIcon]="Search" class="pointer-events-none absolute left-3.5 top-3 h-5 w-5 text-ink-faint" />}
    <label for="site-search" class="sr-only">Search products</label>
    <input id="site-search" [value]="q()" (input)="onChange($any($event.target).value)" (focus)="onFocus()" (blur)="onBlur()"
      [placeholder]="placeholder() ?? 'Search ' + (site().brand_name || 'the store')" autocomplete="off" [class]="inputCls()" />
    @if (button() === "accent") {
      <button type="submit" aria-label="Search" [class]="pill() ? 'pc-press absolute right-1 top-1 flex h-9 w-10 items-center justify-center bg-marigold text-ink hover:bg-marigold-dark rounded-full' : 'pc-press absolute right-1 top-1 flex h-9 w-10 items-center justify-center bg-marigold text-ink hover:bg-marigold-dark rounded-md'">
        <svg [pcIcon]="Search" class="h-5 w-5" />
      </button>
    }
    @if (showList()) {
      <div class="absolute left-0 right-0 top-12 z-40 animate-rise-in overflow-hidden rounded-lg bg-white py-1 text-ink shadow-xl ring-1 ring-line" data-testid="search-suggestions">
        @if (empty()) {
          @if (recent().length > 0) {
            <div>
              <p class="flex items-center justify-between px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Recent searches
                <button type="button" (mousedown)="clearRecent($event)" class="normal-case tracking-normal text-peacock">Clear</button>
              </p>
              @for (r of recent(); track r) {
                <button type="button" (mousedown)="pick($event, r)" class="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-mist">
                  <svg [pcIcon]="Clock" class="h-4 w-4 text-ink-faint" /> {{ r }}
                </button>
              }
            </div>
          }
          @if (trending().length > 0) {
            <div>
              <p class="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Trending</p>
              @for (t of trending(); track t) {
                <button type="button" (mousedown)="pick($event, t)" class="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-mist">
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
              <li><a [pcLink]="'/p/' + p.slug" (mousedown)="remember()" class="flex items-center gap-2 px-4 py-2 hover:bg-mist"><svg [pcIcon]="Search" class="h-4 w-4 text-ink-faint" /><span class="truncate">{{ p.title }}</span></a></li>
            }
          </ul>
        }
      </div>
    }
  `,
})
export class SearchBox {
  readonly categories = input.required<CategoryNode[]>();
  readonly variant = input<"solid" | "soft" | "outline">("solid");
  readonly shape = input<"rounded" | "pill">("rounded");
  readonly button = input<"accent" | "plain">("accent");
  readonly placeholder = input<string | undefined>(undefined);
  protected readonly site = inject(SiteService).site;
  private readonly lists = inject(SiteService).lists;
  private readonly router = inject(Router);
  private readonly route = inject(RouteState);
  protected readonly q = signal(this.route.param("q") ?? "");
  protected readonly cat = signal(this.route.param("category") ?? "");
  protected readonly open = signal(false);
  protected readonly recent = signal<string[]>([]);
  protected readonly sugg = signal<Sugg>({ products: [], categories: [] });
  private timer: ReturnType<typeof setTimeout> | undefined;
  protected readonly Search = Search;
  protected readonly Clock = Clock;
  protected readonly TrendingUp = TrendingUp;
  protected readonly LayoutGrid = LayoutGrid;
  protected readonly pill = computed(() => this.shape() === "pill");
  protected readonly empty = computed(() => this.q().trim().length < 2);
  protected readonly trending = computed(() => this.site().nav?.trending ?? []);
  protected readonly showList = computed(() =>
    this.open() && (this.empty() ? this.recent().length > 0 || this.trending().length > 0 : this.sugg().products.length > 0 || this.sugg().categories.length > 0));
  protected readonly formCls = computed(() => cx("relative flex w-full focus-within:ring-2", this.pill() ? "rounded-full" : "rounded-lg",
    this.variant() === "solid" && "bg-white focus-within:ring-marigold",
    this.variant() === "soft" && "bg-mist ring-1 ring-line focus-within:bg-white focus-within:ring-peacock",
    this.variant() === "outline" && "bg-white ring-1 ring-line focus-within:ring-ink"));
  protected readonly selectCls = computed(() => cx("h-11 max-w-[30%] shrink-0 cursor-pointer border-r border-line px-2 text-[13px] text-ink-soft hover:bg-line/60 focus:outline-none sm:max-w-[160px]",
    this.pill() ? "rounded-l-full pl-4" : "rounded-l-lg", this.variant() === "soft" ? "bg-transparent" : "bg-mist"));
  protected readonly inputCls = computed(() => cx("h-11 min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-ink-faint focus:outline-none",
    this.button() === "plain" ? "pl-11 pr-4" : "pl-3 pr-12", this.pill() && this.button() !== "plain" && "pl-4"));

  constructor() {
    // the address changed (back button, a link): show its search
    let first = true;
    effect(() => {
      const qp = this.route.params().get("q") ?? "";
      if (first) { first = false; return; }
      this.q.set(qp);
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
      api<Sugg>("/api/catalog/suggest", { query: { q: v.trim() } }).then((s) => this.sugg.set(s)).catch(() => {});
    }, 160);
  }

  protected onFocus(): void {
    this.recent.set(readRecent().slice(0, this.lists().recent_searches_max));
    this.open.set(true);
  }

  protected onBlur(): void {
    setTimeout(() => this.open.set(false), 150);
  }

  protected submit(e: Event): void {
    e.preventDefault();
    this.go(this.q());
  }

  protected pick(e: Event, text: string): void {
    e.preventDefault();
    this.q.set(text);
    this.go(text);
  }

  protected clearRecent(e: Event): void {
    e.preventDefault();
    try { localStorage.removeItem(RECENT); } catch { /* ignore */ }
    this.recent.set([]);
  }

  protected remember(): void {
    saveRecent(this.q().trim(), this.lists().recent_searches_max);
  }

  private go(text: string): void {
    const t = text.trim();
    this.open.set(false);
    if (!t) return;
    saveRecent(t, this.lists().recent_searches_max);
    const cat = this.cat();
    const target = `/search?q=${encodeURIComponent(t)}${cat ? `&category=${encodeURIComponent(cat)}` : ""}`;
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
      <svg [pcIcon]="Menu" class="h-5 w-5" /> @if (!iconOnly()) {<ng-container>{{ label() }}</ng-container>}
    </button>
    @if (open()) {
      <div class="fixed inset-0 z-[60] flex" role="dialog" aria-modal="true" aria-label="All categories and pages">
        <div class="absolute inset-0 animate-fade-in bg-ink/60" (click)="open.set(false)"></div>
        <nav class="relative flex h-full w-[86%] max-w-[365px] animate-rise-in flex-col overflow-y-auto bg-white shadow-2xl">
          <div class="sticky top-0 z-10 flex items-center gap-2 bg-peacock px-6 py-4 text-white">
            <svg [pcIcon]="UserIcon" class="h-7 w-7 rounded-full bg-white/20 p-1" />
            @if (session.user()) {
              <span class="text-lg font-semibold">Hello, {{ session.user()!.name?.split(" ")?.[0] || "there" }}</span>
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
                    {{ c.name }}<svg [pcIcon]="ChevronRight" [class]="expanded() === c.slug ? 'h-4 w-4 text-ink-faint transition rotate-90' : 'h-4 w-4 text-ink-faint transition'" />
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
  readonly categories = input.required<CategoryNode[]>();
  readonly tone = input<"dark" | "light">("light");
  readonly label = input("All");
  readonly iconOnly = input(false);
  protected readonly site = inject(SiteService).site;
  protected readonly session = inject(SessionService);
  protected readonly path = inject(RouteState).pathname;
  protected readonly open = signal(false);
  protected readonly expanded = signal<string | null>(null);
  protected readonly Menu = Menu;
  protected readonly UserIcon = UserIcon;
  protected readonly ChevronRight = ChevronRight;
  protected readonly X = X;
  protected readonly enc = encodeURIComponent;
  protected readonly row = "flex w-full items-center justify-between px-6 py-2.5 text-left text-[15px] hover:bg-mist";
  protected readonly triggerCls = computed(() => cx("flex shrink-0 items-center gap-1 rounded px-2 py-1 font-semibold",
    this.tone() === "dark" ? "text-white hover:bg-white/10" : "text-ink hover:bg-peacock-light hover:text-peacock", this.iconOnly() && "h-10 w-10 justify-center px-0"));
  protected t(x: string): string {
    return fillTokens(x, this.site());
  }
  constructor() {
    closeOnNavigate(() => this.open.set(false));
    effect((onCleanup) => {
      if (!this.open()) return;
      const esc = (e: KeyboardEvent) => { if (e.key === "Escape") this.open.set(false); };
      document.addEventListener("keydown", esc);
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      onCleanup(() => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; });
    });
  }
}

/** The second header bar: All menu, delivery PIN (projected), the marketplace's links, categories and a promotion. */
@Component({
  selector: "pc-nav-bar",
  imports: [AllMenu, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "mx-auto flex max-w-shop items-center gap-1 px-3 pb-2 pt-4 sm:px-4" },
  template: `
    @if (site().nav?.all_menu !== false) {<pc-all-menu [categories]="categories()" />}
    <ng-content />
    <span class="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true"></span>
    <nav class="scroll-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Shop">
      @for (l of site().nav?.links ?? []; track l.href + l.label) {
        <a [pcLink]="l.href" class="shrink-0 rounded-full px-3 py-1 text-[15px] font-semibold text-ink hover:bg-peacock-light hover:text-peacock">{{ t(l.label) }}</a>
      }
      @if (site().nav?.show_categories !== false) {
        @for (c of categories(); track c.slug) {
          <a [pcLink]="'/c/' + c.slug" class="shrink-0 rounded-full px-3 py-1 text-[15px] font-medium text-ink-soft hover:bg-peacock-light hover:text-peacock">{{ c.name }}</a>
        }
      }
    </nav>
    @if (site().nav?.promo?.enabled && site().nav!.promo.text) {
      @if (site().nav!.promo.link) {
        <a [pcLink]="site().nav!.promo.link" [class]="'hidden shrink-0 rounded-full px-3 py-1 text-sm font-bold lg:block ' + tone()" data-testid="nav-promo">{{ t(site().nav!.promo.text) }}</a>
      } @else {
        <span [class]="'hidden shrink-0 rounded-full px-3 py-1 text-sm font-bold lg:block ' + tone()" data-testid="nav-promo">{{ t(site().nav!.promo.text) }}</span>
      }
    }
  `,
})
export class NavBar {
  readonly categories = input.required<CategoryNode[]>();
  protected readonly site = inject(SiteService).site;
  protected readonly tone = computed(() => ({ accent: "bg-marigold text-ink", buy: "bg-vermilion text-white", primary: "bg-peacock text-white", dark: "bg-ink text-white" } as Record<string, string>)[this.site().nav?.promo?.tone ?? "accent"]);
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
    <a pcLink="/orders" [class]="tone() === 'dark' ? 'hidden h-10 flex-col justify-center rounded-lg px-2 leading-tight lg:flex text-white hover:bg-white/10' : 'hidden h-10 flex-col justify-center rounded-lg px-2 leading-tight lg:flex text-ink hover:bg-mist'">
      <span [class]="tone() === 'dark' ? 'text-xs text-white/80' : 'text-xs text-ink-faint'">Returns</span>
      <span class="text-sm font-semibold">&amp; Orders</span>
    </a>
  `,
})
export class ReturnsOrders {
  readonly tone = input<"dark" | "light">("dark");
}
