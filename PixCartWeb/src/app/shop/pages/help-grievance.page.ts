/* Grievance redressal: the grievance officer and how to raise a complaint. Port of frontend/src/app/(shop)/help/grievance/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { SiteService } from "../../core/site";
import { PcLink } from "../../shared/ui/link";

@Component({
  selector: "pc-shop-help-grievance-page",
  imports: [PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <article class="mx-auto max-w-2xl rounded-xl bg-white p-6">
      <h1 class="mb-4 text-3xl font-semibold">Grievance redressal</h1>
      <div class="flex flex-col gap-4 text-ink-soft">
        <p>
          Under the Consumer Protection (E-Commerce) Rules, 2020, {{ operator() }} has appointed a grievance officer. We acknowledge every complaint within 48 hours
          and resolve it within one month of receiving it.
        </p>
        @if (g().name || g().email) {
          <dl class="grid grid-cols-[120px_1fr] gap-y-1 rounded-lg bg-mist p-4 text-ink">
            @if (g().name) {<dt class="text-ink-faint">Name</dt><dd>{{ g().name }}{{ g().designation ? ", " + g().designation : "" }}</dd>}
            @if (g().email) {<dt class="text-ink-faint">Email</dt><dd><a class="text-peacock" [href]="'mailto:' + g().email">{{ g().email }}</a></dd>}
            @if (g().phone) {<dt class="text-ink-faint">Phone</dt><dd>{{ g().phone }}</dd>}
            @if (g().hours) {<dt class="text-ink-faint">Hours</dt><dd>{{ g().hours }}</dd>}
            @if (b().registered_address) {<dt class="text-ink-faint">Address</dt><dd>{{ operator() }}, {{ b().registered_address }}</dd>}
          </dl>
        } @else {
          <p class="rounded-lg bg-mist p-4">Raise a complaint through our help centre and we will route it to the grievance officer.</p>
        }
        <p>
          The fastest way is a <a pcLink="/support/new?grievance=1" class="font-semibold text-peacock">grievance ticket</a>: it is tracked, and you can see every reply.
          Include your order number. Each seller also has their own grievance officer, shown on the product page.
        </p>
      </div>
    </article>
  `,
})
export class ShopHelpGrievancePage {
  private readonly site = inject(SiteService).site;
  protected readonly b = computed(() => this.site().business);
  protected readonly g = computed(() => this.b().grievance);
  protected readonly operator = computed(() => this.b().legal_name || this.site().brand_name);
}
