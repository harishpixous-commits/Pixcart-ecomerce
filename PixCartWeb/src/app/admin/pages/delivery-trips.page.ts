/* Admin → Delivery → Trips: every delivery request and trip, by status, searchable by order, partner name or mobile. Port of frontend/src/app/admin/delivery/trips/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { ChevronRight, MapPin, Search, Store, X } from "lucide-angular";
import { api, ApiError, latestOnly } from "../../core/api";
import type { TripView } from "../../core/delivery-types";
import { dateTime, rupees } from "../../core/format";
import { RouteState } from "../../core/route-state";
import { TripPill } from "../../delivery/components/trip";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { EmptyState, ErrorNote, Input, Pagination } from "../../shared/ui/ui";
import { debounced } from "../shared/admin-helpers";

type Data = { items: TripView[]; total: number; page: number; page_size: number };

const TABS: [string, string][] = [
  ["active", "In progress"],
  ["offered", "Requests"],
  ["delivered", "Delivered"],
  ["failed", "Not delivered"],
  ["cancelled", "Cancelled"],
  ["rejected", "Declined"],
  ["expired", "Missed"],
  ["", "All"],
];

@Component({
  selector: "pc-admin-delivery-trips-page",
  imports: [PageHeader, Tabs, Icon, PcLink, PageLoader, EmptyState, ErrorNote, Input, Pagination, TripPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Delivery trips" sub="Every delivery request and trip, with its partner, step and money." />
    <pc-tabs [value]="status()" (valueChange)="go({ status: $event })" [items]="tabs" />
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="relative min-w-[240px] flex-1">
        <svg [pcIcon]="I.Search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
        <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Order number, partner name or mobile" aria-label="Search trips" class="pl-9" />
      </div>
      @if (partnerId()) {
        <button type="button" (click)="go({ partner_id: '' })" class="inline-flex h-10 items-center gap-1.5 rounded-full bg-peacock-light px-3 text-sm font-semibold text-peacock">
          Partner: {{ partnerName() }} <svg [pcIcon]="I.X" class="h-4 w-4" aria-label="Show all partners" />
        </button>
      }
    </div>
    <pc-error-note [message]="error()" />
    @if (!d()) {
      @if (!error()) {<pc-page-loader />}
    } @else if (d()!.items.length === 0) {
      <pc-empty-state title="No trips here" [body]="status() === 'active' ? 'Trips show up here while a partner is carrying a package.' : undefined" [hasAction]="false" />
    } @else {
      <ul class="flex flex-col gap-2" data-testid="trip-list">
        @for (t of d()!.items; track t.id) {
          <li>
            <a [pcLink]="'/admin/delivery/trips/' + t.id" class="flex flex-col gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/30 sm:flex-row sm:items-center sm:gap-4 sm:p-4">
              <span class="flex min-w-0 flex-wrap items-center gap-2 sm:w-64">
                <span class="font-semibold">{{ t.order_number }}</span>
                <pc-trip-pill [trip]="t" />
                @if (t.kind !== "delivery") {<span class="text-xs font-semibold text-marigold-dark">{{ t.kind === "pickup" ? "Return pickup" : "Return" }}</span>}
                <span class="w-full text-xs text-ink-faint">{{ dateTime(t.assigned_at) }} · {{ t.mode === "auto" ? "auto-assign" : "by staff" }}</span>
              </span>
              <span class="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink-soft">
                <svg [pcIcon]="I.Store" class="h-4 w-4 shrink-0 text-marigold-dark" aria-hidden="true" /><span class="truncate">{{ t.pickup.name }}</span>
                <svg [pcIcon]="I.ChevronRight" class="h-4 w-4 shrink-0 text-ink-faint" aria-hidden="true" />
                <svg [pcIcon]="I.MapPin" class="h-4 w-4 shrink-0 text-vermilion" aria-hidden="true" /><span class="truncate">{{ t.drop.name ? t.drop.name + ", " : "" }}{{ dropLine(t) }}</span>
              </span>
              <span class="flex flex-wrap items-center gap-3 text-sm sm:w-72 sm:justify-end">
                <span class="font-medium">{{ t.partner.name }}</span>
                @if (t.cod_amount > 0) {<span class="rounded-full bg-marigold-light px-2 py-0.5 text-xs font-semibold text-[#8A5A00]">COD {{ rupees(t.cod_amount) }}</span>}
                @if (t.status === "delivered") {<span class="text-xs text-ink-soft">Fee {{ rupees(t.fee + t.tip) }}</span>}
                <svg [pcIcon]="I.ChevronRight" class="hidden h-5 w-5 text-ink-faint sm:block" aria-hidden="true" />
              </span>
            </a>
          </li>
        }
      </ul>
    }
    @if (d()) {<pc-pagination [page]="page()" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />}
  `,
})
export class AdminDeliveryTripsPage {
  private readonly route = inject(RouteState);
  private readonly router = inject(Router);
  protected readonly I = { Search, X, Store, ChevronRight, MapPin };
  protected readonly dateTime = dateTime;
  protected readonly rupees = rupees;
  protected readonly tabs = TABS.map(([value, label]) => ({ value, label }));
  protected readonly status = computed(() => this.route.params().get("status") ?? "active");
  protected readonly partnerId = computed(() => this.route.params().get("partner_id") ?? "");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  private readonly query = debounced(this.q, 300, () => this.page.set(1));
  protected readonly d = signal<Data | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly track = latestOnly();
  protected readonly partnerName = computed(() => {
    const id = this.partnerId();
    const first = this.d()?.items[0];
    return id && first?.partner.id === id ? first.partner.name : id ? "this partner" : "";
  });

  constructor() {
    effect(() => {
      const status = this.status(), query = this.query(), partnerId = this.partnerId(), page = this.page();
      this.track(api<Data>("/api/admin/delivery/trips", { query: { status: status === "" ? undefined : status, q: query || undefined, partner_id: partnerId || undefined, page } }),
        (x) => { this.d.set(x); this.error.set(null); })
        .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load trips"));
    });
  }

  protected dropLine(t: TripView): string {
    return [t.drop.city, t.drop.pincode].filter(Boolean).join(" ");
  }

  protected go(next: { status?: string; partner_id?: string }): void {
    const params = new URLSearchParams();
    const s = next.status ?? this.status();
    const p = next.partner_id ?? this.partnerId();
    params.set("status", s);
    if (p) params.set("partner_id", p);
    this.page.set(1);
    void this.router.navigateByUrl(`/admin/delivery/trips?${params.toString()}`, { replaceUrl: true });
  }
}
