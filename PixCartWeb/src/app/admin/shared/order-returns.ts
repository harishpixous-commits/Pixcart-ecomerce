/*
 * "Open a return for the customer" on Admin → order (staff open a return on the customer's behalf, by the shop's rules).
 * Port of ReturnRequestModal in components/order-returns.tsx; the same component as shop/customer/order-returns.ts on the
 * shop customer pages branch (copied from it): keep one after merging.
 *   <pc-return-request-modal [subId] [items] [needsUpi] [open] (closed) (done) [staff] />
 */

import { ChangeDetectionStrategy, Component, booleanAttribute, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { ApiError, api, quietly } from "../../core/api";
import { date, rupees } from "../../core/format";
import type { ReturnableItem } from "../../core/types";
import { Button, ErrorNote, Field, Modal, ProductImage, Select, TextField, Textarea, Toast } from "../../shared/ui/ui";

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
        @if (needsUpi()) {
          <pc-text-field [label]="copy().upi" [value]="upi()" [filter]="trim" (valueChange)="upi.set($event)" placeholder="yourname@okbank" [hint]="copy().upiHint" />
        }
        <div class="flex items-center justify-between gap-3 border-t border-line pt-3">
          <p>Refund: <span class="font-display text-lg font-bold">{{ fmt(refund()) }}</span></p>
          <button pcButton (click)="submit()" [loading]="busy()" [disabled]="!chosen().length || !why() || (needsUpi() && !upi())">{{ copy().submit }}</button>
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

  constructor() {
    effect(() => {
      if (this.open()) untracked(() => api<{ reasons: Reason[] }>("/api/returns/reasons").then((r) => this.reasons.set(r.reasons)).catch(quietly));
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
        body: { sub_order_id: this.subId(), items: this.chosen().map((i) => ({ order_item_id: i.order_item_id, qty: qty[i.order_item_id] })), reason: this.why(), comment: this.comment(), refund_upi: this.upi() },
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
