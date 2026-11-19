"use client";

/* Bestsellers and Hot new releases: ranked lists per department, and the top 50 of any category. */

import clsx from "clsx";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ProductGrid, ProductRail } from "@/components/product";
import { api, latestOnly } from "@/lib/api";
import type { CategoryNode, ProductCard } from "@/lib/types";

type Ref = { name: string; slug: string };
type TopData = {
  list: "bestsellers" | "new"; category: Ref | null; breadcrumbs?: Ref[]; children?: Ref[]; items?: ProductCard[];
  sections?: { category: Ref; items: ProductCard[] }[]; tree: CategoryNode[]; new_release_days?: number;
};

function Tree({ nodes, current, base, depth = 0 }: { nodes: CategoryNode[]; current: string; base: string; depth?: number }) {
  return (
    <ul className={clsx(depth && "ml-3 border-l border-line pl-2")}>
      {nodes.filter((n) => n.product_count > 0).map((n) => (
        <li key={n.slug}>
          <Link href={`${base}?category=${n.slug}`} className={clsx("block rounded px-2 py-1 text-[14px] hover:bg-mist", n.slug === current ? "font-semibold text-peacock" : "text-ink-soft")}>{n.name}</Link>
          {n.children.length > 0 && (n.slug === current || n.children.some((c) => c.slug === current)) && <Tree nodes={n.children} current={current} base={base} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function TopList({ list }: { list: "bestsellers" | "new" }) {
  const sp = useSearchParams();
  const pathname = usePathname();
  const category = sp.get("category") ?? "";
  const [data, setData] = useState<TopData | null>(null);
  const [error, setError] = useState("");
  const track = useMemo(() => latestOnly(), []);
  useEffect(() => {
    track(api<TopData>("/api/catalog/top", { query: { list, category: category || undefined } }), (d) => { setError(""); setData(d); })
      .catch((e: Error) => setError(e.message || "Could not load the list"));
  }, [list, category, track]);
  const name = list === "bestsellers" ? "Bestsellers" : "Hot new releases";
  const explain = list === "bestsellers"
    ? "Our most popular products, by units sold in the last 30 days. Updated through the day."
    : `Products launched in the last ${data?.new_release_days ?? 45} days, ranked by how fast they sell.`;
  return (
    <div className="grid gap-4 lg:grid-cols-[230px_1fr]">
      <aside className="hidden self-start rounded-xl bg-white p-3 lg:sticky lg:top-40 lg:block" aria-label="Departments">
        <p className="px-2 pb-1 font-semibold">Any department</p>
        <Link href={pathname} className={clsx("block rounded px-2 py-1 text-[14px] hover:bg-mist", !category ? "font-semibold text-peacock" : "text-ink-soft")}>All departments</Link>
        {data && <Tree nodes={data.tree} current={category} base={pathname} />}
      </aside>
      <div className="flex min-w-0 flex-col gap-4">
        <header className="rounded-xl bg-white p-4 sm:p-5">
          {data?.breadcrumbs && (
            <nav className="mb-1 text-sm text-ink-faint" aria-label="Breadcrumb">
              <Link href={pathname} className="hover:text-peacock">{name}</Link>
              {data.breadcrumbs.map((b) => <span key={b.slug}> › <Link href={`${pathname}?category=${b.slug}`} className="hover:text-peacock">{b.name}</Link></span>)}
            </nav>
          )}
          <h1 className="text-2xl font-semibold sm:text-3xl">{data?.category ? `${name} in ${data.category.name}` : `${name}`}</h1>
          <p className="text-ink-soft">{explain}</p>
          {data?.children && data.children.length > 0 && (
            <div className="scroll-x mt-3 flex gap-2 overflow-x-auto">
              {data.children.map((c) => <Link key={c.slug} href={`${pathname}?category=${c.slug}`} className="shrink-0 rounded-full border border-line px-3 py-1 text-sm hover:border-peacock hover:text-peacock">{c.name}</Link>)}
            </div>
          )}
          <div className="scroll-x mt-3 flex gap-2 overflow-x-auto lg:hidden">
            {data?.tree.filter((n) => n.product_count > 0).map((n) => (
              <Link key={n.slug} href={`${pathname}?category=${n.slug}`} className={clsx("shrink-0 rounded-full px-3 py-1 text-sm", n.slug === category ? "bg-peacock text-white" : "bg-mist")}>{n.name}</Link>
            ))}
          </div>
        </header>
        {error ? <p className="rounded-xl bg-white p-6 text-vermilion">{error}</p> : !data ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-busy="true">
            {Array.from({ length: 10 }, (_, i) => <div key={i} className="rounded-xl bg-white p-3"><div className="skeleton mb-3 aspect-square rounded-lg" /><div className="skeleton h-4 rounded" /></div>)}
          </div>
        ) : data.category ? (
          data.items && data.items.length ? <ProductGrid items={data.items} ranked showAdd /> : <p className="rounded-xl bg-white p-6 text-ink-soft">Nothing here yet. Check back soon.</p>
        ) : (data.sections ?? []).length ? (
          (data.sections ?? []).map((sec) => (
            <ProductRail key={sec.category.slug} title={`${name} in ${sec.category.name}`} items={sec.items} ranked href={`${pathname}?category=${sec.category.slug}`} linkText="See more" />
          ))
        ) : <p className="rounded-xl bg-white p-6 text-ink-soft">Nothing here yet. Check back soon.</p>}
      </div>
    </div>
  );
}
