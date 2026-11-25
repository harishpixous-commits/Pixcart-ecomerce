/*
 * Admin → Delivery → Payouts and cash. Weekly payouts are created every Monday for the week before (or here, for any
 * week); pay each partner from your bank and mark it paid with the bank reference, and the partner is told. "Cash with
 * partners" lists the cash-on-delivery money partners still hold; record a deposit when they hand it in.
 * Port of frontend/src/app/admin/delivery/payouts/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import { Router } from "@angular/router";
import { AlertTriangle, Banknote, CalendarPlus, CheckCircle2, Download, IndianRupee, Wallet } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError } from "../../core/api";
import { date, dateTime, rupees, toPaise } from "../../core/format";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, Pagination, Pill, Select, TextField, Toast } from "../../shared/ui/ui";
import { searchParam } from "../shared/admin-helpers";
import { Kpi, PartnerAvatar } from "../shared/delivery-admin";

type Bank = { holder?: string; ifsc?: string; account_last4?: string; upi?: string };
type Payout = {
  id: string; partner: { id: string; name: string; phone: string; bank: Bank }; period_start: string; period_end: string; deliveries: number;
  amount: number; cod_deducted: number; net_amount: number; status: "pending" | "paid"; paid_at: string | null; reference: string;
};
type Payouts = { items: Payout[]; total: number; page: number; page_size: number; pending_total: number; not_in_payout: number };
type CashPartner = { id: string; name: string; phone: string; photo: string; cash_in_hand: number; over_limit: boolean };
type Cash = { partners: CashPartner[]; total: number; limit: number; recent: { partner: string; amount: number; method: string; reference: string; note: string; at: string }[] };

const METHOD: Record<string, string> = { cash: "Cash", upi: "UPI", bank: "Bank transfer", payout: "From payout" };

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Component({
  selector: "pc-mark-paid",
  imports: [Modal, ErrorNote, TextField, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="!!payout()" (close)="close.emit()" [title]="payout() ? 'Pay ' + payout()!.partner.name + ' ' + rupees(payout()!.net_amount) : 'Mark paid'">
      <form (submit)="submit($event)" class="flex flex-col gap-3">
        <p class="text-sm text-ink-soft">Send the money from your bank or UPI first, then enter the transaction reference (UTR).</p>
        <pc-error-note [message]="error()" />
        <pc-text-field label="Bank or UPI reference" [value]="reference()" (valueChange)="reference.set($event)" [required]="true" [minlength]="3" [maxlength]="60" placeholder="e.g. UTR 4012 8899 1234" />
        <button pcButton type="submit" [loading]="busy()" [disabled]="reference().trim().length < 3" class="self-start">Mark as paid</button>
      </form>
    </pc-modal>
  `,
})
export class MarkPaid {
  readonly payout = input<Payout | null>(null);
  readonly close = output<void>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly rupees = rupees;
  protected readonly reference = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    const p = this.payout();
    if (!p) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/admin/delivery/payouts/${p.id}/paid`, { method: "POST", body: { reference: this.reference().trim() } });
      this.toast.show(`Marked paid. ${p.partner.name} has been told.`);
      this.reference.set("");
      this.done.emit();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not mark it paid");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-payouts-tab",
  imports: [Icon, PageLoader, Button, EmptyState, ErrorNote, Field, Input, Pagination, Pill, Kpi, MarkPaid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4" },
  template: `
    @if (data(); as data) {
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <pc-kpi [icon]="Wallet" label="To pay now" [value]="rupees(data.pending_total)" hint="Pending payouts" [tone]="data.pending_total ? 'amber' : 'gray'" />
        <pc-kpi [icon]="IndianRupee" label="Earned, not in a payout yet" [value]="rupees(data.not_in_payout)" hint="Goes into next week's payout" tone="blue" />
        @if (canPay()) {
          <div class="flex flex-col gap-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <p class="text-sm font-medium text-ink-soft">Create payouts now</p>
            <div class="flex flex-wrap items-end gap-2">
              <pc-field label="Any day in the week (empty = last week)" class="min-w-0 flex-1">
                <input pcInput type="date" [value]="week()" (input)="week.set($any($event.target).value)" aria-label="Week" />
              </pc-field>
              <button pcButton (click)="generate()" [loading]="busy()"><svg [pcIcon]="CalendarPlus" class="h-4 w-4" /> Create</button>
            </div>
            <p class="text-xs text-ink-faint">They are also created automatically every Monday morning.</p>
          </div>
        } @else {
          <p class="rounded-2xl bg-white p-4 text-sm text-ink-soft shadow-sm ring-1 ring-black/5">Payouts are created every Monday morning. Paying them needs the <b>Payouts</b> permission (Admin → Staff and roles).</p>
        }
      </div>
    }
    <pc-error-note [message]="error()" />
    @if (!data()) {
      @if (!error()) {<pc-page-loader />}
    } @else if (data()!.items.length === 0) {
      <pc-empty-state [title]="status() === 'pending' ? 'Nothing to pay right now' : 'No payouts paid yet'" [body]="status() === 'pending' ? 'Payouts appear here after a week with deliveries.' : undefined" [hasAction]="false" />
    } @else {
      <div class="flex justify-end">
        <button pcButton variant="secondary" size="sm" (click)="download(data()!.items)"><svg [pcIcon]="Download" class="h-4 w-4" /> Download CSV</button>
      </div>
      <ul class="flex flex-col gap-2" data-testid="payout-rows">
        @for (p of data()!.items; track p.id) {
          <li class="flex flex-col gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:flex-row sm:items-center">
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-center gap-2">
                <span class="font-semibold">{{ p.partner.name }}</span>
                <span class="text-sm text-ink-soft">{{ p.partner.phone }}</span>
                <pc-pill [tone]="p.status === 'paid' ? 'green' : 'amber'">{{ p.status === "paid" ? "Paid" : "To pay" }}</pc-pill>
              </p>
              <p class="text-sm text-ink-soft">{{ date(p.period_start) }} to {{ date(p.period_end) }} · {{ p.deliveries }} deliver{{ p.deliveries === 1 ? "y" : "ies" }} · earned {{ rupees(p.amount) }}{{ p.cod_deducted ? " · cash held " + rupees(p.cod_deducted) + " taken off" : "" }}</p>
              <p class="text-xs text-ink-faint">{{ bankLine(p) }}</p>
            </div>
            <div class="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
              <span class="font-display text-xl font-bold">{{ rupees(p.net_amount) }}</span>
              @if (p.status === "pending" && canPay()) {<button pcButton size="sm" (click)="paying.set(p)" data-testid="mark-paid"><svg [pcIcon]="CheckCircle2" class="h-4 w-4" /> Mark paid</button>}
            </div>
          </li>
        }
      </ul>
      <pc-pagination [page]="page()" [pageSize]="data()!.page_size" [total]="data()!.total" (pageChange)="page.set($event)" />
    }
    <pc-mark-paid [payout]="paying()" (close)="paying.set(null)" (done)="paying.set(null); load()" />
  `,
})
export class PayoutsTab {
  readonly status = input.required<"pending" | "paid">();
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly canPay = computed(() => this.admin.can("payouts")); // creating and paying payouts needs the Payouts permission
  protected readonly Wallet = Wallet; protected readonly IndianRupee = IndianRupee; protected readonly CalendarPlus = CalendarPlus;
  protected readonly Download = Download; protected readonly CheckCircle2 = CheckCircle2;
  protected readonly rupees = rupees; protected readonly date = date;
  protected readonly page = signal(1);
  private readonly d = signal<{ key: string; data: Payouts } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly paying = signal<Payout | null>(null);
  protected readonly week = signal("");
  protected readonly busy = signal(false);
  protected readonly data = computed(() => { const d = this.d(); return d?.key === `${this.status()}:${this.page()}` ? d.data : null; });

  constructor() {
    effect(() => this.load());
  }

  protected load(): void {
    const status = this.status(), page = this.page();
    api<Payouts>("/api/admin/delivery/payouts", { query: { status, page } }).then((x) => { this.d.set({ key: `${status}:${page}`, data: x }); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load payouts"));
  }

  protected bankLine(p: Payout): string {
    const b = p.partner.bank;
    return (b.ifsc ? `${b.holder ?? ""} · ${b.ifsc} · ••••${b.account_last4 ?? ""}` : "No bank account added") + (b.upi ? ` · UPI ${b.upi}` : "")
      + (p.status === "paid" ? ` · paid ${dateTime(p.paid_at)}, ref ${p.reference}` : "");
  }

  protected async generate(): Promise<void> {
    this.busy.set(true);
    try {
      const week = this.week();
      const r = await api<{ created: number; week_start: string }>("/api/admin/delivery/payouts/generate", { method: "POST", body: week ? { week_start: week } : {} });
      this.toast.show(r.created ? `${r.created} payout${r.created === 1 ? "" : "s"} created for the week of ${date(r.week_start)}` : `Nothing new to pay for the week of ${date(r.week_start)}`);
      this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not create payouts", "error");
    } finally {
      this.busy.set(false);
    }
  }

  protected download(items: Payout[]): void {
    const head = ["Partner", "Mobile", "Account holder", "IFSC", "Account (last 4)", "UPI", "From", "To", "Deliveries", "Earned (₹)", "Cash held (₹)", "To pay (₹)", "Status", "Reference"];
    const rows = items.map((p) => [p.partner.name, p.partner.phone, p.partner.bank.holder ?? "", p.partner.bank.ifsc ?? "", p.partner.bank.account_last4 ?? "", p.partner.bank.upi ?? "",
      p.period_start, p.period_end, p.deliveries, (p.amount / 100).toFixed(2), (p.cod_deducted / 100).toFixed(2), (p.net_amount / 100).toFixed(2), p.status, p.reference]);
    const blob = new Blob(["﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `partner-payouts-${this.status()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

@Component({
  selector: "pc-cash-deposit",
  imports: [Modal, ErrorNote, Field, Select, TextField, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="!!partner()" (close)="close.emit()" [title]="partner() ? 'Cash from ' + partner()!.name : 'Record deposit'">
      <form (submit)="submit($event)" class="flex flex-col gap-3">
        @if (partner(); as p) {<p class="text-sm text-ink-soft">{{ p.name }} holds {{ rupees(p.cash_in_hand) }}.</p>}
        <pc-error-note [message]="error()" />
        <div class="grid grid-cols-2 gap-3">
          <pc-text-field label="Amount (₹)" [value]="amount()" (valueChange)="amount.set($event)" inputmode="decimal" [required]="true" [placeholder]="partner() ? '' + partner()!.cash_in_hand / 100 : ''" />
          <pc-field label="How">
            <select pcSelect (change)="method.set($any($event.target).value)">
              <option value="cash" [selected]="method() === 'cash'">Cash</option><option value="upi" [selected]="method() === 'upi'">UPI</option><option value="bank" [selected]="method() === 'bank'">Bank transfer</option>
            </select>
          </pc-field>
        </div>
        <pc-text-field label="Reference (optional)" [value]="reference()" (valueChange)="reference.set($event)" [maxlength]="60" placeholder="Receipt or UPI reference" />
        <button pcButton type="submit" [loading]="busy()" class="self-start">Save deposit</button>
      </form>
    </pc-modal>
  `,
})
export class CashDeposit {
  readonly partner = input<CashPartner | null>(null);
  readonly close = output<void>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly rupees = rupees;
  protected readonly amount = signal("");
  protected readonly method = signal("cash");
  protected readonly reference = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    const partner = this.partner();
    if (!partner) return;
    const paise = toPaise(this.amount());
    if (!paise) return void this.error.set("Enter the amount in rupees, like 1500");
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<{ cash_in_hand: number }>(`/api/admin/delivery/partners/${partner.id}/deposits`, { method: "POST", body: { amount_paise: paise, method: this.method(), reference: this.reference().trim() } });
      this.toast.show(`Deposit saved. ${partner.name} now holds ${rupees(r.cash_in_hand)}.`);
      this.amount.set("");
      this.reference.set("");
      this.done.emit();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save the deposit");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-cash-tab",
  imports: [PageLoader, Button, EmptyState, ErrorNote, Kpi, PartnerAvatar, CashDeposit],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!d()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <div class="flex flex-col gap-4">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <pc-kpi [icon]="Banknote" label="Cash with partners" [value]="rupees(d()!.total)" [hint]="d()!.partners.length + ' partner' + (d()!.partners.length === 1 ? '' : 's') + ' holding cash'" tone="amber" />
          <pc-kpi [icon]="AlertTriangle" label="Over the limit" [value]="over()" [hint]="'Limit ' + rupees(d()!.limit) + ' per partner'" [alert]="over() > 0" tone="gray" />
          <pc-kpi [icon]="IndianRupee" label="Recent deposits" [value]="d()!.recent.length" hint="Last 30 shown below" tone="blue" />
        </div>
        @if (d()!.partners.length === 0) {
          <pc-empty-state title="No partner holds cash" body="Cash collected on delivery shows here until the partner deposits it." [hasAction]="false" />
        } @else {
          <ul class="flex flex-col gap-2" data-testid="cash-rows">
            @for (p of d()!.partners; track p.id) {
              <li [class]="p.over_limit ? 'flex items-center gap-3 rounded-xl bg-white p-3 shadow-sm ring-1 sm:p-4 ring-vermilion/40' : 'flex items-center gap-3 rounded-xl bg-white p-3 shadow-sm ring-1 sm:p-4 ring-black/5'">
                <pc-partner-avatar [p]="p" size="sm" />
                <div class="min-w-0 flex-1">
                  <p class="font-semibold">{{ p.name }}</p>
                  <p class="text-sm text-ink-soft">{{ p.phone }}{{ p.over_limit ? " · over the limit, gets no new cash orders" : "" }}</p>
                </div>
                <span [class]="p.over_limit ? 'font-display text-lg font-bold text-vermilion' : 'font-display text-lg font-bold'">{{ rupees(p.cash_in_hand) }}</span>
                <button pcButton size="sm" variant="secondary" (click)="depositing.set(p)">Record deposit</button>
              </li>
            }
          </ul>
        }
        @if (d()!.recent.length > 0) {
          <section class="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <h2 class="mb-2 font-semibold">Recent deposits</h2>
            <ul class="divide-y divide-line text-sm">
              @for (r of d()!.recent; track $index) {
                <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><b>{{ r.partner }}</b> · {{ method[r.method] || r.method }}{{ r.reference ? " · " + r.reference : "" }}{{ r.note ? " · " + r.note : "" }}</span>
                  <span class="text-ink-soft">{{ rupees(r.amount) }} · {{ dateTime(r.at) }}</span>
                </li>
              }
            </ul>
          </section>
        }
        <pc-cash-deposit [partner]="depositing()" (close)="depositing.set(null)" (done)="depositing.set(null); load()" />
      </div>
    }
  `,
})
export class CashTab {
  protected readonly Banknote = Banknote; protected readonly AlertTriangle = AlertTriangle; protected readonly IndianRupee = IndianRupee;
  protected readonly rupees = rupees; protected readonly dateTime = dateTime; protected readonly method = METHOD;
  protected readonly d = signal<Cash | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly depositing = signal<CashPartner | null>(null);
  protected readonly over = computed(() => this.d()?.partners.filter((p) => p.over_limit).length ?? 0);

  constructor() {
    this.load();
  }

  protected load(): void {
    api<Cash>("/api/admin/delivery/cash").then((x) => { this.d.set(x); this.error.set(null); }).catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load cash"));
  }
}

@Component({
  selector: "pc-admin-delivery-payouts-page",
  imports: [PageHeader, Tabs, PayoutsTab, CashTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Partner payouts and cash" sub="Pay partners every week, and keep track of the cash-on-delivery money they hold." />
    <pc-tabs [value]="tab()" (valueChange)="pick($event)" [items]="tabs" />
    @if (tab() === "cash") {<pc-cash-tab />} @else {<pc-payouts-tab [status]="tab() === 'paid' ? 'paid' : 'pending'" />}
  `,
})
export class AdminDeliveryPayoutsPage {
  private readonly router = inject(Router);
  private readonly tabParam = searchParam("tab");
  protected readonly tab = computed(() => { const t = this.tabParam() ?? ""; return (["pending", "paid", "cash"].includes(t) ? t : "pending") as "pending" | "paid" | "cash"; });
  protected readonly tabs = [{ value: "pending", label: "To pay" }, { value: "paid", label: "Paid" }, { value: "cash", label: "Cash with partners" }];

  protected pick(v: string): void {
    void this.router.navigateByUrl(`/admin/delivery/payouts?tab=${v}`, { replaceUrl: true });
  }
}
