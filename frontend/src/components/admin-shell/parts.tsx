"use client";

/*
 * Pieces every admin layout shares: quick find (Ctrl+K), the layout switcher, the header tools (notifications,
 * environment badge, the staff member, sign out), the menu list with foldable sections, the phone menu drawer and the
 * breadcrumb.
 */

import clsx from "clsx";
import {
  Bike, Check, ChevronDown, ChevronRight, CornerDownLeft, IndianRupee, LayoutTemplate, LifeBuoy, Loader2, LogOut, Package, Search, ShoppingBag, Store, Users, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { NotificationBell } from "@/components/shop-chrome";
import { useAdmin } from "@/lib/admin";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ADMIN_LAYOUTS, LAYOUT_INFO, useAdminPrefs, type AdminLayout } from "./prefs";
import { currentItem, isActiveItem, navSections, type AdminNavItem } from "./nav";

/* ------------------------------------------------------------------ quick find */

/** Opens with Ctrl+K or Cmd+K anywhere in the admin panel, or with the search button. */
export function useQuickFindKey(open: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);
}

/** A record found by the admin search (GET /api/admin/search): only what this staff member may open. */
type FoundRecord = { kind: "order" | "customer" | "seller" | "product" | "partner" | "ticket" | "payout"; id: string; title: string; sub: string; href: string };
const RECORD_ICON: Record<FoundRecord["kind"], typeof Search> = {
  order: ShoppingBag, customer: Users, seller: Store, product: Package, partner: Bike, ticket: LifeBuoy, payout: IndianRupee,
};
const RECORD_NAME: Record<FoundRecord["kind"], string> = {
  order: "Order", customer: "Customer", seller: "Seller", product: "Listing", partner: "Delivery partner", ticket: "Support ticket", payout: "Payout",
};

type Option = { key: string; href: string; icon: typeof Search; title: string; sub: string; badge?: number };

/**
 * Quick find: pages of the admin panel, and (from two letters) records anywhere: orders by number or phone, customers,
 * sellers, listings by title or SKU, delivery partners, support tickets and payouts. One list; arrows and Enter.
 */
export function QuickFind({ items, onClose }: { items: AdminNavItem[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [found, setFound] = useState<{ q: string; results: FoundRecord[] } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const pages = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((i) => words.every((w) => `${i.label} ${i.section}`.toLowerCase().includes(w)));
  }, [items, q]);
  const term = q.trim();
  useEffect(() => {
    if (term.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      api<{ results: FoundRecord[] }>("/api/admin/search", { query: { q: term } })
        .then((r) => { if (live) setFound({ q: term, results: r.results }); })
        .catch(() => { if (live) setFound({ q: term, results: [] }); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [term]);
  const records = term.length >= 2 && found?.q === term ? found.results : [];
  const searching = term.length >= 2 && found?.q !== term;
  const options: Option[] = [
    ...pages.map((i) => ({ key: `page:${i.href}`, href: i.href, icon: i.icon, title: i.label, sub: i.section, badge: i.badge })),
    ...records.map((r) => ({ key: `${r.kind}:${r.id}`, href: r.href, icon: RECORD_ICON[r.kind], title: r.title, sub: `${RECORD_NAME[r.kind]} · ${r.sub}` })),
  ];
  const pick = (o: Option | undefined) => { if (!o) return; onClose(); router.push(o.href); };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [at]);
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-ink/50 p-4 pt-[12vh] backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="dialog" aria-modal="true" aria-label="Quick find">
      <div className="w-full max-w-xl animate-rise-in overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-line">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="h-5 w-5 shrink-0 text-ink-faint" aria-hidden />
          <input autoFocus value={q} placeholder="Go to a page, or find an order, customer, seller, listing…" aria-label="Find a page" role="combobox" aria-expanded aria-controls="quick-find-list"
            aria-activedescendant={options[at] ? `qf-${options[at].key}` : undefined}
            onChange={(e) => { setQ(e.target.value); setAt(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setAt((x) => Math.min(options.length - 1, x + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setAt((x) => Math.max(0, x - 1)); }
              if (e.key === "Enter") { e.preventDefault(); pick(options[at]); }
            }}
            className="h-14 min-w-0 flex-1 bg-transparent text-[16px] focus:outline-none" />
          {searching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ink-faint" aria-label="Searching" />}
          <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint sm:block">Esc</kbd>
        </div>
        <ul id="quick-find-list" ref={list} role="listbox" className="max-h-[55vh] overflow-y-auto p-2">
          {options.length === 0 && !searching && <li className="px-3 py-6 text-center text-sm text-ink-soft">Nothing matches “{q}”.</li>}
          {options.map((o, n) => [
            n === pages.length && records.length > 0 && (
              <li key="records-heading" role="presentation" className="px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint">Records</li>
            ),
            <li key={o.key} id={`qf-${o.key}`} role="option" aria-selected={n === at}>
              <button type="button" onMouseEnter={() => setAt(n)} onClick={() => pick(o)}
                className={clsx("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left", n === at ? "bg-peacock text-white" : "text-ink hover:bg-mist")}>
                <o.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{o.title}</span>
                  <span className={clsx("block truncate text-xs", n === at ? "text-white/75" : "text-ink-faint")}>{o.sub}</span>
                </span>
                {o.badge ? <span className={clsx("rounded-full px-1.5 text-xs font-bold leading-5", n === at ? "bg-white text-peacock" : "bg-vermilion text-white")}>{o.badge}</span> : null}
                {n === at && <CornerDownLeft className="h-4 w-4 shrink-0" aria-hidden />}
              </button>
            </li>,
          ])}
        </ul>
        <p className="border-t border-line px-4 py-2 text-xs text-ink-faint">↑ ↓ to move · Enter to open · Ctrl+K anywhere · type 2 letters to search records</p>
      </div>
    </div>
  );
}

export function QuickFindButton({ onClick, tone = "light", wide = false }: { onClick: () => void; tone?: "light" | "dark"; wide?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label="Quick find (Ctrl+K)" data-testid="quick-find"
      className={clsx("flex h-9 items-center gap-2 rounded-lg text-sm",
        wide ? "w-full px-3" : "px-2.5",
        tone === "dark" ? "bg-white/10 text-white/90 hover:bg-white/20" : "bg-mist text-ink-soft ring-1 ring-line hover:bg-white")}>
      <Search className="h-4 w-4 shrink-0" />
      {wide && <span className="flex-1 text-left">Find a page</span>}
      <kbd className={clsx("hidden rounded px-1 text-[11px] sm:inline", tone === "dark" ? "bg-white/15" : "bg-white ring-1 ring-line")}>Ctrl K</kbd>
    </button>
  );
}

/* ------------------------------------------------------------------ layout switcher */

/** A small drawing of each layout. */
export function LayoutThumb({ id, active }: { id: AdminLayout; active?: boolean }) {
  const bar = active ? "bg-peacock" : "bg-ink/40";
  return (
    <span aria-hidden className="relative block aspect-[4/3] w-full overflow-hidden rounded-md bg-mist ring-1 ring-line">
      {id === "sidebar" && (<><span className={clsx("absolute inset-x-0 top-0 h-[16%]", bar)} /><span className="absolute bottom-[6%] left-[5%] top-[24%] w-[24%] rounded-sm bg-white" /><span className="absolute bottom-[6%] left-[33%] right-[5%] top-[24%] rounded-sm bg-white" /></>)}
      {id === "topnav" && (<><span className={clsx("absolute inset-x-0 top-0 h-[16%]", bar)} /><span className="absolute inset-x-0 top-[16%] h-[10%] bg-white/80" /><span className="absolute bottom-[6%] left-[5%] right-[5%] top-[32%] rounded-sm bg-white" /></>)}
      {id === "rail" && (<><span className="absolute bottom-0 left-0 top-0 w-[12%] bg-ink" /><span className="absolute bottom-[6%] left-[17%] right-[5%] top-[6%] rounded-sm bg-white" /></>)}
      {id === "glass" && (<><span className="absolute bottom-[4%] left-[4%] top-[4%] w-[26%] rounded-md bg-white/70 ring-1 ring-black/5 backdrop-blur" /><span className="absolute left-[34%] top-[8%] h-[8%] w-[30%] rounded-full bg-ink/70" /><span className="absolute bottom-[6%] left-[34%] right-[5%] top-[22%] rounded-md bg-white" /></>)}
    </span>
  );
}

export function LayoutPicker({ compact = false }: { compact?: boolean }) {
  const { layout, chosen, defaultLayout, setLayout } = useAdminPrefs();
  return (
    <div className="flex flex-col gap-2">
      <div className={clsx("grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-4")} role="radiogroup" aria-label="Admin layout">
        {ADMIN_LAYOUTS.map((id) => (
          <button key={id} type="button" role="radio" aria-checked={layout === id} onClick={() => setLayout(id)} data-testid={`admin-layout-${id}`}
            className={clsx("flex flex-col gap-1.5 rounded-xl border-2 p-2 text-left", layout === id ? "border-peacock bg-peacock-light/50" : "border-line hover:border-peacock/50")}>
            <LayoutThumb id={id} active={layout === id} />
            <span className="flex items-center gap-1 text-sm font-semibold">{LAYOUT_INFO[id].name}{layout === id && <Check className="h-4 w-4 text-peacock" />}</span>
            {!compact && <span className="text-xs text-ink-soft">{LAYOUT_INFO[id].text}</span>}
          </button>
        ))}
      </div>
      {chosen && chosen !== defaultLayout && (
        <button type="button" onClick={() => setLayout(null)} className="self-start text-sm font-semibold text-peacock hover:underline">
          Use the default ({LAYOUT_INFO[defaultLayout].name})
        </button>
      )}
    </div>
  );
}

export function LayoutSwitcher({ tone = "dark" }: { tone?: "light" | "dark" }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label="Change the admin layout" data-testid="layout-switcher"
        className={clsx("flex h-9 w-9 items-center justify-center rounded-lg", tone === "dark" ? "text-white hover:bg-white/10" : "text-ink-soft hover:bg-mist")}>
        <LayoutTemplate className="h-5 w-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-[min(22rem,calc(100vw-1.5rem))] animate-rise-in rounded-2xl bg-white p-3 text-ink shadow-2xl ring-1 ring-line" role="dialog" aria-label="Admin layout">
          <p className="mb-2 px-1 text-sm font-semibold">Your admin layout</p>
          <LayoutPicker compact />
          <p className="mt-2 px-1 text-xs text-ink-faint">Only for you. Change it any time here or in My account.</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ header tools */

export function EnvironmentBadge() {
  const { environment } = useAdminPrefs();
  if (!environment || environment === "production") return null;
  return (
    <span className="rounded-md bg-marigold px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-ink" title="This is not the live marketplace" data-testid="environment-badge">
      {environment === "development" ? "Test" : environment}
    </span>
  );
}

export function UserTools({ tone = "dark" }: { tone?: "light" | "dark" }) {
  const { user, signOut } = useSession();
  const me = useAdmin();
  const dark = tone === "dark";
  return (
    <div className={clsx("flex items-center gap-1.5 text-sm", dark ? "text-white/90" : "text-ink-soft")}>
      <EnvironmentBadge />
      <NotificationBell dark={!dark} />
      <LayoutSwitcher tone={tone} />
      <span className="hidden max-w-[12rem] flex-col leading-tight md:flex">
        <span className={clsx("truncate font-semibold", dark ? "text-white" : "text-ink")}>{user?.name || user?.email || user?.phone}</span>
        {me?.role_label && <span className={clsx("truncate text-xs", dark ? "text-white/70" : "text-ink-faint")}>{me.role_label}</span>}
      </span>
      <button onClick={() => signOut().then(() => window.location.assign(new URL("/", window.location.origin)))} aria-label="Sign out"
        className={clsx("flex h-9 items-center gap-1.5 rounded-lg px-2 font-semibold", dark ? "hover:bg-white/10" : "hover:bg-mist")}>
        <LogOut className="h-4 w-4" /><span className="hidden sm:inline">Sign out</span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ menu list */

/**
 * The menu as a vertical list with foldable sections (remembered per person).
 * variant: "plain" (sidebar, drawer), "glass" (inset groups), "icons" (only icons, labels in tooltips), "rail" (icons;
 * labels appear when the rail opens on hover or focus).
 */
export function NavList({ items, variant = "plain", onPick }: { items: AdminNavItem[]; variant?: "plain" | "glass" | "icons" | "rail"; onPick?: () => void }) {
  const pathname = usePathname();
  const { folded, toggleSection } = useAdminPrefs();
  const sections = navSections(items);
  return (
    <div className={clsx("flex flex-col", variant === "glass" ? "gap-3" : "gap-1")}>
      {sections.map((s) => {
        const iconish = variant === "icons" || variant === "rail";
        const isFolded = !iconish && folded.includes(s.name) && !s.items.some((i) => isActiveItem(pathname, i));
        return (
          <div key={s.name} className={clsx(variant === "glass" && "rounded-xl bg-white/60 p-1 ring-1 ring-black/5 [@media(prefers-reduced-transparency:reduce)]:bg-white")}>
            {iconish ? <hr className="mx-2 my-1 border-white/15 first:hidden" /> : (
              <button type="button" onClick={() => toggleSection(s.name)} aria-expanded={!isFolded}
                className={clsx("flex w-full items-center gap-1 rounded-md px-3 pb-1 pt-2 text-left text-[11px] font-bold uppercase tracking-wider text-ink-faint hover:text-ink",
                  variant === "glass" && "normal-case tracking-normal text-[12px] font-semibold")}>
                <span className="flex-1">{s.name}</span>
                {isFolded && s.badge > 0 && <span className="rounded-full bg-vermilion px-1.5 text-[10px] font-bold leading-4 text-white">{s.badge}</span>}
                <ChevronDown className={clsx("h-3.5 w-3.5 transition-transform", isFolded && "-rotate-90")} aria-hidden />
              </button>
            )}
            {!isFolded && s.items.map((i) => {
              const active = isActiveItem(pathname, i);
              return (
                <Link key={i.href} href={i.href} onClick={onPick} aria-current={active ? "page" : undefined} title={iconish ? i.label : undefined}
                  className={clsx("group relative flex items-center gap-2.5 rounded-lg font-medium transition-colors",
                    variant === "icons" ? "mx-1 h-10 justify-center" : variant === "rail" ? "mx-1 h-10 px-3 text-[14px]" : "px-3 py-2 text-[15px]",
                    variant === "glass" && "py-1.5 text-[14px]",
                    active ? "bg-peacock text-white shadow-sm" : iconish ? "text-white/80 hover:bg-white/10 hover:text-white" : "text-ink hover:bg-peacock-light hover:text-peacock")}>
                  <i.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                  {variant === "icons" ? <span className="sr-only">{i.label}</span>
                    : variant === "rail" ? <span className="min-w-0 flex-1 whitespace-nowrap opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">{i.label}</span>
                    : <span className="min-w-0 flex-1">{i.label}</span>}
                  {i.badge ? (
                    <span className={clsx("rounded-full px-1.5 text-xs font-bold leading-5", variant === "icons" && "absolute right-0 top-0 scale-90", variant === "rail" && "absolute left-6 top-0.5 scale-90",
                      active ? "bg-white text-peacock" : "bg-vermilion text-white")}>{i.badge}</span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ breadcrumb and phone drawer */

export function Breadcrumb({ items, className }: { items: AdminNavItem[]; className?: string }) {
  const pathname = usePathname();
  const cur = currentItem(pathname, items);
  if (!cur) return null;
  const deeper = pathname !== cur.href;
  return (
    <nav aria-label="Breadcrumb" className={clsx("flex min-w-0 items-center gap-1 text-sm", className)}>
      <span className="hidden truncate sm:inline">{cur.section}</span>
      <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 opacity-60 sm:block" aria-hidden />
      {deeper ? <Link href={cur.href} className="truncate font-semibold hover:underline">{cur.label}</Link> : <span className="truncate font-semibold" aria-current="page">{cur.label}</span>}
      {deeper && <><ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden /><span className="truncate">Details</span></>}
    </nav>
  );
}

export function MenuDrawer({ items, open, onClose, title }: { items: AdminNavItem[]; open: boolean; onClose: () => void; title: string }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex" role="dialog" aria-modal="true" aria-label={`${title} menu`}>
      <div className="absolute inset-0 animate-fade-in bg-ink/50" onClick={onClose} />
      <nav className="relative flex h-full w-[86%] max-w-[340px] animate-rise-in flex-col overflow-y-auto bg-white p-2 shadow-2xl" aria-label={`${title} navigation`}>
        <div className="mb-1 flex items-center justify-between px-2 py-2">
          <span className="font-semibold">{title}</span>
          <button type="button" onClick={onClose} aria-label="Close menu" className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-mist"><X className="h-5 w-5" /></button>
        </div>
        <NavList items={items} onPick={onClose} />
      </nav>
    </div>
  );
}
