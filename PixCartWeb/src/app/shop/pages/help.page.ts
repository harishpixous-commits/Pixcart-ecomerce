/* The help centre: chat, support requests, things you can do and the policies. Port of frontend/src/app/(shop)/help/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import {
  Bell, CreditCard, FileText, Headphones, LifeBuoy, MapPin, MessageCircle, Package, RotateCcw, Scale, ShieldCheck, Truck, UserCog,
} from "lucide-angular";
import { SessionService } from "../../core/session";
import { SiteService } from "../../core/site";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

const CARDS = [
  { href: "/orders", icon: Package, title: "Your orders", text: "Track packages, cancel or download invoices" },
  { href: "/help/returns", icon: RotateCcw, title: "Returns and refunds", text: "Return items and check refund status" },
  { href: "/orders", icon: Truck, title: "Track a package", text: "See where your package is right now" },
  { href: "/account", icon: MapPin, title: "Manage addresses", text: "Add, change or remove delivery addresses" },
  { href: "/pages/shipping-policy", icon: CreditCard, title: "Payments and cash on delivery", text: "UPI, cards, net banking and pay on delivery" },
  { href: "/account", icon: UserCog, title: "Account and privacy", text: "Profile, marketing consent, download or delete data" },
  { href: "/support", icon: LifeBuoy, title: "Raise a support request", text: "Tell us what went wrong; we reply within 48 hours" },
  { href: "/alerts", icon: Bell, title: "Your alerts", text: "Back-in-stock and price-drop alerts" },
  { href: "/help/grievance", icon: Scale, title: "Grievance redressal", text: "Contact the grievance officer" },
  { href: "/contact", icon: Headphones, title: "Contact us", text: "Phone, email and address" },
];

const POLICIES = [["Terms of use", "/pages/terms"], ["Privacy policy", "/pages/privacy"], ["Returns and refunds policy", "/pages/returns-policy"], ["Shipping policy", "/pages/shipping-policy"]];

@Component({
  selector: "pc-shop-help-page",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4">
      <section class="rounded-xl bg-white p-5 sm:p-8">
        <h1 class="text-2xl font-semibold sm:text-3xl">Hello{{ first() }}. What can we help you with?</h1>
        <p class="mt-1 text-ink-soft">Most answers are one click away. For anything else, chat with us or raise a request.</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button type="button" (click)="chat()" class="flex items-center gap-2 rounded-full bg-peacock px-5 py-2.5 font-semibold text-white hover:bg-peacock-dark">
            <svg [pcIcon]="MessageCircle" class="h-5 w-5" /> Chat with us
          </button>
          <a pcLink="/support" class="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 font-semibold hover:bg-mist"><svg [pcIcon]="LifeBuoy" class="h-5 w-5" /> Raise a request</a>
        </div>
      </section>
      <section aria-labelledby="help-actions" class="flex flex-col gap-3">
        <h2 id="help-actions" class="px-1 text-xl font-semibold">Some things you can do here</h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="help-cards">
          @for (c of cards; track c.title) {
            <a [pcLink]="c.href" class="flex items-start gap-3 rounded-xl bg-white p-4 ring-1 ring-transparent transition hover:ring-peacock">
              <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-peacock-light text-peacock"><svg [pcIcon]="c.icon" class="h-5 w-5" /></span>
              <span><span class="block font-semibold">{{ c.title }}</span><span class="text-sm text-ink-soft">{{ c.text }}</span></span>
            </a>
          }
        </div>
      </section>
      <section class="grid gap-3 sm:grid-cols-2">
        <div class="rounded-xl bg-white p-4 sm:p-5">
          <h2 class="mb-2 flex items-center gap-2 text-lg font-semibold"><svg [pcIcon]="FileText" class="h-5 w-5 text-peacock" /> Policies</h2>
          <ul class="flex flex-col gap-1.5">
            @for (p of policies; track p[1]) {<li><a [pcLink]="p[1]" class="text-peacock hover:underline">{{ p[0] }}</a></li>}
          </ul>
        </div>
        <div class="rounded-xl bg-white p-4 sm:p-5">
          <h2 class="mb-2 flex items-center gap-2 text-lg font-semibold"><svg [pcIcon]="ShieldCheck" class="h-5 w-5 text-peacock" /> Shopping safely on {{ site().brand_name || "our store" }}</h2>
          <p class="text-sm text-ink-soft">Every seller is verified. Seller details, GSTIN and the grievance officer are on each product page. We never ask for your OTP, PIN or card details over the phone.</p>
        </div>
      </section>
    </div>
  `,
})
export class ShopHelpPage {
  private readonly session = inject(SessionService);
  protected readonly site = inject(SiteService).site;
  protected readonly cards = CARDS;
  protected readonly policies = POLICIES;
  protected readonly MessageCircle = MessageCircle;
  protected readonly LifeBuoy = LifeBuoy;
  protected readonly FileText = FileText;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly first = computed(() => {
    const name = this.session.user()?.name;
    return name ? `, ${name.split(" ")[0]}` : "";
  });
  /** the shop assistant listens for this event (components/shop-assistant) */
  protected chat(): void {
    window.dispatchEvent(new CustomEvent("shop-assistant:open"));
  }
}
