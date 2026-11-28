/*
 * One seller order (package): confirm, pack, hand over to our delivery partners or ship by courier, deliver, returned to
 * me (RTO), cancel, invoice and packing slip, the earnings breakdown and the history. Port of
 * frontend/src/app/seller/orders/[id]/page.tsx (FleetCard included).
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { Bike, FileText, KeyRound, PackageCheck, Phone, Printer, Truck } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { SUB_STATUS_LABEL, dateTime, pct, rupees, rupeesExact } from "../../core/format";
import { SessionService } from "../../core/session";
import type { SellerFleet, SellerOrder } from "../../core/types";
import { PageHeader } from "../../shared/portal-shell";
import { openPdf, telUrl, usePolling } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Modal, ProductImage, Select, StatusPill, TextField, Toast } from "../../shared/ui/ui";

const REJECT_REASONS = [
  ["out_of_stock", "Out of stock"],
  ["cannot_ship_to_pincode", "Cannot deliver to this PIN code"],
  ["pricing_error", "Pricing error in the listing"],
  ["other", "Other reason"],
];

/** Our own delivery partner on the seller's order: what happens next, the pickup code and who is coming. */
@Component({
  selector: "pc-seller-fleet-card",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="overflow-hidden rounded-xl bg-white ring-1 ring-peacock/20" data-testid="fleet-card">
      <div class="flex items-center gap-3 bg-peacock-light/60 px-4 py-3">
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-peacock text-white"><svg [pcIcon]="Bike" class="h-5 w-5" aria-hidden="true" /></span>
        <div class="min-w-0">
          <h2 class="font-semibold">Delivered by our partner</h2>
          <p class="text-sm text-ink-soft">{{ note() }}</p>
        </div>
      </div>
      @if (f().active && !delivered()) {
        <div class="flex flex-col gap-3 p-4">
          @if (f().pickup_code) {
            <div class="flex items-center gap-3 rounded-xl bg-marigold-light/70 p-3">
              <svg [pcIcon]="KeyRound" class="h-5 w-5 shrink-0 text-marigold-dark" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold uppercase tracking-wide text-ink-soft">Pickup code</p>
                <p class="font-mono text-3xl font-bold tracking-[0.3em]" data-testid="pickup-code-seller">{{ f().pickup_code }}</p>
                <p class="text-xs text-ink-soft">Tell this to the delivery partner only when you hand over the package.</p>
              </div>
            </div>
          }
          @if (f().partner; as p) {
            <div class="flex items-center gap-3">
              @if (p.photo) {
                <img [src]="p.photo" alt="" class="h-12 w-12 rounded-full object-cover" />
              } @else {
                <span class="flex h-12 w-12 items-center justify-center rounded-full bg-peacock-light font-bold text-peacock">{{ p.name.slice(0, 1) }}</span>
              }
              <div class="min-w-0 flex-1">
                <p class="font-semibold">{{ p.name }}</p>
                <p class="text-sm text-ink-soft">{{ p.vehicle }}{{ p.vehicle_no ? " · " + p.vehicle_no : "" }}</p>
              </div>
              <a [href]="telUrl(p.phone)" class="inline-flex h-10 items-center gap-1.5 rounded-lg bg-peacock px-3 text-sm font-semibold text-white"><svg [pcIcon]="Phone" class="h-4 w-4" aria-hidden="true" /> Call</a>
            </div>
          } @else {
            <p [class]="f().step?.status === 'offered' ? 'flex items-center gap-2 text-sm text-marigold-dark' : 'flex items-center gap-2 text-sm text-ink-soft'">
              <span class="relative flex h-2.5 w-2.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-marigold/60"></span><span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-marigold"></span></span>
              Finding a delivery partner near you…
            </p>
          }
          @if (f().ready_for_pickup_at) {<p class="text-xs text-ink-faint">Ready for pickup since {{ dateTime(f().ready_for_pickup_at) }}</p>}
        </div>
      }
    </section>
  `,
})
export class SellerFleetCard {
  readonly f = input.required<SellerFleet>();
  readonly status = input.required<string>();
  protected readonly Bike = Bike;
  protected readonly KeyRound = KeyRound;
  protected readonly Phone = Phone;
  protected readonly telUrl = telUrl;
  protected readonly dateTime = dateTime;
  protected readonly delivered = computed(() => this.status() === "delivered");
  protected readonly note = computed(() => {
    const f = this.f();
    return !f.active
      ? f.choice
        ? "Hand it to our delivery partner (tap Ready for pickup), or ship it by courier yourself."
        : "Pack the order and tap Ready for pickup. Our delivery partner collects it from you."
      : this.delivered()
        ? "Delivered to the customer."
        : f.step?.label ?? "With the delivery team";
  });
}

@Component({
  selector: "pc-seller-orders-id-page",
  imports: [PageHeader, PageLoader, Button, ErrorNote, Field, Modal, ProductImage, Select, StatusPill, TextField, Icon, SellerFleetCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (o(); as o) {
      <div class="flex flex-col gap-4">
        <div class="print:hidden">
          <pc-page-header [back]="{ href: '/seller/orders', label: 'Orders' }" [title]="'Order ' + o.number" [sub]="sub()" [withActions]="true">
            <ng-container ngProjectAs="[actions]">
              @if (o.status === "placed") {<button pcButton (click)="act('confirm', undefined, 'Order confirmed')" [loading]="busy()">Confirm order</button>}
              @if (canHandOver()) {
                <button pcButton (click)="act('ready-for-pickup', undefined, 'Ready for pickup. A delivery partner is on the way.')" [loading]="busy()" data-testid="ready-for-pickup">
                  <svg [pcIcon]="PackageCheck" class="h-4 w-4" /> Ready for pickup
                </button>
              }
              @if (o.status === "confirmed") {<button pcButton [variant]="canHandOver() ? 'secondary' : 'primary'" (click)="act('pack', undefined, 'Marked as packed')" [loading]="busy()">Mark as packed</button>}
              @if (o.status === "packed" && !fleetOnly() && provider() === "shiprocket") {
                <button pcButton [variant]="canHandOver() ? 'secondary' : 'primary'" (click)="bookCourier()" [loading]="busy()"><svg [pcIcon]="Truck" class="h-4 w-4" /> Book courier pickup</button>
              }
              @if (o.status === "packed" && !fleetOnly()) {
                <button pcButton [variant]="provider() === 'shiprocket' || canHandOver() ? 'secondary' : 'primary'" (click)="shipOpen.set(true)">{{ provider() === "shiprocket" ? "Ship on my own" : "Add shipping details" }}</button>
              }
              @if (o.fleet?.active && o.fleet?.choice && o.status === "packed" && !o.fleet?.partner) {
                <button pcButton variant="secondary" (click)="act('use-courier', undefined, 'Taken back from the delivery partners. Ship it by courier.')" [loading]="busy()"><svg [pcIcon]="Truck" class="h-4 w-4" /> Use courier instead</button>
              }
              @if (o.label_url) {<a [href]="o.label_url" target="_blank" rel="noreferrer" class="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-4 font-semibold">Shipping label</a>}
              @if (o.invoice_number) {<button pcButton variant="secondary" (click)="invoice(o)"><svg [pcIcon]="FileText" class="h-4 w-4" /> Invoice {{ o.invoice_number }}</button>}
              @if (o.status === "shipped" && !o.fleet?.active) {<button pcButton (click)="act('deliver', undefined, 'Marked as delivered')" [loading]="busy()">Mark as delivered</button>}
              @if (o.status === "shipped" && o.shipping_provider === "manual") {
                <button pcButton variant="secondary" (click)="rtoOpen.set(true)" data-testid="rto">Returned to me</button>
              }
              @if (["confirmed", "packed", "shipped", "delivered"].includes(o.status)) {
                <button pcButton variant="secondary" (click)="print()"><svg [pcIcon]="Printer" class="h-4 w-4" /> Packing slip</button>
              }
              @if (["placed", "confirmed", "packed"].includes(o.status)) {<button pcButton variant="danger" (click)="rejectOpen.set(true)">Cancel order</button>}
            </ng-container>
          </pc-page-header>
          <pc-error-note [message]="error()" />
          <div class="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <section class="self-start rounded-xl bg-white p-4">
              <div class="mb-3 flex items-center justify-between">
                <h2 class="text-lg font-semibold">Items</h2>
                <pc-status-pill [status]="o.status" [label]="subStatus[o.status]" />
              </div>
              @for (it of o.items; track $index) {
                <div class="flex gap-3 border-t border-line py-3">
                  <pc-product-image [src]="it.image" alt="" imgClass="h-16 w-16 shrink-0" />
                  <div class="flex-1">
                    <p class="font-medium">{{ it.title }}</p>
                    <p class="text-sm text-ink-faint">{{ it.variant_label ? it.variant_label + ", " : "" }}SKU {{ it.sku }}</p>
                  </div>
                  <div class="text-right">
                    <p class="font-semibold">× {{ it.qty }}</p>
                    <p class="text-sm text-ink-soft">{{ rupees(it.line_total) }}</p>
                  </div>
                </div>
              }
              @if (o.tracking_number) {<p class="border-t border-line pt-3 text-sm">Shipped with {{ o.courier_name }}, tracking {{ o.tracking_number }}</p>}
              @if (o.cancel_reason) {<p class="border-t border-line pt-3 text-sm text-vermilion">Cancelled: {{ o.cancel_reason }}</p>}
            </section>
            <div class="flex flex-col gap-4">
              @if (o.fleet && (o.fleet.active || o.fleet.eligible) && !["cancelled", "pending_payment"].includes(o.status)) {
                <pc-seller-fleet-card [f]="o.fleet" [status]="o.status" />
              }
              <section class="rounded-xl bg-white p-4">
                <h2 class="mb-2 text-lg font-semibold">Ship to</h2>
                @if (o.ship_to; as a) {
                  <p class="text-ink-soft">{{ a["full_name"] }}, {{ a["phone"] }}<br />{{ join([a["line1"], a["line2"], a["landmark"]]) }}<br />{{ a["city"] }}, {{ a["state"] }} {{ a["pincode"] }}</p>
                @if (a["delivery_slot"]) {
                  <p class="mt-2 rounded-lg bg-peacock-light/60 px-3 py-2 text-sm" data-testid="delivery-slot"><strong>Preferred delivery time:</strong> {{ a["delivery_slot"] }}. A request from the customer, not a promise.</p>
                }
                @if (a["gift_message"]) {
                  <p class="mt-2 rounded-lg bg-peacock-light/60 px-3 py-2 text-sm" data-testid="gift-message"><strong>Gift message:</strong> {{ a["gift_message"] }}. Pack it in with the order and leave the price out.</p>
                }
                } @else {
                  <p class="text-ink-faint">Address shown once the order is placed.</p>
                }
              </section>
              @if (o.breakdown; as b) {
                <section class="rounded-xl bg-white p-4">
                  <h2 class="mb-2 text-lg font-semibold">Your earnings</h2>
                  <dl class="grid grid-cols-[1fr_auto] gap-y-1 text-[15px]">
                    <dt>Order value</dt><dd>{{ rupeesExact(b.gross) }}</dd>
                    <dt>Commission</dt><dd>−{{ rupeesExact(b.commission) }}</dd>
                    <dt>GST on commission</dt><dd>−{{ rupeesExact(b.commission_gst) }}</dd>
                    <dt>TCS (GST)</dt><dd>−{{ rupeesExact(b.tcs) }}</dd>
                    <dt>TDS (income tax)</dt><dd>−{{ rupeesExact(b.tds) }}</dd>
                    <dt class="border-t border-line pt-1 font-semibold">You receive</dt><dd class="border-t border-line pt-1 font-semibold">{{ rupeesExact(b.payout) }}</dd>
                  </dl>
                  <p class="mt-2 text-xs text-ink-faint">Paid after the return window closes. TCS and TDS can be claimed in your GST and income-tax returns.</p>
                </section>
              }
              @if (o.timeline) {
                <section class="rounded-xl bg-white p-4">
                  <h2 class="mb-2 text-lg font-semibold">History</h2>
                  <ol class="flex flex-col gap-1.5 text-sm">
                    @for (e of o.timeline; track $index) {
                      <li><span class="text-ink-faint">{{ dateTime(e.at) }}</span> {{ subStatus[e.to] ?? e.to }}{{ e.note ? ": " + e.note : "" }}</li>
                    }
                  </ol>
                </section>
              }
            </div>
          </div>
        </div>

        <!-- Packing slip / tax summary, printed on A4 -->
        <div class="hidden print:block">
          <h1 class="text-2xl font-bold">Packing slip and tax summary</h1>
          <p>Order {{ o.number }} ({{ o.order_number }}), {{ dateTime(o.created_at) }}, {{ o.payment_method === "cod" ? "COD: collect " + rupeesExact(o.cod_to_collect ?? o.total) : "Prepaid" }}</p>
          <p class="mt-2"><strong>Sold by:</strong> {{ session.user()?.seller?.display_name }}</p>
          @if (o.ship_to; as a) {
            <p><strong>Ship to:</strong> {{ a["full_name"] }}, {{ a["phone"] }}, {{ join([a["line1"], a["line2"], a["landmark"], a["city"], a["state"], a["pincode"]]) }}</p>
            @if (a["delivery_slot"]) {<p><strong>Preferred delivery time:</strong> {{ a["delivery_slot"] }}</p>}
            @if (a["gift_message"]) {<p><strong>Gift message:</strong> {{ a["gift_message"] }}</p>}
          }
          <table class="mt-3 w-full border-collapse text-sm">
            <thead><tr>@for (h of slipHead; track h) {<th class="border border-ink p-1 text-left">{{ h }}</th>}</tr></thead>
            <tbody>
              @for (it of o.items; track $index; let i = $index) {
                <tr>
                  <td class="border border-ink p-1">{{ it.title }}{{ it.variant_label ? " (" + it.variant_label + ")" : "" }}</td>
                  <td class="border border-ink p-1">{{ it.sku }}</td>
                  @if (o.items_tax?.[i]; as t) {
                    <td class="border border-ink p-1">{{ t.hsn_code }}</td>
                    <td class="border border-ink p-1">{{ it.qty }}</td>
                    <td class="border border-ink p-1">{{ rupeesExact(t.taxable_value) }}</td>
                    <td class="border border-ink p-1">{{ pct(t.gst_bps) }}</td>
                    <td class="border border-ink p-1">{{ rupeesExact(t.cgst) }}</td>
                    <td class="border border-ink p-1">{{ rupeesExact(t.sgst) }}</td>
                    <td class="border border-ink p-1">{{ rupeesExact(t.igst) }}</td>
                  } @else {
                    <td class="border border-ink p-1"></td>
                    <td class="border border-ink p-1">{{ it.qty }}</td>
                    <td class="border border-ink p-1"></td><td class="border border-ink p-1"></td><td class="border border-ink p-1"></td>
                    <td class="border border-ink p-1"></td><td class="border border-ink p-1"></td>
                  }
                  <td class="border border-ink p-1">{{ rupeesExact(it.line_total) }}</td>
                </tr>
              }
            </tbody>
          </table>
          <p class="mt-2">Delivery charge: {{ rupeesExact(o.shipping_fee) }}. Order total: {{ rupeesExact(o.total) }}.</p>
        </div>

        <pc-modal [open]="shipOpen()" (close)="shipOpen.set(false)" title="Shipping details">
          <form class="flex flex-col gap-3" (submit)="submitShip($event)">
            <pc-text-field label="Courier" [(value)]="courier" placeholder="e.g. Delhivery, DTDC, India Post" [required]="true" />
            <pc-text-field label="Tracking number (AWB)" [(value)]="awb" [required]="true" />
            <pc-text-field label="Tracking link (optional)" type="url" [(value)]="trackingUrl" placeholder="https://" />
            <pc-error-note [message]="error()" />
            <button pcButton type="submit" [loading]="busy()">Mark as shipped</button>
          </form>
        </pc-modal>
        <pc-modal [open]="rtoOpen()" (close)="rtoOpen.set(false)" title="Package returned to you?">
          <form class="flex flex-col gap-3" (submit)="submitRto($event)">
            <pc-error-note [message]="error()" />
            <p class="text-ink-soft">
              Use this when your courier brought the package back undelivered (refused, nobody at home, address not found). The order is cancelled, the
              stock goes back to your warehouse{{ o.payment_method === "online" ? " and the customer is refunded" : "" }}. No sale is paid for it.
            </p>
            <pc-text-field label="What happened (optional)" [(value)]="rtoNote" [maxlength]="200" placeholder="For example: customer refused the package" />
            <button pcButton type="submit" variant="danger" [loading]="busy()">Mark as returned to me</button>
          </form>
        </pc-modal>
        <pc-modal [open]="rejectOpen()" (close)="rejectOpen.set(false)" title="Cancel this order?">
          <p class="mb-3 text-ink-soft">The customer is notified and refunded in full. Frequent cancellations affect your seller rating.</p>
          <form class="flex flex-col gap-3" (submit)="submitReject($event, o)">
            <pc-error-note [message]="error()" />
            <pc-field label="Reason" for="rr">
              <select pcSelect id="rr" (change)="reason.set($any($event.target).value)">
                @for (r of reasons; track r[0]) {<option [value]="r[0]" [selected]="r[0] === reason()">{{ r[1] }}</option>}
              </select>
            </pc-field>
            @if (reason() === "out_of_stock") {
              @if (o.items.length > 1) {
                <fieldset class="flex flex-col gap-1.5" data-testid="oos-items">
                  <legend class="mb-1 text-sm font-medium">Which items are out of stock?</legend>
                  @for (it of o.items; track $index) {
                    @if (it.id) {
                      <label class="flex items-start gap-2 text-sm">
                        <input type="checkbox" class="mt-0.5 h-4 w-4 accent-peacock" [checked]="!keepIds().includes(it.id)" (change)="toggleKeep(it.id, $any($event.target).checked)" />
                        <span>{{ it.title }}{{ it.variant_label ? ", " + it.variant_label : "" }}</span>
                      </label>
                    }
                  }
                  <p class="text-sm text-ink-soft">Their stock in this order&apos;s warehouse is set to 0 so they stop selling. Other items keep their stock.</p>
                </fieldset>
              } @else {
                <p class="text-sm text-ink-soft">Its stock in this order&apos;s warehouse is set to 0 so it stops selling.</p>
              }
            }
            <pc-text-field label="Note (optional)" [(value)]="rejectNote" [maxlength]="200" />
            <button pcButton type="submit" variant="buy" [loading]="busy()">Cancel order</button>
          </form>
        </pc-modal>
      </div>
    } @else if (error()) {
      <pc-error-note [message]="error()" />
    } @else {
      <pc-page-loader />
    }
  `,
})
export class SellerOrdersIdPage {
  readonly id = input.required<string>();
  private readonly toast = inject(Toast);
  protected readonly session = inject(SessionService);
  protected readonly Truck = Truck;
  protected readonly PackageCheck = PackageCheck;
  protected readonly FileText = FileText;
  protected readonly Printer = Printer;
  protected readonly reasons = REJECT_REASONS;
  protected readonly subStatus: Record<string, string | undefined> = SUB_STATUS_LABEL;
  protected readonly slipHead = ["Item", "SKU", "HSN", "Qty", "Taxable", "GST", "CGST", "SGST", "IGST", "Total"];
  protected readonly rupees = rupees;
  protected readonly rupeesExact = rupeesExact;
  protected readonly dateTime = dateTime;
  protected readonly pct = pct;

  protected readonly o = signal<SellerOrder | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly shipOpen = signal(false);
  protected readonly rejectOpen = signal(false);
  protected readonly courier = signal("");
  protected readonly awb = signal("");
  protected readonly trackingUrl = signal("");
  protected readonly reason = signal("out_of_stock");
  protected readonly rejectNote = signal("");
  protected readonly keepIds = signal<string[]>([]); // out of stock: items the seller unticked (they still have stock)
  protected readonly rtoOpen = signal(false); // the seller's courier brought the package back (RTO)
  protected readonly rtoNote = signal("");
  protected readonly provider = signal("manual");

  protected readonly sub = computed(() => {
    const o = this.o()!;
    return `Placed ${dateTime(o.created_at)}, ${o.payment_method === "cod" ? "cash on delivery: collect " + rupees(o.cod_to_collect ?? o.total) : "prepaid"}`;
  });
  // Our own delivery partners carry this order: either it is already with the fleet, or the fleet must take it.
  protected readonly fleetOnly = computed(() => {
    const f = this.o()?.fleet;
    return !!f && (f.active || (f.eligible && !f.choice));
  });
  protected readonly canHandOver = computed(() => {
    const o = this.o();
    const f = o?.fleet;
    return !!o && !!f && f.eligible && !f.active && ["confirmed", "packed"].includes(o.status);
  });
  // while our delivery partner is on the way, keep the partner and step fresh
  private readonly following = computed(() => {
    const o = this.o();
    return !!o?.fleet?.active && ["packed", "shipped"].includes(o.status);
  });

  constructor() {
    api<{ provider: string }>("/api/seller/shipping").then((r) => this.provider.set(r.provider)).catch(() => {});
    effect(() => {
      this.id();
      void this.load();
    });
    usePolling(() => void this.load(), 20_000, this.following);
  }

  private load(): Promise<void> {
    return api<SellerOrder>(`/api/seller/orders/${this.id()}`).then((o) => this.o.set(o)).catch((e) => this.error.set(e.message));
  }

  protected async bookCourier(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<{ courier_name: string; tracking_number: string }>(`/api/seller/orders/${this.id()}/book-courier`, { method: "POST" });
      await this.load();
      this.toast.show(`Booked with ${r.courier_name}, AWB ${r.tracking_number}`);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not book the courier");
    } finally {
      this.busy.set(false);
    }
  }

  protected async act(path: string, body?: object, msg?: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/seller/orders/${this.id()}/${path}`, { method: "POST", body });
      await this.load();
      this.toast.show(msg ?? "Updated");
      this.shipOpen.set(false);
      this.rejectOpen.set(false);
      this.rtoOpen.set(false);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not update");
    } finally {
      this.busy.set(false);
    }
  }

  protected invoice(o: SellerOrder): void {
    void openPdf(`/api/seller/orders/${o.id}/invoice.pdf`, (m) => this.toast.show(m, "error"));
  }

  protected print(): void {
    window.print();
  }

  protected join(parts: (string | undefined)[]): string {
    return parts.filter(Boolean).join(", ");
  }

  protected toggleKeep(id: string, checked: boolean): void {
    this.keepIds.update((k) => (checked ? k.filter((x) => x !== id) : [...k, id]));
  }

  protected submitShip(e: Event): void {
    e.preventDefault();
    void this.act("ship", { courier_name: this.courier(), tracking_number: this.awb(), tracking_url: this.trackingUrl() || null }, "Marked as shipped");
  }

  protected submitRto(e: Event): void {
    e.preventDefault();
    void this.act("rto", { note: this.rtoNote() }, "Marked as returned. The order is cancelled.");
  }

  protected submitReject(e: Event, o: SellerOrder): void {
    e.preventDefault();
    const reject = { reason: this.reason(), note: this.rejectNote() };
    const ids = o.items.map((it) => it.id).filter((x): x is string => !!x);
    const gone = ids.filter((x) => !this.keepIds().includes(x));
    if (reject.reason === "out_of_stock" && ids.length > 1 && gone.length === 0) return void this.error.set("Tick the items that are out of stock");
    void this.act("reject", reject.reason === "out_of_stock" && ids.length > 1 ? { ...reject, out_of_stock_items: gone } : reject, "Order cancelled");
  }
}
