"use client";

import clsx from "clsx";
import { BadgePercent, Bookmark, Minus, Plus, Store, Trash2, Truck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BillDetails } from "@/components/bill";
import { RecentlyViewedRail } from "@/components/pdp";
import { Button, ButtonLink, EmptyState, ErrorNote, PageLoader, Pill, Price, ProductImage, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { CartGroup, CartLine, CartView } from "@/lib/types";

const SURFACE = "rounded-2xl bg-white shadow-sm ring-1 ring-black/5";
const CARD = `${SURFACE} p-4 sm:p-5`;
const LINE_ACTION = "inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";

function Qty({ value, max, onChange, disabled }: { value: number; max: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex h-9 items-center rounded-lg border border-line bg-white">
      <button type="button" className="flex h-full w-9 items-center justify-center rounded-l-lg text-ink-soft hover:bg-mist disabled:opacity-40 disabled:hover:bg-transparent"
        onClick={() => onChange(value - 1)} disabled={disabled || value <= 1} aria-label="Decrease quantity">
        <Minus className="h-4 w-4" />
      </button>
      <span className="w-8 text-center font-semibold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" className="flex h-full w-9 items-center justify-center rounded-r-lg text-ink-soft hover:bg-mist disabled:opacity-40 disabled:hover:bg-transparent"
        onClick={() => onChange(value + 1)} disabled={disabled || value >= max} aria-label="Increase quantity">
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

function CartHead({ count, subtotal }: { count: number; subtotal: number }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
      <h1 className="text-2xl font-semibold">Shopping cart</h1>
      <p className="text-ink-soft">
        Subtotal ({count} item{count === 1 ? "" : "s"}): <span className="font-display font-bold text-ink">{rupees(subtotal)}</span>
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- signed out (cart kept in this browser) */

/** Signed-out carts have no server bill: delivery and fees are worked out at checkout, so none is shown as free. */
function GuestSummary({ mrp, total, count }: { mrp: number; total: number; count: number }) {
  return (
    <section className="flex flex-col gap-3" aria-label="Price details">
      <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Price details</h2>
      <dl className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2.5 text-[15px]">
        <dt>Item total<span className="text-ink-faint"> ({count} item{count === 1 ? "" : "s"})</span></dt>
        <dd className="whitespace-nowrap text-right tabular-nums">
          {mrp > total && <span className="mr-1.5 text-sm text-ink-faint line-through">{rupees(mrp)}</span>}
          {rupees(total)}
        </dd>
        <dt>Delivery</dt>
        <dd className="text-right text-sm text-ink-faint">At checkout</dd>
        <dt className="mt-1 border-t border-dashed border-line pt-3 font-display text-lg font-bold">Subtotal</dt>
        <dd className="mt-1 border-t border-dashed border-line pt-3 text-right font-display text-lg font-bold tabular-nums">{rupees(total)}</dd>
      </dl>
      {mrp > total && (
        <p className="flex items-center gap-2 rounded-xl bg-leaf-light px-3 py-2 text-sm font-semibold text-leaf">
          <BadgePercent className="h-4 w-4 shrink-0" aria-hidden /> You save {rupees(mrp - total)} on this order
        </p>
      )}
    </section>
  );
}

function GuestCart() {
  const { guestLines, setGuestQty } = useSession();
  if (!guestLines.length) return <EmptyState title="Your cart is empty" body="Find something you like and add it here." action={<ButtonLink href="/">Start shopping</ButtonLink>} />;
  const mrp = guestLines.reduce((n, l) => n + l.mrp * l.qty, 0);
  const total = guestLines.reduce((n, l) => n + l.price * l.qty, 0);
  const count = guestLines.reduce((n, l) => n + l.qty, 0);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <CartHead count={count} subtotal={total} />
        <section className={clsx(SURFACE, "divide-y divide-line overflow-hidden")}>
          {guestLines.map((l) => (
            <div key={l.variant_id} className="p-4 sm:p-5">
              <div className="flex gap-3 sm:gap-4">
                <Link href={`/p/${l.slug}`} className="shrink-0" tabIndex={-1} aria-hidden>
                  <ProductImage src={l.image} alt={l.title} className="h-20 w-20 rounded-xl sm:h-24 sm:w-24" />
                </Link>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Link href={`/p/${l.slug}`} className="line-clamp-2 font-medium leading-snug hover:text-peacock">{l.title}</Link>
                  {l.variant_label && <p className="text-sm text-ink-faint">{l.variant_label}</p>}
                  <p className="text-sm text-ink-faint">Seller: {l.seller_name}</p>
                  <Price price={l.price} mrp={l.mrp} />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 sm:mt-2 sm:pl-28">
                <Qty value={l.qty} max={10} onChange={(n) => setGuestQty(l.variant_id, n)} />
                <button type="button" className={clsx(LINE_ACTION, "text-ink-soft hover:bg-vermilion-light hover:text-vermilion")} onClick={() => setGuestQty(l.variant_id, 0)}>
                  <Trash2 className="h-4 w-4" aria-hidden /> Remove
                </button>
              </div>
            </div>
          ))}
        </section>
      </div>
      <aside className={clsx(CARD, "flex flex-col gap-4 lg:sticky lg:top-36")}>
        <GuestSummary mrp={mrp} total={total} count={count} />
        <p className="text-sm text-ink-faint">Delivery charges are worked out at checkout.</p>
        <ButtonLink href="/login?next=/checkout" variant="buy" className="h-12">Sign in to place order</ButtonLink>
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------- signed in */

function FreeDeliveryProgress({ group }: { group: CartGroup }) {
  const goal = group.items_total + group.free_shipping_gap;
  const pct = goal > 0 ? Math.min(100, Math.round((group.items_total / goal) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1.5" data-testid="free-delivery-progress">
      <p className="flex items-start gap-2 text-sm text-ink-soft">
        <Truck className="mt-0.5 h-4 w-4 shrink-0 text-marigold-dark" aria-hidden />
        <span>
          Add items worth <span className="font-semibold text-ink">{rupees(group.free_shipping_gap)}</span> more for free delivery from {group.seller.name}
        </span>
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-mist" role="progressbar" aria-label={`Progress towards free delivery from ${group.seller.name}`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full rounded-full bg-marigold transition-[width] duration-500" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
    </div>
  );
}

function CartLineRow({ line: l, busy, onQty, onSave }: { line: CartLine; busy: boolean; onQty: (qty: number) => void; onSave: () => void }) {
  return (
    <div className={clsx("p-4 sm:p-5", l.problem && "bg-vermilion-light/40")} data-testid="cart-line">
      <div className="flex gap-3 sm:gap-4">
        <Link href={`/p/${l.product_slug}`} className="shrink-0" tabIndex={-1} aria-hidden>
          <ProductImage src={l.image} alt={l.title} className="h-20 w-20 rounded-xl bg-white sm:h-24 sm:w-24" />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Link href={`/p/${l.product_slug}`} className="line-clamp-2 font-medium leading-snug hover:text-peacock">{l.title}</Link>
          {l.variant_label && <p className="text-sm text-ink-faint">{l.variant_label}</p>}
          <Price price={l.price} mrp={l.mrp} />
          {l.problem && <p className="text-sm font-semibold text-vermilion">{l.problem}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 sm:mt-2 sm:pl-28">
        <Qty value={l.qty} max={Math.max(1, Math.min(10, l.stock_left))} onChange={onQty} disabled={busy} />
        <button type="button" className={clsx(LINE_ACTION, "text-ink-soft hover:bg-vermilion-light hover:text-vermilion")} disabled={busy} onClick={() => onQty(0)}>
          <Trash2 className="h-4 w-4" aria-hidden /> Delete
        </button>
        <button type="button" className={clsx(LINE_ACTION, "text-peacock hover:bg-peacock-light")} disabled={busy} onClick={onSave}>
          <Bookmark className="h-4 w-4" aria-hidden /> Save for later
        </button>
      </div>
    </div>
  );
}

function SellerGroup({ group: g, busy, onQty, onSave }: { group: CartGroup; busy: string | null; onQty: (variantId: string, qty: number) => void; onSave: (variantId: string) => void }) {
  const free = g.shipping_fee === 0 && g.items_total > 0;
  return (
    <section className={clsx(SURFACE, "overflow-hidden")}>
      <header className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <p className="flex min-w-0 items-center gap-2 font-semibold">
            <Store className="h-4 w-4 shrink-0 text-peacock" aria-hidden />
            <span className="min-w-0 truncate">
              Sold by <Link href={`/store/${g.seller.slug}`} className="text-peacock hover:underline">{g.seller.name}</Link>
            </span>
          </p>
          {free ? (
            <Pill tone="green"><Truck className="mr-1 h-3.5 w-3.5" aria-hidden />Free delivery</Pill>
          ) : g.shipping_fee > 0 ? (
            <span className="text-sm text-ink-soft">Delivery <span className="font-semibold text-ink">{rupees(g.shipping_fee)}</span></span>
          ) : null}
        </div>
        {g.shipping_fee > 0 && g.free_shipping_gap > 0 && <FreeDeliveryProgress group={g} />}
      </header>
      <div className="divide-y divide-line">
        {g.lines.map((l) => (
          <CartLineRow key={l.id} line={l} busy={busy === l.variant_id} onQty={(n) => onQty(l.variant_id, n)} onSave={() => onSave(l.variant_id)} />
        ))}
      </div>
    </section>
  );
}

/** Phones and tablets: the total and the buy button stay in reach while the bill is scrolled out of sight. */
function CheckoutBar({ watch, total, disabled, onBuy }: { watch: React.RefObject<HTMLElement | null>; total: number; disabled: boolean; onBuy: () => void }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = watch.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [watch]);
  useEffect(() => {
    // Same flag as the product page's buy bar: the help button moves up and the compare tray steps aside.
    if (show) document.body.dataset.buyBar = "1";
    else delete document.body.dataset.buyBar;
    return () => {
      delete document.body.dataset.buyBar;
    };
  }, [show]);
  return (
    <div className={clsx("fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white/95 px-3 py-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur transition-transform sm:bottom-0 lg:hidden",
      show ? "translate-y-0" : "pointer-events-none translate-y-[150%]")} aria-hidden={!show} data-testid="cart-bar">
      <div className="mx-auto flex max-w-shop items-center gap-3">
        <div className="min-w-0 flex-1 leading-tight">
          <p className="font-display text-lg font-bold tabular-nums">{rupees(total)}</p>
          <button type="button" tabIndex={show ? 0 : -1} className="text-xs font-semibold text-peacock hover:underline"
            onClick={() => document.getElementById("cart-bill")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            View bill
          </button>
        </div>
        <Button variant="buy" disabled={disabled} onClick={onBuy} tabIndex={show ? 0 : -1}>Proceed to buy</Button>
      </div>
    </div>
  );
}

type Saved = { variant_id: string; product_id: string; slug: string; title: string; variant_label: string; image: string; price: number; mrp: number; in_stock: boolean; available: boolean };

function SavedForLater({ items, busy, onMove, onDelete }: { items: Saved[]; busy: string | null; onMove: (id: string) => void; onDelete: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <section className={clsx(SURFACE, "overflow-hidden")} aria-labelledby="saved-h" data-testid="saved-for-later">
      <h2 id="saved-h" className="border-b border-line px-4 py-3 text-lg font-semibold sm:px-5">
        Saved for later <span className="font-sans text-base font-normal text-ink-faint">({items.length} item{items.length === 1 ? "" : "s"})</span>
      </h2>
      <div className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3">
        {items.map((it) => (
          <div key={it.variant_id} className="flex gap-3 rounded-xl border border-line p-3">
            <Link href={`/p/${it.slug}`} className="shrink-0" tabIndex={-1} aria-hidden>
              <ProductImage src={it.image} alt={it.title} className="h-20 w-20 rounded-lg" />
            </Link>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Link href={`/p/${it.slug}`} className="line-clamp-2 text-sm font-medium leading-snug hover:text-peacock">{it.title}</Link>
              {it.variant_label && <p className="text-xs text-ink-faint">{it.variant_label}</p>}
              <Price price={it.price} mrp={it.mrp} size="sm" />
              {!it.in_stock && <p className="text-xs font-semibold text-vermilion">{it.available ? "Out of stock" : "No longer available"}</p>}
              <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="secondary" disabled={!it.in_stock || busy === it.variant_id} onClick={() => onMove(it.variant_id)}>Move to cart</Button>
                <button type="button" className="text-sm font-semibold text-ink-soft hover:text-vermilion" onClick={() => onDelete(it.variant_id)}>Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function CartPage() {
  const { user, ready, refreshCart } = useSession();
  const router = useRouter();
  const toast = useToast();
  const site = useSite();
  const [cart, setCart] = useState<CartView | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buyRef = useRef<HTMLButtonElement>(null);
  // Quantity changes on different lines can overlap; only the newest cart (and its bill) is shown.
  const track = useMemo(() => latestOnly(), []);

  const load = useCallback(() => {
    track(Promise.all([api<CartView>("/api/cart"), api<{ items: Saved[] }>("/api/cart/saved")]), ([c, sv]) => {
      setCart(c);
      setSaved(sv.items);
    }).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load your cart"));
  }, [track]);

  useEffect(() => {
    if (ready && user) load();
  }, [ready, user, load]);

  async function setQty(variantId: string, qty: number) {
    setBusy(variantId);
    try {
      await track(api<CartView>("/api/cart/items", { method: "PUT", body: { variant_id: variantId, qty } }), setCart);
      await refreshCart();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not update the cart", "error");
    } finally {
      setBusy(null);
    }
  }

  async function move(path: string, variantId: string, done: string) {
    setBusy(variantId);
    try {
      await track(api<{ cart: CartView; saved: { items: Saved[] } }>(path, { method: "POST" }), (r) => {
        setCart(r.cart);
        setSaved(r.saved.items);
      });
      await refreshCart();
      toast(done);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not update the cart", "error");
    } finally {
      setBusy(null);
    }
  }

  async function removeSaved(variantId: string) {
    try {
      setSaved((await api<{ items: Saved[] }>(`/api/cart/saved/${variantId}`, { method: "DELETE" })).items);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not delete", "error");
    }
  }

  if (!ready) return <PageLoader />;
  if (!user) return <><GuestCart /><div className="mt-4"><RecentlyViewedRail currentId="" /></div></>;
  if (error) return <ErrorNote message={error} />;
  if (!cart) return <PageLoader />;
  const savedBlock = <SavedForLater items={saved} busy={busy} onMove={(id) => move(`/api/cart/saved/${id}/move-to-cart`, id, "Moved to your cart")} onDelete={removeSaved} />;
  if (!cart.groups.length)
    return (
      <div className="flex flex-col gap-4">
        <EmptyState title="Your cart is empty" body={saved.length ? "Your saved items are below." : "Find something you like and add it here."} action={<ButtonLink href="/">Start shopping</ButtonLink>} />
        {savedBlock}
        <RecentlyViewedRail currentId="" />
      </div>
    );

  const s = cart.summary;
  const cannotBuy = s.has_problems || s.item_count === 0;
  const checkout = () => router.push("/checkout");
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-3">
          <CartHead count={s.item_count} subtotal={s.items_total} />
          {cart.groups.map((g) => (
            <SellerGroup key={g.seller.id} group={g} busy={busy} onQty={setQty}
              onSave={(id) => move(`/api/cart/items/${id}/save-for-later`, id, "Saved for later")} />
          ))}
        </div>
        <aside id="cart-bill" className={clsx(CARD, "flex scroll-mt-56 flex-col gap-4 sm:scroll-mt-44 lg:sticky lg:top-36")}>
          <BillDetails
            bill={{ mrp_total: s.mrp_total, items_total: s.items_total, item_count: s.item_count, shipping_total: s.shipping_total, fees: s.fees, fee_savings: s.fee_savings, grand_total: s.grand_total }}
            deliveryLabel={cart.checkout?.delivery_label}
            deliveryInfo={cart.checkout?.delivery_info}
            hints={cart.hints ?? []}
            totalLabel="Total"
          />
          {s.has_problems && <p className="rounded-xl bg-vermilion-light px-3 py-2 text-sm text-vermilion">Remove or update the items marked in red to continue.</p>}
          <Button ref={buyRef} variant="buy" size="lg" disabled={cannotBuy} onClick={checkout}>
            Proceed to buy
          </Button>
          <p className="text-center text-xs text-ink-faint">
            Prices include GST. {site.features.coupons ? "Apply coupons and choose how to pay at checkout." : "Choose how to pay at checkout."}
          </p>
        </aside>
      </div>
      {savedBlock}
      <RecentlyViewedRail currentId="" />
      <CheckoutBar watch={buyRef} total={s.grand_total} disabled={cannotBuy} onBuy={checkout} />
    </div>
  );
}
