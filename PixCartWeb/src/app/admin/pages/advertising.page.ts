/* Admin → Advertising: sponsored product campaigns, ad revenue and the ad settings. Port of frontend/src/app/admin/advertising/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Search } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, latestOnly } from "../../core/api";
import { rupees } from "../../core/format";
import { CampaignCard, fillDays, type AdDay, type AdRules, type Campaign } from "../../shared/portal/ad-campaigns";
import { DailyBars } from "../../shared/portal/charts";
import { PageHeader, Stat, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Autofocus, Button, EmptyState, ErrorNote, Input, Modal, Pagination, Textarea, Toast } from "../../shared/ui/ui";
import { debounced } from "../shared/admin-helpers";
import { SettingsBlock, type SettingField } from "../shared/settings-block";

type Data = {
  items: Campaign[]; total: number; page: number; page_size: number; counts: Record<string, number>; rules: AdRules;
  revenue_30d: { impressions: number; clicks: number; invalid_clicks: number; spend: number; days: AdDay[] };
};
type Action = "approve" | "reject" | "pause" | "resume" | "end";

const SETTINGS: SettingField[] = [
  { k: "feature_ads", kind: "bool", label: "Sponsored products are on", hint: "Sellers can run campaigns and shoppers see products marked \"Sponsored\". Off stops all ads at once." },
  { k: "ads_need_approval", kind: "bool", label: "Check campaigns before they run", hint: "New campaigns, and changes to their products or keywords, wait here for approval." },
  { k: "ads_search", kind: "bool", label: "Show ads in search results", hint: "At the top of matching results and in a Sponsored row below them." },
  { k: "ads_product", kind: "bool", label: "Show ads on product pages", hint: "A Sponsored row of similar products from the same category." },
  { k: "ads_home", kind: "bool", label: "Show ads on the home page", hint: "In Sponsored sections you add in Storefront." },
  { k: "ads_min_bid_paise", kind: "rupees", label: "Lowest bid per click (₹)", hint: "₹1 to ₹1,000", min: 100, max: 100_000, needs: "feature_ads" },
  { k: "ads_min_daily_budget_paise", kind: "rupees", label: "Lowest daily budget (₹)", hint: "₹10 to ₹1,00,000", min: 1000, max: 10_000_000, needs: "feature_ads" },
  { k: "ads_per_search", kind: "int", label: "Sponsored results at the top of search", hint: "0 to 6 (0 = only the Sponsored row below the results)", min: 0, max: 6, needs: "feature_ads" },
  { k: "ads_per_rail", kind: "int", label: "Products in a Sponsored row", hint: "4 to 20", min: 4, max: 20, needs: "feature_ads" },
  { k: "ads_paid_clicks_per_address", kind: "int", label: "Paid clicks from one internet address a day", min: 1, max: 50, needs: "feature_ads",
    hint: "1 to 50, per campaign. Later clicks from that address are free and show as invalid clicks." },
  { k: "ads_paid_clicks_per_network", kind: "int", label: "Paid clicks from one network a day", min: 1, max: 500, needs: "feature_ads",
    hint: "1 to 500, per campaign. A network is addresses that start the same, like 49.36.12.x. Many shoppers can share one mobile network." },
];

const TOAST: Record<Action, string> = { approve: "Campaign approved", reject: "Campaign rejected", pause: "Campaign paused", resume: "Campaign running again", end: "Campaign ended" };
const METRICS = [["spend", "Revenue"], ["clicks", "Clicks"], ["impressions", "Impressions"]] as const;

@Component({
  selector: "pc-admin-advertising-page",
  imports: [PageHeader, Stat, Tabs, DailyBars, CampaignCard, SettingsBlock, Icon, PageLoader, Autofocus, Button, EmptyState, ErrorNote, Input, Modal, Pagination, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Advertising" sub="Sponsored products: sellers pay per click to show products in search, on product pages and on the home page. Ad spend plus GST is taken from their payouts." [withActions]="true">
      <button actions pcButton variant="secondary" (click)="billNow()" [loading]="busy() === 'bill'">Bill finished days now</button>
    </pc-page-header>
    @if (rev() && tab() !== "settings") {
      <section class="mb-4 grid gap-3 lg:grid-cols-[1fr_2fr]">
        <div class="grid grid-cols-2 gap-3">
          <pc-stat label="Ad revenue (30 days)" [value]="rupees(rev()!.spend)" hint="Before GST" />
          <pc-stat label="Clicks" [value]="rev()!.clicks.toLocaleString('en-IN')" [hint]="rev()!.clicks ? rupees(round(rev()!.spend / rev()!.clicks)) + ' per click on average' : undefined" />
          <pc-stat label="Impressions" [value]="rev()!.impressions.toLocaleString('en-IN')" />
          <pc-stat label="Click-through rate" [value]="ctr()" />
          <div class="col-span-2">
            <pc-stat label="Invalid clicks" [value]="rev()!.invalid_clicks.toLocaleString('en-IN')"
              hint="Not charged: reused or expired links, clicks by someone the ad was not shown to, or too many from one address or network" />
          </div>
        </div>
        <div class="rounded-xl bg-white p-4">
          <div class="mb-2 flex gap-1 rounded-lg bg-mist p-1 text-sm" role="tablist" aria-label="Chart">
            @for (m of metrics; track m[0]) {
              <button type="button" role="tab" [attr.aria-selected]="metric() === m[0]" (click)="metric.set(m[0])"
                [class]="metric() === m[0] ? 'flex-1 rounded-md px-3 py-1.5 font-semibold bg-white shadow-sm' : 'flex-1 rounded-md px-3 py-1.5 font-semibold text-ink-soft'">{{ m[1] }}</button>
            }
          </div>
          <pc-daily-bars [series]="series()" [valueKey]="metric()" [money]="metric() === 'spend'" [height]="140" />
        </div>
      </section>
    }
    <pc-tabs [value]="tab()" (valueChange)="tab.set($event); page.set(1)" [items]="tabs()" />
    @if (tab() === "settings") {
      <pc-settings-block title="Sponsored products settings" sub="Where ads may show, the lowest bid and budget, how many sponsored products appear, and how many clicks from one place sellers pay for." [fields]="settings" saveLabel="Save ad settings" />
    } @else {
      <div class="relative mb-3 max-w-md">
        <svg [pcIcon]="Search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
        <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Search by campaign or seller" aria-label="Search campaigns" class="pl-9" />
      </div>
      <pc-error-note [message]="error()" />
      @if (!d()) {
        @if (!error()) {<pc-page-loader />}
      } @else if (d()!.items.length === 0) {
        <pc-empty-state [title]="tab() === 'pending' ? 'Nothing waiting' : 'No campaigns here'" [body]="tab() === 'pending' ? 'New campaigns and changed keywords or products show up here for approval.' : undefined" [hasAction]="false" />
      } @else {
        <div class="flex flex-col gap-3">
          @for (c of d()!.items; track c.id) {
            <pc-campaign-card [c]="c" [now]="now" [showSeller]="true" [withActions]="true">
              @if (c.status === "pending") {<button actions pcButton size="sm" [loading]="busy() === c.id + 'approve'" (click)="run(c, 'approve')">Approve</button>}
              @if (isOpen(c)) {<button actions pcButton size="sm" variant="danger" (click)="ask(c, 'reject')">Reject</button>}
              @if (c.status === "active") {<button actions pcButton size="sm" variant="secondary" [loading]="busy() === c.id + 'pause'" (click)="run(c, 'pause')">Pause</button>}
              @if (c.status === "paused") {<button actions pcButton size="sm" [loading]="busy() === c.id + 'resume'" (click)="run(c, 'resume')">Resume</button>}
              @if (isOpen(c)) {<button actions pcButton size="sm" variant="ghost" (click)="ask(c, 'end')">End</button>}
            </pc-campaign-card>
          }
        </div>
      }
      @if (d()) {<pc-pagination [page]="page()" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />}
    }

    <pc-modal [open]="act() !== null" (close)="act.set(null)" [title]="act()?.action === 'reject' ? 'Reject this campaign' : 'End this campaign'">
      @if (act(); as a) {
        <form class="flex flex-col gap-3" (submit)="$event.preventDefault(); run(a.c, a.action, reason().trim())">
          <p class="text-sm text-ink-soft"><b class="text-ink">{{ a.c.name }}</b>{{ a.c.seller ? " from " + a.c.seller : "" }}. The seller sees your reason. {{ a.action === "end" ? "An ended campaign cannot run again." : "The seller can edit it and send it again." }}</p>
          <textarea pcTextarea rows="3" maxlength="300" [value]="reason()" (input)="reason.set($any($event.target).value)" aria-label="Reason" pcAutofocus
            [placeholder]="a.action === 'reject' ? rejectHint : 'e.g. Product listing under review'"></textarea>
          <div class="flex gap-2">
            <button pcButton type="submit" variant="danger" [loading]="busy() === a.c.id + a.action" [disabled]="reason().trim().length < 5">{{ a.action === "reject" ? "Reject campaign" : "End campaign" }}</button>
            <button pcButton type="button" variant="ghost" (click)="act.set(null)">Back</button>
          </div>
        </form>
      }
    </pc-modal>
  `,
})
export class AdminAdvertisingPage {
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly Search = Search;
  protected readonly rupees = rupees;
  protected readonly round = Math.round;
  protected readonly settings = SETTINGS;
  protected readonly metrics = METRICS;
  protected readonly rejectHint = "e.g. Keywords use another brand's name";
  protected readonly now = Date.now();
  protected readonly tab = signal("pending");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly metric = signal<"spend" | "clicks" | "impressions">("spend");
  protected readonly d = signal<Data | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly act = signal<{ c: Campaign; action: Action } | null>(null);
  protected readonly reason = signal("");
  protected readonly busy = signal<string | null>(null);
  private readonly track = latestOnly();
  private readonly query = debounced(this.q, 300, () => this.page.set(1));
  protected readonly rev = computed(() => this.d()?.revenue_30d);
  protected readonly series = computed(() => { const r = this.rev(); return r ? fillDays(r.days, 30) : []; });
  protected readonly ctr = computed(() => { const r = this.rev()!; return r.impressions ? `${Math.round((10000 * r.clicks) / r.impressions) / 100}%` : "—"; });
  protected readonly tabs = computed(() => {
    const counts = this.d()?.counts ?? {};
    const all = Object.values(counts).reduce((a, b) => a + b, 0);
    return [
      { value: "pending", label: "Waiting for approval", count: counts["pending"] ?? 0 },
      { value: "active", label: "Running", count: counts["active"] ?? 0 },
      { value: "paused", label: "Paused", count: counts["paused"] ?? 0 },
      { value: "rejected", label: "Rejected", count: counts["rejected"] ?? 0 },
      { value: "ended", label: "Ended", count: counts["ended"] ?? 0 },
      { value: "all", label: "All", count: all },
      ...(this.admin.can("settings") ? [{ value: "settings", label: "Settings" }] : []),
    ];
  });

  constructor() {
    effect(() => this.load());
  }

  protected load(): void {
    const tab = this.tab();
    const query = this.query();
    const page = this.page();
    if (tab === "settings") return;
    this.track(api<Data>("/api/admin/ads", { query: { status: tab, q: query || undefined, page } }), (x) => { this.d.set(x); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load campaigns"));
  }

  protected isOpen(c: Campaign): boolean {
    return ["pending", "active", "paused"].includes(c.status);
  }

  protected ask(c: Campaign, action: Action): void {
    this.reason.set("");
    this.act.set({ c, action });
  }

  protected async run(c: Campaign, action: Action, why = ""): Promise<void> {
    this.busy.set(c.id + action);
    try {
      await api(`/api/admin/ads/${c.id}/${action}`, { method: "POST", body: { reason: why } });
      this.toast.show(TOAST[action] + ". The seller was told.");
      this.act.set(null);
      this.reason.set("");
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not update the campaign", "error");
    } finally {
      this.busy.set(null);
    }
  }

  protected async billNow(): Promise<void> {
    this.busy.set("bill");
    try {
      const r = await api<{ posted: number }>("/api/admin/ads/bill", { method: "POST" });
      this.toast.show(r.posted ? `${r.posted} charge${r.posted === 1 ? "" : "s"} posted to seller accounts` : "Nothing to bill: finished days are already billed");
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not bill", "error");
    } finally {
      this.busy.set(null);
    }
  }
}
