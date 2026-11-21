"use client";

import clsx from "clsx";
import { MapPin, SlidersHorizontal, Truck, X, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CompareToggle } from "@/components/compare";
import { ProductRail, ProductTile } from "@/components/product";
import { Button, EmptyState, Modal, Pagination, Select } from "@/components/ui";
import { api, latestOnly } from "@/lib/api";
import { rupees, toPaise } from "@/lib/format";
import { isPincode, setPincode, usePincode } from "@/lib/pincode";
import type { ProductCard, SearchResult } from "@/lib/types";

type Result = SearchResult & { sponsored?: ProductCard[]; sponsored_rail?: ProductCard[]; categories?: { name: string; slug: string; count: number }[] };
/** Query changes applied together in one navigation; null removes the parameter. */
type QueryChanges = Record<string, string | string[] | null>;

const SORTS = [
  ["relevance", "Featured"],
  ["popular", "Best sellers"],
  ["price_asc", "Price: low to high"],
  ["price_desc", "Price: high to low"],
  ["rating", "Avg. customer review"],
  ["newest", "Newest arrivals"],
  ["discount", "Biggest discount"],
] as const;

function PinInline() {
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  return (
    <form className="flex flex-col gap-1" onSubmit={(e) => { e.preventDefault(); if (!isPincode(v)) return setErr("Enter a 6-digit PIN code"); setPincode(v); }}>
      <span className="flex items-center gap-1 text-sm text-ink-soft"><MapPin className="h-4 w-4" /> Enter your PIN code to see delivery days</span>
      <span className="flex gap-2">
        <input inputMode="numeric" maxLength={6} value={v} onChange={(e) => { setV(e.target.value.replace(/\D/g, "")); setErr(""); }} aria-label="PIN code" placeholder="PIN code" className="h-9 w-28 rounded-md border border-line px-2" />
        <Button size="sm" type="submit" variant="secondary">Apply</Button>
      </span>
      {err && <span className="text-xs text-vermilion">{err}</span>}
    </form>
  );
}

function Filters({ data, params, set, inCategory }: { data: Result; params: URLSearchParams; set: (changes: QueryChanges) => void; inCategory: boolean }) {
  const pin = usePincode();
  const brands = params.getAll("brand");
  const [min, setMin] = useState(params.get("min_price") ? String(Number(params.get("min_price")) / 100) : "");
  const [max, setMax] = useState(params.get("max_price") ? String(Number(params.get("max_price")) / 100) : "");
  const delivery = params.get("delivery");
  return (
    <div className="flex flex-col gap-6">
      <fieldset>
        <legend className="mb-2 flex items-center gap-1.5 font-semibold"><Truck className="h-4 w-4 text-peacock" /> Delivery day</legend>
        {pin ? (
          <>
            {[["1", "Get it by tomorrow"], ["2", "Get it in 2 days"], ["4", "Get it in 4 days"]].map(([d, label]) => (
              <label key={d} className="flex cursor-pointer items-center gap-2 py-0.5">
                <input type="checkbox" className="h-4 w-4 accent-peacock" checked={delivery === d} onChange={(e) => set({ delivery: e.target.checked ? d : null })} /> {label}
              </label>
            ))}
            <p className="mt-1 text-xs text-ink-faint">To PIN {pin}</p>
          </>
        ) : <PinInline />}
      </fieldset>
      <label className="flex cursor-pointer items-center gap-2 font-semibold">
        <input type="checkbox" className="h-4 w-4 accent-peacock" checked={params.get("deal") === "true"} onChange={(e) => set({ deal: e.target.checked ? "true" : null })} />
        <Zap className="h-4 w-4 text-vermilion" /> Today&apos;s deals
      </label>
      {!inCategory && (data.categories?.length ?? 0) > 0 && (
        <fieldset>
          <legend className="mb-2 font-semibold">Department</legend>
          <div className="flex flex-col gap-1">
            {data.categories!.map((c) => (
              <button key={c.slug} type="button" onClick={() => set({ category: params.get("category") === c.slug ? null : c.slug })}
                className={clsx("text-left text-[15px] hover:text-peacock", params.get("category") === c.slug && "font-semibold text-peacock")}>
                {c.name} <span className="text-ink-faint">({c.count})</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {data.facets.brands.length > 0 && (
        <fieldset>
          <legend className="mb-2 font-semibold">Brand</legend>
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {data.facets.brands.map((b) => (
              <label key={b.name} className="flex cursor-pointer items-center gap-2 text-[15px]">
                <input type="checkbox" className="h-4 w-4 accent-peacock" checked={brands.includes(b.name)}
                  onChange={(e) => set({ brand: e.target.checked ? [...brands, b.name] : brands.filter((x) => x !== b.name) })} />
                {b.name} <span className="text-ink-faint">({b.count})</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-2 font-semibold">Price</legend>
        <form className="flex items-center gap-2" onSubmit={(e) => {
          e.preventDefault();
          const lo = min ? toPaise(min) : null;
          const hi = max ? toPaise(max) : null;
          set({ min_price: lo !== null ? String(lo) : null, max_price: hi !== null ? String(hi) : null });
        }}>
          <input aria-label="Minimum price in rupees" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} placeholder="Min ₹" className="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
          <span className="text-ink-faint">to</span>
          <input aria-label="Maximum price in rupees" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} placeholder="Max ₹" className="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
          <Button size="sm" type="submit">Go</Button>
        </form>
        {data.facets.price_max > 0 && <p className="mt-1 text-xs text-ink-faint">From {rupees(data.facets.price_min)} to {rupees(data.facets.price_max)}</p>}
      </fieldset>
      <fieldset>
        <legend className="mb-2 font-semibold">Customer reviews</legend>
        {["4", "3"].map((r) => (
          <label key={r} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input type="radio" name="rating" className="accent-peacock" checked={params.get("min_rating") === r} onChange={() => set({ min_rating: r })} />
            {r}★ &amp; up
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="mb-2 font-semibold">Discount</legend>
        {["10", "25", "50", "70"].map((d) => (
          <label key={d} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input type="radio" name="discount" className="accent-peacock" checked={params.get("min_discount") === d} onChange={() => set({ min_discount: d })} />
            {d}% off or more
          </label>
        ))}
      </fieldset>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" className="h-4 w-4 accent-peacock" checked={params.get("in_stock") === "true"} onChange={(e) => set({ in_stock: e.target.checked ? "true" : null })} />
        Hide out of stock items
      </label>
    </div>
  );
}

function ResultGrid({ items }: { items: ProductCard[] }) {
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line sm:grid-cols-3 lg:grid-cols-4" data-testid="search-results">
      {items.map((p, i) => (
        <div key={`${p.id}-${i}`} className="flex flex-col bg-white">
          <div className="flex-1"><ProductTile p={p} showAdd /></div>
          <div className="px-3 pb-3 sm:px-4"><CompareToggle item={{ id: p.id, slug: p.slug, title: p.title, image: p.image }} /></div>
        </div>
      ))}
    </div>
  );
}

export function SearchView({ category, seller }: { category?: string; seller?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const pin = usePincode();
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const track = useMemo(() => latestOnly(), []);
  const key = sp.toString();
  const fetchKey = `${key}|${category ?? ""}|${seller ?? ""}|${pin}`;

  useEffect(() => {
    const params = new URLSearchParams(key);
    track(api<Result>("/api/catalog/products", {
      query: {
        q: params.get("q"), category: category ?? params.get("category"), seller, brand: params.getAll("brand"),
        min_price: params.get("min_price"), max_price: params.get("max_price"), min_rating: params.get("min_rating"), min_discount: params.get("min_discount"),
        in_stock: params.get("in_stock"), deal: params.get("deal"), pincode: pin || undefined, delivery: pin ? params.get("delivery") : undefined,
        sort: params.get("sort") ?? "relevance", page: params.get("page") ?? 1,
      },
    }), setData).catch((e: Error) => setError({ key: fetchKey, message: e.message }));
    // fetchKey covers every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, track]);

  // Every change goes into one navigation: two pushes would each start from the current query, and the last would win.
  function set(changes: QueryChanges) {
    const next = new URLSearchParams(key);
    for (const [k, v] of Object.entries(changes)) {
      next.delete(k);
      if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
      else if (v) next.set(k, v);
    }
    const paging = "page" in changes;
    if (!paging) next.delete("page");
    router.push(`${pathname}?${next.toString()}`, { scroll: paging });
  }

  if (error && error.key === fetchKey) return <EmptyState title="Search is unavailable right now" body={error.message} />;
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading results">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="rounded-xl bg-white p-3"><div className="skeleton mb-3 aspect-square rounded-lg" /><div className="skeleton mb-2 h-4 rounded" /><div className="skeleton h-4 w-1/2 rounded" /></div>)}
      </div>
    );
  }
  const q = sp.get("q");
  const from = data.total ? (data.page - 1) * data.page_size + 1 : 0;
  const to = Math.min(data.total, data.page * data.page_size);
  const heading = data.category?.name ?? (seller ? "Products from this store" : q ? null : "All products");
  const filterKeys = ["brand", "min_price", "max_price", "min_rating", "min_discount", "in_stock", "deal", "delivery", ...(category ? [] : ["category"])];
  const activeFilters = filterKeys.some((k) => sp.get(k));
  const sponsored = data.page === 1 ? data.sponsored ?? [] : [];
  const seen = new Set(sponsored.map((p) => p.id));
  const results = [...sponsored, ...data.items.filter((p) => !seen.has(p.id))];
  const shownIds = new Set(results.map((p) => p.id));
  const railItems = (data.sponsored_rail ?? []).filter((p) => !shownIds.has(p.id));
  const params = new URLSearchParams(key);
  const paise = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);
  const lo = paise(sp.get("min_price"));
  const hi = paise(sp.get("max_price"));
  const priceLabel = lo !== null && hi !== null ? `${rupees(lo)} to ${rupees(hi)}` : lo !== null ? `${rupees(lo)} and above` : hi !== null ? `Up to ${rupees(hi)}` : null;
  const priceKey = `${lo}-${hi}`; // the price boxes start again from the applied range when a chip or Clear all changes it

  return (
    <div className="flex flex-col gap-3">
      {data.breadcrumbs.length > 0 && (
        <nav className="text-sm text-ink-faint" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-peacock">Home</Link>
          {data.breadcrumbs.map((b) => <span key={b.slug}> › <Link href={`/c/${b.slug}`} className="hover:text-peacock">{b.name}</Link></span>)}
        </nav>
      )}
      <div className="grid gap-4 lg:grid-cols-[250px_1fr]">
        <aside className="hidden self-start rounded-xl bg-white p-4 lg:sticky lg:top-40 lg:block" aria-label="Filters">
          <h2 className="mb-4 text-lg font-semibold">Filters</h2>
          <Filters key={priceKey} data={data} params={params} set={set} inCategory={Boolean(category)} />
        </aside>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-3">
            <div className="min-w-0">
              {heading && <h1 className="text-2xl font-semibold">{heading}</h1>}
              <p className={clsx(heading ? "text-sm text-ink-faint" : "text-[15px]")} data-testid="results-count">
                {data.total ? `${from}-${to} of ${data.total.toLocaleString("en-IN")} results` : "No results"}
                {q && <> for <span className="font-semibold text-vermilion">&ldquo;{q}&rdquo;</span></>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" className="lg:hidden" onClick={() => setShowFilters(true)}>
                <SlidersHorizontal className="h-4 w-4" /> Filters{activeFilters ? " (on)" : ""}
              </Button>
              <label className="sr-only" htmlFor="sort">Sort by</label>
              <Select id="sort" value={sp.get("sort") ?? "relevance"} onChange={(e) => set({ sort: e.target.value })} className="h-9 w-auto text-sm">
                {SORTS.map(([v, l]) => <option key={v} value={v}>Sort by: {l}</option>)}
              </Select>
            </div>
          </div>
          {!category && (data.categories?.length ?? 0) > 1 && (
            <div className="scroll-x flex gap-2 overflow-x-auto" aria-label="Departments">
              {data.categories!.map((c) => (
                <button key={c.slug} type="button" onClick={() => set({ category: sp.get("category") === c.slug ? null : c.slug })} aria-pressed={sp.get("category") === c.slug}
                  className={clsx("shrink-0 rounded-full border px-3 py-1 text-sm", sp.get("category") === c.slug ? "border-peacock bg-peacock text-white" : "border-line bg-white hover:border-peacock")}>
                  {c.name} <span className={sp.get("category") === c.slug ? "text-white/80" : "text-ink-faint"}>({c.count})</span>
                </button>
              ))}
            </div>
          )}
          {activeFilters && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {sp.get("deal") && <Chip label="Today's deals" onClear={() => set({ deal: null })} />}
              {sp.get("delivery") && <Chip label={sp.get("delivery") === "1" ? "Get it by tomorrow" : `Get it in ${sp.get("delivery")} days`} onClear={() => set({ delivery: null })} />}
              {params.getAll("brand").map((b) => <Chip key={b} label={b} onClear={() => set({ brand: params.getAll("brand").filter((x) => x !== b) })} />)}
              {priceLabel && <Chip label={priceLabel} onClear={() => set({ min_price: null, max_price: null })} />}
              {sp.get("min_rating") && <Chip label={`${sp.get("min_rating")}★ & up`} onClear={() => set({ min_rating: null })} />}
              {sp.get("min_discount") && <Chip label={`${sp.get("min_discount")}% off or more`} onClear={() => set({ min_discount: null })} />}
              <button type="button" onClick={() => router.push(q ? `${pathname}?q=${encodeURIComponent(q)}` : pathname)} className="font-semibold text-peacock hover:underline">Clear all</button>
            </div>
          )}
          {results.length === 0 ? (
            <EmptyState title="No products match"
              body={activeFilters ? "Try removing a filter or two." : "Try a different word, or browse the categories above."}
              action={activeFilters ? <Button variant="secondary" onClick={() => router.push(q ? `${pathname}?q=${encodeURIComponent(q)}` : pathname)}>Clear filters</Button> : undefined} />
          ) : <ResultGrid items={results} />}
          <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={(p) => set({ page: String(p) })} />
          {data.page === 1 && railItems.length > 0 && (
            <ProductRail title={q ? "Sponsored products related to your search" : "Sponsored products"} items={railItems} note="Sponsored" />
          )}
        </div>
      </div>
      <Modal open={showFilters} onClose={() => setShowFilters(false)} title="Filters">
        <Filters key={priceKey} data={data} params={params} set={(changes) => { set(changes); setShowFilters(false); }} inCategory={Boolean(category)} />
      </Modal>
    </div>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-peacock-light py-1 pl-3 pr-1 text-peacock">
      {label}
      <button type="button" onClick={onClear} aria-label={`Remove filter ${label}`} className="rounded-full p-0.5 hover:bg-white"><X className="h-3.5 w-3.5" /></button>
    </span>
  );
}
