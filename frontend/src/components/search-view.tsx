"use client";

/*
 * Search, category and store results. Filters sit in a left column or in a bar on top with drop-downs (the theme's
 * "filters" layout option); the results follow the theme's product grid. Every filter lives in the address, so a
 * filtered page can be shared, bookmarked and reloaded.
 */

import clsx from "clsx";
import { ChevronDown, MapPin, SlidersHorizontal, Truck, X, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CompareToggle } from "@/components/compare";
import { GridFrame, ProductRail, ProductTile } from "@/components/product";
import { SaveSearchButton } from "@/components/save-search";
import { ListingSkeleton } from "@/components/skeletons";
import { Button, EmptyState, Modal, Pagination, Select } from "@/components/ui";
import { api, latestOnly } from "@/lib/api";
import { currencySymbol, paiseToShown, rupees, shownToPaise } from "@/lib/format";
import { isPincode, setPincode, usePincode } from "@/lib/pincode";
import type { ProductCard, SearchResult } from "@/lib/types";
import { useLayout } from "@/themes/context";

type Result = SearchResult & { sponsored?: ProductCard[]; sponsored_rail?: ProductCard[]; categories?: { name: string; slug: string; count: number }[] };
/** Query changes applied together in one navigation; null removes the parameter. */
type QueryChanges = Record<string, string | string[] | null>;
type FilterProps = { data: Result; params: URLSearchParams; set: (changes: QueryChanges) => void; inCategory: boolean };

const SORTS = [
  ["relevance", "Featured"],
  ["popular", "Best sellers"],
  ["price_asc", "Price: low to high"],
  ["price_desc", "Price: high to low"],
  ["rating", "Avg. customer review"],
  ["newest", "Newest arrivals"],
  ["discount", "Biggest discount"],
] as const;

const DELIVERY = [["1", "Get it by tomorrow"], ["2", "Get it in 2 days"], ["4", "Get it in 4 days"]] as const;

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

/* ---------------------------------------------------------------- filter sections (used by the column, the drawer and the bar) */

function DeliveryFilter({ params, set }: FilterProps) {
  const pin = usePincode();
  const delivery = params.get("delivery");
  if (!pin) return <PinInline />;
  return (
    <div className="flex flex-col">
      {DELIVERY.map(([d, label]) => (
        <label key={d} className="flex cursor-pointer items-center gap-2 py-0.5">
          <input type="checkbox" className="h-4 w-4 accent-peacock" checked={delivery === d} onChange={(e) => set({ delivery: e.target.checked ? d : null })} /> {label}
        </label>
      ))}
      <p className="mt-1 text-xs text-ink-faint">To PIN {pin}</p>
    </div>
  );
}

function DepartmentFilter({ data, params, set }: FilterProps) {
  return (
    <div className="flex flex-col gap-1">
      {data.categories!.map((c) => (
        <button key={c.slug} type="button" onClick={() => set({ category: params.get("category") === c.slug ? null : c.slug })}
          className={clsx("text-left text-[15px] hover:text-peacock", params.get("category") === c.slug && "font-semibold text-peacock")}>
          {c.name} <span className="text-ink-faint">({c.count})</span>
        </button>
      ))}
    </div>
  );
}

function BrandFilter({ data, params, set }: FilterProps) {
  const brands = params.getAll("brand");
  return (
    <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
      {data.facets.brands.map((b) => (
        <label key={b.name} className="flex cursor-pointer items-center gap-2 text-[15px]">
          <input type="checkbox" className="h-4 w-4 accent-peacock" checked={brands.includes(b.name)}
            onChange={(e) => set({ brand: e.target.checked ? [...brands, b.name] : brands.filter((x) => x !== b.name) })} />
          {b.name} <span className="text-ink-faint">({b.count})</span>
        </label>
      ))}
    </div>
  );
}

function PriceFilter({ data, params, set }: FilterProps) {
  const [min, setMin] = useState(params.get("min_price") ? paiseToShown(Number(params.get("min_price"))) : "");
  const [max, setMax] = useState(params.get("max_price") ? paiseToShown(Number(params.get("max_price"))) : "");
  const sym = currencySymbol();
  return (
    <div>
      <form className="flex items-center gap-2" onSubmit={(e) => {
        e.preventDefault();
        const lo = min ? shownToPaise(min) : null;
        const hi = max ? shownToPaise(max) : null;
        set({ min_price: lo !== null ? String(lo) : null, max_price: hi !== null ? String(hi) : null });
      }}>
        <input aria-label="Minimum price" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder={`Min ${sym}`} className="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
        <span className="text-ink-faint">to</span>
        <input aria-label="Maximum price" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} placeholder={`Max ${sym}`} className="h-9 min-w-0 flex-1 rounded-md border border-line px-2" />
        <Button size="sm" type="submit">Go</Button>
      </form>
      {data.facets.price_max > 0 && <p className="mt-1 text-xs text-ink-faint">From {rupees(data.facets.price_min)} to {rupees(data.facets.price_max)}</p>}
    </div>
  );
}

function RatingFilter({ params, set }: FilterProps) {
  return (
    <div className="flex flex-col">
      {["4", "3"].map((r) => (
        <label key={r} className="flex cursor-pointer items-center gap-2 py-0.5">
          <input type="radio" name="rating" className="accent-peacock" checked={params.get("min_rating") === r} onChange={() => set({ min_rating: r })} />
          {r}★ &amp; up
        </label>
      ))}
    </div>
  );
}

function DiscountFilter({ params, set }: FilterProps) {
  return (
    <div className="flex flex-col">
      {["10", "25", "50", "70"].map((d) => (
        <label key={d} className="flex cursor-pointer items-center gap-2 py-0.5">
          <input type="radio" name="discount" className="accent-peacock" checked={params.get("min_discount") === d} onChange={() => set({ min_discount: d })} />
          {d}% off or more
        </label>
      ))}
    </div>
  );
}

/** Every filter stacked: the left column, and the Filters drawer. */
function Filters(p: FilterProps) {
  const { data, params, set, inCategory } = p;
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="min-w-0">
        <legend className="mb-2 flex items-center gap-1.5 font-semibold"><Truck className="h-4 w-4 text-peacock" /> Delivery day</legend>
        <DeliveryFilter {...p} />
      </fieldset>
      <label className="flex cursor-pointer items-center gap-2 font-semibold">
        <input type="checkbox" className="h-4 w-4 accent-peacock" checked={params.get("deal") === "true"} onChange={(e) => set({ deal: e.target.checked ? "true" : null })} />
        <Zap className="h-4 w-4 text-vermilion" /> Today&apos;s deals
      </label>
      {!inCategory && (data.categories?.length ?? 0) > 0 && (
        <fieldset className="min-w-0">
          <legend className="mb-2 font-semibold">Department</legend>
          <DepartmentFilter {...p} />
        </fieldset>
      )}
      {data.facets.brands.length > 0 && (
        <fieldset className="min-w-0">
          <legend className="mb-2 font-semibold">Brand</legend>
          <BrandFilter {...p} />
        </fieldset>
      )}
      <fieldset className="min-w-0">
        <legend className="mb-2 font-semibold">Price</legend>
        <PriceFilter {...p} />
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="mb-2 font-semibold">Customer reviews</legend>
        <RatingFilter {...p} />
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="mb-2 font-semibold">Discount</legend>
        <DiscountFilter {...p} />
      </fieldset>
      <label className="flex cursor-pointer items-center gap-2">
        <input type="checkbox" className="h-4 w-4 accent-peacock" checked={params.get("in_stock") === "true"} onChange={(e) => set({ in_stock: e.target.checked ? "true" : null })} />
        Hide out of stock items
      </label>
    </div>
  );
}

/* ---------------------------------------------------------------- the bar on top */

/** A filter button with a drop-down panel (closes on Escape, a click outside, or choosing). */
function FilterMenu({ label, active, children }: { label: string; active?: boolean; children: React.ReactNode }) {
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
    <div className="relative shrink-0" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true"
        className={clsx("pc-press flex h-9 items-center gap-1 rounded-full border px-3 text-sm font-medium",
          active ? "border-peacock bg-peacock-light text-peacock" : "border-line bg-white text-ink hover:border-ink/40")}>
        {label}<ChevronDown className={clsx("h-4 w-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 top-11 z-30 w-72 max-w-[calc(100vw-2rem)] animate-rise-in rounded-xl bg-white p-4 text-[15px] shadow-xl ring-1 ring-line"
          onClick={(e) => { if ((e.target as HTMLElement).closest("input[type=radio],input[type=checkbox],button[type=button]")) setTimeout(() => setOpen(false), 120); }}>
          {children}
        </div>
      )}
    </div>
  );
}

function ToggleChip({ label, on, onChange, icon }: { label: string; on: boolean; onChange: (on: boolean) => void; icon?: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={() => onChange(!on)}
      className={clsx("pc-press flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium",
        on ? "border-peacock bg-peacock text-white" : "border-line bg-white text-ink hover:border-ink/40")}>
      {icon}{label}
    </button>
  );
}

function FilterBar(p: FilterProps & { count: number; onAll: () => void; sort: React.ReactNode }) {
  const { data, params, set, inCategory } = p;
  return (
    <div className="flex items-center gap-2" aria-label="Filters" role="toolbar">
      <div className="scroll-x flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 sm:overflow-visible sm:flex-wrap">
        <button type="button" onClick={p.onAll} className="pc-press flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-ink bg-ink px-3 text-sm font-semibold text-white hover:bg-ink/90">
          <SlidersHorizontal className="h-4 w-4" /> Filters{p.count ? ` (${p.count})` : ""}
        </button>
        <ToggleChip label="Today's deals" on={params.get("deal") === "true"} onChange={(on) => set({ deal: on ? "true" : null })} icon={<Zap className="h-4 w-4" />} />
        <span className="hidden sm:contents">
          <FilterMenu label="Delivery day" active={Boolean(params.get("delivery"))}><DeliveryFilter {...p} /></FilterMenu>
          {!inCategory && (data.categories?.length ?? 0) > 0 && <FilterMenu label="Department" active={Boolean(params.get("category"))}><DepartmentFilter {...p} /></FilterMenu>}
          {data.facets.brands.length > 0 && <FilterMenu label="Brand" active={params.getAll("brand").length > 0}><BrandFilter {...p} /></FilterMenu>}
          <FilterMenu label="Price" active={Boolean(params.get("min_price") || params.get("max_price"))}><PriceFilter {...p} /></FilterMenu>
          <FilterMenu label="Reviews" active={Boolean(params.get("min_rating"))}><RatingFilter {...p} /></FilterMenu>
          <FilterMenu label="Discount" active={Boolean(params.get("min_discount"))}><DiscountFilter {...p} /></FilterMenu>
          <ToggleChip label="In stock" on={params.get("in_stock") === "true"} onChange={(on) => set({ in_stock: on ? "true" : null })} />
        </span>
      </div>
      <div className="shrink-0">{p.sort}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- results */

function ResultGrid({ items, wide }: { items: ProductCard[]; wide: boolean }) {
  const layout = useLayout();
  const hairline = layout.productGrid === "hairline";
  return (
    <GridFrame dense={!wide} data-testid="search-results">
      {items.map((p, i) => (
        <div key={`${p.id}-${i}`} className={clsx("flex flex-col", hairline && "bg-white")}>
          <div className="flex-1"><ProductTile p={p} showAdd /></div>
          <div className={hairline ? "px-3 pb-3 sm:px-4" : "pt-1.5"}><CompareToggle item={{ id: p.id, slug: p.slug, title: p.title, image: p.image }} /></div>
        </div>
      ))}
    </GridFrame>
  );
}

export function SearchView({ category, seller }: { category?: string; seller?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const pin = usePincode();
  const layout = useLayout();
  const topbar = layout.listing.filters === "topbar";
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
  if (!data) return <ListingSkeleton />;
  const q = sp.get("q");
  const from = data.total ? (data.page - 1) * data.page_size + 1 : 0;
  const to = Math.min(data.total, data.page * data.page_size);
  const heading = data.category?.name ?? (seller ? "Products from this store" : q ? null : "All products");
  const filterKeys = ["brand", "min_price", "max_price", "min_rating", "min_discount", "in_stock", "deal", "delivery", ...(category ? [] : ["category"])];
  const activeCount = filterKeys.filter((k) => sp.get(k)).length;
  const activeFilters = activeCount > 0;
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
  const clearAll = () => router.push(q ? `${pathname}?q=${encodeURIComponent(q)}` : pathname);
  const fp: FilterProps = { data, params, set, inCategory: Boolean(category) };

  const sort = (
    <>
      <label className="sr-only" htmlFor="sort">Sort by</label>
      <Select id="sort" value={sp.get("sort") ?? "relevance"} onChange={(e) => set({ sort: e.target.value })} className="h-9 w-auto text-sm">
        {SORTS.map(([v, l]) => <option key={v} value={v}>Sort by: {l}</option>)}
      </Select>
    </>
  );
  const title = (
    <div className="min-w-0">
      {heading && <h1 className="text-2xl font-semibold">{heading}</h1>}
      <p className={clsx(heading ? "text-sm text-ink-faint" : "text-[15px]")} data-testid="results-count">
        {data.total ? `${from}-${to} of ${data.total.toLocaleString("en-IN")} results` : "No results"}
        {q && <> for <span className="font-semibold text-vermilion">&ldquo;{q}&rdquo;</span></>}
      </p>
      {q && <SaveSearchButton query={q} maxPaise={paise(sp.get("max_price"))} />}
    </div>
  );
  const departments = !category && (data.categories?.length ?? 0) > 1 && !topbar && (
    <div className="scroll-x flex gap-2 overflow-x-auto" aria-label="Departments">
      {data.categories!.map((c) => (
        <button key={c.slug} type="button" onClick={() => set({ category: sp.get("category") === c.slug ? null : c.slug })} aria-pressed={sp.get("category") === c.slug}
          className={clsx("shrink-0 rounded-full border px-3 py-1 text-sm", sp.get("category") === c.slug ? "border-peacock bg-peacock text-white" : "border-line bg-white hover:border-peacock")}>
          {c.name} <span className={sp.get("category") === c.slug ? "text-white/80" : "text-ink-faint"}>({c.count})</span>
        </button>
      ))}
    </div>
  );
  const chips = activeFilters && (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {sp.get("deal") && <Chip label="Today's deals" onClear={() => set({ deal: null })} />}
      {sp.get("delivery") && <Chip label={sp.get("delivery") === "1" ? "Get it by tomorrow" : `Get it in ${sp.get("delivery")} days`} onClear={() => set({ delivery: null })} />}
      {!category && sp.get("category") && <Chip label={data.categories?.find((c) => c.slug === sp.get("category"))?.name ?? "Department"} onClear={() => set({ category: null })} />}
      {params.getAll("brand").map((b) => <Chip key={b} label={b} onClear={() => set({ brand: params.getAll("brand").filter((x) => x !== b) })} />)}
      {priceLabel && <Chip label={priceLabel} onClear={() => set({ min_price: null, max_price: null })} />}
      {sp.get("min_rating") && <Chip label={`${sp.get("min_rating")}★ & up`} onClear={() => set({ min_rating: null })} />}
      {sp.get("min_discount") && <Chip label={`${sp.get("min_discount")}% off or more`} onClear={() => set({ min_discount: null })} />}
      {sp.get("in_stock") && <Chip label="In stock" onClear={() => set({ in_stock: null })} />}
      <button type="button" onClick={clearAll} className="font-semibold text-peacock hover:underline">Clear all</button>
    </div>
  );
  const body = (
    <>
      {results.length === 0 ? (
        <EmptyState title="No products match"
          body={activeFilters ? "Try removing a filter or two." : "Try a different word, or browse the categories above."}
          action={activeFilters ? <Button variant="secondary" onClick={clearAll}>Clear filters</Button> : undefined} />
      ) : <ResultGrid items={results} wide={topbar} />}
      <Pagination page={data.page} pageSize={data.page_size} total={data.total} onPage={(p) => set({ page: String(p) })} />
      {data.page === 1 && railItems.length > 0 && (
        <ProductRail title={q ? "Sponsored products related to your search" : "Sponsored products"} items={railItems} note="Sponsored" />
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      {data.breadcrumbs.length > 0 && (
        <nav className="text-sm text-ink-faint" aria-label="Breadcrumb">
          <Link href="/" className="hover:text-peacock">Home</Link>
          {data.breadcrumbs.map((b) => <span key={b.slug}> › <Link href={`/c/${b.slug}`} className="hover:text-peacock">{b.name}</Link></span>)}
        </nav>
      )}
      {topbar ? (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="shop-panel shop-panel-pad px-4 py-3">{title}</div>
          <FilterBar key={priceKey} {...fp} count={activeCount} onAll={() => setShowFilters(true)} sort={sort} />
          {chips}
          {body}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[250px_1fr]">
          <aside className="hidden self-start rounded-xl bg-white p-4 lg:sticky lg:top-40 lg:block" aria-label="Filters">
            <h2 className="mb-4 text-lg font-semibold">Filters</h2>
            <Filters key={priceKey} {...fp} />
          </aside>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white px-4 py-3">
              {title}
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" className="lg:hidden" onClick={() => setShowFilters(true)}>
                  <SlidersHorizontal className="h-4 w-4" /> Filters{activeFilters ? " (on)" : ""}
                </Button>
                {sort}
              </div>
            </div>
            {departments}
            {chips}
            {body}
          </div>
        </div>
      )}
      <Modal open={showFilters} onClose={() => setShowFilters(false)} title="Filters">
        <Filters key={priceKey} {...fp} set={(changes) => { set(changes); setShowFilters(false); }} />
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
