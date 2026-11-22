"use client";

/*
 * The four admin layouts. Each shows the same menu (by role), badges, notifications, quick find, the layout switcher
 * and sign-out; they differ in how the menu is arranged. Pages render the same in all of them.
 *   sidebar  the menu on the left (foldable groups, fold to icons), a drawer on phones
 *   topnav   menus across the top, full-width pages, a drawer on phones
 *   rail     a slim dark icon rail that opens on hover or focus, a drawer on phones
 *   glass    inspired by Apple's design guidelines: a frosted sidebar and toolbar (never on content), the system font,
 *            large titles, a tab bar with More on phones; opaque when transparency is reduced
 */

import clsx from "clsx";
import { ChevronDown, Menu, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Logo } from "@/components/shop-chrome";
import { useSite } from "@/lib/site";
import { isActiveItem, navSections, type AdminNavItem, type NavSection } from "./nav";
import { Breadcrumb, MenuDrawer, NavList, QuickFindButton, UserTools } from "./parts";
import { useAdminPrefs } from "./prefs";

export interface ShellProps {
  title: string;
  items: AdminNavItem[];
  onFind: () => void;
  children: React.ReactNode;
}

function TitleBadge({ title, tone = "dark" }: { title: string; tone?: "dark" | "light" }) {
  return <span className={clsx("hidden rounded-md px-2 py-0.5 text-sm font-semibold sm:inline", tone === "dark" ? "bg-white/15 text-white" : "bg-mist text-ink-soft")}>{title}</span>;
}

/** Closes a phone drawer when the page changes. */
function useDrawer() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(pathname);
  if (path !== pathname) {
    setPath(pathname);
    setOpen(false);
  }
  return [open, setOpen] as const;
}

/* ------------------------------------------------------------------ sidebar (default) */

export function SidebarShell({ title, items, onFind, children }: ShellProps) {
  const { sidebarFolded, setSidebarFolded } = useAdminPrefs();
  const [drawer, setDrawer] = useDrawer();
  return (
    <div className="min-h-screen" data-admin-layout="sidebar">
      <header className="sticky top-0 z-30">
        <div className="bg-peacock">
          <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
            <button type="button" onClick={() => setDrawer(true)} aria-label="Menu" className="flex h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/10 lg:hidden"><Menu className="h-5 w-5" /></button>
            <Logo />
            <TitleBadge title={title} />
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden md:block"><QuickFindButton onClick={onFind} tone="dark" /></span>
              <UserTools />
            </div>
          </div>
        </div>
        <div className="awning bg-mist" aria-hidden />
      </header>
      <div className="mx-auto flex max-w-[1680px] gap-4 px-3 pb-10 pt-3 sm:px-4">
        <aside className={clsx("hidden shrink-0 self-start lg:sticky lg:top-[84px] lg:block lg:max-h-[calc(100vh-96px)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-xl lg:p-2 lg:shadow-sm lg:[scrollbar-width:thin]",
          sidebarFolded ? "w-[64px] bg-ink" : "w-64 bg-white")} aria-label={`${title} navigation`}>
          <div className={clsx("mb-1 flex items-center gap-1", sidebarFolded && "flex-col")}>
            {sidebarFolded
              ? <button type="button" onClick={onFind} aria-label="Quick find (Ctrl+K)" className="flex h-10 w-10 items-center justify-center rounded-lg text-white/80 hover:bg-white/10"><Search className="h-[18px] w-[18px]" /></button>
              : <QuickFindButton onClick={onFind} wide />}
            <button type="button" onClick={() => setSidebarFolded(!sidebarFolded)} aria-label={sidebarFolded ? "Show the full menu" : "Fold the menu to icons"} aria-pressed={sidebarFolded}
              className={clsx("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", sidebarFolded ? "text-white/80 hover:bg-white/10" : "text-ink-soft hover:bg-mist")}>
              {sidebarFolded ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
            </button>
          </div>
          <NavList items={items} variant={sidebarFolded ? "icons" : "plain"} />
        </aside>
        <main className="min-w-0 flex-1">
          <Breadcrumb items={items} className="mb-2 text-ink-soft" />
          {children}
        </main>
      </div>
      <MenuDrawer items={items} open={drawer} onClose={() => setDrawer(false)} title={title} />
    </div>
  );
}

/* ------------------------------------------------------------------ top navigation */

function SectionMenu({ section }: { section: NavSection }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(pathname);
  const box = useRef<HTMLDivElement>(null);
  if (path !== pathname) {
    setPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const active = section.items.some((i) => isActiveItem(pathname, i));
  if (section.items.length === 1) {
    const i = section.items[0];
    return (
      <Link href={i.href} aria-current={active ? "page" : undefined}
        className={clsx("flex h-11 items-center gap-1.5 border-b-2 px-3 text-[14px] font-semibold", active ? "border-peacock text-peacock" : "border-transparent text-ink hover:text-peacock")}>
        {i.label}
      </Link>
    );
  }
  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
        className={clsx("flex h-11 items-center gap-1 border-b-2 px-3 text-[14px] font-semibold", active ? "border-peacock text-peacock" : "border-transparent text-ink hover:text-peacock")}>
        {section.name}
        {section.badge > 0 && <span className="rounded-full bg-vermilion px-1.5 text-[11px] font-bold leading-4 text-white">{section.badge}</span>}
        <ChevronDown className={clsx("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 top-12 z-40 w-72 animate-rise-in rounded-xl bg-white p-1.5 shadow-xl ring-1 ring-line" role="menu">
          {section.items.map((i) => {
            const on = isActiveItem(pathname, i);
            return (
              <Link key={i.href} href={i.href} role="menuitem" aria-current={on ? "page" : undefined}
                className={clsx("flex items-center gap-2.5 rounded-lg px-3 py-2 text-[15px]", on ? "bg-peacock text-white" : "text-ink hover:bg-peacock-light hover:text-peacock")}>
                <i.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                <span className="flex-1">{i.label}</span>
                {i.badge ? <span className={clsx("rounded-full px-1.5 text-xs font-bold leading-5", on ? "bg-white text-peacock" : "bg-vermilion text-white")}>{i.badge}</span> : null}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TopnavShell({ title, items, onFind, children }: ShellProps) {
  const [drawer, setDrawer] = useDrawer();
  return (
    <div className="min-h-screen" data-admin-layout="topnav">
      <header className="sticky top-0 z-30 shadow-sm">
        <div className="bg-peacock">
          <div className="flex items-center gap-3 px-3 py-2 sm:px-6">
            <button type="button" onClick={() => setDrawer(true)} aria-label="Menu" className="flex h-9 w-9 items-center justify-center rounded-lg text-white hover:bg-white/10 lg:hidden"><Menu className="h-5 w-5" /></button>
            <Logo />
            <TitleBadge title={title} />
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden md:block"><QuickFindButton onClick={onFind} tone="dark" /></span>
              <UserTools />
            </div>
          </div>
        </div>
        <nav className="hidden border-b border-line bg-white lg:block" aria-label={`${title} navigation`}>
          <div className="flex flex-wrap items-center px-3 sm:px-6">
            {navSections(items).map((s) => <SectionMenu key={s.name} section={s} />)}
          </div>
        </nav>
      </header>
      <div className="px-3 pb-10 pt-4 sm:px-6">
        <Breadcrumb items={items} className="mb-2 text-ink-soft" />
        <main className="min-w-0">{children}</main>
      </div>
      <MenuDrawer items={items} open={drawer} onClose={() => setDrawer(false)} title={title} />
    </div>
  );
}

/* ------------------------------------------------------------------ compact rail */

export function RailShell({ title, items, onFind, children }: ShellProps) {
  const site = useSite();
  const [drawer, setDrawer] = useDrawer();
  return (
    <div className="min-h-screen lg:pl-16" data-admin-layout="rail">
      <aside className="group/rail fixed inset-y-0 left-0 z-40 hidden w-16 flex-col overflow-hidden bg-ink py-3 text-white shadow-xl transition-[width] duration-200 hover:w-64 focus-within:w-64 lg:flex"
        aria-label={`${title} navigation`}>
        {/* a letter mark while folded, the full logo when the rail opens */}
        <div className="mb-2 flex h-10 items-center px-3">
          <Link href="/admin" aria-label={`${site.brand_name} admin home`} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 font-display text-xl font-bold text-marigold group-hover/rail:hidden group-focus-within/rail:hidden">
            {(site.brand_name || "P").slice(0, 1).toUpperCase()}
          </Link>
          <span className="hidden whitespace-nowrap group-hover/rail:block group-focus-within/rail:block"><Logo /></span>
        </div>
        <button type="button" onClick={onFind} aria-label="Quick find (Ctrl+K)" className="mx-1 mb-2 flex h-10 items-center gap-2.5 rounded-lg px-3 text-white/80 hover:bg-white/10 hover:text-white">
          <Search className="h-[18px] w-[18px] shrink-0" />
          <span className="whitespace-nowrap text-[14px] opacity-0 transition-opacity group-hover/rail:opacity-100 group-focus-within/rail:opacity-100">Find a page</span>
        </button>
        <div className="flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:none]"><NavList items={items} variant="rail" /></div>
      </aside>
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-white/95 px-3 py-2 backdrop-blur sm:px-6">
        <button type="button" onClick={() => setDrawer(true)} aria-label="Menu" className="flex h-9 w-9 items-center justify-center rounded-lg text-ink hover:bg-mist lg:hidden"><Menu className="h-5 w-5" /></button>
        <span className="lg:hidden"><Logo light={false} /></span>
        <Breadcrumb items={items} className="hidden text-ink-soft lg:flex" />
        <div className="ml-auto"><UserTools tone="light" /></div>
      </header>
      <main className="min-w-0 px-3 pb-10 pt-4 sm:px-6">{children}</main>
      <MenuDrawer items={items} open={drawer} onClose={() => setDrawer(false)} title={title} />
    </div>
  );
}

/* ------------------------------------------------------------------ glass */

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const GLASS = "bg-white/70 backdrop-blur-2xl backdrop-saturate-150 [@media(prefers-reduced-transparency:reduce)]:bg-white [@media(prefers-contrast:more)]:bg-white";
/** The phone tab bar's sections (the first four this person can open), with short names that fit a tab. */
const TABS: [string, string][] = [
  ["/admin", "Overview"], ["/admin/orders", "Orders"], ["/admin/products", "Listings"], ["/admin/delivery", "Delivery"],
  ["/admin/support", "Support"], ["/admin/storefront", "Store"], ["/admin/payouts", "Payouts"],
];

export function GlassShell({ title, items, onFind, children }: ShellProps) {
  const pathname = usePathname();
  const { sidebarFolded: hidden, setSidebarFolded } = useAdminPrefs();
  const [more, setMore] = useDrawer();
  const tabs = TABS.map(([h, short]) => { const i = items.find((x) => x.href === h); return i ? { ...i, short } : null; })
    .filter((i): i is AdminNavItem & { short: string } => Boolean(i)).slice(0, 4);
  useEffect(() => {
    // the AI assistant's button moves above the tab bar on phones (globals.css)
    document.body.dataset.adminTabbar = "1";
    return () => { delete document.body.dataset.adminTabbar; };
  }, []);
  return (
    <div className="min-h-screen bg-[#F5F5F7]" style={{ "--f-display": SYSTEM_FONT, "--f-sans": SYSTEM_FONT } as React.CSSProperties} data-admin-layout="glass">
      <aside className={clsx("fixed inset-y-0 left-0 z-40 hidden w-[264px] flex-col gap-3 overflow-y-auto border-r border-black/5 p-3 [scrollbar-width:thin]", GLASS, !hidden && "lg:flex")}
        aria-label={`${title} navigation`}>
        <div className="flex items-center justify-between px-2 pt-1"><Logo light={false} /></div>
        <QuickFindButton onClick={onFind} wide />
        <NavList items={items} variant="glass" />
      </aside>
      <div className={clsx(!hidden && "lg:pl-[264px]")}>
        <header className={clsx("sticky top-0 z-30 flex items-center gap-2 border-b border-black/5 px-3 py-2 sm:px-5", GLASS)}>
          <button type="button" onClick={() => setSidebarFolded(!hidden)} aria-label={hidden ? "Show the sidebar" : "Hide the sidebar"} aria-pressed={!hidden}
            className="hidden h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-black/5 lg:flex">
            {hidden ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
          </button>
          <span className="lg:hidden"><Logo light={false} /></span>
          <Breadcrumb items={items} className="hidden text-ink-soft lg:flex" />
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={onFind} aria-label="Quick find (Ctrl+K)" className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft hover:bg-black/5 lg:hidden"><Search className="h-[18px] w-[18px]" /></button>
            <UserTools tone="light" />
          </div>
        </header>
        <main className="min-w-0 px-4 pb-28 pt-5 sm:px-6 lg:px-8 lg:pb-12 [&_h1]:font-bold [&_h1]:tracking-tight">{children}</main>
      </div>
      <nav className={clsx("fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-black/5 pb-[env(safe-area-inset-bottom)] lg:hidden", GLASS)} aria-label="Main">
        {tabs.map((i) => {
          const on = isActiveItem(pathname, i);
          return (
            <Link key={i.href} href={i.href} aria-current={on ? "page" : undefined} className={clsx("relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", on ? "text-peacock" : "text-ink-faint")}>
              <i.icon className="h-[22px] w-[22px]" aria-hidden />
              <span className="max-w-full truncate px-1" aria-hidden>{i.short}</span>
              <span className="sr-only">{i.label}</span>
              {i.badge ? <span className="absolute right-[22%] top-1 h-2 w-2 rounded-full bg-vermilion" /> : null}
            </Link>
          );
        })}
        <button type="button" onClick={() => setMore(true)} className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-ink-faint">
          <MoreHorizontal className="h-[22px] w-[22px]" aria-hidden /> More
        </button>
      </nav>
      <MenuDrawer items={items} open={more} onClose={() => setMore(false)} title={title} />
    </div>
  );
}
