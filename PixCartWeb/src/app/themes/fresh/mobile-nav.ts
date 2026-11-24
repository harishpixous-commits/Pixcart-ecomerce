/*
 * Fresh phone tab bar: an app-style white bar (Home, Categories, Orders, Cart with its count, Account); the active tab
 * shows its icon in a tinted pill. While the cart has items, a floating "View cart" pill sits centred above the bar (not
 * on the cart and checkout pages, and not while the product page's buy bar or the compare tray is showing there).
 * Phones only. Port of themes/fresh/mobile-nav.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { ChevronRight, House, LayoutGrid, Package, ShoppingBag, ShoppingCart, User as UserIcon, type LucideIconData } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
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
  { href: "/", label: "Home", icon: House, active: (p) => p === "/" },
  { href: "/categories", label: "Categories", icon: LayoutGrid, active: (p) => p.startsWith("/categories") || p.startsWith("/c/") },
  { href: "/orders", label: "Orders", icon: Package, active: (p) => p.startsWith("/orders") },
  { href: "/cart", label: "Cart", icon: ShoppingCart, active: isCartPath },
  { href: "/account", label: "Account", icon: UserIcon, active: (p) => p.startsWith("/account") },
];

@Component({
  selector: "pc-fresh-mobile-nav",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (count() > 0 && !isCartPath(path())) {
      <div class="pointer-events-none fixed inset-x-0 bottom-[calc(3.6rem+0.75rem+env(safe-area-inset-bottom))] z-30 flex animate-rise-in justify-center px-[4.5rem] sm:hidden [body[data-buy-bar]_&]:hidden [body[data-compare-tray]_&]:hidden">
        <a pcLink="/cart" data-testid="cart-pill"
          class="pc-press pointer-events-auto flex h-12 min-w-0 max-w-full items-center gap-2 rounded-full bg-peacock py-1.5 pl-1.5 pr-3 text-white shadow-lg ring-1 ring-black/5 transition-colors hover:bg-peacock-dark">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20">
            <svg [pcIcon]="ShoppingBag" class="h-[18px] w-[18px]" />
          </span>
          <span class="min-w-0 truncate text-sm font-bold">{{ items() }}<span aria-hidden="true"> · </span><span class="sr-only">, </span>View cart</span>
          <svg [pcIcon]="ChevronRight" class="h-4 w-4 shrink-0" />
        </a>
      </div>
    }
    <nav aria-label="Main"
      class="fixed inset-x-0 bottom-0 z-30 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_rgb(var(--c-line)),0_-6px_18px_-8px_rgb(var(--c-ink)/0.22)] sm:hidden">
      <ul class="grid h-[3.6rem] grid-cols-5">
        @for (t of tabs; track t.href) {
          <li class="min-w-0">
            <a [pcLink]="t.href" [attr.aria-current]="t.active(path()) ? 'page' : null" [attr.aria-label]="t.href === '/cart' ? 'Cart, ' + items() : null"
              [class]="t.active(path()) ? 'flex h-full flex-col items-center justify-center gap-1 text-[11px] leading-none transition-colors font-bold text-peacock' : 'flex h-full flex-col items-center justify-center gap-1 text-[11px] leading-none transition-colors font-medium text-ink-soft hover:text-ink'">
              <span [class]="t.active(path()) ? 'relative flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200 bg-peacock-light' : 'relative flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200'">
                <svg [pcIcon]="t.icon" class="h-5 w-5" [strokeWidth]="t.active(path()) ? 2.4 : 2" />
                @if (t.href === "/cart" && count() > 0) {
                  <span class="absolute -top-1 right-0.5 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px] text-white ring-2 ring-white" aria-hidden="true">{{ badge() }}</span>
                }
              </span>
              <span class="max-w-full truncate px-0.5">{{ t.label }}</span>
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
  protected readonly tabs = TABS;
  protected readonly isCartPath = isCartPath;
  protected readonly count = this.session.cartCount;
  protected readonly items = computed(() => itemsLabel(this.count()));
  protected readonly badge = computed(() => badgeCount(this.count()));
  protected readonly ShoppingBag = ShoppingBag;
  protected readonly ChevronRight = ChevronRight;
}
