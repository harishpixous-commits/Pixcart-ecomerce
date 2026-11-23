"use client";

/*
 * "Page not found" and "Something went wrong" for every part of the app: the shop (inside the active theme's header
 * and footer, in its colours), the admin panel, the seller hub and the delivery partner app. The shop's titles,
 * messages, search box and suggestions are set in Admin → Marketplace settings → Error pages.
 */

import { AlertTriangle, Home, RotateCcw, Search, SearchX } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ProductRail } from "@/components/product";
import { api } from "@/lib/api";
import { useSite } from "@/lib/site";
import type { ErrorPageSettings, ProductCard } from "@/lib/types";

export type Area = "shop" | "admin" | "seller" | "delivery";

export const ERROR_PAGE_DEFAULTS: ErrorPageSettings = {
  not_found_title: "We couldn't find that page",
  not_found_message: "The link may be old, or the product is no longer sold. Try a search, or pick from what other shoppers are buying.",
  not_found_search: true,
  not_found_suggestions: true,
  error_title: "Something went wrong on our side",
  error_message: "Please try again. If it keeps happening, contact us and quote the reference shown below.",
};

const HOME: Record<Area, { href: string; label: string }> = {
  shop: { href: "/", label: "Go to the home page" },
  admin: { href: "/admin", label: "Back to the overview" },
  seller: { href: "/seller", label: "Back to your dashboard" },
  delivery: { href: "/delivery", label: "Back to your trips" },
};

function useErrorPages(): ErrorPageSettings {
  const site = useSite();
  return { ...ERROR_PAGE_DEFAULTS, ...(site.error_pages ?? {}) };
}

function Frame({ icon, tone, title, children, testId }: { icon: React.ReactNode; tone: "info" | "danger"; title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="mx-auto flex w-full max-w-xl flex-col items-center px-2 py-10 text-center sm:py-16" data-testid={testId}>
      <span className={tone === "danger" ? "mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-vermilion/10 text-vermilion" : "mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-peacock/10 text-peacock"}>
        {icon}
      </span>
      <h1 className="font-display text-2xl font-bold text-ink sm:text-3xl">{title}</h1>
      {children}
    </section>
  );
}

function Suggestions() {
  const [items, setItems] = useState<ProductCard[] | null>(null);
  useEffect(() => {
    let live = true;
    api<{ items?: ProductCard[]; sections?: { items: ProductCard[] }[] }>("/api/catalog/top", { query: { list: "bestsellers" } })
      .then((d) => { if (live) setItems((d.items ?? d.sections?.flatMap((s) => s.items) ?? []).slice(0, 12)); })
      .catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, []);
  if (!items?.length) return null;
  return <div className="mt-2 w-full text-left"><ProductRail title="Popular right now" items={items} href="/bestsellers" /></div>;
}

/** 404: the page or product does not exist. */
export function NotFoundView({ area = "shop" }: { area?: Area }) {
  const cfg = useErrorPages();
  const router = useRouter();
  const [q, setQ] = useState("");
  const shop = area === "shop";
  return (
    <div className="flex flex-col gap-4">
      <Frame icon={<SearchX className="h-8 w-8" aria-hidden />} tone="info" title={shop ? cfg.not_found_title : "Page not found"} testId="not-found">
        <p className="mt-3 text-ink-soft">{shop ? cfg.not_found_message : "This page does not exist, or you followed an old link. Use the menu to find what you need."}</p>
        {shop && cfg.not_found_search && (
          <form role="search" className="mt-6 flex w-full max-w-md overflow-hidden rounded-xl border border-line bg-white focus-within:border-peacock focus-within:ring-2 focus-within:ring-peacock/20"
            onSubmit={(e) => { e.preventDefault(); if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`); }}>
            <label htmlFor="nf-search" className="sr-only">Search products</label>
            <input id="nf-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products" className="h-11 min-w-0 flex-1 bg-transparent px-4 text-[16px] focus:outline-none" />
            <button type="submit" className="flex w-12 items-center justify-center bg-marigold text-ink" aria-label="Search"><Search className="h-5 w-5" aria-hidden /></button>
          </form>
        )}
        <Link href={HOME[area].href} className="mt-6 inline-flex items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 font-semibold text-white hover:bg-peacock-dark">
          <Home className="h-4 w-4" aria-hidden /> {HOME[area].label}
        </Link>
      </Frame>
      {shop && cfg.not_found_suggestions && <Suggestions />}
    </div>
  );
}

/** An error boundary's page: what happened in plain words, a retry, and a reference to quote to support. */
export function ErrorView({ error, reset, area = "shop" }: { error: Error & { digest?: string }; reset?: () => void; area?: Area }) {
  const cfg = useErrorPages();
  const shop = area === "shop";
  useEffect(() => { console.error(error); }, [error]);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <Frame icon={<AlertTriangle className="h-8 w-8" aria-hidden />} tone="danger" title={offline ? "You are offline" : shop ? cfg.error_title : "This page could not load"} testId="error-page">
      <p className="mt-3 text-ink-soft">
        {offline ? "Check your internet connection, then try again." : shop ? cfg.error_message : "Try again. If it keeps happening, tell the team and quote the reference below."}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {reset && (
          <button type="button" onClick={reset} className="inline-flex items-center gap-2 rounded-lg bg-peacock px-4 py-2.5 font-semibold text-white hover:bg-peacock-dark">
            <RotateCcw className="h-4 w-4" aria-hidden /> Try again
          </button>
        )}
        <Link href={HOME[area].href} className="inline-flex items-center gap-2 rounded-lg border border-line bg-white px-4 py-2.5 font-semibold text-ink hover:bg-mist">
          <Home className="h-4 w-4" aria-hidden /> {HOME[area].label}
        </Link>
      </div>
      {error.digest && <p className="mt-5 text-xs text-ink-faint">Reference: <span className="font-mono select-all">{error.digest}</span></p>}
    </Frame>
  );
}
