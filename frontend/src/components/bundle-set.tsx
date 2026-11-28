"use client";

/* "Buy the set": a bundle offer that includes this product: the set, its price after the discount, and one-click "Add the set to cart". */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { ProductCard } from "@/lib/types";

type Bundle = { code: string; automatic: boolean; percent: number; items: ProductCard[]; total: number; saving: number; set_price: number };

export function BundleSet({ slug }: { slug: string }) {
  const toast = useToast();
  const { addToCart } = useSession();
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ bundles: Bundle[] }>(`/api/catalog/products/${slug}/bundles`).then((r) => { if (live) setBundle(r.bundles[0] ?? null); }).catch(() => { if (live) setBundle(null); });
    return () => { live = false; };
  }, [slug]);
  if (!bundle) return null;
  const addable = bundle.items.filter((p) => p.variant_id && p.in_stock);
  const needsChoice = bundle.items.filter((p) => !p.variant_id);

  async function addSet() {
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
    <section className="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="set-h" data-testid="bundle-set">
      <h2 id="set-h" className="mb-3 text-xl font-semibold">Buy the set, save {bundle.percent}%</h2>
      <ul className="flex flex-col gap-1.5 text-sm">
        {bundle.items.map((p) => (
          <li key={p.id}>
            <Link href={`/p/${p.slug}`} className="hover:text-peacock">{p.title}</Link> <span className="font-semibold">{rupees(p.price)}</span>
            {!p.variant_id && <span className="text-ink-faint"> · choose options on its page</span>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-lg">
        Set price: <span className="font-display font-bold">{rupees(bundle.set_price)}</span>{" "}
        <span className="text-sm text-ink-faint line-through">{rupees(bundle.total)}</span>{" "}
        <span className="text-sm font-semibold text-peacock">You save {rupees(bundle.saving)}</span>
      </p>
      <p className="mt-1 text-xs text-ink-faint">{bundle.automatic ? "The discount is applied at checkout." : `Use code ${bundle.code} at checkout.`}</p>
      <Button variant="cart" className="mt-3" onClick={addSet} loading={busy} disabled={!addable.length}>Add the set to cart</Button>
    </section>
  );
}
