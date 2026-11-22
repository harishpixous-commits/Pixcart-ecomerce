"use client";

/*
 * Luxe phone tab bar: a minimal white bar under a hairline, thin icons and tiny capitals. The current tab is in ink
 * with a short rule along the top edge; the bag shows how many items are in the cart.
 */

import clsx from "clsx";
import { Heart, Home, LayoutGrid, Package, ShoppingBag, User as UserIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";

export function LuxeMobileNav() {
  const pathname = usePathname();
  const site = useSite();
  const { cartCount } = useSession();
  const tabs = [
    { href: "/", label: "Home", icon: Home, also: [] as string[] },
    { href: "/categories", label: "Shop", icon: LayoutGrid, also: ["/c"] },
    site.features.wishlist
      ? { href: "/wishlist", label: "Wishlist", icon: Heart, also: [] }
      : { href: "/orders", label: "Orders", icon: Package, also: [] },
    { href: "/cart", label: "Bag", icon: ShoppingBag, also: [] },
    { href: "/account", label: "Account", icon: UserIcon, also: [] },
  ];
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md sm:hidden">
      <ul className="grid h-14 grid-cols-5">
        {tabs.map(({ href, label, icon: Icon, also }) => {
          const active = href === "/" ? pathname === "/" : under(href) || also.some(under);
          const bag = href === "/cart";
          return (
            <li key={href}>
              <Link href={href} aria-current={active ? "page" : undefined} aria-label={bag ? `Bag, ${cartCount} items` : undefined}
                className={clsx("relative flex h-full flex-col items-center justify-center gap-1 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors",
                  active ? "text-ink" : "text-ink-faint hover:text-ink-soft")}>
                <span aria-hidden className={clsx("absolute left-1/2 top-0 h-0.5 w-8 -translate-x-1/2 bg-ink transition-transform duration-200",
                  active ? "scale-x-100" : "scale-x-0")} />
                <span className="relative">
                  <Icon className="h-5 w-5" strokeWidth={1.5} aria-hidden />
                  {bag && cartCount > 0 && (
                    <span className="absolute -right-2.5 -top-1.5 min-w-[16px] rounded-full bg-peacock px-1 text-center text-[10px] font-semibold leading-4 tracking-normal text-white">
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
