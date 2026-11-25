/* Balances, payouts to the bank and the statement (ledger). Port of frontend/src/app/seller/payouts/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, signal } from "@angular/core";
import { Download } from "lucide-angular";
import { ApiError, api, downloadFile, quietly } from "../../core/api";
import { WEEKDAYS, date, rupees, rupeesExact } from "../../core/format";
import { PageHeader, Stat, Table, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Pill, StatusPill } from "../../shared/ui/ui";

/** Automatic payout runs as the marketplace sets them (Admin → Settings); next_at is null when they are off. */
type Schedule = { auto: boolean; weekday: number; every_weeks: number; min_paise: number; next_at: string | null };
type P = { id: string; number: string; amount: number; status: string; mode: string; utr: string; failure_reason: string; bank: { holder?: string; account_last4?: string; ifsc?: string }; created_at: string; paid_at: string | null };
type L = { at: string; kind: string; amount: number; description: string; order: string | null; available_at: string; available: boolean; payout: string | null };
type D = { balances: { available: number; upcoming: number; paid_out: number }; payouts: P[]; schedule: Schedule };

const KIND: Record<string, string | undefined> = {
  sale: "Sale", commission: "Commission", commission_gst: "GST on commission", tcs: "GST TCS", tds: "Income-tax TDS",
  return: "Return", commission_reversal: "Commission returned", commission_gst_reversal: "GST on commission returned",
  tcs_reversal: "TCS returned", tds_reversal: "TDS returned", adjustment: "Adjustment", payout_reversal: "Payout reversed",
  ad_spend: "Sponsored products", cod_collected: "Cash your courier collected",
};

@Component({
  selector: "pc-seller-payouts-page",
  imports: [PageHeader, Stat, Table, Tabs, Icon, PageLoader, Button, EmptyState, ErrorNote, Pill, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!d()) {
      <pc-page-loader />
    } @else {
      <div class="flex flex-col gap-4">
        <pc-page-header title="Payouts" [sub]="sub()" [withActions]="true">
          <button actions pcButton variant="secondary" (click)="exportCsv()"><svg [pcIcon]="Download" class="h-4 w-4" /> Statement, last 12 months</button>
        </pc-page-header>
        <pc-error-note [message]="exportError()" />
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <pc-stat label="Available for the next payout" [value]="money(d()!.balances.available)" [hint]="availableHint()" />
          <pc-stat label="In the return window" [value]="money(d()!.balances.upcoming)" hint="Moves to available when the window closes" />
          <pc-stat label="Paid out so far" [value]="money(d()!.balances.paid_out)" />
        </div>
        <pc-tabs [value]="tab()" (valueChange)="tab.set($event)" [items]="tabs" />
        @if (tab() === "payouts") {
          @if (d()!.payouts.length === 0) {
            <pc-empty-state title="No payouts yet" body="Your first payout is made after the return window of your first delivered order closes." [hasAction]="false" />
          } @else {
            <pc-table [head]="payoutHead">
              @for (p of d()!.payouts; track p.id) {
                <tr>
                  <td class="px-4 py-2.5 font-medium">{{ p.number }}</td>
                  <td class="px-4 py-2.5 text-sm">{{ date(p.created_at) }}</td>
                  <td class="px-4 py-2.5 font-semibold">{{ money(p.amount) }}</td>
                  <td class="px-4 py-2.5 text-sm">{{ p.bank.holder }}, XXXX{{ p.bank.account_last4 }}</td>
                  <td class="px-4 py-2.5"><pc-status-pill [status]="p.status === 'paid' ? 'approved' : p.status === 'failed' ? 'failed' : 'pending'" [label]="p.status" /></td>
                  <td class="px-4 py-2.5 font-mono text-sm">@if (p.utr) {<ng-container>{{ p.utr }}</ng-container>} @else if (p.failure_reason) {<span class="text-vermilion">{{ p.failure_reason }}</span>}</td>
                </tr>
              }
            </pc-table>
          }
        } @else if (!ledger()) {
          <pc-page-loader />
        } @else {
          <pc-table [head]="ledgerHead">
            @for (e of ledger()!; track $index) {
              <tr>
                <td class="px-4 py-2 text-sm">{{ date(e.at) }}</td>
                <td class="px-4 py-2">{{ kind[e.kind] ?? e.kind }}</td>
                <td class="px-4 py-2 text-sm">{{ e.order }}</td>
                <td [class]="e.amount < 0 ? 'px-4 py-2 text-vermilion' : 'px-4 py-2 text-leaf'">{{ money(e.amount) }}</td>
                <td class="px-4 py-2 text-sm">{{ e.available ? "Yes" : "From " + date(e.available_at) }}</td>
                <td class="px-4 py-2 text-sm">@if (e.payout) {<pc-pill tone="green">{{ e.payout }}</pc-pill>}</td>
              </tr>
            }
          </pc-table>
        }
      </div>
    }
  `,
})
export class SellerPayoutsPage {
  protected readonly Download = Download;
  protected readonly kind = KIND;
  protected readonly date = date;
  protected readonly money = rupeesExact;
  protected readonly payoutHead = ["Payout", "Created", "Amount", "Bank", "Status", "UTR"];
  protected readonly ledgerHead = ["Date", "Type", "Order", "Amount", "Available", "Payout"];
  protected readonly tabs = [{ value: "payouts", label: "Payouts" }, { value: "statement", label: "Statement" }];
  protected readonly tab = signal("payouts");
  protected readonly d = signal<D | null>(null);
  protected readonly ledger = signal<L[] | null>(null);
  protected readonly exportError = signal<string | null>(null);
  protected readonly sub = computed(() => {
    const sch = this.d()!.schedule;
    const when = sch.auto ? `every ${sch.every_weeks === 2 ? "second " : ""}${WEEKDAYS[sch.weekday]}` : "when the marketplace runs payouts";
    return `Money from delivered orders becomes available when the return window closes, and is paid to your bank ${when}.`;
  });
  protected readonly availableHint = computed(() => {
    const sch = this.d()!.schedule;
    const minimum = `if it is ${rupees(sch.min_paise)} or more`;
    return sch.next_at ? `Paid on ${date(sch.next_at)} ${minimum}` : `Paid at the next payout ${minimum}`;
  });

  constructor() {
    api<D>("/api/seller/payouts").then((d) => this.d.set(d)).catch(quietly);
    effect(() => {
      if (this.tab() === "statement" && !this.ledger()) api<{ items: L[] }>("/api/seller/ledger").then((r) => this.ledger.set(r.items)).catch(quietly);
    });
  }

  protected async exportCsv(): Promise<void> {
    // The last 12 months; other periods are on the Reports and exports page.
    this.exportError.set(null);
    const from = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    try {
      await downloadFile("/api/seller/exports/ledger.csv", { from }, "statement.csv");
    } catch (e) {
      this.exportError.set(e instanceof ApiError ? e.message : "Could not download the statement");
    }
  }
}
