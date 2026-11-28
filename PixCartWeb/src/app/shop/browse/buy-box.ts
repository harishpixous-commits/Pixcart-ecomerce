/*
 * The product page's main block: the gallery, what the product is (title, rating, price, offers, options, highlights)
 * and the buy box (delivery for the shopper's PIN code, stock, quantity, add to cart / buy now, seller details).
 * Port of frontend/src/app/(shop)/p/[slug]/buy-box.tsx.
 */

import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal, untracked, viewChild,
} from "@angular/core";
import { Router } from "@angular/router";
import { Award, BadgeCheck, Banknote, ChevronLeft, ChevronRight, Clock, MapPin, Package, X } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { date as fmtDate, rupees } from "../../core/format";
import { PincodeService, isPincode, setPincode } from "../../core/pincode";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import type { ProductPage, ProductVideo, PublicVariant } from "../../core/types";
import { rememberViewed } from "../../core/wishlist";
import { CompareToggle } from "../../shared/chrome/compare";
import { DealBadge } from "../../shared/product/product-parts";
import { WishlistHeart } from "../../shared/product/wishlist-heart";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, Toast } from "../../shared/ui/ui";
import { ThemeService } from "../../themes/context";
import type { ThemeLayout } from "../../themes/types";
import {
  AboutThisItem, AskAboutProduct, KeySpecs, NotifyMe, OffersBlock, RecentlyViewedRail, ReportProduct, SellerSnapshotCard, ServiceIcons, ShareButton,
  StickyBuyBar, UnitPrice,
} from "./pdp";
import { ProductGallery } from "./product-gallery";
import { CustomerMediaStrip, Stars } from "./reviews";

/** The product page's columns per theme layout: Classic's three columns, two columns, or a large gallery. */
const PDP_GRID: Record<ThemeLayout["pdp"]["layout"], string> = {
  three: "lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]",
  two: "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]",
  gallery: "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]",
};

@Component({
  selector: "pc-gallery",
  imports: [ProductGallery],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-product-gallery [images]="images()" [videos]="shownVideos()" [title]="title()" [zoom]="site().gallery?.zoom ?? true" [zoomLevel]="site().gallery?.zoom_level ?? 2.5" />`,
})
export class Gallery {
  readonly images = input.required<string[]>();
  readonly videos = input<ProductVideo[] | undefined>(undefined);
  readonly title = input.required<string>();
  protected readonly site = inject(SiteService).site;
  protected readonly shownVideos = computed(() => (this.site().features.product_videos === false ? [] : this.videos() ?? []));
}

/**
 * The "Large gallery" product page (computers): every photo large in a two-column grid, the first across both
 * columns, then the videos; a photo opens full screen (arrows, Escape to close).
 */
@Component({
  selector: "pc-gallery-grid",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="grid grid-cols-2 gap-3" data-testid="pdp-gallery-grid">
      @for (src of images(); track src + i; let i = $index) {
        <button type="button" (click)="open.set(i)" [attr.aria-label]="'View photo ' + (i + 1) + ' of ' + images().length + ' full screen'"
          [class]="i === 0 ? 'group overflow-hidden rounded-xl bg-white ring-1 ring-line col-span-2 aspect-[4/3]' : 'group overflow-hidden rounded-xl bg-white ring-1 ring-line aspect-square'">
          <img [src]="src" [alt]="i === 0 ? title() : ''" [attr.loading]="i < 3 ? 'eager' : 'lazy'" class="h-full w-full object-contain p-4 transition-transform duration-500 motion-safe:group-hover:scale-[1.03]" />
        </button>
      }
      @for (v of shown(); track v.url) {
        <video [src]="v.url" [attr.poster]="v.poster_url || null" controls playsinline preload="metadata" [attr.aria-label]="v.title || title() + ' video'"
          class="col-span-2 aspect-video w-full rounded-xl bg-black object-contain"></video>
      }
    </div>
    @if (open() !== null) {
      <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4" role="dialog" aria-modal="true" [attr.aria-label]="title() + ': photo ' + (open()! + 1) + ' of ' + images().length"
        (click)="backdrop($event)">
        <img [src]="images()[open()!]" [alt]="title()" class="max-h-full max-w-full object-contain" />
        <button #closeBtn type="button" (click)="open.set(null)" aria-label="Close" class="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"><svg [pcIcon]="X" class="h-6 w-6" /></button>
        @if (images().length > 1) {
          <button type="button" (click)="step(-1)" aria-label="Previous photo" class="absolute left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"><svg [pcIcon]="ChevronLeft" class="h-7 w-7" /></button>
          <button type="button" (click)="step(1)" aria-label="Next photo" class="absolute right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"><svg [pcIcon]="ChevronRight" class="h-7 w-7" /></button>
          <p class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1 text-sm text-white">{{ open()! + 1 }} / {{ images().length }}</p>
        }
      </div>
    }
  `,
})
export class GalleryGrid {
  readonly images = input.required<string[]>();
  readonly videos = input<ProductVideo[] | undefined>(undefined);
  readonly title = input.required<string>();
  private readonly site = inject(SiteService).site;
  protected readonly X = X;
  protected readonly ChevronLeft = ChevronLeft;
  protected readonly ChevronRight = ChevronRight;
  protected readonly open = signal<number | null>(null);
  protected readonly shown = computed(() => (this.site().features.product_videos === false ? [] : this.videos() ?? []));
  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>("closeBtn");

  constructor() {
    effect((onCleanup) => {
      if (this.open() === null) return;
      const n = this.images().length;
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") this.open.set(null);
        if (e.key === "ArrowRight") this.open.update((i) => (i === null ? i : (i + 1) % n));
        if (e.key === "ArrowLeft") this.open.update((i) => (i === null ? i : (i - 1 + n) % n));
      };
      document.addEventListener("keydown", key);
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      onCleanup(() => { document.removeEventListener("keydown", key); document.body.style.overflow = prev; });
    });
    // autoFocus on the close button when the viewer opens
    effect(() => this.closeBtn()?.nativeElement.focus());
  }

  protected step(d: number) {
    const n = this.images().length;
    this.open.update((i) => (i === null ? i : (i + d + n) % n));
  }
  protected backdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) this.open.set(null);
  }
}

type Estimate = {
  serviceable: boolean; min_date?: string; max_date?: string; cod_available?: boolean; order_within_min?: number | null;
  delivery_fee_paise?: number; free_delivery_from_paise?: number; state?: string;
};

function within(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} hr${h > 1 ? "s" : ""} ${m} min${m === 1 ? "" : "s"}` : `${m} min${m === 1 ? "" : "s"}`;
}

/** Delivery date, charge, cut-off countdown and cash on delivery for the shopper's PIN code. */
@Component({
  selector: "pc-delivery",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-1.5 text-[15px]", "data-testid": "delivery" },
  template: `
    @if (res()?.serviceable) {
      <p>@if (res()!.delivery_fee_paise === 0) {<span class="font-semibold text-leaf">FREE delivery</span>} @else {<span>{{ rupees(res()!.delivery_fee_paise ?? 0) }} delivery</span>}{{ " " }}<span class="font-semibold">{{ fmtDate(res()!.min_date!) }}</span>@if (res()!.max_date !== res()!.min_date) { – <span class="font-semibold">{{ fmtDate(res()!.max_date!) }}</span>}.</p>
      @if (res()!.delivery_fee_paise !== 0 && res()!.free_delivery_from_paise) {
        <p class="text-sm text-ink-soft">Free delivery when you buy {{ rupees(res()!.free_delivery_from_paise!) }} or more from this seller.</p>
      }
      @if (left() !== null && site().pdp?.delivery_countdown !== false) {
        <p class="flex items-center gap-1.5 text-sm"><svg [pcIcon]="Clock" class="h-4 w-4 text-leaf" /> Order within <span class="font-semibold text-leaf">{{ within(left()!) }}</span> to get it by this date.</p>
      }
      @if (res()!.cod_available) {<p class="flex items-center gap-1.5 text-sm text-ink-soft"><svg [pcIcon]="Banknote" class="h-4 w-4" /> Cash on delivery available</p>}
    }
    @if (res() && !res()!.serviceable) {<p class="text-sm text-vermilion">This seller does not deliver to {{ pin() }} yet.</p>}
    @if (pin() && !showForm()) {
      <button type="button" (click)="value.set(pin()); editing.set(true)" class="flex items-center gap-1 self-start text-sm text-peacock hover:underline">
        <svg [pcIcon]="MapPin" class="h-4 w-4" /> Delivering to {{ pin() }}{{ res()?.state ? ", " + res()!.state : "" }} – Change
      </button>
    }
    @if (showForm()) {
      <form (submit)="apply($event)" class="flex items-center gap-2">
        <svg [pcIcon]="MapPin" class="h-4 w-4 shrink-0 text-peacock" />
        <label for="pin" class="sr-only">PIN code</label>
        <input id="pin" inputmode="numeric" maxlength="6" [value]="value()" (input)="onInput($event)" placeholder="Enter PIN for delivery date" class="h-9 min-w-0 flex-1 rounded-md border border-line px-2 text-sm" />
        <button type="submit" class="text-sm font-semibold text-peacock">Check</button>
      </form>
    }
    @if (err()) {<p class="text-sm text-vermilion">{{ err() }}</p>}
  `,
})
export class Delivery {
  readonly variant = input<PublicVariant | undefined>(undefined);
  protected readonly site = inject(SiteService).site;
  protected readonly pin = inject(PincodeService).pin;
  protected readonly rupees = rupees;
  protected readonly fmtDate = fmtDate;
  protected readonly within = within;
  protected readonly Clock = Clock;
  protected readonly Banknote = Banknote;
  protected readonly MapPin = MapPin;
  // the answer is kept with the variant and PIN it belongs to, so a stale one is never shown
  private readonly answer = signal<{ key: string; data: Estimate } | null>(null);
  protected readonly editing = signal(false);
  protected readonly value = signal("");
  protected readonly err = signal<string | null>(null);
  protected readonly left = signal<number | null>(null);
  private readonly key = computed(() => (this.variant() && isPincode(this.pin()) ? `${this.variant()!.id}:${this.pin()}` : ""));
  protected readonly res = computed(() => {
    const a = this.answer();
    return a && a.key === this.key() ? a.data : null;
  });
  protected readonly showForm = computed(() => this.editing() || !this.pin());

  constructor() {
    effect((onCleanup) => {
      const key = this.key(), variant = this.variant(), pin = this.pin();
      if (!key || !variant) return;
      let live = true;
      api<Estimate>("/api/catalog/delivery-estimate", { query: { variant_id: variant.id, pincode: pin } })
        .then((r) => { if (live) { this.answer.set({ key, data: r }); this.left.set(r.order_within_min ?? null); this.err.set(null); } })
        .catch((x) => { if (live) this.err.set(x instanceof ApiError ? x.message : "Could not check delivery"); });
      onCleanup(() => (live = false));
    });
    // the countdown ticks once a minute
    effect((onCleanup) => {
      if (this.left() === null) return;
      const t = setInterval(() => this.left.update((x) => (x !== null && x > 1 ? x - 1 : null)), 60_000);
      onCleanup(() => clearInterval(t));
    });
  }

  protected onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const v = el.value.replace(/\D/g, "");
    el.value = v;
    this.value.set(v);
    this.err.set(null);
  }

  protected apply(e: Event) {
    e.preventDefault();
    if (!isPincode(this.value())) return this.err.set("Enter a valid 6-digit PIN code");
    setPincode(this.value());
    this.editing.set(false);
  }
}

@Component({
  selector: "pc-product-main",
  imports: [
    Icon, PcLink, Button, Gallery, GalleryGrid, CustomerMediaStrip, Stars, AskAboutProduct, DealBadge, UnitPrice, OffersBlock, ServiceIcons, KeySpecs,
    AboutThisItem, SellerSnapshotCard, Delivery, NotifyMe, WishlistHeart, ShareButton, CompareToggle, ReportProduct, StickyBuyBar,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="gridCls()" [attr.data-pdp-layout]="pdpLayout()">
      <!-- z-10: the hover-zoom panel opens over the product details, under the site header (z-30). -->
      @if (galleryLayout()) {
        <div class="relative z-10 min-w-0 lg:row-span-2">
          <div class="rounded-xl bg-white p-3 lg:hidden"><pc-gallery [images]="p().images" [videos]="p().videos" [title]="p().title" /></div>
          <div class="hidden lg:block"><pc-gallery-grid [images]="p().images" [videos]="p().videos" [title]="p().title" /></div>
          @if (pdp().customer_media) {<div class="mt-3"><pc-customer-media-strip [slug]="p().slug" /></div>}
        </div>
      } @else {
        <div [class]="three() ? 'relative z-10 lg:sticky lg:top-36 lg:row-span-2 lg:self-start xl:row-span-1' : 'relative z-10 lg:sticky lg:top-36 lg:row-span-2 lg:self-start'">
          <pc-gallery [images]="p().images" [videos]="p().videos" [title]="p().title" />
          @if (pdp().customer_media) {<pc-customer-media-strip [slug]="p().slug" />}
        </div>
      }

      <!-- centre: what it is -->
      <div [class]="galleryLayout() ? 'flex min-w-0 flex-col gap-3 rounded-xl bg-white p-4 sm:p-6' : 'flex min-w-0 flex-col gap-3'">
        @if (p().brand) {
          <a [pcLink]="'/search?brand=' + enc(p().brand)" class="self-start text-sm font-semibold text-peacock hover:underline">Visit the {{ p().brand }} store</a>
        }
        <h1 class="text-[22px] font-semibold leading-snug sm:text-[26px]">{{ p().title }}</h1>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          @if (p().rating_count > 0) {
            <a href="#reviews" (click)="toAnchor($event, 'reviews')" class="flex items-center gap-1.5 hover:text-peacock">
              <span class="font-semibold">{{ p().rating_avg.toFixed(1) }}</span><pc-stars [value]="p().rating_avg" />
              <span class="text-peacock">({{ p().rating_count.toLocaleString("en-IN") }} {{ p().rating_count === 1 ? "rating" : "ratings" }})</span>
            </a>
          } @else if (site().features.reviews) {
            <a href="#reviews" (click)="toAnchor($event, 'reviews')" class="text-ink-faint hover:text-peacock">No ratings yet</a>
          }
          @if (pdp().ask_assistant) {<span class="text-line" aria-hidden="true">|</span><pc-ask-about-product [title]="p().title" />}
        </div>
        @if (p().bought_last_month) {<p class="text-sm font-semibold" data-testid="bought">{{ p().bought_last_month }}</p>}
        @if (bestsellerBadge() || p().seller_snapshot?.top_seller) {
          <div class="flex flex-wrap gap-2">
            @if (bestsellerBadge()) {
              <a [pcLink]="'/c/' + p().bestseller!.slug + '?sort=popular'" class="rounded bg-marigold px-2 py-0.5 text-xs font-bold text-ink hover:bg-marigold-dark" data-testid="bestseller">
                #{{ p().bestseller!.rank }} Best seller <span class="font-normal">in {{ p().bestseller!.category }}</span>
              </a>
            }
            @if (p().seller_snapshot?.top_seller) {<span class="flex items-center gap-1 rounded bg-peacock px-2 py-0.5 text-xs font-bold text-white"><svg [pcIcon]="Award" class="h-3.5 w-3.5" /> Top seller</span>}
          </div>
        }

        <div class="border-t border-line pt-3">
          @if (shown(); as s) {
            <div class="flex flex-wrap items-baseline gap-x-3">
              @if (s.discount_pct > 0) {<span class="text-2xl font-light text-vermilion">-{{ s.discount_pct }}%</span>}
              <span class="font-display text-[32px] font-bold leading-none">{{ rupees(s.price) }}</span>
              <pc-unit-price [up]="pdp().unit_price ? s.unit_price : null" unitClass="text-sm" />
            </div>
            @if (s.mrp > s.price) {<p class="mt-1 text-sm text-ink-faint">M.R.P.: <span class="line-through">{{ rupees(s.mrp) }}</span></p>}
            @if (dealHere()) {
              <div class="mt-2 flex flex-col gap-1 rounded-lg bg-vermilion-light/60 p-3" data-testid="pdp-deal">
                <pc-deal-badge [deal]="p().deal!" [discount]="s.discount_pct" size="md" />
                <p class="text-sm text-ink-soft">Deal price {{ rupees(s.price) }}@if (p().deal!.regular_price && p().deal!.regular_price! > s.price) { · was <span class="line-through">{{ rupees(p().deal!.regular_price!) }}</span>}</p>
                @if (p().deal!.units_left != null && p().deal!.units_left! <= 10) {
                  <p class="text-sm font-semibold text-vermilion" data-testid="deal-left">Only {{ p().deal!.units_left }} left at the deal price</p>
                }
              </div>
            }
          }
          <p class="text-sm text-ink-soft">Inclusive of all taxes</p>
        </div>

        @if (pdp().offers && (p().offers?.length ?? 0) > 0) {<pc-offers-block [offers]="p().offers!" />}
        @if (pdp().service_icons && shown()) {<div class="border-y border-line py-2"><pc-service-icons [p]="p()" [price]="shown()!.price" /></div>}

        @if (p().size_guide; as guide) {
          <details class="rounded-lg border border-line bg-white px-3 py-2 text-sm" data-testid="size-guide">
            <summary class="cursor-pointer font-semibold text-peacock">Size guide</summary>
            <div class="mt-2 overflow-x-auto">
              <table class="w-full text-left">
                <thead><tr>@for (h of guide[0]; track $index) {<th scope="col" class="border-b border-line px-2 py-1 font-semibold">{{ h }}</th>}</tr></thead>
                <tbody>@for (r of guide.slice(1); track $index) {<tr>@for (c of r; track $index) {<td class="border-b border-line/60 px-2 py-1">{{ c }}</td>}</tr>}</tbody>
              </table>
            </div>
          </details>
        }

        @for (ax of axes(); track ax.axis) {
          <fieldset>
            <legend class="mb-2 text-sm font-semibold">{{ ax.axis }}: <span class="font-normal text-ink-soft">{{ chosen()[ax.axis] }}</span></legend>
            <div class="flex flex-wrap gap-2">
              @for (o of ax.options; track o.val) {
                <button type="button" (click)="choose(ax.axis, o.val)" [attr.aria-pressed]="o.selected"
                  [class]="cx('min-w-[56px] rounded-lg border-2 px-3 py-1.5 text-left text-[15px]', o.selected ? 'border-peacock bg-peacock-light' : 'border-line bg-white hover:border-peacock/50', !o.ok && 'border-dashed text-ink-faint')">
                  <span [class]="cx('block font-medium', o.selected && 'text-peacock', !o.ok && 'line-through decoration-1')">{{ o.val }}</span>
                  @if (pricesDiffer() && o.v) {<span class="block text-xs text-ink">{{ rupees(o.v.price) }}</span>}
                  @if (pdp().unit_price && o.v?.unit_price) {<span class="block text-[11px] text-ink-faint">{{ rupees(o.v!.unit_price!.paise) }}/{{ o.v!.unit_price!.per }}</span>}
                  @if (!o.ok) {<span class="block text-[11px]">Unavailable</span>}
                </button>
              }
            </div>
          </fieldset>
        }

        @if (pdp().key_specs) {<pc-key-specs [rows]="p().key_specs ?? []" [extra]="netRow()" />}
        <pc-about-this-item [items]="p().highlights" />
        @if (pdp().seller_snapshot && p().seller_snapshot) {
          <div [class]="three() ? 'xl:hidden' : ''"><pc-seller-snapshot [seller]="p().seller" [snap]="p().seller_snapshot!" /></div>
        }
      </div>

      <!-- right: buy (the two-column and gallery layouts keep it in view while the page scrolls) -->
      <aside [class]="three() ? 'flex flex-col gap-4 lg:col-start-2 xl:col-start-3' : 'flex flex-col gap-4 lg:col-start-2 lg:sticky lg:top-28 lg:self-start'" aria-label="Buy">
        <div [class]="three() ? 'flex flex-col gap-3 rounded-xl border p-4 shadow-sm border-line' : 'flex flex-col gap-3 rounded-xl border p-4 shadow-sm border-peacock/25 bg-white shadow-card'">
          @if (shown(); as s) {
            <div>
              <span class="font-display text-[28px] font-bold leading-none">{{ rupees(s.price) }}</span>{{ " " }}<pc-unit-price [up]="pdp().unit_price ? s.unit_price : null" unitClass="text-sm" />
              @if (dealHere()) {<div class="mt-1.5"><pc-deal-badge [deal]="p().deal!" [discount]="s.discount_pct" /></div>}
            </div>
          }
          <pc-delivery [variant]="variant()" />
          @if (variant(); as v) {
            @if (v.in_stock) {
              <p [class]="v.low_stock ? 'text-lg font-semibold text-vermilion' : 'text-lg font-semibold text-leaf'">{{ v.low_stock ? "Only " + v.stock_left + " left in stock" : "In stock" }}</p>
            } @else {
              <p class="text-lg font-semibold text-vermilion">Currently unavailable</p>
            }
          } @else {
            <p class="font-semibold text-vermilion">This combination is not available</p>
          }
          <div class="flex items-center gap-3">
            <label for="qty" class="text-sm font-semibold">Quantity</label>
            @if (minQty() > 1) {<span class="text-xs text-ink-faint">Minimum order: {{ minQty() }}</span>}
            <select id="qty" (change)="qty.set(+$any($event.target).value)" class="h-10 rounded-lg border border-line bg-mist px-3" [disabled]="!variant()?.in_stock">
              @for (n of qtyOptions(); track n) {<option [value]="n" [selected]="n === qty()">{{ n }}</option>}
            </select>
          </div>
          <div #buttons class="flex flex-col gap-2">
            @if (variant() && !variant()!.in_stock && site().features.stock_alerts !== false) {
              <pc-notify-me [variantId]="variant()!.id" />
            } @else {
              <button pcButton variant="cart" size="lg" (click)="add('cart')" [loading]="busy() === 'cart'" [disabled]="!variant()?.in_stock || busy() !== null" class="w-full rounded-full">Add to cart</button>
              <button pcButton variant="buy" size="lg" (click)="add('buy')" [loading]="busy() === 'buy'" [disabled]="!variant()?.in_stock || busy() !== null" class="w-full rounded-full">Buy now</button>
            }
          </div>
          <dl class="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt class="text-ink-faint">Ships from</dt><dd>{{ p().seller.city }}{{ p().seller.state ? ", " + p().seller.state : "" }}</dd>
            <dt class="text-ink-faint">Sold by</dt><dd><a [pcLink]="'/store/' + p().seller.slug" class="text-peacock hover:underline">{{ p().seller.name }}</a></dd>
            <dt class="text-ink-faint">Returns</dt><dd>{{ p().return_window_days > 0 ? p().return_window_days + "-day return after delivery" : "Not returnable" }}</dd>
            <dt class="text-ink-faint">Payment</dt><dd>{{ site().online_payments === false ? "Cash on delivery" : site().cod_enabled ? "Secure online payment or cash on delivery" : "Secure online payment" }}</dd>
          </dl>
          <div class="flex items-center gap-2 border-t border-line pt-3">
            @if (site().features.wishlist) {<pc-wishlist-heart [productId]="p().id" heartClass="flex h-10 w-10 items-center justify-center rounded-full ring-1 ring-line hover:bg-mist" />}
            @if (site().features.wishlist) {<span class="text-sm text-ink-soft">Save for later</span>}
            @if (pdp().share) {<div class="ml-auto"><pc-share-button [title]="p().title" /></div>}
          </div>
          <pc-compare-toggle [item]="{ id: p().id, slug: p().slug, title: p().title, image: p().images[0] ?? '' }" toggleClass="text-sm" />
        </div>
        @if (three() && pdp().seller_snapshot && p().seller_snapshot) {<div class="hidden xl:block"><pc-seller-snapshot [seller]="p().seller" [snap]="p().seller_snapshot!" /></div>}
        <div class="flex flex-col gap-2 rounded-xl bg-mist p-4 text-[13px] text-ink-soft">
          <p class="flex items-center gap-1.5 font-semibold text-ink"><svg [pcIcon]="BadgeCheck" class="h-4 w-4 text-leaf" /> {{ p().seller.legal_name || p().seller.name }}</p>
          @if (p().seller.gstin) {<p>GSTIN {{ p().seller.gstin }}</p>}
          <p>Grievance officer: {{ p().seller.grievance_officer.name }} ({{ p().seller.grievance_officer.email }})</p>
          <p class="flex items-center gap-1.5"><svg [pcIcon]="Package" class="h-3.5 w-3.5" /> Country of origin: {{ p().country_of_origin }}</p>
        </div>
        @if (pdp().report) {<pc-report-product [slug]="p().slug" />}
      </aside>
    </div>
    @if (pdp().sticky_bar && shown()) {
      <pc-sticky-buy-bar [watch]="buttons" [price]="shown()!.price" [mrp]="shown()!.mrp" [title]="p().title" [image]="p().images[0] ?? ''"
        (add)="add('cart')" (buy)="add('buy')" [disabled]="!variant()?.in_stock || busy() !== null" [busy]="busy()" />
    }
  `,
})
export class ProductMain {
  readonly p = input.required<ProductPage>();
  protected readonly site = inject(SiteService).site;
  private readonly lists = inject(SiteService).lists;
  private readonly layout = inject(ThemeService).layout;
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  private readonly session = inject(SessionService);
  protected readonly cx = cx;
  protected readonly rupees = rupees;
  protected readonly enc = encodeURIComponent;
  protected readonly Award = Award;
  protected readonly BadgeCheck = BadgeCheck;
  protected readonly Package = Package;
  protected readonly pdp = computed(() => this.site().pdp);
  protected readonly pdpLayout = computed(() => this.layout().pdp.layout);
  protected readonly three = computed(() => this.pdpLayout() === "three");
  protected readonly galleryLayout = computed(() => this.pdpLayout() === "gallery");
  protected readonly gridCls = computed(() => cx("grid gap-6", PDP_GRID[this.pdpLayout()], this.galleryLayout() ? "lg:items-start" : "rounded-xl bg-white p-4 sm:p-6"));

  private readonly firstAvailable = computed(() => this.p().variants.find((v) => v.in_stock) ?? this.p().variants[0]);
  protected readonly chosen = signal<Record<string, string>>({});
  protected readonly qty = signal(1);
  protected readonly minQty = computed(() => Math.max(1, this.p().min_qty ?? 1));
  protected readonly busy = signal<"cart" | "buy" | null>(null);
  private claimed = false;

  protected readonly variant = computed(() => {
    const chosen = this.chosen();
    return this.p().variants.find((v) => Object.entries(chosen).every(([k, val]) => v.options[k] === val) && Object.keys(v.options).length === Object.keys(chosen).length);
  });
  protected readonly pricesDiffer = computed(() => new Set(this.p().variants.map((v) => v.price)).size > 1);
  protected readonly axes = computed(() => {
    const chosen = this.chosen();
    const variants = this.p().variants;
    return Object.entries(this.p().option_axes).map(([axis, values]) => ({
      axis,
      options: values.map((val) => ({
        val,
        selected: chosen[axis] === val,
        ok: variants.some((v) => v.options[axis] === val && v.in_stock && Object.entries(chosen).every(([k, x]) => k === axis || v.options[k] === x)),
        v: variants.find((v) => v.options[axis] === val && Object.entries(chosen).every(([k, x]) => k === axis || v.options[k] === x)),
      })),
    }));
  });
  protected readonly shown = computed(() => this.variant() ?? this.firstAvailable());
  protected readonly dealHere = computed(() => Boolean(this.p().deal && this.shown() && this.shown()!.id === this.p().deal!.variant_id));
  // the quantity picker stops at the stock, the per-item limit (Admin → Marketplace settings) and a lightning deal's units left
  private readonly maxQty = computed(() => {
    const variant = this.variant();
    const dealLeft = this.dealHere() && variant && this.p().deal!.units_left ? this.p().deal!.units_left! : null;
    return Math.max(this.minQty(), Math.min(this.site().max_qty_per_item ?? 10, variant?.stock_left ?? 10, dealLeft ?? Infinity));
  });
  protected readonly qtyOptions = computed(() => Array.from({ length: Math.max(1, this.maxQty() - this.minQty() + 1) }, (_, i) => i + this.minQty()));
  protected readonly netRow = computed(() => (this.shown()?.net_quantity ? [{ label: "Net quantity", value: this.shown()!.net_quantity! }] : []));
  protected readonly bestsellerBadge = computed(() => Boolean(this.p().bestseller && this.p().bestseller!.rank <= this.lists().bestseller_badge_top));

  constructor() {
    // a new product: start from its first version in stock
    effect(() => {
      const first = this.firstAvailable();
      untracked(() => {
        this.chosen.set(first?.options ?? {});
        this.qty.set(Math.max(1, this.p().min_qty ?? 1));
      });
    });
    effect(() => {
      const p = this.p();
      const max = this.lists().recently_viewed_max;
      untracked(() => {
        rememberViewed({ id: p.id, slug: p.slug, title: p.title, image: p.images[0] ?? "", price: p.price, mrp: p.mrp }, max);
        api("/api/events", { method: "POST", body: { type: "view", product_id: p.id } }).catch(() => {});
      });
    });
    // Opened from a sponsored product: link the click to this shopper so an order counts as an ad sale.
    effect(() => {
      if (!this.session.user() || this.claimed) return;
      const click = new URLSearchParams(window.location.search).get("sp");
      if (!click || !/^[0-9a-f-]{36}$/i.test(click)) return;
      this.claimed = true;
      api(`/api/ads/clicks/${click}/claim`, { method: "POST" }).catch(() => {});
    });
  }

  protected choose(axis: string, val: string) {
    this.chosen.update((c) => ({ ...c, [axis]: val }));
  }

  /** In-page anchors (#reviews) scroll like a plain link, without leaving the page. */
  protected toAnchor(e: MouseEvent, id: string) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    history.pushState(history.state, "", `${location.pathname}${location.search}#${id}`);
    document.getElementById(id)?.scrollIntoView();
  }

  protected async add(then: "cart" | "buy") {
    const variant = this.variant(), p = this.p();
    if (!variant || !variant.in_stock) return;
    this.busy.set(then);
    try {
      const note = await this.session.addToCart({
        variant_id: variant.id, qty: this.qty(), title: p.title, image: p.images[0] ?? "", price: variant.price, mrp: variant.mrp, slug: p.slug,
        variant_label: variant.label, seller_name: p.seller.name, max: this.maxQty(),
      });
      api("/api/events", { method: "POST", body: { type: "add_to_cart", product_id: p.id } }).catch(() => {});
      if (then === "buy") {
        if (note) this.toast.show(note);
        window.dispatchEvent(new Event("route-progress:start"));
        void this.router.navigateByUrl(this.session.user() ? "/checkout" : "/login?next=/checkout");
      } else this.toast.show(note ?? "Added to your cart");
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not add to cart", "error");
    } finally {
      this.busy.set(null);
    }
  }
}

@Component({
  selector: "pc-browsing-history",
  imports: [RecentlyViewedRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (site().pdp.recently_viewed) {<pc-recently-viewed-rail [currentId]="currentId()" />}`,
})
export class BrowsingHistory {
  readonly currentId = input.required<string>();
  protected readonly site = inject(SiteService).site;
}
