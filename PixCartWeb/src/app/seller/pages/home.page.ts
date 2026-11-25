/*
 * Seller dashboard: orders waiting at each step, sales of the last 30 days, payouts and catalogue counts.
 * Port of frontend/src/app/seller/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { api } from "../../core/api";
import { date, rupees } from "../../core/format";
import { PageHeader, Stat } from "../../shared/portal-shell";
import { PushPrompt } from "../../shared/portal/push-prompt";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { ButtonLink } from "../../shared/ui/ui";

type Dash = {
  orders: { to_confirm: number; to_pack: number; to_ship: number; in_transit: number; delivered: number; cancelled: number };
  sales_30d: { amount: number; orders: number };
  daily_sales: { date: string; amount: number; orders: number }[];
  earnings: { in_return_window: number; ready_for_payout: number };
  products: Record<string, number | undefined>;
  low_stock_variants: number;
  low_stock_threshold?: number;
};

@Component({
  selector: "pc-seller-sales-bars",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!days().length) {
      <p class="py-8 text-center text-ink-faint">Sales from the last 30 days will show here.</p>
    } @else {
      <div class="flex h-40 items-end gap-1" role="img" aria-label="Daily sales for the last 30 days">
        @for (d of days(); track d.date) {
          <div class="group relative flex-1">
            <div class="rounded-t bg-peacock/80 group-hover:bg-peacock" [style.height.px]="barHeight(d.amount)"></div>
            <span class="pointer-events-none absolute bottom-full left-1/2 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-2 py-1 text-xs text-white group-hover:block">{{ date(d.date) }}: {{ rupees(d.amount) }}, {{ d.orders }} orders</span>
          </div>
        }
      </div>
    }
  `,
})
export class SellerSalesBars {
  readonly days = input.required<Dash["daily_sales"]>();
  protected readonly date = date;
  protected readonly rupees = rupees;
  private readonly max = computed(() => Math.max(...this.days().map((d) => d.amount), 1));
  protected barHeight(amount: number): number {
    return Math.max(4, (amount / this.max()) * 150);
  }
}

@Component({
  selector: "pc-seller-home-page",
  imports: [PageHeader, Stat, PushPrompt, PcLink, PageLoader, ButtonLink, SellerSalesBars],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (d(); as d) {
      <div class="flex flex-col gap-4">
        <pc-page-header title="Dashboard" [withActions]="true"><a actions pcButtonLink href="/seller/products/new">Add a product</a></pc-page-header>
        <pc-push-prompt app="seller" title="Get new orders as notifications" text="Hear about new orders, pickups and returns on this device, even when this page is closed." />
        @if (live() === 0) {
          <div class="rounded-xl bg-marigold-light p-4">
            <p class="font-semibold">You have no live products yet</p>
            <p class="text-ink-soft">Add your first product. Our team reviews each new listing before customers can see it.</p>
          </div>
        }
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <pc-stat label="New orders to confirm" [value]="d.orders.to_confirm" href="/seller/orders?status=placed" />
          <pc-stat label="To pack" [value]="d.orders.to_pack" href="/seller/orders?status=confirmed" />
          <pc-stat label="Ready to ship" [value]="d.orders.to_ship" href="/seller/orders?status=packed" />
          <pc-stat label="In transit" [value]="d.orders.in_transit" href="/seller/orders?status=shipped" />
        </div>
        <div class="grid gap-3 lg:grid-cols-[2fr_1fr]">
          <section class="rounded-xl bg-white p-4">
            <div class="mb-3 flex items-baseline justify-between">
              <h2 class="text-lg font-semibold">Sales, last 30 days</h2>
              <p class="font-display text-2xl font-bold">{{ rupees(d.sales_30d.amount) }} <span class="text-sm font-normal text-ink-faint">{{ d.sales_30d.orders }} orders</span></p>
            </div>
            <pc-seller-sales-bars [days]="d.daily_sales" />
          </section>
          <section class="flex flex-col gap-3">
            @if (d.earnings.ready_for_payout < 0) {
              <!-- refunds or ad charges are more than the released earnings: say what it means instead of showing a minus -->
              <pc-stat label="To be recovered" [value]="rupees(-d.earnings.ready_for_payout)" hint="Taken from your next earnings (refunds, ad charges)" href="/seller/payouts" />
            } @else {
              <pc-stat label="Payout ready" [value]="rupees(d.earnings.ready_for_payout)" hint="Return window has closed" href="/seller/payouts" />
            }
            <pc-stat label="In return window" [value]="rupees(d.earnings.in_return_window)" hint="Released when the return window closes" href="/seller/payouts" />
          </section>
        </div>
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <pc-stat label="Live products" [value]="live()" href="/seller/products?status=approved" />
          <pc-stat label="Waiting for review" [value]="d.products['pending'] ?? 0" href="/seller/products?status=pending" />
          <pc-stat label="Need changes" [value]="d.products['rejected'] ?? 0" href="/seller/products?status=rejected" />
          <pc-stat label="Low stock options" [value]="d.low_stock_variants" [hint]="(d.low_stock_threshold ?? 5) + ' or fewer left'" href="/seller/products?low_stock=1" />
        </div>
        <p class="text-sm text-ink-faint">
          Confirm new orders quickly: customers can cancel until you ship. <a pcLink="/seller/orders" class="font-semibold text-peacock">Open orders</a>
        </p>
      </div>
    } @else {
      <pc-page-loader />
    }
  `,
})
export class SellerHomePage {
  protected readonly d = signal<Dash | null>(null);
  protected readonly rupees = rupees;
  protected readonly live = computed(() => this.d()?.products["approved"] ?? 0);

  constructor() {
    api<Dash>("/api/seller/dashboard").then((d) => this.d.set(d)).catch(() => {});
  }
}
