/* Bazaar phone tab bar: Home, Categories, Deals (or Orders when deals are off), Cart with its count, Account.
 * Port of themes/bazaar/mobile-nav.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { Flame, Home, LayoutGrid, Package, ShoppingCart, User as UserIcon, type LucideIconData } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

interface Tab {
  href: string;
  label: string;
  icon: LucideIconData;
  /** other pages that belong to this tab */
  also?: string[];
}

function matches(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

@Component({
  selector: "pc-bazaar-mobile-nav",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <nav aria-label="Main" class="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_18px_-8px_rgb(0_0_0/0.18)] sm:hidden">
      <ul class="grid h-14 grid-cols-5">
        @for (tab of tabs(); track tab.href) {
          <li class="relative">
            <a [pcLink]="tab.href" [attr.aria-current]="active(tab) ? 'page' : null" [attr.aria-label]="tab.href === '/cart' ? cartLabel() : null" [class]="tabCls(tab)">
              @if (active(tab)) {<span class="absolute left-1/2 top-0 h-[3px] w-9 -translate-x-1/2 rounded-b-full bg-peacock" aria-hidden="true"></span>}
              <span class="relative">
                <svg [pcIcon]="tab.icon" [strokeWidth]="active(tab) ? 2.4 : 2" class="h-[22px] w-[22px]" aria-hidden="true" />
                @if (tab.href === "/cart" && session.cartCount() > 0) {
                  <span class="absolute -right-2.5 -top-1.5 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px] text-white ring-2 ring-white" aria-hidden="true">
                    {{ session.cartCount() > 99 ? "99+" : session.cartCount() }}
                  </span>
                }
              </span>
              {{ tab.label }}
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class BazaarMobileNav {
  private readonly path = inject(RouteState).pathname;
  protected readonly session = inject(SessionService);
  private readonly site = inject(SiteService).site;
  protected readonly tabs = computed<Tab[]>(() => {
    const deals = this.site().features.deals !== false;
    return [
      { href: "/", label: "Home", icon: Home },
      { href: "/categories", label: "Categories", icon: LayoutGrid, also: ["/c"] },
      deals ? { href: "/deals", label: "Deals", icon: Flame } : { href: "/orders", label: "Orders", icon: Package },
      { href: "/cart", label: "Cart", icon: ShoppingCart },
      { href: "/account", label: "Account", icon: UserIcon, also: ["/wishlist", "/notifications", ...(deals ? ["/orders"] : [])] },
    ];
  });

  protected active(tab: Tab): boolean {
    return matches(this.path(), tab.href) || (tab.also ?? []).some((a) => matches(this.path(), a));
  }
  protected tabCls(tab: Tab): string {
    return cx("flex h-full flex-col items-center justify-center gap-0.5 text-[11px] leading-tight transition-colors",
      this.active(tab) ? "font-semibold text-peacock" : "font-medium text-ink-soft hover:text-ink");
  }
  protected cartLabel(): string {
    const n = this.session.cartCount();
    return `Cart, ${n} ${n === 1 ? "item" : "items"}`;
  }
}
