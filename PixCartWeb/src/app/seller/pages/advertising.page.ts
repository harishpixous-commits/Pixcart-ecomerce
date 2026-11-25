/*
 * Sponsored products for the seller: 30-day totals, campaigns (create, edit, pause, resume, end), a report per campaign and
 * the ad charges. Port of frontend/src/app/seller/advertising/page.tsx (HowItWorks, CampaignEditor and CampaignReport included).
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import { BadgeIndianRupee, MousePointerClick, Search, Target, X, type LucideIconData } from "lucide-angular";
import { ApiError, api, latestOnly, quietly } from "../../core/api";
import { dateTime, paiseToInput, pct, rupees, toLocalInput, toPaise } from "../../core/format";
import { PageHeader, Stat, Tabs } from "../../shared/portal-shell";
import { CampaignCard, fillDays, type AdDay, type AdRules, type Campaign } from "../../shared/portal/ad-campaigns";
import { DailyBars, HBar } from "../../shared/portal/charts";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, TextField, Toast } from "../../shared/ui/ui";

type Totals = { impressions: number; clicks: number; invalid_clicks: number; spend: number; orders: number; sales: number; acos: number | null };
type ReportProduct = { title: string; impressions: number; clicks: number; invalid_clicks: number; spend: number };
type Data = { campaigns: Campaign[]; rules: AdRules; totals_30d: Totals; billing: { amount: number; description: string; at: string }[] };
type AdProduct = { id: string; title: string; image: string; price: number; in_stock: boolean; rating_avg: number };

const LIVE = ["pending", "active", "paused", "rejected"];

/* ---------------------------------------------------------------- how it works */

@Component({
  selector: "pc-seller-ads-how",
  imports: [Icon, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block rounded-xl bg-white p-5", "data-testid": "ads-how" },
  template: `
    <h2 class="text-lg font-semibold">How sponsored products work</h2>
    <ol class="mt-3 grid gap-4 md:grid-cols-3">
      @for (s of steps(); track s.title; let i = $index) {
        <li class="flex gap-3">
          <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-peacock-light text-peacock"><svg [pcIcon]="s.icon" class="h-5 w-5" aria-hidden="true" /></span>
          <div>
            <p class="font-semibold">{{ i + 1 }}. {{ s.title }}</p>
            <p class="text-sm text-ink-soft">{{ s.text }}</p>
          </div>
        </li>
      }
    </ol>
    @if (rules().enabled) {<button pcButton class="mt-4" (click)="start.emit()">Create your first campaign</button>}
  `,
})
export class SellerAdsHowItWorks {
  readonly rules = input.required<AdRules>();
  readonly start = output<void>();
  protected readonly steps = computed<{ icon: LucideIconData; title: string; text: string }[]>(() => {
    const rules = this.rules();
    return [
      { icon: Target, title: "Choose products and places", text: "Pick the products to promote and where they show: search results, similar product pages, the home page." },
      { icon: BadgeIndianRupee, title: "Set a bid and a budget", text: `Your bid is the most you pay for a click (from ${rupees(rules.min_bid_paise)}). The daily budget caps what you spend in a day.` },
      { icon: MousePointerClick, title: "Pay only for genuine clicks", text: `Ads are marked "Sponsored". Repeat, reused and suspicious clicks are free. Orders placed within ${rules.attribution_days} days of a click count as ad sales in your reports.` },
    ];
  });
}

/* ---------------------------------------------------------------- editor */

type Form = { name: string; ids: string[]; placements: string[]; keywords: string[]; bid: string; daily: string; total: string; starts: string; ends: string };

@Component({
  selector: "pc-seller-campaign-editor",
  imports: [Icon, Button, ErrorNote, Field, Input, TextField, PageLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="save($event)" class="flex flex-col gap-4" data-testid="campaign-form">
      <pc-error-note [message]="error()" />
      <pc-text-field label="Campaign name" [value]="f().name" (valueChange)="set('name', $event)" [maxlength]="80" placeholder="e.g. Diwali earbuds push" [required]="true" />

      <fieldset>
        <legend class="mb-1 flex w-full items-center justify-between text-sm font-medium">
          <span>Products to promote</span>
          <span class="text-xs font-normal text-ink-faint">{{ f().ids.length }} chosen (up to 50)</span>
        </legend>
        <div class="relative mb-2">
          <svg [pcIcon]="Search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
          <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Filter your live products" aria-label="Filter your live products" class="pl-9" />
        </div>
        <div class="max-h-60 overflow-y-auto rounded-xl ring-1 ring-line">
          @if (!products()) {
            <div class="p-6"><pc-page-loader /></div>
          } @else if (list().length === 0) {
            <p class="p-4 text-sm text-ink-soft">{{ products()!.length === 0 ? "You have no live products yet." : "No product matches." }}</p>
          } @else {
            @for (p of list(); track p.id) {
              <label [class]="chosen().has(p.id) ? 'flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-0 bg-peacock-light/40' : 'flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-0 hover:bg-mist'">
                <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="chosen().has(p.id)" (change)="toggleProduct(p.id)" />
                @if (p.image) {<img [src]="p.image" alt="" class="h-10 w-10 shrink-0 rounded object-contain" />} @else {<span class="h-10 w-10 shrink-0 rounded bg-mist"></span>}
                <span class="min-w-0 flex-1">
                  <span class="line-clamp-1 text-sm font-medium">{{ p.title }}</span>
                  <span class="text-xs text-ink-faint">{{ rupees(p.price) }}{{ p.rating_avg ? " · " + p.rating_avg.toFixed(1) + " ★" : "" }}{{ p.in_stock ? "" : " · out of stock (not shown until restocked)" }}</span>
                </span>
              </label>
            }
          }
        </div>
      </fieldset>

      <fieldset>
        <legend class="mb-1 text-sm font-medium">Where the ads show</legend>
        <div class="grid gap-2 sm:grid-cols-3">
          @for (pl of placementList(); track pl[0]) {
            <label [class]="placementCls(pl[0], pl[1].enabled)">
              <input type="checkbox" class="mt-0.5 h-4 w-4 accent-peacock" [checked]="f().placements.includes(pl[0])" [disabled]="!pl[1].enabled" (change)="togglePlacement(pl[0])" />
              <span>
                <span class="block text-sm font-semibold">{{ pl[1].label }}</span>
                <span class="block text-xs text-ink-soft">{{ !pl[1].enabled ? "Off on this marketplace" : pl[0] === "search" ? "At the top of matching search results" : pl[0] === "product" ? "On pages of similar products" : "In the Sponsored row on the home page" }}</span>
              </span>
            </label>
          }
        </div>
      </fieldset>

      @if (f().placements.includes("search")) {
        <pc-field label="Search keywords (optional)" hint="Your ad shows when a search contains one of these words. Without keywords, it shows when the search words match the product title. Press Enter or comma to add.">
          <div class="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-white px-2 py-1.5 focus-within:border-peacock focus-within:ring-2 focus-within:ring-peacock/20">
            @for (w of f().keywords; track w) {
              <span class="inline-flex items-center gap-1 rounded-full bg-peacock-light px-2 py-0.5 text-sm text-peacock">
                {{ w }}
                <button type="button" [attr.aria-label]="'Remove ' + w" (click)="removeKeyword(w)" class="rounded-full hover:bg-white/60"><svg [pcIcon]="X" class="h-3.5 w-3.5" /></button>
              </span>
            }
            <input [value]="kw()" (input)="onKw($event)" (keydown)="onKwKey($event)" (blur)="kw().trim() && addKeywords(kw())"
              [placeholder]="f().keywords.length ? '' : 'wireless earbuds, bluetooth'" aria-label="Add a keyword"
              class="h-7 min-w-[8rem] flex-1 bg-transparent text-[15px] outline-none" />
          </div>
        </pc-field>
      }

      <div class="grid gap-3 sm:grid-cols-3">
        <pc-text-field label="Bid per click (₹)" inputmode="decimal" [value]="f().bid" (valueChange)="set('bid', $event)" [hint]="'At least ' + rupees(rules().min_bid_paise) + '. Higher bids show first.'" />
        <pc-text-field label="Daily budget (₹)" inputmode="decimal" [value]="f().daily" (valueChange)="set('daily', $event)" [hint]="'At least ' + rupees(rules().min_daily_budget_paise)" />
        <pc-text-field label="Total budget (₹, optional)" inputmode="decimal" [value]="f().total" (valueChange)="set('total', $event)" hint="The campaign ends when it is spent" />
        <pc-text-field label="Starts (optional)" type="datetime-local" [value]="f().starts" (valueChange)="set('starts', $event)" hint="Empty: starts now" />
        <pc-text-field label="Ends (optional)" type="datetime-local" [value]="f().ends" (valueChange)="set('ends', $event)" hint="Empty: runs until you end it" />
      </div>

      <p class="rounded-xl bg-mist px-4 py-3 text-sm" data-testid="campaign-estimate">
        @if (bid() > 0 && daily() >= bid()) {
          At most <b>{{ rupees(daily()) }}</b> a day: about <b>{{ clicksPerDay().toLocaleString("en-IN") }}</b> clicks at your bid. You pay only for clicks, plus GST ({{ pct(rules().gst_bps) }}).
        } @else {
          Enter a bid and a daily budget that covers at least one click.
        }
        @if (rules().need_approval) { The marketplace team checks new campaigns and changes to products or keywords before they run.}
      </p>
      <div><button pcButton type="submit" [loading]="saving()">{{ campaign() ? "Save changes" : rules().need_approval ? "Send for approval" : "Start campaign" }}</button></div>
    </form>
  `,
})
export class SellerCampaignEditor {
  readonly rules = input.required<AdRules>();
  readonly campaign = input<Campaign | null>(null);
  readonly done = output<Campaign>();
  protected readonly Search = Search;
  protected readonly X = X;
  protected readonly rupees = rupees;
  protected readonly pct = pct;
  protected readonly products = signal<AdProduct[] | null>(null);
  protected readonly q = signal("");
  protected readonly f = signal<Form>({ name: "", ids: [], placements: [], keywords: [], bid: "", daily: "", total: "", starts: "", ends: "" });
  protected readonly kw = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  private started = false;

  protected readonly bid = computed(() => toPaise(this.f().bid) ?? 0);
  protected readonly daily = computed(() => toPaise(this.f().daily) ?? 0);
  private readonly total = computed(() => (this.f().total ? toPaise(this.f().total) ?? 0 : null));
  protected readonly clicksPerDay = computed(() => (this.bid() > 0 ? Math.floor(this.daily() / this.bid()) : 0));
  protected readonly list = computed(() => {
    const q = this.q().trim().toLowerCase();
    return (this.products() ?? []).filter((p) => !q || p.title.toLowerCase().includes(q));
  });
  protected readonly chosen = computed(() => new Set(this.f().ids));
  protected readonly placementList = computed(() => Object.entries(this.rules().placements));

  constructor() {
    effect(() => {
      // the form starts from the campaign being edited (useState initialiser in the reference)
      const rules = this.rules();
      const campaign = this.campaign();
      if (this.started) return;
      this.started = true;
      this.f.set({
        name: campaign?.name ?? "",
        ids: campaign?.products.map((p) => p.id) ?? [],
        placements: campaign?.placements ?? Object.entries(rules.placements).filter(([, v]) => v.enabled).map(([k]) => k),
        keywords: campaign?.keywords ?? [],
        bid: paiseToInput(campaign?.bid_paise ?? Math.max(rules.min_bid_paise, 500)),
        daily: paiseToInput(campaign?.daily_budget_paise ?? Math.max(rules.min_daily_budget_paise, 20000)),
        total: campaign?.total_budget_paise ? paiseToInput(campaign.total_budget_paise) : "",
        starts: campaign ? toLocalInput(campaign.starts_at) : "",
        ends: campaign?.ends_at ? toLocalInput(campaign.ends_at) : "",
      });
    });
    api<AdProduct[]>("/api/seller/ads/products").then((p) => this.products.set(p)).catch(quietly);
  }

  protected set<K extends keyof Form>(k: K, v: Form[K]): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected placementCls(k: string, enabled: boolean): string {
    return cx("flex items-start gap-2 rounded-xl border p-3", !enabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      this.f().placements.includes(k) ? "border-peacock bg-peacock-light/40" : "border-line hover:bg-mist");
  }

  protected toggleProduct(id: string): void {
    const f = this.f();
    this.set("ids", this.chosen().has(id) ? f.ids.filter((x) => x !== id) : f.ids.length >= 50 ? f.ids : [...f.ids, id]);
  }

  protected togglePlacement(k: string): void {
    const f = this.f();
    this.set("placements", f.placements.includes(k) ? f.placements.filter((x) => x !== k) : [...f.placements, k]);
  }

  protected removeKeyword(w: string): void {
    this.set("keywords", this.f().keywords.filter((x) => x !== w));
  }

  protected addKeywords(text: string): void {
    const words = text.split(/[,\n]/).map((w) => w.trim().toLowerCase().replace(/\s+/g, " ")).filter((w) => w.length >= 2 && w.length <= 40);
    const next = [...this.f().keywords];
    for (const w of words) if (!next.includes(w) && next.length < 30) next.push(w);
    this.set("keywords", next);
    this.kw.set("");
  }

  protected onKw(e: Event): void {
    const el = e.target as HTMLInputElement;
    if (el.value.includes(",")) {
      this.addKeywords(el.value);
      el.value = "";
    } else this.kw.set(el.value);
  }

  protected onKwKey(e: KeyboardEvent): void {
    const kw = this.kw();
    if (e.key === "Enter") {
      e.preventDefault();
      if (kw.trim()) {
        this.addKeywords(kw);
        (e.target as HTMLInputElement).value = "";
      }
    } else if (e.key === "Backspace" && !kw && this.f().keywords.length) this.set("keywords", this.f().keywords.slice(0, -1));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    this.error.set(null);
    const f = this.f();
    const rules = this.rules();
    const bid = this.bid();
    const daily = this.daily();
    const total = this.total();
    const kw = this.kw();
    if (f.name.trim().length < 3) return void this.error.set("Give the campaign a name (at least 3 characters)");
    if (f.ids.length === 0) return void this.error.set("Choose at least one product to promote");
    if (f.placements.length === 0) return void this.error.set("Choose where the ads show");
    if (bid < rules.min_bid_paise) return void this.error.set(`Bid at least ${rupees(rules.min_bid_paise)} per click`);
    if (daily < rules.min_daily_budget_paise) return void this.error.set(`Set a daily budget of at least ${rupees(rules.min_daily_budget_paise)}`);
    if (daily < bid) return void this.error.set("The daily budget must cover at least one click");
    if (total !== null && (!total || total < daily)) return void this.error.set("The total budget cannot be less than the daily budget");
    if (f.starts && f.ends && new Date(f.ends) <= new Date(f.starts)) return void this.error.set("The campaign must end after it starts");
    const pending = kw.trim() ? [...f.keywords, ...kw.split(",").map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2)] : f.keywords;
    this.saving.set(true);
    try {
      const body = {
        name: f.name.trim(), product_ids: f.ids, placements: f.placements, keywords: pending.slice(0, 30), bid_paise: bid, daily_budget_paise: daily,
        total_budget_paise: total, starts_at: f.starts ? new Date(f.starts).toISOString() : null, ends_at: f.ends ? new Date(f.ends).toISOString() : null,
      };
      const campaign = this.campaign();
      const out = campaign
        ? await api<Campaign>(`/api/seller/ads/${campaign.id}`, { method: "PUT", body })
        : await api<Campaign>("/api/seller/ads", { method: "POST", body });
      this.done.emit(out);
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save the campaign");
    } finally {
      this.saving.set(false);
    }
  }
}

/* ---------------------------------------------------------------- report */

@Component({
  selector: "pc-seller-campaign-report",
  imports: [DailyBars, HBar, PageLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (r() && r()!.key === key()) {
      <div class="flex flex-col gap-4" data-testid="campaign-report">
        <div class="flex flex-wrap items-center gap-2">
          @for (n of periods; track n) {
            <button type="button" (click)="days.set(n)" [class]="days() === n ? 'rounded-full px-3 py-1 text-sm font-semibold bg-peacock text-white' : 'rounded-full px-3 py-1 text-sm font-semibold bg-mist hover:bg-line'">{{ n }} days</button>
          }
          <span class="ml-auto text-sm text-ink-soft">
            {{ sum().impressions.toLocaleString("en-IN") }} impressions · {{ sum().clicks.toLocaleString("en-IN") }} clicks · {{ rupees(sum().spend) }} · {{ sum().invalid.toLocaleString("en-IN") }} invalid clicks (free)
          </span>
        </div>
        <div class="flex gap-1 rounded-lg bg-mist p-1 text-sm" role="tablist" aria-label="Chart">
          @for (m of metrics; track m) {
            <button type="button" role="tab" [attr.aria-selected]="metric() === m" (click)="metric.set(m)"
              [class]="metric() === m ? 'flex-1 rounded-md px-3 py-1.5 font-semibold capitalize bg-white shadow-sm' : 'flex-1 rounded-md px-3 py-1.5 font-semibold capitalize text-ink-soft'">{{ m }}</button>
          }
        </div>
        <pc-daily-bars [series]="series()" [valueKey]="metric()" [money]="metric() === 'spend'" />
        <div>
          <h3 class="mb-2 font-semibold">Clicks by product</h3>
          @if (r()!.products.length === 0) {
            <p class="text-sm text-ink-faint">No clicks in this period yet.</p>
          } @else {
            <ul pcHBar [items]="bars()"></ul>
          }
        </div>
      </div>
    } @else {
      <pc-page-loader />
    }
  `,
})
export class SellerCampaignReport {
  readonly campaign = input.required<Campaign>();
  protected readonly rupees = rupees;
  protected readonly periods = [7, 30, 90] as const;
  protected readonly metrics = ["clicks", "spend", "impressions"] as const;
  protected readonly days = signal<number>(30);
  protected readonly metric = signal<"clicks" | "spend" | "impressions">("clicks");
  protected readonly r = signal<{ key: string; days: AdDay[]; products: ReportProduct[] } | null>(null);
  protected readonly key = computed(() => `${this.campaign().id}:${this.days()}`);
  protected readonly series = computed(() => fillDays(this.r()?.days ?? [], this.days()));
  protected readonly sum = computed(() => this.series().reduce((a, x) => ({ impressions: a.impressions + x.impressions, clicks: a.clicks + x.clicks, invalid: a.invalid + x.invalid_clicks, spend: a.spend + x.spend }),
    { impressions: 0, clicks: 0, invalid: 0, spend: 0 }));
  protected readonly bars = computed(() => (this.r()?.products ?? []).map((p) => ({ label: p.title, value: p.clicks,
    display: `${p.clicks} clicks · ${rupees(p.spend)}${p.invalid_clicks ? ` · ${p.invalid_clicks} invalid` : ""}` })));

  constructor() {
    effect((onCleanup) => {
      const id = this.campaign().id;
      const days = this.days();
      const key = this.key();
      let live = true;
      api<{ days: AdDay[]; products: ReportProduct[] }>(`/api/seller/ads/${id}/report`, { query: { days } })
        .then((x) => { if (live) this.r.set({ key, ...x }); })
        .catch(quietly);
      onCleanup(() => { live = false; });
    });
  }
}

/* ---------------------------------------------------------------- page */

@Component({
  selector: "pc-seller-advertising-page",
  imports: [PageHeader, Stat, Tabs, CampaignCard, Button, EmptyState, ErrorNote, Modal, PageLoader, SellerAdsHowItWorks, SellerCampaignEditor, SellerCampaignReport],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (d(); as d) {
      <div>
        <pc-page-header title="Advertising"
          sub="Sponsored products: show your products at the top of search results, on similar product pages and on the home page. You pay only when a shopper clicks."
          [withActions]="true">
          <button actions pcButton (click)="edit.set('new')" [disabled]="!d.rules.enabled">Create campaign</button>
        </pc-page-header>
        <pc-error-note [message]="error()" />
        @if (!d.rules.enabled) {
          <p class="mb-4 rounded-xl bg-marigold-light px-4 py-3 text-sm">Sponsored products are switched off on the marketplace right now. Your campaigns are not showing.</p>
        }

        <div class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label="Last 30 days">
          <pc-stat label="Impressions (30 days)" [value]="d.totals_30d.impressions.toLocaleString('en-IN')" />
          <pc-stat label="Clicks" [value]="d.totals_30d.clicks.toLocaleString('en-IN')" [hint]="ctr() + '% of impressions'" />
          <pc-stat label="Invalid clicks" [value]="d.totals_30d.invalid_clicks.toLocaleString('en-IN')" hint="Free: you are not charged" />
          <pc-stat label="Spend" [value]="rupees(d.totals_30d.spend)" [hint]="'+ GST ' + pct(d.rules.gst_bps)" />
          <pc-stat label="Ad sales" [value]="rupees(d.totals_30d.sales)" [hint]="d.totals_30d.orders + ' order' + (d.totals_30d.orders === 1 ? '' : 's') + ' within ' + d.rules.attribution_days + ' days of a click'" />
          <pc-stat label="ACOS" [value]="d.totals_30d.acos === null ? '—' : d.totals_30d.acos + '%'" hint="Spend as a share of ad sales; lower is better" />
        </div>

        @if (d.campaigns.length === 0) {
          <pc-seller-ads-how [rules]="d.rules" (start)="edit.set('new')" />
        } @else {
          <pc-tabs [value]="tab()" (valueChange)="tab.set($event)" [items]="tabs()" />
          @if (shown().length === 0) {
            <pc-empty-state title="Nothing here" body="Campaigns in this list show up here." [hasAction]="false" />
          } @else {
            <div class="flex flex-col gap-3">
              @for (c of shown(); track c.id) {
                <pc-campaign-card [c]="c" [now]="now" [withActions]="true">
                  <button actions pcButton size="sm" variant="secondary" (click)="report.set(c)">Report</button>
                  @if (c.status !== "ended") {<button actions pcButton size="sm" variant="secondary" (click)="edit.set(c)">{{ c.status === "rejected" ? "Edit and send again" : "Edit" }}</button>}
                  @if (c.status === "active") {<button actions pcButton size="sm" variant="ghost" [loading]="busy() === c.id + 'pause'" (click)="act(c, 'pause')">Pause</button>}
                  @if (c.status === "paused") {<button actions pcButton size="sm" [loading]="busy() === c.id + 'resume'" (click)="act(c, 'resume')">Resume</button>}
                  @if (["pending", "active", "paused"].includes(c.status)) {<button actions pcButton size="sm" variant="danger" (click)="ending.set(c)">End</button>}
                </pc-campaign-card>
              }
            </div>
          }
        }

        <section class="mt-6 rounded-xl bg-white p-4" aria-labelledby="ad-charges">
          <h2 id="ad-charges" class="font-semibold">Ad charges</h2>
          <p class="text-sm text-ink-soft">Each day&apos;s clicks plus GST ({{ pct(d.rules.gst_bps) }}) are taken from your next payout. You pay only for genuine clicks:</p>
          <ul class="mt-1 list-disc pl-5 text-sm text-ink-soft" data-testid="ad-click-rules">
            <li>Each ad link counts once, and only for the shopper it was shown to.</li>
            <li>A shopper&apos;s repeat clicks on the same product within 24 hours are free.</li>
            <li>Each campaign pays for at most {{ d.rules.paid_clicks_per_address }} clicks a day from one internet address, and {{ d.rules.paid_clicks_per_network }} from one network.</li>
            <li>Links from pages opened more than {{ d.rules.link_hours }} hours ago are free.</li>
          </ul>
          <p class="mt-1 text-sm text-ink-soft">Other clicks still open your product, cost you nothing and show as invalid clicks in your reports.</p>
          @if (d.billing.length === 0) {
            <p class="mt-2 text-sm text-ink-faint">No charges yet.</p>
          } @else {
            <ul class="mt-2 divide-y divide-line">
              @for (b of d.billing; track $index) {
                <li class="flex items-start justify-between gap-3 py-2 text-sm">
                  <span class="min-w-0">{{ b.description }}<span class="block text-xs text-ink-faint">{{ dateTime(b.at) }}</span></span>
                  <span class="shrink-0 font-semibold text-vermilion">− {{ rupees(abs(b.amount)) }}</span>
                </li>
              }
            </ul>
          }
        </section>

        <pc-modal [open]="edit() !== null" (close)="edit.set(null)" [title]="editTitle()" [wide]="true">
          @if (edit() !== null) {
            <pc-seller-campaign-editor [rules]="d.rules" [campaign]="edit() === 'new' ? null : $any(edit())" (done)="saved($event)" />
          }
        </pc-modal>
        <pc-modal [open]="report() !== null" (close)="report.set(null)" [title]="report() ? 'Report: ' + report()!.name : 'Report'" [wide]="true">
          @if (report(); as report) {<pc-seller-campaign-report [campaign]="report" />}
        </pc-modal>
        <pc-modal [open]="ending() !== null" (close)="ending.set(null)" title="End this campaign?">
          @if (ending(); as ending) {
            <div class="flex flex-col gap-3">
              <p class="text-ink-soft">Ads for <b class="text-ink">{{ ending.name }}</b> stop showing right away. You cannot restart an ended campaign, but you can create a new one.</p>
              <div class="flex gap-2">
                <button pcButton variant="danger" [loading]="busy() === ending.id + 'end'" (click)="act(ending, 'end')">End campaign</button>
                <button pcButton variant="ghost" (click)="this.ending.set(null)">Keep it</button>
              </div>
            </div>
          }
        </pc-modal>
      </div>
    } @else if (error()) {
      <pc-error-note [message]="error()" />
    } @else {
      <pc-page-loader />
    }
  `,
})
export class SellerAdvertisingPage {
  private readonly toast = inject(Toast);
  protected readonly now = Date.now();
  protected readonly rupees = rupees;
  protected readonly pct = pct;
  protected readonly dateTime = dateTime;
  protected readonly abs = Math.abs;
  protected readonly d = signal<Data | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly tab = signal("live");
  protected readonly edit = signal<Campaign | "new" | null>(null);
  protected readonly report = signal<Campaign | null>(null);
  protected readonly ending = signal<Campaign | null>(null);
  protected readonly busy = signal<string | null>(null);
  private readonly track = latestOnly();

  private readonly live = computed(() => (this.d()?.campaigns ?? []).filter((c) => LIVE.includes(c.status)));
  private readonly ended = computed(() => (this.d()?.campaigns ?? []).filter((c) => !LIVE.includes(c.status)));
  protected readonly shown = computed(() => (this.tab() === "live" ? this.live() : this.tab() === "ended" ? this.ended() : this.d()?.campaigns ?? []));
  protected readonly ctr = computed(() => {
    const t = this.d()?.totals_30d;
    return t && t.impressions ? Math.round((10000 * t.clicks) / t.impressions) / 100 : 0;
  });
  protected readonly tabs = computed(() => [
    { value: "live", label: "Current", count: this.live().length },
    { value: "ended", label: "Ended", count: this.ended().length },
    { value: "all", label: "All", count: this.d()?.campaigns.length ?? 0 },
  ]);
  protected readonly editTitle = computed(() => {
    const e = this.edit();
    return e === "new" ? "New campaign" : `Edit ${e?.name ?? ""}`;
  });

  constructor() {
    this.load();
  }

  private load(): void {
    this.track(api<Data>("/api/seller/ads"), (x) => { this.d.set(x); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load your campaigns"));
  }

  protected async act(c: Campaign, action: "pause" | "resume" | "end"): Promise<void> {
    this.busy.set(c.id + action);
    try {
      await api(`/api/seller/ads/${c.id}/${action}`, { method: "POST" });
      this.toast.show(action === "pause" ? "Campaign paused" : action === "resume" ? "Campaign is running again" : "Campaign ended");
      this.ending.set(null);
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not update the campaign", "error");
    } finally {
      this.busy.set(null);
    }
  }

  protected saved(c: Campaign): void {
    this.edit.set(null);
    this.toast.show(c.status === "pending" ? "Campaign sent. The marketplace team checks it before it runs." : "Campaign saved");
    this.tab.set("live");
    this.load();
  }
}
