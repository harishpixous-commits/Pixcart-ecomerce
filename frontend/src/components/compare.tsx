"use client";

/*
 * Compare products: shoppers tick "Compare" on product cards or the product page (up to 4, kept in this browser), a tray
 * at the bottom shows the picks, and /compare puts them side by side. Switched on or off in Admin → Product page.
 */

import clsx from "clsx";
import { Scale, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { useSite } from "@/lib/site";

export type CompareItem = { id: string; slug: string; title: string; image: string };

const KEY = "pc_compare_v1";
export const COMPARE_MAX = 4;
const listeners = new Set<() => void>();
const EMPTY = "[]";

function readRaw(): string {
  try {
    return localStorage.getItem(KEY) ?? EMPTY;
  } catch {
    return EMPTY;
  }
}

function write(items: CompareItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, COMPARE_MAX)));
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) cb(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

function parse(raw: string): CompareItem[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function useCompare() {
  const raw = useSyncExternalStore(subscribe, readRaw, () => EMPTY);
  const items = parse(raw);
  return {
    items,
    has: (id: string) => items.some((x) => x.id === id),
    full: items.length >= COMPARE_MAX,
    toggle: (item: CompareItem) => {
      const cur = parse(readRaw());
      write(cur.some((x) => x.id === item.id) ? cur.filter((x) => x.id !== item.id) : [...cur, item].slice(-COMPARE_MAX));
    },
    remove: (id: string) => write(parse(readRaw()).filter((x) => x.id !== id)),
    clear: () => write([]),
  };
}

/** A small "Compare" checkbox for a product card or the product page. */
export function CompareToggle({ item, className }: { item: CompareItem; className?: string }) {
  const site = useSite();
  const c = useCompare();
  if (site.features.compare === false) return null;
  const on = c.has(item.id);
  return (
    <label className={clsx("inline-flex cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-ink-soft", className)} data-testid="compare-toggle">
      <input type="checkbox" className="h-3.5 w-3.5 accent-peacock" checked={on} disabled={!on && c.full}
        onChange={() => c.toggle(item)} aria-label={`Compare ${item.title}`} />
      {on ? "Added to compare" : c.full ? `Compare (max ${COMPARE_MAX})` : "Add to compare"}
    </label>
  );
}

/** The tray at the bottom of the store while products are picked for comparison. */
export function CompareTray() {
  const site = useSite();
  const pathname = usePathname();
  const c = useCompare();
  const visible = site.features.compare !== false && c.items.length > 0 && !pathname.startsWith("/compare");
  // lets the help button move up so the tray never covers it (see globals.css)
  useEffect(() => {
    if (!visible) return;
    document.body.dataset.compareTray = "1";
    return () => { delete document.body.dataset.compareTray; };
  }, [visible]);
  if (!visible) return null;
  const ids = c.items.map((x) => x.id).join(",");
  return (
    <div className="compare-tray fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-30 border-t border-line bg-white/95 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur sm:bottom-0"
      role="region" aria-label="Products to compare" data-testid="compare-tray">
      <div className="mx-auto flex max-w-shop items-center gap-3 px-3 py-2 sm:px-4">
        <Scale className="hidden h-5 w-5 shrink-0 text-peacock sm:block" />
        <div className="scroll-x flex min-w-0 flex-1 gap-2 overflow-x-auto">
          {c.items.map((x) => (
            <span key={x.id} className="relative flex shrink-0 items-center gap-2 rounded-lg border border-line bg-white py-1 pl-1 pr-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={x.image} alt="" className="h-9 w-9 rounded object-contain" />
              <span className="hidden max-w-[140px] truncate text-xs md:block">{x.title}</span>
              <button type="button" onClick={() => c.remove(x.id)} aria-label={`Remove ${x.title} from compare`} className="absolute right-1 top-1 rounded-full p-0.5 hover:bg-mist">
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
        <button type="button" onClick={c.clear} className="shrink-0 text-sm text-ink-soft hover:text-vermilion">Clear</button>
        <Link href={`/compare?ids=${ids}`} aria-disabled={c.items.length < 2}
          className={clsx("shrink-0 rounded-full px-4 py-2 text-sm font-semibold", c.items.length < 2 ? "pointer-events-none bg-mist text-ink-faint" : "bg-peacock text-white hover:bg-peacock-dark")}>
          Compare ({c.items.length})
        </Link>
      </div>
    </div>
  );
}
