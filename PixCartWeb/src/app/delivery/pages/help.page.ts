/* Partner help: call or message the delivery team, and the common questions. Port of frontend/src/app/delivery/help/page.tsx. */

import { ChangeDetectionStrategy, Component, computed } from "@angular/core";
import { ChevronDown, LifeBuoy, MessageCircle, Phone } from "lucide-angular";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { deliveryOptions } from "../components/partner";

const FAQ: [string, string][] = [
  ["I did not get any requests", "Make sure you are Online, your phone's location is on and the partner app is open (or installed). Requests go to partners near the store first."],
  ["How long do I have to accept a request?", "The timer on the request shows the seconds left. If you do not accept in time, the request goes to the next partner."],
  ["The seller does not have my pickup code", "The pickup code is on the seller's order screen. Ask them to open the order; if it still does not match, call the delivery team."],
  ["The customer is not answering", "Call them from the order screen. If you cannot reach them, mark the attempt as failed with the reason; the team will plan the next try."],
  ["The customer has no OTP", "The OTP is on the customer's order page and in their SMS. Do not hand over the package without it."],
  ["When are payouts made?", "Every week for the deliveries of the previous Monday to Sunday. You can see each payout in Earnings."],
  ["How do I deposit cash collected?", "Hand it to the delivery team or pay by UPI to the business account. The team records it and your cash in hand goes down."],
];

@Component({
  selector: "pc-delivery-help-page",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4 pt-2", "data-testid": "partner-help" },
  template: `
    <section class="rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-6 text-white shadow-sm">
      <svg [pcIcon]="LifeBuoy" class="h-9 w-9" />
      <h1 class="mt-2 text-2xl font-bold">How can we help?</h1>
      <p class="text-white/80">The delivery team is here for you during deliveries.</p>
      <div class="mt-4 grid gap-2 sm:grid-cols-2">
        @if (o()?.support_phone) {
          <a [href]="'tel:' + o()!.support_phone" class="flex items-center justify-center gap-2 rounded-xl bg-white py-3 font-semibold text-peacock"><svg [pcIcon]="Phone" class="h-5 w-5" /> Call {{ o()!.support_phone }}</a>
        }
        @if (wa()) {
          <a [href]="'https://wa.me/' + (wa().length === 10 ? '91' + wa() : wa())" target="_blank" rel="noreferrer" class="flex items-center justify-center gap-2 rounded-xl bg-leaf py-3 font-semibold text-white"><svg [pcIcon]="MessageCircle" class="h-5 w-5" /> WhatsApp us</a>
        }
        <a pcLink="/support" class="flex items-center justify-center gap-2 rounded-xl bg-white/15 py-3 font-semibold ring-1 ring-white/40">Write to support</a>
      </div>
    </section>
    <section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
      <h2 class="text-lg font-semibold">Common questions</h2>
      <div class="mt-2 divide-y divide-line">
        @for (f of faq; track f[0]) {
          <details class="group py-3">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold">{{ f[0] }}<svg [pcIcon]="ChevronDown" class="h-5 w-5 shrink-0 text-ink-faint transition-transform group-open:rotate-180" /></summary>
            <p class="mt-2 text-ink-soft">{{ f[1] }}</p>
          </details>
        }
      </div>
    </section>
  `,
})
export class DeliveryHelpPage {
  protected readonly o = deliveryOptions();
  protected readonly wa = computed(() => this.o()?.support_whatsapp?.replace(/\D/g, "") ?? "");
  protected readonly faq = FAQ;
  protected readonly LifeBuoy = LifeBuoy;
  protected readonly Phone = Phone;
  protected readonly MessageCircle = MessageCircle;
  protected readonly ChevronDown = ChevronDown;
}
