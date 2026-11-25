/* Seller analytics: sales, orders, conversion and product performance for a period. Port of frontend/src/app/seller/analytics/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, signal } from "@angular/core";
import { api, quietly } from "../../core/api";
import { hoursLabel, rupees } from "../../core/format";
import { PageHeader, Stat, Table } from "../../shared/portal-shell";
import { DailyBars, Delta } from "../../shared/portal/charts";
import { PageLoader } from "../../shared/ui/page-loader";
import { Select } from "../../shared/ui/ui";

type K = {
  gmv: number; gmv_prev: number; orders: number; orders_prev: number; aov: number; units: number; cancellation_rate: number; return_rate: number;
  avg_hours_to_ship: number | null; views: number; add_to_cart: number; conversion_rate: number; cart_rate: number;
  series: { date: string; orders: number; gmv: number }[];
  products: { id: string; title: string; slug: string; views: number; add_to_cart: number; orders: number; units: number; revenue: number; conversion: number; in_stock: boolean }[];
};

const PERIODS = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 12 months"]] as const;

@Component({
  selector: "pc-seller-analytics-page",
  imports: [PageHeader, Stat, Table, DailyBars, Delta, PageLoader, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div class="flex flex-col gap-4">
      <pc-page-header title="Analytics" [withActions]="true">
        <select actions pcSelect class="w-auto" aria-label="Period" (change)="days.set(+$any($event.target).value)">
          @for (p of periods; track p[0]) {<option [value]="p[0]" [selected]="p[0] === days()">{{ p[1] }}</option>}
        </select>
      </pc-page-header>
      @if (k(); as k) {
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Sales</p><p class="font-display text-3xl font-bold">{{ rupees(k.gmv) }}</p><pc-delta [now]="k.gmv" [before]="k.gmv_prev" /></div>
          <div class="rounded-xl bg-white p-4"><p class="text-sm text-ink-soft">Orders</p><p class="font-display text-3xl font-bold">{{ k.orders }}</p><pc-delta [now]="k.orders" [before]="k.orders_prev" /></div>
          <pc-stat label="Average order value" [value]="rupees(k.aov)" />
          <pc-stat label="Units sold" [value]="k.units" />
          <pc-stat label="Product page views" [value]="k.views.toLocaleString('en-IN')" />
          <pc-stat label="Views that became orders" [value]="k.conversion_rate + '%'" [hint]="k.cart_rate + '% added to cart'" />
          <pc-stat label="Cancelled packages" [value]="k.cancellation_rate + '%'" />
          <pc-stat label="Average time to ship" [value]="hoursLabel(k.avg_hours_to_ship)" [hint]="'Return rate ' + k.return_rate + '%'" />
        </div>
        <section class="rounded-xl bg-white p-4"><h2 class="mb-2 text-lg font-semibold">Daily sales</h2><pc-daily-bars [series]="k.series" valueKey="gmv" [money]="true" /></section>
        <section>
          <h2 class="mb-2 px-1 text-lg font-semibold">Product performance</h2>
          <pc-table [head]="head">
            @for (p of k.products; track p.id) {
              <tr>
                <td class="px-4 py-2"><a [href]="'/p/' + p.slug" target="_blank" rel="noreferrer" class="line-clamp-1 font-medium hover:text-peacock">{{ p.title }}</a>@if (!p.in_stock) {<span class="text-xs text-vermilion"> Out of stock</span>}</td>
                <td class="px-4 py-2">{{ p.views }}</td><td class="px-4 py-2">{{ p.add_to_cart }}</td><td class="px-4 py-2">{{ p.orders }}</td><td class="px-4 py-2">{{ p.units }}</td>
                <td class="px-4 py-2 font-semibold">{{ rupees(p.revenue) }}</td><td class="px-4 py-2">{{ p.conversion }}%</td>
              </tr>
            }
          </pc-table>
        </section>
      } @else {
        <pc-page-loader />
      }
    </div>
  `,
})
export class SellerAnalyticsPage {
  protected readonly periods = PERIODS;
  protected readonly head = ["Product", "Views", "Added to cart", "Orders", "Units", "Sales", "Conversion"];
  protected readonly rupees = rupees;
  protected readonly hoursLabel = hoursLabel;
  protected readonly days = signal(30);
  // the figures remember their period, so a new period shows the loader until its own figures arrive
  private readonly res = signal<{ days: number; k: K } | null>(null);
  protected readonly k = computed(() => {
    const r = this.res();
    return r && r.days === this.days() ? r.k : null;
  });

  constructor() {
    effect((onCleanup) => {
      const days = this.days();
      let live = true;
      api<K>("/api/seller/analytics", { query: { days } }).then((k) => { if (live) this.res.set({ days, k }); }).catch(quietly);
      onCleanup(() => { live = false; });
    });
  }
}
