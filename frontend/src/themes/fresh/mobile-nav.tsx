"use client";

/*
 * Fresh phone tab bar: an app-style white bar (Home, Categories, Orders, Cart with its count, Account); the active
 * tab shows its icon in a tinted pill. While the cart has items, a floating "View cart" pill sits centred above the
 * bar so the cart is always one tap away (not on the cart and checkout pages, and not while the product page's buy
 * bar or the compare tray is showing there). Phones only: tablets and desktops have the header's cart button.
 */

import clsx from "clsx";
import { ChevronRight, Home, LayoutGrid, Package, ShoppingBag, ShoppingCart, User as UserIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { badgeCount, isCartPath, itemsLabel } from "@/themes/fresh/parts";

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
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
function CartPill({ count }: { count: number }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(3.6rem+0.75rem+env(safe-area-inset-bottom))] z-30 flex animate-rise-in justify-center px-[4.5rem] sm:hidden [body[data-buy-bar]_&]:hidden [body[data-compare-tray]_&]:hidden">
      <Link href="/cart" data-testid="cart-pill"
        className="pc-press pointer-events-auto flex h-12 min-w-0 max-w-full items-center gap-2 rounded-full bg-peacock py-1.5 pl-1.5 pr-3 text-white shadow-lg ring-1 ring-black/5 transition-colors hover:bg-peacock-dark">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20">
          <ShoppingBag className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 truncate text-sm font-bold">
          {itemsLabel(count)}<span aria-hidden> · </span><span className="sr-only">, </span>View cart
        </span>
        <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
      </Link>
    </div>
  );
}

export function FreshMobileNav() {
  const pathname = usePathname();
  const { cartCount } = useSession();
  return (
    <>
      {cartCount > 0 && !isCartPath(pathname) && <CartPill count={cartCount} />}
      <nav aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_0_rgb(var(--c-line)),0_-6px_18px_-8px_rgb(var(--c-ink)/0.22)] sm:hidden">
        <ul className="grid h-[3.6rem] grid-cols-5">
          {TABS.map(({ href, label, icon: Icon, active }) => {
            const on = active(pathname);
            const cart = href === "/cart";
            return (
              <li key={href} className="min-w-0">
                <Link href={href} aria-current={on ? "page" : undefined} aria-label={cart ? `Cart, ${itemsLabel(cartCount)}` : undefined}
                  className={clsx("flex h-full flex-col items-center justify-center gap-1 text-[11px] leading-none transition-colors",
                    on ? "font-bold text-peacock" : "font-medium text-ink-soft hover:text-ink")}>
                  <span className={clsx("relative flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200",
                    on && "bg-peacock-light")}>
                    <Icon className="h-5 w-5" strokeWidth={on ? 2.4 : 2} aria-hidden />
                    {cart && cartCount > 0 && (
                      <span className="absolute -top-1 right-0.5 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px] text-white ring-2 ring-white" aria-hidden>
                        {badgeCount(cartCount)}
                      </span>
                    )}
                  </span>
                  <span className="max-w-full truncate px-0.5">{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
