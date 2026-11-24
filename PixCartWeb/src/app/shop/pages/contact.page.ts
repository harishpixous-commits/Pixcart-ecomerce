/* Contact us: orders help, the contact list, social links and the registered office. Port of frontend/src/app/(shop)/contact/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject } from "@angular/core";
import { setPageTitle } from "../../core/brand";
import { SiteService } from "../../core/site";
import { ContactList, SocialLinks } from "../../shared/chrome/social";
import { PcLink } from "../../shared/ui/link";

@Component({
  selector: "pc-shop-contact-page",
  imports: [ContactList, SocialLinks, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <article class="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 class="text-3xl font-semibold">{{ site().contact.title || "Contact us" }}</h1>
      <div class="grid gap-4 md:grid-cols-2">
        <section class="rounded-xl bg-white p-5">
          <h2 class="mb-3 text-lg font-semibold">Questions about an order?</h2>
          <p class="mb-3 text-ink-soft">Open the order in Your orders to track, cancel or return it. For anything else, raise a request and we reply within 48 hours.</p>
          <div class="flex flex-wrap gap-2">
            <a pcLink="/orders" class="rounded-lg border border-line px-4 py-2 font-semibold">Your orders</a>
            <a pcLink="/support/new" class="rounded-lg bg-peacock px-4 py-2 font-semibold text-white">Get help</a>
          </div>
        </section>
        @if (contactOn()) {
          <section class="rounded-xl bg-white p-5">
            <h2 class="mb-3 text-lg font-semibold">Reach us</h2>
            <pc-contact-list [items]="site().contact.items" tone="dark" />
          </section>
        }
        @if (socialOn()) {
          <section class="rounded-xl bg-white p-5">
            <h2 class="mb-3 text-lg font-semibold">{{ site().social.title || "Follow us" }}</h2>
            <pc-social-links [links]="site().social.links" tone="dark" />
          </section>
        }
        @if (b().legal_name || b().registered_address) {
          <section class="rounded-xl bg-white p-5">
            <h2 class="mb-3 text-lg font-semibold">Registered office</h2>
            <p class="font-medium">{{ b().legal_name }}</p>
            @if (b().registered_address) {<p class="whitespace-pre-line text-ink-soft">{{ b().registered_address }}</p>}
            @if (b().gstin) {<p class="text-sm text-ink-faint">GSTIN {{ b().gstin }}</p>}
            @if (b().cin) {<p class="text-sm text-ink-faint">CIN {{ b().cin }}</p>}
            <a pcLink="/help/grievance" class="mt-2 inline-block text-sm font-semibold text-peacock">Grievance officer</a>
          </section>
        }
      </div>
    </article>
  `,
})
export class ShopContactPage {
  protected readonly site = inject(SiteService).site;
  protected readonly b = computed(() => this.site().business);
  protected readonly contactOn = computed(() => this.site().contact.enabled && this.site().contact.items.some((i) => i.enabled));
  protected readonly socialOn = computed(() => this.site().social.enabled && this.site().social.links.some((l) => l.enabled && l.url));
  constructor() {
    effect(() => setPageTitle(this.site().contact.title || "Contact us"));
  }
}
