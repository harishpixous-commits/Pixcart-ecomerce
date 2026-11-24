/*
 * Pieces every admin layout shares: quick find (Ctrl+K), the layout switcher, the header tools (notifications,
 * environment badge, the staff member, sign out), the menu list with foldable sections, the phone menu drawer and the
 * breadcrumb. Port of components/admin-shell/parts.tsx.
 *   <pc-quick-find [items] (close)>  <pc-quick-find-button tone wide (find)>  <pc-layout-thumb [id] [active]>
 *   <pc-layout-picker [compact]>  <pc-layout-switcher tone>  <pc-environment-badge>  <pc-user-tools tone>
 *   <pc-nav-list [items] variant (pick)>  <pc-breadcrumb [items] crumbClass>  <pc-menu-drawer [items] [open] title (close)>
 */

import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from "@angular/core";
import { Router } from "@angular/router";
import {
  Bike, Check, ChevronDown, ChevronRight, CornerDownLeft, IndianRupee, LayoutTemplate, LifeBuoy, Loader2, LogOut, Package, Search, ShoppingBag, Store, Users, X,
  type LucideIconData,
} from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api } from "../../core/api";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { RegionButton } from "../chrome/region-picker";
import { NotificationBell, closeOnOutside } from "../shop/shop-chrome";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { Autofocus } from "../ui/ui";
import { PcLink } from "../ui/link";
import { currentItem, isActiveItem, navSections, type AdminNavItem } from "./nav";
import { ADMIN_LAYOUTS, AdminPrefsService, LAYOUT_INFO, type AdminLayout } from "./prefs";

/* ------------------------------------------------------------------ quick find */

/** Opens with Ctrl+K or Cmd+K anywhere in the admin panel, or with the search button. Call in an injection context. */
export function quickFindKey(open: () => void): void {
  const key = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      open();
    }
  };
  document.addEventListener("keydown", key);
  inject(DestroyRef).onDestroy(() => document.removeEventListener("keydown", key));
}

/** A record found by the admin search (GET /api/admin/search): only what this staff member may open. */
type FoundRecord = { kind: "order" | "customer" | "seller" | "product" | "partner" | "ticket" | "payout"; id: string; title: string; sub: string; href: string };
const RECORD_ICON: Record<FoundRecord["kind"], LucideIconData> = {
  order: ShoppingBag, customer: Users, seller: Store, product: Package, partner: Bike, ticket: LifeBuoy, payout: IndianRupee,
};
const RECORD_NAME: Record<FoundRecord["kind"], string> = {
  order: "Order", customer: "Customer", seller: "Seller", product: "Listing", partner: "Delivery partner", ticket: "Support ticket", payout: "Payout",
};

type Option = { key: string; href: string; icon: LucideIconData; title: string; sub: string; badge?: number };

/**
 * Quick find: pages of the admin panel, and (from two letters) records anywhere: orders by number or phone, customers,
 * sellers, listings by title or SKU, delivery partners, support tickets and payouts. One list; arrows and Enter.
 */
@Component({
  selector: "pc-quick-find",
  imports: [Icon, Autofocus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="fixed inset-0 z-[80] flex items-start justify-center bg-ink/50 p-4 pt-[12vh] backdrop-blur-sm" (click)="backdrop($event)" role="dialog" aria-modal="true" aria-label="Quick find">
      <div class="w-full max-w-xl animate-rise-in overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-line">
        <div class="flex items-center gap-2 border-b border-line px-4">
          <svg [pcIcon]="Search" class="h-5 w-5 shrink-0 text-ink-faint" />
          <input pcAutofocus [value]="q()" placeholder="Go to a page, or find an order, customer, seller, listing…" aria-label="Find a page" role="combobox" aria-expanded="true" aria-controls="quick-find-list"
            [attr.aria-activedescendant]="options()[at()] ? 'qf-' + options()[at()].key : null"
            (input)="q.set($any($event.target).value); at.set(0)" (keydown)="keydown($event)"
            class="h-14 min-w-0 flex-1 bg-transparent text-[16px] focus:outline-none" />
          @if (searching()) {<svg [pcIcon]="Loader2" [ariaHidden]="null" class="h-4 w-4 shrink-0 animate-spin text-ink-faint" aria-label="Searching" />}
          <kbd class="hidden rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint sm:block">Esc</kbd>
        </div>
        <ul id="quick-find-list" #list role="listbox" class="max-h-[55vh] overflow-y-auto p-2">
          @if (options().length === 0 && !searching()) {<li class="px-3 py-6 text-center text-sm text-ink-soft">Nothing matches “{{ q() }}”.</li>}
          @for (o of options(); track o.key; let n = $index) {
            @if (n === pages().length && records().length > 0) {
              <li role="presentation" class="px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Records</li>
            }
            <li [id]="'qf-' + o.key" role="option" [attr.aria-selected]="n === at()">
              <button type="button" (mouseenter)="at.set(n)" (click)="pick(o)"
                [class]="n === at() ? 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left bg-peacock text-white' : 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-ink hover:bg-mist'">
                <svg [pcIcon]="o.icon" class="h-[18px] w-[18px] shrink-0" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{{ o.title }}</span>
                  <span [class]="n === at() ? 'block truncate text-xs text-white/75' : 'block truncate text-xs text-ink-faint'">{{ o.sub }}</span>
                </span>
                @if (o.badge) {<span [class]="n === at() ? 'rounded-full px-1.5 text-xs font-bold leading-5 bg-white text-peacock' : 'rounded-full px-1.5 text-xs font-bold leading-5 bg-vermilion text-white'">{{ o.badge }}</span>}
                @if (n === at()) {<svg [pcIcon]="CornerDownLeft" class="h-4 w-4 shrink-0" />}
              </button>
            </li>
          }
        </ul>
        <p class="border-t border-line px-4 py-2 text-xs text-ink-faint">↑ ↓ to move · Enter to open · Ctrl+K anywhere · type 2 letters to search records</p>
      </div>
    </div>
  `,
})
export class QuickFind {
  readonly items = input.required<AdminNavItem[]>();
  readonly close = output<void>();
  private readonly router = inject(Router);
  private readonly list = viewChild<ElementRef<HTMLUListElement>>("list");
  protected readonly q = signal("");
  protected readonly at = signal(0);
  private readonly found = signal<{ q: string; results: FoundRecord[] } | null>(null);
  protected readonly Search = Search;
  protected readonly Loader2 = Loader2;
  protected readonly CornerDownLeft = CornerDownLeft;
  protected readonly pages = computed(() => {
    const words = this.q().toLowerCase().split(/\s+/).filter(Boolean);
    return this.items().filter((i) => words.every((w) => `${i.label} ${i.section}`.toLowerCase().includes(w)));
  });
  private readonly term = computed(() => this.q().trim());
  protected readonly records = computed(() => (this.term().length >= 2 && this.found()?.q === this.term() ? this.found()!.results : []));
  protected readonly searching = computed(() => this.term().length >= 2 && this.found()?.q !== this.term());
  protected readonly options = computed<Option[]>(() => [
    ...this.pages().map((i) => ({ key: `page:${i.href}`, href: i.href, icon: i.icon, title: i.label, sub: i.section, badge: i.badge })),
    ...this.records().map((r) => ({ key: `${r.kind}:${r.id}`, href: r.href, icon: RECORD_ICON[r.kind], title: r.title, sub: `${RECORD_NAME[r.kind]} · ${r.sub}` })),
  ]);

  constructor() {
    effect((onCleanup) => {
      const term = this.term();
      if (term.length < 2) return;
      let live = true;
      const t = setTimeout(() => {
        api<{ results: FoundRecord[] }>("/api/admin/search", { query: { q: term } })
          .then((r) => { if (live) this.found.set({ q: term, results: r.results }); })
          .catch(() => { if (live) this.found.set({ q: term, results: [] }); });
      }, 200);
      onCleanup(() => { live = false; clearTimeout(t); });
    });
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") this.close.emit(); };
    document.addEventListener("keydown", esc);
    inject(DestroyRef).onDestroy(() => document.removeEventListener("keydown", esc));
    effect(() => {
      this.at();
      untracked(() => queueMicrotask(() => this.list()?.nativeElement.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" })));
    });
  }

  protected backdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.close.emit();
  }

  protected keydown(e: KeyboardEvent): void {
    const n = this.options().length;
    if (e.key === "ArrowDown") { e.preventDefault(); this.at.set(Math.min(n - 1, this.at() + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); this.at.set(Math.max(0, this.at() - 1)); }
    if (e.key === "Enter") { e.preventDefault(); this.pick(this.options()[this.at()]); }
  }

  protected pick(o: Option | undefined): void {
    if (!o) return;
    this.close.emit();
    void this.router.navigateByUrl(o.href);
  }
}

@Component({
  selector: "pc-quick-find-button",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <button type="button" (click)="find.emit()" aria-label="Quick find (Ctrl+K)" data-testid="quick-find" [class]="cls()">
      <svg [pcIcon]="Search" class="h-4 w-4 shrink-0" />
      @if (wide()) {<span class="flex-1 text-left">Find a page</span>}
      <kbd [class]="tone() === 'dark' ? 'hidden rounded px-1 text-[11px] sm:inline bg-white/15' : 'hidden rounded px-1 text-[11px] sm:inline bg-white ring-1 ring-line'">Ctrl K</kbd>
    </button>
  `,
})
export class QuickFindButton {
  readonly tone = input<"light" | "dark">("light");
  readonly wide = input(false);
  readonly find = output<void>();
  protected readonly Search = Search;
  protected readonly cls = computed(() => cx("flex h-9 items-center gap-2 rounded-lg text-sm", this.wide() ? "w-full px-3" : "px-2.5",
    this.tone() === "dark" ? "bg-white/10 text-white/90 hover:bg-white/20" : "bg-mist text-ink-soft ring-1 ring-line hover:bg-white"));
}

/* ------------------------------------------------------------------ layout switcher */

/** A small drawing of each layout. */
@Component({
  selector: "pc-layout-thumb",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <span aria-hidden="true" class="relative block aspect-[4/3] w-full overflow-hidden rounded-md bg-mist ring-1 ring-line">
      @switch (id()) {
        @case ("sidebar") {<span [class]="'absolute inset-x-0 top-0 h-[16%] ' + bar()"></span><span class="absolute bottom-[6%] left-[5%] top-[24%] w-[24%] rounded-sm bg-white"></span><span class="absolute bottom-[6%] left-[33%] right-[5%] top-[24%] rounded-sm bg-white"></span>}
        @case ("topnav") {<span [class]="'absolute inset-x-0 top-0 h-[16%] ' + bar()"></span><span class="absolute inset-x-0 top-[16%] h-[10%] bg-white/80"></span><span class="absolute bottom-[6%] left-[5%] right-[5%] top-[32%] rounded-sm bg-white"></span>}
        @case ("rail") {<span class="absolute bottom-0 left-0 top-0 w-[12%] bg-ink"></span><span class="absolute bottom-[6%] left-[17%] right-[5%] top-[6%] rounded-sm bg-white"></span>}
        @case ("glass") {<span class="absolute bottom-[4%] left-[4%] top-[4%] w-[26%] rounded-md bg-white/70 ring-1 ring-black/5 backdrop-blur"></span><span class="absolute left-[34%] top-[8%] h-[8%] w-[30%] rounded-full bg-ink/70"></span><span class="absolute bottom-[6%] left-[34%] right-[5%] top-[22%] rounded-md bg-white"></span>}
      }
    </span>
  `,
})
export class LayoutThumb {
  readonly id = input.required<AdminLayout>();
  readonly active = input(false);
  protected readonly bar = computed(() => (this.active() ? "bg-peacock" : "bg-ink/40"));
}

@Component({
  selector: "pc-layout-picker",
  imports: [Icon, LayoutThumb],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-2" },
  template: `
    <div [class]="compact() ? 'grid gap-2 grid-cols-2' : 'grid gap-2 grid-cols-2 lg:grid-cols-4'" role="radiogroup" aria-label="Admin layout">
      @for (id of layouts; track id) {
        <button type="button" role="radio" [attr.aria-checked]="prefs.layout() === id" (click)="prefs.setLayout(id)" [attr.data-testid]="'admin-layout-' + id"
          [class]="prefs.layout() === id ? 'flex flex-col gap-1.5 rounded-xl border-2 p-2 text-left border-peacock bg-peacock-light/50' : 'flex flex-col gap-1.5 rounded-xl border-2 p-2 text-left border-line hover:border-peacock/50'">
          <pc-layout-thumb [id]="id" [active]="prefs.layout() === id" />
          <span class="flex items-center gap-1 text-sm font-semibold">{{ info[id].name }}@if (prefs.layout() === id) {<svg [pcIcon]="Check" class="h-4 w-4 text-peacock" />}</span>
          @if (!compact()) {<span class="text-xs text-ink-soft">{{ info[id].text }}</span>}
        </button>
      }
    </div>
    @if (prefs.chosen() && prefs.chosen() !== prefs.defaultLayout()) {
      <button type="button" (click)="prefs.setLayout(null)" class="self-start text-sm font-semibold text-peacock hover:underline">
        Use the default ({{ info[prefs.defaultLayout()].name }})
      </button>
    }
  `,
})
export class LayoutPicker {
  readonly compact = input(false);
  protected readonly prefs = inject(AdminPrefsService);
  protected readonly layouts = ADMIN_LAYOUTS;
  protected readonly info = LAYOUT_INFO;
  protected readonly Check = Check;
}

@Component({
  selector: "pc-layout-switcher",
  imports: [Icon, LayoutPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="relative" #box>
      <button type="button" (click)="open.set(!open())" [attr.aria-expanded]="open()" aria-haspopup="dialog" aria-label="Change the admin layout" data-testid="layout-switcher"
        [class]="tone() === 'dark' ? 'flex h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/10' : 'flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-mist'">
        <svg [pcIcon]="LayoutTemplate" class="h-5 w-5" />
      </button>
      @if (open()) {
        <div class="absolute right-0 top-11 z-50 w-[min(22rem,calc(100vw-1.5rem))] animate-rise-in rounded-2xl bg-white p-3 text-ink shadow-2xl ring-1 ring-line" role="dialog" aria-label="Admin layout">
          <p class="mb-2 px-1 text-sm font-semibold">Your admin layout</p>
          <pc-layout-picker [compact]="true" />
          <p class="mt-2 px-1 text-xs text-ink-faint">Only for you. Change it any time here or in My account.</p>
        </div>
      }
    </div>
  `,
})
export class LayoutSwitcher {
  readonly tone = input<"light" | "dark">("dark");
  private readonly box = viewChild<ElementRef<HTMLElement>>("box");
  protected readonly open = signal(false);
  protected readonly LayoutTemplate = LayoutTemplate;
  constructor() {
    closeOnOutside(this.open, () => this.open.set(false), () => this.box()?.nativeElement);
  }
}

/* ------------------------------------------------------------------ header tools */

@Component({
  selector: "pc-environment-badge",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (env() && env() !== "production") {
      <span class="rounded-md bg-marigold px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-ink" title="This is not the live marketplace" data-testid="environment-badge">
        {{ env() === "development" ? "Test" : env() }}
      </span>
    }
  `,
})
export class EnvironmentBadge {
  protected readonly env = inject(AdminPrefsService).environment;
}

@Component({
  selector: "pc-user-tools",
  imports: [Icon, EnvironmentBadge, NotificationBell, RegionButton, LayoutSwitcher],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="dark() ? 'flex items-center gap-1.5 text-sm text-white/90' : 'flex items-center gap-1.5 text-sm text-ink-soft'">
      <pc-environment-badge />
      <pc-notification-bell [dark]="!dark()" />
      <pc-region-button [languageOnly]="true" [tone]="dark() ? 'dark' : 'light'" />
      <pc-layout-switcher [tone]="tone()" />
      <span class="hidden max-w-[12rem] flex-col leading-tight md:flex">
        <span [class]="dark() ? 'truncate font-semibold text-white' : 'truncate font-semibold text-ink'">{{ who() }}</span>
        @if (admin.me()?.role_label) {<span [class]="dark() ? 'truncate text-xs text-white/70' : 'truncate text-xs text-ink-faint'">{{ admin.me()!.role_label }}</span>}
      </span>
      <button (click)="signOut()" aria-label="Sign out" [class]="dark() ? 'flex h-9 items-center gap-1.5 rounded-lg px-2 font-semibold hover:bg-white/10' : 'flex h-9 items-center gap-1.5 rounded-lg px-2 font-semibold hover:bg-mist'">
        <svg [pcIcon]="LogOut" class="h-4 w-4" /><span class="hidden sm:inline">Sign out</span>
      </button>
    </div>
  `,
})
export class UserTools {
  readonly tone = input<"light" | "dark">("dark");
  private readonly session = inject(SessionService);
  protected readonly admin = inject(AdminContext);
  protected readonly LogOut = LogOut;
  protected readonly dark = computed(() => this.tone() === "dark");
  protected readonly who = computed(() => {
    const u = this.session.user();
    return u?.name || u?.email || u?.phone;
  });
  protected signOut(): void {
    void this.session.signOut().then(() => window.location.assign(new URL("/", window.location.origin)));
  }
}

/* ------------------------------------------------------------------ menu list */

/**
 * The menu as a vertical list with foldable sections (remembered per person).
 * variant: "plain" (sidebar, drawer), "glass" (inset groups), "icons" (only icons, labels in tooltips), "rail" (icons;
 * labels appear when the rail opens on hover or focus).
 */
@Component({
  selector: "pc-nav-list",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "variant() === 'glass' ? 'flex flex-col gap-3' : 'flex flex-col gap-1'" },
  template: `
    @for (s of sections(); track s.name) {
      <div [class]="variant() === 'glass' ? 'rounded-xl bg-white/60 p-1 ring-1 ring-black/5 [@media(prefers-reduced-transparency:reduce)]:bg-white' : ''">
        @if (iconish()) {
          <hr class="mx-2 my-1 border-white/15 first:hidden" />
        } @else {
          <button type="button" (click)="prefs.toggleSection(s.name)" [attr.aria-expanded]="!isFolded(s)"
            [class]="variant() === 'glass' ? 'flex w-full items-center gap-1 rounded-md px-3 pb-1 pt-2 text-left text-[11px] font-bold uppercase tracking-wider text-ink-faint hover:text-ink normal-case tracking-normal text-[12px] font-semibold' : 'flex w-full items-center gap-1 rounded-md px-3 pb-1 pt-2 text-left text-[11px] font-bold uppercase tracking-wider text-ink-faint hover:text-ink'">
            <span class="flex-1">{{ s.name }}</span>
            @if (isFolded(s) && s.badge > 0) {<span class="rounded-full bg-vermilion px-1.5 text-[10px] font-bold leading-4 text-white">{{ s.badge }}</span>}
            <svg [pcIcon]="ChevronDown" [class]="isFolded(s) ? 'h-3.5 w-3.5 transition-transform -rotate-90' : 'h-3.5 w-3.5 transition-transform'" />
          </button>
        }
        @if (!isFolded(s)) {
          @for (i of s.items; track i.href) {
            <a [pcLink]="i.href" (click)="pick.emit()" [attr.aria-current]="active(i) ? 'page' : null" [attr.title]="iconish() ? i.label : null" [class]="linkCls(i)">
              <svg [pcIcon]="i.icon" class="h-[18px] w-[18px] shrink-0" />
              @if (variant() === "icons") {
                <span class="sr-only">{{ i.label }}</span>
              } @else if (variant() === "rail") {
                <span class="min-w-0 flex-1 whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">{{ i.label }}</span>
              } @else {
                <span class="min-w-0 flex-1">{{ i.label }}</span>
              }
              @if (i.badge) {<span [class]="badgeCls(i)">{{ i.badge }}</span>}
            </a>
          }
        }
      </div>
    }
  `,
})
export class NavList {
  readonly items = input.required<AdminNavItem[]>();
  readonly variant = input<"plain" | "glass" | "icons" | "rail">("plain");
  readonly pick = output<void>();
  protected readonly prefs = inject(AdminPrefsService);
  private readonly path = inject(RouteState).pathname;
  protected readonly ChevronDown = ChevronDown;
  protected readonly sections = computed(() => navSections(this.items()));
  protected readonly iconish = computed(() => this.variant() === "icons" || this.variant() === "rail");
  protected active(i: AdminNavItem): boolean {
    return isActiveItem(this.path(), i);
  }
  protected isFolded(s: { name: string; items: AdminNavItem[] }): boolean {
    return !this.iconish() && this.prefs.folded().includes(s.name) && !s.items.some((i) => isActiveItem(this.path(), i));
  }
  protected linkCls(i: AdminNavItem): string {
    const v = this.variant();
    const active = this.active(i);
    return cx("group relative flex items-center gap-2.5 rounded-lg font-medium transition-colors",
      v === "icons" ? "mx-1 h-10 justify-center" : v === "rail" ? "mx-1 h-10 px-3 text-[14px]" : "px-3 py-2 text-[15px]",
      v === "glass" && "py-1.5 text-[14px]",
      active ? "bg-peacock text-white shadow-sm" : this.iconish() ? "text-white/80 hover:bg-white/10 hover:text-white" : "text-ink hover:bg-peacock-light hover:text-peacock");
  }
  protected badgeCls(i: AdminNavItem): string {
    const v = this.variant();
    return cx("rounded-full px-1.5 text-xs font-bold leading-5", v === "icons" && "absolute right-0 top-0 scale-90", v === "rail" && "absolute left-6 top-0.5 scale-90",
      this.active(i) ? "bg-white text-peacock" : "bg-vermilion text-white");
  }
}

/* ------------------------------------------------------------------ breadcrumb and phone drawer */

@Component({
  selector: "pc-breadcrumb",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (cur(); as c) {
      <nav aria-label="Breadcrumb" [class]="'flex min-w-0 items-center gap-1 text-sm ' + crumbClass()">
        <span class="hidden truncate sm:inline">{{ c.section }}</span>
        <svg [pcIcon]="ChevronRight" class="hidden h-3.5 w-3.5 shrink-0 opacity-60 sm:block" />
        @if (deeper()) {
          <a [pcLink]="c.href" class="truncate font-semibold hover:underline">{{ c.label }}</a>
          <svg [pcIcon]="ChevronRight" class="h-3.5 w-3.5 shrink-0 opacity-60" /><span class="truncate">Details</span>
        } @else {
          <span class="truncate font-semibold" aria-current="page">{{ c.label }}</span>
        }
      </nav>
    }
  `,
})
export class Breadcrumb {
  readonly items = input.required<AdminNavItem[]>();
  readonly crumbClass = input<string>("");
  private readonly path = inject(RouteState).pathname;
  protected readonly ChevronRight = ChevronRight;
  protected readonly cur = computed(() => currentItem(this.path(), this.items()));
  protected readonly deeper = computed(() => this.path() !== this.cur()?.href);
}

@Component({
  selector: "pc-menu-drawer",
  imports: [Icon, NavList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (open()) {
      <div class="fixed inset-0 z-[70] flex" role="dialog" aria-modal="true" [attr.aria-label]="title() + ' menu'">
        <div class="absolute inset-0 animate-fade-in bg-ink/50" (click)="close.emit()"></div>
        <nav class="relative flex h-full w-[86%] max-w-[340px] animate-rise-in flex-col overflow-y-auto bg-white p-2 shadow-2xl" [attr.aria-label]="title() + ' navigation'">
          <div class="mb-1 flex items-center justify-between px-2 py-2">
            <span class="font-semibold">{{ title() }}</span>
            <button type="button" (click)="close.emit()" aria-label="Close menu" class="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-mist"><svg [pcIcon]="X" class="h-5 w-5" /></button>
          </div>
          <pc-nav-list [items]="items()" (pick)="close.emit()" />
        </nav>
      </div>
    }
  `,
})
export class MenuDrawer {
  readonly items = input.required<AdminNavItem[]>();
  readonly open = input(false);
  readonly title = input.required<string>();
  readonly close = output<void>();
  protected readonly X = X;
  constructor() {
    effect((onCleanup) => {
      if (!this.open()) return;
      const esc = (e: KeyboardEvent) => { if (e.key === "Escape") this.close.emit(); };
      document.addEventListener("keydown", esc);
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      onCleanup(() => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; });
    });
  }
}
