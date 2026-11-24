/*
 * Luxe footer: white, quiet and spacious. The brand name set large in the serif with a short gold rule and the tagline;
 * the owner's link columns and contact details under small capitals; social links; the grievance officer (required by
 * the Consumer Protection (E-Commerce) Rules 2020) on its own row; the legal line at the bottom.
 * What it shows comes from footerData(); this file only arranges and styles it. Port of themes/luxe/footer.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { SiteService } from "../../core/site";
import { ContactList, SocialLinks } from "../../shared/chrome/social";
import { FooterLink, footerData } from "../../shared/shop/shop-chrome";
import { PcLink } from "../../shared/ui/link";

const HEADING = "text-[11px] font-medium uppercase tracking-[0.16em] text-ink";
const LINK = "text-ink-soft transition-colors hover:text-ink";

@Component({
  selector: "pc-luxe-footer",
  imports: [PcLink, SocialLinks, ContactList, FooterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <footer class="mt-16 border-t border-line bg-white pb-20 sm:mt-20 sm:pb-0">
      <div class="mx-auto max-w-shop px-3 sm:px-4">
        <div class="grid gap-12 py-14 sm:py-16 lg:grid-cols-12 lg:gap-10 lg:py-20">
          <div class="lg:col-span-4">
            <a pcLink="/" class="font-display text-[34px] leading-none text-ink transition-colors hover:text-ink-soft sm:text-[40px]">{{ f().site.brand_name }}</a>
            <span aria-hidden="true" class="mt-6 block h-px w-16 bg-marigold"></span>
            @if (f().site.tagline) {<p class="mt-6 max-w-xs text-[15px] leading-relaxed text-ink-soft">{{ f().site.tagline }}</p>}
            @if (f().socialOn) {
              <div class="mt-8">
                @if (f().site.social.title) {<p [class]="HEADING">{{ f().site.social.title }}</p>}
                <pc-social-links [links]="f().site.social.links" tone="dark" iconClass="h-[18px] w-[18px]"
                  listClass="mt-4 gap-3 [&_a]:h-10 [&_a]:w-10 [&_a]:bg-transparent [&_a]:text-ink [&_a]:ring-1 [&_a]:ring-line" />
              </div>
            }
          </div>
          @if (f().columns.length > 0 || f().contactOn) {
            <div class="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:col-span-8 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none">
              @for (col of f().columns; track col.title) {
                <nav [attr.aria-label]="col.title" class="min-w-0">
                  <p [class]="HEADING">{{ col.title }}</p>
                  <ul class="mt-5 flex flex-col gap-3 text-[14px]">
                    @for (l of col.links; track l.href + l.label) {
                      <li><pc-footer-link [href]="l.href" [label]="l.label" [linkClass]="LINK" /></li>
                    }
                  </ul>
                </nav>
              }
              @if (f().contactOn) {
                <div class="min-w-0">
                  <p [class]="HEADING">{{ f().site.contact.title || "Contact us" }}</p>
                  <div class="mt-5 text-[14px] text-ink-soft [&_a]:font-normal [&_a]:text-ink [&_a]:[overflow-wrap:anywhere] [&_svg]:text-ink-faint">
                    <pc-contact-list [items]="f().site.contact.items" tone="dark" />
                  </div>
                </div>
              }
            </div>
          }
        </div>
        @if (f().grievance; as g) {
          <section aria-label="Grievance officer" class="grid gap-4 border-t border-line py-10 lg:grid-cols-12 lg:gap-10" data-testid="footer-grievance">
            <p [class]="HEADING + ' lg:col-span-4'">Grievance officer</p>
            <div class="flex flex-col gap-1.5 text-[14px] text-ink-soft lg:col-span-8 lg:flex-row lg:flex-wrap lg:items-baseline lg:gap-x-8 lg:gap-y-2">
              <p class="text-ink">{{ g.name }}{{ g.designation ? ", " + g.designation : "" }}</p>
              @if (g.email) {<a [href]="'mailto:' + g.email" [class]="LINK + ' break-all'">{{ g.email }}</a>}
              @if (g.phone) {<p>{{ g.phone }}</p>}
              @if (g.hours) {<p>{{ g.hours }}</p>}
              <a pcLink="/help/grievance" class="mt-2 w-fit text-ink underline decoration-marigold underline-offset-[6px] transition-colors hover:decoration-ink lg:mt-0">How to raise a complaint</a>
            </div>
          </section>
        }
      </div>
      @if (f().copyright || f().business) {
        <div class="border-t border-line">
          <div class="mx-auto flex max-w-shop flex-col gap-1.5 px-3 py-6 text-[12px] leading-relaxed text-ink-soft sm:px-4">
            @if (f().copyright) {<p>{{ f().copyright }}</p>}
            @if (f().business) {<p>{{ f().business }}</p>}
          </div>
        </div>
      }
    </footer>
  `,
})
export class LuxeFooter {
  private readonly site = inject(SiteService).site;
  protected readonly f = computed(() => footerData(this.site()));
  protected readonly HEADING = HEADING;
  protected readonly LINK = LINK;
}
