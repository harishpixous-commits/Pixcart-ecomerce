/*
 * The Classic theme's chrome: the shared marketplace header, the phone tab bar and the shared footer.
 * Port of themes/classic/slots.tsx (Header: ShopHeader, Footer: ShopFooter, MobileNav: MobileTabBar from
 * components/shop-chrome.tsx). Other themes reuse the parts from shared/shop/shop-chrome.ts and shared/shop/shop-nav.ts.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { Heart, Home, LayoutGrid, Package, ShoppingCart, User as UserIcon } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { ContactList, SocialLinks } from "../../shared/chrome/social";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { AnnouncementBar, CategoriesService, AccountMenu, CartLink, DeliverTo, Logo, NotificationBell, WishlistLink, footerData } from "../../shared/shop/shop-chrome";
import { NavBar, ReturnsOrders, SearchBox } from "../../shared/shop/shop-nav";

@Component({
  selector: "pc-classic-header",
  imports: [AnnouncementBar, Logo, SearchBox, NotificationBell, AccountMenu, ReturnsOrders, CartLink, WishlistLink, NavBar, DeliverTo, Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <header class="sticky top-0 z-30">
      <pc-announcement-bar />
      <div class="bg-peacock">
        <div class="mx-auto flex max-w-shop flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:flex-nowrap sm:px-4">
          <a pcLogo pcLink="/"></a>
          <!-- min-w-0 lets the search shrink so the account and cart buttons never push past the screen edge -->
          <div class="order-last w-full min-w-0 sm:order-none sm:flex-1">
            <pc-search-box [categories]="cats()" />
          </div>
          <nav class="ml-auto flex items-center gap-1 sm:ml-0">
            @for (l of site().header_links; track l.href) {
              <a [pcLink]="l.href" class="hidden h-10 items-center rounded-lg px-3 font-semibold text-white hover:bg-white/10 lg:flex">{{ l.label }}</a>
            }
            <pc-wishlist-link />
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
  private readonly categories = inject(CategoriesService);
  protected readonly site = inject(SiteService).site;
  protected readonly cats = this.categories.categories;
}

@Component({
  selector: "pc-classic-mobile-nav",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <nav class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] sm:hidden" aria-label="Main">
      @for (tab of tabs; track tab.href) {
        <a [pcLink]="tab.href" [class]="tabCls(tab.href)">
          <svg [pcIcon]="tab.icon" class="h-5 w-5" />
          {{ tab.label }}
          @if (tab.href === "/cart" && session.cartCount() > 0) {<span class="absolute right-[22%] top-1 h-2 w-2 rounded-full bg-vermilion"></span>}
        </a>
      }
    </nav>
  `,
})
export class ClassicMobileNav {
  private readonly path = inject(RouteState).pathname;
  protected readonly session = inject(SessionService);
  protected readonly tabs = [
    { href: "/", label: "Home", icon: Home },
    { href: "/categories", label: "Categories", icon: LayoutGrid },
    { href: "/orders", label: "Orders", icon: Package },
    { href: "/cart", label: "Cart", icon: ShoppingCart },
    { href: "/account", label: "Account", icon: UserIcon },
  ];

  protected tabCls(href: string): string {
    const active = href === "/" ? this.path() === "/" : this.path().startsWith(href);
    return cx("relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", active ? "text-peacock" : "text-ink-faint");
  }
}

/**
 * What every theme's footer shows (Admin → Storefront → Navigation and footer / Business): the link columns,
 * contact details, social links, the grievance officer (Consumer Protection (E-Commerce) Rules 2020) and the legal line.
 */
@Component({
  selector: "pc-classic-footer",
  imports: [Logo, SocialLinks, ContactList, Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <footer class="mt-12 bg-peacock-dark pb-20 text-white/80 sm:pb-0">
      <div class="mx-auto grid max-w-shop gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-5">
        <div class="flex flex-col gap-3 lg:col-span-1">
          <a pcLogo pcLink="/"></a>
          @if (site().tagline) {<p class="text-sm">{{ site().tagline }}</p>}
          @if (d().socialOn) {
            <div>
              @if (site().social.title) {<p class="mb-2 text-sm font-semibold text-white">{{ site().social.title }}</p>}
              <pc-social-links [links]="site().social.links" />
            </div>
          }
        </div>
        @for (col of d().columns; track col.title) {
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
        @if (d().contactOn || d().grievance) {
          <div class="flex flex-col gap-4 text-sm">
            @if (d().contactOn) {
              <div>
                <p class="mb-2 font-semibold text-white">{{ site().contact.title || "Contact us" }}</p>
                <pc-contact-list [items]="site().contact.items" />
              </div>
            }
            @if (d().grievance; as g) {
              <div>
                <p class="font-semibold text-white">Grievance officer</p>
                <p>{{ g.name }}@if (g.designation) {, {{ g.designation }}}</p>
                @if (g.email) {<a [href]="'mailto:' + g.email" class="block hover:text-white">{{ g.email }}</a>}
                @if (g.phone) {<p>{{ g.phone }}</p>}
                <a pcLink="/help/grievance" class="mt-1 block text-white underline-offset-2 hover:underline">How to raise a complaint</a>
              </div>
            }
          </div>
        }
      </div>
      <div class="border-t border-white/10">
        <div class="mx-auto flex max-w-shop flex-col gap-1 px-4 py-4 text-xs text-white/60">
          @if (d().copyright) {<p>{{ d().copyright }}</p>}
          @if (d().business) {<p>{{ d().business }}</p>}
        </div>
      </div>
    </footer>
  `,
})
export class ClassicFooter {
  protected readonly site = inject(SiteService).site;
  protected readonly d = computed(() => footerData(this.site()));
}
