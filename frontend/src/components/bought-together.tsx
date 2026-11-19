"use client";

/* "Frequently bought together": products that real customers ordered with this one, with one-click "Add all to cart". */

import clsx from "clsx";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { ProductCard } from "@/lib/types";

export function BoughtTogether({ slug }: { slug: string }) {
  const site = useSite();
  const toast = useToast();
  const { addToCart } = useSession();
  const [items, setItems] = useState<ProductCard[] | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ items: ProductCard[] }>(`/api/catalog/products/${slug}/bought-together`).then((r) => { if (live) setItems(r.items); }).catch(() => { if (live) setItems([]); });
    return () => { live = false; };
  }, [slug]);
  if (site.features.bought_together === false || !items || items.length < 2) return null;
  const picked = items.filter((p) => !off.has(p.id));
  const total = picked.reduce((n, p) => n + p.price, 0);
  const addable = picked.filter((p) => p.variant_id && p.in_stock);
  const needsChoice = picked.filter((p) => !p.variant_id);

  async function addAll() {
    setBusy(true);
    try {
      for (const p of addable) {
        await addToCart({ variant_id: p.variant_id!, qty: 1, title: p.title, image: p.image, price: p.price, mrp: p.mrp, slug: p.slug, variant_label: "", seller_name: p.seller_name });
      }
      toast(`${addable.length} item${addable.length === 1 ? "" : "s"} added to your cart${needsChoice.length ? ". Choose options for the rest." : ""}`);
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not add to cart", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="fbt-h" data-testid="bought-together">
      <h2 id="fbt-h" className="mb-3 text-xl font-semibold">Frequently bought together</h2>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-2">
          {items.map((p, i) => (
            <div key={p.id} className="flex items-center gap-2">
              {i > 0 && <Plus className="h-5 w-5 text-ink-faint" aria-hidden />}
              <Link href={`/p/${p.slug}`} className={clsx("block h-24 w-24 overflow-hidden rounded-lg bg-mist p-1 sm:h-28 sm:w-28", off.has(p.id) && "opacity-40")}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.image} alt={p.title} className="h-full w-full object-contain mix-blend-multiply" />
              </Link>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2 lg:ml-6 lg:min-w-[220px]">
          <p className="text-lg">Total price: <span className="font-display font-bold">{rupees(total)}</span></p>
          <Button variant="cart" onClick={addAll} loading={busy} disabled={!addable.length}>
            {picked.length === items.length ? `Add all ${addable.length} to cart` : `Add ${addable.length} to cart`}
          </Button>
          {needsChoice.length > 0 && <p className="text-xs text-ink-faint">Some items have sizes or colours: choose them on their pages.</p>}
        </div>
      </div>
      <ul className="mt-4 flex flex-col gap-1.5 text-sm">
        {items.map((p, i) => (
          <li key={p.id}>
            <label className="flex cursor-pointer items-start gap-2">
              <input type="checkbox" className="mt-1 accent-peacock" checked={!off.has(p.id)}
                onChange={(e) => setOff((s) => { const n = new Set(s); if (e.target.checked) n.delete(p.id); else n.add(p.id); return n; })} />
              <span>
                {i === 0 ? <span className="font-semibold">This item: </span> : null}
                <Link href={`/p/${p.slug}`} className="hover:text-peacock">{p.title}</Link>{" "}
                <span className="font-semibold">{rupees(p.price)}</span>
                {!p.variant_id && <span className="text-ink-faint"> · choose options on its page</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
