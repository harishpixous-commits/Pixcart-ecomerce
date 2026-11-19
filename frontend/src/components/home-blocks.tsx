"use client";

/*
 * Home page blocks beyond the basics: the carousel, Amazon-style card rows, the deals rail with its timer, sponsored
 * products, countdown banners, the sign-in prompt for visitors, "Inspired by your browsing history" and "Buy it again".
 * Every block is added, ordered, scheduled and edited in Admin → Storefront → Home page.
 */

import clsx from "clsx";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DealCountdown, ProductRail } from "@/components/product";
import { api } from "@/lib/api";
import { rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";
import type { ProductCard } from "@/lib/types";
import { readViewed } from "@/lib/wishlist";

type Viewed = ReturnType<typeof readViewed>;
const noSubscribe = () => () => {};

/** Products this shopper viewed, read from the browser after hydration. */
export function useViewed(): Viewed {
  const raw = useSyncExternalStore(noSubscribe, () => JSON.stringify(readViewed()), () => "[]");
  return useMemo(() => JSON.parse(raw) as Viewed, [raw]);
}

function useT() {
  const site = useSite();
  return (x: string) => fillTokens(x ?? "", site);
}

/** Loads a product list once (signed-in only when `auth`). */
function useProducts(url: string | null): ProductCard[] | null {
  const [state, setState] = useState<{ url: string; items: ProductCard[] } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    api<{ items: ProductCard[] }>(url).then((r) => { if (live) setState({ url, items: r.items }); }).catch(() => { if (live) setState({ url, items: [] }); });
    return () => { live = false; };
  }, [url]);
  return url && state?.url === url ? state.items : null;
}

/* ---------------------------------------------------------------- hero carousel */

export type Slide = { image: string; image_mobile?: string; link: string; heading: string; text: string; cta: string; offer?: string; note?: string; theme?: "light" | "dark"; align?: "left" | "center" };

export function HeroCarousel({ slides, autoplay, interval = 5, style = "boxed" }: { slides: Slide[]; autoplay: boolean; interval?: number; style?: "boxed" | "fade" }) {
  const t = useT();
  const [i, setI] = useState(0);
  const [hover, setHover] = useState(false);
  const [stopped, setStopped] = useState(false);
  const touch = useRef<number | null>(null);
  const reduced = useSyncExternalStore(
    (cb) => { const m = window.matchMedia("(prefers-reduced-motion: reduce)"); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const playing = autoplay && !stopped && !hover && !reduced && slides.length > 1;
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setI((x) => (x + 1) % slides.length), Math.max(3, interval) * 1000);
    return () => clearInterval(id);
  }, [playing, interval, slides.length]);
  if (!slides.length) return null;
  const s = slides[Math.min(i, slides.length - 1)];
  const go = (d: number) => setI((x) => (x + d + slides.length) % slides.length);
  const dark = s.theme === "dark";
  const fade = style === "fade";
  const content = (
    <div className={clsx("relative w-full", fade ? "aspect-[16/9] sm:aspect-[16/6]" : "aspect-[16/8] sm:aspect-[16/5]")}>
      {s.image && (
        <picture>
          {s.image_mobile && <source media="(max-width: 640px)" srcSet={s.image_mobile} />}
          <img src={s.image} alt={s.heading ? "" : "Offer"} className="absolute inset-0 h-full w-full object-cover" />
        </picture>
      )}
      {(s.heading || s.text) && (
        <div className={clsx("absolute inset-0 flex flex-col justify-center gap-2 p-6 sm:p-12", s.align === "center" ? "items-center text-center" : "items-start",
          dark ? "text-ink" : "bg-gradient-to-r from-ink/60 via-ink/20 to-transparent text-white", fade && "pb-16 sm:pb-40")}>
          {s.heading && <p className="max-w-xl font-display text-2xl font-bold leading-tight sm:text-5xl">{t(s.heading)}</p>}
          {s.text && <p className={clsx("max-w-md sm:text-lg", dark ? "text-ink-soft" : "text-white/90")}>{t(s.text)}</p>}
          {s.cta && <span className="mt-2 rounded-lg bg-marigold px-4 py-2 text-sm font-semibold text-ink shadow sm:text-base">{t(s.cta)}</span>}
          {fade && (s.offer || s.note) && (
            <span className="mt-1 flex flex-wrap items-center gap-2">
              {s.offer && <span className="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-semibold text-ink shadow sm:text-sm">{t(s.offer)}</span>}
              {s.note && <span className={clsx("text-[11px]", dark ? "text-ink-soft" : "text-white/80")}>{t(s.note)}</span>}
            </span>
          )}
        </div>
      )}
      {!fade && (s.offer || s.note) && (
        <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-center justify-between gap-2 sm:inset-x-12">
          {s.offer && <span className="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-semibold text-ink shadow sm:text-sm">{t(s.offer)}</span>}
          {s.note && <span className={clsx("text-[11px]", dark ? "text-ink-soft" : "text-white/80")}>{t(s.note)}</span>}
        </div>
      )}
      {fade && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-b from-transparent to-mist" />}
    </div>
  );
  return (
    <section className={clsx("relative overflow-hidden bg-peacock", fade ? "-mx-3 sm:-mx-4 sm:-mt-6" : "rounded-xl")} aria-roledescription="carousel" aria-label="Offers"
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => { if (touch.current !== null) { const dx = e.changedTouches[0].clientX - touch.current; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); } touch.current = null; }}>
      {s.link ? (s.link.startsWith("https://") ? <a href={s.link} target="_blank" rel="noopener noreferrer" className="block">{content}</a> : <Link href={s.link} className="block">{content}</Link>) : content}
      {slides.length > 1 && (
        <>
          <button type="button" onClick={() => go(-1)} aria-label="Previous slide"
            className={clsx("absolute left-2 hidden h-12 w-10 items-center justify-center rounded-lg bg-white/80 text-ink hover:bg-white sm:flex", fade ? "top-[30%]" : "top-1/2 -translate-y-1/2")}>
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button type="button" onClick={() => go(1)} aria-label="Next slide"
            className={clsx("absolute right-2 hidden h-12 w-10 items-center justify-center rounded-lg bg-white/80 text-ink hover:bg-white sm:flex", fade ? "top-[30%]" : "top-1/2 -translate-y-1/2")}>
            <ChevronRight className="h-6 w-6" />
          </button>
          <div className={clsx("absolute right-3 flex items-center gap-1.5", fade ? "top-3" : "bottom-2")}>
            {autoplay && (
              <button type="button" onClick={() => setStopped((x) => !x)} aria-label={stopped ? "Play slides" : "Pause slides"} className="mr-1 flex h-6 w-6 items-center justify-center rounded-full bg-ink/60 text-white hover:bg-ink">
                {stopped ? <Play className="h-3 w-3 fill-white" /> : <Pause className="h-3 w-3 fill-white" />}
              </button>
            )}
            {slides.map((_, n) => (
              <button key={n} type="button" onClick={() => setI(n)} aria-label={`Slide ${n + 1}`} aria-current={n === i}
                className={clsx("h-2 rounded-full transition-all", n === i ? "w-6 bg-white" : "w-2 bg-white/60")} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- card row ("quad cards") */

type Tile = { image: string; label: string; link: string; badge: string };
type CardCfg = { title: string; link: string; link_text: string; mode: "tiles" | "products" | "recent" | "buy_again"; tiles?: Tile[]; products?: ProductCard[] };

function TileGrid({ tiles }: { tiles: Tile[] }) {
  const t = useT();
  if (tiles.length === 1) {
    const x = tiles[0];
    return (
      <Link href={x.link || "#"} className="group relative block flex-1 overflow-hidden rounded-lg bg-mist">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {x.image && <img src={x.image} alt={x.label} className="aspect-square h-full w-full object-cover transition group-hover:scale-[1.02]" />}
        {x.badge && <span className="absolute bottom-2 left-2 rounded-full bg-marigold px-2.5 py-1 text-xs font-bold text-ink shadow">{t(x.badge)}</span>}
        {x.label && <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/70 to-transparent p-2 pt-6 text-sm font-semibold text-white">{t(x.label)}</span>}
      </Link>
    );
  }
  return (
    <div className="grid flex-1 grid-cols-2 gap-3">
      {tiles.map((x, n) => (
        <Link key={n} href={x.link || "#"} className="group flex flex-col gap-1">
          <span className="relative block aspect-square overflow-hidden rounded-lg bg-mist">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {x.image && <img src={x.image} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.03]" />}
            {x.badge && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-marigold px-2 py-0.5 text-[11px] font-bold text-ink shadow">{t(x.badge)}</span>}
          </span>
          {x.label && <span className="line-clamp-1 text-[13px] text-ink group-hover:text-peacock">{t(x.label)}</span>}
        </Link>
      ))}
    </div>
  );
}

type QuadItem = { slug: string; title: string; image: string; price: number; discount_pct?: number; deal?: ProductCard["deal"] };

function ProductQuad({ items }: { items: QuadItem[] }) {
  return (
    <div className="grid flex-1 grid-cols-2 gap-3">
      {items.slice(0, 4).map((p) => (
        <Link key={p.slug} href={`/p/${p.slug}`} className="group flex flex-col gap-1">
          <span className="block aspect-square overflow-hidden rounded-lg bg-mist p-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {p.image && <img src={p.image} alt="" className="h-full w-full object-contain mix-blend-multiply transition group-hover:scale-[1.04]" />}
          </span>
          {p.deal || (p.discount_pct ?? 0) > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {(p.discount_pct ?? 0) > 0 && <span className="rounded bg-vermilion px-1 text-[11px] font-semibold leading-4 text-white">{p.discount_pct}% off</span>}
              {p.deal && <span className="text-[11px] font-semibold text-vermilion">{p.deal.label}</span>}
            </span>
          ) : null}
          <span className="line-clamp-1 text-[13px] text-ink group-hover:text-peacock">{p.title}</span>
          <span className="text-[13px] font-semibold">{rupees(p.price)}</span>
        </Link>
      ))}
    </div>
  );
}

export function CardRow({ cards }: { cards: CardCfg[] }) {
  const t = useT();
  const { user, ready } = useSession();
  const viewed = useViewed();
  const wantsBuyAgain = cards.some((c) => c.mode === "buy_again");
  const again = useProducts(ready && user && wantsBuyAgain ? "/api/orders/buy-again?limit=4" : null);
  const shown = cards.map((c): (CardCfg & { items: QuadItem[] }) | null => {
    if (c.mode === "recent") return viewed.length ? { ...c, items: viewed } : null;
    if (c.mode === "buy_again") return again && again.length ? { ...c, items: again } : null;
    if (c.mode === "products") return c.products?.length ? { ...c, items: c.products } : null;
    return c.tiles?.length ? { ...c, items: [] } : null;
  }).filter((c): c is CardCfg & { items: QuadItem[] } => c !== null);
  if (!shown.length) return null;
  return (
    <section className={clsx("grid gap-4", shown.length >= 4 ? "sm:grid-cols-2 lg:grid-cols-4" : shown.length === 3 ? "sm:grid-cols-3" : shown.length === 2 ? "sm:grid-cols-2" : "")} data-testid="card-row">
      {shown.map((c, n) => (
        <article key={n} className="flex flex-col gap-3 rounded-xl bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold leading-snug">{t(c.title)}</h2>
          {c.mode === "tiles" ? <TileGrid tiles={c.tiles ?? []} /> : <ProductQuad items={c.items} />}
          {c.link ? <Link href={c.link} className="mt-auto text-sm font-semibold text-peacock hover:underline">{t(c.link_text || "See more")}</Link>
            : c.mode === "recent" ? <span className="mt-auto text-xs text-ink-faint">Only you can see this</span> : null}
        </article>
      ))}
    </section>
  );
}

/* ---------------------------------------------------------------- deals, sponsored, personal rails */

export function DealsRail({ title, items }: { title: string; items: ProductCard[] }) {
  const soonest = items.map((p) => p.deal?.ends_at).filter((x): x is string => Boolean(x)).sort()[0];
  return (
    <ProductRail title={title || "Today's deals"} items={items} href="/deals" linkText="See all deals"
      extra={soonest ? <span className="rounded-full bg-vermilion-light px-2.5 py-0.5 text-sm font-semibold text-vermilion"><DealCountdown endsAt={soonest} /></span> : undefined} />
  );
}

export function SponsoredHomeRail({ title, limit }: { title: string; limit: number }) {
  const items = useProducts(`/api/ads/serve?placement=home&limit=${limit}`);
  if (!items || !items.length) return null;
  return <ProductRail title={title || "Sponsored products"} items={items} note="Sponsored" />;
}

export function InspiredRail({ title, limit }: { title: string; limit: number }) {
  const viewed = useViewed();
  const ids = viewed.slice(0, 10).map((v) => v.id).join(",");
  const items = useProducts(ids ? `/api/catalog/related?ids=${ids}&limit=${limit}` : null);
  if (!items || !items.length) return null;
  return <ProductRail title={title || "Inspired by your browsing history"} items={items} />;
}

export function BuyAgainRail({ title, limit }: { title: string; limit: number }) {
  const { user, ready } = useSession();
  const items = useProducts(ready && user ? `/api/orders/buy-again?limit=${limit}` : null);
  if (!items || !items.length) return null;
  return <ProductRail title={title || "Buy it again"} items={items} showAdd />;
}

/* ---------------------------------------------------------------- countdown banner and sign-in prompt */

function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);
  return now;
}

const TONE = { buy: "bg-vermilion text-white", accent: "bg-marigold text-ink", primary: "bg-peacock text-white", dark: "bg-ink text-white" };

export function CountdownBanner({ title, cfg }: { title: string; cfg: { heading: string; text: string; ends_at: string; link: string; cta: string; image: string; tone: keyof typeof TONE } }) {
  const t = useT();
  const now = useNow();
  const end = new Date(cfg.ends_at).getTime();
  if (now !== null && end <= now) return null;
  const left = now === null ? 0 : Math.max(0, Math.floor((end - now) / 1000));
  const parts: [string, number][] = [["Days", Math.floor(left / 86400)], ["Hours", Math.floor((left % 86400) / 3600)], ["Mins", Math.floor((left % 3600) / 60)], ["Secs", left % 60]];
  const body = (
    <div className={clsx("flex flex-col items-center gap-4 overflow-hidden rounded-xl p-5 sm:flex-row sm:p-8", TONE[cfg.tone] ?? TONE.buy)} data-testid="countdown-banner">
      <div className="flex flex-1 flex-col gap-2 text-center sm:text-left">
        <p className="font-display text-2xl font-bold sm:text-3xl">{t(cfg.heading || title)}</p>
        {cfg.text && <p className="opacity-90">{t(cfg.text)}</p>}
        <div className="mt-1 flex justify-center gap-2 sm:justify-start" aria-live="off">
          {parts.map(([label, v]) => (
            <span key={label} className="flex min-w-[56px] flex-col items-center rounded-lg bg-white/15 px-2 py-1.5 ring-1 ring-white/25">
              <span className="font-display text-2xl font-bold tabular-nums" suppressHydrationWarning>{now === null ? "--" : String(v).padStart(2, "0")}</span>
              <span className="text-[10px] uppercase tracking-wide opacity-80">{label}</span>
            </span>
          ))}
        </div>
        {cfg.cta && <span className="mt-2 self-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-ink shadow sm:self-start">{t(cfg.cta)}</span>}
      </div>
      {cfg.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cfg.image} alt="" className="h-32 w-auto max-w-[280px] rounded-lg object-cover sm:h-40" />
      )}
    </div>
  );
  return cfg.link ? <Link href={cfg.link} className="block">{body}</Link> : body;
}

export function SigninPrompt({ heading, text }: { heading: string; text: string }) {
  const site = useSite();
  const { user, ready } = useSession();
  if (!ready || user || site.home_extras?.signin_prompt === false) return null;
  return (
    <section className="flex flex-col items-center gap-2 rounded-xl bg-white px-4 py-6 text-center" data-testid="signin-prompt">
      <p className="text-lg font-semibold">{heading || "See personalised recommendations"}</p>
      {text && <p className="max-w-md text-sm text-ink-soft">{text}</p>}
      <Link href="/login" className="mt-1 w-full max-w-[260px] rounded-full bg-marigold py-2 font-semibold text-ink hover:bg-marigold-dark">Sign in</Link>
      <p className="text-xs text-ink-soft">New customer? <Link href="/signup" className="font-semibold text-peacock hover:underline">Start here.</Link></p>
    </section>
  );
}
