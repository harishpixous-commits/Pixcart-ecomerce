"use client";

/*
 * Luxe header: an editorial boutique header on white.
 *
 * The announcement bar and a thin utility row (delivery PIN, help, orders, the owner's header links; large screens)
 * scroll away. The sticky part is a three-column row (menu and featured links | centred logo | search, wishlist,
 * account, notifications, bag) and, on large screens, the categories with a gold rule under the active one, then the
 * promotion. Search opens a full-width panel under the header; phones and tablets also find the delivery PIN there.
 *
 * Behaviour comes from the shared parts (components/shop-chrome, components/shop-nav); this file only arranges and
 * styles them.
 */

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Search, ShoppingBag, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AccountMenu, AnnouncementBar, DeliverTo, Logo, NotificationBell, WishlistLink, useCategories } from "@/components/shop-chrome";
import { AllMenu, SearchBox } from "@/components/shop-nav";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";
import type { CategoryNode } from "@/lib/types";

/** The delivery PIN button in Luxe's small type (it sets its own size), its pin icon lined up with the page edge. */
const PIN_STYLE = "[&_[data-testid=deliver-to]]:text-[12px]";

/** Help, orders and the owner's header links, with the delivery PIN on the left (large screens; scrolls away). */
function UtilityRow({ pinOn }: { pinOn: boolean }) {
  const site = useSite();
  const links = [{ href: "/help", label: "Help" }, { href: "/orders", label: "Track order" }, ...site.header_links];
  return (
    <div className="hidden border-b border-line/70 bg-white [&_svg]:[stroke-width:1.5] lg:block">
      <div className="mx-auto flex h-9 max-w-shop items-center justify-between gap-6 px-3 sm:px-4">
        <div className={clsx("-ml-2.5 min-w-0", PIN_STYLE)}>{pinOn && <DeliverTo tone="light" />}</div>
        <nav aria-label="Help and orders" className="flex min-w-0 items-center gap-6 text-[11px] uppercase tracking-[0.18em] text-ink-soft">
          {links.map((l) => (
            <Link key={l.href + l.label} href={l.href} className="whitespace-nowrap transition-colors hover:text-ink">
              {fillTokens(l.label, site)}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

/** The first nav links beside the menu on large screens (two on 1024 px, three from 1280 px); an underline draws in on hover. */
function FeaturedLinks() {
  const site = useSite();
  const pathname = usePathname();
  const links = (site.nav?.links ?? []).slice(0, 3);
  if (!links.length) return null;
  return (
    <nav aria-label="Featured" className="hidden items-center gap-7 lg:flex">
      {links.map((l, i) => {
        const on = pathname === l.href.split("?")[0];
        return (
          <Link key={l.href + l.label} href={l.href} aria-current={on ? "page" : undefined}
            className={clsx("group/nav relative whitespace-nowrap py-1.5 text-[12px] font-medium uppercase tracking-[0.16em] text-ink", i === 2 && "hidden xl:block")}>
            {fillTokens(l.label, site)}
            <span aria-hidden className={clsx("absolute inset-x-0 bottom-0.5 h-px origin-left bg-current transition-transform duration-300 ease-out",
              on ? "scale-x-100" : "scale-x-0 group-hover/nav:scale-x-100 group-focus-visible/nav:scale-x-100")} />
          </Link>
        );
      })}
    </nav>
  );
}

/** The cart: a bag with the count in brackets ("Bag (2)" on large screens). */
function BagLink() {
  const { cartCount } = useSession();
  return (
    <Link href="/cart" aria-label={`Cart, ${cartCount} items`} data-testid="header-cart"
      className="flex h-10 min-w-[40px] items-center justify-center gap-1.5 px-2 text-ink transition-colors hover:text-ink-soft">
      <ShoppingBag className="h-5 w-5 shrink-0" />
      <span className="hidden text-[12px] font-medium uppercase tracking-[0.16em] lg:inline">Bag</span>
      {cartCount > 0 && <span className="text-[12px] font-medium tabular-nums">({cartCount > 99 ? "99+" : cartCount})</span>}
    </Link>
  );
}

/**
 * The search button and its full-width panel under the header: the search box with suggestions, trending searches and,
 * on phones, the delivery PIN. Escape, a click outside, a search or a new page close it.
 */
function LuxeSearch({ categories, pinOn }: { categories: CategoryNode[]; pinOn: boolean }) {
  const site = useSite();
  const pathname = usePathname();
  const params = useSearchParams();
  const here = `${pathname}?${params.toString()}`;
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(here);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  if (here !== at) {
    // a new page or a new search: close the panel
    setAt(here);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);

  function toggle() {
    if (open) return setOpen(false);
    // render the panel now so focus lands in the search box within the tap (phones then show the keyboard)
    flushSync(() => setOpen(true));
    panel.current?.querySelector<HTMLInputElement>("#site-search")?.focus();
  }

  const trending = site.nav?.trending ?? [];
  return (
    <>
      <button ref={button} type="button" onClick={toggle} aria-expanded={open} aria-controls={open ? "luxe-search" : undefined}
        aria-label={open ? "Close search" : "Search"} data-testid="header-search"
        className="flex h-10 w-10 shrink-0 items-center justify-center text-ink transition-colors hover:text-ink-soft">
        {open ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
      </button>
      {open && (
        <>
          {/* dims the page under the header; the header's own background covers it inside the header */}
          <div aria-hidden className="fixed inset-0 -z-20 animate-fade-in bg-ink/25" />
          <div ref={panel} id="luxe-search" className="absolute inset-x-0 top-full animate-rise-in border-b border-line bg-white shadow-[0_32px_48px_-32px_rgb(0_0_0/0.35)]"
            onSubmit={(e) => { if ((e.target as HTMLFormElement).querySelector("input")?.value.trim()) setOpen(false); }}>
            <div className="mx-auto max-w-3xl px-3 pb-6 pt-4 sm:px-4 sm:pb-10 sm:pt-8">
              <p className="mb-4 hidden text-center font-display text-2xl text-ink sm:block">What are you looking for?</p>
              <SearchBox categories={categories} variant="outline" button="plain" />
              {trending.length > 0 && (
                <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 sm:mt-6 sm:justify-center">
                  <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-faint">Trending</span>
                  {trending.map((t) => (
                    <Link key={t} href={`/search?q=${encodeURIComponent(t)}`}
                      className="inline-block py-1 font-display text-[15px] text-ink-soft underline-offset-4 transition-colors first-letter:uppercase hover:text-ink hover:underline">
                      {t}
                    </Link>
                  ))}
                </div>
              )}
              {pinOn && (
                <div className={clsx("-ml-2.5 mt-4 border-t border-line pt-3 lg:hidden", PIN_STYLE)}>
                  <DeliverTo tone="light" />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** Large screens: the categories, centred, with a gold rule under the active or hovered one; then the promotion. */
function CategoryRow({ categories }: { categories: CategoryNode[] }) {
  const site = useSite();
  const pathname = usePathname();
  const nav = site.nav;
  const box = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const showCats = nav?.show_categories !== false && categories.length > 0;
  const promo = nav?.promo?.enabled && nav.promo.text ? nav.promo : null;
  const shown = showCats || Boolean(promo);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // arrows appear only when the row is wider than the screen (many or long category names)
    const update = () => setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", update); };
  }, [shown, categories.length]);

  if (!shown) return null;
  const go = (d: number) => box.current?.scrollBy({ left: d * box.current.clientWidth * 0.6, behavior: "smooth" });
  const dot = { accent: "bg-marigold", buy: "bg-vermilion", primary: "bg-peacock", dark: "bg-ink" }[promo?.tone ?? "accent"];
  const promoBody = promo && (
    <>
      <span aria-hidden className={clsx("h-1.5 w-1.5 shrink-0 rotate-45", dot)} />
      {fillTokens(promo.text, site)}
    </>
  );
  const promoClass = "flex items-center gap-2 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-ink decoration-marigold decoration-2 underline-offset-[6px]";
  return (
    <div className="relative mx-auto hidden max-w-shop px-3 sm:px-4 lg:block">
      <div ref={box} className="scroll-x overflow-x-auto">
        <nav aria-label="Categories" className="mx-auto flex h-11 w-max items-stretch gap-x-6 xl:gap-x-8">
          {showCats && categories.map((c) => {
            const href = `/c/${c.slug}`;
            const on = pathname === href || c.children.some((ch) => pathname === `/c/${ch.slug}`);
            return (
              <Link key={c.slug} href={href} aria-current={pathname === href ? "page" : on ? "true" : undefined}
                className={clsx("group/cat relative flex items-center whitespace-nowrap text-[12px] uppercase tracking-[0.18em] transition-colors",
                  on ? "text-ink" : "text-ink-soft hover:text-ink")}>
                {c.name}
                <span aria-hidden className={clsx("absolute inset-x-0 bottom-0 h-0.5 bg-marigold transition-transform duration-300 ease-out",
                  on ? "scale-x-100" : "scale-x-0 group-hover/cat:scale-x-100 group-focus-visible/cat:scale-x-100")} />
              </Link>
            );
          })}
          {promo && (
            <>
              {showCats && <span aria-hidden className="h-4 w-px self-center bg-line" />}
              {promo.link
                ? <Link href={promo.link} className={clsx(promoClass, "hover:underline")} data-testid="nav-promo">{promoBody}</Link>
                : <span className={promoClass} data-testid="nav-promo">{promoBody}</span>}
            </>
          )}
        </nav>
      </div>
      {!edges.start && (
        <button type="button" onClick={() => go(-1)} aria-label="Scroll categories left"
          className="absolute inset-y-0 left-0 flex w-14 items-center justify-start bg-gradient-to-r from-white via-white/90 to-transparent pl-2 text-ink-soft hover:text-ink">
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {!edges.end && (
        <button type="button" onClick={() => go(1)} aria-label="Scroll categories right"
          className="absolute inset-y-0 right-0 flex w-14 items-center justify-end bg-gradient-to-l from-white via-white/90 to-transparent pr-2 text-ink-soft hover:text-ink">
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function LuxeHeader() {
  const cats = useCategories();
  const site = useSite();
  const pinOn = site.pdp?.header_pincode !== false;
  return (
    <>
      <AnnouncementBar />
      <UtilityRow pinOn={pinOn} />
      {/* The header rises above the help button and tab bar while the All menu is open. Its frosted background is a
          separate layer: a backdrop filter on the header itself would trap the menu's full-screen drawer inside it. */}
      <header className="sticky top-0 z-30 has-[[role=dialog]]:z-[60] [&_svg]:[stroke-width:1.5]">
        <div aria-hidden className="absolute inset-0 -z-10 border-b border-line bg-white/95 backdrop-blur-md" />
        <div className="mx-auto grid h-16 max-w-shop grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 sm:px-4 lg:h-20">
          <div className="flex min-w-0 items-center gap-5">
            {site.nav?.all_menu !== false && (
              <div className="-ml-2.5 shrink-0">
                <AllMenu categories={cats} tone="light" iconOnly />
              </div>
            )}
            <FeaturedLinks />
          </div>
          <div className="flex justify-center lg:[&>a]:text-[28px] lg:[&_img]:h-11">
            <Logo light={false} />
          </div>
          <div className="-mr-2 flex items-center justify-end gap-0.5 sm:gap-1">
            <Suspense fallback={<span className="h-10 w-10 shrink-0" aria-hidden />}>
              <LuxeSearch categories={cats} pinOn={pinOn} />
            </Suspense>
            <WishlistLink tone="light" />
            {/* the tab bar has Account on phones; Luxe's small capitals for "Sign in" and the first name */}
            <div className="hidden sm:block [&_button>span]:text-[12px] [&_button>span]:font-medium [&_button>span]:uppercase [&_button>span]:tracking-[0.16em] [&_a>span]:text-[12px] [&_a>span]:font-medium [&_a>span]:uppercase [&_a>span]:tracking-[0.16em]">
              <AccountMenu tone="light" compact />
            </div>
            {/* phones keep the bar to menu, logo, search and bag; notifications are under Account */}
            <div className="hidden sm:block">
              <NotificationBell dark />
            </div>
            <BagLink />
          </div>
        </div>
        <CategoryRow categories={cats} />
      </header>
    </>
  );
}
