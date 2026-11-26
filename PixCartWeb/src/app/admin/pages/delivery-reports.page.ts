/*
 * Admin → Delivery → Reports: deliveries per day (delivered and not delivered), success rate, cash collected, and how
 * each partner performs (deliveries, failures, declines, average time from accepting to delivering, earnings, rating).
 * Port of frontend/src/app/admin/delivery/reports/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, signal } from "@angular/core";
import { Banknote, CheckCircle2, Download, Percent, XCircle } from "lucide-angular";
import { api, ApiError, latestOnly } from "../../core/api";
import { rupees } from "../../core/format";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { ErrorNote } from "../../shared/ui/ui";
import { ColumnChart, type ColumnDatum } from "../shared/columns";
import { Kpi } from "../shared/delivery-admin";

type Report = {
  days: { date: string; delivered: number; failed: number; cod: number }[];
  delivered: number; failed: number; success_rate: number | null; cod_collected: number;
  partners: { id: string; name: string; rating_avg: number; rating_count: number; delivered: number; failed: number; declined: number; earned: number; cod: number;
    avg_minutes: number | null; success_rate: number | null }[];
};

const RANGES = [7, 30, 90, 180];

function short(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Component({
  selector: "pc-admin-delivery-reports-page",
  imports: [PageHeader, Icon, PageLoader, ErrorNote, ColumnChart, Kpi],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4" data-testid="delivery-reports">
      <pc-page-header title="Delivery reports" sub="How the delivery fleet performs: deliveries, failures, cash collected and each partner's numbers." />
      <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="Period">
        @for (n of ranges; track n) {
          <button type="button" role="tab" [attr.aria-selected]="days() === n" (click)="days.set(n)"
            [class]="days() === n ? 'rounded-full px-3.5 py-1.5 text-sm font-semibold bg-peacock text-white' : 'rounded-full px-3.5 py-1.5 text-sm font-semibold bg-white text-ink-soft ring-1 ring-line hover:text-ink'">
            Last {{ n }} days
          </button>
        }
      </div>
      <pc-error-note [message]="error()" />
      @if (!rep()) {
        @if (!error()) {<pc-page-loader />}
      } @else {
        <div [class]="stale() ? 'flex flex-col gap-4 transition-opacity opacity-60' : 'flex flex-col gap-4 transition-opacity'">
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <pc-kpi [icon]="I.CheckCircle2" label="Delivered" [value]="rep()!.delivered.toLocaleString('en-IN')" tone="green" />
            <pc-kpi [icon]="I.XCircle" label="Not delivered" [value]="rep()!.failed.toLocaleString('en-IN')" [tone]="rep()!.failed ? 'red' : 'gray'" hint="Failed attempts" />
            <pc-kpi [icon]="I.Percent" label="Success rate" [value]="rep()!.success_rate === null ? '–' : rep()!.success_rate + '%'" tone="blue" hint="Delivered of all attempts" />
            <pc-kpi [icon]="I.Banknote" label="Cash collected" [value]="rupees(rep()!.cod_collected)" tone="amber" hint="Cash on delivery" />
          </div>
          <div class="grid gap-4 xl:grid-cols-2">
            <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
              <h2 class="font-semibold">Deliveries per day</h2>
              <p class="mb-3 text-sm text-ink-soft">Delivered and not delivered attempts</p>
              <figure pcColumnChart [caption]="'Deliveries per day, last ' + days() + ' days'" [series]="countSeries" [data]="countData()" [format]="fmtCount" [labelEvery]="every()"></figure>
            </section>
            <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
              <h2 class="font-semibold">Cash collected per day</h2>
              <p class="mb-3 text-sm text-ink-soft">Cash on delivery handed over by customers</p>
              <figure pcColumnChart [caption]="'Cash collected per day, last ' + days() + ' days'" [series]="cashSeries" [data]="cashData()" [format]="fmtCash" [labelEvery]="every()"></figure>
            </section>
          </div>
          <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 class="font-semibold">Partners</h2>
              @if (rep()!.partners.length > 0) {
                <button type="button" (click)="download(rep()!)" class="inline-flex items-center gap-1.5 text-sm font-semibold text-peacock"><svg [pcIcon]="I.Download" class="h-4 w-4" aria-hidden="true" />Download CSV</button>
              }
            </div>
            @if (rep()!.partners.length === 0) {
              <p class="text-ink-soft">No deliveries in this period.</p>
            } @else {
              <div class="overflow-x-auto">
                <table class="w-full min-w-[760px] text-left text-sm" data-testid="partner-report">
                  <thead class="border-b border-line text-xs uppercase tracking-wide text-ink-faint">
                    <tr>
                      <th class="py-2 pr-3 font-semibold">Partner</th>
                      <th class="px-3 py-2 text-right font-semibold">Delivered</th>
                      <th class="px-3 py-2 text-right font-semibold">Not delivered</th>
                      <th class="px-3 py-2 text-right font-semibold">Declined or missed</th>
                      <th class="px-3 py-2 text-right font-semibold">Success</th>
                      <th class="px-3 py-2 text-right font-semibold">Avg time</th>
                      <th class="px-3 py-2 text-right font-semibold">Earned</th>
                      <th class="px-3 py-2 text-right font-semibold">Cash</th>
                      <th class="py-2 pl-3 text-right font-semibold">Rating</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-line tabular-nums">
                    @for (p of rep()!.partners; track p.id) {
                      <tr>
                        <td class="py-2 pr-3 font-semibold">{{ p.name }}</td>
                        <td class="px-3 py-2 text-right">{{ p.delivered }}</td>
                        <td [class]="p.failed > 0 ? 'px-3 py-2 text-right text-vermilion' : 'px-3 py-2 text-right'">{{ p.failed }}</td>
                        <td class="px-3 py-2 text-right">{{ p.declined }}</td>
                        <td class="px-3 py-2 text-right">{{ p.success_rate === null ? "–" : p.success_rate + "%" }}</td>
                        <td class="px-3 py-2 text-right">{{ p.avg_minutes === null ? "–" : round(p.avg_minutes) + " min" }}</td>
                        <td class="px-3 py-2 text-right">{{ rupees(p.earned) }}</td>
                        <td class="px-3 py-2 text-right">{{ rupees(p.cod) }}</td>
                        <td class="py-2 pl-3 text-right">{{ p.rating_count ? "★ " + p.rating_avg.toFixed(1) + " (" + p.rating_count + ")" : "–" }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        </div>
      }
    </div>
  `,
})
export class AdminDeliveryReportsPage {
  protected readonly I = { CheckCircle2, XCircle, Percent, Banknote, Download };
  protected readonly ranges = RANGES;
  protected readonly rupees = rupees;
  protected readonly round = Math.round;
  protected readonly days = signal(30);
  private readonly r = signal<{ days: number; data: Report } | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly track = latestOnly();
  protected readonly rep = computed(() => this.r()?.data ?? null);
  // the previous report stays on screen, faded, while the new one loads
  protected readonly stale = computed(() => !!this.r() && this.r()!.days !== this.days());
  protected readonly every = computed(() => {
    const d = this.days();
    return d <= 7 ? 1 : d <= 30 ? 5 : d <= 90 ? 15 : 30;
  });
  protected readonly countSeries = [{ key: "delivered", label: "Delivered" }, { key: "failed", label: "Not delivered" }];
  protected readonly cashSeries = [{ key: "cod", label: "Cash collected" }];
  protected readonly fmtCount = (n: number) => Math.round(n).toLocaleString("en-IN");
  protected readonly fmtCash = (n: number) => rupees(Math.round(n));
  protected readonly countData = computed<ColumnDatum[]>(() => {
    const days = this.rep()?.days ?? [];
    return days.map((x, i) => ({ key: x.date, label: short(x.date), title: short(x.date), values: { delivered: x.delivered, failed: x.failed }, highlight: i === days.length - 1 }));
  });
  protected readonly cashData = computed<ColumnDatum[]>(() => {
    const days = this.rep()?.days ?? [];
    return days.map((x, i) => ({ key: x.date, label: short(x.date), title: short(x.date), values: { cod: x.cod }, highlight: i === days.length - 1 }));
  });

  constructor() {
    effect(() => {
      const days = this.days();
      this.track(api<Report>("/api/admin/delivery/reports", { query: { days } }), (x) => { this.r.set({ days, data: x }); this.error.set(null); })
        .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load the report"));
    });
  }

  protected download(rep: Report): void {
    const head = ["Partner", "Delivered", "Not delivered", "Declined or missed", "Success rate %", "Avg minutes accept to deliver", "Earned (₹)", "Cash collected (₹)", "Rating", "Ratings"];
    const rows = rep.partners.map((p) => [p.name, p.delivered, p.failed, p.declined, p.success_rate ?? "", p.avg_minutes ?? "", (p.earned / 100).toFixed(2), (p.cod / 100).toFixed(2), p.rating_avg, p.rating_count]);
    const blob = new Blob(["﻿" + [head, ...rows].map((x) => x.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `delivery-partners-${this.days()}-days.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
