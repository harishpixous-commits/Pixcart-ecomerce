"use client";

import { SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ProductGrid } from "@/components/product";
import { Button, EmptyState, Modal, PageLoader, Pagination, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { rupees, toPaise } from "@/lib/format";
import type { SearchResult } from "@/lib/types";

const SORTS = [
  ["relevance", "Relevance"],
  ["popular", "Popularity"],
  ["price_asc", "Price: low to high"],
  ["price_desc", "Price: high to low"],
  ["newest", "Newest first"],
  ["rating", "Customer rating"],
  ["discount", "Biggest discount"],
] as const;

function Filters({ data, params, set }: { data: SearchResult; params: URLSearchParams; set: (k: string, v: string | string[] | null) => void }) {
  const brands = params.getAll("brand");
  const [min, setMin] = useState(params.get("min_price") ? String(Number(params.get("min_price")) / 100) : "");
  const [max, setMax] = useState(params.get("max_price") ? String(Number(params.get("max_price")) / 100) : "");
  return (
    <div className="flex flex-col gap-6">
      {data.facets.brands.length > 0 && (
        <fieldset>
          <legend className="mb-2 font-semibold">Brand</legend>
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {data.facets.brands.map((b) => (
              <label key={b.name} className="flex cursor-pointer items-center gap-2 text-[15px]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-peacock"
                  checked={brands.includes(b.name)}
                  onChange={(e) => set("brand", e.target.checked ? [...brands, b.name] : brands.filter((x) => x !== b.name))}
                />
                {b.name} <span className="text-ink-faint">({b.count})</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-2 font-semibold">Price</legend>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const lo = min ? toPaise(min) : null;
            const hi = max ? toPaise(max) : null;
            set("min_price", lo !== null ? String(lo) : null);
            set("max_price", hi !== null ? String(hi) : null);
          }}
        >
          <input aria-label="Minimum price in rupees" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} placeholder="Min ₹" className="h-9 w-20 rounded-md border border-line px-2" />
          <span className="text-ink-faint">to</span>
          <input aria-label="Maximum price in rupees" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} placeholder="Max ₹" className="h-9 w-20 rounded-md border border-line px-2" />
          <Button size="sm" type="submit">Go</Button>
        </form>
        {data.facets.price_max > 0 && (
          <p className="mt-1 text-xs text-ink-faint">
            From {rupees(data.facets.price_min)} to {rupees(data.facets.price_max)}
          </p>
        )}
      </fieldset>
      <fieldset>
        <legend className="mb-2 font-semibold">Customer rating</legend>
        {["4", "3"].map((r) => (
          <label key={r} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input type="radio" name="rating" className="accent-peacock" checked={params.get("min_rating") === r} onChange={() => set("min_rating", r)} />
            {r}★ and above
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="mb-2 font-semibold">Discount</legend>
        {["50", "30", "10"].map((d) => (
          <label key={d} className="flex cursor-pointer items-center gap-2 py-0.5">
            <input type="radio" name="discount" className="accent-peacock" checked={params.get("min_discount") === d} onChange={() => set("min_discount", d)} />
            {d}% or more
          </label>
        ))}
      </fieldset>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" className="h-4 w-4 accent-peacock" checked={params.get("in_stock") === "true"} onChange={(e) => set("in_stock", e.target.checked ? "true" : null)} />
        Hide out of stock items
      </label>
    </div>
  );
}

export function SearchView({ category, seller }: { category?: string; seller?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [data, setData] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const key = sp.toString();

  useEffect(() => {
    const params = new URLSearchParams(key);
    setError(null);
    api<SearchResult>("/api/catalog/products", {
      query: {
        q: params.get("q"),
        category: category ?? params.get("category"),
        seller,
        brand: params.getAll("brand"),
        min_price: params.get("min_price"),
        max_price: params.get("max_price"),
        min_rating: params.get("min_rating"),
        min_discount: params.get("min_discount"),
        in_stock: params.get("in_stock"),
        sort: params.get("sort") ?? "relevance",
        page: params.get("page") ?? 1,
      },
    })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [key, category, seller]);

  function set(k: string, v: string | string[] | null) {
    const next = new URLSearchParams(key);
    next.delete(k);
    if (Array.isArray(v)) v.forEach((x) => next.append(k, x));
    else if (v) next.set(k, v);
    if (k !== "page") next.delete("page");
    router.push(`${pathname}?${next.toString()}`, { scroll: k === "page" });
  }

  if (error) return <EmptyState title="Search is unavailable right now" body={error} />;
  if (!data) return <PageLoader />;
  const q = sp.get("q");
  const heading = data.category?.name ?? (q ? `Results for “${q}”` : seller ? "Products from this store" : "All products");
  const activeFilters = ["brand", "min_price", "max_price", "min_rating", "min_discount", "in_stock"].some((k) => sp.get(k));

  return (
    <div className="flex flex-col gap-3">
      {data.breadcrumbs.length > 0 && (
        <nav className="text-sm text-ink-faint" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-peacock">Home</Link>
          {data.breadcrumbs.map((b) => (
            <span key={b.slug}>
              {" / "}
              <Link href={`/c/${b.slug}`} className="hover:text-peacock">{b.name}</Link>
            </span>
          ))}
        </nav>
      )}
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <aside className="hidden self-start rounded-xl bg-white p-4 lg:block">
          <h2 className="mb-4 text-lg font-semibold">Filters</h2>
          <Filters data={data} params={new URLSearchParams(key)} set={set} />
        </aside>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-3">
            <div>
              <h1 className="text-2xl font-semibold">{heading}</h1>
              <p className="text-sm text-ink-faint">{data.total.toLocaleString("en-IN")} products</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" className="lg:hidden" onClick={() => setShowFilters(true)}>
                <SlidersHorizontal className="h-4 w-4" /> Filters{activeFilters ? " (on)" : ""}
              </Button>
              <label className="sr-only" htmlFor="sort">Sort by</label>
              <Select id="sort" value={sp.get("sort") ?? "relevance"} onChange={(e) => set("sort", e.target.value)} className="h-9 w-auto text-sm">
                {SORTS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
            </div>
          </div>
          {data.items.length === 0 ? (
            <EmptyState
              title="No products match"
              body={activeFilters ? "Try removing a filter or two." : "Try a different word, or browse the categories above."}
              action={activeFilters ? <Button variant="secondary" onClick={() => router.push(q ? `${pathname}?q=${encodeURIComponent(q)}` : pathname)}>Clear filters</Button> : undefined}
            />
          ) : (
            <ProductGrid items={data.items} dense />
          )}
          <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={(p) => set("page", String(p))} />
        </div>
      </div>
      <Modal open={showFilters} onClose={() => setShowFilters(false)} title="Filters">
        <Filters data={data} params={new URLSearchParams(key)} set={(k, v) => { set(k, v); setShowFilters(false); }} />
      </Modal>
    </div>
  );
}
