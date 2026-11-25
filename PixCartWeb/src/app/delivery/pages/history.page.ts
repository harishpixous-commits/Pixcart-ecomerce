/*
 * Partner trip history: every finished request and trip (delivered, not delivered, declined, missed, cancelled),
 * filtered by date range and outcome, with what was earned, the cash collected and the customer's rating.
 * Port of frontend/src/app/delivery/history/page.tsx.
 */

import { ChangeDetectionStrategy, Component, effect, signal, untracked } from "@angular/core";
import { Banknote, ChevronRight, MapPin, Star } from "lucide-angular";
import { ApiError, api, latestOnly } from "../../core/api";
import type { HistoryItem } from "../../core/delivery-types";
import { dateTime, rupees } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { ErrorNote, Pagination } from "../../shared/ui/ui";
import { TripPill } from "../components/trip";
import { FullLoader } from "../shell/delivery-app";

type Data = { items: HistoryItem[]; total: number; page: number; page_size: number };

const FILTERS: [string, string][] = [
  ["", "All"],
  ["delivered", "Delivered"],
  ["failed", "Not delivered"],
  ["rejected", "Declined"],
  ["expired", "Missed"],
  ["cancelled", "Cancelled"],
];

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const RANGES: [string, string, number | null][] = [["7", "Last 7 days", 7], ["30", "Last 30 days", 30], ["90", "Last 90 days", 90], ["all", "All time", null]];
const TABS: [string, string][] = [...RANGES.map((r) => [r[0], r[1]] as [string, string]), ["custom", "Pick dates"]];

@Component({
  selector: "pc-delivery-history-page",
  imports: [Icon, PcLink, ErrorNote, Pagination, TripPill, FullLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3", "data-testid": "partner-history" },
  template: `
    <h1 class="px-1 font-display text-2xl font-bold">Trip history</h1>
    <div class="flex flex-col gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5">
      <div class="scroll-x -mx-1 flex gap-1.5 overflow-x-auto px-1" role="tablist" aria-label="Period">
        @for (r of tabs; track r[0]) {
          <button type="button" role="tab" [attr.aria-selected]="range() === r[0]" (click)="range.set(r[0]); page.set(1)"
            [class]="range() === r[0] ? 'shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold bg-peacock text-white' : 'shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold bg-mist text-ink-soft'">
            {{ r[1] }}
          </button>
        }
      </div>
      @if (range() === "custom") {
        <div class="grid grid-cols-2 gap-2">
          <label class="text-xs font-semibold text-ink-soft">From
            <input type="date" [value]="from()" [attr.max]="to() || null" (input)="from.set($any($event.target).value); page.set(1)" class="mt-1 h-10 w-full rounded-lg border border-line px-2 text-sm text-ink" />
          </label>
          <label class="text-xs font-semibold text-ink-soft">To
            <input type="date" [value]="to()" [attr.min]="from() || null" (input)="to.set($any($event.target).value); page.set(1)" class="mt-1 h-10 w-full rounded-lg border border-line px-2 text-sm text-ink" />
          </label>
        </div>
      }
      <div class="scroll-x -mx-1 flex gap-1.5 overflow-x-auto px-1" role="tablist" aria-label="Outcome">
        @for (f of filters; track f[0]) {
          <button type="button" role="tab" [attr.aria-selected]="status() === f[0]" (click)="status.set(f[0]); page.set(1)"
            [class]="status() === f[0] ? 'shrink-0 rounded-full px-3 py-1 text-xs font-semibold ring-1 bg-peacock-light text-peacock ring-peacock/40' : 'shrink-0 rounded-full px-3 py-1 text-xs font-semibold ring-1 text-ink-soft ring-line'">
            {{ f[1] }}
          </button>
        }
      </div>
    </div>
    <pc-error-note [message]="error()" />
    @if (d(); as d) {
      @if (d.items.length === 0) {
        <p class="rounded-2xl bg-white p-8 text-center text-ink-soft shadow-sm ring-1 ring-black/5">No trips in this period.</p>
      } @else {
        <p class="px-1 text-sm text-ink-soft">{{ d.total }} trip{{ d.total === 1 ? "" : "s" }}</p>
        <ul class="flex flex-col gap-2">
          @for (t of d.items; track t.id) {
            <li>
              <a [pcLink]="'/delivery/trips/' + t.id" class="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/30" data-testid="history-item">
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold">{{ t.order_number }}</span>
                    <pc-trip-pill [trip]="t" />
                    @if (t.kind !== "delivery") {<span class="text-xs font-semibold text-marigold-dark">{{ t.kind === "pickup" ? "Return pickup" : "Return" }}</span>}
                  </span>
                  <span class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-ink-soft">
                    <span>{{ dateTime(t.delivered_at ?? t.assigned_at) }}</span>
                    @if (t.drop_area) {<span class="inline-flex items-center gap-1"><svg [pcIcon]="MapPin" class="h-3.5 w-3.5" />{{ t.drop_area }}</span>}
                    @if (t.cod_collected > 0) {<span class="inline-flex items-center gap-1"><svg [pcIcon]="Banknote" class="h-3.5 w-3.5" />{{ rupees(t.cod_collected) }} {{ t.cod_method === "upi" ? "UPI" : "cash" }}</span>}
                    @if (t.rating) {<span class="inline-flex items-center gap-0.5"><svg [pcIcon]="Star" class="h-3.5 w-3.5 fill-marigold text-marigold" />{{ t.rating }}</span>}
                  </span>
                  @if (t.fail_reason || (t.status !== "delivered" && t.reject_reason)) {
                    <span class="mt-0.5 block truncate text-xs text-ink-faint">{{ t.fail_reason || t.reject_reason }}</span>
                  }
                </span>
                @if (t.status === "delivered") {<span class="font-display text-lg font-bold text-leaf">{{ rupees(t.fee + t.tip) }}</span>}
                <svg [pcIcon]="ChevronRight" class="h-5 w-5 shrink-0 text-ink-faint" />
              </a>
            </li>
          }
        </ul>
        <pc-pagination [page]="page()" [pageSize]="d.page_size" [total]="d.total" (pageChange)="page.set($event)" />
      }
    } @else if (!error()) {
      <pc-full-loader label="Loading trips" />
    }
  `,
})
export class DeliveryHistoryPage {
  protected readonly status = signal("");
  protected readonly range = signal("30");
  protected readonly from = signal("");
  protected readonly to = signal("");
  protected readonly page = signal(1);
  protected readonly d = signal<Data | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly track = latestOnly();
  protected readonly tabs = TABS;
  protected readonly filters = FILTERS;
  protected readonly dateTime = dateTime;
  protected readonly rupees = rupees;
  protected readonly MapPin = MapPin;
  protected readonly Banknote = Banknote;
  protected readonly Star = Star;
  protected readonly ChevronRight = ChevronRight;

  constructor() {
    effect(() => {
      const status = this.status();
      const range = this.range();
      const page = this.page();
      let start = this.from();
      let end = this.to();
      if (range !== "custom") {
        const days = RANGES.find((r) => r[0] === range)?.[2] ?? null;
        start = days ? isoDay(new Date(Date.now() - (days - 1) * 86_400_000)) : "";
        end = "";
      }
      untracked(() => {
        this.track(api<Data>("/api/delivery/history", { query: { status, from: start || undefined, to: end || undefined, page } }), (x) => { this.d.set(x); this.error.set(null); })
          .catch((x) => this.error.set(x instanceof ApiError ? x.message : "Could not load your history"));
      });
    });
  }
}
