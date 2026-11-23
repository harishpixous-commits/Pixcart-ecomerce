/*
 * The shop header's shared parts, used by every theme's header and footer (and the panels' logo and bell).
 * Port of components/shop-chrome.tsx (the Classic header, tab bar and footer are in themes/classic/chrome.ts):
 *   CategoriesService (useCategories), <a pcLogo [light]>, <pc-announcement-bar>, <pc-notification-bell [dark]>,
 *   <pc-account-menu tone compact>, <pc-deliver-to tone>, <pc-cart-link tone [label]>, <pc-wishlist-link tone>,
 *   footerData() (useFooter), <pc-footer-link [href] [label] linkClass>.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, Injectable, computed, effect, inject, input, signal, untracked } from "@angular/core";
import { Bell, ChevronDown, Globe, Heart, MapPin, ShoppingCart, User as UserIcon, X } from "lucide-angular";
import { api } from "../../core/api";
import { PincodeService, isPincode } from "../../core/pincode";
import { RegionalService } from "../../core/regional";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { fillTokens, splitBrand } from "../../core/tokens";
import type { Address, CategoryNode } from "../../core/types";
import { RegionDialog, hasRegionChoice } from "../chrome/region-picker";
import { fillCopyright } from "../chrome/social";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";
import { Autofocus } from "../ui/ui";

/** The category tree, read once per visit (useCategories). */
@Injectable({ providedIn: "root" })
export class CategoriesService {
  private readonly tree = signal<CategoryNode[]>([]);
  private loading = false;
  /** the categories (empty until loaded; asking starts the load) */
  readonly categories = computed(() => {
    if (!this.loading) untracked(() => this.load());
    return this.tree();
  });
  private load(): void {
    this.loading = true;
    api<CategoryNode[]>("/api/catalog/categories").then((c) => this.tree.set(c)).catch(() => (this.loading = false));
  }
}

/** Runs `close` on a click outside `host` or on Escape while `open()` is true (the reference's menu effects). */
export function closeOnOutside(open: () => boolean, close: () => void, host: () => HTMLElement | null | undefined) {
  const destroy = inject(DestroyRef);
  effect((onCleanup) => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => { const h = host(); if (h && !h.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", esc);
    onCleanup(() => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", esc); });
  });
  return destroy;
}

/** Closes something when the page changes (the reference's "a new page: close the menu"). */
export function closeOnNavigate(close: () => void) {
  const path = inject(RouteState).pathname;
  let first = true;
  effect(() => {
    path();
    if (first) { first = false; return; }
    untracked(close);
  });
}

/** The brand: the logo image, or the two-tone wordmark. Usage: <a pcLogo [light]="false"></a>. */
@Component({
  selector: "a[pcLogo]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [{ directive: PcLink, inputs: ["pcLink"] }],
  host: { "[class]": "cls()", "[attr.aria-label]": "site().brand_name + ' home'", "[attr.translate]": "site().logo_url ? null : 'no'" },
  template: `@if (site().logo_url) {<img [src]="site().logo_url" [alt]="site().brand_name" class="h-9 w-auto max-w-[160px] object-contain" />} @else {{{ parts()[0] }}@if (parts()[1]) {<span class="text-marigold">{{ parts()[1] }}</span>}}`,
})
export class Logo {
  readonly light = input(true);
  protected readonly site = inject(SiteService).site;
  protected readonly parts = computed(() => splitBrand(this.site().brand_name));
  protected readonly cls = computed(() =>
    this.site().logo_url ? "flex items-center" : cx("flex items-baseline font-display text-2xl font-bold tracking-tight", this.light() ? "text-white" : "text-peacock"));
}

@Component({
  selector: "pc-announcement-bar",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (a().enabled && a().text) {
      @if (a().link) {
        <a [pcLink]="a().link" [class]="'block hover:opacity-90 ' + tone()"><span class="mx-auto block max-w-shop truncate px-4 py-1.5 text-center text-sm font-medium">{{ text() }}</span></a>
      } @else {
        <div [class]="tone()"><span class="mx-auto block max-w-shop truncate px-4 py-1.5 text-center text-sm font-medium">{{ text() }}</span></div>
      }
    }
  `,
})
export class AnnouncementBar {
  private readonly site = inject(SiteService).site;
  protected readonly a = computed(() => this.site().announcement);
  protected readonly tone = computed(() => (this.a().tone === "primary" ? "bg-peacock-dark text-white" : this.a().tone === "dark" ? "bg-ink text-white" : "bg-marigold text-ink"));
  protected readonly text = computed(() => fillTokens(this.a().text, this.site()));
}

@Component({
  selector: "pc-notification-bell",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (session.user()) {
      <a pcLink="/notifications" [class]="cls()" [attr.aria-label]="'Notifications, ' + count() + ' unread'">
        <svg [pcIcon]="Bell" class="h-5 w-5" />
        @if (count() > 0) {<span class="absolute right-1 top-1 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px] text-white">{{ count() > 9 ? "9+" : count() }}</span>}
      </a>
    }
  `,
})
export class NotificationBell {
  readonly dark = input(false);
  protected readonly session = inject(SessionService);
  private readonly path = inject(RouteState).pathname;
  protected readonly Bell = Bell;
  protected readonly count = signal(0);
  protected readonly cls = computed(() => cx("relative flex h-10 w-10 items-center justify-center rounded-lg", this.dark() ? "text-ink-soft hover:bg-mist" : "text-white hover:bg-white/10"));
  constructor() {
    effect(() => {
      const user = this.session.user();
      this.path();
      if (!user) return;
      api<{ unread: number }>("/api/notifications").then((r) => this.count.set(r.unread)).catch(() => {});
    });
  }
}

/** Header text colours: "dark" for a header on the brand colour (white text), "light" for a white header. */
export type HeaderTone = "dark" | "light";
export const TONE_TEXT: Record<HeaderTone, { text: string; sub: string; hover: string }> = {
  dark: { text: "text-white", sub: "text-white/80", hover: "hover:bg-white/10" },
  light: { text: "text-ink", sub: "text-ink-faint", hover: "hover:bg-mist" },
};

/**
 * Sign in, or the account menu (orders, wishlist, help, profile, selling, admin, sign out).
 * compact: an icon with a short label instead of the two-line "Hello, name / Account & Lists".
 */
@Component({
  selector: "pc-account-menu",
  imports: [Icon, PcLink, RegionDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!session.ready()) {
      <div [class]="compact() ? 'h-10 w-10' : 'h-10 w-24'"></div>
    } @else if (!session.user()) {
      <a [pcLink]="'/login?next=' + enc(path())" [class]="linkCls()" data-testid="account-signin">
        <svg [pcIcon]="UserIcon" [class]="compact() ? 'h-5 w-5' : 'h-5 w-5 sm:hidden'" />
        @if (compact()) {
          <span class="hidden text-sm font-semibold sm:inline">Sign in</span>
        } @else {
          <span class="hidden flex-col leading-tight sm:flex">
            <span [class]="'text-xs ' + t().sub">Hello, sign in</span>
            <span class="text-sm font-semibold">Account &amp; Lists</span>
          </span>
        }
      </a>
    } @else {
      <div class="relative" #box>
        <button (click)="open.set(!open())" [class]="buttonCls()" [attr.aria-expanded]="open()" aria-haspopup="menu" data-testid="account-menu">
          <svg [pcIcon]="UserIcon" [class]="compact() ? 'h-5 w-5' : 'h-5 w-5 sm:hidden'" />
          @if (compact()) {
            <span class="hidden max-w-[110px] truncate text-sm font-semibold sm:inline">{{ first() || "Account" }}</span>
          } @else {
            <span class="hidden flex-col leading-tight sm:flex">
              <span [class]="'max-w-[130px] truncate text-xs ' + t().sub">Hello, {{ first() || "there" }}</span>
              <span class="text-sm font-semibold">Account &amp; Lists</span>
            </span>
          }
          <svg [pcIcon]="ChevronDown" class="h-4 w-4" />
        </button>
        @if (open()) {
          <div class="absolute right-0 top-12 z-40 w-56 animate-rise-in overflow-hidden rounded-lg bg-white py-1 text-ink shadow-xl ring-1 ring-line" role="menu">
            <a pcLink="/orders" class="block px-4 py-2 hover:bg-mist">Your orders</a>
            <a pcLink="/wishlist" class="block px-4 py-2 hover:bg-mist">Wishlist</a>
            <a pcLink="/support" class="block px-4 py-2 hover:bg-mist">Help and support</a>
            <a pcLink="/contact" class="block px-4 py-2 hover:bg-mist">Contact us</a>
            <a pcLink="/account" class="block px-4 py-2 hover:bg-mist">Profile and addresses</a>
            <a pcLink="/app" class="block px-4 py-2 hover:bg-mist">Get the app</a>
            @if (session.user()!.seller) {
              <a pcLink="/seller" class="block px-4 py-2 hover:bg-mist">Seller dashboard</a>
            } @else {
              <a pcLink="/sell" class="block px-4 py-2 hover:bg-mist">Sell on {{ site().brand_name }}</a>
            }
            @if (session.user()!.is_admin) {<a pcLink="/admin" class="block px-4 py-2 hover:bg-mist">Admin panel</a>}
            @if (hasRegion()) {
              <button type="button" (click)="open.set(false); regionOpen.set(true)" class="flex w-full items-center gap-2 border-t border-line px-4 py-2 text-left hover:bg-mist" data-testid="menu-region">
                <svg [pcIcon]="Globe" class="h-4 w-4 text-peacock" /> Language and currency
              </button>
            }
            <button (click)="session.signOut()" class="block w-full border-t border-line px-4 py-2 text-left hover:bg-mist">Sign out</button>
          </div>
        }
        @if (regionOpen()) {<pc-region-dialog (close)="regionOpen.set(false)" />}
      </div>
    }
  `,
})
export class AccountMenu {
  readonly tone = input<HeaderTone>("dark");
  readonly compact = input(false);
  protected readonly site = inject(SiteService).site;
  protected readonly session = inject(SessionService);
  private readonly regional = inject(RegionalService);
  protected readonly path = inject(RouteState).pathname;
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly open = signal(false);
  protected readonly regionOpen = signal(false);
  protected readonly UserIcon = UserIcon;
  protected readonly ChevronDown = ChevronDown;
  protected readonly Globe = Globe;
  protected readonly enc = encodeURIComponent;
  protected readonly t = computed(() => TONE_TEXT[this.tone()]);
  protected readonly hasRegion = computed(() => hasRegionChoice(this.regional));
  protected readonly first = computed(() => this.session.user()?.name?.split(" ")[0] ?? "");
  protected readonly linkCls = computed(() => cx("flex h-10 items-center gap-2 rounded-lg px-2", this.t().text, this.t().hover, !this.compact() && "sm:px-3"));
  protected readonly buttonCls = computed(() => cx("flex h-10 items-center gap-1.5 rounded-lg px-2 text-left", this.t().text, this.t().hover, !this.compact() && "sm:px-3"));
  constructor() {
    closeOnOutside(this.open, () => this.open.set(false), () => this.el.parentElement?.querySelector(":scope > .relative") ?? this.el.nextElementSibling as HTMLElement);
    closeOnNavigate(() => this.open.set(false));
  }
}

/** "Deliver to 641001": one PIN code for the whole visit; product pages show delivery dates for it. */
@Component({
  selector: "pc-deliver-to",
  imports: [Icon, PcLink, Autofocus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative block shrink-0" },
  template: `
    <button type="button" (click)="toggle()" [attr.aria-expanded]="open()" [class]="btnCls()" data-testid="deliver-to">
      <svg [pcIcon]="MapPin" [class]="tone() === 'dark' ? 'h-4 w-4 text-marigold' : 'h-4 w-4 text-peacock'" />
      @if (pin.pin()) {
        <span>Deliver to <span [class]="tone() === 'dark' ? 'font-semibold text-white' : 'font-semibold text-ink'">{{ pin.pin() }}</span></span>
      } @else {
        <span class="font-semibold">Set delivery PIN</span>
      }
      <svg [pcIcon]="ChevronDown" class="h-3.5 w-3.5" />
    </button>
    @if (open()) {
      <div class="absolute left-0 top-10 z-40 w-[300px] rounded-xl bg-white p-4 text-ink shadow-xl ring-1 ring-line">
        <div class="mb-2 flex items-center justify-between">
          <p class="font-semibold">Choose your location</p>
          <button type="button" (click)="open.set(false)" aria-label="Close" class="rounded p-1 hover:bg-mist"><svg [pcIcon]="X" class="h-4 w-4" /></button>
        </div>
        <p class="mb-3 text-sm text-ink-soft">Delivery dates, charges and cash on delivery depend on where you are.</p>
        @if (addresses().length > 0) {
          <ul class="mb-3 flex max-h-40 flex-col gap-1.5 overflow-y-auto">
            @for (a of addresses(); track a.id) {
              <li>
                <button type="button" (click)="pin.set(a.pincode); open.set(false)"
                  [class]="a.pincode === pin.pin() ? 'w-full rounded-lg border px-3 py-2 text-left text-sm border-peacock bg-peacock-light' : 'w-full rounded-lg border px-3 py-2 text-left text-sm border-line hover:border-peacock'">
                  <span class="font-semibold">{{ a.full_name }}</span> · {{ a.city }} {{ a.pincode }}
                </button>
              </li>
            }
          </ul>
        }
        <form (submit)="apply($event)" class="flex gap-2">
          <label for="hdr-pin" class="sr-only">PIN code</label>
          <input id="hdr-pin" inputmode="numeric" maxlength="6" [value]="value()" pcAutofocus placeholder="Enter PIN code" (input)="onInput($event)"
            class="h-10 min-w-0 flex-1 rounded-lg border border-line px-3 focus:border-peacock focus:outline-none" />
          <button type="submit" class="h-10 rounded-lg bg-peacock px-4 font-semibold text-white hover:bg-peacock-dark">Apply</button>
        </form>
        @if (error()) {<p class="mt-1 text-sm text-vermilion">{{ error() }}</p>}
        @if (!session.user()) {<p class="mt-3 text-xs text-ink-faint"><a pcLink="/login" class="font-semibold text-peacock">Sign in</a> to use your saved addresses.</p>}
      </div>
    }
  `,
})
export class DeliverTo {
  readonly tone = input<HeaderTone>("light");
  protected readonly pin = inject(PincodeService);
  protected readonly session = inject(SessionService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly open = signal(false);
  protected readonly value = signal("");
  protected readonly error = signal("");
  protected readonly addresses = signal<Address[]>([]);
  protected readonly MapPin = MapPin;
  protected readonly ChevronDown = ChevronDown;
  protected readonly X = X;
  protected readonly btnCls = computed(() => cx("flex items-center gap-1 rounded-full px-2.5 py-1 text-[14px]",
    this.tone() === "dark" ? "text-white/85 hover:bg-white/10 hover:text-white" : "text-ink-soft hover:bg-peacock-light hover:text-peacock"));
  constructor() {
    effect(() => {
      const user = this.session.user();
      if (!user) return;
      api<Address[]>("/api/addresses")
        .then((list) => {
          this.addresses.set(list);
          const def = list.find((a) => a.is_default) ?? list[0];
          if (def && !localStorage.getItem("pc_pin")) this.pin.set(def.pincode);
        })
        .catch(() => {});
    });
    closeOnOutside(this.open, () => this.open.set(false), () => this.el);
  }
  protected toggle(): void {
    this.value.set(this.pin.pin());
    this.error.set("");
    this.open.set(!this.open());
  }
  protected onInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = el.value.replace(/\D/g, "");
    el.value = v;
    this.value.set(v);
    this.error.set("");
  }
  protected apply(e: Event): void {
    e.preventDefault();
    if (!isPincode(this.value())) {
      this.error.set("Enter a valid 6-digit PIN code");
      return;
    }
    this.pin.set(this.value());
    this.open.set(false);
  }
}

/** The cart button with its item count. */
@Component({
  selector: "pc-cart-link",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <a pcLink="/cart" [class]="cls()" [attr.aria-label]="'Cart, ' + session.cartCount() + ' items'" data-testid="header-cart">
      <svg [pcIcon]="ShoppingCart" class="h-5 w-5" />
      @if (label()) {<span class="hidden sm:inline">Cart</span>}
      @if (session.cartCount() > 0) {
        <span class="absolute -top-0.5 left-6 min-w-[20px] rounded-full bg-marigold px-1 text-center text-xs font-bold leading-5 text-ink">{{ session.cartCount() > 99 ? "99+" : session.cartCount() }}</span>
      }
    </a>
  `,
})
export class CartLink {
  readonly tone = input<HeaderTone>("dark");
  readonly label = input(true);
  protected readonly session = inject(SessionService);
  protected readonly ShoppingCart = ShoppingCart;
  protected readonly cls = computed(() => cx("relative flex h-10 items-center gap-2 rounded-lg px-3 font-semibold", TONE_TEXT[this.tone()].text, TONE_TEXT[this.tone()].hover));
}

/** The wishlist heart link (when wishlists are on). */
@Component({
  selector: "pc-wishlist-link",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (site().features.wishlist) {
      <a pcLink="/wishlist" [class]="cls()" aria-label="Wishlist"><svg [pcIcon]="Heart" class="h-5 w-5" /></a>
    }
  `,
})
export class WishlistLink {
  readonly tone = input<HeaderTone>("dark");
  protected readonly site = inject(SiteService).site;
  protected readonly Heart = Heart;
  protected readonly cls = computed(() => cx("hidden h-10 w-10 items-center justify-center rounded-lg sm:flex", TONE_TEXT[this.tone()].text, TONE_TEXT[this.tone()].hover));
}

/**
 * What every theme's footer shows (Admin → Storefront → Navigation and footer / Business): the link columns, contact
 * details, social links, the grievance officer (Consumer Protection (E-Commerce) Rules 2020) and the legal line.
 * useFooter() → footerData(site()).
 */
export function footerData(site: ReturnType<SiteService["site"]>) {
  const b = site.business;
  const f = site.footer;
  const legal = b.legal_name || site.brand_name;
  const contactOn = f.show_contact && site.contact.enabled && site.contact.items.some((i) => i.enabled);
  const socialOn = f.show_social && site.social.enabled && site.social.links.some((l) => l.enabled && l.url);
  const grievance = f.show_grievance && b.grievance.name ? b.grievance : null;
  const copyright = f.copyright ? fillCopyright(f.copyright, { legal_name: legal, brand: site.brand_name }) : "";
  const business = f.show_business && (b.registered_address || (f.show_gstin && b.gstin) || b.cin)
    ? [b.legal_name, b.registered_address ? `Registered office: ${b.registered_address}` : "", f.show_gstin && b.gstin ? `GSTIN ${b.gstin}` : "", b.cin ? `CIN ${b.cin}` : ""].filter(Boolean).join(". ")
    : "";
  return { site, columns: site.footer_columns, contactOn, socialOn, grievance, copyright, business };
}

/** A footer link: outside links open in a new tab. */
@Component({
  selector: "pc-footer-link",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (href().startsWith("https://")) {
      <a [href]="href()" target="_blank" rel="noopener noreferrer" [class]="linkClass()">{{ label() }}</a>
    } @else {
      <a [pcLink]="href()" [class]="linkClass()">{{ label() }}</a>
    }
  `,
})
export class FooterLink {
  readonly href = input.required<string>();
  readonly label = input.required<string>();
  readonly linkClass = input<string>("");
}
