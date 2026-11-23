/*
 * Luxe phone tab bar: a minimal white bar under a hairline, thin icons and tiny capitals. The current tab is in ink
 * with a short rule along the top edge; the bag shows how many items are in the cart.
 * Port of themes/luxe/mobile-nav.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { Heart, Home, LayoutGrid, Package, ShoppingBag, User as UserIcon, type LucideIconData } from "lucide-angular";
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
  also: string[];
}

@Component({
  selector: "pc-luxe-mobile-nav",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <nav aria-label="Main" class="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden">
      <ul class="grid h-14 grid-cols-5">
        @for (tab of tabs(); track tab.href) {
          <li>
            <a [pcLink]="tab.href" [attr.aria-current]="active(tab) ? 'page' : null" [attr.aria-label]="tab.href === '/cart' ? 'Bag, ' + cartCount() + ' items' : null"
              [class]="cx('relative flex h-full flex-col items-center justify-center gap-1 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors', active(tab) ? 'text-ink' : 'text-ink-faint hover:text-ink-soft')">
              <span aria-hidden="true" [class]="cx('absolute left-1/2 top-0 h-0.5 w-8 -translate-x-1/2 bg-ink transition-transform duration-200', active(tab) ? 'scale-x-100' : 'scale-x-0')"></span>
              <span class="relative">
                <svg [pcIcon]="tab.icon" class="h-5 w-5" stroke-width="1.5" aria-hidden="true" />
                @if (tab.href === '/cart' && cartCount() > 0) {
                  <span class="absolute -right-2.5 -top-1.5 min-w-[16px] rounded-full bg-peacock px-1 text-center text-[10px] font-semibold leading-4 tracking-normal text-white">
                    {{ cartCount() > 99 ? "99+" : cartCount() }}
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
export class LuxeMobileNav {
  protected readonly path = inject(RouteState).pathname;
  private readonly site = inject(SiteService).site;
  private readonly session = inject(SessionService);
  protected readonly cartCount = this.session.cartCount;
  protected readonly cx = cx;

  protected readonly tabs = computed<Tab[]>(() => [
    { href: "/", label: "Home", icon: Home, also: [] },
    { href: "/categories", label: "Shop", icon: LayoutGrid, also: ["/c"] },
    this.site().features.wishlist
      ? { href: "/wishlist", label: "Wishlist", icon: Heart, also: [] }
      : { href: "/orders", label: "Orders", icon: Package, also: [] },
    { href: "/cart", label: "Bag", icon: ShoppingBag, also: [] },
    { href: "/account", label: "Account", icon: UserIcon, also: [] },
  ]);

  private under(base: string): boolean {
    const p = this.path();
    return p === base || p.startsWith(`${base}/`);
  }

  protected active(tab: Tab): boolean {
    return tab.href === "/" ? this.path() === "/" : this.under(tab.href) || tab.also.some((a) => this.under(a));
  }
}
