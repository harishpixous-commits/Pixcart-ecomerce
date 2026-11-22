"use client";

/*
 * The home page, built from the sections in Admin → Storefront → Home page, in the active theme's layout:
 * sections on white panels or straight on the page (theme "sections"), the category block as circles, cards, dense
 * squares or text chips (theme "categories", or the section's own choice), banners and blocks with images or videos.
 */

import clsx from "clsx";
import { BadgeCheck, Check, Gift, Headphones, RotateCcw, ShieldCheck, Truck, Wallet } from "lucide-react";
import Link from "next/link";
import { CategoryIcon } from "@/components/category-icon";
import {
  BuyAgainRail, CardRow, CountdownBanner, DealsRail, HeroCarousel, InspiredRail, SigninPrompt, SponsoredHomeRail, useViewed,
} from "@/components/home-blocks";
import { MediaBanner, MediaBlock, type BannerCfg, type MediaCfg } from "@/components/home-media";
import { Markdown } from "@/components/markdown";
import { ProductGrid, ProductRail } from "@/components/product";
import { rupees } from "@/lib/format";
import type { CategoryNode, HomeSectionData } from "@/lib/types";
import { useSite } from "@/lib/site";
import { fillTokens } from "@/lib/tokens";
import { useLayout } from "@/themes/context";
import type { ThemeLayout } from "@/themes/types";

const USP_ICONS = { badge: BadgeCheck, wallet: Wallet, truck: Truck, return: RotateCcw, shield: ShieldCheck, gift: Gift, support: Headphones, check: Check };

/** Storefront text with {brand} and {free_delivery_amount} filled in. */
function useT() {
  const site = useSite();
  return (x: string) => fillTokens(x, site);
}

/** A section heading: larger when sections sit straight on the page. */
function SectionTitle({ children, plain, className }: { children: React.ReactNode; plain: boolean; className?: string }) {
  return <h2 className={clsx("font-semibold", plain ? "text-2xl" : "text-xl", className)}>{children}</h2>;
}

function Recent({ title, plain }: { title: string; plain: boolean }) {
  const items = useViewed();
  if (items.length < 2) return null;
  return (
    <section className={clsx("shop-panel", !plain && "p-4")}>
      <SectionTitle plain={plain} className="mb-3">{title || "Recently viewed"}</SectionTitle>
      <div className="scroll-x flex gap-3 overflow-x-auto">
        {items.map((p) => (
          <Link key={p.id} href={`/p/${p.slug}`} className="group w-32 shrink-0 sm:w-36">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.image} alt={p.title} className="mb-1 aspect-square w-full rounded-lg bg-white object-contain ring-1 ring-line" />
            <p className="line-clamp-2 text-sm group-hover:text-peacock">{p.title}</p>
            <p className="font-display font-bold">{rupees(p.price)}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- categories in four styles */

type CatStyle = ThemeLayout["home"]["categories"];

/** The section's own style wins; "auto" (and the old "tiles") means the theme's. */
export function categoryStyle(sectionStyle: unknown, themeStyle: CatStyle): CatStyle {
  return sectionStyle === "circles" || sectionStyle === "cards" || sectionStyle === "squares" || sectionStyle === "chips" ? sectionStyle : themeStyle;
}

function CatPicture({ cat, className, iconClass }: { cat: CategoryNode; className?: string; iconClass?: string }) {
  return (
    <span className={clsx("flex items-center justify-center overflow-hidden", className)}>
      {cat.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={cat.image_url} alt="" className="h-full w-full object-cover" />
      ) : (
        <CategoryIcon slug={cat.slug} className={iconClass} />
      )}
    </span>
  );
}

function Categories({ cats, style }: { cats: CategoryNode[]; style: CatStyle }) {
  if (style === "chips") {
    return (
      <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
        {cats.map((cat) => (
          <Link key={cat.slug} href={`/c/${cat.slug}`}
            className="pc-press rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-ink hover:bg-mist">
            {cat.name}
          </Link>
        ))}
      </div>
    );
  }
  if (style === "cards") {
    return (
      <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 sm:gap-4 md:grid-cols-6 lg:grid-cols-8">
        {cats.map((cat) => (
          <Link key={cat.slug} href={`/c/${cat.slug}`} className="pc-lift group flex flex-col items-center gap-2 rounded-xl bg-white p-2.5 text-center shadow-card sm:p-3">
            <CatPicture cat={cat} className="aspect-square w-full rounded-lg bg-peacock-light text-peacock transition-transform duration-300 motion-safe:group-hover:scale-[1.03]" iconClass="h-9 w-9" />
            <span className="line-clamp-2 text-[13px] font-semibold leading-tight text-ink group-hover:text-peacock">{cat.name}</span>
          </Link>
        ))}
      </div>
    );
  }
  if (style === "squares") {
    return (
      <div className="grid grid-cols-4 gap-x-2 gap-y-3 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
        {cats.map((cat) => (
          <Link key={cat.slug} href={`/c/${cat.slug}`} className="group flex flex-col items-center gap-1.5 text-center">
            <CatPicture cat={cat} className="pc-press aspect-square w-full rounded-2xl bg-peacock-light text-peacock ring-1 ring-peacock/10 transition-colors group-hover:bg-peacock/15" iconClass="h-8 w-8" />
            <span className="line-clamp-2 text-[12px] font-semibold leading-tight text-ink">{cat.name}</span>
          </Link>
        ))}
      </div>
    );
  }
  // circles: the original look
  return (
    <div className="scroll-x flex gap-1 overflow-x-auto sm:grid sm:grid-cols-8 sm:overflow-visible">
      {cats.map((cat) => (
        <Link key={cat.slug} href={`/c/${cat.slug}`} className="flex w-[84px] shrink-0 flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-center hover:bg-mist sm:w-auto">
          <CatPicture cat={cat} className="h-14 w-14 rounded-full bg-peacock-light text-peacock" iconClass="h-7 w-7" />
          <span className="text-[13px] font-medium leading-tight text-ink">{cat.name}</span>
        </Link>
      ))}
    </div>
  );
}

const SOURCE_LINK: Record<string, string> = {
  deals: "/deals?tab=discounts", deals_live: "/deals", bestsellers: "/bestsellers", top_rated: "/search?sort=rating", new: "/new-releases",
};

export function HomeSections({ sections }: { sections: HomeSectionData[] }) {
  const t = useT();
  const layout = useLayout();
  const plain = layout.home.sections === "plain";
  // Amazon-style: the block after a "fade" banner rides up over its lower edge (computers only).
  const lifted = new Set(sections.filter((s, i) => i > 0 && s.kind !== "hero" && sections[i - 1].kind === "hero" && sections[i - 1].config.style === "fade").map((s) => s.id));
  return (
    <div className={clsx("flex flex-col", plain ? "gap-8 sm:gap-10" : "gap-4")}>
      {sections.map((s) => {
        const vis = s.device === "mobile" ? "sm:hidden" : s.device === "desktop" ? "hidden sm:block" : "";
        let body: React.ReactNode = null;
        const c = s.config;
        switch (s.kind as HomeSectionData["kind"] | "media") {
          case "hero":
            body = <HeroCarousel slides={c.slides ?? []} autoplay={c.autoplay !== false} interval={c.interval ?? 5} style={c.style === "fade" ? "fade" : "boxed"} />;
            break;
          case "categories": {
            const style = categoryStyle(c.style, layout.home.categories);
            body = (s.categories ?? []).length ? (
              <section aria-label={s.title || "Categories"} className={clsx("shop-panel", !plain && (style === "circles" ? "px-2 py-3" : "p-4"))}>
                {s.title && <SectionTitle plain={plain} className={clsx("mb-3", style === "circles" && !plain && "px-2", style === "chips" && "text-center")}>{s.title}</SectionTitle>}
                <Categories cats={s.categories ?? []} style={style} />
              </section>
            ) : null;
            break;
          }
          case "products": {
            const href = c.see_all || (c.source === "category" ? `/c/${c.category_slug}` : SOURCE_LINK[c.source]);
            if (c.layout === "grid") {
              body = (
                <section className="flex flex-col gap-3">
                  {s.title && (
                    <div className={clsx("flex items-baseline justify-between", !plain && "px-1")}>
                      <SectionTitle plain={plain}>{s.title}</SectionTitle>
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
            body = <MediaBanner {...(c as BannerCfg)} />;
            break;
          case "banner_grid":
            body = (
              <section className={clsx("grid gap-3", (c.items?.length ?? 0) >= 3 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2")}>
                {(c.items ?? []).map((b: BannerCfg, n: number) => <MediaBanner key={n} {...b} compact />)}
              </section>
            );
            break;
          case "media":
            body = <MediaBlock cfg={c as MediaCfg} title={s.title} />;
            break;
          case "text":
            body = (
              <section className={clsx("shop-panel", !plain && "p-6", c.align === "center" && "text-center")}>
                {s.title && <h2 className="mb-2 text-2xl font-semibold">{s.title}</h2>}
                <Markdown source={t(c.markdown ?? "")} />
              </section>
            );
            break;
          case "usp":
            body = (
              <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line text-sm ring-1 ring-line sm:grid-cols-4">
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
            body = <Recent title={s.title} plain={plain} />;
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
