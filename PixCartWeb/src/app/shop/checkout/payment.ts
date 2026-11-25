/*
 * Payment at checkout: the two ways to pay, the cancellation note and the bottom pay bar on phones and tablets.
 * Port of components/checkout/payment.tsx.
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from "@angular/core";
import { Banknote, Check, ChevronUp, CircleAlert, Smartphone, Wallet } from "lucide-angular";
import { inRupees, rupees } from "../../core/format";
import { RegionalService } from "../../core/regional";
import { AcceptedPayments } from "../../shared/chrome/pay-logos";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { ErrorNote } from "../../shared/ui/ui";
import { CARD, CardHeading } from "./card";
import { SlideToPay } from "./slide-to-pay";

export type PayMethod = "online" | "cod";

const LABELS: [string, string][] = [["upi", "UPI"], ["card", "Cards"], ["netbanking", "Net banking"], ["wallet", "Wallets"], ["emi", "EMI"], ["paylater", "Pay later"]];

function methodCls(checked: boolean, disabled: boolean): string {
  return cx(
    "relative flex gap-3 rounded-2xl border-2 p-4 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-peacock has-[:focus-visible]:ring-offset-2",
    checked ? "border-peacock bg-peacock-light/40" : "border-line bg-white",
    disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
    !checked && !disabled && "hover:border-peacock/40",
  );
}

@Component({
  selector: "pc-payment-methods",
  imports: [Icon, CardHeading, AcceptedPayments, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #tick let-on>
      <span aria-hidden="true" [class]="on ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-peacock bg-peacock text-white' : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-line bg-white'">
        @if (on) {<svg [pcIcon]="Check" class="h-3 w-3" [strokeWidth]="3.5" />}
      </span>
    </ng-template>
    <section id="checkout-payment" aria-labelledby="co-pay-h" data-testid="checkout-payment" [class]="sectionCls()">
      <div pcCardHeading headingId="co-pay-h" [icon]="Wallet" title="Payment method"></div>
      <fieldset>
        <legend class="sr-only">Choose how to pay</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          <label [class]="onlineCls()">
            <input type="radio" name="pay" value="online" class="sr-only" [checked]="method() === 'online'" [disabled]="!onlineAvailable()" (change)="methodChange.emit('online')" />
            <span [class]="method() === 'online' ? 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-peacock text-white' : 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-mist text-peacock'" aria-hidden="true">
              <svg [pcIcon]="Smartphone" class="h-5 w-5" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="font-semibold text-ink">Pay online</span>
                @if (onlineAvailable()) {<span class="rounded-full bg-leaf-light px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-leaf">Instant</span>}
              </span>
              <span class="mt-0.5 block text-sm leading-snug text-ink-soft">{{ onlineAvailable() ? onlineText() : "Not available right now" }}</span>
              @if (onlineAvailable()) {
                <span class="mt-2 flex flex-wrap gap-1.5" aria-hidden="true">
                  @for (o of offered(); track o[0]) {<span class="rounded-md bg-white px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft ring-1 ring-line">{{ o[1] }}</span>}
                </span>
              }
            </span>
            <ng-container *ngTemplateOutlet="tick; context: { $implicit: method() === 'online' }" />
          </label>
          <label [class]="codCls()">
            <input type="radio" name="pay" value="cod" class="sr-only" [checked]="method() === 'cod'" [disabled]="!codAvailable()" (change)="methodChange.emit('cod')" />
            <span [class]="method() === 'cod' ? 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-peacock text-white' : 'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-mist text-peacock'" aria-hidden="true">
              <svg [pcIcon]="Banknote" class="h-5 w-5" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="font-semibold text-ink">Cash on delivery</span>
              </span>
              <span class="mt-0.5 block text-sm leading-snug text-ink-soft">{{ codText() }}</span>
            </span>
            <ng-container *ngTemplateOutlet="tick; context: { $implicit: method() === 'cod' }" />
          </label>
        </div>
      </fieldset>
      @if (onlineAvailable()) {
        <pc-accepted-payments rowClass="mt-3" [networks]="regional.data().card_networks" [methods]="regional.data().pay_methods" label="We accept" />
      }
      @if (chargedInRupees() && total()) {
        <p class="mt-3 rounded-xl bg-mist px-3 py-2 text-sm text-ink-soft" data-testid="charged-in-rupees">
          Prices are shown in {{ regional.currency() }} at today&apos;s rate. You pay <span class="font-semibold text-ink" translate="no">{{ inRupees(total()!) }}</span> in Indian rupees{{ method() === "cod" ? " in cash" : "; your bank converts it" }}.
        </p>
      }
      @if (method() === "cod" && codAllowed() === false) {
        <p class="mt-3 flex items-start gap-2 rounded-xl bg-vermilion-light px-3 py-2 text-sm text-vermilion" role="alert">
          <svg [pcIcon]="CircleAlert" class="mt-0.5 h-4 w-4 shrink-0" />
          Cash on delivery is available up to {{ fmt(codMax()) }}. Please pay online for this order.
        </p>
      }
    </section>
  `,
})
export class PaymentMethods {
  readonly method = input.required<PayMethod>();
  readonly onlineAvailable = input(true);
  readonly codAvailable = input(true);
  /** false when this order is above the cash-on-delivery limit */
  readonly codAllowed = input<boolean | undefined>(undefined);
  readonly codMax = input(0);
  /** the cash-on-delivery fee on this bill (only known once cash on delivery is chosen) */
  readonly codFee = input(0);
  readonly extraClass = input("");
  /** the bill's total in paise: shown in rupees when the shopper browses in another currency but pays in rupees */
  readonly total = input<number | undefined>(undefined);
  readonly methodChange = output<PayMethod>();

  protected readonly regional = inject(RegionalService);
  protected readonly fmt = rupees;
  protected readonly inRupees = inRupees;
  protected readonly Wallet = Wallet;
  protected readonly Smartphone = Smartphone;
  protected readonly Banknote = Banknote;
  protected readonly Check = Check;
  protected readonly CircleAlert = CircleAlert;

  protected readonly sectionCls = computed(() => cx(CARD, this.extraClass()));
  protected readonly offered = computed(() => {
    const ways = this.regional.data().pay_methods;
    return LABELS.filter(([k]) => ways[k] !== false);
  });
  protected readonly onlineText = computed(() => `${this.offered().map(([, t]) => t).join(", ").replace(/, ([^,]*)$/, " and $1")} via Razorpay`);
  protected readonly chargedInRupees = computed(() => {
    const foreign = this.regional.shop() && this.regional.currency() !== "INR";
    return foreign && (this.method() === "cod" || this.regional.data().charge_in === "base");
  });
  protected readonly onlineCls = computed(() => methodCls(this.method() === "online", !this.onlineAvailable()));
  protected readonly codCls = computed(() => methodCls(this.method() === "cod", !this.codAvailable()));
  protected readonly codText = computed(() =>
    !this.codAvailable()
      ? "Not available right now"
      : this.codAllowed() === false && this.method() !== "cod"
        ? `For orders up to ${rupees(this.codMax())}`
        : `Pay when each package arrives${this.method() === "cod" && this.codFee() ? ` (+${rupees(this.codFee())} fee)` : ""}`,
  );
}

@Component({
  selector: "pc-cancellation-note",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section aria-labelledby="co-cancel-h" [class]="CARD" data-testid="checkout-cancellation">
      <h2 id="co-cancel-h" class="font-sans text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Cancellation policy</h2>
      <p class="mt-2 text-sm leading-relaxed text-ink-soft"><span class="font-bold text-vermilion">NOTE:</span> {{ note() }}</p>
    </section>
  `,
})
export class CancellationNote {
  readonly note = input.required<string>();
  protected readonly CARD = CARD;
}

/**
 * The pay bar under the page on phones and tablets (hidden from lg up, where the bill column has its own button).
 * It is sticky, not fixed: it stays at the bottom of the screen while the checkout scrolls and settles at the end of
 * the page, so it never sits on top of the last section or the footer.
 */
@Component({
  selector: "pc-pay-bar",
  imports: [Icon, ErrorNote, SlideToPay],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="sticky bottom-0 z-40 -mx-3 border-t border-line bg-white/95 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_rgba(27,36,48,0.10)] backdrop-blur sm:-mx-4 sm:px-4 lg:hidden"
      data-testid="checkout-pay-bar">
      <div class="mx-auto flex max-w-3xl flex-col gap-2.5">
        @if (notice() && !error()) {
          <p class="flex items-start gap-1.5 text-sm font-medium text-vermilion"><svg [pcIcon]="CircleAlert" class="mt-0.5 h-4 w-4 shrink-0" /> {{ notice() }}</p>
        }
        <pc-error-note [message]="error()" />
        <div class="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
          <div class="flex min-w-0 items-center gap-3 sm:flex-1">
            <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-peacock-light text-peacock" aria-hidden="true">
              <svg [pcIcon]="online() ? Smartphone : Banknote" class="h-5 w-5" />
            </span>
            <!-- One text node after the caption, so "Cash on delivery" alone stays unique to the payment card. -->
            <p class="min-w-0 flex-1 truncate font-semibold leading-tight text-ink"><span class="block text-[11px] font-bold uppercase tracking-[0.12em] text-ink-faint">Pay using</span> {{ online() ? "Online payment" : "Cash on delivery" }}</p>
            <a href="#checkout-payment" (click)="$event.preventDefault(); change.emit()"
              class="flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1.5 text-sm font-bold uppercase tracking-wide text-peacock hover:bg-peacock-light">
              Change <svg [pcIcon]="ChevronUp" class="h-4 w-4" />
            </a>
          </div>
          <pc-slide-to-pay extraClass="sm:w-[360px] sm:shrink-0" [ariaLabel]="ariaLabel()" [loadingLabel]="online() ? 'Opening secure payment…' : 'Placing your order…'"
            (confirm)="confirm.emit()" [disabled]="disabled()" [loading]="loading()">@if (online()) {Slide to pay <span class="mx-1.5 opacity-60">|</span> {{ amount() }}} @else {Slide to place order}</pc-slide-to-pay>
        </div>
      </div>
    </div>
  `,
})
export class PayBar {
  readonly method = input.required<PayMethod>();
  /** grand total in paise (null until the bill is ready) */
  readonly total = input<number | null>(null);
  readonly disabled = input(false);
  readonly loading = input(false);
  readonly notice = input<string | null>(null);
  readonly error = input<string | null>(null);
  readonly change = output<void>();
  readonly confirm = output<void>();
  protected readonly amount = computed(() => (this.total() !== null ? rupees(this.total()!) : ""));
  protected readonly online = computed(() => this.method() === "online");
  protected readonly ariaLabel = computed(() => (this.online() ? `Slide to pay ${this.amount()}`.trim() : "Slide to place order"));
  protected readonly CircleAlert = CircleAlert;
  protected readonly Smartphone = Smartphone;
  protected readonly Banknote = Banknote;
  protected readonly ChevronUp = ChevronUp;
}
