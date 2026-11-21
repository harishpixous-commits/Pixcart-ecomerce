"use client";

/*
 * Product cards and rails used across the store: search, categories, home blocks, deals, bestsellers, product pages.
 * A card shows the running deal (with a live countdown and how much of a lightning deal is claimed), the bestseller
 * rank, "Sponsored" for ads, unit price, "bought in the past month", the delivery date for the shopper's PIN code
 * and, where asked, an Add to cart button for single-version products.
 */

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Plus, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { date as fmtDate, rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { DealInfo, ProductCard as Card } from "@/lib/types";
import { WishlistHeart } from "@/lib/wishlist";

function left(ms: number): string {
  if (ms <= 0) return "Ended";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  if (d >= 2) return `${d} days`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** "Ends in 02:13:44", ticking every second (rendered after hydration so server and browser agree). */
export function DealCountdown({ endsAt, prefix = "Ends in", doneText = "Deal ended", className }: { endsAt: string; prefix?: string; doneText?: string; className?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, []);
  if (now === null) return <span className={className}>&nbsp;</span>;
  const ms = new Date(endsAt).getTime() - now;
  return <span className={className} suppressHydrationWarning>{ms > 0 ? `${prefix} ${left(ms)}` : doneText}</span>;
}

export function DealBadge({ deal, discount, size = "sm" }: { deal: DealInfo; discount: number; size?: "sm" | "md" }) {
  const timed = deal.kind !== "limited";
  return (
    <div className={clsx("flex flex-col gap-1", size === "md" && "gap-1.5")} data-testid="deal-badge">
      <div className="flex flex-wrap items-center gap-1.5">
        {discount > 0 && <span className={clsx("rounded bg-vermilion font-semibold text-white", size === "md" ? "px-2 py-0.5 text-sm" : "px-1.5 text-xs leading-5")}>{discount}% off</span>}
        <span className={clsx("font-semibold text-vermilion", size === "md" ? "text-sm" : "text-xs")}>{deal.label}</span>
      </div>
      {timed && <DealCountdown endsAt={deal.ends_at} className={clsx("font-medium text-vermilion", size === "md" ? "text-sm" : "text-xs")} />}
      {deal.claimed_pct !== null && (
        <div className="flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-vermilion-light"><span className="block h-full bg-vermilion" style={{ width: `${Math.max(4, deal.claimed_pct)}%` }} /></span>
          <span className="shrink-0 text-[11px] text-ink-faint">{deal.claimed_pct}% claimed</span>
        </div>
      )}
    </div>
  );
}

function QuickAdd({ p, compact }: { p: Card; compact?: boolean }) {
  const { addToCart } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!p.in_stock) return null;
  if (!p.variant_id) {
    return compact ? null : <Link href={p.href && !p.sponsored ? p.href : `/p/${p.slug}`} className="mt-2 block rounded-full border border-line py-1.5 text-center text-sm font-semibold hover:bg-mist">See options</Link>;
  }
  async function add(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      const note = await addToCart({ variant_id: p.variant_id!, qty: 1, title: p.title, image: p.image, price: p.price, mrp: p.mrp, slug: p.slug, variant_label: "", seller_name: p.seller_name });
      toast(note ?? "Added to your cart");
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not add to cart", "error");
    } finally {
      setBusy(false);
    }
  }
  if (compact) {
    return (
      <button type="button" onClick={add} disabled={busy} aria-label={`Add ${p.title} to cart`} data-testid="quick-add"
        className="absolute bottom-2 right-2 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-marigold text-ink shadow-md ring-2 ring-white hover:bg-marigold-dark disabled:opacity-60">
        <Plus className="h-5 w-5" />
      </button>
    );
  }
  return (
    <button type="button" onClick={add} disabled={busy} data-testid="quick-add"
      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full bg-marigold py-1.5 text-sm font-semibold text-ink hover:bg-marigold-dark disabled:opacity-60">
      <ShoppingCart className="h-4 w-4" /> {busy ? "Adding…" : "Add to cart"}
    </button>
  );
}

export function ProductTile({ p, showAdd, rank, quickPlus }: { p: Card; showAdd?: boolean; rank?: number; quickPlus?: boolean }) {
  // Ads go through the click counter (a plain link, so it is never prefetched and counted by mistake).
  const external = Boolean(p.sponsored && p.href);
  const href = external ? p.href! : `/p/${p.slug}`;
  const body = (
    <>
      <div className="relative mb-2 aspect-square overflow-hidden rounded-lg bg-white">
        {p.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image} alt={p.title} loading="lazy" className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.04]" />
        ) : (
          <div className="h-full w-full bg-mist" />
        )}
        {rank !== undefined && <span className="absolute left-0 top-0 rounded-br-lg bg-marigold px-2 py-0.5 text-sm font-bold text-ink">#{rank}</span>}
        {!p.in_stock && <span className="absolute inset-x-0 bottom-0 bg-ink/75 py-1 text-center text-xs font-semibold text-white">Out of stock</span>}
      </div>
      {p.sponsored && <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint" data-testid="sponsored-label">Sponsored</p>}
      {p.brand && <p className="text-xs font-semibold text-ink-faint">{p.brand}</p>}
      <p className="line-clamp-2 text-[15px] leading-snug text-ink group-hover:text-peacock">{p.title}</p>
      {p.rating_count > 0 && (
        <p className="mt-1 flex items-center gap-1.5">
          <span className="rounded bg-leaf px-1.5 text-xs font-semibold leading-5 text-white">{p.rating_avg.toFixed(1)} ★</span>
          <span className="text-xs text-ink-faint">({p.rating_count.toLocaleString("en-IN")})</span>
        </p>
      )}
      {p.bought && <p className="mt-0.5 text-xs text-ink-soft">{p.bought}</p>}
      {p.deal && <div className="mt-1.5"><DealBadge deal={p.deal} discount={p.discount_pct} /></div>}
      <div className="mt-auto flex flex-wrap items-baseline gap-x-1.5 pt-1.5">
        <span className="font-display text-lg font-bold">{rupees(p.price)}</span>
        {p.unit_price && <span className="text-xs text-ink-soft">({rupees(p.unit_price.paise)}/{p.unit_price.per})</span>}
        {p.mrp > p.price && <span className="text-sm text-ink-faint line-through">{rupees(p.mrp)}</span>}
        {p.discount_pct > 0 && !p.deal && <span className="text-sm font-semibold text-leaf">{p.discount_pct}% off</span>}
      </div>
      {p.delivery_by && <p className="text-xs text-ink-soft">Get it by <span className="font-semibold text-ink">{fmtDate(p.delivery_by)}</span></p>}
      {p.starts_at && <p className="text-xs font-semibold text-peacock">Starts {new Date(p.starts_at).toLocaleString("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit" })}</p>}
    </>
  );
  const cls = "group flex h-full flex-col bg-white p-3 outline-offset-[-2px] sm:p-4";
  return (
    <div className="relative flex h-full flex-col bg-white" data-testid="product-tile">
      <WishlistHeart productId={p.id} />
      {external ? <a href={href} className={cls} rel="sponsored">{body}</a> : <Link href={href} className={cls}>{body}</Link>}
      {quickPlus && <QuickAdd p={p} compact />}
      {showAdd && <div className="px-3 pb-3 sm:px-4 sm:pb-4"><QuickAdd p={p} /></div>}
    </div>
  );
}

/** Products separated by hairlines (a gap-px grid on a line-coloured background), not floating cards. */
export function ProductGrid({ items, dense, showAdd, ranked }: { items: Card[]; dense?: boolean; showAdd?: boolean; ranked?: boolean }) {
  return (
    <div className={`grid gap-px overflow-hidden rounded-xl bg-line ${dense ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"}`}>
      {items.map((p, i) => (
        <ProductTile key={`${p.id}-${i}`} p={p} showAdd={showAdd} rank={ranked ? i + 1 : undefined} />
      ))}
    </div>
  );
}

/** A horizontal row with arrow buttons (desktop) and swipe (phones). */
export function ProductRail({ title, items, href, linkText = "See all", showAdd, ranked, note, extra }: {
  title: string; items: Card[]; href?: string; linkText?: string; showAdd?: boolean; ranked?: boolean; note?: string; extra?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const update = () => {
    const el = box.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = requestAnimationFrame(update);
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { cancelAnimationFrame(first); el.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [items.length]);
  if (!items.length) return null;
  const go = (d: number) => box.current?.scrollBy({ left: d * box.current.clientWidth * 0.9, behavior: "smooth" });
  return (
    <section className="rounded-xl bg-white" aria-label={title}>
      <div className="flex items-baseline justify-between gap-3 px-4 pb-1 pt-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-xl font-semibold">{title}</h2>
          {note && <span className="text-xs text-ink-faint">{note}</span>}
          {extra}
        </div>
        {href && <Link href={href} className="shrink-0 text-sm font-semibold text-peacock hover:underline">{linkText}</Link>}
      </div>
      <div className="group/rail relative">
        <div ref={box} className="scroll-x flex snap-x overflow-x-auto">
          {items.map((p, i) => (
            <div key={`${p.id}-${i}`} className="w-[46%] shrink-0 snap-start border-r border-line last:border-r-0 sm:w-[30%] lg:w-[16.66%]">
              <ProductTile p={p} showAdd={showAdd} rank={ranked ? i + 1 : undefined} />
            </div>
          ))}
        </div>
        {!edges.start && (
          <button type="button" onClick={() => go(-1)} aria-label="Scroll left" className="absolute left-0 top-1/3 hidden h-20 w-10 items-center justify-center rounded-r-lg bg-white/95 shadow-md ring-1 ring-line hover:bg-mist lg:flex">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {!edges.end && (
          <button type="button" onClick={() => go(1)} aria-label="Scroll right" className="absolute right-0 top-1/3 hidden h-20 w-10 items-center justify-center rounded-l-lg bg-white/95 shadow-md ring-1 ring-line hover:bg-mist lg:flex">
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </section>
  );
}
