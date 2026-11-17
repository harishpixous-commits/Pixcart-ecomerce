import Link from "next/link";
import { rupees } from "@/lib/format";
import type { ProductCard as Card } from "@/lib/types";
import { WishlistHeart } from "@/lib/wishlist";

/* Server-safe (no hooks): used by server and client pages alike. */

export function ProductTile({ p }: { p: Card }) {
  return (
    <div className="relative h-full bg-white">
      <WishlistHeart productId={p.id} />
      <TileBody p={p} />
    </div>
  );
}

function TileBody({ p }: { p: Card }) {
  return (
    <Link href={`/p/${p.slug}`} className="group flex h-full flex-col bg-white p-3 outline-offset-[-2px] sm:p-4">
      <div className="relative mb-3 aspect-square overflow-hidden">
        {p.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.image} alt={p.title} loading="lazy" className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : (
          <div className="h-full w-full bg-mist" />
        )}
        {!p.in_stock && <span className="absolute inset-x-0 bottom-0 bg-ink/75 py-1 text-center text-xs font-semibold text-white">Out of stock</span>}
      </div>
      {p.brand && <p className="text-xs font-semibold text-ink-faint">{p.brand}</p>}
      <p className="line-clamp-2 text-[15px] leading-snug text-ink group-hover:text-peacock">{p.title}</p>
      {p.rating_count > 0 && (
        <p className="mt-1 flex items-center gap-1.5">
          <span className="rounded bg-leaf px-1.5 text-xs font-semibold leading-5 text-white">{p.rating_avg.toFixed(1)} ★</span>
          <span className="text-xs text-ink-faint">({p.rating_count.toLocaleString("en-IN")})</span>
        </p>
      )}
      <div className="mt-auto flex flex-wrap items-baseline gap-x-2 pt-2">
        <span className="font-display text-lg font-bold">{rupees(p.price)}</span>
        {p.mrp > p.price && <span className="text-sm text-ink-faint line-through">{rupees(p.mrp)}</span>}
        {p.discount_pct > 0 && <span className="text-sm font-semibold text-leaf">{p.discount_pct}% off</span>}
      </div>
    </Link>
  );
}

/** Products separated by hairlines (a gap-px grid on a line-coloured background), not floating cards. */
export function ProductGrid({ items, dense }: { items: Card[]; dense?: boolean }) {
  return (
    <div className={`grid gap-px overflow-hidden rounded-xl bg-line ${dense ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"}`}>
      {items.map((p) => (
        <ProductTile key={p.id} p={p} />
      ))}
    </div>
  );
}

export function ProductRail({ title, items, href }: { title: string; items: Card[]; href?: string }) {
  if (!items.length) return null;
  return (
    <section className="rounded-xl bg-white">
      <div className="flex items-center justify-between px-4 pb-1 pt-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        {href && (
          <Link href={href} className="text-sm font-semibold text-peacock hover:underline">
            View all
          </Link>
        )}
      </div>
      <div className="scroll-x flex snap-x overflow-x-auto">
        {items.map((p) => (
          <div key={p.id} className="w-[46%] shrink-0 snap-start border-r border-line last:border-r-0 sm:w-[30%] lg:w-[16.66%]">
            <ProductTile p={p} />
          </div>
        ))}
      </div>
    </section>
  );
}
