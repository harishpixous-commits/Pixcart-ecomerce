"use client";

import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BackLink } from "@/components/back-button";
import { Logo, NotificationBell } from "@/components/shop-chrome";
import { useSession } from "@/lib/session";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  section?: string; // heading shown above the first item of each section (desktop)
  exact?: boolean; // active only on this exact path (an overview whose sub-pages have their own items)
}

/** Shared chrome for the seller hub and the admin panel: peacock top bar with awning, side navigation. */
export function PortalShell({ title, nav, children, root }: { title: string; nav: NavItem[]; children: React.ReactNode; root: string }) {
  const pathname = usePathname();
  const { user, signOut } = useSession();
  const exact = new Set(nav.filter((n) => n.exact).map((n) => n.href));
  const isActive = (href: string) => (href === root || exact.has(href) ? pathname === href : pathname.startsWith(href));
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30">
        <div className="bg-peacock">
          <div className="flex items-center gap-4 px-4 py-2.5">
            <Logo />
            <span className="rounded-md bg-white/15 px-2 py-0.5 text-sm font-semibold text-white">{title}</span>
            <div className="ml-auto flex items-center gap-3 text-sm text-white/90">
              <NotificationBell />
              <span className="hidden sm:inline">{user?.name || user?.email || user?.phone}</span>
              <button onClick={() => signOut().then(() => window.location.assign(new URL("/", window.location.origin)))} className="rounded-md px-2 py-1 font-semibold hover:bg-white/10">
                Sign out
              </button>
            </div>
          </div>
        </div>
        <div className="awning bg-mist" aria-hidden />
      </header>
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-3 pb-10 pt-3 sm:px-4 lg:flex-row">
        {/* Phones: one row that scrolls sideways. Desktop: a card that stays in view and scrolls on its own,
            so every item is reachable however long the menu is. */}
        <nav
          className="scroll-x -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1 lg:sticky lg:top-[84px] lg:mx-0 lg:max-h-[calc(100vh-96px)] lg:w-60 lg:shrink-0 lg:flex-col lg:gap-0.5 lg:self-start lg:overflow-y-auto lg:overflow-x-hidden lg:overscroll-contain lg:rounded-xl lg:bg-white lg:p-2 lg:shadow-sm lg:[scrollbar-width:thin]"
          aria-label={`${title} navigation`}
        >
          {nav.map(({ href, label, icon: Icon, badge, section }, i) => (
            <div key={href} className="contents">
              {section && section !== nav[i - 1]?.section && (
                <p className="hidden px-3 pb-1 pt-3 text-[11px] font-bold uppercase tracking-wider text-ink-faint first:pt-1 lg:block">{section}</p>
              )}
              <Link
                href={href}
                aria-current={isActive(href) ? "page" : undefined}
                className={clsx(
                  "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-[15px] font-medium transition-colors",
                  isActive(href)
                    ? "bg-peacock text-white shadow-sm"
                    : "bg-white text-ink ring-1 ring-line hover:bg-peacock-light hover:text-peacock lg:bg-transparent lg:ring-0",
                )}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                <span className="whitespace-nowrap lg:whitespace-normal">{label}</span>
                {badge ? <span className={clsx("ml-auto rounded-full px-1.5 text-xs font-bold leading-5", isActive(href) ? "bg-white text-peacock" : "bg-vermilion text-white")}>{badge}</span> : null}
              </Link>
            </div>
          ))}
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, sub, actions, back }: { title: string; sub?: string; actions?: React.ReactNode; back?: { href: string; label?: string } }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        {back && <BackLink fallback={back.href} label={back.label} className="mb-1" />}
        <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
        {sub && <p className="text-ink-soft">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs({ value, onChange, items }: { value: string; onChange: (v: string) => void; items: { value: string; label: string; count?: number }[] }) {
  return (
    <div className="scroll-x mb-3 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
      {items.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx("-mb-px shrink-0 border-b-2 px-3 py-2 font-medium", value === t.value ? "border-peacock text-peacock" : "border-transparent text-ink-soft hover:text-ink")}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-sm text-ink-faint">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint, href }: { label: string; value: string | number; hint?: string; href?: string }) {
  const body = (
    <>
      <p className="text-sm text-ink-soft">{label}</p>
      <p className="font-display text-3xl font-bold text-ink">{value}</p>
      {hint && <p className="text-xs text-ink-faint">{hint}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="rounded-xl bg-white p-4 hover:ring-2 hover:ring-peacock/20">{body}</Link>
  ) : (
    <div className="rounded-xl bg-white p-4">{body}</div>
  );
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl bg-white">
      <table className="w-full min-w-[640px] text-left text-[15px]">
        <thead className="border-b border-line text-sm text-ink-faint">
          <tr>{head.map((h) => <th key={h} className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
