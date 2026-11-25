/* Sell on the marketplace: the pitch, the numbers and the steps. Port of frontend/src/app/(shop)/sell/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject } from "@angular/core";
import { setPageTitle } from "../../core/brand";
import { SiteService } from "../../core/site";
import { ButtonLink } from "../../shared/ui/ui";

const STEPS = [
  { title: "Sign in with your mobile", body: "Use the same number you will run your shop with." },
  { title: "Add your business details", body: "GSTIN, PAN, pickup address and the bank account for payouts. Keep your PAN card, GST certificate and a cancelled cheque ready as PDF or photo." },
  { title: "Get verified", body: "Our team checks your documents, usually within two working days. You will see the result on your dashboard." },
  { title: "List products and start selling", body: "Add photos, sizes and colours, price and stock. Each listing is reviewed before it goes live." },
];

const FACTS: [string, string][] = [
  ["5–17%", "commission, by category"],
  ["0", "listing or signup fees"],
  ["Your choice", "of courier in the first phase"],
  ["Weekly", "payouts once the return window ends"],
];

@Component({
  selector: "pc-shop-sell-page",
  imports: [ButtonLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4">
      <section class="grid overflow-hidden rounded-xl bg-peacock text-white md:grid-cols-2">
        <div class="flex flex-col gap-4 p-6 sm:p-10">
          <h1 class="text-4xl font-bold sm:text-5xl">Sell to customers across India</h1>
          <p class="max-w-md text-lg text-white/85">List your products on {{ brand() }}, ship orders from your own premises and get paid to your bank account after the return window closes.</p>
          <div class="flex flex-wrap gap-3">
            <a pcButtonLink href="/signup?seller=1&next=/seller/onboarding" variant="cart" class="h-12 px-6">Start selling</a>
            <a pcButtonLink href="/seller" variant="outlineLight" class="h-12 px-6">Go to seller dashboard</a>
          </div>
        </div>
        <dl class="grid grid-cols-2 gap-px bg-white/10">
          @for (f of facts; track f[1]) {
            <div class="bg-peacock p-6">
              <dt class="font-display text-3xl font-bold text-marigold">{{ f[0] }}</dt>
              <dd class="text-white/80">{{ f[1] }}</dd>
            </div>
          }
        </dl>
      </section>
      <section class="rounded-xl bg-white p-6">
        <h2 class="mb-4 text-2xl font-semibold">How to get started</h2>
        <ol class="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          @for (s of steps; track s.title; let i = $index) {
            <li class="flex flex-col gap-2">
              <span class="flex h-9 w-9 items-center justify-center rounded-full bg-marigold font-display text-lg font-bold">{{ i + 1 }}</span>
              <p class="font-display text-lg font-semibold">{{ s.title }}</p>
              <p class="text-ink-soft">{{ s.body }}</p>
            </li>
          }
        </ol>
      </section>
      <p class="px-1 text-sm text-ink-faint">{{ brand() }} collects GST TCS and income-tax TDS on your sales as the law requires; both show on your earnings statement and can be claimed in your returns.</p>
    </div>
  `,
})
export class ShopSellPage {
  private readonly site = inject(SiteService).site;
  protected readonly brand = computed(() => this.site().brand_name);
  protected readonly steps = STEPS;
  protected readonly facts = FACTS;
  constructor() {
    effect(() => setPageTitle(`Sell on ${this.brand()}`));
  }
}
