/*
 * The payment part of a shopper's order page: opens the Razorpay window, and shows the real result, as Razorpay records
 * it, when the shopper comes back from Google Pay, PhonePe or another UPI app (on a phone, in the app or on a computer):
 *
 *   paid      → "Payment received" with the amount, the way it was paid and Razorpay's reference
 *   failed    → "Payment not received", Razorpay's reason, and Try again
 *   waiting   → "Checking your payment…", asking Razorpay every few seconds and whenever the page comes back into view
 *
 * Nothing is decided in the browser: every answer comes from /api/orders/{id}/payment-status, which asks Razorpay.
 * Port of components/order-payment.tsx:
 *   <pc-order-payment [order]="o" (orderChange)="..." [arrival]="{ outcome, reason, open }" [placed]="false" />
 */

import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, effect, inject, input, output, signal } from "@angular/core";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { dateTime, money, rupees } from "../../core/format";
import { clearPaying, payWithRazorpay, payingSince } from "../../core/razorpay";
import { RegionalService } from "../../core/regional";
import { SiteService } from "../../core/site";
import type { OrderDetail } from "../../core/types";
import { Icon } from "../../shared/ui/icon";
import { Button } from "../../shared/ui/ui";

type Phase = "idle" | "open" | "checking" | "waiting" | "failed";
type StatusReply = { status: "paid" | "waiting" | "failed" | "not_paid" | "unknown"; reason: string; order: OrderDetail };

const POLL_MS = 5000;
const POLL_FOR_MS = 3 * 60 * 1000; // keep asking for 3 minutes after the shopper comes back
const RECENT_MS = 30 * 60 * 1000; // a payment started in this tab within 30 minutes may still arrive

const METHOD: Record<string, string> = { upi: "UPI", card: "card", netbanking: "net banking", wallet: "wallet", emi: "EMI", paylater: "pay later" };

export type PaymentArrival = { outcome: string; reason: string; open: boolean };

@Component({
  selector: "pc-order-payment",
  imports: [Icon, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!pending()) {
      @if (order().status !== "cancelled" && justPaid()) {
        @let paid = order().paid;
        <div class="flex items-start gap-3 rounded-2xl bg-leaf-light p-4 text-leaf ring-1 ring-leaf/15" role="status" data-testid="payment-success">
          <svg [pcIcon]="CheckCircle2" class="h-7 w-7 shrink-0" />
          <div class="min-w-0">
            <p class="font-display text-xl font-semibold">{{ paid ? "Payment received. Order placed" : "Order placed" }}</p>
            @if (paid) {
              <p class="break-words text-ink-soft"><span translate="no">{{ paidAmount() }}</span> paid{{ METHOD[paid.method] ? " by " + METHOD[paid.method] : "" }}@if (paid.reference) {. Reference <span class="font-semibold text-ink">{{ paid.reference }}</span>}</p>
            }
            <p class="text-ink-soft">We have sent your order to the seller{{ order().sub_orders.length > 1 ? "s" : "" }}. You can track each package below.</p>
          </div>
        </div>
      }
    } @else if (phase() === "failed") {
      <div class="flex flex-col gap-3 rounded-2xl bg-vermilion-light p-4 ring-1 ring-vermilion/25" role="alert" data-testid="payment-failed">
        <div class="flex items-start gap-3">
          <svg [pcIcon]="AlertTriangle" class="h-6 w-6 shrink-0 text-vermilion" />
          <div class="min-w-0">
            <p class="text-lg font-semibold text-vermilion">Payment not received</p>
            @if (reason()) {<p class="break-words text-ink">{{ reason() }}</p>}
            <p class="text-sm text-ink-soft">If money left your account, your bank returns it by itself, usually within 5 to 7 working days.{{ held() }}</p>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button pcButton variant="buy" (click)="pay()">Try again · Pay {{ total() }}</button>
          <button pcButton variant="ghost" (click)="startPolling()" [loading]="checkingNow()"><svg [pcIcon]="RefreshCw" class="h-4 w-4" /> I have paid, check again</button>
        </div>
      </div>
    } @else if (phase() === "checking" || phase() === "waiting" || phase() === "open") {
      <div class="flex flex-col gap-3 rounded-2xl bg-marigold-light p-4 ring-1 ring-marigold/30" role="status" aria-live="polite" data-testid="payment-checking">
        <div class="flex items-start gap-3">
          <svg [pcIcon]="Loader2" class="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[#8A5A00]" />
          <div class="min-w-0">
            <p class="font-semibold">{{ phase() === "open" ? "Complete the payment in the payment window" : phase() === "waiting" ? "Waiting for you to approve the payment in your UPI app" : "Checking your payment…" }}</p>
            <p class="text-sm text-ink-soft">{{ phase() === "open" ? "Pick Google Pay, PhonePe, Paytm or any UPI app, a card or net banking. You come back here after paying." : "This page updates by itself as soon as the payment reaches us. Please don't pay again." }}{{ held() }}</p>
          </div>
        </div>
        @if (phase() !== "open") {
          <div class="flex flex-wrap gap-2">
            <button pcButton variant="secondary" size="sm" (click)="startPolling()" [loading]="checkingNow()"><svg [pcIcon]="RefreshCw" class="h-4 w-4" /> Check now</button>
            <button pcButton variant="ghost" size="sm" (click)="pay()">Pay {{ total() }} again</button>
          </div>
        }
      </div>
    } @else {
      <div class="flex flex-col gap-3 rounded-2xl bg-marigold-light p-4 ring-1 ring-marigold/30 sm:flex-row sm:items-center" data-testid="payment-pending">
        <p class="flex-1">Your payment is not complete.{{ held() }}</p>
        <div class="flex flex-wrap gap-2">
          <button pcButton variant="ghost" size="sm" (click)="startPolling()" [loading]="checkingNow()">Already paid? Check</button>
          <button pcButton variant="buy" (click)="pay()">Pay {{ total() }}</button>
        </div>
      </div>
    }
  `,
})
export class OrderPayment implements OnInit {
  readonly order = input.required<OrderDetail>();
  /** what the address said on arrival: ?pay=1 (open the window), ?payment=success|failed|checking&reason= */
  readonly arrival = input.required<PaymentArrival>();
  /** came straight from checkout (?placed=1) */
  readonly placed = input(false);
  readonly orderChange = output<OrderDetail>();

  private readonly site = inject(SiteService).site;
  private readonly regional = inject(RegionalService).data;
  protected readonly phase = signal<Phase>("idle");
  protected readonly reason = signal("");
  protected readonly justPaid = signal(false);
  protected readonly checkingNow = signal(false);
  private pollUntil = 0;
  private lastFail = "";
  private opened = false;
  private alive = true;
  protected readonly METHOD = METHOD;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Loader2 = Loader2;
  protected readonly RefreshCw = RefreshCw;

  protected readonly pending = computed(() => this.order().status === "pending_payment" && !!this.order().payment);
  private readonly id = computed(() => this.order().id);
  // what the button pays: Razorpay's amount in the currency it charges (rupees unless the admin charges the shopper's)
  protected readonly total = computed(() => {
    const p = this.order().payment;
    return p ? money(p.amount, p.currency, this.digits(p.currency)) : rupees(this.order().grand_total);
  });
  protected readonly held = computed(() => (this.order().payment_expires_at ? ` Your items are held until ${dateTime(this.order().payment_expires_at)}.` : ""));
  protected readonly paidAmount = computed(() => {
    const paid = this.order().paid;
    if (!paid) return "";
    return paid.currency && paid.currency !== "INR" && paid.charge_amount ? money(paid.charge_amount, paid.currency, this.digits(paid.currency)) : money(paid.amount, "INR");
  });

  constructor() {
    const destroy = inject(DestroyRef);
    destroy.onDestroy(() => (this.alive = false));

    // On arrival: open the window (from checkout), or find out what happened (back from a UPI app, the page reloaded,
    // or the shopper simply opened an unpaid order).
    effect((onCleanup) => {
      if (!this.pending() || this.opened) return;
      const t = window.setTimeout(() => {
        this.opened = true;
        const arrival = this.arrival();
        if (arrival.open) {
          void this.pay();
          return;
        }
        const recent = Date.now() - payingSince(this.id()) < RECENT_MS;
        if (arrival.outcome === "checking" || arrival.outcome === "success" || recent) this.startPolling();
        else void this.check(false);
      }, 0);
      onCleanup(() => window.clearTimeout(t));
    });

    // Ask again every few seconds while a payment may be on its way, and whenever the page comes back into view
    // (the shopper switches back from the UPI app).
    effect((onCleanup) => {
      if (!this.pending()) return;
      const tick = window.setInterval(() => {
        if (document.visibilityState !== "visible") return;
        const phase = this.phase();
        if (phase === "open") return;
        if (Date.now() < this.pollUntil) void this.check(false);
        else if (phase === "checking" || phase === "waiting") this.phase.set("idle");
      }, POLL_MS);
      const back = () => {
        if (document.visibilityState === "visible" && Date.now() - payingSince(this.id()) < RECENT_MS) {
          this.pollUntil = Math.max(this.pollUntil, Date.now() + POLL_FOR_MS);
          void this.check(false);
        }
      };
      document.addEventListener("visibilitychange", back);
      window.addEventListener("pageshow", back);
      onCleanup(() => {
        window.clearInterval(tick);
        document.removeEventListener("visibilitychange", back);
        window.removeEventListener("pageshow", back);
      });
    });
  }

  ngOnInit(): void {
    const a = this.arrival();
    this.phase.set(a.outcome === "failed" ? "failed" : a.outcome === "checking" ? "checking" : "idle");
    this.reason.set(a.reason);
    this.justPaid.set(a.outcome === "success" || this.placed());
  }

  private digits(code: string): number {
    return this.regional().currencies.find((c) => c.code === code)?.digits ?? 2;
  }

  private async check(show: boolean): Promise<StatusReply["status"]> {
    const id = this.id();
    if (show) this.checkingNow.set(true);
    try {
      const r = await api<StatusReply>(`/api/orders/${id}/payment-status`, { method: "POST" });
      if (!this.alive) return r.status;
      this.orderChange.emit(r.order);
      if (r.status === "paid") {
        clearPaying(id);
        this.pollUntil = 0;
        this.justPaid.set(true);
        this.phase.set("idle");
      } else if (r.status === "waiting") {
        this.phase.update((p) => (p === "open" ? p : "waiting"));
      } else if (r.status === "failed") {
        this.reason.set(r.reason);
        // while polling, a failed attempt ends the wait; the shopper decides to try again
        this.phase.update((p) => (p === "open" ? p : "failed"));
        this.pollUntil = 0;
      } else if (r.status === "not_paid") {
        this.phase.update((p) => (p === "open" ? p : Date.now() < this.pollUntil ? "checking" : p === "failed" ? "failed" : "idle"));
      }
      // "unknown": Razorpay could not be reached; keep the current state and try again on the next round
      return r.status;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.pollUntil = 0;
      return "unknown";
    } finally {
      if (show) this.checkingNow.set(false);
    }
  }

  protected startPolling(): void {
    this.pollUntil = Date.now() + POLL_FOR_MS;
    this.phase.update((p) => (p === "failed" ? p : "checking"));
    void this.check(false);
  }

  protected async pay(): Promise<void> {
    const payment = this.order().payment;
    const id = this.id();
    if (!payment) return;
    this.phase.set("open");
    this.reason.set("");
    this.lastFail = "";
    try {
      const done = await payWithRazorpay(payment, {
        orderId: id,
        returnMode: this.site().payment_return,
        onFailed: (why) => {
          this.lastFail = why;
        },
      });
      if (done) {
        clearPaying(id);
        this.orderChange.emit(done);
        this.justPaid.set(true);
        this.phase.set("idle");
        return;
      }
      // the window was closed: the money may still have gone through (approved in the UPI app, then closed)
      this.phase.set(this.lastFail ? "failed" : "checking");
      this.reason.set(this.lastFail);
      const status = await this.check(false);
      if (status !== "paid" && !this.lastFail) this.startPolling();
    } catch (e) {
      this.reason.set(e instanceof Error ? e.message : "The payment could not be started");
      this.phase.set("failed");
      void this.check(false);
    }
  }
}
