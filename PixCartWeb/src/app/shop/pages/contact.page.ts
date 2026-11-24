import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { SiteService } from "../../core/site";
import { ContactList, SocialLinks } from "../../shared/chrome/social";

@Component({
  selector: "pc-shop-contact-page",
  imports: [RouterLink, ContactList, SocialLinks],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <article class="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 class="text-3xl font-semibold">{{ site().contact.title || 'Contact us' }}</h1>
      <div class="grid gap-4 md:grid-cols-2">
        <section class="rounded-xl bg-white p-5">
          <h2 class="mb-3 text-lg font-semibold">Questions about an order?</h2>
          <p class="mb-3 text-ink-soft">Open the order in Your orders to track, cancel or return it. For anything else, raise a request and we reply within 48 hours.</p>
          <div class="flex flex-wrap gap-2">
            <a routerLink="/orders" class="rounded-lg border border-line px-4 py-2 font-semibold">Your orders</a>
            <a routerLink="/support/new" class="rounded-lg bg-peacock px-4 py-2 font-semibold text-white">Get help</a>
          </div>
        </section>
        @if (contactOn()) {
          <section class="rounded-xl bg-white p-5"><h2 class="mb-3 text-lg font-semibold">Reach us</h2><pc-contact-list [items]="site().contact.items" tone="dark" /></section>
        }
        @if (socialOn()) {
          <section class="rounded-xl bg-white p-5"><h2 class="mb-3 text-lg font-semibold">{{ site().social.title || 'Follow us' }}</h2><pc-social-links [links]="site().social.links" tone="dark" /></section>
        }
        @if (business().legal_name || business().registered_address) {
          <section class="rounded-xl bg-white p-5">
            <h2 class="mb-3 text-lg font-semibold">Registered office</h2>
            <p class="font-medium">{{ business().legal_name }}</p>
            @if (business().registered_address) { <p class="whitespace-pre-line text-ink-soft">{{ business().registered_address }}</p> }
            @if (business().gstin) { <p class="text-sm text-ink-faint">GSTIN {{ business().gstin }}</p> }
            @if (business().cin) { <p class="text-sm text-ink-faint">CIN {{ business().cin }}</p> }
            <a routerLink="/help/grievance" class="mt-2 inline-block text-sm font-semibold text-peacock">Grievance officer</a>
          </section>
        }
      </div>
    </article>
  `,
})
export class ShopContactPage {
  readonly site = inject(SiteService).site;
  readonly business = computed(() => this.site().business);
  readonly contactOn = computed(() => this.site().contact.enabled && this.site().contact.items.some(item => item.enabled));
  readonly socialOn = computed(() => this.site().social.enabled && this.site().social.links.some(link => link.enabled && link.url));
}
