/*
 * Sponsored-product campaigns as the seller hub and the admin see them: status, products, where the ads show, the bid
 * and budgets with today's spend, and the results. Port of components/ad-campaigns.tsx:
 *   <pc-campaign-card [c]="campaign" [now]="now" [showSeller]="false" [withActions]="true"><button actions ...></button></pc-campaign-card>
 *   <dl pcStatsLine [s]="stats"></dl>
 */

import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from "@angular/core";
import { date, rupees } from "../../core/format";
import { Pill } from "../ui/ui";

export type AdStats = {
  impressions: number; clicks: number; invalid_clicks: number; spend: number; orders: number; sales: number; ctr: number; acos: number | null;
};

export type Campaign = {
  id: string; name: string; status: string; note: string; placements: string[]; keywords: string[]; bid_paise: number;
  daily_budget_paise: number; total_budget_paise: number | null; starts_at: string; ends_at: string | null; spend_paise: number;
  spent_today_paise: number; products: { id: string; title: string; slug: string; image: string }[]; stats: AdStats; created_at: string;
  seller?: string; seller_id?: string;
};

export type AdRules = {
  enabled: boolean; need_approval: boolean; min_bid_paise: number; min_daily_budget_paise: number; gst_bps: number;
  placements: Record<string, { label: string; enabled: boolean }>; attribution_days: number;
  link_hours: number; paid_clicks_per_address: number; paid_clicks_per_network: number;
};

type Tone = "green" | "amber" | "red" | "blue" | "gray";
export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for approval", tone: "amber" },
  active: { label: "Running", tone: "green" },
  paused: { label: "Paused", tone: "gray" },
  rejected: { label: "Not approved", tone: "red" },
  ended: { label: "Ended", tone: "gray" },
};

export const PLACEMENT_LABEL: Record<string, string> = { search: "Search results", product: "Product pages", home: "Home page" };

/** Why a running campaign is not showing right now, if it is not. */
export function deliveryNote(c: Campaign, now: number): string | null {
  if (c.status !== "active") return null;
  if (new Date(c.starts_at).getTime() > now) return `Starts ${date(c.starts_at)}`;
  if (c.ends_at && new Date(c.ends_at).getTime() <= now) return "Finished";
  if (c.spent_today_paise + c.bid_paise > c.daily_budget_paise) return "Today's budget is used up; ads show again tomorrow";
  if (c.total_budget_paise !== null && c.spend_paise + c.bid_paise > c.total_budget_paise) return "Total budget is used up";
  return null;
}

export type AdDay = { day: string; impressions: number; clicks: number; invalid_clicks: number; spend: number };

/** A continuous run of days ending today (days without ads as zero), for the charts. */
export function fillDays(rows: AdDay[], days: number): { date: string; impressions: number; clicks: number; invalid_clicks: number; spend: number }[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const out = [];
  for (let k = days - 1; k >= 0; k--) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - k);
    const key = d.toISOString().slice(0, 10);
    const r = byDay.get(key);
    out.push({ date: key, impressions: r?.impressions ?? 0, clicks: r?.clicks ?? 0, invalid_clicks: r?.invalid_clicks ?? 0, spend: r?.spend ?? 0 });
  }
  return out;
}

@Component({
  selector: "dl[pcStatsLine]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "grid grid-cols-4 gap-x-3 gap-y-2 rounded-lg bg-mist/70 p-3 lg:grid-cols-8" },
  template: `
    @for (c of cells(); track c[0]) {
      <div class="min-w-0">
        <dt class="text-[11px] uppercase tracking-wide text-ink-faint">{{ c[0] }}</dt>
        <dd class="truncate font-semibold">{{ c[1] }}</dd>
      </div>
    }
  `,
})
export class StatsLine {
  readonly s = input.required<AdStats>();
  protected readonly cells = computed((): [string, string][] => {
    const s = this.s();
    return [
      ["Impressions", s.impressions.toLocaleString("en-IN")],
      ["Clicks", s.clicks.toLocaleString("en-IN")],
      ["Invalid", s.invalid_clicks.toLocaleString("en-IN")],
      ["CTR", `${s.ctr}%`],
      ["Spend", rupees(s.spend)],
      ["Orders", s.orders.toLocaleString("en-IN")],
      ["Ad sales", rupees(s.sales)],
      ["ACOS", s.acos === null ? "—" : `${s.acos}%`],
    ];
  });
}

@Component({
  selector: "pc-meter",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<span class="mt-1 block h-1.5 overflow-hidden rounded-full bg-mist"><span [class]="pct() >= 90 ? 'block h-full rounded-full bg-vermilion' : 'block h-full rounded-full bg-peacock'" [style.width.%]="pct()"></span></span>`,
})
export class Meter {
  readonly used = input.required<number>();
  readonly of = input.required<number>();
  protected readonly pct = computed(() => (this.of() > 0 ? Math.min(100, Math.round((100 * this.used()) / this.of())) : 0));
}

@Component({
  selector: "pc-campaign-card",
  imports: [Pill, StatsLine, Meter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block rounded-xl bg-white p-4", "data-testid": "campaign", role: "article" },
  template: `
    <div class="flex flex-wrap items-start gap-2">
      <div class="min-w-0 flex-1">
        <h3 class="font-semibold">{{ c().name }}</h3>
        <p class="text-xs text-ink-faint">{{ showSeller() && c().seller ? c().seller + " · " : "" }}{{ date(c().starts_at) }}{{ c().ends_at ? " to " + date(c().ends_at) : ", no end date" }}</p>
      </div>
      <pc-pill [tone]="st().tone">{{ st().label }}</pc-pill>
    </div>
    @if (note()) {<p class="mt-2 rounded-lg bg-marigold-light px-3 py-1.5 text-sm">{{ note() }}</p>}
    <div class="mt-3 flex flex-wrap items-center gap-2">
      @for (p of c().products.slice(0, 6); track p.id) {
        <a [href]="'/p/' + p.slug" target="_blank" rel="noreferrer" [title]="p.title" class="block">
          @if (p.image) {<img [src]="p.image" [alt]="p.title" class="h-11 w-11 rounded-lg bg-white object-contain ring-1 ring-line" />} @else {<span class="block h-11 w-11 rounded-lg bg-mist"></span>}
        </a>
      }
      @if (c().products.length > 6) {<span class="text-sm text-ink-soft">+{{ c().products.length - 6 }} more</span>}
      <span class="text-sm text-ink-soft">{{ c().products.length }} product{{ c().products.length === 1 ? "" : "s" }}</span>
    </div>
    <div class="mt-3 grid gap-3 text-sm sm:grid-cols-3">
      <div>
        <p class="text-ink-faint">Shows on</p>
        <p class="font-medium">{{ placements() }}</p>
        @if (c().keywords.length > 0) {<p class="mt-0.5 line-clamp-2 text-xs text-ink-soft">Keywords: {{ c().keywords.join(", ") }}</p>}
      </div>
      <div>
        <p class="text-ink-faint">Today</p>
        <p class="font-medium">{{ rupees(c().spent_today_paise) }} of {{ rupees(c().daily_budget_paise) }} · bid {{ rupees(c().bid_paise) }}/click</p>
        <pc-meter [used]="c().spent_today_paise" [of]="c().daily_budget_paise" />
      </div>
      <div>
        <p class="text-ink-faint">Total spent</p>
        <p class="font-medium">{{ rupees(c().spend_paise) }}{{ c().total_budget_paise ? " of " + rupees(c().total_budget_paise!) : "" }}</p>
        @if (c().total_budget_paise) {<pc-meter [used]="c().spend_paise" [of]="c().total_budget_paise!" />} @else {<p class="text-xs text-ink-faint">No total limit</p>}
      </div>
    </div>
    <dl pcStatsLine [s]="c().stats" class="mt-3"></dl>
    @if (c().note) {<p class="mt-2 rounded-lg bg-mist px-3 py-2 text-sm"><span class="font-semibold">Note:</span> {{ c().note }}</p>}
    @if (withActions()) {<div class="mt-3 flex flex-wrap gap-2"><ng-content select="[actions]" /></div>}
  `,
})
export class CampaignCard {
  readonly c = input.required<Campaign>();
  readonly now = input.required<number>();
  readonly showSeller = input(false, { transform: booleanAttribute });
  readonly withActions = input(false, { transform: booleanAttribute });
  protected readonly date = date;
  protected readonly rupees = rupees;
  protected readonly st = computed(() => CAMPAIGN_STATUS[this.c().status] ?? { label: this.c().status, tone: "gray" as Tone });
  protected readonly note = computed(() => deliveryNote(this.c(), this.now()));
  protected readonly placements = computed(() => this.c().placements.map((p) => PLACEMENT_LABEL[p] ?? p).join(", "));
}
