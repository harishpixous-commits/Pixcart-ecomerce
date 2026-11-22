"use client";

/*
 * Bazaar header: a bold, two-tier big-store header.
 * Tier 1 (brand colour): logo, delivery PIN, a large centred search, notifications, account, orders, wishlist, cart.
 * Tier 2 (the darker brand colour): an all-categories mega menu (large screens), the marketplace's links and the
 * promotion. Phones: menu, logo, account and cart, then the search; the delivery PIN and the links follow as a strip
 * that scrolls sideways and scrolls away with the page, so the part that stays on screen is compact.
 * Behaviour comes from the shared header parts (components/shop-chrome, components/shop-nav); this file arranges them.
 */

import clsx from "clsx";
import { ChevronDown, ChevronRight, Flame, LayoutGrid, Sparkles, Trophy } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { CategoryIcon } from "@/components/category-icon";
import { AccountMenu, AnnouncementBar, CartLink, DeliverTo, Logo, NotificationBell, useCategories, WishlistLink } from "@/components/shop-chrome";
import { AllMenu, ReturnsOrders, SearchBox } from "@/components/shop-nav";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";
import type { CategoryNode, LinkItem, Site } from "@/lib/types";

/* Phones get the delivery PIN, the links and the promotion in a strip under the header; larger screens get them in the
 * header. Each part is mounted once (tests and screen readers find one of each); while the page is drawn on the
 * server both places render and CSS shows the right one, so nothing moves when the page comes alive. */
const PHONE = "(max-width: 767.98px)";

function subscribePhone(onChange: () => void) {
  const m = window.matchMedia(PHONE);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

/** true on phones, false on larger screens, null on the server. */
function usePhone(): boolean | null {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => null);
}

/** The marketplace's links (Admin → Storefront → Navigation), then the header links. */
function navLinks(site: Site): LinkItem[] {
  return [...(site.nav?.links ?? []), ...(site.header_links ?? [])];
}

function isCurrent(pathname: string, href: string): boolean {
  if (href.includes("?") || href.includes("#") || href === "/") return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ links, small }: { links: LinkItem[]; small?: boolean }) {
  const site = useSite();
  const pathname = usePathname();
  return (
    <>
      {links.map((l, i) => (
        <Link key={`${l.href}-${i}`} href={l.href} aria-current={isCurrent(pathname, l.href) ? "page" : undefined}
          className={clsx("flex h-full shrink-0 items-center whitespace-nowrap px-2.5 font-medium text-white/90 decoration-marigold decoration-2 hover:text-white hover:underline aria-[current=page]:text-white aria-[current=page]:underline",
            small ? "text-[13px] underline-offset-[5px]" : "text-sm underline-offset-[7px]")}>
          {fillTokens(l.label, site)}
        </Link>
      ))}
    </>
  );
}

const PROMO_TONE = {
  accent: "bg-marigold text-ink",
  buy: "bg-vermilion text-white",
  primary: "bg-peacock text-white ring-1 ring-white/30",
  dark: "bg-ink text-white",
} as const;

/** The promotion pill (Admin → Storefront → Navigation → Promotion). */
function Promo({ className }: { className?: string }) {
  const site = useSite();
  const promo = site.nav?.promo;
  if (!promo?.enabled || !promo.text) return null;
  const cls = clsx("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1 font-bold", PROMO_TONE[promo.tone] ?? PROMO_TONE.accent, className);
  const text = fillTokens(promo.text, site);
  return promo.link
    ? <Link href={promo.link} className={clsx(cls, "hover:opacity-90")} data-testid="nav-promo">{text}</Link>
    : <span className={cls} data-testid="nav-promo">{text}</span>;
}

/** "All categories": a full-width panel under the header with every category, its sub-categories and shortcuts. */
function MegaMenu({ categories }: { categories: CategoryNode[] }) {
  const site = useSite();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(pathname);
  if (pathname !== path) {
    // a new page: close the menu
    setPath(pathname);
    setOpen(false);
  }
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);
  const close = () => setOpen(false);
  const shortcuts = [
    ...(site.features.deals !== false ? [{ href: "/deals", label: "Today's deals", note: "Limited-time prices", icon: Flame, tint: "bg-vermilion/10 text-vermilion" }] : []),
    { href: "/bestsellers", label: "Bestsellers", note: "Most bought right now", icon: Trophy, tint: "bg-marigold/25 text-ink" },
    { href: "/new-releases", label: "New releases", note: "Just arrived", icon: Sparkles, tint: "bg-leaf/10 text-leaf" },
  ];
  const extra = site.nav?.drawer_links ?? [];
  return (
    <div ref={box} className="flex h-full items-end"
      onBlur={(e) => { if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <button ref={trigger} type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true" aria-controls={open ? panelId : undefined}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown") return;
          e.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => document.getElementById(panelId)?.querySelector<HTMLElement>("a")?.focus());
        }}
        className={clsx("flex h-9 items-center gap-2 rounded-t-lg px-3.5 text-sm font-semibold transition-colors",
          open ? "bg-white text-peacock" : "bg-white/10 text-white hover:bg-white/20")} data-testid="mega-menu">
        <LayoutGrid className="h-[18px] w-[18px]" aria-hidden />
        All categories
        <ChevronDown className={clsx("h-4 w-4 transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <>
          <div className="absolute inset-x-0 top-full h-screen animate-fade-in bg-ink/30" onClick={close} aria-hidden />
          <div id={panelId} tabIndex={-1} className="absolute inset-x-0 top-full animate-rise-in border-t border-line bg-white text-ink shadow-xl outline-none">
            <div className="mx-auto grid max-h-[calc(100vh-9rem)] max-w-shop grid-cols-[minmax(0,1fr)_16rem] gap-8 overflow-y-auto px-4 py-6">
              <div>
                <div className="mb-5 flex items-baseline justify-between gap-4">
                  <p className="font-display text-lg font-bold">Shop by category</p>
                  <Link href="/categories" onClick={close} className="inline-flex items-center gap-0.5 text-sm font-semibold text-peacock hover:underline">
                    Every category <ChevronRight className="h-4 w-4" aria-hidden />
                  </Link>
                </div>
                {categories.length ? (
                  <ul className="grid grid-cols-3 gap-x-6 gap-y-7 xl:grid-cols-4">
                    {categories.map((c) => (
                      <li key={c.slug} className="min-w-0">
                        <Link href={`/c/${c.slug}`} onClick={close} className="group/cat flex items-center gap-3">
                          <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-peacock/10 text-peacock transition-colors group-hover/cat:bg-peacock group-hover/cat:text-white">
                            {c.image_url
                              // eslint-disable-next-line @next/next/no-img-element
                              ? <img src={c.image_url} alt="" className="h-full w-full object-cover" />
                              : <CategoryIcon slug={c.slug} className="h-5 w-5" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-display text-[15px] font-semibold leading-snug group-hover/cat:text-peacock">{c.name}</span>
                            {c.product_count > 0 && <span className="block text-xs text-ink-faint">{c.product_count.toLocaleString("en-IN")} {c.product_count === 1 ? "product" : "products"}</span>}
                          </span>
                        </Link>
                        {c.children.length > 0 && (
                          <ul className="mt-2.5 flex flex-col gap-1 pl-14">
                            {c.children.slice(0, 6).map((ch) => (
                              <li key={ch.slug}>
                                <Link href={`/c/${ch.slug}`} onClick={close} className="block truncate text-sm text-ink-soft hover:text-peacock hover:underline">{ch.name}</Link>
                              </li>
                            ))}
                          </ul>
                        )}
                        <Link href={`/c/${c.slug}`} onClick={close} className="ml-14 mt-2 inline-flex items-center gap-0.5 text-sm font-semibold text-peacock hover:underline">
                          See all <span className="sr-only">in {c.name}</span><ChevronRight className="h-4 w-4" aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="grid grid-cols-3 gap-6 xl:grid-cols-4" aria-hidden>
                    {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton h-28 rounded-lg" />)}
                  </div>
                )}
              </div>
              <aside className="flex flex-col gap-1 border-l border-line pl-6" aria-label="Shop more">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint">Shop more</p>
                {shortcuts.map(({ href, label, note, icon: Icon, tint }) => (
                  <Link key={href} href={href} onClick={close} className="group/more -mx-2 flex items-center gap-3 rounded-lg p-2 hover:bg-mist">
                    <span className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", tint)}><Icon className="h-5 w-5" aria-hidden /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold group-hover/more:text-peacock">{label}</span>
                      <span className="block text-xs text-ink-faint">{note}</span>
                    </span>
                  </Link>
                ))}
                {extra.length > 0 && (
                  <div className="mt-3 flex flex-col gap-0.5 border-t border-line pt-3">
                    {extra.map((l, i) => (
                      <Link key={`${l.href}-${i}`} href={l.href} onClick={close} className="-mx-2 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-mist hover:text-peacock">
                        {fillTokens(l.label, site)}
                      </Link>
                    ))}
                  </div>
                )}
              </aside>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Tier 2 on tablets and computers: the All menu (tablets) or the mega menu (computers), links, promotion. */
function TierTwo({ categories, links, allMenu, phone }: { categories: CategoryNode[]; links: LinkItem[]; allMenu: boolean; phone: boolean | null }) {
  return (
    <div className="relative hidden bg-peacock-dark text-white md:block">
      <div className="mx-auto flex h-11 max-w-shop items-center gap-2 px-3 sm:px-4">
        {allMenu && (
          <div className="-ml-2 shrink-0 lg:hidden">
            <AllMenu categories={categories} tone="dark" label="All" />
          </div>
        )}
        <div className="hidden h-full shrink-0 lg:block">
          <MegaMenu categories={categories} />
        </div>
        {links.length > 0 && (
          <nav aria-label="Shop" className="scroll-x flex h-full min-w-0 flex-1 items-center overflow-x-auto lg:pl-1">
            <NavLinks links={links} />
          </nav>
        )}
        {phone !== true && <Promo className="ml-auto text-sm" />}
      </div>
    </div>
  );
}

/** Phones: the delivery PIN, the promotion and the links in a strip that scrolls sideways. */
function PhoneStrip({ links, pinOn }: { links: LinkItem[]; pinOn: boolean }) {
  const site = useSite();
  const promoOn = Boolean(site.nav?.promo?.enabled && site.nav.promo.text);
  if (!links.length && !pinOn && !promoOn) return null;
  return (
    <div className="bg-peacock-dark text-white md:hidden">
      <div className="flex h-10 items-center pl-0.5">
        {pinOn && (
          <>
            {/* the PIN button is a full-height touch target in the strip */}
            <div className="[&_[data-testid=deliver-to]]:min-h-10">
              <DeliverTo tone="dark" />
            </div>
            <span className="mx-0.5 h-4 w-px shrink-0 bg-white/25" aria-hidden />
          </>
        )}
        <nav aria-label="Shop" className="scroll-x flex h-full min-w-0 flex-1 items-center overflow-x-auto pr-2">
          <Promo className="mx-1 py-0.5 text-[13px]" />
          <NavLinks links={links} small />
        </nav>
      </div>
    </div>
  );
}

export function BazaarHeader() {
  const cats = useCategories();
  const site = useSite();
  const phone = usePhone();
  const pinOn = site.pdp?.header_pincode !== false;
  const allMenu = site.nav?.all_menu !== false;
  const links = navLinks(site);
  return (
    <>
      <AnnouncementBar />
      {/* the All menu drawer opens inside the header, so the header rises above the phone tab bar while it is open */}
      <header className="sticky top-0 z-30 shadow-md has-[[aria-modal=true]]:z-[60]">
        <div className="bg-peacock text-white">
          <div className="mx-auto flex max-w-shop flex-wrap items-center gap-x-1 gap-y-1.5 px-3 pb-2.5 pt-1.5 sm:gap-x-2 sm:px-4 md:gap-y-2 md:pb-3 md:pt-2 lg:flex-nowrap lg:gap-x-4 lg:py-3">
            {/* phones: the All menu as an icon here; tablets have it in tier 2 */}
            {allMenu && phone !== false && (
              <div className="-ml-2 md:hidden">
                <AllMenu categories={cats} tone="dark" iconOnly />
              </div>
            )}
            <Logo />
            {pinOn && phone !== true && (
              <div className="hidden md:block">
                <DeliverTo tone="dark" />
              </div>
            )}
            {/* one search box: full width on its own row on phones and tablets, centred in the row on computers */}
            <div className="order-last w-full min-w-0 lg:order-none lg:mx-auto lg:w-auto lg:max-w-3xl lg:flex-1">
              <Suspense fallback={<div className="h-11 rounded-full bg-white" aria-hidden />}>
                <SearchBox categories={cats} variant="solid" shape="pill" button="accent" />
              </Suspense>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1 lg:ml-0">
              <NotificationBell />
              <AccountMenu tone="dark" compact={phone === true} />
              <div className="hidden xl:block">
                <ReturnsOrders tone="dark" />
              </div>
              <WishlistLink tone="dark" />
              <CartLink tone="dark" label={phone !== true} />
            </div>
          </div>
        </div>
        {phone !== true && <TierTwo categories={cats} links={links} allMenu={allMenu} phone={phone} />}
      </header>
      {phone !== false && <PhoneStrip links={links} pinOn={pinOn} />}
    </>
  );
}
