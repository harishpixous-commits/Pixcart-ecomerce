"use client";

import { Bell, BellOff, Heart } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, PageLoader, ProductImage, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";

type StockAlertRow = { variant_id: string; product: string; slug: string; variant: string; image: string; in_stock: boolean; created_at: string };

export default function AlertsPage() {
  const { user, ready } = useSession();
  const site = useSite();
  const toast = useToast();
  const [items, setItems] = useState<StockAlertRow[] | null>(null);
  const load = useCallback(() => api<{ stock: StockAlertRow[] }>("/api/alerts").then((r) => setItems(r.stock)).catch(() => setItems([])), []);
  useEffect(() => { if (ready && user) load(); }, [ready, user, load]);

  async function remove(id: string) {
    try {
      await api(`/api/alerts/stock/${id}`, { method: "DELETE" });
      setItems((x) => (x ?? []).filter((a) => a.variant_id !== id));
      toast("Alert removed");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not remove", "error");
    }
  }

  if (!ready) return <PageLoader />;
  if (!user) {
    return <EmptyState title="Sign in to see your alerts" body="We tell you when items you follow are back in stock or cheaper."
      action={<Link href="/login?next=/alerts" className="rounded-full bg-peacock px-5 py-2 font-semibold text-white">Sign in</Link>} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <header className="rounded-xl bg-white p-4 sm:p-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Bell className="h-6 w-6 text-peacock" /> Your alerts</h1>
        <p className="text-ink-soft">We send a notification (and an email when you have one on your account) as soon as something changes.</p>
      </header>
      <section className="rounded-xl bg-white" aria-labelledby="stock-h">
        <h2 id="stock-h" className="border-b border-line px-4 py-3 text-lg font-semibold">Back in stock</h2>
        {items === null ? <PageLoader /> : items.length === 0 ? (
          <p className="px-4 py-6 text-ink-soft">No alerts. On a product that is out of stock, choose <span className="font-semibold">Notify me</span> and we will tell you when it is back.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="stock-alerts">
            {items.map((a) => (
              <li key={a.variant_id} className="flex items-center gap-3 px-4 py-3">
                <ProductImage src={a.image} alt={a.product} className="h-16 w-16 shrink-0" />
                <div className="min-w-0 flex-1">
                  <Link href={`/p/${a.slug}`} className="line-clamp-2 font-medium hover:text-peacock">{a.product}</Link>
                  {a.variant && <p className="text-sm text-ink-faint">{a.variant}</p>}
                  <p className={a.in_stock ? "text-sm font-semibold text-leaf" : "text-sm text-ink-soft"}>{a.in_stock ? "Back in stock now" : `Waiting for stock · since ${date(a.created_at)}`}</p>
                </div>
                <button type="button" onClick={() => remove(a.variant_id)} className="flex items-center gap-1 text-sm text-ink-soft hover:text-vermilion"><BellOff className="h-4 w-4" /> Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {site.features.price_alerts !== false && (
        <section className="flex items-start gap-3 rounded-xl bg-white p-4">
          <Heart className="mt-0.5 h-5 w-5 shrink-0 text-vermilion" />
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink">Price drops:</span> products in your <Link href="/wishlist" className="font-semibold text-peacock">wishlist</Link> are watched for you.
            When one gets cheaper than when you saved it, we let you know.
          </p>
        </section>
      )}
    </div>
  );
}
