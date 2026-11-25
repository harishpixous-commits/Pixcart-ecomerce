/*
 * Partner earnings: today, this week, this month and all time (delivery fees plus customer tips), the last 7 days as
 * a chart, what is still to be paid, the cash on delivery they hold against the limit (and deposits made), and the
 * weekly payouts with their status and bank reference. Port of frontend/src/app/delivery/earnings/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { AlertTriangle, Banknote, CalendarCheck, CheckCircle2, Clock, IndianRupee, Wallet } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import type { EarningsPeriod, PartnerEarnings } from "../../core/delivery-types";
import { date, dateTime, rupees } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { ErrorNote } from "../../shared/ui/ui";
import { ColumnChart, type ColumnDatum } from "../components/columns";
import { usePolling } from "../components/trip";
import { FullLoader } from "../shell/delivery-app";

const DEPOSIT: Record<string, string> = { cash: "Cash at the office", upi: "UPI", bank: "Bank transfer", payout: "Taken from payout" };

function dayLabel(iso: string, short: boolean): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-IN", short ? { weekday: "short" } : { weekday: "long", day: "numeric", month: "short" });
}

@Component({
  selector: "pc-earnings-period",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block rounded-2xl bg-white/10 p-3" },
  template: `
    <p class="text-[11px] font-semibold uppercase tracking-wide text-white/70">{{ label() }}</p>
    <p class="font-display text-lg font-bold leading-tight">{{ rupees(p().earned) }}</p>
    <p class="text-xs text-white/70">{{ p().trips }} trip{{ p().trips === 1 ? "" : "s" }}</p>
  `,
})
export class EarningsPeriodTile {
  readonly label = input.required<string>();
  readonly p = input.required<EarningsPeriod>();
  protected readonly rupees = rupees;
}

@Component({
  selector: "pc-delivery-earnings-page",
  imports: [Icon, ErrorNote, ColumnChart, FullLoader, EarningsPeriodTile],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (e(); as e) {
      <div class="flex flex-col gap-4" data-testid="partner-earnings">
        <h1 class="px-1 font-display text-2xl font-bold">Earnings</h1>

        <section class="overflow-hidden rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-5 text-white shadow-sm">
          <p class="text-sm font-semibold text-white/80">This week</p>
          <p class="font-display text-4xl font-bold">{{ rupees(e.week.earned) }}</p>
          <p class="mt-1 text-sm text-white/80">
            {{ e.week.trips }} deliver{{ e.week.trips === 1 ? "y" : "ies" }} · fees {{ rupees(e.week.fees) }}{{ e.week.tips ? " · tips " + rupees(e.week.tips) : "" }}{{ e.week.bonuses ? " · bad weather bonus " + rupees(e.week.bonuses) : "" }}
          </p>
          <div class="mt-4 grid grid-cols-3 gap-2">
            <pc-earnings-period label="Today" [p]="e.today" />
            <pc-earnings-period label="This month" [p]="e.month" />
            <pc-earnings-period label="All time" [p]="e.total" />
          </div>
        </section>

        <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 class="font-semibold">Last 7 days</h2>
          <p class="mb-3 text-sm text-ink-soft">What you earned each day: fees, tips and bonuses</p>
          <figure pcColumnChart caption="Earnings per day for the last 7 days" [series]="series" [data]="days()" [format]="money" [height]="150"></figure>
        </section>

        <div class="grid gap-3 sm:grid-cols-2">
          <section class="flex flex-col gap-1 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <p class="flex items-center gap-2 text-sm font-semibold text-ink-soft"><svg [pcIcon]="Clock" class="h-4 w-4 text-peacock" />To be paid</p>
            <p class="font-display text-2xl font-bold">{{ rupees(e.unpaid) }}</p>
            <p class="text-sm text-ink-soft">Earned but not yet in a payout. Payouts are made every week for the week before.</p>
          </section>
          <section [class]="over() ? 'flex flex-col gap-1 rounded-2xl p-4 shadow-sm ring-1 bg-vermilion-light ring-vermilion/30' : 'flex flex-col gap-1 rounded-2xl p-4 shadow-sm ring-1 bg-white ring-black/5'">
            <p [class]="over() ? 'flex items-center gap-2 text-sm font-semibold text-vermilion' : 'flex items-center gap-2 text-sm font-semibold text-ink-soft'">
              @if (over()) {<svg [pcIcon]="AlertTriangle" class="h-4 w-4" />} @else {<svg [pcIcon]="Banknote" class="h-4 w-4 text-marigold-dark" />}Cash in hand
            </p>
            <p [class]="over() ? 'font-display text-2xl font-bold text-vermilion' : 'font-display text-2xl font-bold'">{{ rupees(e.cash_in_hand) }}</p>
            @if (e.cash_limit > 0) {
              <div class="h-1.5 overflow-hidden rounded-full bg-mist" role="meter" aria-valuemin="0" [attr.aria-valuemax]="e.cash_limit" [attr.aria-valuenow]="e.cash_in_hand" aria-label="Cash held against the limit">
                <div [class]="over() ? 'h-full rounded-full bg-vermilion' : cashPct() > 75 ? 'h-full rounded-full bg-marigold' : 'h-full rounded-full bg-leaf'" [style.width.%]="cashPct()"></div>
              </div>
              <p class="text-sm text-ink-soft">{{ over() ? "Above" : "Limit" }} {{ rupees(e.cash_limit) }}. {{ over() ? "Deposit the cash to keep getting cash-on-delivery orders." : "Deposit cash with the delivery team regularly." }}</p>
            }
          </section>
        </div>

        <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 class="mb-2 flex items-center gap-2 font-semibold"><svg [pcIcon]="Wallet" class="h-4 w-4 text-peacock" />Weekly payouts</h2>
          @if (e.payouts.length === 0) {
            <p class="text-sm text-ink-soft">Your first payout appears here after your first full week of deliveries.</p>
          } @else {
            <ul class="divide-y divide-line" data-testid="payout-list">
              @for (p of e.payouts; track p.id) {
                <li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <span [class]="p.status === 'paid' ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-leaf-light text-leaf' : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-marigold-light text-marigold-dark'">
                    <svg [pcIcon]="p.status === 'paid' ? CheckCircle2 : CalendarCheck" class="h-5 w-5" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block font-semibold">{{ date(p.period_start) }} to {{ date(p.period_end) }}</span>
                    <span class="block text-sm text-ink-soft">
                      {{ p.deliveries }} deliver{{ p.deliveries === 1 ? "y" : "ies" }} · {{ rupees(p.amount) }}{{ p.cod_deducted ? " − " + rupees(p.cod_deducted) + " cash held" : "" }}
                    </span>
                    @if (p.status === "paid") {<span class="block text-xs text-ink-faint">Paid {{ dateTime(p.paid_at) }}{{ p.reference ? " · Ref " + p.reference : "" }}</span>}
                  </span>
                  <span class="text-right">
                    <span class="block font-display text-lg font-bold">{{ rupees(p.net_amount) }}</span>
                    <span [class]="p.status === 'paid' ? 'text-xs font-semibold text-leaf' : 'text-xs font-semibold text-marigold-dark'">{{ p.status === "paid" ? "Paid" : "Processing" }}</span>
                  </span>
                </li>
              }
            </ul>
          }
        </section>

        @if (e.deposits.length > 0) {
          <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <h2 class="mb-2 flex items-center gap-2 font-semibold"><svg [pcIcon]="IndianRupee" class="h-4 w-4 text-peacock" />Cash deposits</h2>
            <ul class="divide-y divide-line text-sm">
              @for (d of e.deposits; track $index) {
                <li class="flex items-center justify-between gap-3 py-2">
                  <span>
                    <span class="block font-medium">{{ DEPOSIT[d.method] ?? d.method }}{{ d.reference ? " · " + d.reference : "" }}</span>
                    <span class="text-xs text-ink-faint">{{ dateTime(d.at) }}</span>
                  </span>
                  <span class="font-semibold">{{ rupees(d.amount) }}</span>
                </li>
              }
            </ul>
          </section>
        }
      </div>
    } @else if (error()) {
      <pc-error-note [message]="error()" />
    } @else {
      <pc-full-loader label="Loading your earnings" />
    }
  `,
})
export class DeliveryEarningsPage {
  protected readonly e = signal<PartnerEarnings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly series = [{ key: "earned", label: "Earned" }];
  protected readonly money = (n: number) => rupees(Math.round(n));
  protected readonly rupees = rupees;
  protected readonly date = date;
  protected readonly dateTime = dateTime;
  protected readonly DEPOSIT = DEPOSIT;
  protected readonly Clock = Clock;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Banknote = Banknote;
  protected readonly Wallet = Wallet;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly CalendarCheck = CalendarCheck;
  protected readonly IndianRupee = IndianRupee;
  protected readonly over = computed(() => {
    const e = this.e();
    return !!e && e.cash_limit > 0 && e.cash_in_hand > e.cash_limit;
  });
  protected readonly cashPct = computed(() => {
    const e = this.e();
    return e && e.cash_limit > 0 ? Math.min(100, Math.round((100 * e.cash_in_hand) / e.cash_limit)) : 0;
  });
  protected readonly days = computed<ColumnDatum[]>(() => {
    const e = this.e();
    if (!e) return [];
    const last = e.days[e.days.length - 1]?.date;
    return e.days.map((d) => ({
      key: d.date,
      label: d.date === last ? "Today" : dayLabel(d.date, true),
      title: `${dayLabel(d.date, false)} · ${d.trips} deliver${d.trips === 1 ? "y" : "ies"}`,
      values: { earned: d.earned },
      highlight: d.date === last,
    }));
  });

  constructor() {
    usePolling(() => {
      api<PartnerEarnings>("/api/delivery/earnings").then((x) => { this.e.set(x); this.error.set(null); })
        .catch((x) => this.error.set(x instanceof ApiError ? x.message : "Could not load your earnings"));
    }, 60_000);
  }
}
