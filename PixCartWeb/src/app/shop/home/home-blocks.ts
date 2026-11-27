/*
 * Home page blocks beyond the basics: the carousel, Amazon-style card rows, the deals rail with its timer, sponsored
 * products, countdown banners, the sign-in prompt for visitors, "Inspired by your browsing history" and "Buy it again".
 * Port of components/home-blocks.tsx.
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-angular";
import { api } from "../../core/api";
import { rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { ProductCard } from "../../core/types";
import { readViewed } from "../../core/wishlist";
import { MediaFill, reducedMotion } from "../../shared/chrome/media";
import { Clock } from "../../shared/product/product-parts";
import { DealCountdown, ProductRail } from "../../shared/product/product";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

type Viewed = ReturnType<typeof readViewed>;

/** Products this shopper viewed, read from the browser. */
export function viewed(): Viewed {
  return readViewed();
}

/** Loads a product list once (null until loaded; [] on failure). */
function productsFrom(url: () => string | null) {
  const state = signal<{ url: string; items: ProductCard[] } | null>(null);
  effect(() => {
    const u = url();
    if (!u) return;
    api<{ items: ProductCard[] }>(u).then((r) => state.set({ url: u, items: r.items })).catch(() => state.set({ url: u, items: [] }));
  });
  return computed(() => {
    const u = url();
    const s = state();
    return u && s?.url === u ? s.items : null;
  });
}

/* ---------------------------------------------------------------- hero carousel */

export type Slide = { image: string; image_mobile?: string; video?: string; link: string; heading: string; text: string; cta: string; offer?: string; note?: string; theme?: "light" | "dark"; align?: "left" | "center" };

@Component({
  selector: "pc-hero-carousel",
  imports: [Icon, PcLink, MediaFill, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (slides().length) {
      <ng-template #content>
        <div [class]="fade() ? 'relative w-full aspect-[4/3] sm:aspect-[16/6] xl:aspect-auto xl:h-[560px]' : 'relative w-full aspect-[16/11] sm:aspect-[16/5] xl:aspect-auto xl:h-[440px]'">
          @if (s().video) {
            <pc-media-fill [image]="s().image" [video]="s().video" [alt]="s().heading ? '' : 'Offer'" [eager]="i() === 0" [playing]="!stopped()" mediaClass="absolute inset-0" />
          } @else if (s().image) {
            <picture>
              @if (s().image_mobile) {<source media="(max-width: 640px)" [attr.srcset]="s().image_mobile" />}
              <img [src]="s().image" [alt]="s().heading ? '' : 'Offer'" class="absolute inset-0 h-full w-full object-cover" />
            </picture>
          }
          @if (s().heading || s().text) {
            <div [class]="cx('absolute inset-0 flex flex-col justify-center gap-2 px-5 py-6 sm:px-16 sm:py-12 lg:px-20', s().align === 'center' ? 'items-center text-center' : 'items-start',
              dark() ? 'text-ink' : 'bg-gradient-to-r from-ink/60 via-ink/20 to-transparent text-white', fade() && 'pb-8 sm:pb-40')">
              @if (s().heading) {<p class="max-w-xl font-display text-2xl font-bold leading-tight sm:text-5xl">{{ t(s().heading) }}</p>}
              @if (s().text) {<p [class]="dark() ? 'max-w-md sm:text-lg text-ink-soft' : 'max-w-md sm:text-lg text-white/90'">{{ t(s().text) }}</p>}
              @if (s().cta) {<span class="mt-2 rounded-lg bg-marigold px-4 py-2 text-sm font-semibold text-ink shadow sm:text-base">{{ t(s().cta) }}</span>}
              @if (fade() && (s().offer || s().note)) {
                <span class="mt-1 flex flex-wrap items-center gap-2">
                  @if (s().offer) {<span class="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-semibold text-ink shadow sm:text-sm">{{ t(s().offer) }}</span>}
                  @if (s().note) {<span [class]="dark() ? 'text-[11px] text-ink-soft' : 'text-[11px] text-white/80'">{{ t(s().note) }}</span>}
                </span>
              }
            </div>
          }
          @if (!fade() && (s().offer || s().note)) {
            <div class="absolute inset-x-3 bottom-3 flex flex-wrap items-center justify-between gap-2 sm:inset-x-12">
              @if (s().offer) {<span class="rounded-lg bg-white/95 px-3 py-1.5 text-xs font-semibold text-ink shadow sm:text-sm">{{ t(s().offer) }}</span>}
              @if (s().note) {<span [class]="dark() ? 'text-[11px] text-ink-soft' : 'text-[11px] text-white/80'">{{ t(s().note) }}</span>}
            </div>
          }
          @if (fade()) {<div aria-hidden="true" class="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-b from-transparent to-mist"></div>}
        </div>
      </ng-template>
      <section [class]="fade() ? 'relative overflow-hidden bg-peacock -mx-3 sm:-mx-4 sm:-mt-6' : 'relative overflow-hidden bg-peacock rounded-xl'" aria-roledescription="carousel" aria-label="Offers"
        (mouseenter)="hover.set(true)" (mouseleave)="hover.set(false)" (touchstart)="touchStart($event)" (touchend)="touchEnd($event)">
        @if (s().link) {
          @if (s().link.startsWith("https://")) {
            <a [href]="s().link" target="_blank" rel="noopener noreferrer" class="block"><ng-container *ngTemplateOutlet="content" /></a>
          } @else {
            <a [pcLink]="s().link" class="block"><ng-container *ngTemplateOutlet="content" /></a>
          }
        } @else {
          <ng-container *ngTemplateOutlet="content" />
        }
        @if (slides().length > 1) {
          <button type="button" (click)="go(-1)" aria-label="Previous slide"
            [class]="cx('pc-press absolute left-2 hidden h-12 w-10 items-center justify-center rounded-lg bg-white/80 text-ink hover:bg-white sm:flex', fade() ? 'top-[30%]' : 'top-1/2 -translate-y-1/2')">
            <svg [pcIcon]="ChevronLeft" class="h-6 w-6" />
          </button>
          <button type="button" (click)="go(1)" aria-label="Next slide"
            [class]="cx('pc-press absolute right-2 hidden h-12 w-10 items-center justify-center rounded-lg bg-white/80 text-ink hover:bg-white sm:flex', fade() ? 'top-[30%]' : 'top-1/2 -translate-y-1/2')">
            <svg [pcIcon]="ChevronRight" class="h-6 w-6" />
          </button>
        }
        @if (slides().length > 1 || hasVideo()) {
          <div [class]="fade() ? 'absolute right-3 flex items-center gap-1.5 top-3' : 'absolute right-3 flex items-center gap-1.5 bottom-2'">
            @if ((autoplay() && slides().length > 1) || hasVideo()) {
              <button type="button" (click)="stopped.set(!stopped())" [attr.aria-pressed]="stopped()"
                [attr.aria-label]="hasVideo() ? (stopped() ? 'Play' : 'Pause') : stopped() ? 'Play slides' : 'Pause slides'"
                class="mr-1 flex h-6 w-6 items-center justify-center rounded-full bg-ink/60 text-white hover:bg-ink">
                <svg [pcIcon]="stopped() ? Play : Pause" class="h-3 w-3 fill-white" />
              </button>
            }
            @if (slides().length > 1) {
              @for (x of slides(); track $index) {
                <button type="button" (click)="i.set($index)" [attr.aria-label]="'Slide ' + ($index + 1)" [attr.aria-current]="$index === i()"
                  [class]="$index === i() ? 'h-2 rounded-full transition-all w-6 bg-white' : 'h-2 rounded-full transition-all w-2 bg-white/60'"></button>
              }
            }
          </div>
        }
      </section>
    }
  `,
})
export class HeroCarousel {
  readonly slides = input.required<Slide[]>();
  readonly autoplay = input(true);
  readonly interval = input(5);
  readonly style = input<"boxed" | "fade">("boxed");
  private readonly site = inject(SiteService).site;
  private readonly reduced = reducedMotion();
  protected readonly i = signal(0);
  protected readonly hover = signal(false);
  protected readonly stopped = signal(false);
  private touch: number | null = null;
  protected readonly cx = cx;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;
  protected readonly Pause = Pause;
  protected readonly Play = Play;
  protected readonly fade = computed(() => this.style() === "fade");
  protected readonly s = computed(() => this.slides()[Math.min(this.i(), this.slides().length - 1)]);
  protected readonly dark = computed(() => this.s().theme === "dark");
  protected readonly hasVideo = computed(() => this.slides().some((x) => x.video));
  private readonly playing = computed(() => this.autoplay() && !this.stopped() && !this.hover() && !this.reduced() && this.slides().length > 1);

  constructor() {
    effect((onCleanup) => {
      if (!this.playing()) return;
      const n = this.slides().length;
      const id = setInterval(() => this.i.update((x) => (x + 1) % n), Math.max(3, this.interval()) * 1000);
      onCleanup(() => clearInterval(id));
    });
  }

  protected t(x: string | undefined): string {
    return fillTokens(x ?? "", this.site());
  }
  protected go(d: number): void {
    const n = this.slides().length;
    this.i.update((x) => (x + d + n) % n);
  }
  protected touchStart(e: TouchEvent): void {
    this.touch = e.touches[0].clientX;
  }
  protected touchEnd(e: TouchEvent): void {
    if (this.touch !== null) {
      const dx = e.changedTouches[0].clientX - this.touch;
      if (Math.abs(dx) > 40) this.go(dx < 0 ? 1 : -1);
    }
    this.touch = null;
  }
}

/* ---------------------------------------------------------------- card row ("quad cards") */

type Tile = { image: string; video?: string; label: string; link: string; badge: string };
type CardCfg = { title: string; link: string; link_text: string; mode: "tiles" | "products" | "recent" | "buy_again"; tiles?: Tile[]; products?: ProductCard[] };
type QuadItem = { slug: string; title: string; image: string; price: number; discount_pct?: number; deal?: ProductCard["deal"] };

/** A tile's picture, or its video that plays only while pointed at or focused. */
@Component({
  selector: "pc-tile-media",
  imports: [MediaFill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (x().video) {
      <span class="contents" (mouseenter)="active.set(true)" (mouseleave)="active.set(false)" (focusin)="active.set(true)" (focusout)="active.set(false)">
        <pc-media-fill [image]="x().image" [video]="x().video" [alt]="alt()" [playing]="active()" [mediaClass]="cls()" />
      </span>
    } @else if (x().image) {
      <img [src]="x().image" [alt]="alt()" [class]="cls()" />
    }
  `,
})
export class TileMedia {
  readonly x = input.required<Tile>();
  readonly alt = input("");
  readonly cls = input<string>("", { alias: "mediaClass" });
  protected readonly active = signal(false);
}

@Component({
  selector: "pc-card-row",
  imports: [PcLink, TileMedia],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (shown().length) {
      <section [class]="gridCls()" data-testid="card-row">
        @for (c of shown(); track $index) {
          <article class="flex flex-col gap-3 rounded-xl bg-white p-4 shadow-card">
            <h2 class="text-lg font-semibold leading-snug">{{ t(c.title) }}</h2>
            @if (c.mode === "tiles") {
              @if (c.tiles!.length === 1) {
                <a [pcLink]="c.tiles![0].link || '#'" class="group relative block flex-1 overflow-hidden rounded-lg bg-mist">
                  <pc-tile-media [x]="c.tiles![0]" [alt]="c.tiles![0].label" mediaClass="aspect-square h-full w-full object-cover transition motion-safe:group-hover:scale-[1.02]" />
                  @if (c.tiles![0].badge) {<span class="absolute bottom-2 left-2 rounded-full bg-marigold px-2.5 py-1 text-xs font-bold text-ink shadow">{{ t(c.tiles![0].badge) }}</span>}
                  @if (c.tiles![0].label) {<span class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/70 to-transparent p-2 pt-6 text-sm font-semibold text-white">{{ t(c.tiles![0].label) }}</span>}
                </a>
              } @else {
                <div class="grid flex-1 grid-cols-2 gap-3">
                  @for (x of c.tiles!; track $index) {
                    <a [pcLink]="x.link || '#'" class="group flex flex-col gap-1">
                      <span class="relative block aspect-square overflow-hidden rounded-lg bg-mist">
                        <pc-tile-media [x]="x" mediaClass="h-full w-full object-cover transition motion-safe:group-hover:scale-[1.03]" />
                        @if (x.badge) {<span class="absolute bottom-1.5 left-1.5 rounded-full bg-marigold px-2 py-0.5 text-[11px] font-bold text-ink shadow">{{ t(x.badge) }}</span>}
                      </span>
                      @if (x.label) {<span class="line-clamp-1 text-[13px] text-ink group-hover:text-peacock">{{ t(x.label) }}</span>}
                    </a>
                  }
                </div>
              }
            } @else {
              <div class="grid flex-1 grid-cols-2 gap-3">
                @for (p of c.items.slice(0, 4); track p.slug) {
                  <a [pcLink]="'/p/' + p.slug" class="group flex flex-col gap-1">
                    <span class="block aspect-square overflow-hidden rounded-lg bg-mist p-1.5">
                      @if (p.image) {<img [src]="p.image" alt="" class="h-full w-full object-contain mix-blend-multiply transition group-hover:scale-[1.04]" />}
                    </span>
                    @if (p.deal || (p.discount_pct ?? 0) > 0) {
                      <span class="flex flex-wrap items-center gap-1">
                        @if ((p.discount_pct ?? 0) > 0) {<span class="rounded bg-vermilion px-1 text-[11px] font-semibold leading-4 text-white">{{ p.discount_pct }}% off</span>}
                        @if (p.deal) {<span class="text-[11px] font-semibold text-vermilion">{{ p.deal.label }}</span>}
                      </span>
                    }
                    <span class="line-clamp-1 text-[13px] text-ink group-hover:text-peacock">{{ p.title }}</span>
                    <span class="text-[13px] font-semibold">{{ fmt(p.price) }}</span>
                  </a>
                }
              </div>
            }
            @if (c.link) {
              <a [pcLink]="c.link" class="mt-auto text-sm font-semibold text-peacock hover:underline">{{ t(c.link_text || "See more") }}</a>
            } @else if (c.mode === "recent") {
              <span class="mt-auto text-xs text-ink-faint">Only you can see this</span>
            }
          </article>
        }
      </section>
    }
  `,
})
export class CardRow {
  readonly cards = input.required<CardCfg[]>();
  private readonly site = inject(SiteService).site;
  private readonly session = inject(SessionService);
  private readonly viewed = signal(viewed());
  protected readonly fmt = rupees;
  private readonly again = productsFrom(() => (this.session.ready() && this.session.user() && this.cards().some((c) => c.mode === "buy_again") ? "/api/orders/buy-again?limit=4" : null));
  protected readonly shown = computed(() => this.cards().map((c): (CardCfg & { items: QuadItem[] }) | null => {
    if (c.mode === "recent") return this.viewed().length ? { ...c, items: this.viewed() } : null;
    if (c.mode === "buy_again") { const a = this.again(); return a && a.length ? { ...c, items: a } : null; }
    if (c.mode === "products") return c.products?.length ? { ...c, items: c.products } : null;
    return c.tiles?.length ? { ...c, items: [] } : null;
  }).filter((c): c is CardCfg & { items: QuadItem[] } => c !== null));
  protected readonly gridCls = computed(() => {
    const n = this.shown().length;
    return cx("grid gap-4", n >= 4 ? "sm:grid-cols-2 lg:grid-cols-4" : n === 3 ? "sm:grid-cols-3" : n === 2 ? "sm:grid-cols-2" : "");
  });
  protected t(x: string | undefined): string {
    return fillTokens(x ?? "", this.site());
  }
}

/* ---------------------------------------------------------------- deals, sponsored, personal rails */

@Component({
  selector: "pc-deals-rail",
  imports: [ProductRail, DealCountdown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-product-rail [title]="title() || 'Today\\'s deals'" [items]="items()" href="/deals" linkText="See all deals">
      @if (soonest()) {<span extra class="rounded-full bg-vermilion-light px-2.5 py-0.5 text-sm font-semibold text-vermilion"><pc-deal-countdown [endsAt]="soonest()!" /></span>}
    </pc-product-rail>
  `,
})
export class DealsRail {
  readonly title = input("");
  readonly items = input.required<ProductCard[]>();
  protected readonly soonest = computed(() => this.items().filter((p) => p.deal?.show_countdown !== false).map((p) => p.deal?.ends_at).filter((x): x is string => Boolean(x)).sort()[0]);
}

@Component({
  selector: "pc-sponsored-home-rail",
  imports: [ProductRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (items()?.length) {<pc-product-rail [title]="title() || 'Sponsored products'" [items]="items()!" note="Sponsored" />}`,
})
export class SponsoredHomeRail {
  readonly title = input("");
  readonly limit = input(10);
  protected readonly items = productsFrom(() => `/api/ads/serve?placement=home&limit=${this.limit()}`);
}

@Component({
  selector: "pc-inspired-rail",
  imports: [ProductRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (items()?.length) {<pc-product-rail [title]="title() || 'Inspired by your browsing history'" [items]="items()!" />}`,
})
export class InspiredRail {
  readonly title = input("");
  readonly limit = input(12);
  private readonly ids = viewed().slice(0, 10).map((v) => v.id).join(",");
  protected readonly items = productsFrom(() => (this.ids ? `/api/catalog/related?ids=${this.ids}&limit=${this.limit()}` : null));
}

@Component({
  selector: "pc-buy-again-rail",
  imports: [ProductRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (items()?.length) {<pc-product-rail [title]="title() || 'Buy it again'" [items]="items()!" [showAdd]="true" />}`,
})
export class BuyAgainRail {
  readonly title = input("");
  readonly limit = input(12);
  private readonly session = inject(SessionService);
  protected readonly items = productsFrom(() => (this.session.ready() && this.session.user() ? `/api/orders/buy-again?limit=${this.limit()}` : null));
}

/* ---------------------------------------------------------------- countdown banner and sign-in prompt */

const TONE: Record<string, string> = { buy: "bg-vermilion text-white", accent: "bg-marigold text-ink", primary: "bg-peacock text-white", dark: "bg-ink text-white" };
type CountdownCfg = { heading: string; text: string; ends_at: string; link: string; cta: string; image: string; tone: string };

@Component({
  selector: "pc-countdown-banner",
  imports: [PcLink, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (end() > now()) {
      <ng-template #body>
        <div [class]="'flex flex-col items-center gap-4 overflow-hidden rounded-xl p-5 sm:flex-row sm:p-8 ' + (TONE[cfg().tone] ?? TONE['buy'])" data-testid="countdown-banner">
          <div class="flex flex-1 flex-col gap-2 text-center sm:text-left">
            <p class="font-display text-2xl font-bold sm:text-3xl">{{ t(cfg().heading || title()) }}</p>
            @if (cfg().text) {<p class="opacity-90">{{ t(cfg().text) }}</p>}
            <div class="mt-1 flex justify-center gap-2 sm:justify-start" aria-live="off">
              @for (part of parts(); track part[0]) {
                <span class="flex min-w-[56px] flex-col items-center rounded-lg bg-white/15 px-2 py-1.5 ring-1 ring-white/25">
                  <span class="font-display text-2xl font-bold tabular-nums">{{ pad(part[1]) }}</span>
                  <span class="text-[10px] uppercase tracking-wide opacity-80">{{ part[0] }}</span>
                </span>
              }
            </div>
            @if (cfg().cta) {<span class="mt-2 self-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-ink shadow sm:self-start">{{ t(cfg().cta) }}</span>}
          </div>
          @if (cfg().image) {<img [src]="cfg().image" alt="" class="h-32 w-auto max-w-[280px] rounded-lg object-cover sm:h-40" />}
        </div>
      </ng-template>
      @if (cfg().link) {
        <a [pcLink]="cfg().link" class="block"><ng-container *ngTemplateOutlet="body" /></a>
      } @else {
        <ng-container *ngTemplateOutlet="body" />
      }
    }
  `,
})
export class CountdownBanner {
  readonly title = input("");
  readonly cfg = input.required<CountdownCfg>();
  private readonly site = inject(SiteService).site;
  protected readonly now = inject(Clock).now;
  protected readonly TONE = TONE;
  protected readonly end = computed(() => new Date(this.cfg().ends_at).getTime());
  protected readonly parts = computed<[string, number][]>(() => {
    const left = Math.max(0, Math.floor((this.end() - this.now()) / 1000));
    return [["Days", Math.floor(left / 86400)], ["Hours", Math.floor((left % 86400) / 3600)], ["Mins", Math.floor((left % 3600) / 60)], ["Secs", left % 60]];
  });
  protected pad(v: number): string {
    return String(v).padStart(2, "0");
  }
  protected t(x: string | undefined): string {
    return fillTokens(x ?? "", this.site());
  }
}

@Component({
  selector: "pc-signin-prompt",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (session.ready() && !session.user() && site().home_extras?.signin_prompt !== false) {
      <section class="flex flex-col items-center gap-2 rounded-xl bg-white px-4 py-6 text-center" data-testid="signin-prompt">
        <p class="text-lg font-semibold">{{ heading() || "See personalised recommendations" }}</p>
        @if (text()) {<p class="max-w-md text-sm text-ink-soft">{{ text() }}</p>}
        <a pcLink="/login" class="mt-1 w-full max-w-[260px] rounded-full bg-marigold py-2 font-semibold text-ink hover:bg-marigold-dark">Sign in</a>
        <p class="text-xs text-ink-soft">New customer? <a pcLink="/signup" class="font-semibold text-peacock hover:underline">Start here.</a></p>
      </section>
    }
  `,
})
export class SigninPrompt {
  readonly heading = input("");
  readonly text = input("");
  protected readonly site = inject(SiteService).site;
  protected readonly session = inject(SessionService);
}

export const HOME_BLOCKS = [HeroCarousel, CardRow, DealsRail, SponsoredHomeRail, InspiredRail, BuyAgainRail, CountdownBanner, SigninPrompt] as const;
