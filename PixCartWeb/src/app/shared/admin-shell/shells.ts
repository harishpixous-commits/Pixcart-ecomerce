/*
 * The four admin layouts. Each shows the same menu (by role), badges, notifications, quick find, the layout switcher
 * and sign-out; they differ in how the menu is arranged. Pages render the same in all of them (projected content).
 * Port of components/admin-shell/shells.tsx:
 *   sidebar  the menu on the left (foldable groups, fold to icons), a drawer on phones
 *   topnav   menus across the top, full-width pages, a drawer on phones
 *   rail     a slim dark icon rail that opens on hover or focus, a drawer on phones
 *   glass    a frosted sidebar and toolbar (never on content), the system font, large titles, a tab bar with More on phones
 */

import { ChangeDetectionStrategy, Component, DestroyRef, Directive, ElementRef, computed, inject, input, output, signal, viewChild } from "@angular/core";
import { ChevronDown, Menu, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SiteService } from "../../core/site";
import { Logo, closeOnNavigate, closeOnOutside } from "../shop/shop-chrome";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";
import { isActiveItem, navSections, type AdminNavItem, type NavSection } from "./nav";
import { Breadcrumb, MenuDrawer, NavList, QuickFindButton, UserTools } from "./parts";
import { AdminPrefsService } from "./prefs";

/** Inputs every shell takes: the title ("Admin, Owner"), the menu items, and (find) to open quick find. */
@Directive()
abstract class ShellBase {
  readonly title = input.required<string>();
  readonly items = input.required<AdminNavItem[]>();
  readonly find = output<void>();
  /** a phone drawer that closes when the page changes */
  protected readonly drawer = signal(false);
  protected readonly Menu = Menu;
  protected readonly Search = Search;
  constructor() {
    closeOnNavigate(() => this.drawer.set(false));
  }
}

const TITLE_BADGE = "hidden rounded-md px-2 py-0.5 text-sm font-semibold sm:inline bg-white/15 text-white";

/* ------------------------------------------------------------------ sidebar (default) */

@Component({
  selector: "pc-sidebar-shell",
  imports: [Icon, Logo, QuickFindButton, UserTools, NavList, Breadcrumb, MenuDrawer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-h-screen", "data-admin-layout": "sidebar" },
  template: `
    <header class="sticky top-0 z-30">
      <div class="bg-peacock">
        <div class="flex items-center gap-3 px-3 py-2.5 sm:px-4">
          <button type="button" (click)="drawer.set(true)" aria-label="Menu" class="flex h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/10 lg:hidden"><svg [pcIcon]="Menu" class="h-5 w-5" /></button>
          <a pcLogo></a>
          <span [class]="TITLE_BADGE">{{ title() }}</span>
          <div class="ml-auto flex items-center gap-2">
            <span class="hidden md:block"><pc-quick-find-button tone="dark" (find)="find.emit()" /></span>
            <pc-user-tools />
          </div>
        </div>
      </div>
      <div class="awning bg-mist" aria-hidden="true"></div>
    </header>
    <div class="mx-auto flex max-w-[1680px] gap-4 px-3 pb-10 pt-3 sm:px-4">
      <aside [class]="asideCls()" [attr.aria-label]="title() + ' navigation'">
        <div [class]="prefs.sidebarFolded() ? 'mb-1 flex items-center gap-1 flex-col' : 'mb-1 flex items-center gap-1'">
          @if (prefs.sidebarFolded()) {
            <button type="button" (click)="find.emit()" aria-label="Quick find (Ctrl+K)" class="flex h-10 w-10 items-center justify-center rounded-lg text-white/80 hover:bg-white/10"><svg [pcIcon]="Search" class="h-[18px] w-[18px]" /></button>
          } @else {
            <pc-quick-find-button [wide]="true" (find)="find.emit()" />
          }
          <button type="button" (click)="prefs.setSidebarFolded(!prefs.sidebarFolded())" [attr.aria-label]="prefs.sidebarFolded() ? 'Show the full menu' : 'Fold the menu to icons'" [attr.aria-pressed]="prefs.sidebarFolded()"
            [class]="prefs.sidebarFolded() ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/80 hover:bg-white/10' : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-mist'">
            <svg [pcIcon]="prefs.sidebarFolded() ? PanelLeftOpen : PanelLeftClose" class="h-[18px] w-[18px]" />
          </button>
        </div>
        <pc-nav-list [items]="items()" [variant]="prefs.sidebarFolded() ? 'icons' : 'plain'" />
      </aside>
      <main class="min-w-0 flex-1">
        <pc-breadcrumb [items]="items()" crumbClass="mb-2 text-ink-soft" />
        <ng-content />
      </main>
    </div>
    <pc-menu-drawer [items]="items()" [open]="drawer()" (close)="drawer.set(false)" [title]="title()" />
  `,
})
export class SidebarShell extends ShellBase {
  protected readonly prefs = inject(AdminPrefsService);
  protected readonly TITLE_BADGE = TITLE_BADGE;
  protected readonly PanelLeftOpen = PanelLeftOpen;
  protected readonly PanelLeftClose = PanelLeftClose;
  protected readonly asideCls = computed(() => cx(
    "hidden shrink-0 self-start lg:sticky lg:top-[84px] lg:block lg:max-h-[calc(100vh-96px)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-xl lg:p-2 lg:shadow-sm lg:[scrollbar-width:thin]",
    this.prefs.sidebarFolded() ? "w-[64px] bg-ink" : "w-64 bg-white"));
}

/* ------------------------------------------------------------------ top navigation */

@Component({
  selector: "pc-section-menu",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (section().items.length === 1) {
      <a [pcLink]="section().items[0].href" [attr.aria-current]="active() ? 'page' : null"
        [class]="active() ? 'flex h-11 items-center gap-1.5 border-b-2 px-3 text-[14px] font-semibold border-peacock text-peacock' : 'flex h-11 items-center gap-1.5 border-b-2 px-3 text-[14px] font-semibold border-transparent text-ink hover:text-peacock'">
        {{ section().items[0].label }}
      </a>
    } @else {
      <div class="relative" #box>
        <button type="button" (click)="open.set(!open())" [attr.aria-expanded]="open()" aria-haspopup="menu"
          [class]="active() ? 'flex h-11 items-center gap-1 border-b-2 px-3 text-[14px] font-semibold border-peacock text-peacock' : 'flex h-11 items-center gap-1 border-b-2 px-3 text-[14px] font-semibold border-transparent text-ink hover:text-peacock'">
          {{ section().name }}
          @if (section().badge > 0) {<span class="rounded-full bg-vermilion px-1.5 text-[11px] font-bold leading-4 text-white">{{ section().badge }}</span>}
          <svg [pcIcon]="ChevronDown" [class]="open() ? 'h-4 w-4 transition-transform rotate-180' : 'h-4 w-4 transition-transform'" />
        </button>
        @if (open()) {
          <div class="absolute left-0 top-12 z-40 w-72 animate-rise-in rounded-xl bg-white p-1.5 shadow-xl ring-1 ring-line" role="menu">
            @for (i of section().items; track i.href) {
              <a [pcLink]="i.href" role="menuitem" [attr.aria-current]="on(i) ? 'page' : null"
                [class]="on(i) ? 'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] bg-peacock text-white' : 'flex items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] text-ink hover:bg-peacock-light hover:text-peacock'">
                <svg [pcIcon]="i.icon" class="h-[18px] w-[18px] shrink-0" />
                <span class="flex-1">{{ i.label }}</span>
                @if (i.badge) {<span [class]="on(i) ? 'rounded-full px-1.5 text-xs font-bold leading-5 bg-white text-peacock' : 'rounded-full px-1.5 text-xs font-bold leading-5 bg-vermilion text-white'">{{ i.badge }}</span>}
              </a>
            }
          </div>
        }
      </div>
    }
  `,
})
export class SectionMenu {
  readonly section = input.required<NavSection>();
  private readonly path = inject(RouteState).pathname;
  private readonly box = viewChild<ElementRef<HTMLElement>>("box");
  protected readonly open = signal(false);
  protected readonly ChevronDown = ChevronDown;
  protected readonly active = computed(() => this.section().items.some((i) => isActiveItem(this.path(), i)));
  protected on(i: AdminNavItem): boolean {
    return isActiveItem(this.path(), i);
  }
  constructor() {
    closeOnNavigate(() => this.open.set(false));
    closeOnOutside(this.open, () => this.open.set(false), () => this.box()?.nativeElement);
  }
}

@Component({
  selector: "pc-topnav-shell",
  imports: [Icon, Logo, QuickFindButton, UserTools, Breadcrumb, MenuDrawer, SectionMenu],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-h-screen", "data-admin-layout": "topnav" },
  template: `
    <header class="sticky top-0 z-30 shadow-sm">
      <div class="bg-peacock">
        <div class="flex items-center gap-3 px-3 py-2 sm:px-6">
          <button type="button" (click)="drawer.set(true)" aria-label="Menu" class="flex h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/10 lg:hidden"><svg [pcIcon]="Menu" class="h-5 w-5" /></button>
          <a pcLogo></a>
          <span [class]="TITLE_BADGE">{{ title() }}</span>
          <div class="ml-auto flex items-center gap-2">
            <span class="hidden md:block"><pc-quick-find-button tone="dark" (find)="find.emit()" /></span>
            <pc-user-tools />
          </div>
        </div>
      </div>
      <nav class="hidden border-b border-line bg-white lg:block" [attr.aria-label]="title() + ' navigation'">
        <div class="flex flex-wrap items-center px-3 sm:px-6">
          @for (s of sections(); track s.name) {<pc-section-menu [section]="s" />}
        </div>
      </nav>
    </header>
    <div class="px-3 pb-10 pt-4 sm:px-6">
      <pc-breadcrumb [items]="items()" crumbClass="mb-2 text-ink-soft" />
      <main class="min-w-0"><ng-content /></main>
    </div>
    <pc-menu-drawer [items]="items()" [open]="drawer()" (close)="drawer.set(false)" [title]="title()" />
  `,
})
export class TopnavShell extends ShellBase {
  protected readonly TITLE_BADGE = TITLE_BADGE;
  protected readonly sections = computed(() => navSections(this.items()));
}

/* ------------------------------------------------------------------ compact rail */

@Component({
  selector: "pc-rail-shell",
  imports: [Icon, PcLink, Logo, UserTools, NavList, Breadcrumb, MenuDrawer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-h-screen lg:pl-16", "data-admin-layout": "rail" },
  template: `
    <aside class="group/rail fixed inset-y-0 left-0 z-40 hidden w-16 flex-col overflow-hidden bg-ink py-3 text-white shadow-xl transition-[width] duration-200 hover:w-64 focus-within:w-64 lg:flex"
      [attr.aria-label]="title() + ' navigation'">
      <div class="mb-2 flex h-10 items-center px-3">
        <a pcLink="/admin" [attr.aria-label]="site().brand_name + ' admin home'" class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 font-display text-xl font-bold text-marigold group-hover/rail:hidden group-focus-within/rail:hidden">
          {{ (site().brand_name || "P").slice(0, 1).toUpperCase() }}
        </a>
        <span class="hidden whitespace-nowrap group-hover/rail:block group-focus-within/rail:block"><a pcLogo></a></span>
      </div>
      <button type="button" (click)="find.emit()" aria-label="Quick find (Ctrl+K)" class="mx-1 mb-2 flex h-10 items-center gap-2.5 rounded-lg px-3 text-white/80 hover:bg-white/10 hover:text-white">
        <svg [pcIcon]="Search" class="h-[18px] w-[18px] shrink-0" />
        <span class="whitespace-nowrap text-[14px] opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">Find a page</span>
      </button>
      <div class="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none]"><pc-nav-list [items]="items()" variant="rail" /></div>
    </aside>
    <header class="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-white/95 px-3 py-2 backdrop-blur sm:px-6">
      <button type="button" (click)="drawer.set(true)" aria-label="Menu" class="flex h-9 w-9 items-center justify-center rounded-lg text-ink hover:bg-mist lg:hidden"><svg [pcIcon]="Menu" class="h-5 w-5" /></button>
      <span class="lg:hidden"><a pcLogo [light]="false"></a></span>
      <pc-breadcrumb [items]="items()" crumbClass="hidden text-ink-soft lg:flex" />
      <div class="ml-auto"><pc-user-tools tone="light" /></div>
    </header>
    <main class="min-w-0 px-3 pb-10 pt-4 sm:px-6"><ng-content /></main>
    <pc-menu-drawer [items]="items()" [open]="drawer()" (close)="drawer.set(false)" [title]="title()" />
  `,
})
export class RailShell extends ShellBase {
  protected readonly site = inject(SiteService).site;
}

/* ------------------------------------------------------------------ glass */

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const GLASS = "bg-white/70 backdrop-blur-2xl backdrop-saturate-150 [@media(prefers-reduced-transparency:reduce)]:bg-white [@media(prefers-contrast:more)]:bg-white";
/** The phone tab bar's sections (the first four this person can open), with short names that fit a tab. */
const TABS: [string, string][] = [
  ["/admin", "Overview"], ["/admin/orders", "Orders"], ["/admin/products", "Listings"], ["/admin/delivery", "Delivery"],
  ["/admin/support", "Support"], ["/admin/storefront", "Store"], ["/admin/payouts", "Payouts"],
];

@Component({
  selector: "pc-glass-shell",
  imports: [Icon, PcLink, Logo, QuickFindButton, UserTools, NavList, Breadcrumb, MenuDrawer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-h-screen bg-[#F5F5F7]", "data-admin-layout": "glass", "[style.--f-display]": "font", "[style.--f-sans]": "font" },
  template: `
    <aside [class]="asideCls()" [attr.aria-label]="title() + ' navigation'">
      <div class="flex items-center justify-between px-2 pt-1"><a pcLogo [light]="false"></a></div>
      <pc-quick-find-button [wide]="true" (find)="find.emit()" />
      <pc-nav-list [items]="items()" variant="glass" />
    </aside>
    <div [class]="hidden() ? '' : 'lg:pl-[264px]'">
      <header [class]="'sticky top-0 z-30 flex items-center gap-2 border-b border-black/5 px-3 py-2 sm:px-5 ' + GLASS">
        <button type="button" (click)="prefs.setSidebarFolded(!hidden())" [attr.aria-label]="hidden() ? 'Show the sidebar' : 'Hide the sidebar'" [attr.aria-pressed]="!hidden()"
          class="hidden h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-black/5 lg:flex">
          <svg [pcIcon]="hidden() ? PanelLeftOpen : PanelLeftClose" class="h-[18px] w-[18px]" />
        </button>
        <span class="lg:hidden"><a pcLogo [light]="false"></a></span>
        <pc-breadcrumb [items]="items()" crumbClass="hidden text-ink-soft lg:flex" />
        <div class="ml-auto flex items-center gap-1">
          <button type="button" (click)="find.emit()" aria-label="Quick find (Ctrl+K)" class="flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-black/5 lg:hidden"><svg [pcIcon]="Search" class="h-[18px] w-[18px]" /></button>
          <pc-user-tools tone="light" />
        </div>
      </header>
      <main class="min-w-0 px-4 pb-28 pt-5 sm:px-6 lg:px-8 lg:pb-12 [&_h1]:font-bold [&_h1]:tracking-tight"><ng-content /></main>
    </div>
    <nav [class]="'fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-black/5 pb-[env(safe-area-inset-bottom)] lg:hidden ' + GLASS" aria-label="Main">
      @for (i of tabs(); track i.href) {
        <a [pcLink]="i.href" [attr.aria-current]="on(i) ? 'page' : null" [class]="on(i) ? 'relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-peacock' : 'relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-ink-faint'">
          <svg [pcIcon]="i.icon" class="h-[22px] w-[22px]" />
          <span class="max-w-full truncate px-1" aria-hidden="true">{{ i.short }}</span>
          <span class="sr-only">{{ i.label }}</span>
          @if (i.badge) {<span class="absolute right-[22%] top-1 h-2 w-2 rounded-full bg-vermilion"></span>}
        </a>
      }
      <button type="button" (click)="drawer.set(true)" class="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-ink-faint">
        <svg [pcIcon]="MoreHorizontal" class="h-[22px] w-[22px]" /> More
      </button>
    </nav>
    <pc-menu-drawer [items]="items()" [open]="drawer()" (close)="drawer.set(false)" [title]="title()" />
  `,
})
export class GlassShell extends ShellBase {
  protected readonly prefs = inject(AdminPrefsService);
  private readonly path = inject(RouteState).pathname;
  protected readonly font = SYSTEM_FONT;
  protected readonly GLASS = GLASS;
  protected readonly PanelLeftOpen = PanelLeftOpen;
  protected readonly PanelLeftClose = PanelLeftClose;
  protected readonly MoreHorizontal = MoreHorizontal;
  protected readonly hidden = this.prefs.sidebarFolded;
  protected readonly asideCls = computed(() =>
    cx("fixed inset-y-0 left-0 z-40 hidden w-[264px] flex-col gap-3 overflow-y-auto border-r border-black/5 p-3 [scrollbar-width:thin]", GLASS, !this.hidden() && "lg:flex"));
  protected readonly tabs = computed(() =>
    TABS.map(([h, short]) => { const i = this.items().find((x) => x.href === h); return i ? { ...i, short } : null; })
      .filter((i): i is AdminNavItem & { short: string } => Boolean(i)).slice(0, 4));
  protected on(i: AdminNavItem): boolean {
    return isActiveItem(this.path(), i);
  }
  constructor() {
    super();
    // the AI assistant's button moves above the tab bar on phones (globals.css)
    document.body.dataset["adminTabbar"] = "1";
    inject(DestroyRef).onDestroy(() => { delete document.body.dataset["adminTabbar"]; });
  }
}
