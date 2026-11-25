/* Admin → Refunds: failed and running refunds, retry, or record a refund paid by hand. Port of frontend/src/app/admin/refunds/page.tsx. */

import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from "@angular/core";
import { api, ApiError, latestOnly } from "../../core/api";
import { dateTime, rupeesExact } from "../../core/format";
import { PageHeader, Table, Tabs } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Input, Modal, Pagination, Select, StatusPill, TextField, Toast } from "../../shared/ui/ui";

type Row = { id: string; order_id: string; order_number: string; amount: number; status: string; reason: string; attempts: number; last_error: string; created_at: string };

@Component({
  selector: "pc-admin-refunds-page",
  imports: [PageHeader, Table, Tabs, PcLink, PageLoader, Button, EmptyState, ErrorNote, Input, Modal, Pagination, Select, StatusPill, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Refunds" sub="Failed refunds are retried automatically 8 times, then wait here for you." />
      <input pcInput placeholder="Order number" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="mb-3 max-w-xs" aria-label="Search refunds" />
      <pc-tabs [value]="status()" (valueChange)="status.set($event); page.set(1)" [items]="tabs" />
      @if (!rows()) {
        <pc-page-loader />
      } @else if (rows()!.length === 0) {
        <pc-empty-state title="No refunds here" [hasAction]="false" />
      } @else {
        <pc-table [head]="['Order', 'Amount', 'Reason', 'Attempts', 'Created', 'Status', '']">
          @for (r of rows()!; track r.id) {
            <tr>
              <td class="px-4 py-2.5"><a [pcLink]="'/admin/orders/' + r.order_id" class="font-semibold text-peacock">{{ r.order_number }}</a></td>
              <td class="px-4 py-2.5">{{ rupeesExact(r.amount) }}</td>
              <td class="px-4 py-2.5 text-sm">{{ r.reason }}@if (r.last_error) {<p class="text-vermilion">{{ r.last_error }}</p>}</td>
              <td class="px-4 py-2.5">{{ r.attempts }}</td>
              <td class="px-4 py-2.5 text-sm">{{ dateTime(r.created_at) }}</td>
              <td class="px-4 py-2.5"><pc-status-pill [status]="r.status" /></td>
              <td class="px-4 py-2.5"><span class="flex gap-1">@if (r.status === "failed") {<button pcButton size="sm" variant="secondary" (click)="retry(r.id)">Retry</button>}@if (r.status === "failed" || r.status === "pending") {<button pcButton size="sm" variant="ghost" (click)="settling.set(r); err.set(null)">Paid by hand</button>}</span></td>
            </tr>
          }
        </pc-table>
      }
      @if (rows()) {<pc-pagination [page]="page()" [pageSize]="50" [total]="total()" (pageChange)="page.set($event)" />}
      <pc-modal [open]="!!settling()" (close)="settling.set(null)" title="Record a refund paid by hand">
        @if (settling(); as s) {
          <div class="flex flex-col gap-3">
            <p class="text-sm text-ink-soft">Use this when you paid {{ rupeesExact(s.amount) }} for order {{ s.order_number }} outside the payment gateway. The gateway is not called again.</p>
            <pc-error-note [message]="err()" />
            <label class="flex flex-col gap-1 text-sm font-medium">How it was paid
              <select pcSelect [value]="method()" (change)="method.set($any($event.target).value)">
                <option value="upi">UPI</option><option value="neft">NEFT</option><option value="imps">IMPS</option><option value="rtgs">RTGS</option><option value="cheque">Cheque</option><option value="other">Other</option>
              </select>
            </label>
            <pc-text-field label="Reference (UTR / UPI ref no.)" [(value)]="reference" [maxlength]="40" />
            <button pcButton (click)="settle()" [disabled]="reference().trim().length < 4">Record refund</button>
          </div>
        }
      </pc-modal>
    </div>
  `,
})
export class AdminRefundsPage {
  private readonly toast = inject(Toast);
  protected readonly rupeesExact = rupeesExact;
  protected readonly dateTime = dateTime;
  protected readonly tabs = [{ value: "failed", label: "Failed" }, { value: "pending", label: "In progress" }, { value: "processed", label: "Completed" }, { value: "", label: "All" }];
  protected readonly status = signal("failed");
  protected readonly rows = signal<Row[] | null>(null);
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly total = signal(0);
  protected readonly settling = signal<Row | null>(null);
  protected readonly method = signal("upi");
  protected readonly reference = signal("");
  protected readonly err = signal<string | null>(null);
  private readonly track = latestOnly();

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const status = this.status(), q = this.q(), page = this.page();
      clearTimeout(t);
      t = setTimeout(() => this.load(status, q, page), q ? 250 : 0);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  private load(status = this.status(), q = this.q(), page = this.page()): Promise<unknown> {
    return this.track(api<{ items: Row[]; total: number }>("/api/admin/refunds", { query: { status: status || undefined, q, page } }), (d) => {
      this.rows.set(d.items);
      this.total.set(d.total);
    });
  }

  protected async settle(): Promise<void> {
    const s = this.settling();
    if (!s) return;
    this.err.set(null);
    try {
      await api(`/api/admin/refunds/${s.id}/settle`, { method: "POST", body: { method: this.method(), reference: this.reference() } });
      this.toast.show("Refund recorded. The customer has been told.");
      this.settling.set(null);
      this.reference.set("");
      void this.load();
    } catch (e) {
      this.err.set(e instanceof ApiError ? e.message : "Could not record it");
    }
  }

  protected async retry(id: string): Promise<void> {
    await api(`/api/admin/refunds/${id}/retry`, { method: "POST" });
    this.toast.show("Refund sent again");
    void this.load();
  }
}
