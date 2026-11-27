/* Seller orders: one tab per step (confirm, pack, ship ...), search and the export. Port of frontend/src/app/seller/orders/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { api, latestOnly } from "../../core/api";
import { dateTime, rupees } from "../../core/format";
import { RouteState } from "../../core/route-state";
import type { Paged, SellerOrder } from "../../core/types";
import { PageHeader, Table, Tabs } from "../../shared/portal-shell";
import { ExportButton } from "../../shared/portal/export-button";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { EmptyState, Input, Pagination, Pill, StatusPill } from "../../shared/ui/ui";

const TABS = [
  ["placed", "To confirm"],
  ["confirmed", "To pack"],
  ["packed", "To ship"],
  ["shipped", "In transit"],
  ["delivered", "Delivered"],
  ["cancelled", "Cancelled"],
  ["", "All"],
] as const;

@Component({
  selector: "pc-seller-orders-page",
  imports: [PageHeader, Table, Tabs, ExportButton, PcLink, PageLoader, EmptyState, Input, Pagination, Pill, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Orders" sub="Confirm, pack and ship each order. Customers can cancel until you ship." [withActions]="true">
        <pc-export-button actions scope="seller" name="orders" [status]="status() || undefined" />
      </pc-page-header>
      @if (data()?.late_count; as n) {
        <p class="mb-3 rounded-lg bg-marigold-light px-3 py-2 text-sm text-ink" role="status">
          {{ n }} open order{{ n === 1 ? " is" : "s are" }} more than {{ data()?.late_after_days }} day{{ data()?.late_after_days === 1 ? "" : "s" }} old. Ship {{ n === 1 ? "it" : "them" }} first.
        </p>
      }
      <pc-tabs [value]="status()" (valueChange)="tab($event)" [items]="tabs()" />
      <input pcInput placeholder="Search by order number" [value]="q()" (input)="search($any($event.target).value)" class="mb-3 max-w-sm" aria-label="Search orders" />
      @if (!data()) {
        <pc-page-loader />
      } @else if (data()!.items.length === 0) {
        <pc-empty-state title="No orders here" [body]="status() === 'placed' ? 'New orders appear here as soon as they are paid or placed with cash on delivery.' : undefined" [hasAction]="false" />
      } @else {
        <pc-table [head]="head">
          @for (o of data()!.items; track o.id) {
            <tr class="hover:bg-mist/60">
              <td class="px-4 py-3">
                <a [pcLink]="'/seller/orders/' + o.id" class="font-semibold text-peacock hover:underline">{{ o.number }}</a>
                <p class="text-sm text-ink-faint">{{ dateTime(o.created_at) }}</p>
              </td>
              <td class="px-4 py-3">
                <p class="line-clamp-1">{{ o.items[0]?.title }}</p>
                <p class="text-sm text-ink-faint">{{ skus(o) }}</p>
              </td>
              <td class="px-4 py-3 text-sm">{{ o.ship_to_city }} {{ o.ship_to_pincode }}</td>
              <td class="px-4 py-3">@if (o.payment_method === "cod") {<pc-pill tone="amber">COD</pc-pill>} @else {<pc-pill tone="green">Prepaid</pc-pill>}</td>
              <td class="px-4 py-3 font-semibold">{{ rupees(o.total) }}</td>
              <td class="px-4 py-3"><pc-status-pill [status]="o.status" /></td>
            </tr>
          }
        </pc-table>
        <pc-pagination [page]="data()!.page" [pageSize]="data()!.page_size" [total]="data()!.total" (pageChange)="page.set($event)" />
      }
    </div>
  `,
})
export class SellerOrdersPage {
  private readonly router = inject(Router);
  private readonly route = inject(RouteState);
  protected readonly head = ["Order", "Items", "Ship to", "Payment", "Amount", "Status"];
  protected readonly dateTime = dateTime;
  protected readonly rupees = rupees;
  protected readonly status = computed(() => this.route.params().get("status") ?? "placed");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly data = signal<Paged<SellerOrder> | null>(null);
  protected readonly tabs = computed(() => {
    const counts = this.data()?.status_counts ?? {};
    return TABS.map(([v, l]) => ({ value: v as string, label: l as string, count: v ? counts[v] ?? 0 : undefined }));
  });
  private readonly track = latestOnly();

  constructor() {
    effect((onCleanup) => {
      const status = this.status();
      const q = this.q();
      const page = this.page();
      const t = setTimeout(() => this.track(api<Paged<SellerOrder>>("/api/seller/orders", { query: { status: status || undefined, q, page } }), (d) => this.data.set(d)), q ? 250 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected tab(v: string): void {
    this.page.set(1);
    void this.router.navigateByUrl(`/seller/orders?status=${v}`);
  }

  protected search(v: string): void {
    this.q.set(v);
    this.page.set(1);
  }

  protected skus(o: SellerOrder): string {
    return o.items.map((i) => `${i.sku} × ${i.qty}`).join(", ");
  }
}
