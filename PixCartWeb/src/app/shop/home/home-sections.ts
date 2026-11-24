/*
 * The home page, built from the sections in Admin → Storefront → Home page, in the active theme's layout: sections on
 * white panels or straight on the page (theme "sections"), the category block as circles, cards, dense squares or text
 * chips (theme "categories", or the section's own choice), banners and blocks with images or videos.
 * Port of components/home-sections.tsx and app/(shop)/page.tsx (<pc-home-page>).
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from "@angular/core";
import { BadgeCheck, Check, Gift, Headphones, RotateCcw, ShieldCheck, Truck, Wallet, type LucideIconData } from "lucide-angular";
import { api } from "../../core/api";
import { rupees } from "../../core/format";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { CategoryNode, HomeSectionData } from "../../core/types";
import { readViewed } from "../../core/wishlist";
import { ThemeService } from "../../themes/context";
import type { ThemeLayout } from "../../themes/types";
import { CategoryIcon } from "../../shared/chrome/category-icon";
import { Markdown } from "../../shared/chrome/markdown";
import { ProductGrid, ProductRail } from "../../shared/product/product";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { HomeSkeleton } from "../../shared/ui/skeletons";
import { BuyAgainRail, CardRow, CountdownBanner, DealsRail, HeroCarousel, InspiredRail, SigninPrompt, SponsoredHomeRail } from "./home-blocks";
import { MediaBanner, MediaBlock } from "./home-media";

const USP_ICONS: Record<string, LucideIconData> = { badge: BadgeCheck, wallet: Wallet, truck: Truck, return: RotateCcw, shield: ShieldCheck, gift: Gift, support: Headphones, check: Check };

type CatStyle = ThemeLayout["home"]["categories"];

/** The section's own style wins; "auto" (and the old "tiles") means the theme's. */
export function categoryStyle(sectionStyle: unknown, themeStyle: CatStyle): CatStyle {
  return sectionStyle === "circles" || sectionStyle === "cards" || sectionStyle === "squares" || sectionStyle === "chips" ? sectionStyle : themeStyle;
}

@Component({
  selector: "pc-cat-picture",
  imports: [CategoryIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-center justify-center overflow-hidden" },
  template: `
    @if (cat().image_url) {<img [src]="cat().image_url" alt="" class="h-full w-full object-cover" />}
    @else {<svg [pcCategoryIcon]="cat().slug" [class]="iconClass()" />}
  `,
})
export class CatPicture {
  readonly cat = input.required<CategoryNode>();
  readonly iconClass = input("");
}

@Component({
  selector: "pc-home-categories",
  imports: [PcLink, CatPicture],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @switch (style()) {
      @case ("chips") {
        <div class="flex flex-wrap justify-center gap-2 sm:gap-3">
          @for (cat of cats(); track cat.slug) {
            <a [pcLink]="'/c/' + cat.slug" class="pc-press rounded-lg border border-line bg-white px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-ink hover:bg-mist">{{ cat.name }}</a>
          }
        </div>
      }
      @case ("cards") {
        <div class="grid grid-cols-3 gap-2.5 sm:grid-cols-4 sm:gap-4 md:grid-cols-6 lg:grid-cols-8">
          @for (cat of cats(); track cat.slug) {
            <a [pcLink]="'/c/' + cat.slug" class="pc-lift group flex flex-col items-center gap-2 rounded-xl bg-white p-2.5 text-center shadow-card sm:p-3">
              <pc-cat-picture [cat]="cat" class="aspect-square w-full rounded-lg bg-peacock-light text-peacock transition-transform duration-300 motion-safe:group-hover:scale-[1.03]" iconClass="h-9 w-9" />
              <span class="line-clamp-2 text-[13px] font-semibold leading-tight text-ink group-hover:text-peacock">{{ cat.name }}</span>
            </a>
          }
        </div>
      }
      @case ("squares") {
        <div class="grid grid-cols-4 gap-x-2 gap-y-3 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
          @for (cat of cats(); track cat.slug) {
            <a [pcLink]="'/c/' + cat.slug" class="group flex flex-col items-center gap-1.5 text-center">
              <pc-cat-picture [cat]="cat" class="pc-press aspect-square w-full rounded-2xl bg-peacock-light text-peacock ring-1 ring-peacock/10 transition-colors group-hover:bg-peacock/15" iconClass="h-8 w-8" />
              <span class="line-clamp-2 text-[12px] font-semibold leading-tight text-ink">{{ cat.name }}</span>
            </a>
          }
        </div>
      }
      @default {
        <div class="scroll-x flex gap-1 overflow-x-auto sm:grid sm:grid-cols-8 sm:overflow-visible">
          @for (cat of cats(); track cat.slug) {
            <a [pcLink]="'/c/' + cat.slug" class="flex w-[84px] shrink-0 flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-center hover:bg-mist sm:w-auto">
              <pc-cat-picture [cat]="cat" class="h-14 w-14 rounded-full bg-peacock-light text-peacock" iconClass="h-7 w-7" />
              <span class="text-[13px] font-medium leading-tight text-ink">{{ cat.name }}</span>
            </a>
          }
        </div>
      }
    }
  `,
})
export class HomeCategories {
  readonly cats = input.required<CategoryNode[]>();
  readonly style = input.required<CatStyle>();
}

const SOURCE_LINK: Record<string, string> = {
  deals: "/deals?tab=discounts", deals_live: "/deals", bestsellers: "/bestsellers", top_rated: "/search?sort=rating", new: "/new-releases",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
@Component({
  selector: "pc-home-sections",
  imports: [Icon, PcLink, HomeCategories, Markdown, ProductGrid, ProductRail, MediaBanner, MediaBlock,
    HeroCarousel, CardRow, DealsRail, SponsoredHomeRail, CountdownBanner, SigninPrompt, InspiredRail, BuyAgainRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "plain() ? 'flex flex-col gap-8 sm:gap-10' : 'flex flex-col gap-4'" },
  template: `
    @for (s of shown(); track s.id) {
      <div [class]="wrapCls(s)">
        @switch (s.kind) {
          @case ("hero") {
            <pc-hero-carousel [slides]="c(s).slides ?? []" [autoplay]="c(s).autoplay !== false" [interval]="c(s).interval ?? 5" [style]="c(s).style === 'fade' ? 'fade' : 'boxed'" />
          }
          @case ("categories") {
            <section [attr.aria-label]="s.title || 'Categories'" [class]="cx('shop-panel', !plain() && (catStyle(s) === 'circles' ? 'px-2 py-3' : 'p-4'))">
              @if (s.title) {
                <h2 [class]="cx('font-semibold', plain() ? 'text-2xl' : 'text-xl', 'mb-3', catStyle(s) === 'circles' && !plain() && 'px-2', catStyle(s) === 'chips' && 'text-center')">{{ s.title }}</h2>
              }
              <pc-home-categories [cats]="s.categories ?? []" [style]="catStyle(s)" />
            </section>
          }
          @case ("products") {
            @if (c(s).layout === "grid") {
              <section class="flex flex-col gap-3">
                @if (s.title) {
                  <div [class]="cx('flex items-baseline justify-between', !plain() && 'px-1')">
                    <h2 [class]="cx('font-semibold', plain() ? 'text-2xl' : 'text-xl')">{{ s.title }}</h2>
                    @if (href(s)) {<a [pcLink]="href(s)!" class="text-sm font-semibold text-peacock hover:underline">See all</a>}
                  </div>
                }
                <pc-product-grid [items]="s.products ?? []" [showAdd]="!!c(s).show_add" [ranked]="!!c(s).ranked" />
              </section>
            } @else {
              <pc-product-rail [title]="s.title" [items]="s.products ?? []" [href]="href(s)" [showAdd]="!!c(s).show_add" [ranked]="!!c(s).ranked" />
            }
          }
          @case ("banner") {<pc-media-banner [cfg]="$any(c(s))" />}
          @case ("banner_grid") {
            <section [class]="cx('grid gap-3', (c(s).items?.length ?? 0) >= 3 ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2')">
              @for (b of c(s).items ?? []; track $index) {<pc-media-banner [cfg]="b" [compact]="true" />}
            </section>
          }
          @case ("media") {<pc-media-block [cfg]="$any(c(s))" [title]="s.title" />}
          @case ("text") {
            <section [class]="cx('shop-panel', !plain() && 'p-6', c(s).align === 'center' && 'text-center')">
              @if (s.title) {<h2 class="mb-2 text-2xl font-semibold">{{ s.title }}</h2>}
              <pc-markdown [source]="t(c(s).markdown ?? '')" />
            </section>
          }
          @case ("usp") {
            <ul class="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line text-sm ring-1 ring-line sm:grid-cols-4">
              @for (it of c(s).items ?? []; track it.text) {
                <li class="flex items-center gap-2.5 bg-white px-4 py-3">
                  <svg [pcIcon]="uspIcon(it.icon)" class="h-5 w-5 shrink-0 text-peacock" />
                  <span class="text-ink-soft">{{ t(it.text) }}</span>
                </li>
              }
            </ul>
          }
          @case ("recent") {
            @if (viewed().length >= 2) {
            <section [class]="cx('shop-panel', !plain() && 'p-4')">
              <h2 [class]="cx('font-semibold', plain() ? 'text-2xl' : 'text-xl', 'mb-3')">{{ s.title || "Recently viewed" }}</h2>
              <div class="scroll-x flex gap-3 overflow-x-auto">
                @for (p of viewed(); track p.id) {
                  <a [pcLink]="'/p/' + p.slug" class="group w-32 shrink-0 sm:w-36">
                    <img [src]="p.image" [alt]="p.title" class="mb-1 aspect-square w-full rounded-lg bg-white object-contain ring-1 ring-line" />
                    <p class="line-clamp-2 text-sm group-hover:text-peacock">{{ p.title }}</p>
                    <p class="font-display font-bold">{{ fmt(p.price) }}</p>
                  </a>
                }
              </div>
            </section>
            }
          }
          @case ("cards") {<pc-card-row [cards]="c(s).cards ?? []" />}
          @case ("deals") {<pc-deals-rail [title]="s.title" [items]="s.products ?? []" />}
          @case ("sponsored") {<pc-sponsored-home-rail [title]="s.title" [limit]="c(s).limit ?? 10" />}
          @case ("countdown") {<pc-countdown-banner [title]="s.title" [cfg]="$any(c(s))" />}
          @case ("signin") {<pc-signin-prompt [heading]="c(s).heading ?? ''" [text]="c(s).text ?? ''" />}
          @case ("inspired") {<pc-inspired-rail [title]="s.title" [limit]="c(s).limit ?? 12" />}
          @case ("buy_again") {<pc-buy-again-rail [title]="s.title" [limit]="c(s).limit ?? 12" />}
        }
      </div>
    }
  `,
})
export class HomeSections {
  readonly sections = input.required<HomeSectionData[]>();
  private readonly site = inject(SiteService).site;
  private readonly layout = inject(ThemeService).layout;
  protected readonly cx = cx;
  protected readonly fmt = rupees;
  protected readonly viewed = signal(readViewed());
  protected readonly plain = computed(() => this.layout().home.sections === "plain");
  // Amazon-style: the block after a "fade" banner rides up over its lower edge (computers only).
  private readonly lifted = computed(() => {
    const ss = this.sections();
    return new Set(ss.filter((s, i) => i > 0 && s.kind !== "hero" && ss[i - 1].kind === "hero" && ss[i - 1].config["style"] === "fade").map((s) => s.id));
  });
  /** The reference leaves out the wrapper only when the block itself is null: empty category blocks and unknown kinds. */
  protected readonly shown = computed(() => this.sections().filter((s) => {
    if (s.kind === "categories") return (s.categories ?? []).length > 0;
    return ["hero", "products", "banner", "banner_grid", "media", "text", "usp", "recent", "cards", "deals", "sponsored", "countdown", "signin", "inspired", "buy_again"].includes(s.kind as string);
  }));

  protected c(s: HomeSectionData): any {
    return s.config;
  }
  protected catStyle(s: HomeSectionData): CatStyle {
    return categoryStyle(s.config["style"], this.layout().home.categories);
  }
  protected href(s: HomeSectionData): string | undefined {
    const c = s.config as any;
    return c.see_all || (c.source === "category" ? `/c/${c.category_slug}` : SOURCE_LINK[c.source]);
  }
  protected wrapCls(s: HomeSectionData): string {
    const vis = s.device === "mobile" ? "sm:hidden" : s.device === "desktop" ? "hidden sm:block" : "";
    return cx(vis, this.lifted().has(s.id) && "relative z-10 lg:-mt-40");
  }
  protected uspIcon(name: string): LucideIconData {
    return USP_ICONS[name] ?? Check;
  }
  protected t(x: string): string {
    return fillTokens(x, this.site());
  }
}

/** The home page (app/(shop)/page.tsx): the sections from /api/home. */
@Component({
  selector: "pc-home-page",
  imports: [HomeSections, HomeSkeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (state() === "loading") {
      <pc-home-skeleton />
    } @else if (state() === "error") {
      <p class="py-20 text-center text-ink-soft">The store is waking up. Refresh the page in a moment.</p>
    } @else {
      <pc-home-sections [sections]="sections()" />
    }
  `,
})
export class HomePage {
  protected readonly state = signal<"loading" | "ready" | "error">("loading");
  protected readonly sections = signal<HomeSectionData[]>([]);
  constructor() {
    api<{ sections: HomeSectionData[]; categories: CategoryNode[] }>("/api/home")
      .then((d) => { this.sections.set(d.sections); this.state.set("ready"); })
      .catch(() => this.state.set("error"));
  }
}
