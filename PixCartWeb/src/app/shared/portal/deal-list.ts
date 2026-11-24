/*
 * Deals as the seller hub and the admin see them: one card per deal with its product, price, time window, units claimed
 * and status. The pages add their own buttons (project them with the "actions" attribute). Port of components/deal-list.tsx:
 *   <pc-deal-item [d]="row" [showSeller]="false" [withActions]="true"><button actions ...>Stop deal</button></pc-deal-item>
 */

import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from "@angular/core";
import { CalendarClock, Timer, Zap, type LucideIconData } from "lucide-angular";
import { dateTime, duration, rupees } from "../../core/format";
import { DealCountdown } from "../product/product-parts";
import { Icon } from "../ui/icon";
import { Pill } from "../ui/ui";

export type DealKind = "lightning" | "deal_of_day" | "limited";
export const DEAL_KINDS: DealKind[] = ["lightning", "deal_of_day", "limited"];

export type DealRow = {
  id: string; kind: DealKind; kind_label: string; status: string; note: string; product: string; slug: string; product_id: string;
  variant_id: string; variant: string; image: string; stock: number; seller: string; seller_id: string; deal_price: number;
  regular_price: number; mrp: number; discount_pct: number; starts_at: string; ends_at: string; qty_limit: number | null;
  sold_qty: number; created_at: string;
};

export type DealRules = {
  enabled: boolean; need_approval: boolean; min_discount_pct: number; max_hours_lightning: number; max_hours_day: number;
  max_days_limited: number; kinds: Record<DealKind, string>;
};

type Tone = "green" | "amber" | "red" | "blue" | "gray";
export const DEAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for approval", tone: "amber" },
  approved: { label: "Scheduled", tone: "blue" },
  active: { label: "Running", tone: "green" },
  ended: { label: "Ended", tone: "gray" },
  rejected: { label: "Not approved", tone: "red" },
  cancelled: { label: "Cancelled", tone: "gray" },
};

/** Statuses a deal can still be stopped from. */
export const DEAL_OPEN = ["pending", "approved", "active"];

export const KIND_ICON: Record<DealKind, LucideIconData> = { lightning: Zap, deal_of_day: Timer, limited: CalendarClock };

export function kindText(kind: DealKind, r: DealRules): string {
  if (kind === "lightning") return `A few hours with a set number of units and a "claimed" bar. Up to ${r.max_hours_lightning} hours.`;
  if (kind === "deal_of_day") return `A one-day offer shown with a countdown. Up to ${r.max_hours_day} hours.`;
  return `A sale price for several days. Up to ${r.max_days_limited} days.`;
}

/** The longest a deal of this kind may run, in milliseconds. */
export function maxDealMs(kind: DealKind, r: DealRules): number {
  if (kind === "limited") return r.max_days_limited * 86_400_000;
  return (kind === "lightning" ? r.max_hours_lightning : r.max_hours_day) * 3_600_000;
}

@Component({
  selector: "pc-deal-item",
  imports: [Icon, Pill, DealCountdown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex gap-3 rounded-xl bg-white p-4", "data-testid": "deal-row", role: "article" },
  template: `
    @if (d().image) {
      <img [src]="d().image" alt="" class="h-16 w-16 shrink-0 rounded-lg object-contain ring-1 ring-line sm:h-20 sm:w-20" />
    } @else {
      <div class="h-16 w-16 shrink-0 rounded-lg bg-mist sm:h-20 sm:w-20"></div>
    }
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-start gap-2">
        <a [href]="'/p/' + d().slug" target="_blank" rel="noreferrer" class="min-w-0 flex-1 font-semibold hover:text-peacock">{{ d().product }}</a>
        <pc-pill [tone]="st().tone">{{ st().label }}</pc-pill>
      </div>
      <p class="text-sm text-ink-soft">
        {{ d().variant }}@if (showSeller()) { · Sold by <span class="font-medium text-ink">{{ d().seller }}</span>}
      </p>
      <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span class="inline-flex items-center gap-1 rounded-full bg-vermilion-light px-2 py-0.5 text-xs font-semibold text-vermilion">
          <svg [pcIcon]="icon()" class="h-3.5 w-3.5" /> {{ d().kind_label }}
        </span>
        <span>
          <span class="font-display text-base font-bold">{{ rupees(d().deal_price) }}</span>
          @if (d().regular_price > d().deal_price) {<span class="ml-1 text-ink-faint line-through">{{ rupees(d().regular_price) }}</span>}
        </span>
        @if (d().discount_pct > 0) {<span class="font-semibold text-leaf">{{ d().discount_pct }}% off M.R.P.</span>}
      </div>
      <p class="mt-1 text-sm text-ink-soft">
        {{ dateTime(d().starts_at) }} to {{ dateTime(d().ends_at) }} ({{ span() }})@if (d().status === "active") { · <pc-deal-countdown [endsAt]="d().ends_at" spanClass="font-medium text-vermilion" />}@if (d().status === "approved") { · <pc-deal-countdown [endsAt]="d().starts_at" prefix="Starts in" doneText="Starting now" spanClass="font-medium text-peacock" />}
      </p>
      @if (d().qty_limit) {
        <div class="mt-2 flex max-w-md items-center gap-2 text-xs text-ink-soft">
          <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-mist">
            <span class="block h-full rounded-full bg-vermilion" [style.width.%]="claimed()"></span>
          </span>
          <span class="shrink-0">{{ d().sold_qty }} of {{ d().qty_limit }} units claimed</span>
        </div>
      } @else if (d().sold_qty > 0) {
        <p class="mt-1 text-xs text-ink-soft">{{ d().sold_qty }} sold at the deal price</p>
      }
      @if (d().note) {<p class="mt-2 rounded-lg bg-mist px-3 py-2 text-sm">{{ d().note }}</p>}
      @if (withActions()) {<div class="mt-3 flex flex-wrap gap-2"><ng-content select="[actions]" /></div>}
    </div>
  `,
})
export class DealItem {
  readonly d = input.required<DealRow>();
  readonly showSeller = input(false, { transform: booleanAttribute });
  readonly withActions = input(false, { transform: booleanAttribute });
  protected readonly rupees = rupees;
  protected readonly dateTime = dateTime;
  protected readonly st = computed(() => DEAL_STATUS[this.d().status] ?? { label: this.d().status, tone: "gray" as Tone });
  protected readonly icon = computed(() => KIND_ICON[this.d().kind] ?? Zap);
  protected readonly span = computed(() => duration(new Date(this.d().ends_at).getTime() - new Date(this.d().starts_at).getTime()));
  protected readonly claimed = computed(() => {
    const d = this.d();
    return d.qty_limit ? Math.min(100, Math.round((100 * d.sold_qty) / d.qty_limit)) : null;
  });
}
