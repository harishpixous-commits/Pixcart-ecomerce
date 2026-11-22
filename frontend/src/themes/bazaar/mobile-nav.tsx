"use client";

/* Bazaar phone tab bar: Home, Categories, Deals (or Orders when deals are off), Cart with its count, Account. */

import clsx from "clsx";
import { Flame, Home, LayoutGrid, Package, ShoppingCart, User as UserIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";

interface Tab {
  href: string;
  label: string;
  icon: typeof Home;
  /** other pages that belong to this tab */
  also?: string[];
}

function matches(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function BazaarMobileNav() {
  const pathname = usePathname();
  const { cartCount } = useSession();
  const site = useSite();
  const deals = site.features.deals !== false;
  const tabs: Tab[] = [
    { href: "/", label: "Home", icon: Home },
    { href: "/categories", label: "Categories", icon: LayoutGrid, also: ["/c"] },
    deals ? { href: "/deals", label: "Deals", icon: Flame } : { href: "/orders", label: "Orders", icon: Package },
    { href: "/cart", label: "Cart", icon: ShoppingCart },
    { href: "/account", label: "Account", icon: UserIcon, also: ["/wishlist", "/notifications", ...(deals ? ["/orders"] : [])] },
  ];
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_18px_-8px_rgb(0_0_0/0.18)] sm:hidden">
      <ul className="grid h-14 grid-cols-5">
        {tabs.map(({ href, label, icon: Icon, also }) => {
          const active = matches(pathname, href) || (also ?? []).some((a) => matches(pathname, a));
          const cart = href === "/cart";
          return (
            <li key={href} className="relative">
              <Link href={href} aria-current={active ? "page" : undefined} aria-label={cart ? `Cart, ${cartCount} ${cartCount === 1 ? "item" : "items"}` : undefined}
                className={clsx("flex h-full flex-col items-center justify-center gap-0.5 text-[11px] leading-tight transition-colors",
                  active ? "font-semibold text-peacock" : "font-medium text-ink-soft hover:text-ink")}>
                {active && <span className="absolute left-1/2 top-0 h-[3px] w-9 -translate-x-1/2 rounded-b-full bg-peacock" aria-hidden />}
                <span className="relative">
                  <Icon className="h-[22px] w-[22px]" strokeWidth={active ? 2.4 : 2} aria-hidden />
                  {cart && cartCount > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-[18px] rounded-full bg-vermilion px-1 text-center text-[11px] font-bold leading-[18px] text-white ring-2 ring-white" aria-hidden>
                      {cartCount > 99 ? "99+" : cartCount}
                    </span>
                  )}
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
