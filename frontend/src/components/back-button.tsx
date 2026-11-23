"use client";

/*
 * Back navigation that works everywhere, including the installed app on iPhone (which has no browser back button):
 * goes back when the visitor came from inside the site, otherwise to the page's logical parent (fallback).
 * BackLink: a small "‹ Back" for page headers. ShopBackBar: the shop's bar under the header on inner pages.
 */

import clsx from "clsx";
import { ChevronLeft } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

function cameFromHere(): boolean {
  try {
    return window.history.length > 1 && !!document.referrer && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function useGoBack(fallback: string) {
  const router = useRouter();
  return () => {
    if (cameFromHere()) router.back();
    else router.push(fallback);
  };
}

export function BackLink({ fallback, label = "Back", className }: { fallback: string; label?: string; className?: string }) {
  const back = useGoBack(fallback);
  return (
    <button type="button" onClick={back} data-testid="back-link"
      className={clsx("-ml-1 inline-flex items-center gap-0.5 rounded-md py-1 pr-2 text-sm font-semibold text-peacock hover:bg-peacock/5", className)}>
      <ChevronLeft className="h-4 w-4" aria-hidden /> {label}
    </button>
  );
}

/** The parent page for a shop address: /orders/123 → /orders, /help/returns → /help, /support/new → /support. */
export function shopParent(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  if (parts[0] === "p" || parts[0] === "c" || parts[0] === "store" || parts[0] === "pages") return "/";
  return `/${parts[0]}`;
}

// Pages people reach from the menu: a back bar only on phones. Deeper pages get it on every screen.
const DESKTOP_TOO = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 && !["p", "c"].includes(parts[0]) || ["/compare", "/checkout", "/app"].includes(path);
};

export function ShopBackBar() {
  const pathname = usePathname();
  const back = useGoBack(shopParent(pathname));
  if (pathname === "/") return null;
  return (
    <div className={clsx("mx-auto w-full max-w-shop px-3 pt-2 sm:px-4", !DESKTOP_TOO(pathname) && "sm:hidden")} data-testid="shop-back-bar">
      <button type="button" onClick={back} aria-label="Go back"
        className="-ml-1 inline-flex items-center gap-0.5 rounded-md py-1 pr-2 text-sm font-semibold text-peacock hover:bg-peacock/5">
        <ChevronLeft className="h-5 w-5" aria-hidden /> Back
      </button>
    </div>
  );
}
