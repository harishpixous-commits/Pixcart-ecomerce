"use client";

/* "Review items" at checkout: the cart grouped by seller (each seller ships its own package). */

import clsx from "clsx";
import { CircleAlert, ShoppingBag, Store, Truck } from "lucide-react";
import Link from "next/link";
import { ProductImage } from "@/components/ui";
import { rupees } from "@/lib/format";
import type { CartGroup } from "@/lib/types";
import { Bone, Card, CardHeading } from "./card";

export function ItemsReview({ groups, itemCount }: { groups: CartGroup[]; itemCount: number }) {
  const many = groups.length > 1;
  return (
    <Card labelledBy="co-items-h" testId="checkout-items">
      <CardHeading
        id="co-items-h"
        icon={ShoppingBag}
        title="Review items"
        sub={`${itemCount} item${itemCount === 1 ? "" : "s"}${many ? ` from ${groups.length} sellers` : ""}`}
        action={<Link href="/cart" className="rounded-lg px-2.5 py-1.5 text-sm font-bold uppercase tracking-wide text-peacock hover:bg-peacock-light">Edit cart</Link>}
      />
      {many && (
        <p className="mb-3 flex items-start gap-2 rounded-xl bg-peacock-light/60 px-3 py-2 text-sm text-ink-soft">
          <Truck className="mt-0.5 h-4 w-4 shrink-0 text-peacock" aria-hidden />
          Items from different sellers arrive in separate packages ({groups.length} packages).
        </p>
      )}
      <div className="flex flex-col gap-3">
        {groups.map((g, i) => (
          <div key={g.seller.id} className="overflow-hidden rounded-xl ring-1 ring-line" data-testid="checkout-package">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-mist/70 px-3 py-2">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink">
                <Store className="h-4 w-4 shrink-0 text-peacock" aria-hidden />
                {many && <span className="shrink-0 text-ink-faint">Package {i + 1} ·</span>}
                <span className="truncate">{g.seller.name}</span>
              </p>
              {g.shipping_fee ? (
                <span className="text-xs font-medium text-ink-soft">Delivery {rupees(g.shipping_fee)}</span>
              ) : (
                <span className="text-xs font-bold uppercase tracking-wide text-leaf">Free delivery</span>
              )}
            </div>
            <ul className="divide-y divide-line">
              {g.lines.map((l) => (
                <li key={l.id} className={clsx("flex gap-3 p-3", l.problem && "bg-vermilion-light/40")} data-testid="checkout-line">
                  <ProductImage src={l.image} alt="" className={clsx("h-16 w-16 shrink-0 rounded-lg bg-white ring-1 ring-line", l.problem && "opacity-60")} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/p/${l.product_slug}`} className="line-clamp-2 text-[15px] leading-snug text-ink hover:text-peacock">{l.title}</Link>
                    <p className="mt-0.5 text-sm text-ink-faint">{[l.variant_label, `Qty ${l.qty}`].filter(Boolean).join(" · ")}</p>
                    {l.problem && (
                      <p className="mt-1 flex items-start gap-1 text-sm font-semibold text-vermilion">
                        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {l.problem}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-semibold tabular-nums text-ink">{rupees(l.line_total)}</p>
                    {l.mrp > l.price && <p className="text-xs tabular-nums text-ink-faint line-through">{rupees(l.mrp * l.qty)}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function ReviewSkeleton() {
  return (
    <Card labelledBy="co-items-h" testId="checkout-items-loading">
      <CardHeading id="co-items-h" icon={ShoppingBag} title="Review items" sub="Getting your items…" />
      <div className="flex flex-col gap-3" aria-hidden>
        {[0, 1].map((i) => (
          <div key={i} className="flex gap-3">
            <Bone className="h-16 w-16 shrink-0 rounded-lg" />
            <div className="flex flex-1 flex-col gap-2 pt-1">
              <Bone className="h-4 w-3/4" />
              <Bone className="h-3 w-1/3" />
            </div>
            <Bone className="h-4 w-14" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function BillSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Bone className="h-3 w-24" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex justify-between gap-6">
          <Bone className="h-4 w-1/2" />
          <Bone className="h-4 w-16" />
        </div>
      ))}
      <div className="mt-1 flex justify-between gap-6 border-t border-dashed border-line pt-3">
        <Bone className="h-5 w-20" />
        <Bone className="h-5 w-20" />
      </div>
    </div>
  );
}
