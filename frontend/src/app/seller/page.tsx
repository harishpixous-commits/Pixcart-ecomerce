"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, Stat } from "@/components/portal-shell";
import { ButtonLink, PageLoader } from "@/components/ui";
import { api } from "@/lib/api";
import { date, rupees } from "@/lib/format";

type Dash = {
  orders: { to_confirm: number; to_pack: number; to_ship: number; in_transit: number; delivered: number; cancelled: number };
  sales_30d: { amount: number; orders: number };
  daily_sales: { date: string; amount: number; orders: number }[];
  earnings: { in_return_window: number; ready_for_payout: number };
  products: Record<string, number>;
  low_stock_variants: number;
};

function SalesBars({ days }: { days: Dash["daily_sales"] }) {
  if (!days.length) return <p className="py-8 text-center text-ink-faint">Sales from the last 30 days will show here.</p>;
  const max = Math.max(...days.map((d) => d.amount), 1);
  return (
    <div className="flex h-40 items-end gap-1" role="img" aria-label="Daily sales for the last 30 days">
      {days.map((d) => (
        <div key={d.date} className="group relative flex-1">
          <div className="rounded-t bg-peacock/80 group-hover:bg-peacock" style={{ height: `${Math.max(4, (d.amount / max) * 150)}px` }} />
          <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-2 py-1 text-xs text-white group-hover:block">
            {date(d.date)}: {rupees(d.amount)}, {d.orders} orders
          </span>
        </div>
      ))}
    </div>
  );
}

export default function SellerDashboard() {
  const [d, setD] = useState<Dash | null>(null);
  useEffect(() => {
    api<Dash>("/api/seller/dashboard").then(setD).catch(() => {});
  }, []);
  if (!d) return <PageLoader />;
  const live = d.products.approved ?? 0;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Dashboard" actions={<ButtonLink href="/seller/products/new">Add a product</ButtonLink>} />
      {live === 0 && (
        <div className="rounded-xl bg-marigold-light p-4">
          <p className="font-semibold">You have no live products yet</p>
          <p className="text-ink-soft">Add your first product. Our team reviews each new listing before customers can see it.</p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="New orders to confirm" value={d.orders.to_confirm} href="/seller/orders?status=placed" />
        <Stat label="To pack" value={d.orders.to_pack} href="/seller/orders?status=confirmed" />
        <Stat label="Ready to ship" value={d.orders.to_ship} href="/seller/orders?status=packed" />
        <Stat label="In transit" value={d.orders.in_transit} href="/seller/orders?status=shipped" />
      </div>
      <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <section className="rounded-xl bg-white p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">Sales, last 30 days</h2>
            <p className="font-display text-2xl font-bold">{rupees(d.sales_30d.amount)} <span className="text-sm font-normal text-ink-faint">{d.sales_30d.orders} orders</span></p>
          </div>
          <SalesBars days={d.daily_sales} />
        </section>
        <section className="flex flex-col gap-3">
          <Stat label="Payout ready" value={rupees(d.earnings.ready_for_payout)} hint="Return window has closed" href="/seller/payouts" />
          <Stat label="In return window" value={rupees(d.earnings.in_return_window)} hint="Released when the return window closes" href="/seller/payouts" />
        </section>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Live products" value={live} href="/seller/products?status=approved" />
        <Stat label="Waiting for review" value={d.products.pending ?? 0} href="/seller/products?status=pending" />
        <Stat label="Need changes" value={d.products.rejected ?? 0} href="/seller/products?status=rejected" />
        <Stat label="Low stock options" value={d.low_stock_variants} hint="5 or fewer left" href="/seller/products?low_stock=1" />
      </div>
      <p className="text-sm text-ink-faint">
        Confirm new orders quickly: customers can cancel until you ship. <Link href="/seller/orders" className="font-semibold text-peacock">Open orders</Link>
      </p>
    </div>
  );
}
