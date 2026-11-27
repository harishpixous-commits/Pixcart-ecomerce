/*
 * Admin → Overview (the admin dashboard): the go-live setup checklist, the delivery fleet live, an AI business brief,
 * work waiting for staff, and the period's sales numbers and charts. Port of frontend/src/app/admin/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from "@angular/core";
import { Sparkles } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, quietly } from "../../core/api";
import type { DeliveryOverview } from "../../core/delivery-types";
import { hoursLabel, rupees } from "../../core/format";
import { PageHeader, Stat } from "../../shared/portal-shell";
import { AiBadge, type AiRun } from "../../shared/portal/ai";
import { DailyBars, Delta, HBar } from "../../shared/portal/charts";
import { usePolling } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Select } from "../../shared/ui/ui";

type D = { orders_late_to_ship?: number; sellers_pending_review: number; products_pending_review: number; orders_today: number; gmv_30d: number; orders_30d: number; commission_30d: number; refunds_needing_attention: number; active_sellers: number; customers: number; live_products: number };
type K = {
  gmv: number; gmv_prev: number; orders: number; orders_prev: number; aov: number; units: number; commission: number; discounts: number;
  cancellation_rate: number; return_rate: number; returned_value: number; avg_hours_to_ship: number | null; views: number; add_to_cart: number;
  conversion_rate: number; cart_rate: number; series: { date: string; orders: number; gmv: number }[];
  top_products: { product_id: string; title: string; units: number; revenue: number }[];
  top_sellers?: { name: string; gmv: number; packages: number }[];
  top_categories?: { name: string; gmv: number }[];
  payment_mix?: Record<string, number | undefined>;
  new_customers?: number; buyers?: number; repeat_buyer_rate?: number; tickets_ack_overdue?: number;
};

type Setup = { done: number; total: number; items: { key: string; label: string; done: boolean; href: string }[] };

@Component({
  selector: "pc-setup-checklist",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (d() && d()!.done !== d()!.total) {
      <section class="rounded-xl border border-marigold bg-marigold-light p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p class="font-semibold">Before you go live: {{ d()!.done }} of {{ d()!.total }} done</p>
            <p class="text-sm text-ink-soft">Legal details, policies and payments the shop still needs.</p>
          </div>
          <button class="text-sm font-semibold text-peacock" (click)="open.set(!open())" [attr.aria-expanded]="open()">{{ open() ? "Hide" : "Show " + todo().length + " to do" }}</button>
        </div>
        <div class="mt-2 h-2 overflow-hidden rounded-full bg-white"><div class="h-full rounded-full bg-leaf" [style.width.%]="(d()!.done / d()!.total) * 100"></div></div>
        @if (open()) {
          <ul class="mt-3 flex flex-col gap-1">
            @for (i of todo(); track i.key) {<li><a [pcLink]="i.href" class="text-peacock hover:underline">{{ i.label }}</a></li>}
          </ul>
        }
      </section>
    }
  `,
})
export class SetupChecklist {
  protected readonly d = signal<Setup | null>(null);
  protected readonly open = signal(false);
  protected readonly todo = computed(() => (this.d()?.items ?? []).filter((i) => !i.done));
  constructor() {
    api<Setup>("/api/admin/setup-status").then((x) => this.d.set(x)).catch(() => {});
  }
}

@Component({
  selector: "pc-business-brief",
  imports: [Icon, AiBadge, Button, ErrorNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (allowed()) {
      <section class="rounded-xl bg-white p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold">Business brief</h2>
          @if (run()) {<pc-ai-badge [mode]="run()!.mode" />}
          <button pcButton size="sm" variant="secondary" class="ml-auto" (click)="write()" [loading]="busy()"><svg [pcIcon]="Sparkles" class="h-4 w-4" /> {{ run() ? "Write again" : "Summarise the last " + days() + " days" }}</button>
        </div>
        <pc-error-note [message]="error()" />
        @if (run()) {
          <p class="mt-2 whitespace-pre-line text-[15px] leading-relaxed">{{ run()!.output.text }}</p>
        } @else {
          <p class="mt-1 text-sm text-ink-soft">A plain-language summary of the numbers below, with suggested next steps. Written from these figures only.</p>
        }
      </section>
    }
  `,
})
export class BusinessBrief {
  readonly days = input.required<number>();
  private readonly admin = inject(AdminContext);
  protected readonly Sparkles = Sparkles;
  protected readonly allowed = computed(() => !!this.admin.me()?.permissions.includes("dashboard"));
  protected readonly run = signal<AiRun | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async write(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.run.set(await api<AiRun>("/api/admin/ai/tasks/business_brief", { method: "POST", body: { subject_id: String(this.days()) } }));
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not write the brief");
    } finally {
      this.busy.set(false);
    }
  }
}

/** The own delivery fleet at a glance, live: partners online now, packages waiting, trips moving, stuck trips. */
@Component({
  selector: "pc-fleet-glance",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (can() && o() && o()!.enabled && o()!.fleet_mode !== "off") {
      <section class="rounded-xl bg-white p-4" data-testid="fleet-glance">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="flex items-center gap-2 text-lg font-semibold">
            <span class="relative flex h-2.5 w-2.5">@if (o()!.online > 0) {<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-leaf/60 motion-reduce:animate-none"></span>}<span [class]="o()!.online > 0 ? 'relative inline-flex h-2.5 w-2.5 rounded-full bg-leaf' : 'relative inline-flex h-2.5 w-2.5 rounded-full bg-line'"></span></span>
            Delivery fleet, live
          </h2>
          <a pcLink="/admin/delivery/live" class="text-sm font-semibold text-peacock">See who is online</a>
        </div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
          @for (t of tiles(); track t.label) {
            <a [pcLink]="t.href" class="rounded-lg bg-mist px-3 py-2 hover:ring-2 hover:ring-peacock/20">
              <p [class]="'font-display text-2xl font-bold ' + t.tone">{{ t.value }}</p>
              <p class="text-xs text-ink-soft">{{ t.label }}</p>
            </a>
          }
        </div>
      </section>
    }
  `,
})
export class FleetGlance {
  private readonly admin = inject(AdminContext);
  protected readonly can = computed(() => !!this.admin.me()?.permissions.includes("delivery"));
  protected readonly o = signal<DeliveryOverview | null>(null);
  protected readonly tiles = computed(() => {
    const o = this.o();
    if (!o) return [];
    return [
      { label: "Partners online now", value: o.online, href: "/admin/delivery/live", tone: "text-leaf" },
      { label: "Waiting for a partner", value: o.queue, href: "/admin/delivery/queue", tone: o.queue ? "text-[#8A5A00]" : "text-ink" },
      { label: "On a trip", value: o.on_trip, href: "/admin/delivery/trips?status=active", tone: "text-peacock" },
      { label: "Stuck trips", value: o.stuck, href: "/admin/delivery/live", tone: o.stuck ? "text-vermilion" : "text-ink" },
      { label: "Delivered today", value: o.delivered_today, href: "/admin/delivery/trips?status=delivered", tone: "text-ink" },
    ];
  });

  constructor() {
    usePolling(() => untracked(() => {
      api<DeliveryOverview>("/api/admin/delivery/overview").then((x) => this.o.set(x)).catch(() => {});
    }), 30_000, this.can);
  }
}

@Component({
  selector: "pc-admin-home-page",
  imports: [PageHeader, Stat, PageLoader, Select, DailyBars, Delta, HBar, SetupChecklist, FleetGlance, BusinessBrief],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4">
      <pc-page-header title="Overview" [withActions]="true">
        <select actions pcSelect (change)="days.set(+$any($event.target).value)" class="w-auto" aria-label="Period">
          @for (p of periods; track p[0]) {<option [value]="p[0]" [selected]="days() === p[0]">{{ p[1] }}</option>}
        </select>
      </pc-page-header>
      <pc-setup-checklist />
      <pc-fleet-glance />
      <pc-business-brief [days]="days()" />
      @if (d()) {
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <pc-stat label="Sellers waiting for verification" [value]="d()!.sellers_pending_review" href="/admin/sellers?status=submitted" />
          <pc-stat label="Listings waiting for review" [value]="d()!.products_pending_review" href="/admin/products" />
          @if (d()!.orders_late_to_ship) {
            <pc-stat label="Orders late to ship" [value]="d()!.orders_late_to_ship!" href="/admin/orders" />
          }
          <pc-stat label="Refunds that failed" [value]="d()!.refunds_needing_attention" href="/admin/refunds?status=failed" />
          @if (tickets() !== undefined) {
            <pc-stat label="Tickets past the 48-hour reply limit" [value]="tickets()!" href="/admin/support?overdue=1" />
          } @else {
            <pc-stat label="Orders today" [value]="d()!.orders_today" href="/admin/orders" />
          }
        </div>
      }
      @if (!k()) {
        <pc-page-loader />
      } @else {
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Sales (GMV)</p><p class="font-display text-3xl font-bold">{{ rupees(k()!.gmv) }}</p><pc-delta [now]="k()!.gmv" [before]="k()!.gmv_prev" /></div>
          <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Orders</p><p class="font-display text-3xl font-bold">{{ k()!.orders.toLocaleString("en-IN") }}</p><pc-delta [now]="k()!.orders" [before]="k()!.orders_prev" /></div>
          <pc-stat label="Commission earned" [value]="rupees(k()!.commission)" [hint]="'Coupons cost ' + rupees(k()!.discounts)" />
          <pc-stat label="Average order value" [value]="rupees(k()!.aov)" [hint]="k()!.units.toLocaleString('en-IN') + ' units sold'" />
          <pc-stat label="Views that became orders" [value]="k()!.conversion_rate + '%'" [hint]="k()!.views.toLocaleString('en-IN') + ' product views, ' + k()!.cart_rate + '% added to cart'" />
          <pc-stat label="Cancelled packages" [value]="k()!.cancellation_rate + '%'" />
          <pc-stat label="Returned after delivery" [value]="k()!.return_rate + '%'" [hint]="rupees(k()!.returned_value) + ' refunded'" />
          <pc-stat label="Average time to ship" [value]="hoursLabel(k()!.avg_hours_to_ship)" />
          @if (k()!.new_customers !== undefined) {<pc-stat label="New customers" [value]="k()!.new_customers!" [hint]="k()!.repeat_buyer_rate !== undefined ? k()!.repeat_buyer_rate + '% of ' + k()!.buyers + ' buyers ordered more than once' : undefined" />}
          @if (k()!.payment_mix) {<pc-stat label="Paid online" [value]="paidOnline()" [hint]="(k()!.payment_mix!['cod'] ?? 0) + ' cash-on-delivery orders'" />}
          @if (d()) {<pc-stat label="Active sellers" [value]="d()!.active_sellers" [hint]="d()!.live_products + ' live listings'" />}
        </div>
        <section class="rounded-xl bg-white p-4">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h2 class="text-lg font-semibold">Daily {{ metric() === "gmv" ? "sales" : "orders" }}</h2>
            <div class="flex rounded-lg bg-mist p-1 text-sm">
              @for (m of metrics; track m) {
                <button (click)="metric.set(m)" [class]="metric() === m ? 'rounded-md bg-white px-3 py-1 font-semibold text-peacock shadow-sm' : 'px-3 py-1 text-ink-soft'">{{ m === "gmv" ? "Sales" : "Orders" }}</button>
              }
            </div>
          </div>
          <pc-daily-bars [series]="k()!.series" [valueKey]="metric()" [money]="metric() === 'gmv'" [height]="200" />
        </section>
        <div class="grid gap-4 lg:grid-cols-2">
          <section class="rounded-xl bg-white p-4">
            <h2 class="mb-3 text-lg font-semibold">Top products</h2>
            @if (k()!.top_products.length) {<ul pcHBar [items]="topProducts()"></ul>} @else {<p class="text-ink-faint">No sales in this period.</p>}
          </section>
          @if (k()!.top_sellers) {
            <section class="rounded-xl bg-white p-4">
              <h2 class="mb-3 text-lg font-semibold">Top sellers</h2>
              @if (k()!.top_sellers!.length) {<ul pcHBar [items]="topSellers()"></ul>} @else {<p class="text-ink-faint">No sales in this period.</p>}
            </section>
          }
          @if (k()!.top_categories) {
            <section class="rounded-xl bg-white p-4">
              <h2 class="mb-3 text-lg font-semibold">Sales by category</h2>
              @if (k()!.top_categories!.length) {<ul pcHBar [items]="topCategories()"></ul>} @else {<p class="text-ink-faint">No sales in this period.</p>}
            </section>
          }
        </div>
      }
    </div>
  `,
})
export class AdminHomePage {
  protected readonly rupees = rupees;
  protected readonly hoursLabel = hoursLabel;
  protected readonly periods: [number, string][] = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 12 months"]];
  protected readonly metrics = ["gmv", "orders"] as const;
  protected readonly d = signal<D | null>(null);
  // analytics for the chosen period; while another period loads, the loader shows instead of old numbers
  private readonly kv = signal<{ days: number; data: K } | null>(null);
  protected readonly days = signal(30);
  protected readonly metric = signal<"gmv" | "orders">("gmv");
  protected readonly k = computed(() => {
    const kv = this.kv();
    return kv && kv.days === this.days() ? kv.data : null;
  });
  // TS optional chaining (undefined while the period loads, like the reference): a template ?. would give null here
  protected readonly tickets = computed(() => this.k()?.tickets_ack_overdue);
  protected readonly paidOnline = computed(() => {
    const m = this.k()?.payment_mix ?? {};
    return `${Math.round(((m["online"] ?? 0) * 100) / Math.max(1, (m["online"] ?? 0) + (m["cod"] ?? 0)))}%`;
  });
  protected readonly topProducts = computed(() => (this.k()?.top_products ?? []).map((p) => ({ label: p.title, value: p.revenue, display: `${rupees(p.revenue)} · ${p.units} sold` })));
  protected readonly topSellers = computed(() => (this.k()?.top_sellers ?? []).map((s) => ({ label: s.name, value: s.gmv, display: `${rupees(s.gmv)} · ${s.packages} packages` })));
  protected readonly topCategories = computed(() => (this.k()?.top_categories ?? []).map((c) => ({ label: c.name, value: c.gmv, display: rupees(c.gmv) })));

  constructor() {
    api<D>("/api/admin/dashboard").then((x) => this.d.set(x)).catch(() => {});
    effect(() => {
      const days = this.days();
      api<K>("/api/admin/analytics", { query: { days } }).then((data) => this.kv.set({ days, data })).catch(quietly);
    });
  }
}
