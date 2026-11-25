/*
 * Admin → Seller payouts: create the payout run, the bank file (manual mode) or RazorpayX sending, record UTRs,
 * confirm a changed bank account, cancel, export. Port of frontend/src/app/admin/payouts/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Download, Send } from "lucide-angular";
import { api, ApiError, downloadFile, latestOnly } from "../../core/api";
import { date, rupeesExact } from "../../core/format";
import { RouteState } from "../../core/route-state";
import { ExportButton } from "../../shared/portal/export-button";
import { PageHeader, Stat, Table, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Modal, Pagination, Pill, StatusPill, TextField, Toast } from "../../shared/ui/ui";

type P = {
  id: string; number: string; seller_name: string; amount: number; status: string; mode: string; utr: string; failure_reason: string;
  bank: { holder?: string; account_last4?: string; ifsc?: string }; created_at: string; paid_at: string | null;
  /** the seller's bank details changed after this payout was made: confirm the new account (or cancel) before paying */
  bank_changed?: boolean;
};
type D = { mode: string; razorpayx_ready: boolean; due: { seller: string; amount: number }[]; items: P[]; total: number };

@Component({
  selector: "pc-admin-payouts-page",
  imports: [ExportButton, PageHeader, Stat, Table, Tabs, Icon, PageLoader, Button, EmptyState, ErrorNote, Modal, Pagination, Pill, StatusPill, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!d()) {
      <pc-page-loader />
    } @else {
      <div class="flex flex-col gap-4">
        <pc-page-header title="Seller payouts" [withActions]="true"
          [sub]="d()!.mode === 'razorpayx' ? 'Payouts are sent through RazorpayX and confirmed automatically.' : 'Manual mode: download the bank file, upload it in your bank\\'s bulk-transfer screen, then record each UTR here. Payouts whose seller changed bank details are left out of the file until you confirm the new account.'">
          @if (d()!.mode !== "razorpayx") {<button actions pcButton variant="secondary" (click)="bankFile()"><svg [pcIcon]="I.Download" class="h-4 w-4" /> Bank file</button>}
          <pc-export-button actions scope="admin" name="payouts" [status]="status() || undefined" />
          <button actions pcButton (click)="call(runPayouts, 'Payouts created')" [loading]="busy()">Create payouts now</button>
        </pc-page-header>
        <pc-error-note [message]="error()" />
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <pc-stat label="Ready to pay" [value]="rupeesExact(dueTotal())" [hint]="d()!.due.length + ' sellers with balances past the return window'" />
          <pc-stat label="Payout method" [value]="d()!.mode === 'razorpayx' ? 'RazorpayX' : 'Bank file'" [hint]="d()!.mode === 'razorpayx' && !d()!.razorpayx_ready ? 'RazorpayX keys missing' : undefined" />
          <pc-stat label="Pending payouts" [value]="pending()" />
        </div>
        <pc-tabs [value]="status()" (valueChange)="status.set($event); page.set(1)" [items]="tabs" />
        @if (d()!.items.length === 0) {
          <pc-empty-state title="No payouts here" [hasAction]="false" />
        } @else {
          <pc-table [head]="['Payout', 'Seller', 'Amount', 'Bank', 'Created', 'Status', '']">
            @for (p of d()!.items; track p.id) {
              <tr>
                <td class="px-4 py-2.5 font-medium">{{ p.number }}</td>
                <td class="px-4 py-2.5">{{ p.seller_name }}</td>
                <td class="px-4 py-2.5 font-semibold">{{ rupeesExact(p.amount) }}</td>
                <td class="px-4 py-2.5 text-sm">
                  {{ p.bank.holder }}<br /><span class="text-ink-faint">XXXX{{ p.bank.account_last4 }}, {{ p.bank.ifsc }}</span>
                  @if (p.bank_changed) {
                    <span class="mt-1 block max-w-[220px] rounded bg-marigold-light px-2 py-1 text-xs font-semibold text-ink" data-testid="bank-changed">
                      The seller's bank account changed after this payout was made. Check with the seller before paying.
                    </span>
                  }
                </td>
                <td class="px-4 py-2.5 text-sm">{{ date(p.created_at) }}</td>
                <td class="px-4 py-2.5">
                  <pc-status-pill [status]="p.status === 'paid' ? 'approved' : p.status === 'failed' || p.status === 'cancelled' ? 'failed' : 'pending'" [label]="p.status" />
                  @if (p.utr) {<p class="font-mono text-xs">{{ p.utr }}</p>}
                  @if (p.failure_reason) {<p class="text-xs text-vermilion">{{ p.failure_reason }}</p>}
                </td>
                <td class="px-4 py-2.5">
                  @if (p.status === "pending") {
                    <div class="flex flex-wrap gap-1">
                      @if (p.bank_changed) {
                        <button pcButton size="sm" variant="secondary" (click)="useNewBank(p)">Use the new account</button>
                      }
                      @if (d()!.mode === "razorpayx") {
                        @if (!p.bank_changed) {<button pcButton size="sm" (click)="send(p)"><svg [pcIcon]="I.Send" class="h-4 w-4" /> Send</button>}
                      } @else {
                        <button pcButton size="sm" (click)="paid.set(p)">Record UTR</button>
                      }
                      <button pcButton size="sm" variant="ghost" (click)="cancel(p)">Cancel</button>
                    </div>
                  }
                  @if (p.mode === "razorpayx" && p.status === "processing") {<pc-pill tone="blue">Waiting for bank</pc-pill>}
                </td>
              </tr>
            }
          </pc-table>
        }
        <pc-pagination [page]="page()" [pageSize]="50" [total]="d()!.total" (pageChange)="page.set($event)" />
        <pc-modal [open]="!!paid()" (close)="paid.set(null)" [title]="'Record payment ' + (paid()?.number ?? '')">
          @if (paid(); as p) {
            <div class="flex flex-col gap-3">
              <p class="text-ink-soft">{{ rupeesExact(p.amount) }} to {{ p.bank.holder }}, account ending {{ p.bank.account_last4 }}.</p>
              <pc-text-field label="UTR / bank reference" [value]="utr()" [filter]="utrOnly" (valueChange)="utr.set($event)" [maxlength]="40" />
              <button pcButton [disabled]="utr().length < 6" [loading]="busy()" (click)="markPaid(p)">Mark as paid</button>
            </div>
          }
        </pc-modal>
      </div>
    }
  `,
})
export class AdminPayoutsPage {
  private readonly toast = inject(Toast);
  private readonly route = inject(RouteState);
  private readonly sellerId = computed(() => this.route.params().get("seller_id") ?? undefined);
  protected readonly I = { Download, Send };
  protected readonly rupeesExact = rupeesExact;
  protected readonly date = date;
  protected readonly utrOnly = (v: string) => v.replace(/[^A-Za-z0-9]/g, "");
  protected readonly tabs = [{ value: "pending", label: "To pay" }, { value: "processing", label: "Processing" }, { value: "paid", label: "Paid" }, { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" }, { value: "", label: "All" }];
  protected readonly status = signal("pending");
  protected readonly d = signal<D | null>(null);
  protected readonly paid = signal<P | null>(null);
  protected readonly utr = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly page = signal(1);
  private readonly track = latestOnly();
  protected readonly dueTotal = computed(() => (this.d()?.due ?? []).reduce((s, x) => s + x.amount, 0));
  protected readonly pending = computed(() => (this.d()?.items ?? []).filter((p) => p.status === "pending").length);
  protected readonly runPayouts = () => api("/api/admin/payouts/run", { method: "POST" });

  constructor() {
    effect(() => this.load());
  }

  private load(): void {
    void this.track(api<D>("/api/admin/payouts", { query: { status: this.status() || undefined, page: this.page(), seller_id: this.sellerId() } }), (x) => this.d.set(x));
  }

  protected async call(fn: () => Promise<unknown>, msg: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
      this.toast.show(msg);
      this.paid.set(null);
      this.utr.set("");
      this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Something went wrong");
    } finally {
      this.busy.set(false);
    }
  }

  protected async bankFile(): Promise<void> {
    this.error.set(null);
    try {
      await downloadFile("/api/admin/payouts/bank-file.csv", undefined, "bank-file.csv");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not create the bank file");
    }
  }

  protected useNewBank(p: P): void {
    if (window.confirm("Pay this payout to the seller's new bank account? Do this only after checking the change with the seller."))
      void this.call(() => api(`/api/admin/payouts/${p.id}/use-current-bank`, { method: "POST" }), "The payout now goes to the new account");
  }

  protected send(p: P): void {
    void this.call(() => api(`/api/admin/payouts/${p.id}/send`, { method: "POST" }), "Sent to RazorpayX");
  }

  protected cancel(p: P): void {
    if (window.confirm("Cancel this payout? The balance returns to the seller's available amount.")) void this.call(() => api(`/api/admin/payouts/${p.id}/cancel`, { method: "POST" }), "Payout cancelled");
  }

  protected markPaid(p: P): void {
    void this.call(() => api(`/api/admin/payouts/${p.id}/paid`, { method: "POST", body: { utr: this.utr() } }), "Marked as paid");
  }
}
