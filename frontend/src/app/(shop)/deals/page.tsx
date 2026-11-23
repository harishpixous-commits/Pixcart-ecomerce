"use client";

import clsx from "clsx";
import { Clock, Percent, SlidersHorizontal, Star, X, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ProductTile } from "@/components/product";
import { Pagination, Select } from "@/components/ui";
import { api, latestOnly, quietly } from "@/lib/api";
import { currencySymbol, paiseToShown, shownToPaise } from "@/lib/format";
import type { ProductCard } from "@/lib/types";

type DealsData = {
  items: ProductCard[]; total: number; page: number; page_size: number; tab: "live" | "upcoming" | "discounts"; enabled: boolean;
  facets: { departments?: { name: string; slug: string; count: number }[]; kinds?: Record<string, number>; upcoming?: number };
};

const PILLS: { key: string; label: string; tab: string; kind?: string; icon?: typeof Zap }[] = [
  { key: "all", label: "All deals", tab: "live" },
  { key: "lightning", label: "Lightning deals", tab: "live", kind: "lightning", icon: Zap },
  { key: "deal_of_day", label: "Deal of the Day", tab: "live", kind: "deal_of_day" },
  { key: "limited", label: "Limited time deals", tab: "live", kind: "limited" },
  { key: "upcoming", label: "Upcoming", tab: "upcoming", icon: Clock },
  { key: "discounts", label: "Top discounts", tab: "discounts", icon: Percent },
];

function DealsPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [data, setData] = useState<DealsData | null>(null);
  const [drawer, setDrawer] = useState(false);
  const track = useMemo(() => latestOnly(), []);
  const key = sp.toString();
  const tab = sp.get("tab") ?? "live";
  const kind = sp.get("kind") ?? "";
  const category = sp.get("category") ?? "";
  const minDiscount = sp.get("min_discount") ?? "";
  const minRating = sp.get("min_rating") ?? "";
  const sort = sp.get("sort") ?? "featured";
  const page = Number(sp.get("page") ?? 1);
  const [price, setPrice] = useState({ min: sp.get("min_price") ? paiseToShown(Number(sp.get("min_price"))) : "", max: sp.get("max_price") ? paiseToShown(Number(sp.get("max_price"))) : "" });
  const sym = currencySymbol();

  useEffect(() => {
    const q = new URLSearchParams(key);
    track(api<DealsData>("/api/catalog/deals", {
      query: { tab: q.get("tab") ?? "live", kind: q.get("kind") || undefined, category: q.get("category") || undefined, min_discount: q.get("min_discount") || undefined,
        min_rating: q.get("min_rating") || undefined, min_price: q.get("min_price") || undefined, max_price: q.get("max_price") || undefined,
        sort: q.get("sort") ?? "featured", page: q.get("page") ?? 1 },
    }), setData).catch(quietly);
  }, [key, track]);

  function set(changes: Record<string, string | null>) {
    const q = new URLSearchParams(key);
    for (const [k, v] of Object.entries(changes)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    if (!("page" in changes)) q.delete("page");
    router.push(`${pathname}?${q.toString()}`, { scroll: false });
  }
  const activePill = tab === "upcoming" ? "upcoming" : tab === "discounts" ? "discounts" : kind || "all";
  const kinds = data?.facets.kinds ?? {};
  const pillCount = (k: string) => (k === "upcoming" ? data?.facets.upcoming : k in kinds ? kinds[k] : undefined);

  const filters = (
    <div className="flex flex-col gap-5 text-[15px]">
      {(data?.facets.departments?.length ?? 0) > 0 && (
        <fieldset>
          <legend className="mb-2 font-semibold">Department</legend>
          {[{ name: "All", slug: "", count: 0 }, ...(data?.facets.departments ?? [])].map((d) => (
            <label key={d.slug || "all"} className="flex cursor-pointer items-center gap-2 py-1">
              <input type="radio" name="dept" className="accent-peacock" checked={category === d.slug} onChange={() => set({ category: d.slug || null })} />
              <span>{d.name}</span>{d.count > 0 && <span className="text-xs text-ink-faint">({d.count})</span>}
            </label>
          ))}
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-2 font-semibold">Discount</legend>
        {[["", "Any"], ["10", "10% off or more"], ["25", "25% off or more"], ["50", "50% off or more"], ["70", "70% off or more"]].map(([v, label]) => (
          <label key={v || "any"} className="flex cursor-pointer items-center gap-2 py-1">
            <input type="radio" name="disc" className="accent-peacock" checked={minDiscount === v} onChange={() => set({ min_discount: v || null })} /> {label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="mb-2 font-semibold">Customer reviews</legend>
        <label className="flex cursor-pointer items-center gap-2 py-1">
          <input type="checkbox" className="accent-peacock" checked={minRating === "4"} onChange={(e) => set({ min_rating: e.target.checked ? "4" : null })} />
          <span className="flex items-center gap-0.5 text-marigold">{[1, 2, 3, 4].map((n) => <Star key={n} className="h-4 w-4 fill-current" />)}<Star className="h-4 w-4" /></span>
          <span>&amp; up</span>
        </label>
      </fieldset>
      <fieldset>
        <legend className="mb-2 font-semibold">Price</legend>
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); set({ min_price: price.min ? String(shownToPaise(price.min) ?? "") || null : null, max_price: price.max ? String(shownToPaise(price.max) ?? "") || null : null }); setDrawer(false); }}>
          <input inputMode="numeric" aria-label="Minimum price" placeholder={`${sym} Min`} value={price.min} onChange={(e) => setPrice({ ...price, min: e.target.value.replace(/[^\d.]/g, "") })} className="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
          <span>to</span>
          <input inputMode="numeric" aria-label="Maximum price" placeholder={`${sym} Max`} value={price.max} onChange={(e) => setPrice({ ...price, max: e.target.value.replace(/[^\d.]/g, "") })} className="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
          <button type="submit" className="h-9 rounded-md border border-line px-3 font-semibold hover:bg-mist">Go</button>
        </form>
      </fieldset>
      {(category || minDiscount || minRating || sp.get("min_price") || sp.get("max_price")) && (
        <button type="button" onClick={() => { setPrice({ min: "", max: "" }); set({ category: null, min_discount: null, min_rating: null, min_price: null, max_price: null }); }}
          className="self-start text-sm font-semibold text-peacock hover:underline">Clear all filters</button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2 px-1">
        <div>
          <h1 className="text-2xl font-semibold sm:text-3xl">Today&apos;s Deals</h1>
          <p className="text-ink-soft">Lightning deals, deals of the day and limited time offers from verified sellers. Prices change when a deal ends.</p>
        </div>
      </div>
      <nav className="scroll-x -mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Kinds of deals">
        {PILLS.map((p) => {
          const n = pillCount(p.key);
          const Icon = p.icon;
          return (
            <button key={p.key} type="button" onClick={() => set({ tab: p.tab === "live" ? null : p.tab, kind: p.kind ?? null })} aria-pressed={activePill === p.key}
              className={clsx("flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold", activePill === p.key ? "border-peacock bg-peacock text-white" : "border-line bg-white hover:border-peacock")}>
              {Icon && <Icon className="h-4 w-4" />}{p.label}{n !== undefined && <span className={activePill === p.key ? "text-white/80" : "text-ink-faint"}>({n})</span>}
            </button>
          );
        })}
      </nav>
      <div className="grid gap-4 lg:grid-cols-[230px_1fr]">
        <aside className="hidden self-start rounded-xl bg-white p-4 lg:sticky lg:top-40 lg:block" aria-label="Filters">{filters}</aside>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-4 py-2.5">
            <p className="text-sm text-ink-soft">{data ? `${data.total.toLocaleString("en-IN")} ${tab === "upcoming" ? "upcoming deals" : tab === "discounts" ? "discounted products" : "deals"}` : "Loading deals…"}</p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setDrawer(true)} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold lg:hidden"><SlidersHorizontal className="h-4 w-4" /> Filters</button>
              {tab !== "upcoming" && (
                <>
                  <label htmlFor="deal-sort" className="sr-only">Sort deals</label>
                  <Select id="deal-sort" value={sort} onChange={(e) => set({ sort: e.target.value === "featured" ? null : e.target.value })} className="h-9 w-auto text-sm">
                    <option value="featured">Featured</option>
                    {tab === "live" && <option value="ending">Ending soonest</option>}
                    <option value="discount">Discount: high to low</option>
                    <option value="price_asc">Price: low to high</option>
                    <option value="price_desc">Price: high to low</option>
                    <option value="rating">Customer rating</option>
                  </Select>
                </>
              )}
            </div>
          </div>
          {!data ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" aria-busy="true">
              {Array.from({ length: 8 }, (_, i) => <div key={i} className="rounded-xl bg-white p-3"><div className="skeleton mb-3 aspect-square rounded-lg" /><div className="skeleton mb-2 h-4 rounded" /><div className="skeleton h-4 w-1/2 rounded" /></div>)}
            </div>
          ) : !data.enabled && tab !== "discounts" ? (
            <div className="rounded-xl bg-white p-8 text-center">
              <p className="text-lg font-semibold">Deals are not running on the store right now</p>
              <button type="button" onClick={() => set({ tab: "discounts", kind: null })} className="mt-2 font-semibold text-peacock hover:underline">See the top discounts instead</button>
            </div>
          ) : data.items.length === 0 ? (
            <div className="rounded-xl bg-white p-8 text-center">
              <p className="text-lg font-semibold">{tab === "upcoming" ? "No deals are scheduled for the next 7 days" : "No deals match these filters"}</p>
              <p className="mt-1 text-ink-soft">Try another department or discount, or browse the biggest price drops.</p>
              <div className="mt-3 flex justify-center gap-3">
                <button type="button" onClick={() => set({ category: null, min_discount: null, min_rating: null, min_price: null, max_price: null, kind: null, tab: null })} className="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:bg-mist">All deals</button>
                <button type="button" onClick={() => set({ tab: "discounts", kind: null })} className="rounded-full bg-peacock px-4 py-2 text-sm font-semibold text-white">Top discounts</button>
              </div>
            </div>
          ) : (
            <div className="grid gap-px overflow-hidden rounded-xl bg-line sm:grid-cols-3 xl:grid-cols-4 grid-cols-2" data-testid="deals-grid">
              {data.items.map((p) => <ProductTile key={p.id} p={p} quickPlus />)}
            </div>
          )}
          {data && data.total > data.page_size && <Pagination page={page} pageSize={data.page_size} total={data.total} onPage={(n) => set({ page: String(n) })} />}
          <p className="px-1 text-xs text-ink-faint">Deal prices are set by sellers and checked by our team. A deal price applies while the timer runs (lightning deals: while units last). <Link href="/coupons" className="font-semibold text-peacock">See coupons</Link></p>
        </div>
      </div>
      {drawer && (
        <div className="fixed inset-0 z-[60] flex lg:hidden" role="dialog" aria-modal="true" aria-label="Filters">
          <div className="absolute inset-0 bg-ink/50" onClick={() => setDrawer(false)} />
          <div className="relative ml-auto h-full w-[85%] max-w-sm overflow-y-auto bg-white p-5">
            <div className="mb-4 flex items-center justify-between"><p className="text-lg font-semibold">Filters</p><button type="button" onClick={() => setDrawer(false)} aria-label="Close filters"><X className="h-5 w-5" /></button></div>
            {filters}
            <button type="button" onClick={() => setDrawer(false)} className="mt-6 w-full rounded-full bg-peacock py-2.5 font-semibold text-white">Show results</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <DealsPage />
    </Suspense>
  );
}
