/*
 * Fresh footer: white and compact, like the last screen of a shopping app. The brand with its tagline and social links,
 * the link columns (two per row on phones), the contact details, the grievance officer on a tinted card (with the link
 * to /help/grievance; legally required) and the legal line. What it shows comes from footerData(); this file only
 * arranges it. Phones get extra room at the bottom for the tab bar and the floating cart pill. Port of themes/fresh/footer.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { ChevronRight, ShieldCheck } from "lucide-angular";
import { SiteService } from "../../core/site";
import { ContactList, SocialLinks } from "../../shared/chrome/social";
import { FooterLink, Logo, footerData } from "../../shared/shop/shop-chrome";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

/** Link columns per row on large screens, by how many columns there are. */
const LG_COLS = ["lg:grid-cols-1", "lg:grid-cols-1", "lg:grid-cols-2", "lg:grid-cols-3", "lg:grid-cols-4"] as const;

const HEADING = "mb-2 text-xs font-extrabold uppercase tracking-wider text-ink";

@Component({
  selector: "pc-fresh-footer",
  imports: [Icon, PcLink, Logo, SocialLinks, ContactList, FooterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <footer class="mt-10 border-t border-line bg-white pb-[calc(7rem+env(safe-area-inset-bottom))] text-sm text-ink-soft sm:mt-12 sm:pb-0">
      <div class="mx-auto grid max-w-shop gap-8 px-3 py-8 sm:px-4 lg:grid-cols-12 lg:gap-10 lg:py-10">
        <div class="flex flex-col items-start gap-3 lg:col-span-3">
          <a pcLogo [light]="false"></a>
          @if (f().site.tagline) {<p class="max-w-xs leading-relaxed">{{ f().site.tagline }}</p>}
          @if (f().socialOn) {
            <div class="mt-1">
              @if (f().site.social.title) {<p [class]="HEADING">{{ f().site.social.title }}</p>}
              <pc-social-links [links]="f().site.social.links" tone="dark" />
            </div>
          }
        </div>
        @if (f().columns.length > 0) {
          <div [class]="colsCls()">
            @for (col of f().columns; track col.title) {
              <nav [attr.aria-label]="col.title" class="min-w-0">
                <p [class]="HEADING">{{ col.title }}</p>
                <ul class="flex flex-col">
                  @for (l of col.links; track l.href + l.label) {
                    <li><pc-footer-link [href]="l.href" [label]="l.label" linkClass="inline-flex min-h-[36px] items-center py-1 transition-colors hover:text-peacock lg:min-h-0" /></li>
                  }
                </ul>
              </nav>
            }
          </div>
        }
        @if (side()) {
          <div [class]="f().columns.length > 0 ? 'grid gap-4 sm:grid-cols-2 lg:grid-cols-1 lg:col-span-3' : 'grid gap-4 sm:grid-cols-2 lg:grid-cols-1 lg:col-span-9'">
            @if (f().contactOn) {
              <div class="min-w-0">
                <p [class]="HEADING">{{ f().site.contact.title || "Contact us" }}</p>
                <pc-contact-list [items]="f().site.contact.items" tone="dark" />
              </div>
            }
            @if (f().grievance; as g) {
              <div class="min-w-0 rounded-xl bg-mist p-4 ring-1 ring-line" data-testid="footer-grievance">
                <p class="flex items-center gap-2 font-bold text-ink">
                  <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-peacock ring-1 ring-line">
                    <svg [pcIcon]="ShieldCheck" class="h-4 w-4" />
                  </span>
                  Grievance officer
                </p>
                <p class="mt-2 text-ink">{{ g.name }}{{ g.designation ? ", " + g.designation : "" }}</p>
                @if (g.email) {<a [href]="'mailto:' + g.email" class="block break-all transition-colors hover:text-peacock">{{ g.email }}</a>}
                @if (g.phone) {<a [href]="'tel:' + tel(g.phone)" class="block transition-colors hover:text-peacock">{{ g.phone }}</a>}
                @if (g.hours) {<p class="mt-0.5 text-xs">{{ g.hours }}</p>}
                <a pcLink="/help/grievance" class="mt-2 inline-flex min-h-[32px] items-center gap-0.5 font-semibold text-peacock-dark hover:underline">
                  How to raise a complaint <svg [pcIcon]="ChevronRight" class="h-4 w-4" />
                </a>
              </div>
            }
          </div>
        }
      </div>
      @if (f().copyright || f().business) {
        <div class="border-t border-line">
          <div class="mx-auto flex max-w-shop flex-col gap-1 px-3 py-4 text-xs leading-relaxed text-ink-soft sm:px-4">
            @if (f().copyright) {<p>{{ f().copyright }}</p>}
            @if (f().business) {<p>{{ f().business }}</p>}
          </div>
        </div>
      }
    </footer>
  `,
})
export class FreshFooter {
  private readonly site = inject(SiteService).site;
  protected readonly f = computed(() => footerData(this.site()));
  protected readonly side = computed(() => this.f().contactOn || Boolean(this.f().grievance));
  protected readonly colsCls = computed(() =>
    cx("grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3", this.side() ? "lg:col-span-6" : "lg:col-span-9", LG_COLS[Math.min(this.f().columns.length, 4)]));
  protected readonly HEADING = HEADING;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly ChevronRight = ChevronRight;
  protected tel(p: string): string {
    return p.replace(/[^\d+]/g, "");
  }
}
