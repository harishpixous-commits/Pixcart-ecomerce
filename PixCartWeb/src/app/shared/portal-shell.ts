/*
 * Shared chrome for the seller hub: peacock top bar with awning, side navigation, plus the page pieces both panels
 * use. Port of components/portal-shell.tsx:
 *   <pc-portal-shell title="Seller hub" [nav]="items" root="/seller"> page </pc-portal-shell>
 *   <pc-page-header title="Orders" sub="..." [back]="{ href: '/seller/orders' }"><button actions pcButton>..</button></pc-page-header>
 *   <pc-tabs [value] [items] (valueChange)>   <pc-stat label value hint href>   <pc-table [head]> <tr>..</tr> </pc-table>
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, afterNextRender } from "@angular/core";
import type { LucideIconData } from "lucide-angular";
import { RouteState } from "../core/route-state";
import { SessionService } from "../core/session";
import { BackLink } from "./chrome/back-button";
import { RegionButton } from "./chrome/region-picker";
import { Logo, NotificationBell } from "./shop/shop-chrome";
import { cx } from "./ui/cx";
import { Icon } from "./ui/icon";
import { PcLink } from "./ui/link";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIconData;
  badge?: number;
  section?: string; // heading shown above the first item of each section (desktop)
  exact?: boolean; // active only on this exact path (an overview whose sub-pages have their own items)
}

@Component({
  selector: "pc-portal-shell",
  imports: [Icon, PcLink, Logo, NotificationBell, RegionButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-h-screen" },
  template: `
    <header class="sticky top-0 z-30">
      <div class="bg-peacock">
        <div class="flex items-center gap-4 px-4 py-2.5">
          <a pcLogo></a>
          <span class="rounded-md bg-white/15 px-2 py-0.5 text-sm font-semibold text-white">{{ title() }}</span>
          <div class="ml-auto flex items-center gap-3 text-sm text-white/90">
            <pc-notification-bell />
            <pc-region-button [languageOnly]="true" tone="dark" />
            <span class="hidden sm:inline">{{ who() }}</span>
            <button (click)="signOut()" class="rounded-md px-2 py-1 font-semibold hover:bg-white/10">Sign out</button>
          </div>
        </div>
      </div>
      <div class="awning bg-mist" aria-hidden="true"></div>
    </header>
    <div class="mx-auto flex max-w-[1400px] flex-col gap-4 px-3 pb-10 pt-3 sm:px-4 lg:flex-row">
      <!-- Phones: one row that scrolls sideways. Desktop: a card that stays in view and scrolls on its own. -->
      <nav class="scroll-x -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 lg:sticky lg:top-[84px] lg:mx-0 lg:max-h-[calc(100vh-96px)] lg:w-60 lg:shrink-0 lg:flex-col lg:gap-0.5 lg:self-start lg:overflow-y-auto lg:overflow-x-hidden lg:overscroll-contain lg:rounded-xl lg:bg-white lg:p-2 lg:shadow-sm lg:[scrollbar-width:thin]"
        [attr.aria-label]="title() + ' navigation'">
        @for (n of nav(); track n.href; let i = $index) {
          <div class="contents">
            @if (n.section && n.section !== nav()[i - 1]?.section) {
              <p class="hidden px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint first:pt-1 lg:block">{{ n.section }}</p>
            }
            <a [pcLink]="n.href" [attr.aria-current]="isActive(n.href) ? 'page' : null" [class]="linkCls(n.href)">
              <svg [pcIcon]="n.icon" class="h-[18px] w-[18px] shrink-0" />
              <span class="whitespace-nowrap lg:whitespace-normal">{{ n.label }}</span>
              @if (n.badge) {<span [class]="isActive(n.href) ? 'ml-auto rounded-full px-1.5 text-xs font-bold leading-5 bg-white text-peacock' : 'ml-auto rounded-full px-1.5 text-xs font-bold leading-5 bg-vermilion text-white'">{{ n.badge }}</span>}
            </a>
          </div>
        }
      </nav>
      <main class="min-w-0 flex-1"><ng-content /></main>
    </div>
  `,
})
export class PortalShell {
  readonly title = input.required<string>();
  readonly nav = input.required<NavItem[]>();
  readonly root = input.required<string>();
  private readonly session = inject(SessionService);
  private readonly path = inject(RouteState).pathname;
  private readonly exact = computed(() => new Set(this.nav().filter((n) => n.exact).map((n) => n.href)));
  protected readonly who = computed(() => {
    const u = this.session.user();
    return u?.name || u?.email || u?.phone;
  });
  protected isActive(href: string): boolean {
    return href === this.root() || this.exact().has(href) ? this.path() === href : this.path().startsWith(href);
  }
  protected linkCls(href: string): string {
    return cx("flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] font-medium transition-colors",
      this.isActive(href) ? "bg-peacock text-white shadow-sm" : "bg-white text-ink ring-1 ring-line hover:bg-peacock-light hover:text-peacock lg:bg-transparent lg:ring-0");
  }
  protected signOut(): void {
    void this.session.signOut().then(() => window.location.assign(new URL("/", window.location.origin)));
  }
}

/** The page title, its sub-line, an optional back link, and the page's actions (projected with the `actions` attribute). */
@Component({
  selector: "pc-page-header",
  imports: [BackLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "mb-4 flex flex-wrap items-end justify-between gap-3" },
  template: `
    <div>
      @if (back(); as b) {<pc-back-link [fallback]="b.href" [label]="b.label ?? 'Back'" class="mb-1" />}
      <h1 class="text-2xl font-semibold sm:text-3xl">{{ title() }}</h1>
      @if (sub()) {<p class="text-ink-soft">{{ sub() }}</p>}
    </div>
    <div #actions [class]="(withActions() ?? hasActions()) ? 'flex flex-wrap gap-2' : 'hidden'"><ng-content select="[actions]" /></div>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly sub = input<string | undefined>(undefined);
  readonly back = input<{ href: string; label?: string } | undefined>(undefined);
  /** true when the page passes actions (the reference shows the actions box even when every action is hidden); left out: shown when something is projected */
  readonly withActions = input<boolean | undefined>(undefined);
  protected readonly hasActions = signal(false);
  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    afterNextRender(() => this.hasActions.set((el.lastElementChild?.childElementCount ?? 0) > 0));
  }
}

@Component({
  selector: "pc-tabs",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "scroll-x mb-3 flex gap-1 overflow-x-auto border-b border-line", role: "tablist" },
  template: `
    @for (t of items(); track t.value) {
      <button role="tab" [attr.aria-selected]="value() === t.value" (click)="valueChange.emit(t.value)"
        [class]="value() === t.value ? '-mb-px shrink-0 border-b-2 px-3 py-2 font-medium border-peacock text-peacock' : '-mb-px shrink-0 border-b-2 px-3 py-2 font-medium border-transparent text-ink-soft hover:text-ink'">
        {{ t.label }}
        @if (t.count !== undefined) {<span class="ml-1.5 text-sm text-ink-faint">{{ t.count }}</span>}
      </button>
    }
  `,
})
export class Tabs {
  readonly value = input.required<string>();
  readonly items = input.required<{ value: string; label: string; count?: number }[]>();
  readonly valueChange = output<string>();
}

@Component({
  selector: "pc-stat",
  imports: [PcLink, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #body>
      <p class="text-sm text-ink-soft">{{ label() }}</p>
      <p class="font-display text-3xl font-bold text-ink">{{ value() }}</p>
      @if (hint()) {<p class="text-xs text-ink-faint">{{ hint() }}</p>}
    </ng-template>
    @if (href()) {
      <a [pcLink]="href()!" class="rounded-xl bg-white p-4 hover:ring-2 hover:ring-peacock/20"><ng-container [ngTemplateOutlet]="body" /></a>
    } @else {
      <div class="rounded-xl bg-white p-4"><ng-container [ngTemplateOutlet]="body" /></div>
    }
  `,
})
export class Stat {
  readonly label = input.required<string>();
  readonly value = input.required<string | number>();
  readonly hint = input<string | undefined>(undefined);
  readonly href = input<string | undefined>(undefined);
}

/** A white table card; project the <tr> rows. */
@Component({
  selector: "pc-table",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block overflow-x-auto rounded-xl bg-white" },
  template: `
    <table class="w-full min-w-[640px] text-left text-[15px]">
      <thead class="border-b border-line text-sm text-ink-faint">
        <tr>@for (h of head(); track h) {<th class="px-4 py-2.5 font-medium">{{ h }}</th>}</tr>
      </thead>
      <tbody class="divide-y divide-line"><ng-content /></tbody>
    </table>
  `,
})
export class Table {
  readonly head = input.required<string[]>();
}
