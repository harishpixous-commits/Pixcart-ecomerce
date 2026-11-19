"use client";

import clsx from "clsx";
import { Scale, ShoppingCart, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useCompare } from "@/components/compare";
import { DealBadge } from "@/components/product";
import { EmptyState, PageLoader, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { ProductCard } from "@/lib/types";

type Item = ProductCard & { specs: Record<string, string>; info: Record<string, string>; return_window_days: number; highlights: string[] };
type Data = { items: Item[]; spec_keys: string[]; info_keys: string[] };

function ComparePage() {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { addToCart } = useSession();
  const compare = useCompare();
  const ids = sp.get("ids") ?? "";
  const [state, setState] = useState<{ ids: string; data: Data | null; error: string }>({ ids: "", data: null, error: "" });
  const [diffOnly, setDiffOnly] = useState(false);
  useEffect(() => {
    if (!ids) return;
    let live = true;
    api<Data>("/api/catalog/compare", { query: { ids } })
      .then((d) => { if (live) setState({ ids, data: d, error: "" }); })
      .catch((e: Error) => { if (live) setState({ ids, data: null, error: e.message }); });
    return () => { live = false; };
  }, [ids]);

  if (!ids) {
    return <EmptyState title="Nothing to compare yet" body="Tick “Add to compare” on two to four products, then open the compare tray at the bottom."
      action={<Link href="/search" className="rounded-full bg-peacock px-5 py-2 font-semibold text-white">Browse products</Link>} />;
  }
  if (state.ids !== ids) return <PageLoader />;
  if (state.error || !state.data) return <EmptyState title="Could not compare these products" body={state.error} />;
  const { items, spec_keys, info_keys } = state.data;

  function remove(id: string) {
    compare.remove(id);
    const left = items.filter((x) => x.id !== id).map((x) => x.id);
    router.replace(left.length ? `/compare?ids=${left.join(",")}` : "/compare");
  }
  async function add(p: Item) {
    if (!p.variant_id) return;
    try {
      await addToCart({ variant_id: p.variant_id, qty: 1, title: p.title, image: p.image, price: p.price, mrp: p.mrp, slug: p.slug, variant_label: "", seller_name: p.seller_name });
      toast("Added to your cart");
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not add to cart", "error");
    }
  }
  const differs = (values: string[]) => new Set(values.map((v) => v.trim().toLowerCase())).size > 1;
  const rows: { label: string; values: string[] }[] = [
    ...info_keys.map((k) => ({ label: k, values: items.map((x) => x.info[k] ?? "—") })),
    ...spec_keys.filter((k) => !info_keys.includes(k)).map((k) => ({ label: k, values: items.map((x) => x.specs[k] ?? "—") })),
    { label: "Returns", values: items.map((x) => (x.return_window_days > 0 ? `${x.return_window_days}-day returns` : "Not returnable")) },
    { label: "Sold by", values: items.map((x) => x.seller_name) },
  ];
  const shownRows = diffOnly ? rows.filter((r) => differs(r.values)) : rows;
  const cell = "border-b border-line px-3 py-2.5 align-top text-sm";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 sm:p-5">
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Scale className="h-6 w-6 text-peacock" /> Compare products</h1>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="h-4 w-4 accent-peacock" checked={diffOnly} onChange={(e) => setDiffOnly(e.target.checked)} /> Show only differences
        </label>
      </header>
      <div className="overflow-x-auto rounded-xl bg-white" data-testid="compare-table">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 w-40 bg-white" />
              {items.map((p) => (
                <th key={p.id} className="relative w-56 border-b border-line p-3 text-left align-top font-normal">
                  <button type="button" onClick={() => remove(p.id)} aria-label={`Remove ${p.title}`} className="absolute right-2 top-2 rounded-full p-1 text-ink-faint hover:bg-mist hover:text-vermilion"><X className="h-4 w-4" /></button>
                  <Link href={`/p/${p.slug}`} className="block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.image} alt="" className="mx-auto mb-2 aspect-square w-32 rounded-lg object-contain" />
                    <span className="line-clamp-2 text-sm font-medium hover:text-peacock">{p.title}</span>
                  </Link>
                  <p className="mt-1 font-display text-lg font-bold">{rupees(p.price)} {p.mrp > p.price && <span className="text-sm font-normal text-ink-faint line-through">{rupees(p.mrp)}</span>}</p>
                  {p.deal ? <div className="mt-1"><DealBadge deal={p.deal} discount={p.discount_pct} /></div> : p.discount_pct > 0 ? <p className="text-sm font-semibold text-leaf">{p.discount_pct}% off</p> : null}
                  {p.rating_count > 0 && <p className="mt-1 text-xs"><span className="rounded bg-leaf px-1.5 font-semibold text-white">{p.rating_avg.toFixed(1)} ★</span> <span className="text-ink-faint">({p.rating_count.toLocaleString("en-IN")})</span></p>}
                  {p.variant_id && p.in_stock ? (
                    <button type="button" onClick={() => add(p)} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-marigold py-1.5 text-sm font-semibold text-ink hover:bg-marigold-dark"><ShoppingCart className="h-4 w-4" /> Add to cart</button>
                  ) : (
                    <Link href={`/p/${p.slug}`} className="mt-2 block rounded-full border border-line py-1.5 text-center text-sm font-semibold hover:bg-mist">{p.in_stock ? "See options" : "Out of stock"}</Link>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((r) => (
              <tr key={r.label} className={clsx(differs(r.values) && "bg-marigold-light/30")}>
                <th scope="row" className={clsx(cell, "sticky left-0 z-10 bg-mist text-left font-semibold")}>{r.label}</th>
                {r.values.map((v, i) => <td key={i} className={clsx(cell, "text-ink-soft")}>{v}</td>)}
              </tr>
            ))}
            {shownRows.length === 0 && <tr><td colSpan={items.length + 1} className="p-6 text-center text-ink-soft">These products have the same details.</td></tr>}
          </tbody>
        </table>
      </div>
      {items.length < 4 && <p className="px-1 text-sm text-ink-soft">You can compare up to 4 products. Tick “Add to compare” on any product.</p>}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ComparePage />
    </Suspense>
  );
}
