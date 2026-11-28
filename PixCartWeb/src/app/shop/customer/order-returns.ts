/*
 * Returns on the shopper's order page: the "Return items" dialog and the list of returns with their status, credit note,
 * "Cancel return" and the pickup by our delivery partner. Port of components/order-returns.tsx:
 *   <pc-return-request-modal [subId] [items] [needsUpi] [open] (closed) (done) [staff] />
 *   <pc-returns-list [returns] (cancelReturn)="..." />
 */

import { ChangeDetectionStrategy, Component, booleanAttribute, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { FileText } from "lucide-angular";
import { ApiError, api, quietly, uploadWithProgress } from "../../core/api";
import { date, rupees } from "../../core/format";
import type { ReturnView, ReturnableItem } from "../../core/types";
import { RETURN_STATUS, openPdf } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { Button, ErrorNote, Field, Modal, ProductImage, Select, StatusPill, TextField, Textarea, Toast } from "../../shared/ui/ui";

// The customer asks for a return themselves; staff (Admin → order) open one on the customer's behalf, by the same rules.
const REQUEST_COPY = {
  customer: {
    path: "/api/returns", title: "Return items", why: "Why are you returning?", upi: "UPI ID for your refund",
    upiHint: "You paid cash on delivery, so we send the refund to this UPI ID", submit: "Request return", done: "Return requested", failed: "Could not request the return",
  },
  staff: {
    path: "/api/admin/returns", title: "Open a return for the customer", why: "Why is the customer returning?", upi: "Customer's UPI ID for the refund",
    upiHint: "They paid cash on delivery, so the refund goes to this UPI ID", submit: "Open return", done: "Return opened", failed: "Could not open the return",
  },
};

type Reason = { code: string; label: string; defect: boolean };

@Component({
  selector: "pc-return-request-modal",
  imports: [Button, ErrorNote, Field, Modal, ProductImage, Select, TextField, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="open()" (close)="closed.emit()" [title]="copy().title" [wide]="true">
      <div class="flex flex-col gap-4">
        <pc-error-note [message]="error()" />
        <div class="flex flex-col gap-3">
          @for (i of items(); track i.order_item_id) {
            <div class="flex items-center gap-3">
              <pc-product-image [src]="i.image" alt="" imgClass="h-14 w-14 shrink-0" />
              <div class="flex-1">
                <p class="font-medium">{{ i.title }}</p>
                <p class="text-sm text-ink-faint">{{ itemNote(i) }}</p>
              </div>
              <select pcSelect [attr.aria-label]="'Quantity to return of ' + i.title" [disabled]="!i.eligible" (change)="setQty(i.order_item_id, $any($event.target).value)" class="h-9 w-20">
                @for (n of range(i.qty_left + 1); track n) {<option [value]="n" [selected]="(qty()[i.order_item_id] ?? 0) === n">{{ n }}</option>}
              </select>
            </div>
          }
        </div>
        <pc-field [label]="copy().why" for="rr" [hint]="defectsOnly() ? 'Some items you chose can be returned only for these reasons' : undefined">
          <select pcSelect id="rr" (change)="reason.set($any($event.target).value)">
            <option value="" [selected]="why() === ''">Choose a reason</option>
            @for (r of allowed(); track r.code) {<option [value]="r.code" [selected]="why() === r.code">{{ r.label }}</option>}
          </select>
        </pc-field>
        <pc-field label="More details (optional)" for="rc"><textarea pcTextarea id="rc" [value]="comment()" (input)="comment.set($any($event.target).value)" maxlength="2000" rows="3"></textarea></pc-field>
        @if (showPhotos()) {
          <pc-field [label]="photoCfg().required_for_defects ? 'Photos of the problem (needed for damaged or faulty items)' : 'Photos (optional)'" for="rp" [hint]="'Up to ' + photoCfg().max + ' photos'">
            <div class="flex flex-wrap items-center gap-2" data-testid="return-photos">
              @for (u of photos(); track u) {
                <span class="relative">
                  <img [src]="u" alt="Return photo" class="h-16 w-16 rounded-lg border border-line object-cover" />
                  <button type="button" aria-label="Remove photo" class="absolute -right-1 -top-1 rounded-full bg-white px-1 text-xs shadow" (click)="removePhoto(u)">×</button>
                </span>
              }
              @if (photos().length < photoCfg().max) {
                <input id="rp" type="file" accept="image/*" [disabled]="uploading()" (change)="addPhoto($event)" class="text-sm" />
              }
            </div>
          </pc-field>
        }
        @if (needsUpi()) {
          <pc-text-field [label]="copy().upi" [value]="upi()" [filter]="trim" (valueChange)="upi.set($event)" placeholder="yourname@okbank" [hint]="copy().upiHint" />
        }
        <div class="flex items-center justify-between gap-3 border-t border-line pt-3">
          <p>Refund: <span class="font-display text-lg font-bold">{{ fmt(refund()) }}</span></p>
          <button pcButton (click)="submit()" [loading]="busy()" [disabled]="!chosen().length || !why() || (needsUpi() && !upi()) || photoNeeded() || uploading()">{{ copy().submit }}</button>
        </div>
      </div>
    </pc-modal>
  `,
})
export class ReturnRequestModal {
  readonly subId = input.required<string>();
  readonly items = input.required<ReturnableItem[]>();
  readonly needsUpi = input(false);
  readonly open = input(false, { transform: booleanAttribute });
  readonly staff = input(false, { transform: booleanAttribute });
  readonly closed = output<void>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly copy = computed(() => REQUEST_COPY[this.staff() ? "staff" : "customer"]);
  protected readonly reasons = signal<Reason[]>([]);
  protected readonly qty = signal<Record<string, number | undefined>>({});
  protected readonly reason = signal("");
  protected readonly comment = signal("");
  protected readonly upi = signal("");
  protected readonly photoCfg = signal<{ enabled: boolean; required_for_defects: boolean; max: number }>({ enabled: false, required_for_defects: false, max: 3 });
  protected readonly photos = signal<string[]>([]);
  protected readonly uploading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly fmt = rupees;
  protected readonly trim = (v: string) => v.trim();
  protected readonly range = (n: number) => Array.from({ length: n }, (_, i) => i);

  protected readonly chosen = computed(() => this.items().filter((i) => (this.qty()[i.order_item_id] ?? 0) > 0));
  protected readonly refund = computed(() => this.chosen().reduce((n, i) => n + i.unit_refund * (this.qty()[i.order_item_id] ?? 0), 0));
  // an item past its own return window comes back only if it arrived damaged, faulty, wrong or incomplete
  protected readonly defectsOnly = computed(() => this.chosen().some((i) => i.defects_only));
  protected readonly allowed = computed(() => (this.defectsOnly() ? this.reasons().filter((r) => r.defect) : this.reasons()));
  protected readonly why = computed(() => (this.allowed().some((r) => r.code === this.reason()) ? this.reason() : ""));

  protected readonly showPhotos = computed(() => !this.staff() && this.photoCfg().enabled);
  protected readonly photoNeeded = computed(() => this.showPhotos() && this.photoCfg().required_for_defects && !!this.allowed().find((r) => r.code === this.why())?.defect && this.photos().length === 0);

  protected async addPhoto(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this.uploading.set(true);
    this.error.set(null);
    try {
      const up = await uploadWithProgress<{ url: string }>("/api/returns/photos", file, () => {});
      this.photos.update((p) => [...p, up.url]);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not upload the photo");
    } finally {
      this.uploading.set(false);
    }
  }

  protected removePhoto(u: string): void {
    this.photos.update((p) => p.filter((x) => x !== u));
  }

  constructor() {
    effect(() => {
      if (this.open()) untracked(() => api<{ reasons: Reason[]; photos?: { enabled: boolean; required_for_defects: boolean; max: number } }>("/api/returns/reasons").then((r) => { this.reasons.set(r.reasons); if (r.photos) this.photoCfg.set(r.photos); }).catch(quietly));
    });
  }

  protected itemNote(i: ReturnableItem): string {
    return !i.eligible
      ? "Return window closed or not returnable"
      : `${i.defects_only ? "Only if it arrived damaged, faulty, wrong or incomplete: return" : "Return"} by ${date(i.return_by)}, refund ${rupees(i.unit_refund)} each`;
  }

  protected setQty(id: string, v: string): void {
    this.qty.update((q) => ({ ...q, [id]: Number(v) }));
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const qty = this.qty();
      await api(this.copy().path, {
        method: "POST",
        body: { sub_order_id: this.subId(), items: this.chosen().map((i) => ({ order_item_id: i.order_item_id, qty: qty[i.order_item_id] })), reason: this.why(), comment: this.comment(), refund_upi: this.upi(), ...(this.showPhotos() ? { photos: this.photos() } : {}) },
      });
      this.toast.show(this.copy().done);
      this.done.emit();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : this.copy().failed);
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-returns-list",
  imports: [Icon, Button, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (returns().length) {
      <section class="rounded-xl bg-white p-4">
        <h2 class="mb-2 text-lg font-semibold">Returns</h2>
        <ul class="divide-y divide-line">
          @for (r of returns(); track r.id) {
            <li class="flex flex-wrap items-start justify-between gap-3 py-3">
              <div>
                <p class="font-semibold">{{ r.number }}: {{ itemsText(r) }}</p>
                <p class="text-sm text-ink-soft">{{ r.reason_label }}. Refund {{ fmt(r.refund_amount) }}{{ r.refund_upi ? " to " + r.refund_upi : "" }}.</p>
                @if (r.seller_note) {<p class="text-sm text-ink-soft">Seller: {{ r.seller_note }}</p>}
                @if (r.pickup_tracking) {<p class="text-sm text-ink-soft">Pickup: {{ r.pickup_courier }} {{ r.pickup_tracking }}</p>}
                @if (r.fleet_pickup?.requested) {
                  @let f = r.fleet_pickup!;
                  <div class="mt-2 flex flex-col gap-1.5 rounded-xl bg-peacock-light/50 p-3 text-sm ring-1 ring-peacock/15" data-testid="return-fleet-pickup">
                    <p class="font-semibold text-peacock-dark">Pickup by our delivery partner{{ f.label ? ": " + f.label : "" }}</p>
                    @if (f.partner; as p) {
                      <p class="text-ink-soft">{{ p.name }}{{ p.vehicle_no ? " · " + p.vehicle_no : "" }}@if (p.phone) { · <a [href]="'tel:' + p.phone" class="font-semibold text-peacock">Call</a>}</p>
                    }
                    @if (f.status === "failed" && f.fail_reason) {<p class="text-vermilion">Last try: {{ f.fail_reason }}. We will arrange another pickup.</p>}
                    @if (f.code) {
                      <p class="flex items-center gap-2">
                        <span class="text-ink-soft">Pickup code</span>
                        <span class="rounded-lg bg-white px-2 py-0.5 font-mono text-lg font-bold tracking-[0.3em] ring-1 ring-line" data-testid="return-pickup-code">{{ f.code }}</span>
                        <span class="text-xs text-ink-faint">Give it to the partner only when you hand over the item.</span>
                      </p>
                    }
                  </div>
                }
              </div>
              <div class="flex flex-col items-end gap-1">
                <pc-status-pill [status]="pillStatus(r)" [label]="RETURN_STATUS[r.status]" />
                @if (r.credit_note_number) {
                  <button class="inline-flex items-center gap-1 text-sm font-semibold text-peacock" (click)="creditNote(r.id)"><svg [pcIcon]="FileText" class="h-4 w-4" /> Credit note</button>
                }
                @if (r.status === "requested" || r.status === "approved") {<button pcButton size="sm" variant="ghost" (click)="cancelReturn.emit(r.id)">Cancel return</button>}
              </div>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class ReturnsList {
  readonly returns = input.required<ReturnView[]>();
  readonly cancelReturn = output<string>();
  private readonly toast = inject(Toast);
  protected readonly fmt = rupees;
  protected readonly RETURN_STATUS = RETURN_STATUS;
  protected readonly FileText = FileText;
  protected readonly itemsText = (r: ReturnView) => r.items.map((i) => `${i.title} × ${i.qty}`).join(", ");
  protected readonly pillStatus = (r: ReturnView) =>
    r.status === "refunded" ? "approved" : r.status === "rejected" ? "rejected" : r.status === "cancelled" ? "cancelled" : "pending";

  protected creditNote(id: string): void {
    void openPdf(`/api/credit-notes/${id}.pdf`, (m) => this.toast.show(m, "error"));
  }
}
