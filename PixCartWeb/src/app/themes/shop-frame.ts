/*
 * The shop's frame in the active theme: its header, the page (router outlet), its footer and phone tab bar, plus the
 * shared extras (back to top, help assistant launcher, compare tray) and, while an admin previews a theme, the preview
 * bar. The maintenance gate shows the "back soon" page to shoppers. Port of themes/shop-frame.tsx and app/(shop)/layout.tsx.
 */

import { NgComponentOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, computed, effect, inject, signal } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { Construction, Eye, MessageCircle, X } from "lucide-angular";
import { api } from "../core/api";
import { RouteState } from "../core/route-state";
import { SessionService } from "../core/session";
import { SiteService } from "../core/site";
import { AppBanner } from "../shared/chrome/app-banner";
import { ShopBackBar } from "../shared/chrome/back-button";
import { CompareTray } from "../shared/chrome/compare";
import { NewsletterBox } from "../shared/chrome/newsletter";
import { RegionStrip } from "../shared/chrome/region-picker";
import { Logo } from "../shared/shop/shop-chrome";
import { Icon } from "../shared/ui/icon";
import { PcLink } from "../shared/ui/link";
import { ShopRouteSkeleton } from "../shared/ui/skeletons";
import { ThemeService } from "./context";
import { BRAND_PRESET, findPreset } from "./manifest";
import { SLOTS } from "./slots";

/** Pages that stay open during maintenance: signing in (so staff can get in), and the legal and contact pages. */
const OPEN_DURING_MAINTENANCE = ["/login", "/signup", "/pages", "/contact"];

@Component({
  selector: "pc-preview-bar",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!framed) {
      <div class="relative z-[35] bg-ink text-white" role="status" data-testid="theme-preview-bar">
        <div class="mx-auto flex max-w-shop flex-col gap-1.5 px-3 py-2 text-[13px] sm:flex-row sm:items-center sm:gap-3 sm:px-4 sm:text-sm">
          <p class="flex min-w-0 flex-1 items-center gap-2">
            <svg [pcIcon]="Eye" class="h-4 w-4 shrink-0 text-marigold" />
            <span class="min-w-0">Previewing <b>{{ t().data.name }}</b>@if (preset()) {<ng-container> · {{ preset() }}</ng-container>}<span class="hidden md:inline">. Only you see this; shoppers see the live theme.</span></span>
          </p>
          <div class="flex shrink-0 items-center gap-2">
            <a pcLink="/admin/storefront?tab=theme" class="rounded-md bg-white/15 px-2.5 py-1 font-semibold hover:bg-white/25">Theme settings</a>
            <a [href]="'/theme-preview?theme=off&to=' + enc(path())" class="flex items-center gap-1 rounded-md px-2 py-1 font-semibold hover:bg-white/10" data-testid="theme-preview-exit">
              <svg [pcIcon]="X" class="h-4 w-4" /> Exit preview
            </a>
          </div>
        </div>
      </div>
    }
  `,
})
export class PreviewBar {
  protected readonly t = inject(ThemeService).active;
  protected readonly path = inject(RouteState).pathname;
  /** inside the admin's live preview window (an iframe), where the admin page has its own controls */
  protected readonly framed = window.self !== window.top;
  protected readonly Eye = Eye;
  protected readonly X = X;
  protected readonly enc = encodeURIComponent;
  protected readonly preset = computed(() => (this.t().presetId === BRAND_PRESET ? "brand colours" : findPreset(this.t().data, this.t().presetId)?.name ?? ""));
}

/** What shoppers see while the owner has switched on maintenance mode (Admin → Marketplace settings). */
@Component({
  selector: "pc-maintenance-page",
  imports: [Icon, PcLink, Logo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex min-h-screen flex-col bg-mist", "data-testid": "maintenance-page" },
  template: `
    <header class="bg-peacock px-4 py-4"><div class="mx-auto max-w-shop"><a pcLogo></a></div></header>
    <main class="flex flex-1 items-center justify-center px-4 py-12">
      <div class="w-full max-w-lg rounded-2xl bg-white p-8 text-center shadow-card">
        <span class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-marigold-light text-ink"><svg [pcIcon]="Construction" class="h-7 w-7" /></span>
        <h1 class="font-display text-2xl font-bold text-ink">We'll be back soon</h1>
        <p class="mt-3 text-ink-soft">{{ site().maintenance?.message ?? "" }}</p>
        <p class="mt-6 text-sm text-ink-soft">Need help with an order? <a pcLink="/contact" class="font-semibold text-peacock">Contact {{ site().brand_name }}</a></p>
      </div>
    </main>
    <footer class="px-4 pb-6 text-center text-xs text-ink-faint"><a pcLink="/login" class="hover:underline">Staff sign in</a></footer>
  `,
})
export class MaintenancePage {
  protected readonly site = inject(SiteService).site;
  protected readonly Construction = Construction;
}

/** Staff still use the shop during maintenance; this bar reminds them shoppers cannot. */
@Component({
  selector: "pc-maintenance-bar",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative z-[35] block bg-marigold text-ink", role: "status", "data-testid": "maintenance-bar" },
  template: `
    <div class="mx-auto flex max-w-shop flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px] sm:px-4 sm:text-sm">
      <svg [pcIcon]="Construction" class="h-4 w-4 shrink-0" />
      <p class="min-w-0 flex-1"><b>Maintenance mode is on.</b> Shoppers see the &ldquo;back soon&rdquo; page and cannot order; you see the shop as staff.</p>
      <a pcLink="/admin/settings#maintenance" class="rounded-md bg-ink/10 px-2.5 py-1 font-semibold hover:bg-ink/20">Turn it off</a>
    </div>
  `,
})
export class MaintenanceBar {
  protected readonly Construction = Construction;
}

/** The full-width "Back to top" bar above the footer (Admin → Storefront → Navigation can switch it off). */
@Component({
  selector: "pc-back-to-top",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (site().home_extras?.back_to_top !== false) {
      <button type="button" (click)="top()" data-testid="back-to-top" class="mt-6 block w-full bg-peacock-dark/90 py-3.5 text-center text-sm font-semibold text-white hover:bg-peacock-dark">Back to top</button>
    }
  `,
})
export class BackToTop {
  protected readonly site = inject(SiteService).site;
  protected top(): void {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

/** Opens the shop's help chat; the chat panel itself is ported by the shop-assistant module (it reads `open`). */
@Injectable({ providedIn: "root" })
export class ShopAssistantState {
  readonly open = signal(false);
  readonly config = signal<{ switched_on: boolean; name: string } | null>(null);
}

/**
 * The help assistant's launcher button (Admin → Shop assistant). TODO(shop-assistant module): port the chat panel from
 * components/shop-assistant/widget.tsx; it opens when ShopAssistantState.open() is true.
 */
@Component({
  selector: "pc-shop-assistant",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (session.ready() && state.config()?.switched_on && !state.open()) {
      <button type="button" (click)="state.open.set(true)" [attr.aria-label]="'Open ' + state.config()!.name"
        class="shop-assistant-launcher fixed bottom-20 right-4 z-40 flex items-center gap-2 rounded-full bg-peacock px-4 py-3 font-semibold text-white shadow-lg hover:bg-peacock-dark sm:bottom-6">
        <svg [pcIcon]="MessageCircle" class="h-5 w-5" /><span class="hidden sm:inline">Help</span>
      </button>
    }
  `,
})
export class ShopAssistantLauncher {
  protected readonly session = inject(SessionService);
  protected readonly state = inject(ShopAssistantState);
  protected readonly MessageCircle = MessageCircle;
  constructor() {
    effect(() => {
      if (!this.session.ready()) return;
      this.session.user();
      api<{ switched_on: boolean; name: string }>("/api/shop-assistant/config").then((c) => this.state.config.set(c)).catch(() => this.state.config.set(null));
    });
  }
}

@Component({
  selector: "pc-shop-frame",
  imports: [NgComponentOutlet, RouterOutlet, MaintenancePage, MaintenanceBar, AppBanner, PreviewBar, ShopBackBar, BackToTop, RegionStrip, NewsletterBox, ShopAssistantLauncher, CompareTray, ShopRouteSkeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (closed() && !session.ready()) {
      <div class="mx-auto w-full max-w-shop px-3 py-6"><pc-shop-route-skeleton /></div>
    } @else if (closed() && !session.user()?.is_admin) {
      <pc-maintenance-page />
    } @else {
      <div [attr.data-theme]="t().data.id" [attr.data-sections]="t().data.layout.home.sections" [attr.data-grid]="t().data.layout.productGrid" class="flex min-h-screen flex-col">
        @if (maintenanceOn() && session.user()?.is_admin) {<pc-maintenance-bar />}
        <pc-app-banner />
        @if (t().preview) {<pc-preview-bar />}
        <ng-container *ngComponentOutlet="slots().Header" />
        <pc-shop-back-bar />
        <main class="mx-auto w-full min-h-[60vh] max-w-shop flex-1 px-3 py-4 sm:px-4 sm:py-6"><router-outlet /></main>
        <pc-back-to-top />
        <pc-region-strip />
        <pc-newsletter-box />
        <ng-container *ngComponentOutlet="slots().Footer" />
        @if (slots().MobileNav) {<ng-container *ngComponentOutlet="slots().MobileNav" />}
        <pc-shop-assistant />
        <pc-compare-tray />
      </div>
    }
  `,
})
export class ShopFrame {
  private readonly theme = inject(ThemeService);
  private readonly site = inject(SiteService).site;
  private readonly path = inject(RouteState).pathname;
  protected readonly session = inject(SessionService);
  protected readonly t = this.theme.active;
  protected readonly slots = computed(() => SLOTS[this.t().data.id] ?? SLOTS.classic);
  protected readonly maintenanceOn = computed(() => Boolean(this.site().maintenance?.on));
  protected readonly closed = computed(() => this.maintenanceOn() && !OPEN_DURING_MAINTENANCE.some((p) => this.path() === p || this.path().startsWith(`${p}/`)));

  constructor() {
    this.theme.inShop.set(true);
    inject(DestroyRef).onDestroy(() => this.theme.inShop.set(false));
  }
}
