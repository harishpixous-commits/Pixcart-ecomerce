/*
 * One order: payment banner (Razorpay window, return from a UPI app), each package with its progress, tracking, items,
 * cancel / return / invoice / rate buttons, returns, the delivery address, the bill and "Need help with this order?".
 * Port of frontend/src/app/(shop)/orders/[id]/page.tsx.
 */

import { ChangeDetectionStrategy, Component, afterNextRender, computed, effect, inject, input, signal, untracked } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute, Router } from "@angular/router";
import { Building2, ChevronRight, FileText, Leaf, LifeBuoy, MapPin, RotateCcw, Star, Truck } from "lucide-angular";
import { map } from "rxjs";
import { ApiError, api } from "../../core/api";
import { PAYMENT_STATUS_LABEL, SUB_STATUS_LABEL, date, dateTime, rupees } from "../../core/format";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import type { OrderDetail, ReturnView, ReturnableItem, SubOrderView } from "../../core/types";
import { PushPrompt } from "../../shared/chrome/push-prompt";
import { BillDetails } from "../../shared/commerce/bill";
import { openPdf, usePolling } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Modal, Pill, ProductImage, StatusPill, Textarea, Toast } from "../../shared/ui/ui";
import { DeliveryTracking } from "../customer/delivery-tracking";
import { OrderPayment, type PaymentArrival } from "../customer/order-payment";
import { ReturnRequestModal, ReturnsList } from "../customer/order-returns";

const SURFACE = "rounded-2xl bg-white shadow-sm ring-1 ring-black/5";
const CARD = `${SURFACE} p-4 sm:p-5`;
const STEPS = ["placed", "confirmed", "packed", "shipped", "delivered"] as const;

type Returnable = { items: Record<string, ReturnableItem[] | undefined>; returns: ReturnView[]; needs_upi: boolean };

/** The delivery address kept on the order. Older orders have no label, instructions or no_bag. */
function shipTo(raw: Record<string, unknown>) {
  const text = (key: string) => {
    const v = raw[key];
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    name: text("full_name"),
    phone: text("phone"),
    street: [text("line1"), text("line2"), text("landmark")].filter(Boolean).join(", "),
    place: [text("city"), [text("state"), text("pincode")].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    label: text("label") || (raw["kind"] === "home" ? "Home" : raw["kind"] === "work" ? "Work" : ""),
    instructions: text("instructions"),
    noBag: raw["no_bag"] === true,
  };
}

@Component({
  selector: "pc-order-progress",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (sub().status === "cancelled") {
      <p class="text-sm text-vermilion">Cancelled{{ sub().cancelled_at ? " on " + date(sub().cancelled_at) : "" }}{{ sub().cancel_reason ? ": " + sub().cancel_reason : "" }}</p>
    } @else if (sub().status === "pending_payment") {
      <p class="text-sm text-[#8A5A00]">Waiting for payment</p>
    } @else {
      <ol class="grid grid-cols-5 gap-1" aria-label="Delivery progress">
        @for (s of STEPS; track s; let i = $index) {
          <li class="flex flex-col gap-1">
            <span [class]="i <= idx() ? 'h-1.5 rounded-full bg-leaf' : 'h-1.5 rounded-full bg-line'"></span>
            <span [class]="i <= idx() ? 'text-[11px] leading-tight sm:text-xs font-semibold text-ink' : 'text-[11px] leading-tight sm:text-xs text-ink-faint'">{{ label(s) }}</span>
          </li>
        }
      </ol>
    }
  `,
})
export class Progress {
  readonly sub = input.required<SubOrderView>();
  protected readonly STEPS = STEPS;
  protected readonly date = date;
  protected readonly idx = computed(() => STEPS.indexOf(this.sub().status as (typeof STEPS)[number]));
  protected readonly label = (s: string) => SUB_STATUS_LABEL[s].replace(" by seller", "");
}

@Component({
  selector: "pc-shop-orders-id-page",
  imports: [
    Icon, PcLink, PageLoader, Button, ErrorNote, Modal, Pill, ProductImage, StatusPill, Textarea, BillDetails, PushPrompt, DeliveryTracking, OrderPayment,
    ReturnRequestModal, ReturnsList, Progress,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!order()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      @let o = order()!;
      @let a = ship();
      <div class="flex flex-col gap-4">
        <pc-order-payment [order]="o" (orderChange)="order.set($event)" [arrival]="arrival" [placed]="placed" />
        <pc-error-note [message]="error()" />
        @if (active()) {
          <pc-push-prompt app="shop" title="Get delivery updates as notifications" text="Know the moment your package is picked up, on the way, or at your door, with the OTP to share." />
        }

        <section [class]="CARD">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <h1 class="break-words text-2xl font-semibold">Order {{ o.number }}</h1>
              <p class="text-sm text-ink-faint">Placed {{ dateTime(o.created_at) }}</p>
              <button pcButton variant="secondary" size="sm" class="mt-2" data-testid="order-again" (click)="orderAgain(o.id)">Order again</button>
            </div>
            <div class="flex items-center justify-between gap-3 border-t border-dashed border-line pt-3 sm:flex-col sm:items-end sm:gap-1 sm:border-0 sm:pt-0">
              <p class="font-display text-2xl font-bold leading-tight tabular-nums">{{ rupees(o.grand_total) }}</p>
              <div class="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-sm text-ink-soft">
                <span>{{ o.payment_method === "cod" ? "Cash on delivery" : "Online payment" }}</span>
                @if (o.payment_status !== "cod") {<pc-status-pill [status]="o.payment_status" [label]="PAYMENT_STATUS_LABEL[o.payment_status]" />}
              </div>
            </div>
          </div>
        </section>

        <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          <div class="flex min-w-0 flex-col gap-4">
            @for (s of o.sub_orders; track s.id; let i = $index) {
              <section [class]="SURFACE + ' overflow-hidden'">
                <header class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
                  <p class="min-w-0 font-semibold">Package {{ i + 1 }} of {{ o.sub_orders.length }}, sold by @if (s.seller) {<a [pcLink]="'/store/' + s.seller.slug" class="text-peacock hover:underline">{{ s.seller.name }}</a>} @else {seller}</p>
                  <pc-status-pill [status]="s.status" [label]="SUB_STATUS_LABEL[s.status]" />
                </header>
                <div class="flex flex-col gap-4 p-4 sm:p-5">
                  <pc-order-progress [sub]="s" />
                  @if (o.fleet?.[s.id] && s.status !== "cancelled") {
                    <pc-delivery-tracking [orderId]="o.id" [subId]="s.id" [f]="o.fleet![s.id]" [packageStatus]="s.status" (changed)="refreshOrder()" />
                  }
                  @if (s.tracking_number && !o.fleet?.[s.id]) {
                    <p class="flex items-start gap-2 rounded-xl bg-mist px-3 py-2 text-sm">
                      <svg [pcIcon]="Truck" class="mt-0.5 h-4 w-4 shrink-0 text-peacock" />
                      <span class="min-w-0 break-words">{{ s.courier_name }} tracking number <span class="font-semibold">{{ s.tracking_number }}</span>@if (s.tracking_url) {&ngsp;<a [href]="s.tracking_url" target="_blank" rel="noopener noreferrer" class="font-semibold text-peacock hover:underline">Track package</a>}</span>
                    </p>
                  }
                  <ul class="flex flex-col gap-3">
                    @for (it of s.items; track $index) {
                      <li class="flex gap-3">
                        <pc-product-image [src]="it.image" [alt]="it.title" imgClass="h-16 w-16 shrink-0 rounded-xl sm:h-20 sm:w-20" />
                        <div class="min-w-0 flex-1">
                          @if (it.product_slug) {
                            <a [pcLink]="'/p/' + it.product_slug" class="line-clamp-2 font-medium leading-snug hover:text-peacock">{{ it.title }}</a>
                          } @else {
                            <p class="line-clamp-2 font-medium leading-snug">{{ it.title }}</p>
                          }
                          @if (it.variant_label) {<p class="text-sm text-ink-faint">{{ it.variant_label }}</p>}
                          <p class="text-sm text-ink-soft">Qty {{ it.qty }} at {{ rupees(it.unit_price) }}</p>
                        </div>
                        <p class="font-semibold tabular-nums">{{ rupees(it.line_total) }}</p>
                      </li>
                    }
                  </ul>
                  @if (s.expected_delivery_at && isLive(s.status)) {
                    <p class="text-sm text-ink-soft">Expected by <span class="font-semibold text-ink">{{ date(s.expected_delivery_at) }}</span></p>
                  }
                  <div class="flex flex-wrap gap-2">
                    @if (s.can_cancel) {<button pcButton variant="danger" size="sm" (click)="cancelSub.set(s)">Cancel this package</button>}
                    @if (site().features.returns && canReturn(s.id)) {<button pcButton variant="secondary" size="sm" (click)="returnSub.set(s.id)">Return items</button>}
                    @if (s.invoice_number) {
                      <button pcButton variant="ghost" size="sm" (click)="pdf('/api/invoices/' + s.id + '.pdf')"><svg [pcIcon]="FileText" class="h-4 w-4" /> Invoice {{ s.invoice_number }}</button>
                    }
                    @if (site().features.reviews && s.status === "delivered" && s.items[0]?.product_slug) {
                      <a [href]="'/p/' + s.items[0].product_slug + '#reviews'" class="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-peacock hover:bg-peacock-light">
                        <svg [pcIcon]="Star" class="h-4 w-4" /> Rate this product
                      </a>
                    }
                  </div>
                </div>
              </section>
            }

            @if (returnable() && returnable()!.returns.length > 0) {
              <div class="overflow-hidden rounded-2xl shadow-sm ring-1 ring-black/5">
                <pc-returns-list [returns]="returnable()!.returns" (cancelReturn)="cancelReturn($event)" />
              </div>
            }
          </div>

          <aside class="flex min-w-0 flex-col gap-4">
            <section [class]="CARD" aria-labelledby="ship-h">
              <div class="flex items-center justify-between gap-2">
                <h2 id="ship-h" class="flex items-center gap-2 text-lg font-semibold"><svg [pcIcon]="MapPin" class="h-5 w-5 text-peacock" /> Delivery address</h2>
                @if (a.label) {<pc-pill tone="blue">{{ a.label }}</pc-pill>}
              </div>
              <p class="mt-2 break-words font-semibold" translate="no">{{ a.name }}@if (a.phone) {<span class="font-normal text-ink-soft">, {{ a.phone }}</span>}</p>
              <p class="break-words text-ink-soft" translate="no">{{ a.street }}@if (a.street && a.place) {<br />}{{ a.place }}</p>
              @if (a.instructions || a.noBag) {
                <div class="mt-3 flex flex-col items-start gap-2">
                  @if (a.instructions) {
                    <p class="w-full break-words rounded-xl bg-mist px-3 py-2 text-sm text-ink-soft"><span class="font-semibold text-ink">Instructions:</span> {{ a.instructions }}</p>
                  }
                  @if (a.noBag) {<pc-pill tone="green"><svg [pcIcon]="Leaf" class="mr-1 h-3.5 w-3.5" />No bag</pc-pill>}
                </div>
              }
              @if (o.buyer_gstin) {
                <div class="mt-4 rounded-xl bg-peacock-light/60 p-3 ring-1 ring-inset ring-peacock/15" data-testid="business-purchase">
                  <p class="flex items-center gap-2 font-semibold text-peacock-dark"><svg [pcIcon]="Building2" class="h-4 w-4 shrink-0" /> Business purchase</p>
                  <dl class="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    @if (o.buyer_business) {
                      <dt class="text-ink-soft">Business</dt>
                      <dd class="break-words font-semibold">{{ o.buyer_business }}</dd>
                    }
                    <dt class="text-ink-soft">GSTIN</dt>
                    <dd class="break-all font-semibold tracking-wide">{{ o.buyer_gstin }}</dd>
                  </dl>
                  <p class="mt-2 text-xs text-ink-faint">The tax invoices for this order are billed to this business.</p>
                </div>
              }
            </section>

            <section [class]="CARD + ' flex flex-col gap-3'">
              <pc-bill-details [bill]="bill()" totalLabel="Order total" deliveryLabel="Delivery" />
              @if (o.refunded_total > 0) {
                <p class="flex items-center justify-between gap-3 border-t border-dashed border-line pt-3 text-[15px] font-semibold text-leaf" data-testid="order-refunded">
                  <span class="inline-flex items-center gap-1.5"><svg [pcIcon]="RotateCcw" class="h-4 w-4" /> Refunded</span>
                  <span class="tabular-nums">{{ rupees(o.refunded_total) }}</span>
                </p>
              }
              @if (o.refunds.length > 0) {<p class="text-sm text-ink-soft">Refunds reach your original payment method in 5 to 7 working days.</p>}
              @if (o.fee_invoice_number) {
                <button pcButton variant="ghost" size="sm" class="self-start" data-testid="fee-invoice" (click)="pdf('/api/orders/' + o.id + '/fee-invoice.pdf')">
                  <svg [pcIcon]="FileText" class="h-4 w-4" /> Invoice for the fees {{ o.fee_invoice_number }}
                </button>
              }
            </section>

            <a [href]="helpHref()" [class]="SURFACE + ' flex items-center gap-3 px-4 py-3 font-semibold text-peacock transition-colors hover:bg-peacock-light/50 sm:px-5'">
              <svg [pcIcon]="LifeBuoy" class="h-5 w-5 shrink-0" /> Need help with this order?
              <svg [pcIcon]="ChevronRight" class="ml-auto h-4 w-4 shrink-0" />
            </a>
          </aside>
        </div>

        @if (returnSub() && returnable()) {
          <pc-return-request-modal [subId]="returnSub()!" [items]="returnable()!.items[returnSub()!] ?? []" [needsUpi]="returnable()!.needs_upi" [open]="true"
            (closed)="returnSub.set(null)" (done)="returnSub.set(null); load()" />
        }

        <pc-modal [open]="!!cancelSub()" (close)="cancelSub.set(null)" title="Cancel this package?">
          <p class="mb-3 text-ink-soft">{{ cancelNote() }}</p>
          <label for="reason" class="text-sm font-medium">Reason (optional)</label>
          <textarea pcTextarea id="reason" [value]="reason()" (input)="reason.set($any($event.target).value)" maxlength="300" placeholder="For example: ordered by mistake"></textarea>
          <div class="mt-4 flex gap-2">
            <button pcButton variant="buy" (click)="cancel()" [loading]="busy()">Cancel package</button>
            <button pcButton variant="ghost" (click)="cancelSub.set(null)">Keep it</button>
          </div>
        </pc-modal>
      </div>
    }
  `,
})
export class ShopOrdersIdPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  private readonly session = inject(SessionService);
  protected readonly site = inject(SiteService).site;
  private readonly id = toSignal(this.route.paramMap.pipe(map((p) => p.get("id") ?? "")), { initialValue: this.route.snapshot.paramMap.get("id") ?? "" });
  private readonly sp = this.route.snapshot.queryParamMap;
  protected readonly order = signal<OrderDetail | null>(null);
  protected readonly error = signal<string | null>(this.sp.get("payment_error"));
  protected readonly cancelSub = signal<SubOrderView | null>(null);
  protected readonly reason = signal("");
  protected readonly busy = signal(false);
  protected readonly returnable = signal<Returnable | null>(null);
  protected readonly returnSub = signal<string | null>(null);
  // What the address said on arrival (from checkout, or back from Razorpay), read once: the address is then tidied so a
  // reload does not open the payment window again.
  protected readonly arrival: PaymentArrival = { outcome: this.sp.get("payment") ?? "", reason: this.sp.get("reason") ?? "", open: this.sp.get("pay") === "1" };
  protected readonly placed = this.sp.get("placed") === "1";

  protected readonly CARD = CARD;
  protected readonly SURFACE = SURFACE;
  protected readonly PAYMENT_STATUS_LABEL = PAYMENT_STATUS_LABEL;
  protected readonly SUB_STATUS_LABEL = SUB_STATUS_LABEL;
  protected readonly rupees = rupees;
  protected readonly date = date;
  protected readonly dateTime = dateTime;
  protected readonly Truck = Truck;
  protected readonly FileText = FileText;
  protected readonly Star = Star;
  protected readonly MapPin = MapPin;
  protected readonly Leaf = Leaf;
  protected readonly Building2 = Building2;
  protected readonly RotateCcw = RotateCcw;
  protected readonly LifeBuoy = LifeBuoy;
  protected readonly ChevronRight = ChevronRight;

  protected readonly ship = computed(() => shipTo(this.order()?.ship_to ?? {}));
  protected readonly active = computed(() => (this.order()?.sub_orders ?? []).some((s) => ["placed", "confirmed", "packed", "shipped"].includes(s.status)));
  protected readonly bill = computed(() => {
    const o = this.order()!;
    return {
      items_total: o.items_total, shipping_total: o.shipping_total, cod_fee: o.cod_fee, fees: o.fees, tip: o.tip, coupon_code: o.coupon_code,
      coupon_discount: o.discount_total, grand_total: o.grand_total,
    };
  });
  protected readonly helpHref = computed(() => {
    const o = this.order()!;
    return `/support/new?order=${o.id}&subject=${encodeURIComponent(`Help with order ${o.number}`)}`;
  });
  protected readonly cancelNote = computed(() => {
    const s = this.cancelSub();
    const o = this.order();
    return (s?.refund_if_cancelled ?? 0) > 0
      ? `We will refund ${rupees(s!.refund_if_cancelled!)} to your original payment method.`
      : o?.payment_method === "online" && o.payment_status === "pending"
        ? "The payment for this order is not complete, so nothing is refunded."
        : "Nothing has been charged for this package.";
  });
  // While our delivery partner has a package (or one is being assigned), follow along every 15 seconds.
  private readonly followFleet = computed(() => {
    const order = this.order();
    return !!order?.fleet && Object.entries(order.fleet).some(([sid, f]) => {
      const sub = order.sub_orders.find((x) => x.id === sid);
      return !!sub && ["packed", "shipped"].includes(sub.status) && (!!f.ready_for_pickup_at || !!f.assignment);
    });
  });

  constructor() {
    if (this.sp.get("pay") || this.sp.get("payment") || this.sp.get("reason") || this.sp.get("placed"))
      afterNextRender(() => void this.router.navigateByUrl(`/orders/${this.id()}`, { replaceUrl: true }));

    effect(() => {
      const user = this.session.user();
      const id = this.id();
      if (this.session.ready() && !user) void this.router.navigateByUrl(`/login?next=/orders/${id}`, { replaceUrl: true });
      if (user) untracked(() => this.load());
    });
    usePolling(() => this.refreshOrder(), 15_000, this.followFleet);
  }

  protected isLive(status: string): boolean {
    return ["placed", "confirmed", "packed", "shipped"].includes(status);
  }

  protected canReturn(subId: string): boolean {
    return (this.returnable()?.items[subId] ?? []).some((i) => i.eligible);
  }

  protected load(): void {
    const id = this.id();
    api<OrderDetail>(`/api/orders/${id}`)
      .then((o) => {
        this.order.set(o);
        return api<Returnable>(`/api/orders/${id}/returnable`).then((r) => this.returnable.set(r));
      })
      .catch((e) => this.error.set(e instanceof Error ? e.message : "Could not load the order"));
  }

  protected refreshOrder(): void {
    api<OrderDetail>(`/api/orders/${this.id()}`).then((o) => this.order.set(o)).catch(() => {});
  }

  protected async orderAgain(orderId: string): Promise<void> {
    try {
      const r = await api<{ added: number; skipped: { title: string; reason: string }[] }>(`/api/cart/reorder/${orderId}`, { method: "POST" });
      this.toast.show(r.skipped.length ? `${r.added} added to your cart. Not available now: ${r.skipped.map((x) => x.title).join(", ")}` : `${r.added} item${r.added === 1 ? "" : "s"} added to your cart`, r.added ? "ok" : "error");
      if (r.added) void this.router.navigateByUrl("/cart");
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not add these items", "error");
    }
  }

  protected pdf(path: string): void {
    void openPdf(path, (m) => this.toast.show(m, "error"));
  }

  protected async cancelReturn(rid: string): Promise<void> {
    await api(`/api/returns/${rid}/cancel`, { method: "POST" });
    this.toast.show("Return cancelled");
    this.load();
  }

  protected async cancel(): Promise<void> {
    const sub = this.cancelSub();
    if (!sub) return;
    this.busy.set(true);
    try {
      const refundBefore = this.order()?.refunded_total ?? 0;
      const next = await api<OrderDetail>(`/api/orders/${this.id()}/cancel`, { method: "POST", body: { sub_order_id: sub.id, reason: this.reason().trim() || "Changed my mind" } });
      this.order.set(next);
      const refunded = (next.refunded_total ?? 0) - refundBefore;
      this.toast.show(refunded > 0 ? `Cancelled. A refund of ${rupees(refunded)} has been started.` : "Cancelled");
      this.cancelSub.set(null);
      this.reason.set("");
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not cancel", "error");
    } finally {
      this.busy.set(false);
    }
  }
}
