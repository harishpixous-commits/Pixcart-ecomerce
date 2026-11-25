/*
 * Admin → Orders: every order with status tabs, search and filters kept in the address bar (so links like
 * /admin/orders?q=PC… or ?seller_id=… open filtered), CSV/Excel export and paging. Port of frontend/src/app/admin/orders/page.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { X } from "lucide-angular";
import { api, quietly } from "../../core/api";
import { dateTime, PAYMENT_STATUS_LABEL, rupees } from "../../core/format";
import { RouteState } from "../../core/route-state";
import type { Paged } from "../../core/types";
import { ExportButton } from "../../shared/portal/export-button";
import { PageHeader, Table, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { EmptyState, Input, Pagination, Select, StatusPill } from "../../shared/ui/ui";

type Row = { id: string; number: string; customer: string; phone: string; status: string; payment_method: string; payment_status: string; grand_total: number; created_at: string; package_statuses: string[] };
type Filters = { status: string; q: string; payment_method: string; payment_status: string; package_status: string; date_from: string; date_to: string; seller_id: string; customer_id: string };
const KEYS: (keyof Filters)[] = ["status", "q", "payment_method", "payment_status", "package_status", "date_from", "date_to", "seller_id", "customer_id"];
const PACKAGE_STATUSES = ["placed", "confirmed", "packed", "shipped", "delivered", "cancelled"];

@Component({
  selector: "pc-admin-orders-page",
  imports: [ExportButton, PageHeader, Table, Tabs, Icon, PcLink, PageLoader, EmptyState, Input, Pagination, Select, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Orders" [withActions]="true">
      <pc-export-button actions scope="admin" name="orders" [status]="f().status === 'cancelled' ? 'cancelled' : undefined" />
    </pc-page-header>
    <pc-tabs [value]="f().status" (valueChange)="set({ status: $event, page: 1 })" [items]="tabs" />
    <div class="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <input pcInput placeholder="Order or package no., AWB, name, mobile or email" [value]="q()" (input)="q.set($any($event.target).value)" class="sm:col-span-2" aria-label="Search orders" />
      <select pcSelect (change)="set({ package_status: $any($event.target).value, page: 1 })" aria-label="Package status">
        <option value="" [selected]="f().package_status === ''">Any package status</option>
        @for (s of packageStatuses; track s) {<option [value]="s" [selected]="f().package_status === s">{{ s[0].toUpperCase() + s.slice(1) }}</option>}
      </select>
      <select pcSelect (change)="set({ payment_method: $any($event.target).value, page: 1 })" aria-label="Payment method">
        <option value="" [selected]="f().payment_method === ''">COD and online</option><option value="cod" [selected]="f().payment_method === 'cod'">Cash on delivery</option><option value="online" [selected]="f().payment_method === 'online'">Paid online</option>
      </select>
      <select pcSelect (change)="set({ payment_status: $any($event.target).value, page: 1 })" aria-label="Payment status">
        <option value="" [selected]="f().payment_status === ''">Any payment status</option>
        @for (p of paymentStatuses; track p[0]) {<option [value]="p[0]" [selected]="f().payment_status === p[0]">{{ p[1] }}</option>}
      </select>
      <label class="flex items-center gap-2 text-sm text-ink-soft">From <input pcInput type="date" [value]="f().date_from" (change)="set({ date_from: $any($event.target).value, page: 1 })" aria-label="From date" /></label>
      <label class="flex items-center gap-2 text-sm text-ink-soft">To <input pcInput type="date" [value]="f().date_to" (change)="set({ date_to: $any($event.target).value, page: 1 })" aria-label="To date" /></label>
      @if (anyFilter()) {
        <button type="button" (click)="clear()" class="inline-flex h-10 items-center gap-1 justify-self-start px-2 text-sm font-semibold text-peacock">
          <svg [pcIcon]="X" class="h-4 w-4" />Clear filters
        </button>
      }
    </div>
    @if (scoped()) {<p class="mb-2 text-sm text-ink-soft">Showing orders {{ f().seller_id ? "of one seller" : "of one customer" }} only.</p>}
    @if (!d()) {
      <pc-page-loader />
    } @else if (d()!.items.length === 0) {
      <pc-empty-state title="No orders match" [hasAction]="false" />
    } @else {
      <pc-table [head]="['Order', 'Customer', 'Placed', 'Payment', 'Total', 'Packages', 'Order status']">
        @for (o of d()!.items; track o.id) {
          <tr class="hover:bg-mist/60">
            <td class="px-4 py-3"><a [pcLink]="'/admin/orders/' + o.id" class="font-semibold text-peacock hover:underline">{{ o.number }}</a></td>
            <td class="px-4 py-3">{{ o.customer }}<p class="text-sm text-ink-faint">{{ o.phone }}</p></td>
            <td class="px-4 py-3 text-sm">{{ dateTime(o.created_at) }}</td>
            <td class="px-4 py-3 text-sm">{{ o.payment_method === "cod" ? "COD" : "Online" }}, {{ payLabel[o.payment_status] }}</td>
            <td class="px-4 py-3 font-semibold">{{ rupees(o.grand_total) }}</td>
            <td class="px-4 py-3"><span class="flex flex-wrap gap-1">@for (s of o.package_statuses; track $index) {<pc-status-pill [status]="s" />}</span></td>
            <td class="px-4 py-3"><pc-status-pill [status]="o.status" /></td>
          </tr>
        }
      </pc-table>
      <pc-pagination [page]="d()!.page" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="set({ page: $event })" />
    }
  `,
})
export class AdminOrdersPage {
  private readonly route = inject(RouteState);
  private readonly router = inject(Router);
  protected readonly X = X;
  protected readonly dateTime = dateTime;
  protected readonly rupees = rupees;
  protected readonly payLabel = PAYMENT_STATUS_LABEL;
  protected readonly packageStatuses = PACKAGE_STATUSES;
  protected readonly paymentStatuses = Object.entries(PAYMENT_STATUS_LABEL);
  protected readonly tabs = [{ value: "", label: "All" }, { value: "placed", label: "Placed" }, { value: "pending_payment", label: "Awaiting payment" }, { value: "cancelled", label: "Cancelled" }];
  // filters live in the address bar
  protected readonly f = computed(() => {
    const sp = this.route.params();
    return Object.fromEntries(KEYS.map((k) => [k, sp.get(k) ?? ""])) as Filters;
  });
  private readonly page = computed(() => Number(this.route.params().get("page") ?? "1") || 1);
  protected readonly q = signal(untracked(this.f).q);
  protected readonly d = signal<Paged<Row> | null>(null);
  protected readonly scoped = computed(() => this.f().seller_id || this.f().customer_id);
  protected readonly anyFilter = computed(() => KEYS.some((k) => k !== "status" && this.f()[k]));
  private readonly key = computed(() => {
    const f = this.f();
    const query = KEYS.reduce((acc, k) => (f[k] ? { ...acc, [k]: f[k] } : acc), {} as Record<string, string>);
    return JSON.stringify({ query, page: this.page() });
  });

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const q = this.q();
      clearTimeout(t);
      t = setTimeout(() => {
        if (q !== untracked(this.f).q) this.set({ q });
      }, 300);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
    effect(() => {
      const k = JSON.parse(this.key()) as { query: Record<string, string>; page: number };
      api<Paged<Row>>("/api/admin/orders", { query: { ...k.query, page: k.page } }).then((x) => this.d.set(x)).catch(quietly);
    });
  }

  protected set(patch: Partial<Filters> & { page?: number }): void {
    const f = this.f();
    const next = new URLSearchParams();
    for (const k of KEYS) {
      const v = (k in patch ? patch[k] : f[k]) ?? "";
      if (v) next.set(k, String(v));
    }
    if (patch.page && patch.page > 1) next.set("page", String(patch.page));
    void this.router.navigateByUrl(`/admin/orders${next.toString() ? `?${next}` : ""}`, { replaceUrl: true });
  }

  protected clear(): void {
    this.q.set("");
    const status = this.f().status;
    void this.router.navigateByUrl(`/admin/orders${status ? `?status=${status}` : ""}`, { replaceUrl: true });
  }
}
