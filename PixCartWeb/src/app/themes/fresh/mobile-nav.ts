/*
 * Fresh phone tab bar: an app-style white bar (Home, Categories, Orders, Cart with its count, Account); the active
 * tab shows its icon in a tinted pill. While the cart has items, a floating "View cart" pill sits centred above the
 * bar so the cart is always one tap away (not on the cart and checkout pages, and not while the product page's buy
 * bar or the compare tray is showing there). Phones only: tablets and desktops have the header's cart button.
 * Port of themes/fresh/mobile-nav.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { ChevronRight, Home, LayoutGrid, Package, ShoppingBag, ShoppingCart, User as UserIcon, type LucideIconData } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { badgeCount, isCartPath, itemsLabel } from "./parts";

interface Tab {
  href: string;
  label: string;
  icon: LucideIconData;
  active: (path: string) => boolean;
}

const TABS: Tab[] = [
  { href: "/", label: "Home", icon: Home, active: (p) => p === "/" },
  { href: "/categories", label: "Categories", icon: LayoutGrid, active: (p) => p.startsWith("/categories") || p.startsWith("/c/") },
  { href: "/orders", label: "Orders", icon: Package, active: (p) => p.startsWith("/orders") },
  { href: "/cart", label: "Cart", icon: ShoppingCart, active: isCartPath },
  { href: "/account", label: "Account", icon: UserIcon, active: (p) => p.startsWith("/account") },
];

/** The floating cart pill; its wrapper keeps clear of the help button on the right (72 px each side). */
@Component({
  selector: "pc-fresh-cart-pill",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="pointer-events-none fixed inset-x-0 bottom-[calc(3.6rem+0.75rem+env(safe-area-inset-bottom))] z-30 flex animate-rise-in justify-center px-[4.5rem] sm:hidden [body[data-buy-bar]_&]:hidden [body[data-compare-tray]_&]:hidden">
      <a pcLink="/cart" data-testid="cart-pill"
        class="pc-press pointer-events-auto flex h-12 min-w-0 max-w-full items-center gap-2 rounded-full bg-peacock py-1.5 pl-1.5 pr-3 text-white shadow-lg ring-1 ring-black/5 transition-colors hover:bg-peacock-dark">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20">
          <svg [pcIcon]="ShoppingBag" class="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <span class="min-w-0 truncate text-sm font-bold">
          {{ label() }}<span aria-hidden="true"> · </span><span class="sr-only">, </span>View cart
        </span>
        <svg [pcIcon]="ChevronRight" class="h-4 w-4 shrink-0" aria-hidden="true" />
      </a>
    </div>
  `,
})
export class FreshCartPill {
  readonly count = input.required<number>();
  protected readonly label = computed(() => itemsLabel(this.count()));
  protected readonly ShoppingBag = ShoppingBag;
  protected readonly ChevronRight = ChevronRight;
}

@Component({
  selector: "pc-fresh-mobile-nav",
  imports: [Icon, PcLink, FreshCartPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (cartCount() > 0 && !isCartPath(path())) {<pc-fresh-cart-pill [count]="cartCount()" />}
    <nav aria-label="Main"
      class="fixed inset-x-0 bottom-0 z-30 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_rgb(var(--c-line)),0_-6px_18px_-8px_rgb(var(--c-ink)/0.22)] sm:hidden">
      <ul class="grid h-[3.6rem] grid-cols-5">
        @for (tab of tabs; track tab.href) {
          <li class="min-w-0">
            <a [pcLink]="tab.href" [attr.aria-current]="on(tab) ? 'page' : null" [attr.aria-label]="tab.href === '/cart' ? 'Cart, ' + itemsLabel(cartCount()) : null"
              [class]="cx('flex h-full flex-col items-center justify-center gap-1 text-[11px] leading-none transition-colors', on(tab) ? 'font-bold text-peacock' : 'font-medium text-ink-soft hover:text-ink')">
              <span [class]="cx('relative flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200', on(tab) && 'bg-peacock-light')">
                <svg [pcIcon]="tab.icon" class="h-5 w-5" [attr.stroke-width]="on(tab) ? 2.4 : 2" aria-hidden="true" />
                @if (tab.href === '/cart' && cartCount() > 0) {
                  <span class="absolute -top-1 right-0.5 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px] text-white ring-2 ring-white" aria-hidden="true">
                    {{ badgeCount(cartCount()) }}
                  </span>
                }
              </span>
              <span class="max-w-full truncate px-0.5">{{ tab.label }}</span>
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class FreshMobileNav {
  protected readonly path = inject(RouteState).pathname;
  private readonly session = inject(SessionService);
  protected readonly cartCount = this.session.cartCount;
  protected readonly tabs = TABS;
  protected readonly cx = cx;
  protected readonly isCartPath = isCartPath;
  protected readonly badgeCount = badgeCount;
  protected readonly itemsLabel = itemsLabel;

  protected on(tab: Tab): boolean {
    return tab.active(this.path());
  }
}
