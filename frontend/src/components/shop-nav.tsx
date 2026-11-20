"use client";

/*
 * Header navigation: search with a category picker and recent/trending suggestions, the "All" side menu and the
 * second bar with the marketplace's links and an optional promotion. All of it is set in Admin → Storefront → Navigation.
 */

import clsx from "clsx";
import { ChevronDown, ChevronRight, Clock, LayoutGrid, Menu, Search, TrendingUp, User as UserIcon, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";
import type { CategoryNode } from "@/lib/types";

const RECENT = "pc_recent_searches";

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) || "[]");
  } catch {
    return [];
  }
}

function saveRecent(q: string) {
  try {
    const list = [q, ...readRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    localStorage.setItem(RECENT, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

export function SearchBox({ categories }: { categories: CategoryNode[] }) {
  const site = useSite();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [cat, setCat] = useState(params.get("category") ?? "");
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [sugg, setSugg] = useState<{ products: { title: string; slug: string }[]; categories: { name: string; slug: string }[] }>({ products: [], categories: [] });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [paramsQ, setParamsQ] = useState(params.get("q") ?? "");
  if ((params.get("q") ?? "") !== paramsQ) {
    // the address changed (back button, a link): show its search
    setParamsQ(params.get("q") ?? "");
    setQ(params.get("q") ?? "");
  }

  function onChange(v: string) {
    setQ(v);
    setOpen(true);
    clearTimeout(timer.current);
    if (v.trim().length < 2) {
      setSugg({ products: [], categories: [] });
      return;
    }
    timer.current = setTimeout(() => {
      api<typeof sugg>("/api/catalog/suggest", { query: { q: v.trim() } }).then(setSugg).catch(() => {});
    }, 160);
  }

  function go(text: string) {
    const t = text.trim();
    setOpen(false);
    if (!t) return;
    saveRecent(t);
    const target = `/search?q=${encodeURIComponent(t)}${cat ? `&category=${encodeURIComponent(cat)}` : ""}`;
    if (location.pathname + location.search !== target) window.dispatchEvent(new Event("route-progress:start"));
    router.push(target);
  }

  const empty = q.trim().length < 2;
  const trending = site.nav?.trending ?? [];
  return (
    <form onSubmit={(e) => { e.preventDefault(); go(q); }} role="search" className="relative flex w-full rounded-lg bg-white focus-within:ring-2 focus-within:ring-marigold">
      {site.nav?.search_categories !== false && categories.length > 0 && (
        <>
          <label htmlFor="search-cat" className="sr-only">Search in</label>
          <select id="search-cat" value={cat} onChange={(e) => setCat(e.target.value)}
            className="h-11 max-w-[30%] shrink-0 cursor-pointer rounded-l-lg border-r border-line bg-mist px-2 text-[13px] text-ink-soft hover:bg-line/60 focus:outline-none sm:max-w-[160px]">
            <option value="">All</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
        </>
      )}
      <label htmlFor="site-search" className="sr-only">Search products</label>
      <input
        id="site-search"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => { setRecent(readRecent()); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={`Search ${site.brand_name || "the store"}`}
        autoComplete="off"
        className="h-11 min-w-0 flex-1 bg-transparent pl-3 pr-12 text-[15px] text-ink placeholder:text-ink-faint focus:outline-none"
      />
      <button type="submit" aria-label="Search" className="absolute right-1 top-1 flex h-9 w-10 items-center justify-center rounded-md bg-marigold text-ink hover:bg-marigold-dark">
        <Search className="h-5 w-5" />
      </button>
      {open && (empty ? recent.length > 0 || trending.length > 0 : sugg.products.length > 0 || sugg.categories.length > 0) && (
        <div className="absolute left-0 right-0 top-12 z-40 overflow-hidden rounded-lg bg-white py-1 text-ink shadow-xl ring-1 ring-line" data-testid="search-suggestions">
          {empty ? (
            <>
              {recent.length > 0 && (
                <div>
                  <p className="flex items-center justify-between px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    Recent searches
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); try { localStorage.removeItem(RECENT); } catch { /* ignore */ } setRecent([]); }} className="normal-case tracking-normal text-peacock">Clear</button>
                  </p>
                  {recent.map((r) => (
                    <button key={r} type="button" onMouseDown={(e) => { e.preventDefault(); setQ(r); go(r); }} className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-mist">
                      <Clock className="h-4 w-4 text-ink-faint" /> {r}
                    </button>
                  ))}
                </div>
              )}
              {trending.length > 0 && (
                <div>
                  <p className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Trending</p>
                  {trending.map((t) => (
                    <button key={t} type="button" onMouseDown={(e) => { e.preventDefault(); setQ(t); go(t); }} className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-mist">
                      <TrendingUp className="h-4 w-4 text-ink-faint" /> {t}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <ul>
              {sugg.categories.map((c) => (
                <li key={c.slug}><Link href={`/c/${c.slug}`} className="flex items-center gap-2 px-4 py-2 hover:bg-mist"><LayoutGrid className="h-4 w-4 text-ink-faint" />{c.name}</Link></li>
              ))}
              {sugg.products.map((p) => (
                <li key={p.slug}><Link href={`/p/${p.slug}`} onMouseDown={() => saveRecent(q.trim())} className="flex items-center gap-2 px-4 py-2 hover:bg-mist"><Search className="h-4 w-4 text-ink-faint" /><span className="truncate">{p.title}</span></Link></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

/** The "All" side menu: account, popular pages, every category, programmes and help. */
export function AllMenu({ categories }: { categories: CategoryNode[] }) {
  const site = useSite();
  const { user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const pathname = usePathname();
  const [path, setPath] = useState(pathname);
  if (pathname !== path) {
    setPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; };
  }, [open]);
  const t = (x: string) => fillTokens(x, site);
  const row = "flex w-full items-center justify-between px-6 py-2.5 text-left text-[15px] hover:bg-mist";
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex shrink-0 items-center gap-1 rounded px-2 py-1 font-semibold text-ink hover:bg-peacock-light hover:text-peacock" aria-haspopup="dialog" data-testid="all-menu">
        <Menu className="h-5 w-5" /> All
      </button>
      {open && (
        <div className="fixed inset-0 z-[60] flex" role="dialog" aria-modal="true" aria-label="All categories and pages">
          <div className="absolute inset-0 bg-ink/60" onClick={() => setOpen(false)} />
          <nav className="relative flex h-full w-[86%] max-w-[365px] flex-col overflow-y-auto bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-peacock px-6 py-4 text-white">
              <UserIcon className="h-7 w-7 rounded-full bg-white/20 p-1" />
              {user ? <span className="text-lg font-semibold">Hello, {user.name?.split(" ")[0] || "there"}</span>
                : <Link href={`/login?next=${encodeURIComponent(pathname)}`} className="text-lg font-semibold">Hello, sign in</Link>}
            </div>
            {site.nav?.links?.length ? (
              <section className="border-b border-line py-2">
                <h2 className="px-6 py-2 text-lg font-semibold">Trending</h2>
                {site.nav.links.map((l) => <Link key={l.href} href={l.href} className={row}>{t(l.label)}</Link>)}
              </section>
            ) : null}
            <section className="border-b border-line py-2">
              <h2 className="px-6 py-2 text-lg font-semibold">Shop by category</h2>
              {categories.map((c) => (
                <div key={c.slug}>
                  {c.children.length ? (
                    <button type="button" className={row} aria-expanded={expanded === c.slug} onClick={() => setExpanded(expanded === c.slug ? null : c.slug)}>
                      {c.name}<ChevronRight className={clsx("h-4 w-4 text-ink-faint transition", expanded === c.slug && "rotate-90")} />
                    </button>
                  ) : <Link href={`/c/${c.slug}`} className={row}>{c.name}</Link>}
                  {expanded === c.slug && (
                    <div className="bg-mist/60 pb-1">
                      <Link href={`/c/${c.slug}`} className="block px-9 py-2 text-sm font-semibold text-peacock hover:underline">All of {c.name}</Link>
                      {c.children.map((ch) => <Link key={ch.slug} href={`/c/${ch.slug}`} className="block px-9 py-2 text-sm hover:bg-mist">{ch.name}</Link>)}
                    </div>
                  )}
                </div>
              ))}
            </section>
            <section className="border-b border-line py-2">
              <h2 className="px-6 py-2 text-lg font-semibold">Programs and features</h2>
              {(site.nav?.drawer_links ?? []).map((l) => <Link key={l.href + l.label} href={l.href} className={row}>{t(l.label)}</Link>)}
              {site.features.wishlist && <Link href="/wishlist" className={row}>Your wishlist</Link>}
            </section>
            <section className="py-2">
              <h2 className="px-6 py-2 text-lg font-semibold">Help and settings</h2>
              <Link href="/account" className={row}>Your account</Link>
              <Link href="/orders" className={row}>Your orders</Link>
              <Link href="/help" className={row}>Customer service</Link>
              {user ? <button type="button" onClick={() => { setOpen(false); signOut(); }} className={row}>Sign out</button>
                : <Link href={`/login?next=${encodeURIComponent(pathname)}`} className={row}>Sign in</Link>}
            </section>
          </nav>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close menu" className="relative ml-2 mt-3 h-10 w-10 rounded-full text-white hover:bg-white/10"><X className="mx-auto h-7 w-7" /></button>
        </div>
      )}
    </>
  );
}

/** The second header bar: All menu, delivery PIN, the marketplace's links, categories and a promotion. */
export function NavBar({ categories, deliverTo }: { categories: CategoryNode[]; deliverTo: React.ReactNode }) {
  const site = useSite();
  const nav = site.nav;
  const t = (x: string) => fillTokens(x, site);
  const tone = { accent: "bg-marigold text-ink", buy: "bg-vermilion text-white", primary: "bg-peacock text-white", dark: "bg-ink text-white" }[nav?.promo?.tone ?? "accent"];
  return (
    <div className="mx-auto flex max-w-shop items-center gap-1 px-3 pb-2 pt-4 sm:px-4">
      {nav?.all_menu !== false && <AllMenu categories={categories} />}
      {deliverTo}
      <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />
      <nav className="scroll-x flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Shop">
        {(nav?.links ?? []).map((l) => (
          <Link key={l.href + l.label} href={l.href} className="shrink-0 rounded-full px-3 py-1 text-[15px] font-semibold text-ink hover:bg-peacock-light hover:text-peacock">{t(l.label)}</Link>
        ))}
        {nav?.show_categories !== false && categories.map((c) => (
          <Link key={c.slug} href={`/c/${c.slug}`} className="shrink-0 rounded-full px-3 py-1 text-[15px] font-medium text-ink-soft hover:bg-peacock-light hover:text-peacock">{c.name}</Link>
        ))}
      </nav>
      {nav?.promo?.enabled && nav.promo.text && (
        nav.promo.link
          ? <Link href={nav.promo.link} className={clsx("hidden shrink-0 rounded-full px-3 py-1 text-sm font-bold lg:block", tone)} data-testid="nav-promo">{t(nav.promo.text)}</Link>
          : <span className={clsx("hidden shrink-0 rounded-full px-3 py-1 text-sm font-bold lg:block", tone)} data-testid="nav-promo">{t(nav.promo.text)}</span>
      )}
    </div>
  );
}

export function ReturnsOrders() {
  return (
    <Link href="/orders" className="hidden h-10 flex-col justify-center rounded-lg px-2 leading-tight text-white hover:bg-white/10 lg:flex">
      <span className="text-xs text-white/80">Returns</span>
      <span className="text-sm font-semibold">&amp; Orders</span>
    </Link>
  );
}

export function useCategoryTree() {
  const [cats, setCats] = useState<CategoryNode[]>([]);
  useEffect(() => {
    api<CategoryNode[]>("/api/catalog/categories").then(setCats).catch(() => {});
  }, []);
  return cats;
}

export { ChevronDown };
