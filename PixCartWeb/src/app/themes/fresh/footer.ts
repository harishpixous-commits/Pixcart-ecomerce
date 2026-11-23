/*
 * Fresh footer: white and compact, like the last screen of a shopping app. The brand with its tagline and social
 * links, the link columns (two per row on phones), the contact details, the grievance officer on a tinted card (with
 * the link to /help/grievance; legally required) and the legal line. What it shows comes from footerData()
 * (Admin -> Storefront -> Navigation and footer, and Business); this file only arranges it.
 * Phones get extra room at the bottom for the tab bar and the floating cart pill.
 * Port of themes/fresh/footer.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { ChevronRight, ShieldCheck } from "lucide-angular";
import { SiteService } from "../../core/site";
import { ContactList, SocialLinks } from "../../shared/chrome/social";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { FooterLink, Logo, footerData } from "../../shared/shop/shop-chrome";

/** Link columns per row on large screens, by how many columns there are. */
const LG_COLS = ["lg:grid-cols-1", "lg:grid-cols-1", "lg:grid-cols-2", "lg:grid-cols-3", "lg:grid-cols-4"] as const;

const HEADING = "mb-2 text-xs font-extrabold uppercase tracking-wider text-ink";

@Component({
  selector: "pc-fresh-footer",
  imports: [FooterLink, Logo, SocialLinks, ContactList, Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <footer class="mt-10 border-t border-line bg-white pb-[calc(7rem+env(safe-area-inset-bottom))] text-sm text-ink-soft sm:mt-12 sm:pb-0">
      <div class="mx-auto grid max-w-shop gap-8 px-3 py-8 sm:px-4 lg:grid-cols-12 lg:gap-10 lg:py-10">
        <div class="flex flex-col items-start gap-3 lg:col-span-3">
          <a pcLogo pcLink="/" [light]="false"></a>
          @if (site().tagline) {<p class="max-w-xs leading-relaxed">{{ site().tagline }}</p>}
          @if (d().socialOn) {
            <div class="mt-1">
              @if (site().social.title) {<p [class]="HEADING">{{ site().social.title }}</p>}
              <pc-social-links [links]="site().social.links" tone="dark" />
            </div>
          }
        </div>

        @if (d().columns.length > 0) {
          <div [class]="'grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 ' + (side() ? 'lg:col-span-6' : 'lg:col-span-9') + ' ' + lgCols()">
            @for (col of d().columns; track col.title) {
              <nav [attr.aria-label]="col.title" class="min-w-0">
                <p [class]="HEADING">{{ col.title }}</p>
                <ul class="flex flex-col">
                  @for (l of col.links; track l.href + l.label) {
                    <li>
                      <pc-footer-link [href]="l.href" [label]="l.label"
                        linkClass="inline-flex min-h-[36px] items-center py-1 transition-colors hover:text-peacock lg:min-h-0" />
                    </li>
                  }
                </ul>
              </nav>
            }
          </div>
        }

        @if (side()) {
          <div [class]="'grid gap-4 sm:grid-cols-2 lg:grid-cols-1 ' + (d().columns.length > 0 ? 'lg:col-span-3' : 'lg:col-span-9')">
            @if (d().contactOn) {
              <div class="min-w-0">
                <p [class]="HEADING">{{ site().contact.title || "Contact us" }}</p>
                <pc-contact-list [items]="site().contact.items" tone="dark" />
              </div>
            }
            @if (d().grievance; as g) {
              <div class="min-w-0 rounded-xl bg-mist p-4 ring-1 ring-line" data-testid="footer-grievance">
                <p class="flex items-center gap-2 font-bold text-ink">
                  <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-peacock ring-1 ring-line">
                    <svg [pcIcon]="ShieldCheck" class="h-4 w-4" aria-hidden="true" />
                  </span>
                  Grievance officer
                </p>
                <p class="mt-2 text-ink">{{ g.name }}@if (g.designation) {, {{ g.designation }}}</p>
                @if (g.email) {<a [href]="'mailto:' + g.email" class="block break-all transition-colors hover:text-peacock">{{ g.email }}</a>}
                @if (g.phone) {<a [href]="'tel:' + phoneHref(g.phone)" class="block transition-colors hover:text-peacock">{{ g.phone }}</a>}
                @if (g.hours) {<p class="mt-0.5 text-xs">{{ g.hours }}</p>}
                <a pcLink="/help/grievance" class="mt-2 inline-flex min-h-[32px] items-center gap-0.5 font-semibold text-peacock-dark hover:underline">
                  How to raise a complaint <svg [pcIcon]="ChevronRight" class="h-4 w-4" aria-hidden="true" />
                </a>
              </div>
            }
          </div>
        }
      </div>

      @if (d().copyright || d().business) {
        <div class="border-t border-line">
          <div class="mx-auto flex max-w-shop flex-col gap-1 px-3 py-4 text-xs leading-relaxed text-ink-soft sm:px-4">
            @if (d().copyright) {<p>{{ d().copyright }}</p>}
            @if (d().business) {<p>{{ d().business }}</p>}
          </div>
        </div>
      }
    </footer>
  `,
})
export class FreshFooter {
  protected readonly site = inject(SiteService).site;
  protected readonly d = computed(() => footerData(this.site()));
  protected readonly side = computed(() => this.d().contactOn || !!this.d().grievance);
  protected readonly lgCols = computed(() => LG_COLS[Math.min(this.d().columns.length, 4)]);
  protected readonly HEADING = HEADING;
  protected readonly ChevronRight = ChevronRight;
  protected readonly ShieldCheck = ShieldCheck;

  protected phoneHref(p: string): string {
    return p.replace(/[^\d+]/g, "");
  }
}
