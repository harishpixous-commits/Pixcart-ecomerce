/*
 * Classic (the original look): the search-first header with the awning edge and a category bar, the five-tab phone
 * bar and the dark brand footer. Port of ShopHeader, MobileTabBar and ShopFooter in components/shop-chrome.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { Heart, House, LayoutGrid, Package, ShoppingCart, User as UserIcon, type LucideIconData } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { ContactList, SocialLinks, fillCopyright } from "../../shared/chrome/social";
import { AccountMenu, AnnouncementBar, CartLink, CategoriesService, DeliverTo, Logo, NotificationBell } from "../../shared/shop/shop-chrome";
import { NavBar, ReturnsOrders, SearchBox } from "../../shared/shop/shop-nav";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

@Component({
  selector: "pc-classic-header",
  imports: [Icon, PcLink, Logo, AnnouncementBar, SearchBox, NotificationBell, AccountMenu, ReturnsOrders, CartLink, NavBar, DeliverTo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <header class="sticky top-0 z-30">
    <pc-announcement-bar />
    <div class="bg-peacock">
      <div class="mx-auto flex max-w-shop flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap sm:px-4">
        <a pcLogo></a>
        <div class="order-last w-full min-w-0 sm:order-none sm:flex-1">
          <form pcSearchBox [categories]="cats()"></form>
        </div>
        <nav class="ml-auto flex items-center gap-1 sm:ml-0">
          @for (l of site().header_links; track l.href) {
            <a [pcLink]="l.href" class="hidden h-10 items-center rounded-lg px-3 font-semibold text-white hover:bg-white/10 lg:flex">{{ l.label }}</a>
          }
          @if (site().features.wishlist) {
            <a pcLink="/wishlist" class="hidden h-10 w-10 items-center justify-center rounded-lg text-white hover:bg-white/10 sm:flex" aria-label="Wishlist"><svg [pcIcon]="Heart" class="h-5 w-5" /></a>
          }
          <pc-notification-bell />
          <pc-account-menu />
          <pc-returns-orders />
          <pc-cart-link />
        </nav>
      </div>
    </div>
    <div class="relative bg-white shadow-sm">
      <div class="awning absolute inset-x-0 top-0" aria-hidden="true"></div>
      <pc-nav-bar [categories]="cats()">
        @if (site().pdp?.header_pincode !== false) {<pc-deliver-to />}
      </pc-nav-bar>
    </div>
    </header>
  `,
})
export class ClassicHeader {
  protected readonly site = inject(SiteService).site;
  protected readonly cats = inject(CategoriesService).categories;
  protected readonly Heart = Heart;
}

@Component({
  selector: "pc-classic-mobile-nav",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <nav class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] sm:hidden" aria-label="Main">
      @for (t of tabs; track t.href) {
        <a [pcLink]="t.href" [class]="active(t.href) ? 'relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-peacock' : 'relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-ink-faint'">
          <svg [pcIcon]="t.icon" class="h-5 w-5" />
          {{ t.label }}
          @if (t.href === "/cart" && session.cartCount() > 0) {<span class="absolute right-[22%] top-1 h-2 w-2 rounded-full bg-vermilion"></span>}
        </a>
      }
    </nav>
  `,
})
export class ClassicMobileNav {
  private readonly path = inject(RouteState).pathname;
  protected readonly session = inject(SessionService);
  protected readonly tabs: { href: string; label: string; icon: LucideIconData }[] = [
    { href: "/", label: "Home", icon: House },
    { href: "/categories", label: "Categories", icon: LayoutGrid },
    { href: "/orders", label: "Orders", icon: Package },
    { href: "/cart", label: "Cart", icon: ShoppingCart },
    { href: "/account", label: "Account", icon: UserIcon },
  ];
  protected active(href: string): boolean {
    return href === "/" ? this.path() === "/" : this.path().startsWith(href);
  }
}

@Component({
  selector: "pc-classic-footer",
  imports: [PcLink, Logo, SocialLinks, ContactList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <footer class="mt-12 bg-peacock-dark pb-20 text-white/80 sm:pb-0">
    <div class="mx-auto grid max-w-shop gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-5">
      <div class="flex flex-col gap-3 lg:col-span-1">
        <a pcLogo></a>
        @if (site().tagline) {<p class="text-sm">{{ site().tagline }}</p>}
        @if (socialOn()) {
          <div>
            @if (site().social.title) {<p class="mb-2 text-sm font-semibold text-white">{{ site().social.title }}</p>}
            <pc-social-links [links]="site().social.links" />
          </div>
        }
      </div>
      @for (col of site().footer_columns; track col.title) {
        <nav class="flex flex-col gap-1.5 text-sm" [attr.aria-label]="col.title">
          <p class="font-semibold text-white">{{ col.title }}</p>
          @for (l of col.links; track l.href + l.label) {
            @if (l.href.startsWith("https://")) {
              <a [href]="l.href" target="_blank" rel="noopener noreferrer" class="hover:text-white">{{ l.label }}</a>
            } @else {
              <a [pcLink]="l.href" class="hover:text-white">{{ l.label }}</a>
            }
          }
        </nav>
      }
      @if (contactOn() || (f().show_grievance && g().name)) {
        <div class="flex flex-col gap-4 text-sm">
          @if (contactOn()) {
            <div>
              <p class="mb-2 font-semibold text-white">{{ site().contact.title || "Contact us" }}</p>
              <pc-contact-list [items]="site().contact.items" />
            </div>
          }
          @if (f().show_grievance && g().name) {
            <div>
              <p class="font-semibold text-white">Grievance officer</p>
              <p>{{ g().name }}{{ g().designation ? ", " + g().designation : "" }}</p>
              @if (g().email) {<a [href]="'mailto:' + g().email" class="block hover:text-white">{{ g().email }}</a>}
              @if (g().phone) {<p>{{ g().phone }}</p>}
              <a pcLink="/help/grievance" class="mt-1 block text-white underline-offset-2 hover:underline">How to raise a complaint</a>
            </div>
          }
        </div>
      }
    </div>
    <div class="border-t border-white/10">
      <div class="mx-auto flex max-w-shop flex-col gap-1 px-4 py-4 text-xs text-white/60">
        @if (f().copyright) {<p>{{ copyright() }}</p>}
        @if (business()) {<p>{{ business() }}</p>}
      </div>
    </div>
    </footer>
  `,
})
export class ClassicFooter {
  protected readonly site = inject(SiteService).site;
  protected readonly f = computed(() => this.site().footer);
  protected readonly g = computed(() => this.site().business.grievance);
  protected readonly contactOn = computed(() => this.f().show_contact && this.site().contact.enabled && this.site().contact.items.some((i) => i.enabled));
  protected readonly socialOn = computed(() => this.f().show_social && this.site().social.enabled && this.site().social.links.some((l) => l.enabled && l.url));
  protected readonly copyright = computed(() => fillCopyright(this.f().copyright, { legal_name: this.site().business.legal_name || this.site().brand_name, brand: this.site().brand_name }));
  protected readonly business = computed(() => {
    const b = this.site().business;
    const f = this.f();
    return f.show_business && (b.registered_address || (f.show_gstin && b.gstin) || b.cin)
      ? [b.legal_name, b.registered_address ? `Registered office: ${b.registered_address}` : "", f.show_gstin && b.gstin ? `GSTIN ${b.gstin}` : "", b.cin ? `CIN ${b.cin}` : ""].filter(Boolean).join(". ")
      : "";
  });
}
