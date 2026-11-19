"use client";

import clsx from "clsx";
import { BadgeCheck, Check, Gift, Headphones, RotateCcw, ShieldCheck, Truck, Wallet } from "lucide-react";
import Link from "next/link";
import { CategoryIcon } from "@/components/category-icon";
import {
  BuyAgainRail, CardRow, CountdownBanner, DealsRail, HeroCarousel, InspiredRail, SigninPrompt, SponsoredHomeRail, useViewed,
} from "@/components/home-blocks";
import { Markdown } from "@/components/markdown";
import { ProductGrid, ProductRail } from "@/components/product";
import { rupees } from "@/lib/format";
import type { HomeSectionData } from "@/lib/types";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";

const USP_ICONS = { badge: BadgeCheck, wallet: Wallet, truck: Truck, return: RotateCcw, shield: ShieldCheck, gift: Gift, support: Headphones, check: Check };

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
  const items = useViewed();
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

const SOURCE_LINK: Record<string, string> = {
  deals: "/deals?tab=discounts", deals_live: "/deals", bestsellers: "/bestsellers", top_rated: "/search?sort=rating", new: "/new-releases",
};

export function HomeSections({ sections }: { sections: HomeSectionData[] }) {
  const t = useT();
  // Amazon-style: the block after a "fade" banner rides up over its lower edge (computers only).
  const lifted = new Set(sections.filter((s, i) => i > 0 && s.kind !== "hero" && sections[i - 1].kind === "hero" && sections[i - 1].config.style === "fade").map((s) => s.id));
  return (
    <div className="flex flex-col gap-4">
      {sections.map((s) => {
        const vis = s.device === "mobile" ? "sm:hidden" : s.device === "desktop" ? "hidden sm:block" : "";
        let body: React.ReactNode = null;
        const c = s.config;
        switch (s.kind) {
          case "hero":
            body = <HeroCarousel slides={c.slides ?? []} autoplay={c.autoplay !== false} interval={c.interval ?? 5} style={c.style === "fade" ? "fade" : "boxed"} />;
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
          case "products": {
            const href = c.see_all || (c.source === "category" ? `/c/${c.category_slug}` : SOURCE_LINK[c.source]);
            if (c.layout === "grid") {
              body = (
                <section className="flex flex-col gap-3">
                  {s.title && (
                    <div className="flex items-baseline justify-between px-1">
                      <h2 className="text-xl font-semibold">{s.title}</h2>
                      {href && <Link href={href} className="text-sm font-semibold text-peacock hover:underline">See all</Link>}
                    </div>
                  )}
                  <ProductGrid items={s.products ?? []} showAdd={Boolean(c.show_add)} ranked={Boolean(c.ranked)} />
                </section>
              );
            } else {
              body = <ProductRail title={s.title} items={s.products ?? []} href={href} showAdd={Boolean(c.show_add)} ranked={Boolean(c.ranked)} />;
            }
            break;
          }
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
          case "cards":
            body = <CardRow cards={c.cards ?? []} />;
            break;
          case "deals":
            body = <DealsRail title={s.title} items={s.products ?? []} />;
            break;
          case "sponsored":
            body = <SponsoredHomeRail title={s.title} limit={c.limit ?? 10} />;
            break;
          case "countdown":
            body = <CountdownBanner title={s.title} cfg={c as Parameters<typeof CountdownBanner>[0]["cfg"]} />;
            break;
          case "signin":
            body = <SigninPrompt heading={c.heading ?? ""} text={c.text ?? ""} />;
            break;
          case "inspired":
            body = <InspiredRail title={s.title} limit={c.limit ?? 12} />;
            break;
          case "buy_again":
            body = <BuyAgainRail title={s.title} limit={c.limit ?? 12} />;
            break;
        }
        return body ? <div key={s.id} className={clsx(vis, lifted.has(s.id) && "relative z-10 lg:-mt-40")}>{body}</div> : null;
      })}
    </div>
  );
}
