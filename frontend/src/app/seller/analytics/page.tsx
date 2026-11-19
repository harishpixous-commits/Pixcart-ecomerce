"use client";

import { useEffect, useState } from "react";
import { DailyBars, Delta } from "@/components/charts";
import { PageHeader, Stat, Table } from "@/components/portal-shell";
import { PageLoader, Select } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { hoursLabel, rupees } from "@/lib/format";

type K = {
  gmv: number; gmv_prev: number; orders: number; orders_prev: number; aov: number; units: number; cancellation_rate: number; return_rate: number;
  avg_hours_to_ship: number | null; views: number; add_to_cart: number; conversion_rate: number; cart_rate: number;
  series: { date: string; orders: number; gmv: number }[];
  products: { id: string; title: string; slug: string; views: number; add_to_cart: number; orders: number; units: number; revenue: number; conversion: number; in_stock: boolean }[];
};

export default function SellerAnalytics() {
  const [days, setDays] = useState(30);
  // the figures remember their period, so a new period shows the loader until its own figures arrive
  const [res, setRes] = useState<{ days: number; k: K } | null>(null);
  useEffect(() => {
    let live = true;
    api<K>("/api/seller/analytics", { query: { days } }).then((k) => { if (live) setRes({ days, k }); }).catch(quietly);
    return () => { live = false; };
  }, [days]);
  const k = res && res.days === days ? res.k : null;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Analytics" actions={
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto" aria-label="Period">
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 12 months</option>
        </Select>
      } />
      {!k ? <PageLoader /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="rounded-xl bg-white p-4"><p className="text-sm text-ink-soft">Sales</p><p className="font-display text-3xl font-bold">{rupees(k.gmv)}</p><Delta now={k.gmv} before={k.gmv_prev} /></div>
            <div className="rounded-xl bg-white p-4"><p className="text-sm text-ink-soft">Orders</p><p className="font-display text-3xl font-bold">{k.orders}</p><Delta now={k.orders} before={k.orders_prev} /></div>
            <Stat label="Average order value" value={rupees(k.aov)} />
            <Stat label="Units sold" value={k.units} />
            <Stat label="Product page views" value={k.views.toLocaleString("en-IN")} />
            <Stat label="Views that became orders" value={`${k.conversion_rate}%`} hint={`${k.cart_rate}% added to cart`} />
            <Stat label="Cancelled packages" value={`${k.cancellation_rate}%`} />
            <Stat label="Average time to ship" value={hoursLabel(k.avg_hours_to_ship)} hint={`Return rate ${k.return_rate}%`} />
          </div>
          <section className="rounded-xl bg-white p-4"><h2 className="mb-2 text-lg font-semibold">Daily sales</h2><DailyBars series={k.series} valueKey="gmv" money /></section>
          <section>
            <h2 className="mb-2 px-1 text-lg font-semibold">Product performance</h2>
            <Table head={["Product", "Views", "Added to cart", "Orders", "Units", "Sales", "Conversion"]}>
              {k.products.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2"><a href={`/p/${p.slug}`} target="_blank" rel="noreferrer" className="line-clamp-1 font-medium hover:text-peacock">{p.title}</a>{!p.in_stock && <span className="text-xs text-vermilion"> Out of stock</span>}</td>
                  <td className="px-4 py-2">{p.views}</td><td className="px-4 py-2">{p.add_to_cart}</td><td className="px-4 py-2">{p.orders}</td><td className="px-4 py-2">{p.units}</td>
                  <td className="px-4 py-2 font-semibold">{rupees(p.revenue)}</td><td className="px-4 py-2">{p.conversion}%</td>
                </tr>
              ))}
            </Table>
          </section>
        </>
      )}
    </div>
  );
}
