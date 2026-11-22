"use client";

/*
 * Fresh header (quick commerce). The announcement bar, then a sticky white bar: the logo with the delivery PIN, a big
 * soft search, wishlist, notifications, account and a solid cart button. Below it a strip with the All menu, the
 * categories as chips with their icons, and the marketplace's links. On phones the logo row scrolls away while the
 * search and the strip stay pinned, as in shopping apps; the cart is then in the tab bar and the floating cart pill.
 * Behaviour comes from the shared parts (shop-chrome, shop-nav); this file only arranges them.
 */

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Search, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { CategoryIcon } from "@/components/category-icon";
import { useReducedMotion } from "@/components/media";
import { AccountMenu, AnnouncementBar, DeliverTo, Logo, NotificationBell, WishlistLink, useCategories } from "@/components/shop-chrome";
import { AllMenu, SearchBox } from "@/components/shop-nav";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";
import type { CategoryNode } from "@/lib/types";
import { itemsLabel } from "@/themes/fresh/parts";

/** The solid cart button (tablets and desktops; phones have the tab bar and the floating cart pill). */
function CartButton() {
  const { cartCount } = useSession();
  const items = itemsLabel(cartCount);
  return (
    <Link href="/cart" aria-label={`Cart, ${items}`} data-testid="header-cart"
      className="pc-press hidden h-11 shrink-0 items-center gap-2 rounded-xl bg-peacock px-3 font-bold text-white shadow-sm transition-colors hover:bg-peacock-dark sm:flex">
      <ShoppingCart className="h-5 w-5" aria-hidden />
      <span className="whitespace-nowrap text-sm">{cartCount > 0 ? items : "My cart"}</span>
    </Link>
  );
}

/** Cycles the search placeholder through the trending searches (paused while the search has focus or motion is reduced). */
function useTrendingPlaceholder(terms: string[]) {
  const reduced = useReducedMotion();
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = terms.length;
  useEffect(() => {
    if (reduced || paused || count < 2) return;
    const id = setInterval(() => setI((x) => (x + 1) % count), 3200);
    return () => clearInterval(id);
  }, [reduced, paused, count]);
  const term = count ? terms[i % count] : "";
  return { placeholder: term ? `Search for “${term}”` : undefined, setPaused };
}

/** Whether a horizontal scroller can move further left or right (for its arrows and edge fades). */
function useScrollEdges(ref: React.RefObject<HTMLElement | null>, contentKey: number) {
  const [edges, setEdges] = useState({ start: true, end: true });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const update = () => {
      if (!live) return;
      const start = el.scrollLeft <= 4;
      const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    const frame = requestAnimationFrame(update);
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    document.fonts?.ready.then(update).catch(() => {});
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref, contentKey]);
  return edges;
}

function containsSlug(c: CategoryNode, slug: string): boolean {
  return c.slug === slug || c.children.some((ch) => containsSlug(ch, slug));
}

/** A fade at the end of the strip that has more to show, with an arrow button for mouse users (tablets and up). */
function ScrollHint({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <div className={clsx("pointer-events-none absolute inset-y-0 flex w-14 items-center from-white via-white/85 to-transparent",
      side === "left" ? "left-0 justify-start bg-gradient-to-r" : "right-0 justify-end bg-gradient-to-l")}>
      <button type="button" onClick={onClick} tabIndex={-1} aria-hidden
        className="pointer-events-auto hidden h-8 w-8 items-center justify-center rounded-full bg-white text-ink shadow-md ring-1 ring-line transition-colors hover:bg-mist md:flex">
        <Icon className="h-4 w-4" />
      </button>
    </div>
  );
}

const CHIP = "flex h-10 shrink-0 items-center whitespace-nowrap rounded-full text-[13px] font-semibold transition-colors md:h-9";
const PROMO_TONE = { accent: "bg-marigold text-ink", buy: "bg-vermilion text-white", primary: "bg-peacock text-white", dark: "bg-ink text-white" } as const;

/** The strip under the header: All menu, promotion, categories with icons, then the marketplace's links. */
function CategoryStrip({ cats }: { cats: CategoryNode[] }) {
  const site = useSite();
  const nav = site.nav;
  const pathname = usePathname();
  const track = useRef<HTMLElement>(null);
  const showCats = nav?.show_categories !== false && cats.length > 0;
  const links = nav?.links ?? [];
  const edges = useScrollEdges(track, cats.length + links.length);
  const current = pathname.startsWith("/c/") ? pathname.split("/")[2] ?? "" : "";
  const promo = nav?.promo?.enabled && nav.promo.text ? nav.promo : null;
  const t = (x: string) => fillTokens(x, site);
  const linkOn = (href: string) => href !== "/" && (pathname === href || pathname.startsWith(`${href}/`));

  // Bring the chip of the page you are on into view (a category far along the strip, say).
  useEffect(() => {
    const el = track.current;
    const chip = el?.querySelector<HTMLElement>("[aria-current]");
    if (!el || !chip) return;
    el.scrollTo({ left: Math.max(0, chip.offsetLeft - (el.clientWidth - chip.offsetWidth) / 2) });
  }, [pathname, cats.length]);

  const scroll = (dir: number) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: "smooth" });
  };

  return (
    <div className="border-b border-line bg-white">
      <div className="mx-auto flex h-12 max-w-shop items-center gap-1 px-3 sm:px-4">
        {nav?.all_menu !== false && (
          <>
            <AllMenu categories={cats} tone="light" />
            <span className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden />
          </>
        )}
        <div className="relative min-w-0 flex-1">
          <nav ref={track} aria-label="Shop" className="scroll-x flex items-center gap-1 overflow-x-auto">
            {promo && (promo.link ? (
              <Link href={promo.link} className={clsx(CHIP, "px-3 font-bold hover:opacity-90", PROMO_TONE[promo.tone] ?? PROMO_TONE.accent)} data-testid="nav-promo">{t(promo.text)}</Link>
            ) : (
              <span className={clsx(CHIP, "px-3 font-bold", PROMO_TONE[promo.tone] ?? PROMO_TONE.accent)} data-testid="nav-promo">{t(promo.text)}</span>
            ))}
            {showCats && cats.map((c) => {
              const on = current !== "" && containsSlug(c, current);
              return (
                <Link key={c.slug} href={`/c/${c.slug}`} aria-current={on ? (current === c.slug ? "page" : "true") : undefined}
                  className={clsx(CHIP, "gap-1.5 pl-1 pr-3", on ? "bg-peacock-light text-peacock-dark" : "text-ink-soft hover:bg-mist hover:text-ink")}>
                  <span className={clsx("flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-peacock", on ? "bg-white" : "bg-peacock-light")}>
                    {c.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.image_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <CategoryIcon slug={c.slug} className="h-4 w-4" />
                    )}
                  </span>
                  {c.name}
                </Link>
              );
            })}
            {showCats && links.length > 0 && <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />}
            {links.map((l) => (
              <Link key={l.href + l.label} href={l.href} aria-current={linkOn(l.href) ? "page" : undefined}
                className={clsx(CHIP, "px-3", linkOn(l.href) ? "bg-peacock-light text-peacock-dark" : "text-ink-soft hover:bg-mist hover:text-ink")}>
                {t(l.label)}
              </Link>
            ))}
          </nav>
          {!edges.start && <ScrollHint side="left" onClick={() => scroll(-1)} />}
          {!edges.end && <ScrollHint side="right" onClick={() => scroll(1)} />}
        </div>
        {site.header_links.length > 0 && (
          <nav aria-label="More" className="ml-1 hidden shrink-0 items-center gap-1 border-l border-line pl-2 lg:flex">
            {site.header_links.map((l) => (
              <Link key={l.href + l.label} href={l.href} className="rounded-full px-3 py-1.5 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-mist hover:text-peacock">
                {t(l.label)}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

export function FreshHeader() {
  const cats = useCategories();
  const site = useSite();
  const { placeholder, setPaused } = useTrendingPlaceholder(site.nav?.trending ?? []);
  const pin = site.pdp?.header_pincode !== false;
  // The search's category picker (when on) shows from tablets up; phones get a plain search with its icon.
  const picker = site.nav?.search_categories !== false && cats.length > 0;
  return (
    <>
      <AnnouncementBar />
      {/* Phones: the 64 px logo row scrolls away (negative sticky top); the search and the strip stay pinned. */}
      <header className="sticky z-30 bg-white max-sm:-top-16 sm:top-0">
        <div className="border-b border-line">
          <div className="mx-auto flex max-w-shop flex-wrap items-center gap-x-2 px-3 sm:px-4 md:flex-nowrap md:gap-x-4">
            <div className="flex h-16 min-w-0 shrink-0 flex-col items-start justify-center lg:flex-row lg:items-center lg:gap-3">
              <Logo light={false} />
              {pin && (
                <>
                  <span className="hidden h-7 w-px bg-line lg:block" aria-hidden />
                  <div className="-ml-2.5 lg:ml-0">
                    <DeliverTo tone="light" />
                  </div>
                </>
              )}
            </div>
            {/* One search box for every width: its own row on phones, inline from tablets up. With the category
                picker showing, the search icon moves to the right end so it never sits over the picker. */}
            <div className={clsx("relative order-last w-full min-w-0 pb-2.5 md:order-none md:w-auto md:max-w-3xl md:flex-1 md:pb-0",
              picker && "max-sm:[&_select]:hidden sm:[&_select~input]:pl-3 sm:[&_select~input]:pr-11 sm:[&_select~svg]:hidden")}
              onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
              <Suspense fallback={<div className="h-11 rounded-full bg-mist ring-1 ring-line" />}>
                <SearchBox categories={cats} variant="soft" shape="pill" button="plain" placeholder={placeholder} />
              </Suspense>
              {picker && <Search className="pointer-events-none absolute right-4 top-3 hidden h-5 w-5 text-ink-faint sm:block" aria-hidden />}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
              <WishlistLink tone="light" />
              <NotificationBell dark />
              <AccountMenu tone="light" compact />
              <CartButton />
            </div>
          </div>
        </div>
        <CategoryStrip cats={cats} />
      </header>
    </>
  );
}
