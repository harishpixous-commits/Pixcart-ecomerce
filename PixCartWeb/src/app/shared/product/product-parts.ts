/*
 * Building blocks every theme's product tile uses (themes/<id>/product-tile.ts), so behaviour stays the same in every
 * theme: the deal badge and countdown, adding to the cart (with the stock and per-item limits and the "added" toast),
 * the link (ads go through the click counter), the rating, the price line and the delivery date.
 * Port of components/product-parts.tsx.
 */

import { ChangeDetectionStrategy, Component, Directive, Injectable, computed, inject, input, signal, type Signal } from "@angular/core";
import { Router } from "@angular/router";
import { ApiError } from "../../core/api";
import { date as fmtDate, rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import type { DealInfo, ProductCard as Card } from "../../core/types";
import { cx } from "../ui/cx";
import { Toast } from "../ui/ui";

/** One clock for every countdown on the page (ticks each second while something reads it). */
@Injectable({ providedIn: "root" })
export class Clock {
  readonly now = signal<number>(Date.now());
  constructor() {
    setInterval(() => this.now.set(Date.now()), 1000);
  }
}

function left(ms: number): string {
  if (ms <= 0) return "Ended";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  if (d >= 2) return `${d} days`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** "Ends in 02:13:44", ticking every second. */
@Component({
  selector: "pc-deal-countdown",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<span [class]="cls()">{{ text() }}</span>`,
})
export class DealCountdown {
  readonly endsAt = input.required<string>();
  readonly prefix = input("Ends in");
  readonly doneText = input("Deal ended");
  readonly cls = input<string>("", { alias: "spanClass" });
  private readonly now = inject(Clock).now;
  protected readonly text = computed(() => {
    const ms = new Date(this.endsAt()).getTime() - this.now();
    return ms > 0 ? `${this.prefix()} ${left(ms)}` : this.doneText();
  });
}

@Component({
  selector: "pc-deal-badge",
  imports: [DealCountdown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "size() === 'md' ? 'flex flex-col gap-1 gap-1.5' : 'flex flex-col gap-1'", "data-testid": "deal-badge" },
  template: `
    <div class="flex flex-wrap items-center gap-1.5">
      @if (discount() > 0) {<span [class]="size() === 'md' ? 'rounded bg-vermilion font-semibold text-white px-2 py-0.5 text-sm' : 'rounded bg-vermilion font-semibold text-white px-1.5 text-xs leading-5'">{{ discount() }}% off</span>}
      <span [class]="size() === 'md' ? 'font-semibold text-vermilion text-sm' : 'font-semibold text-vermilion text-xs'">{{ deal().label }}</span>
    </div>
    @if (deal().kind !== "limited" && deal().show_countdown !== false) {<pc-deal-countdown [endsAt]="deal().ends_at" [spanClass]="size() === 'md' ? 'font-medium text-vermilion text-sm' : 'font-medium text-vermilion text-xs'" />}
    @if (deal().claimed_pct !== null) {
      <div class="flex items-center gap-2">
        <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-vermilion-light"><span class="block h-full bg-vermilion" [style.width.%]="max4(deal().claimed_pct!)"></span></span>
        <span class="shrink-0 text-[11px] text-ink-faint">{{ deal().claimed_pct }}% claimed</span>
      </div>
    }
  `,
})
export class DealBadge {
  readonly deal = input.required<DealInfo>();
  readonly discount = input.required<number>();
  readonly size = input<"sm" | "md">("sm");
  protected max4(n: number) {
    return Math.max(4, n);
  }
}

/** Where a tile leads: ads go through the click counter (a plain link, so no false clicks). */
export function tileHref(p: Card): { href: string; external: boolean } {
  const external = Boolean(p.sponsored && p.href);
  return { href: external ? p.href! : `/p/${p.slug}`, external };
}

/** <a [pcTileLink]="p">: the product page, or the ad's click counter (a full page load, rel=sponsored). */
@Directive({
  selector: "a[pcTileLink]",
  host: { "[attr.href]": "target().href", "[attr.rel]": "target().external ? 'sponsored' : null", "(click)": "onClick($event)" },
})
export class TileLink {
  readonly pcTileLink = input.required<Card>();
  private readonly router = inject(Router);
  protected readonly target = computed(() => tileHref(this.pcTileLink()));
  onClick(e: MouseEvent): void {
    if (this.target().external || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void this.router.navigateByUrl(this.target().href);
  }
}

/** Adding one unit of a single-version product, with the cart's notices ("only 2 left") as a toast. Call in a field initialiser. */
export function quickAdd(card: Signal<Card>) {
  const session = inject(SessionService);
  const toast = inject(Toast);
  const busy = signal(false);
  const canAdd = computed(() => card().in_stock && Boolean(card().variant_id));
  /** products with several versions open the product page to choose one */
  const needsOptions = computed(() => card().in_stock && !card().variant_id);
  const optionsHref = computed(() => (card().href && !card().sponsored ? card().href! : `/p/${card().slug}`));
  async function add(e?: Event) {
    e?.preventDefault();
    e?.stopPropagation();
    const p = card();
    if (!canAdd() || busy()) return;
    busy.set(true);
    try {
      const note = await session.addToCart({ variant_id: p.variant_id!, qty: 1, title: p.title, image: p.image, price: p.price, mrp: p.mrp, slug: p.slug, variant_label: "", seller_name: p.seller_name });
      toast.show(note ?? "Added to your cart");
    } catch (x) {
      toast.show(x instanceof ApiError ? x.message : "Could not add to cart", "error");
    } finally {
      busy.set(false);
    }
  }
  return { add, busy, canAdd, needsOptions, optionsHref };
}

/** The rating chip: "4.3 ★ (1,204)". */
@Component({
  selector: "pc-tile-rating",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (p().rating_count > 0) {
      <p [class]="'flex items-center gap-1.5 ' + cls()">
        <span class="rounded bg-leaf px-1.5 text-xs font-semibold leading-5 text-white">{{ p().rating_avg.toFixed(1) }} ★</span>
        <span class="text-xs text-ink-faint">({{ p().rating_count.toLocaleString("en-IN") }})</span>
      </p>
    }
  `,
})
export class TileRating {
  readonly p = input.required<Card>();
  readonly cls = input<string>("", { alias: "ratingClass" });
}

/** Price, unit price, M.R.P. struck through and the discount. The caller's class goes on the host (the row). */
@Component({
  selector: "pc-tile-price",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-wrap items-baseline gap-x-1.5" },
  template: `
    <span [class]="priceClass()">{{ fmt(p().price) }}</span>
    @if (p().unit_price) {<span class="text-xs text-ink-soft">({{ fmt(p().unit_price!.paise) }}/{{ p().unit_price!.per }})</span>}
    @if (p().mrp > p().price) {<span class="text-sm text-ink-faint line-through">{{ fmt(p().mrp) }}</span>}
    @if (showDiscount() && p().discount_pct > 0 && !p().deal) {<span class="text-sm font-semibold text-leaf">{{ p().discount_pct }}% off</span>}
  `,
})
export class TilePrice {
  readonly p = input.required<Card>();
  readonly priceClass = input("font-display text-lg font-bold");
  readonly showDiscount = input(true);
  protected readonly fmt = rupees;
}

/** "Get it by Thu, 12 Dec" and, for a deal that has not started, when it starts. */
@Component({
  selector: "pc-tile-delivery",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (p().delivery_by) {<p class="text-xs text-ink-soft">Get it by <span class="font-semibold text-ink">{{ fmtDate(p().delivery_by) }}</span></p>}
    @if (p().starts_at) {<p class="text-xs font-semibold text-peacock">Starts {{ starts() }}</p>}
  `,
})
export class TileDelivery {
  readonly p = input.required<Card>();
  protected readonly fmtDate = fmtDate;
  protected readonly starts = computed(() => (this.p().starts_at ? new Date(this.p().starts_at!).toLocaleString("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""));
}

/** The product photo (or a blank square), with the "out of stock" band. The caller's class goes on the host. */
@Component({
  selector: "pc-tile-image",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative block overflow-hidden" },
  template: `
    @if (p().image) {
      <img [src]="p().image" [alt]="p().title" loading="lazy" [class]="imgCls()" />
    } @else {
      <div class="h-full w-full bg-mist"></div>
    }
    @if (!p().in_stock) {<span class="absolute inset-x-0 bottom-0 bg-ink/75 py-1 text-center text-xs font-semibold text-white">Out of stock</span>}
  `,
})
export class TileImage {
  readonly p = input.required<Card>();
  readonly imgClass = input<string>("");
  readonly fit = input<"contain" | "cover">("contain");
  protected readonly imgCls = computed(() =>
    cx("h-full w-full transition-transform duration-300 motion-safe:group-hover:scale-[1.03]", this.fit() === "cover" ? "object-cover" : "object-contain", this.imgClass()));
}

export const TILE_PARTS = [DealCountdown, DealBadge, TileLink, TileRating, TilePrice, TileDelivery, TileImage] as const;
