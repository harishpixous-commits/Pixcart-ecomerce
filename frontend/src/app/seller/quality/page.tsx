"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { PageLoader } from "@/components/ui";
import { api, quietly } from "@/lib/api";

type Me = { orders: number; late: number; cancelled_by_seller: number; returned: number; late_percent: number; cancel_percent: number; return_percent: number; level: string };
type Card = { enabled: boolean; window_days?: number; ship_within_hours?: number; min_orders?: number; limits?: Record<string, number>; you?: Me };
const LEVEL: Record<string, string> = { ok: "Your standing: good", warning: "Your standing: warning", critical: "Your standing: critical", not_enough_orders: "Not enough orders to rate yet" };

export default function SellerQualityPage() {
  const [c, setC] = useState<Card | null>(null);
  useEffect(() => { api<Card>("/api/seller/scorecard").then(setC).catch(quietly); }, []);
  if (!c) return <PageLoader />;
  const tiles = c.enabled && c.you ? [
    { t: "Late shipments", p: c.you.late_percent, n: c.you.late, w: c.limits!.late_warn_percent, k: c.limits!.late_critical_percent },
    { t: "Cancelled by you", p: c.you.cancel_percent, n: c.you.cancelled_by_seller, w: c.limits!.cancel_warn_percent, k: c.limits!.cancel_critical_percent },
    { t: "Returns", p: c.you.return_percent, n: c.you.returned, w: c.limits!.return_warn_percent, k: c.limits!.return_critical_percent },
  ] : [];
  return (
    <div>
      <PageHeader title="Quality" sub="How your orders are doing. Keep these figures under the warning level to stay in good standing." />
      {!c.enabled ? <p className="rounded-xl bg-white p-5 text-ink-soft">The marketplace is not tracking seller quality yet.</p> : (
        <>
          <p className="mb-3 text-sm text-ink-soft">Last {c.window_days} days. Orders count as late when not shipped within {c.ship_within_hours} hours. {LEVEL[c.you!.level] ?? c.you!.level}{c.you!.level === "not_enough_orders" ? ` (needs at least ${c.min_orders} orders)` : ""}.</p>
          <div className="grid gap-3 sm:grid-cols-3" data-testid="seller-quality">
            {tiles.map((x) => (
              <section key={x.t} className="rounded-xl bg-white p-5"><div className="text-sm text-ink-soft">{x.t}</div><div className="text-2xl font-semibold">{x.p}%</div>
                <div className="text-sm text-ink-soft">{x.n} of {c.you!.orders} orders. Warning at {x.w}%, critical at {x.k}%</div></section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
