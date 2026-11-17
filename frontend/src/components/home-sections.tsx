"use client";

import clsx from "clsx";
import { BadgeCheck, Check, ChevronLeft, ChevronRight, Gift, Headphones, RotateCcw, ShieldCheck, Truck, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CategoryIcon } from "@/components/category-icon";
import { Markdown } from "@/components/markdown";
import { ProductGrid, ProductRail } from "@/components/product";
import { rupees } from "@/lib/format";
import type { HomeSectionData } from "@/lib/types";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";
import { readViewed } from "@/lib/wishlist";

const USP_ICONS = { badge: BadgeCheck, wallet: Wallet, truck: Truck, return: RotateCcw, shield: ShieldCheck, gift: Gift, support: Headphones, check: Check };

function Hero({ slides, autoplay }: { slides: { image: string; link: string; heading: string; text: string; cta: string }[]; autoplay: boolean }) {
  const t = useT();
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!autoplay || paused || slides.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((x) => (x + 1) % slides.length), 5000);
    return () => clearInterval(t);
  }, [autoplay, paused, slides.length]);
  const s = slides[i];
  const go = (d: number) => setI((x) => (x + d + slides.length) % slides.length);
  return (
    <section className="relative overflow-hidden rounded-xl bg-peacock" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} aria-roledescription="carousel">
      <Link href={s.link || "#"} className="block">
        <div className="relative aspect-[16/7] w-full sm:aspect-[16/5]">
          {s.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.image} alt={s.heading ? "" : "Offer"} className="absolute inset-0 h-full w-full object-cover" />
          )}
          {s.heading && (
            <div className="absolute inset-0 flex flex-col justify-center gap-2 bg-gradient-to-r from-ink/60 to-transparent p-6 text-white sm:p-12">
              {s.heading && <p className="max-w-lg font-display text-2xl font-bold sm:text-5xl">{t(s.heading)}</p>}
              {s.text && <p className="max-w-md text-white/90 sm:text-lg">{t(s.text)}</p>}
            </div>
          )}
          {s.cta && (
            <span className="absolute bottom-4 left-6 rounded-lg bg-marigold px-4 py-2 text-sm font-semibold text-ink sm:bottom-8 sm:left-12 sm:text-base">{t(s.cta)}</span>
          )}
        </div>
      </Link>
      {slides.length > 1 && (
        <>
          <button onClick={() => go(-1)} className="absolute left-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/80 text-ink hover:bg-white sm:flex" aria-label="Previous slide">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button onClick={() => go(1)} className="absolute right-2 top-1/2 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/80 text-ink hover:bg-white sm:flex" aria-label="Next slide">
            <ChevronRight className="h-5 w-5" />
          </button>
          <div className="absolute bottom-2 right-3 flex gap-1.5">
            {slides.map((_, n) => (
              <button key={n} onClick={() => setI(n)} aria-label={`Slide ${n + 1}`} aria-current={n === i} className={clsx("h-2 rounded-full transition-all", n === i ? "w-6 bg-white" : "w-2 bg-white/60")} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Banner({ image, link, heading, text, cta, compact }: { image: string; link: string; heading?: string; text?: string; cta?: string; compact?: boolean }) {
  const t = useT();
  if (!image) return null;
  const body = (
    <div className="relative h-full w-full">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image} alt={heading ? "" : "Banner"} className="h-full w-full rounded-xl object-cover" />
      {(heading || text || cta) && (
        <div className={clsx("absolute inset-0 flex flex-col justify-center gap-1 rounded-xl bg-gradient-to-r from-ink/60 to-transparent text-white", compact ? "p-4" : "p-6 sm:p-10")}>
          {heading && <p className={clsx("max-w-md font-display font-bold", compact ? "text-xl" : "text-2xl sm:text-4xl")}>{t(heading)}</p>}
          {text && <p className={clsx("max-w-md text-white/90", compact ? "text-sm" : "sm:text-lg")}>{t(text)}</p>}
          {cta && <span className="mt-1 self-start rounded-lg bg-marigold px-3 py-1.5 text-sm font-semibold text-ink">{t(cta)}</span>}
        </div>
      )}
    </div>
  );
  if (!link) return <div className="overflow-hidden rounded-xl">{body}</div>;
  return link.startsWith("https://") ? (
    <a href={link} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl">{body}</a>
  ) : (
    <Link href={link} className="block overflow-hidden rounded-xl">{body}</Link>
  );
}

/** Storefront text with {brand} and {free_delivery_amount} filled in. */
function useT() {
  const site = useSite();
  return (x: string) => fillTokens(x, site);
}

function Recent({ title }: { title: string }) {
  const [items, setItems] = useState<ReturnType<typeof readViewed>>([]);
  useEffect(() => setItems(readViewed()), []);
  if (items.length < 2) return null;
  return (
    <section className="rounded-xl bg-white p-4">
      <h2 className="mb-3 text-xl font-semibold">{title || "Recently viewed"}</h2>
      <div className="scroll-x flex gap-3 overflow-x-auto">
        {items.map((p) => (
          <Link key={p.id} href={`/p/${p.slug}`} className="w-32 shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.image} alt={p.title} className="mb-1 aspect-square w-full rounded-lg bg-mist object-contain" />
            <p className="line-clamp-2 text-sm">{p.title}</p>
            <p className="font-display font-bold">{rupees(p.price)}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function HomeSections({ sections }: { sections: HomeSectionData[] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      {sections.map((s) => {
        const vis = s.device === "mobile" ? "sm:hidden" : s.device === "desktop" ? "hidden sm:block" : "";
        let body: React.ReactNode = null;
        const c = s.config;
        switch (s.kind) {
          case "hero":
            body = <Hero slides={c.slides ?? []} autoplay={c.autoplay !== false} />;
            break;
          case "categories":
            body = (
              <section aria-label={s.title || "Categories"} className="rounded-xl bg-white px-2 py-3">
                {s.title && <h2 className="mb-2 px-2 text-xl font-semibold">{s.title}</h2>}
                <div className={clsx("scroll-x flex gap-1 overflow-x-auto", c.style !== "chips" && "sm:grid sm:grid-cols-8 sm:overflow-visible")}>
                  {(s.categories ?? []).map((cat) =>
                    c.style === "chips" ? (
                      <Link key={cat.slug} href={`/c/${cat.slug}`} className="shrink-0 rounded-full bg-mist px-4 py-2 text-sm font-medium hover:bg-peacock-light">{cat.name}</Link>
                    ) : (
                      <Link key={cat.slug} href={`/c/${cat.slug}`} className="flex w-[84px] shrink-0 flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-center hover:bg-mist sm:w-auto">
                        <span className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-peacock-light text-peacock">
                          {cat.image_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={cat.image_url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <CategoryIcon slug={cat.slug} className="h-7 w-7" />
                          )}
                        </span>
                        <span className="text-[13px] font-medium leading-tight text-ink">{cat.name}</span>
                      </Link>
                    ),
                  )}
                </div>
              </section>
            );
            break;
          case "products":
            if (c.layout === "grid") {
              body = (
                <section className="flex flex-col gap-3">
                  {s.title && <h2 className="px-1 text-xl font-semibold">{s.title}</h2>}
                  <ProductGrid items={s.products ?? []} />
                </section>
              );
            } else {
              const href = c.source === "category" ? `/c/${c.category_slug}` : c.source === "deals" ? "/search?sort=discount" : c.source === "bestsellers" ? "/search?sort=popular" : c.source === "top_rated" ? "/search?sort=rating" : c.source === "new" ? "/search?sort=newest" : undefined;
              body = <ProductRail title={s.title} items={s.products ?? []} href={href} />;
            }
            break;
          case "banner":
            body = <Banner image={c.image} link={c.link} heading={c.heading} text={c.text} cta={c.cta} />;
            break;
          case "banner_grid":
            body = (
              <section className={clsx("grid gap-3", (c.items?.length ?? 0) >= 3 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2")}>
                {(c.items ?? []).map((b: { image: string; link: string; heading: string; text: string; cta: string }, n: number) => <Banner key={n} {...b} compact />)}
              </section>
            );
            break;
          case "text":
            body = (
              <section className={clsx("rounded-xl bg-white p-6", c.align === "center" && "text-center")}>
                {s.title && <h2 className="mb-2 text-2xl font-semibold">{s.title}</h2>}
                <Markdown source={t(c.markdown ?? "")} />
              </section>
            );
            break;
          case "usp":
            body = (
              <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line text-sm sm:grid-cols-4">
                {(c.items ?? []).map((it: { icon: keyof typeof USP_ICONS; text: string }) => {
                  const Icon = USP_ICONS[it.icon] ?? Check;
                  return (
                    <li key={it.text} className="flex items-center gap-2.5 bg-white px-4 py-3">
                      <Icon className="h-5 w-5 shrink-0 text-peacock" aria-hidden />
                      <span className="text-ink-soft">{t(it.text)}</span>
                    </li>
                  );
                })}
              </ul>
            );
            break;
          case "recent":
            body = <Recent title={s.title} />;
            break;
        }
        return body ? <div key={s.id} className={vis}>{body}</div> : null;
      })}
    </div>
  );
}
