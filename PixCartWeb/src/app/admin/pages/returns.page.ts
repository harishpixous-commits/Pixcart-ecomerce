/* Admin → Returns: step in on returns, settle disputes, record UPI refunds for COD returns. Port of frontend/src/app/admin/returns/page.tsx. */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { AdminContext } from "../../core/admin";
import { api, ApiError, latestOnly } from "../../core/api";
import { dateTime, rupees } from "../../core/format";
import type { ReturnView } from "../../core/types";
import { ExportButton } from "../../shared/portal/export-button";
import { RETURN_STATUS } from "../../shared/portal/helpers";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Input, Modal, Pagination, ProductImage, StatusPill, Textarea, TextField, Toast } from "../../shared/ui/ui";
import { searchParam } from "../shared/admin-helpers";

type AR = Omit<ReturnView, "refund_upi"> & { refund_upi?: string | null; seller_name?: string; payment_method?: string };
type D = { items: AR[]; status_counts: Record<string, number>; total: number; page: number; page_size: number };
type Act = { r: AR; action: "reject" | "mark_refunded" };

const TABS = [["requested", "Waiting for seller"], ["approved", "Approved"], ["picked_up", "Picked up"], ["received", "Received, refund due"], ["refunded", "Refunded"], ["rejected", "Rejected"], ["", "All"]];

@Component({
  selector: "pc-admin-returns-page",
  imports: [PageHeader, Tabs, ExportButton, PcLink, PageLoader, Button, EmptyState, ErrorNote, Input, Modal, Pagination, ProductImage, StatusPill, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Returns" sub="Step in when a seller doesn't respond, settle disputes, and record UPI refunds for cash-on-delivery returns. To open a return for a customer, use Open a return on their order." [withActions]="true">
        <pc-export-button actions scope="admin" name="returns" [status]="status() || undefined" />
      </pc-page-header>
      <pc-tabs [value]="status()" (valueChange)="status.set($event); page.set(1)" [items]="tabs()" />
      <input pcInput placeholder="Return or package number, customer name or mobile" [value]="q()" (input)="q.set($any($event.target).value); page.set(1)" class="mb-3 max-w-sm" aria-label="Search returns" />
      @if (!canAct()) {<p class="mb-3 rounded-lg bg-mist p-3 text-sm text-ink-soft">You can see returns. Approving, rejecting and recording refunds needs the Refunds permission.</p>}
      <pc-error-note [message]="error()" />
      @if (!d()) {
        <pc-page-loader />
      } @else if (d()!.items.length === 0) {
        <pc-empty-state title="No returns here" [hasAction]="false" />
      } @else {
        <div class="flex flex-col gap-3">
          @for (r of d()!.items; track r.id) {
            <section class="rounded-xl bg-white p-4">
              <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p class="font-semibold">{{ r.number }} on <a [pcLink]="'/admin/orders/' + r.order_id" class="text-peacock hover:underline">{{ r.sub_order_number }}</a>{{ r.seller_name ? ", " + r.seller_name : "" }}</p>
                <pc-status-pill [status]="r.status === 'refunded' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending'" [label]="returnStatus[r.status]" />
              </div>
              @for (i of r.items; track $index) {
                <div class="flex items-center gap-3 py-1">
                  <pc-product-image [src]="i.image" alt="" imgClass="h-10 w-10 shrink-0" />
                  <p class="flex-1 text-sm">{{ i.title }} × {{ i.qty }}</p>
                  <p class="text-sm font-semibold">{{ rupees(i.amount) }}</p>
                </div>
              }
              <p class="text-ink-soft"><strong>{{ r.reason_label }}.</strong> {{ r.comment }}</p>
              <p class="text-sm text-ink-faint">Requested {{ dateTime(r.created_at) }}{{ r.refund_upi ? ". Refund to UPI " + r.refund_upi : "" }}</p>
              @if (canAct()) {
                <div class="mt-2 flex flex-wrap gap-2">
                  @if (r.status === "requested") {
                    <button pcButton size="sm" (click)="run(r, 'approve')">Approve</button><button pcButton size="sm" variant="danger" (click)="act.set({ r, action: 'reject' })">Reject</button>
                  }
                  @if (r.status === "approved" || r.status === "picked_up") {<button pcButton size="sm" (click)="run(r, 'received')">Mark received</button>}
                  @if (r.status === "received") {<button pcButton size="sm" (click)="act.set({ r, action: 'mark_refunded' })">Record UPI refund</button>}
                </div>
              }
            </section>
          }
          <pc-pagination [page]="d()!.page" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />
        </div>
      }
      <pc-modal [open]="!!act()" (close)="act.set(null)" [title]="act()?.action === 'reject' ? 'Reject return' : 'Record refund'">
        @if (act(); as a) {
          <div class="flex flex-col gap-3">
            @if (a.action === "reject") {
              <textarea pcTextarea [value]="text()" (input)="text.set($any($event.target).value)" placeholder="Reason the customer will see" aria-label="Reason"></textarea>
            } @else {
              <p class="text-ink-soft">Pay {{ rupees(a.r.refund_amount) }} to UPI {{ a.r.refund_upi ?? "(not given)" }}, then enter the UPI reference number.</p>
              <pc-text-field label="UPI / bank reference" [(value)]="text" />
            }
            <button pcButton (click)="run(a.r, a.action, a.action === 'reject' ? { note: text() } : { reference: text() })" [disabled]="text().trim().length < 4">Save</button>
          </div>
        }
      </pc-modal>
    </div>
  `,
})
export class AdminReturnsPage {
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly rupees = rupees;
  protected readonly dateTime = dateTime;
  protected readonly returnStatus = RETURN_STATUS;
  private readonly sellerParam = searchParam("seller_id");
  protected readonly canAct = computed(() => this.admin.can("refunds"));
  protected readonly status = signal("requested");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly d = signal<D | null>(null);
  protected readonly act = signal<Act | null>(null);
  protected readonly text = signal("");
  protected readonly error = signal<string | null>(null);
  private readonly refresh = signal(0);
  private readonly track = latestOnly();
  protected readonly tabs = computed(() => {
    const c = this.d()?.status_counts ?? {};
    return TABS.map(([v, l]) => ({ value: v, label: l, count: v ? c[v] ?? 0 : undefined }));
  });

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    // Reloads always use the tab that is open now, even if it changed while an action was running.
    effect(() => {
      const status = this.status(), q = this.q(), page = this.page(), seller_id = this.sellerParam() ?? undefined;
      this.refresh();
      clearTimeout(t);
      t = setTimeout(() => void this.track(api<D>("/api/admin/returns", { query: { status: status || undefined, q, page, seller_id } }), (x) => this.d.set(x)), q ? 250 : 0);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  protected async run(r: AR, action: string, extra: object = {}): Promise<void> {
    this.error.set(null);
    try {
      await api(`/api/admin/returns/${r.id}`, { method: "POST", body: { action, ...extra } });
      this.toast.show("Return updated");
      this.act.set(null);
      this.text.set("");
      this.refresh.update((n) => n + 1);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not update");
    }
  }
}
