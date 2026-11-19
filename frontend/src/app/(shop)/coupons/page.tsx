"use client";

import clsx from "clsx";
import { Check, Copy, Store, Tag } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { date, rupees } from "@/lib/format";

type CouponItem = {
  code: string; title: string; terms: string; description: string; source: "platform" | "seller"; seller: string; category: string;
  shop_link: string; min_order_paise: number; first_order_only: boolean; ends_at: string | null;
};

export default function CouponsPage() {
  const toast = useToast();
  const [data, setData] = useState<{ items: CouponItem[]; enabled: boolean } | null>(null);
  const [filter, setFilter] = useState<"all" | "platform" | "seller">("all");
  const [copied, setCopied] = useState("");
  useEffect(() => { api<{ items: CouponItem[]; enabled: boolean }>("/api/catalog/coupons").then(setData).catch(quietly); }, []);
  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* the code is visible anyway */
    }
    setCopied(code);
    toast(`Code ${code} copied. Apply it at checkout.`);
    setTimeout(() => setCopied(""), 2500);
  }
  const items = (data?.items ?? []).filter((c) => filter === "all" || c.source === filter);
  return (
    <div className="flex flex-col gap-4">
      <header className="rounded-xl bg-white p-4 sm:p-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold sm:text-3xl"><Tag className="h-7 w-7 text-vermilion" /> Coupons</h1>
        <p className="text-ink-soft">Copy a code and apply it at checkout. Store offers work across sellers; seller offers work on that seller&apos;s products.</p>
        <div className="mt-3 flex gap-2">
          {([["all", "All offers"], ["platform", "Store offers"], ["seller", "Seller offers"]] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setFilter(k)} aria-pressed={filter === k}
              className={clsx("rounded-full border px-4 py-1.5 text-sm font-semibold", filter === k ? "border-peacock bg-peacock text-white" : "border-line hover:border-peacock")}>{label}</button>
          ))}
        </div>
      </header>
      {!data ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton h-44 rounded-xl" />)}</div>
      ) : !data.enabled || items.length === 0 ? (
        <div className="rounded-xl bg-white p-8 text-center">
          <p className="text-lg font-semibold">{data.enabled ? "No coupons right now" : "Coupons are not available right now"}</p>
          <p className="mt-1 text-ink-soft">Today&apos;s deals still have great prices.</p>
          <Link href="/deals" className="mt-3 inline-block rounded-full bg-peacock px-5 py-2 font-semibold text-white">See today&apos;s deals</Link>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="coupons">
          {items.map((c) => (
            <article key={c.code} className="relative flex flex-col gap-2 overflow-hidden rounded-xl border-2 border-dashed border-peacock/30 bg-white p-4">
              <span className={clsx("self-start rounded-full px-2.5 py-0.5 text-xs font-semibold", c.source === "seller" ? "bg-marigold-light text-ink" : "bg-peacock-light text-peacock")}>
                {c.source === "seller" ? <span className="inline-flex items-center gap-1"><Store className="h-3 w-3" /> Seller offer: {c.seller}</span> : "Store offer"}
              </span>
              <p className="font-display text-2xl font-bold leading-tight">{c.title}</p>
              <p className="text-sm text-ink-soft">{c.description || c.terms || "On eligible products"}</p>
              <ul className="flex flex-wrap gap-1.5 text-xs text-ink-soft">
                {c.min_order_paise > 0 && <li className="rounded bg-mist px-2 py-0.5">Min. order {rupees(c.min_order_paise)}</li>}
                {c.first_order_only && <li className="rounded bg-mist px-2 py-0.5">First order only</li>}
                {c.category && <li className="rounded bg-mist px-2 py-0.5">{c.category}</li>}
                {c.ends_at && <li className="rounded bg-vermilion-light px-2 py-0.5 text-vermilion">Ends {date(c.ends_at)}</li>}
              </ul>
              <div className="mt-auto flex items-center gap-2 pt-2">
                <button type="button" onClick={() => copy(c.code)} aria-label={`Copy code ${c.code}`}
                  className="flex flex-1 items-center justify-between rounded-lg border border-dashed border-peacock bg-peacock-light px-3 py-2 font-mono font-semibold text-peacock hover:bg-peacock hover:text-white">
                  {c.code}{copied === c.code ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
                <Link href={c.shop_link} className="rounded-lg bg-marigold px-3 py-2 text-sm font-semibold text-ink hover:bg-marigold-dark">Shop now</Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
