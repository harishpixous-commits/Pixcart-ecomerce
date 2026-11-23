/*
 * Fresh tile (quick commerce): a compact white card with the photo on a tinted square, a discount or deal tag, the
 * delivery date as a chip, the title and rating, and the price with an ADD button at the bottom. The ADD button is
 * always there when the product can be added: it is this theme's identity. The whole card opens the product (the
 * link's ::after covers it); the wishlist heart and the ADD button sit above that layer as siblings of the link.
 */

import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { Clock, Loader2, Star } from "lucide-angular";
import { rupees } from "../../core/format";
import type { ProductCard } from "../../core/types";
import { DealCountdown, TileImage, TileLink, quickAdd } from "../../shared/product/product-parts";
import { WishlistHeart } from "../../shared/product/wishlist-heart";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

const IST = "Asia/Kolkata";
const dayFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: IST });
const startFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: IST });

/*
 * Tiles narrower than 150 px inside (rails on phones) use a slimmer ADD button and price so both fit on one line;
 * the row still wraps (the button then takes the full width) if a long price does not fit.
 */
const ADD =
  "pc-press relative z-10 flex h-9 min-w-[72px] shrink-0 grow items-center justify-center rounded-lg border border-peacock bg-peacock-light px-3 " +
  "text-sm font-extrabold uppercase tracking-wide text-peacock-dark transition-colors hover:bg-peacock hover:text-white disabled:opacity-70 " +
  "[@container(max-width:149px)]:min-w-[58px] [@container(max-width:149px)]:px-2";
const TAG = "max-w-full truncate rounded-md px-1.5 py-1 text-[11px] font-extrabold leading-none";

@Component({
  selector: "pc-fresh-tile",
  imports: [Icon, PcLink, DealCountdown, TileImage, TileLink, WishlistHeart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "pc-lift group relative flex h-full flex-col rounded-xl bg-white p-2 shadow-card [container-type:inline-size]", "data-testid": "product-tile" },
  template: `
    <a [pcTileLink]="p()"
      class="flex flex-1 flex-col rounded-lg after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-peacock">
      <div class="relative">
        <pc-tile-image [p]="p()" class="aspect-square rounded-lg bg-mist" imgClass="p-1.5 mix-blend-multiply" />
        @if (rank() !== undefined || p().deal || p().discount_pct > 0) {
          <div class="absolute left-1.5 top-1.5 flex max-w-[calc(100%-3rem)] flex-col items-start gap-1">
            @if (rank() !== undefined) {<span [class]="TAG + ' bg-marigold text-ink'">#{{ rank() }}</span>}
            @if (p().deal) {
              <span [class]="TAG + ' bg-vermilion text-white'" data-testid="deal-badge">{{ p().deal!.label }}</span>
            } @else if (p().discount_pct > 0) {
              <span [class]="TAG + ' bg-peacock uppercase text-white'">{{ p().discount_pct }}% off</span>
            }
          </div>
        }
      </div>
      <div class="flex flex-1 flex-col px-0.5 pt-2">
        @if (p().delivery_by) {
          <span class="mb-1.5 inline-flex w-fit max-w-full items-center gap-1 rounded-md bg-mist px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft">
            <svg [pcIcon]="Clock" class="h-3 w-3 shrink-0 text-peacock" />
            <span class="truncate">By {{ day() }}</span>
          </span>
        }
        @if (p().sponsored) {<span class="text-[11px] font-semibold uppercase tracking-wide text-ink-soft" data-testid="sponsored-label">Sponsored</span>}
        <p class="line-clamp-2 min-h-[2.75em] text-[13px] font-semibold leading-snug text-ink">{{ p().title }}</p>
        @if (p().unit_price) {<p class="mt-0.5 text-[11px] text-ink-soft">{{ fmt(p().unit_price!.paise) }}/{{ p().unit_price!.per }}</p>}
        @if (p().rating_count > 0) {
          <p class="mt-1 flex items-center gap-1 text-[11px] leading-none">
            <span class="sr-only">Rated {{ p().rating_avg.toFixed(1) }} out of 5 from {{ count() }} ratings</span>
            <span class="font-bold text-leaf" aria-hidden="true">{{ p().rating_avg.toFixed(1) }}</span>
            <svg [pcIcon]="Star" class="h-3 w-3 fill-leaf text-leaf" />
            <span class="text-ink-soft" aria-hidden="true">({{ count() }})</span>
          </p>
        }
        @if (p().deal && p().deal!.kind !== "limited") {<pc-deal-countdown [endsAt]="p().deal!.ends_at" spanClass="mt-1 text-[11px] font-semibold text-vermilion" />}
        @if (p().starts_at) {<p class="mt-1 text-[11px] font-semibold text-peacock">Starts {{ start() }}</p>}
      </div>
    </a>
    <pc-wishlist-heart [productId]="p().id"
      heartClass="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/90 shadow-sm before:absolute before:-inset-1 before:content-[''] hover:bg-white" />
    <div class="mt-2 flex flex-wrap items-center gap-1.5 px-0.5">
      <div class="shrink-0 grow-[100] leading-tight">
        <p class="font-display text-[15px] font-bold text-ink [@container(max-width:149px)]:text-sm">{{ fmt(p().price) }}</p>
        @if (p().mrp > p().price) {<p class="text-xs text-ink-soft line-through"><span class="sr-only">M.R.P. </span>{{ fmt(p().mrp) }}</p>}
      </div>
      @if (q.needsOptions()) {
        <a [pcLink]="q.optionsHref()" [class]="ADD + ' flex-col gap-1 leading-none'" [attr.aria-label]="'See options for ' + p().title" data-testid="tile-options">
          <span aria-hidden="true">Add</span>
          <span class="text-[11px] font-semibold normal-case tracking-normal" aria-hidden="true">{{ (p().variant_count ?? 0) > 1 ? p().variant_count + " options" : "options" }}</span>
        </a>
      } @else if (!q.canAdd()) {
        <span class="flex h-9 shrink-0 grow items-center justify-center rounded-lg bg-mist px-2 text-center text-xs font-bold leading-tight text-ink-soft">Out of stock</span>
      } @else {
        <button type="button" (click)="q.add($event)" [disabled]="q.busy()" [attr.aria-label]="'Add ' + p().title + ' to cart'" data-testid="quick-add" [class]="ADD">
          @if (q.busy()) {<svg [pcIcon]="Loader2" class="h-4 w-4 animate-spin" />} @else {Add}
        </button>
      }
    </div>
  `,
})
export class FreshProductTile {
  readonly p = input.required<ProductCard>();
  readonly showAdd = input(false);
  readonly rank = input<number | undefined>(undefined);
  readonly quickPlus = input(false);
  protected readonly q = quickAdd(this.p);
  protected readonly fmt = rupees;
  protected readonly ADD = ADD;
  protected readonly TAG = TAG;
  protected readonly Clock = Clock;
  protected readonly Loader2 = Loader2;
  protected readonly Star = Star;
  protected readonly day = computed(() => (this.p().delivery_by ? dayFmt.format(new Date(this.p().delivery_by!)) : ""));
  protected readonly start = computed(() => (this.p().starts_at ? startFmt.format(new Date(this.p().starts_at!)) : ""));
  protected readonly count = computed(() => this.p().rating_count.toLocaleString("en-IN"));
}
