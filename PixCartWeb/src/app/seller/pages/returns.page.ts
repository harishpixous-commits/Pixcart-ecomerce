/* Returns on the seller's orders: approve or reject, pickup, receive (per item: back in stock or damaged) and refund. Port of frontend/src/app/seller/returns/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from "@angular/core";
import { FileText } from "lucide-angular";
import { ApiError, api, latestOnly } from "../../core/api";
import { dateTime, rupees } from "../../core/format";
import type { ReturnView } from "../../core/types";
import { PageHeader, Tabs } from "../../shared/portal-shell";
import { ExportButton } from "../../shared/portal/export-button";
import { RETURN_STATUS, openPdf } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Modal, ProductImage, StatusPill, TextField, Textarea, Toast } from "../../shared/ui/ui";

type Cond = "sellable" | "damaged";
type D = { items: ReturnView[]; status_counts: Record<string, number> };

const TABS = [["requested", "To review"], ["approved", "Awaiting pickup"], ["picked_up", "In transit"], ["received", "Received"], ["refunded", "Refunded"], ["rejected", "Rejected"], ["", "All"]];

@Component({
  selector: "pc-seller-returns-page",
  imports: [PageHeader, Tabs, ExportButton, Icon, PageLoader, Button, EmptyState, ErrorNote, Modal, ProductImage, StatusPill, TextField, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Returns" sub="Approve returns, arrange the pickup, and mark them received. The refund is issued when you mark a return received." [withActions]="true">
        <pc-export-button actions scope="seller" name="returns" [status]="status() || undefined" />
      </pc-page-header>
      <pc-tabs [value]="status()" (valueChange)="status.set($event)" [items]="tabs()" />
      <pc-error-note [message]="error()" />
      @if (!data()) {
        <pc-page-loader />
      } @else if (data()!.items.length === 0) {
        <pc-empty-state title="No returns here" [hasAction]="false" />
      } @else {
        <div class="flex flex-col gap-3">
          @for (r of data()!.items; track r.id) {
            <section class="rounded-xl bg-white p-4">
              <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p class="font-semibold">{{ r.number }} on order {{ r.sub_order_number }}</p>
                <pc-status-pill [status]="r.status === 'refunded' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending'" [label]="returnStatus[r.status]" />
              </div>
              @for (i of r.items; track $index) {
                <div class="flex items-center gap-3 py-1">
                  <pc-product-image [src]="i.image" alt="" imgClass="h-12 w-12 shrink-0" />
                  <p class="flex-1">
                    {{ i.title }}{{ i.variant_label ? " (" + i.variant_label + ")" : "" }} × {{ i.qty }}
                    @if (i.condition === "damaged") {<span class="ml-2 rounded bg-vermilion-light px-1.5 py-0.5 text-xs font-semibold text-vermilion">Kept out of stock</span>}
                    @if (i.condition === "sellable") {<span class="ml-2 rounded bg-leaf-light px-1.5 py-0.5 text-xs font-semibold text-leaf">Back in stock</span>}
                  </p>
                  <p class="font-semibold">{{ rupees(i.amount) }}</p>
                </div>
              }
              <p class="mt-2 text-ink-soft"><strong>{{ r.reason_label }}.</strong> {{ r.comment }}</p>
              <p class="text-sm text-ink-faint">Requested {{ dateTime(r.created_at) }}</p>
              @if (r.fleet_pickup?.requested) {
                <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-peacock-light/50 p-3 text-sm ring-1 ring-peacock/15" data-testid="seller-return-pickup">
                  <span class="font-semibold text-peacock-dark">Our delivery partner collects this return{{ r.fleet_pickup!.label ? ": " + r.fleet_pickup!.label : "" }}</span>
                  @if (r.fleet_pickup!.partner; as pt) {<span class="text-ink-soft">{{ pt.name }}{{ pt.vehicle_no ? " · " + pt.vehicle_no : "" }}</span>}
                  @if (r.fleet_pickup!.code) {
                    <span class="flex items-center gap-2">
                      <span class="text-ink-soft">Give pickup code</span>
                      <span class="rounded-lg bg-white px-2 py-0.5 font-mono text-lg font-bold tracking-[0.3em] ring-1 ring-line">{{ r.fleet_pickup!.code }}</span>
                      <span class="text-ink-soft">when you receive it</span>
                    </span>
                  }
                </div>
              }
              <div class="mt-3 flex flex-wrap gap-2">
                @if (r.status === "requested") {
                  <button pcButton size="sm" (click)="run(r, 'approve')">Approve return</button>
                  <button pcButton size="sm" variant="danger" (click)="act.set({ r, action: 'reject' })">Reject</button>
                }
                @if (r.status === "approved") {
                  <button pcButton size="sm" variant="secondary" (click)="act.set({ r, action: 'picked_up' })">{{ r.fleet_pickup?.requested ? "Use my own courier instead" : "Pickup booked" }}</button>
                }
                @if (r.status === "approved" || r.status === "picked_up") {
                  <button pcButton size="sm" (click)="startReceive(r)">Mark received and refund</button>
                }
                @if (r.credit_note_number) {
                  <button pcButton size="sm" variant="ghost" (click)="creditNote(r)"><svg [pcIcon]="FileText" class="h-4 w-4" /> Credit note {{ r.credit_note_number }}</button>
                }
              </div>
            </section>
          }
        </div>
      }
      <pc-modal [open]="!!act()" (close)="act.set(null)" [title]="act()?.action === 'reject' ? 'Reject this return' : 'Pickup details'">
        @if (act()?.action === "reject") {
          <div class="flex flex-col gap-3">
            <p class="text-ink-soft">The customer sees your reason and can contact support if they disagree.</p>
            <textarea pcTextarea [value]="note()" (input)="note.set($any($event.target).value)" placeholder="e.g. The item was used and the tags are removed" aria-label="Reason"></textarea>
            <button pcButton variant="buy" [disabled]="note().trim().length < 10" (click)="run(act()!.r, 'reject', { note: note() })">Reject return</button>
          </div>
        } @else if (act()) {
          <div class="flex flex-col gap-3">
            <pc-text-field label="Courier" [(value)]="courier" />
            <pc-text-field label="Pickup tracking number" [(value)]="tracking" />
            <button pcButton (click)="run(act()!.r, 'picked_up', { courier: courier(), tracking: tracking() })">Save</button>
          </div>
        }
      </pc-modal>
      <pc-modal [open]="!!receive()" (close)="receive.set(null)" title="Mark this return received">
        @if (receive(); as rc) {
          <div class="flex flex-col gap-3" data-testid="receive-return">
            <pc-error-note [message]="error()" />
            <p class="text-ink-soft">Check each item. The customer is refunded {{ rupees(rc.r.refund_amount) }} either way.</p>
            @for (i of rc.r.items; track $index) {
              @if (i.order_item_id) {
                <fieldset class="rounded-xl border border-line p-3">
                  <legend class="px-1 text-sm font-semibold">{{ i.title }}{{ i.variant_label ? " (" + i.variant_label + ")" : "" }} × {{ i.qty }}</legend>
                  @for (c of conds; track c) {
                    <label class="flex items-start gap-2 py-1 text-sm">
                      <input type="radio" class="mt-0.5 h-4 w-4 accent-peacock" [name]="'cond-' + i.order_item_id" [checked]="rc.conditions[i.order_item_id] === c"
                        (change)="setCond(i.order_item_id, c)" />
                      <span>{{ c === "sellable" ? "Good: put it back in stock for sale" : "Damaged, used or not the item ordered: keep it out of stock" }}</span>
                    </label>
                  }
                </fieldset>
              }
            }
            <button pcButton (click)="received(rc)">Mark received and refund</button>
          </div>
        }
      </pc-modal>
    </div>
  `,
})
export class SellerReturnsPage {
  private readonly toast = inject(Toast);
  protected readonly FileText = FileText;
  protected readonly returnStatus = RETURN_STATUS;
  protected readonly rupees = rupees;
  protected readonly dateTime = dateTime;
  protected readonly conds: Cond[] = ["sellable", "damaged"];
  protected readonly status = signal("requested");
  protected readonly data = signal<D | null>(null);
  protected readonly act = signal<{ r: ReturnView; action: "reject" | "picked_up" } | null>(null);
  // receiving a return: each item back in sellable stock, or damaged and kept out of stock
  protected readonly receive = signal<{ r: ReturnView; conditions: Record<string, Cond> } | null>(null);
  protected readonly note = signal("");
  protected readonly courier = signal("");
  protected readonly tracking = signal("");
  protected readonly error = signal<string | null>(null);
  // Reloads always use the tab that is open now, even if it changed while an action was running.
  private readonly refresh = signal(0);
  private readonly track = latestOnly();
  protected readonly tabs = computed(() => {
    const c = this.data()?.status_counts ?? {};
    return TABS.map(([v, l]) => ({ value: v, label: l, count: v ? c[v] ?? 0 : undefined }));
  });

  constructor() {
    effect(() => {
      const status = this.status();
      this.refresh();
      untracked(() => void this.track(api<D>("/api/seller/returns", { query: { status: status || undefined } }), (d) => this.data.set(d)));
    });
  }

  protected async run(r: ReturnView, action: string, body: object = {}): Promise<void> {
    this.error.set(null);
    try {
      await api(`/api/seller/returns/${r.id}`, { method: "POST", body: { action, ...body } });
      this.toast.show("Return updated");
      this.act.set(null);
      this.receive.set(null);
      this.note.set("");
      this.refresh.update((n) => n + 1);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not update");
    }
  }

  protected startReceive(r: ReturnView): void {
    this.receive.set({ r, conditions: Object.fromEntries(r.items.filter((i) => i.order_item_id).map((i) => [i.order_item_id!, i.suggested_condition ?? "sellable"])) });
  }

  protected setCond(id: string, c: Cond): void {
    const rc = this.receive();
    if (rc) this.receive.set({ ...rc, conditions: { ...rc.conditions, [id]: c } });
  }

  protected received(rc: { r: ReturnView; conditions: Record<string, Cond> }): void {
    void this.run(rc.r, "received", { items: Object.entries(rc.conditions).map(([order_item_id, condition]) => ({ order_item_id, condition })) });
  }

  protected creditNote(r: ReturnView): void {
    void openPdf(`/api/seller/returns/${r.id}/credit-note.pdf`, (m) => this.toast.show(m, "error"));
  }
}
