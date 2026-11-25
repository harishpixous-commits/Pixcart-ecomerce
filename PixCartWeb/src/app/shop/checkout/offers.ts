/* Coupons and offers at checkout: type a code or pick one of the offers on show. The server checks every code. Port of components/checkout/offers.tsx. */

import { ChangeDetectionStrategy, Component, input, output, signal } from "@angular/core";
import { BadgePercent, CircleAlert, CircleCheck, Tag, TicketPercent } from "lucide-angular";
import { date, rupees } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { Button } from "../../shared/ui/ui";
import { CARD, CardHeading } from "./card";

export type OfferCoupon = { code: string; description: string; min_order_paise: number; max_discount_paise?: number | null; ends_at?: string | null };
export type AppliedCoupon = { code: string; discount: number; description?: string };

@Component({
  selector: "pc-coupon-section",
  imports: [Icon, Button, CardHeading],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section aria-labelledby="co-coupon-h" data-testid="checkout-coupons" [class]="CARD">
      <div pcCardHeading headingId="co-coupon-h" [icon]="TicketPercent" tone="marigold" title="Coupons and offers" [sub]="applied() ? undefined : 'Apply a code to save on this order.'"></div>
      @if (applied(); as a) {
        <div class="flex items-center gap-3 rounded-xl border border-dashed border-leaf/50 bg-leaf-light p-3" data-testid="coupon-applied">
          <svg [pcIcon]="CircleCheck" class="h-6 w-6 shrink-0 text-leaf" />
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-ink"><span class="tracking-wide text-leaf">{{ a.code }}</span> applied</p>
            <p class="text-sm text-ink-soft">You save <span class="font-semibold text-leaf">{{ fmt(a.discount) }}</span>{{ a.description ? " · " + a.description : "" }}</p>
          </div>
          <button pcButton variant="ghost" size="sm" (click)="text.set(''); remove.emit()">Remove</button>
        </div>
      } @else {
        <form class="flex gap-2" (submit)="submit($event)">
          <label for="co-coupon" class="sr-only">Coupon code</label>
          <div class="relative min-w-0 flex-1">
            <svg [pcIcon]="Tag" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
            <input id="co-coupon" [value]="text()" (input)="onInput($event)" placeholder="Enter coupon code" autocomplete="off" autocapitalize="characters"
              spellcheck="false" maxlength="30" [attr.aria-invalid]="!!error()" [attr.aria-describedby]="error() ? 'co-coupon-error' : null"
              class="h-10 w-full rounded-lg border border-line bg-white pl-9 pr-3 font-semibold uppercase tracking-wide text-ink placeholder:font-normal placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-faint focus:border-peacock focus:outline-none focus:ring-2 focus:ring-peacock/20" />
          </div>
          <button pcButton type="submit" variant="secondary" [loading]="checking()" [disabled]="!text().trim()">Apply</button>
        </form>
        @if (error(); as e) {
          <p id="co-coupon-error" role="alert" class="mt-2 flex items-start gap-1.5 text-sm text-vermilion">
            <svg [pcIcon]="CircleAlert" class="mt-0.5 h-4 w-4 shrink-0" />
            <span><span class="font-semibold">{{ e.code }}:</span> {{ e.message }}</span>
          </p>
        }
        @if (offers().length > 0) {
          <p class="mb-2 mt-4 text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Available offers</p>
          <ul class="flex flex-col gap-2">
            @for (o of offers(); track o.code) {
              <li class="flex items-center gap-3 rounded-xl border border-dashed border-peacock/40 bg-peacock-light/30 p-3">
                <svg [pcIcon]="BadgePercent" class="h-5 w-5 shrink-0 text-peacock" />
                <div class="min-w-0 flex-1">
                  <p class="font-bold tracking-wide text-peacock">{{ o.code }}</p>
                  @if (o.description) {<p class="text-sm leading-snug text-ink-soft">{{ o.description }}</p>}
                  @if (o.min_order_paise > 0 || o.ends_at) {<p class="mt-0.5 text-xs text-ink-faint">{{ terms(o) }}</p>}
                </div>
                <button pcButton size="sm" variant="secondary" [attr.aria-label]="'Apply ' + o.code" [disabled]="checking()" (click)="text.set(o.code); apply.emit(o.code)">Apply</button>
              </li>
            }
          </ul>
        }
      }
    </section>
  `,
})
export class CouponSection {
  readonly applied = input<AppliedCoupon | null>(null);
  readonly error = input<{ code: string; message: string } | null>(null);
  readonly offers = input<OfferCoupon[]>([]);
  /** A code is being checked (the bill is being worked out again). */
  readonly checking = input(false);
  readonly apply = output<string>();
  readonly remove = output<void>();
  /** The shopper is typing a new code: clears the last error. */
  readonly edit = output<void>();
  protected readonly text = signal("");
  protected readonly fmt = rupees;
  protected readonly CARD = CARD;
  protected readonly TicketPercent = TicketPercent;
  protected readonly CircleCheck = CircleCheck;
  protected readonly CircleAlert = CircleAlert;
  protected readonly Tag = Tag;
  protected readonly BadgePercent = BadgePercent;

  protected onInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = el.value.toUpperCase();
    if (el.value !== v) {
      const pos = el.selectionStart;
      el.value = v;
      if (pos !== null) el.setSelectionRange(pos, pos);
    }
    this.text.set(v);
    this.edit.emit();
  }

  protected submit(e: Event): void {
    e.preventDefault();
    if (this.text().trim()) this.apply.emit(this.text().trim());
  }

  protected terms(o: OfferCoupon): string {
    return [o.min_order_paise > 0 ? `On orders of ${rupees(o.min_order_paise)} or more` : "", o.ends_at ? `Valid till ${date(o.ends_at)}` : ""].filter(Boolean).join(" · ");
  }
}
