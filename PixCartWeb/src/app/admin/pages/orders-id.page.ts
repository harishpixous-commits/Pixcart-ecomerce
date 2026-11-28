/*
 * Admin → one order: risk brief, message the customer (AI draft), customer / ship-to / totals and the fee invoice,
 * the online payment check with Razorpay, each package with its actions (mark delivered, cancel and refund, open a
 * return), the own delivery fleet line, refunds (retry) and the timeline.
 * Port of frontend/src/app/admin/orders/[id]/page.tsx with its local message.tsx and payment-check.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { Bike, CheckCircle2, ChevronRight, CreditCard, RefreshCw } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, quietly } from "../../core/api";
import { dateTime, PAYMENT_STATUS_LABEL, rupeesExact, SUB_STATUS_LABEL } from "../../core/format";
import type { OrderDetail, ReturnableItem } from "../../core/types";
import { PageHeader } from "../../shared/portal-shell";
import { AiBadge, AiDraftButton, type AiRun } from "../../shared/portal/ai";
import { openPdf } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Modal, StatusPill, Textarea, TextField, Toast } from "../../shared/ui/ui";
import { RiskBrief } from "../shared/ai";
import { ReturnRequestModal } from "../../shop/customer/order-returns";

/** The own delivery fleet on one package, as the admin order API sends it (lib/types FleetTracking). */
type Fleet = {
  ready_for_pickup_at: string | null;
  assignment: { id: string; status: string; status_label: string } | null;
  partner: { name: string; vehicle_no: string } | null;
};

/* ---------------------------------------------------------------- message.tsx */

/** Message the customer about this order: AI writes a draft, staff edit and send it (in-app and email). */
@Component({
  selector: "pc-customer-message",
  imports: [AiBadge, AiDraftButton, Button, ErrorNote, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (allowed()) {
      <section class="flex flex-col gap-2 rounded-xl bg-white p-4">
        <h2 class="font-semibold">Message the customer</h2>
        @if (!run()) {
          <p class="text-sm text-ink-soft">Write an update about this order. It is sent in the app and by email.</p>
          <pc-ai-draft-button base="/api/admin/ai" task="customer_message" [subjectId]="orderId()" [withIntent]="true" [requireIntent]="true" intentLabel="What should the message tell them?" label="Write message with AI"
            (draft)="useDraft($event)" />
        } @else {
          <div class="flex items-center gap-2"><pc-ai-badge [mode]="run()!.mode" /><span class="text-xs text-ink-faint">Check every detail before sending.</span></div>
          <pc-text-field label="Subject" [value]="subject()" [maxlength]="150" (valueChange)="subject.set($event)" />
          <textarea pcTextarea rows="6" maxlength="2000" [value]="text()" (input)="text.set($any($event.target).value)" aria-label="Message"></textarea>
          <pc-error-note [message]="error()" />
          <div class="flex gap-2">
            <button pcButton (click)="send()" [loading]="busy()" [disabled]="subject().trim().length < 3 || text().trim().length < 10">Send to customer</button>
            <button pcButton variant="ghost" (click)="discard()">Discard</button>
          </div>
        }
      </section>
    }
  `,
})
export class CustomerMessage {
  readonly orderId = input.required<string>();
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly allowed = computed(() => !!this.admin.me()?.permissions.includes("orders"));
  protected readonly run = signal<AiRun | null>(null);
  protected readonly subject = signal("");
  protected readonly text = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected useDraft(r: AiRun): void {
    this.run.set(r);
    this.subject.set(r.output.subject ?? "About your order");
    this.text.set(r.output.text ?? "");
  }

  protected async send(): Promise<void> {
    const run = this.run();
    if (!run) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/admin/ai/runs/${run.id}/send`, { method: "POST", body: { subject: this.subject(), text: this.text() } });
      this.toast.show("Message sent to the customer");
      this.run.set(null);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not send");
    } finally {
      this.busy.set(false);
    }
  }

  protected async discard(): Promise<void> {
    const run = this.run();
    if (run) await api(`/api/admin/ai/runs/${run.id}/discard`, { method: "POST", body: {} }).catch(() => {});
    this.run.set(null);
  }
}

/* ---------------------------------------------------------------- notes */

type StaffNote = { id: string; note: string; author: string; at: string };

/** Private staff notes on this order. The customer and the seller never see them. */
@Component({
  selector: "pc-staff-notes",
  imports: [Button, ErrorNote, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (allowed()) {
      <section class="rounded-xl bg-white p-4">
        <h2 class="mb-1 font-semibold">Staff notes</h2>
        <p class="mb-2 text-sm text-ink-soft">Only staff see these. They are never shown to the customer or the seller.</p>
        <ul class="mb-2 flex flex-col gap-1 text-sm">
          @for (n of items(); track n.id) {
            <li><span class="text-ink-faint">{{ when(n.at) }} · {{ n.author }}</span> {{ n.note }}</li>
          } @empty {
            <li class="text-ink-faint">No notes yet.</li>
          }
        </ul>
        <textarea pcTextarea rows="3" maxlength="1000" [value]="text()" (input)="text.set($any($event.target).value)" placeholder="Add a note" aria-label="Staff note"></textarea>
        <pc-error-note [message]="error()" />
        <button pcButton class="mt-2" (click)="add()" [loading]="busy()" [disabled]="text().trim().length === 0">Add note</button>
      </section>
    }
  `,
})
export class StaffNotes {
  readonly orderId = input.required<string>();
  private readonly admin = inject(AdminContext);
  protected readonly allowed = computed(() => !!this.admin.me()?.permissions.includes("orders"));
  protected readonly items = signal<StaffNote[]>([]);
  protected readonly text = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly when = dateTime;

  constructor() {
    effect(() => {
      const id = this.orderId();
      if (this.allowed()) untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    try {
      this.items.set((await api<{ items: StaffNote[] }>(`/api/admin/orders/${id}/notes`)).items);
    } catch {
      /* the list stays as it was */
    }
  }

  protected async add(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/admin/orders/${this.orderId()}/notes`, { method: "POST", body: { note: this.text() } });
      this.text.set("");
      await this.load(this.orderId());
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save the note");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- payment-check.tsx */

type Attempt = { id: string; status: string; method: string; error: string };
type Reply = { result: string; attempts?: Attempt[]; waiting?: boolean; reason?: string; payment?: { id: string; method: string } };

const RESULT: Record<string, string | undefined> = {
  already_paid: "Already paid. Nothing to change.",
  already: "Already paid. Nothing to change.",
  paid: "Razorpay has the payment. The order is now paid and sent to the seller.",
  refund: "This was a second payment for an order already paid. It is being refunded to the shopper.",
  not_paid: "Razorpay has no successful payment for this order yet.",
};

/*
 * The online payment as Razorpay recorded it, and "Check payment with Razorpay" for an order still waiting for payment
 * when the shopper says they paid (their phone lost the confirmation and no webhook arrived). The server asks Razorpay;
 * a payment it captured is recorded exactly as the webhook would record it.
 */
@Component({
  selector: "pc-payment-check",
  imports: [Icon, Button, StatusPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="rounded-xl bg-white p-4" data-testid="payment-check" aria-labelledby="pay-h">
      <div class="flex flex-wrap items-center gap-3">
        <h2 id="pay-h" class="flex items-center gap-2 font-semibold"><svg [pcIcon]="I.CreditCard" class="h-4 w-4 text-peacock" aria-hidden="true" /> Online payment</h2>
        <pc-status-pill [status]="order().payment_status" [label]="payLabel[order().payment_status]" />
        <button pcButton size="sm" variant="secondary" class="ml-auto" [loading]="busy()" (click)="check()">
          <svg [pcIcon]="I.RefreshCw" class="h-4 w-4" aria-hidden="true" /> Check payment with Razorpay
        </button>
      </div>
      @if (order().paid; as paid) {
        <p class="mt-2 flex items-start gap-2 text-sm">
          <svg [pcIcon]="I.CheckCircle2" class="mt-0.5 h-4 w-4 shrink-0 text-leaf" aria-hidden="true" />
          <span class="min-w-0 break-words">
            Received {{ rupeesExact(paid.amount) }}{{ paid.method ? " by " + paid.method : "" }}@if (paid.reference) {, Razorpay reference <span class="font-mono font-semibold">{{ paid.reference }}</span>}@if (paid.at) {, {{ dateTime(paid.at) }}}
          </span>
        </p>
      } @else if (order().status === "pending_payment") {
        <p class="mt-2 text-sm text-ink-soft">
          Waiting for payment{{ order().payment_expires_at ? " until " + dateTime(order().payment_expires_at) : "" }}. If the shopper says they paid, check with Razorpay.
        </p>
      }
      @if (error()) {<p role="alert" class="mt-2 text-sm text-vermilion">{{ error() }}</p>}
      @if (reply(); as r) {
        <div role="status" class="mt-2 rounded-lg bg-mist p-3 text-sm">
          <p class="font-medium">{{ r.waiting ? "A UPI request is still open: the shopper has not approved it yet." : result[r.result] ?? r.result }}</p>
          @if (r.reason) {<p class="text-ink-soft">Last attempt: {{ r.reason }}</p>}
          @if (r.attempts?.length) {
            <ul class="mt-1 space-y-0.5 text-xs text-ink-soft">
              @for (a of r.attempts!; track a.id) {
                <li class="break-words">
                  <span class="font-mono">{{ a.id }}</span>: {{ a.status }}{{ a.method ? ", " + a.method : "" }}{{ a.error ? ", " + a.error : "" }}
                </li>
              }
            </ul>
          }
        </div>
      }
    </section>
  `,
})
export class PaymentCheck {
  readonly order = input.required<OrderDetail>();
  readonly checked = output<void>();
  protected readonly I = { CreditCard, RefreshCw, CheckCircle2 };
  protected readonly payLabel = PAYMENT_STATUS_LABEL;
  protected readonly result = RESULT;
  protected readonly rupeesExact = rupeesExact;
  protected readonly dateTime = dateTime;
  protected readonly busy = signal(false);
  protected readonly reply = signal<Reply | null>(null);
  protected readonly error = signal<string | null>(null);

  protected async check(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<Reply>(`/api/admin/orders/${this.order().id}/check-payment`, { method: "POST" });
      this.reply.set(r);
      this.checked.emit();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not check with Razorpay");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- FleetLine */

/** Own delivery fleet on the admin order: the step, the partner, and a link to the trip (or the assignment queue). */
@Component({
  selector: "pc-fleet-line",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-peacock-light/50 px-3 py-2 text-sm" data-testid="admin-order-fleet">
      <svg [pcIcon]="I.Bike" class="h-4 w-4 shrink-0 text-peacock" aria-hidden="true" />
      <span class="font-semibold">Own delivery partner:</span>
      @if (f().assignment; as a) {
        <span>{{ a.status_label }}</span>
        @if (f().partner; as p) {<span class="text-ink-soft">· {{ p.name }}{{ p.vehicle_no ? ", " + p.vehicle_no : "" }}</span>}
        <a [pcLink]="'/admin/delivery/trips/' + a.id" class="ml-auto inline-flex items-center gap-0.5 font-semibold text-peacock">Open trip <svg [pcIcon]="I.ChevronRight" class="h-4 w-4" aria-hidden="true" /></a>
      } @else if (f().ready_for_pickup_at) {
        <span>Ready for pickup, waiting for a partner</span>
        <a pcLink="/admin/delivery/queue" class="ml-auto inline-flex items-center gap-0.5 font-semibold text-peacock">Assign <svg [pcIcon]="I.ChevronRight" class="h-4 w-4" aria-hidden="true" /></a>
      } @else {
        <span>the seller has not handed it over yet</span>
      }
    </div>
  `,
})
export class FleetLine {
  readonly f = input.required<Fleet>();
  protected readonly I = { Bike, ChevronRight };
}

/* ---------------------------------------------------------------- page */

@Component({
  selector: "pc-admin-orders-id-page",
  imports: [PageHeader, PageLoader, Button, ErrorNote, Modal, StatusPill, Textarea, RiskBrief, ReturnRequestModal, CustomerMessage, StaffNotes, PaymentCheck, FleetLine],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!o()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <div class="flex flex-col gap-4">
        <pc-page-header [back]="{ href: '/admin/orders', label: 'Orders' }" [title]="'Order ' + o()!.number" [sub]="sub()" />
        <pc-error-note [message]="error()" />
        <div class="grid gap-4 lg:grid-cols-2">
          <pc-risk-brief [path]="'/api/admin/ai/briefs/order/' + o()!.id" title="Order risk" />
          <pc-customer-message [orderId]="o()!.id" />
          <pc-staff-notes [orderId]="o()!.id" />
        </div>
        <div class="grid gap-4 lg:grid-cols-3">
          <section class="rounded-xl bg-white p-4"><h2 class="mb-1 font-semibold">Customer</h2><p>{{ o()!.customer?.name }}</p><p class="text-ink-soft">{{ o()!.customer?.phone }} {{ o()!.customer?.email }}</p></section>
          <section class="rounded-xl bg-white p-4"><h2 class="mb-1 font-semibold">Ship to</h2><p class="text-ink-soft">{{ a()["full_name"] }}, {{ a()["phone"] }}, {{ a()["line1"] }}, {{ a()["city"] }}, {{ a()["state"] }} {{ a()["pincode"] }}</p>@if (a()["gift_message"]) {<p class="mt-1 text-sm"><strong>Gift message:</strong> {{ a()["gift_message"] }}</p>}</section>
          <section class="rounded-xl bg-white p-4">
            <h2 class="mb-1 font-semibold">Totals</h2><p>Order {{ rupeesExact(o()!.grand_total) }}</p>@if (o()!.refunded_total > 0) {<p class="text-leaf">Refunded {{ rupeesExact(o()!.refunded_total) }}</p>}
            @if (o()!.fee_invoice_number) {
              <button type="button" class="mt-1 text-sm font-semibold text-peacock hover:underline" (click)="feeInvoice()">
                Fee invoice {{ o()!.fee_invoice_number }}
              </button>
            }
          </section>
        </div>
        @if (o()!.payment_method === "online") {<pc-payment-check [order]="o()!" (checked)="load()" />}
        @for (s of o()!.sub_orders; track s.id) {
          <section class="rounded-xl bg-white p-4">
            <div class="mb-2 flex flex-wrap items-center gap-3">
              <h2 class="font-semibold">{{ s.number }}, {{ s.seller?.name }}</h2>
              <pc-status-pill [status]="s.status" [label]="subLabel[s.status]" />
              <div class="ml-auto flex gap-2">
                @if (s.status === "shipped") {
                  <button pcButton size="sm" [loading]="busy()" (click)="deliver(s.id)">Mark delivered</button>
                }
                @if (cancellable.includes(s.status)) {<button pcButton size="sm" variant="danger" (click)="cancelId.set(s.id)">Cancel and refund</button>}
                @if (canReturn(s.id)) {<button pcButton size="sm" variant="secondary" (click)="returnFor.set(s.id)">Open a return</button>}
              </div>
            </div>
            <ul class="mb-2 text-[15px]">
              @for (it of s.items; track $index) {<li>{{ it.title }}{{ it.variant_label ? " (" + it.variant_label + ")" : "" }} × {{ it.qty }}: {{ rupeesExact(it.line_total) }}</li>}
            </ul>
            <p class="text-sm text-ink-soft">
              Total {{ rupeesExact(s.total) }}; commission {{ rupeesExact(s.commission ?? 0) }} + GST {{ rupeesExact(s.commission_gst ?? 0) }}; TCS {{ rupeesExact(s.tcs ?? 0) }}; TDS {{ rupeesExact(s.tds ?? 0) }}; seller payout {{ rupeesExact(s.seller_payout ?? 0) }} ({{ s.settlement_status }})
            </p>
            @if (s.tracking_number) {<p class="text-sm">Tracking: {{ s.courier_name }} {{ s.tracking_number }}</p>}
            @if (fleet(s.id); as f) {<pc-fleet-line [f]="f" />}
            @if (s.cancel_reason) {<p class="text-sm text-vermilion">Cancelled by {{ s.cancelled_by }}: {{ s.cancel_reason }}</p>}
          </section>
        }
        @if (o()!.refunds.length > 0) {
          <section class="rounded-xl bg-white p-4">
            <h2 class="mb-2 font-semibold">Refunds</h2>
            @for (r of o()!.refunds; track $index) {
              <div class="flex flex-wrap items-center gap-3 border-t border-line py-2 text-[15px]">
                <span>{{ rupeesExact(r.amount) }}</span><pc-status-pill [status]="r.status" /><span class="text-ink-soft">{{ r.reason }}</span>
                @if (r.last_error) {<span class="text-sm text-vermilion">{{ r.last_error }}</span>}
                @if (r.status === "failed" && r.id) {
                  @if (canRefund()) {
                    <button pcButton size="sm" variant="secondary" class="ml-auto" (click)="act('/api/admin/refunds/' + r.id + '/retry', undefined, 'Refund retried')">Retry</button>
                  } @else {
                    <span class="ml-auto text-sm text-ink-soft">Ask Finance, or anyone with the Refunds permission, to retry this refund.</span>
                  }
                }
              </div>
            }
          </section>
        }
        <section class="rounded-xl bg-white p-4">
          <h2 class="mb-2 font-semibold">Timeline</h2>
          <ol class="text-sm">@for (e of o()!.timeline; track $index) {<li><span class="text-ink-faint">{{ dateTime(e.at) }}</span> {{ e.from ? e.from + " to " : "" }}{{ e.to }} by {{ e.actor }}{{ e.note ? ": " + e.note : "" }}</li>}</ol>
        </section>
        <pc-modal [open]="!!cancelId()" (close)="cancelId.set(null)" title="Cancel this part of the order">
          <p class="mb-2 text-ink-soft">Stock is returned to the seller. If the customer paid online, a refund is sent to Razorpay.</p>
          <textarea pcTextarea [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="Reason shown to the customer and seller" aria-label="Reason"></textarea>
          <button pcButton class="mt-3" variant="buy" [disabled]="reason().trim().length < 5" [loading]="busy()" (click)="act('/api/admin/sub-orders/' + cancelId() + '/cancel', { reason: reason() }, 'Cancelled')">Cancel and refund</button>
        </pc-modal>
        @if (returnFor() && returnable()) {
          <pc-return-request-modal [staff]="true" [subId]="returnFor()!" [items]="returnable()!.items[returnFor()!] ?? []" [needsUpi]="returnable()!.needs_upi" [open]="true" (closed)="returnFor.set(null)"
            (done)="returnFor.set(null); loadReturnable()" />
        }
      </div>
    }
  `,
})
export class AdminOrdersIdPage {
  readonly id = input.required<string>();
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly rupeesExact = rupeesExact;
  protected readonly dateTime = dateTime;
  protected readonly subLabel = SUB_STATUS_LABEL;
  protected readonly cancellable = ["pending_payment", "placed", "confirmed", "packed"];
  // retrying a failed refund needs the Refunds permission
  protected readonly canRefund = computed(() => !!this.admin.me()?.permissions.includes("refunds"));
  protected readonly o = signal<OrderDetail | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly cancelId = signal<string | null>(null);
  protected readonly reason = signal("");
  protected readonly busy = signal(false);
  // what the customer can still return, package by package: staff can open a return for them
  protected readonly returnable = signal<{ items: Record<string, ReturnableItem[] | undefined>; needs_upi: boolean } | null>(null);
  protected readonly returnFor = signal<string | null>(null);
  protected readonly a = computed(() => this.o()?.ship_to ?? {});
  protected readonly sub = computed(() => {
    const o = this.o();
    return o ? `${dateTime(o.created_at)}, ${o.payment_method === "cod" ? "cash on delivery" : "online"}: ${PAYMENT_STATUS_LABEL[o.payment_status]}` : "";
  });

  constructor() {
    effect(() => {
      this.id();
      untracked(() => {
        this.load();
        this.loadReturnable();
      });
    });
  }

  protected load(): Promise<void> {
    return api<OrderDetail>(`/api/admin/orders/${this.id()}`).then((x) => this.o.set(x)).catch((e) => this.error.set(e.message));
  }

  protected loadReturnable(): void {
    api<{ items: Record<string, ReturnableItem[]>; needs_upi: boolean }>(`/api/admin/orders/${this.id()}/returnable`).then((x) => this.returnable.set(x)).catch(quietly);
  }

  protected fleet(subId: string): Fleet | undefined {
    return (this.o()?.fleet as unknown as Record<string, Fleet> | undefined)?.[subId];
  }

  protected canReturn(subId: string): boolean {
    return (this.returnable()?.items[subId] ?? []).some((i) => i.eligible);
  }

  protected feeInvoice(): void {
    const o = this.o();
    if (o) void openPdf(`/api/admin/orders/${o.id}/fee-invoice.pdf`, (m) => this.toast.show(m, "error"));
  }

  protected deliver(subId: string): void {
    const f = this.fleet(subId);
    const withPartner = !!f?.assignment && !["delivered", "failed"].includes(f.assignment.status);
    if (withPartner && !window.confirm("Our delivery partner has this package. Mark it delivered without the customer's OTP? Do this only when you know it was handed over; the partner's trip is closed and any cash counts as collected by them.")) return;
    void this.act(`/api/admin/sub-orders/${subId}/deliver`, undefined, "Marked delivered");
  }

  protected async act(path: string, body?: object, msg = "Updated"): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(path, { method: "POST", body });
      await this.load();
      this.toast.show(msg);
      this.cancelId.set(null);
      this.reason.set("");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Failed");
    } finally {
      this.busy.set(false);
    }
  }
}
