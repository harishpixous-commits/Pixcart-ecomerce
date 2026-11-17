"use client";

import { Minus, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button, ButtonLink, EmptyState, ErrorNote, PageLoader, ProductImage, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { CartView } from "@/lib/types";

function Qty({ value, max, onChange, disabled }: { value: number; max: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-line">
      <button className="flex h-8 w-8 items-center justify-center disabled:opacity-40" onClick={() => onChange(value - 1)} disabled={disabled || value <= 1} aria-label="Decrease quantity">
        <Minus className="h-4 w-4" />
      </button>
      <span className="w-8 text-center font-semibold" aria-live="polite">{value}</span>
      <button className="flex h-8 w-8 items-center justify-center disabled:opacity-40" onClick={() => onChange(value + 1)} disabled={disabled || value >= max} aria-label="Increase quantity">
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

function Summary({ s, children }: { s: { mrp_total: number; discount: number; shipping_total: number; grand_total: number; item_count: number }; children: React.ReactNode }) {
  return (
    <aside className="flex flex-col gap-3 self-start rounded-xl bg-white p-4 lg:sticky lg:top-36">
      <h2 className="text-lg font-semibold text-ink-soft">Price details</h2>
      <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-[15px]">
        <dt>Price ({s.item_count} item{s.item_count === 1 ? "" : "s"})</dt>
        <dd>{rupees(s.mrp_total)}</dd>
        <dt>Discount</dt>
        <dd className="text-leaf">−{rupees(s.discount)}</dd>
        <dt>Delivery</dt>
        <dd>{s.shipping_total ? rupees(s.shipping_total) : <span className="text-leaf">Free</span>}</dd>
        <dt className="border-t border-dashed border-line pt-2 font-display text-lg font-semibold">Total</dt>
        <dd className="border-t border-dashed border-line pt-2 font-display text-lg font-semibold">{rupees(s.grand_total)}</dd>
      </dl>
      {s.discount > 0 && <p className="font-semibold text-leaf">You save {rupees(s.discount)} on this order</p>}
      {children}
    </aside>
  );
}

function GuestCart() {
  const { guestLines, setGuestQty } = useSession();
  if (!guestLines.length) return <EmptyState title="Your cart is empty" body="Find something you like and add it here." action={<ButtonLink href="/">Start shopping</ButtonLink>} />;
  const mrp = guestLines.reduce((n, l) => n + l.mrp * l.qty, 0);
  const total = guestLines.reduce((n, l) => n + l.price * l.qty, 0);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <section className="divide-y divide-line rounded-xl bg-white">
        {guestLines.map((l) => (
          <div key={l.variant_id} className="flex gap-4 p-4">
            <ProductImage src={l.image} alt={l.title} className="h-24 w-24 shrink-0" />
            <div className="flex flex-1 flex-col gap-1">
              <Link href={`/p/${l.slug}`} className="font-medium hover:text-peacock">{l.title}</Link>
              {l.variant_label && <p className="text-sm text-ink-faint">{l.variant_label}</p>}
              <p className="text-sm text-ink-faint">Seller: {l.seller_name}</p>
              <p className="font-display text-lg font-bold">{rupees(l.price)}</p>
              <div className="flex items-center gap-3">
                <Qty value={l.qty} max={10} onChange={(n) => setGuestQty(l.variant_id, n)} />
                <button className="text-sm font-semibold text-ink-soft hover:text-vermilion" onClick={() => setGuestQty(l.variant_id, 0)}>Remove</button>
              </div>
            </div>
          </div>
        ))}
      </section>
      <Summary s={{ mrp_total: mrp, discount: mrp - total, shipping_total: 0, grand_total: total, item_count: guestLines.reduce((n, l) => n + l.qty, 0) }}>
        <p className="text-sm text-ink-faint">Delivery charges are worked out at checkout.</p>
        <ButtonLink href="/login?next=/checkout" variant="buy" className="h-12">Sign in to place order</ButtonLink>
      </Summary>
    </div>
  );
}

export default function CartPage() {
  const { user, ready, refreshCart } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [cart, setCart] = useState<CartView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCart(await api<CartView>("/api/cart"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load your cart");
    }
  }, []);

  useEffect(() => {
    if (ready && user) load();
  }, [ready, user, load]);

  async function setQty(variantId: string, qty: number) {
    setBusy(variantId);
    try {
      setCart(await api<CartView>("/api/cart/items", { method: "PUT", body: { variant_id: variantId, qty } }));
      await refreshCart();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not update the cart", "error");
    } finally {
      setBusy(null);
    }
  }

  if (!ready) return <PageLoader />;
  if (!user) return <GuestCart />;
  if (error) return <ErrorNote message={error} />;
  if (!cart) return <PageLoader />;
  if (!cart.groups.length) return <EmptyState title="Your cart is empty" body="Find something you like and add it here." action={<ButtonLink href="/">Start shopping</ButtonLink>} />;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-3">
        <h1 className="px-1 text-2xl font-semibold">Your cart</h1>
        {cart.groups.map((g) => (
          <section key={g.seller.id} className="rounded-xl bg-white">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <p className="font-semibold">
                Sold by <Link href={`/store/${g.seller.slug}`} className="text-peacock hover:underline">{g.seller.name}</Link>
              </p>
              {g.shipping_fee > 0 ? (
                <p className="text-sm text-ink-soft">Add {rupees(g.free_shipping_gap)} more from this seller for free delivery</p>
              ) : (
                <p className="text-sm font-semibold text-leaf">Free delivery from this seller</p>
              )}
            </header>
            <div className="divide-y divide-line">
              {g.lines.map((l) => (
                <div key={l.id} className="flex gap-4 p-4">
                  <ProductImage src={l.image} alt={l.title} className="h-24 w-24 shrink-0" />
                  <div className="flex flex-1 flex-col gap-1">
                    <Link href={`/p/${l.product_slug}`} className="font-medium hover:text-peacock">{l.title}</Link>
                    {l.variant_label && <p className="text-sm text-ink-faint">{l.variant_label}</p>}
                    <p className="flex items-baseline gap-2">
                      <span className="font-display text-lg font-bold">{rupees(l.price)}</span>
                      {l.mrp > l.price && <span className="text-sm text-ink-faint line-through">{rupees(l.mrp)}</span>}
                    </p>
                    {l.problem && <p className="text-sm font-semibold text-vermilion">{l.problem}</p>}
                    <div className="flex items-center gap-3">
                      <Qty value={l.qty} max={Math.max(1, Math.min(10, l.stock_left))} onChange={(n) => setQty(l.variant_id, n)} disabled={busy === l.variant_id} />
                      <button className="inline-flex items-center gap-1 text-sm font-semibold text-ink-soft hover:text-vermilion" onClick={() => setQty(l.variant_id, 0)}>
                        <Trash2 className="h-4 w-4" /> Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <Summary s={cart.summary}>
        {cart.summary.has_problems && <p className="text-sm text-vermilion">Remove or update the items marked in red to continue.</p>}
        <Button variant="buy" size="lg" disabled={cart.summary.has_problems || cart.summary.item_count === 0} onClick={() => router.push("/checkout")}>
          Place order
        </Button>
      </Summary>
    </div>
  );
}
