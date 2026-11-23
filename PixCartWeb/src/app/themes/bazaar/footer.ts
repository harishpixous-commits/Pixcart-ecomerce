/*
 * Bazaar footer: a strip of shopping promises taken from the marketplace's own settings (only what is switched on is
 * said), then a dark brand footer with the logo, the link columns, contact details, the grievance officer (required by
 * the Consumer Protection (E-Commerce) Rules 2020) and the legal line. The data comes from footerData(), like every theme.
 * Port of themes/bazaar/footer.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from "@angular/core";
import { ArrowRight, BadgeCheck, Banknote, Clock, Headset, Mail, Phone, RotateCcw, Scale, ShieldCheck, type LucideIconData } from "lucide-angular";
import { SiteService } from "../../core/site";
import type { Site } from "../../core/types";
import { ContactList, SocialLinks } from "../../shared/chrome/social";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Logo, footerData } from "../../shared/shop/shop-chrome";

interface Assurance {
  icon: LucideIconData;
  title: string;
  text: string;
  href?: string;
}

/** Only statements the settings make true. */
function assurances(site: Site): Assurance[] {
  const list: Assurance[] = [{ icon: BadgeCheck, title: "Verified sellers", text: "Seller details on every product page" }];
  if (site.cod_enabled) list.push({ icon: Banknote, title: "Cash on delivery", text: "Pay when it arrives, where available" });
  if (site.features.returns) list.push({ icon: RotateCcw, title: "Easy returns", text: "Return eligible items from your orders" });
  if (site.online_payments !== false) list.push({ icon: ShieldCheck, title: "Secure online payments", text: "Through a trusted payment gateway" });
  if (site.features.support) list.push({ icon: Headset, title: "Help when you need it", text: "Visit the help centre", href: "/help" });
  return list;
}

const HEADING = "font-display text-xs font-semibold uppercase tracking-wider text-white";

@Component({
  selector: "pc-bazaar-footer",
  imports: [Logo, SocialLinks, ContactList, Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <footer class="mt-10 bg-peacock-dark pb-20 text-white/75 sm:mt-12 sm:pb-0">
      <section aria-label="Shopping with us" class="border-y border-line bg-white text-ink">
        <ul class="mx-auto grid max-w-shop grid-cols-2 gap-x-4 gap-y-5 px-3 py-6 sm:px-4 md:grid-cols-3 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none lg:gap-x-6 lg:py-7">
          @for (a of list(); track a.title) {
            <li class="flex min-w-0 items-center gap-3 lg:justify-center">
              <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-peacock/10 text-peacock">
                <svg [pcIcon]="a.icon" class="h-[22px] w-[22px]" aria-hidden="true" />
              </span>
              <span class="min-w-0">
                <span class="block font-display text-sm font-semibold leading-snug">{{ a.title }}</span>
                @if (a.href) {
                  <a [pcLink]="a.href!" class="text-xs text-ink-soft underline-offset-2 hover:text-peacock hover:underline">{{ a.text }}</a>
                } @else {
                  <span class="block text-xs text-ink-soft">{{ a.text }}</span>
                }
              </span>
            </li>
          }
        </ul>
      </section>
      <div class="h-1 bg-marigold" aria-hidden="true"></div>
      <div class="mx-auto grid max-w-shop gap-x-8 gap-y-10 px-3 py-10 sm:px-4 md:grid-cols-12 lg:py-12">
        <div class="flex flex-col items-start gap-4 md:col-span-12 lg:col-span-3">
          <a pcLogo pcLink="/"></a>
          @if (site().tagline) {<p class="max-w-xs text-sm leading-relaxed">{{ site().tagline }}</p>}
          @if (d().socialOn) {
            <div>
              @if (site().social.title) {<p [class]="'mb-2.5 ' + HEADING">{{ site().social.title }}</p>}
              <pc-social-links [links]="site().social.links" />
            </div>
          }
        </div>
        @if (d().columns.length > 0) {
          <div class="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 md:col-span-7 lg:col-span-5">
            @for (col of d().columns; track col.title) {
              <nav [attr.aria-label]="col.title" class="flex min-w-0 flex-col items-start gap-2.5 text-sm">
                <p [class]="'mb-0.5 ' + HEADING">{{ col.title }}</p>
                @for (l of col.links; track l.href + l.label) {
                  @if (l.href.startsWith("https://")) {
                    <a [href]="l.href" target="_blank" rel="noopener noreferrer" class="text-white/75 underline-offset-2 hover:text-white hover:underline">{{ l.label }}</a>
                  } @else {
                    <a [pcLink]="l.href" class="text-white/75 underline-offset-2 hover:text-white hover:underline">{{ l.label }}</a>
                  }
                }
              </nav>
            }
          </div>
        }
        @if (d().contactOn || d().grievance) {
          <div class="flex flex-col gap-6 text-sm md:col-span-5 lg:col-span-4">
            @if (d().contactOn) {
              <div>
                <p [class]="'mb-3 ' + HEADING">{{ site().contact.title || "Contact us" }}</p>
                <pc-contact-list [items]="site().contact.items" />
              </div>
            }
            @if (d().grievance; as g) {
              <div class="rounded-xl bg-white/[0.06] p-4 ring-1 ring-white/10" data-testid="grievance-officer">
                <p [class]="'flex items-center gap-2 ' + HEADING">
                  <svg [pcIcon]="Scale" class="h-4 w-4 text-marigold" aria-hidden="true" /> Grievance officer
                </p>
                <p class="mt-2.5 font-semibold text-white">
                  {{ g.name }}@if (g.designation) {<span class="font-normal text-white/75">, {{ g.designation }}</span>}
                </p>
                <div class="mt-1.5 flex flex-col gap-1">
                  @if (g.email) {
                    <a [href]="'mailto:' + g.email" class="flex min-w-0 items-center gap-2 hover:text-white">
                      <svg [pcIcon]="Mail" class="h-4 w-4 shrink-0 text-white/60" aria-hidden="true" /><span class="truncate">{{ g.email }}</span>
                    </a>
                  }
                  @if (g.phone) {
                    <a [href]="'tel:' + tel(g.phone)" class="flex items-center gap-2 hover:text-white">
                      <svg [pcIcon]="Phone" class="h-4 w-4 shrink-0 text-white/60" aria-hidden="true" />{{ g.phone }}
                    </a>
                  }
                  @if (g.hours) {
                    <p class="flex items-start gap-2"><svg [pcIcon]="Clock" class="mt-0.5 h-4 w-4 shrink-0 text-white/60" aria-hidden="true" />{{ g.hours }}</p>
                  }
                </div>
                <a pcLink="/help/grievance" class="mt-3 inline-flex items-center gap-1 font-semibold text-marigold underline-offset-2 hover:underline">
                  How to raise a complaint <svg [pcIcon]="ArrowRight" class="h-4 w-4" aria-hidden="true" />
                </a>
              </div>
            }
          </div>
        }
      </div>
      @if (d().copyright || d().business) {
        <div class="border-t border-white/10">
          <div class="mx-auto flex max-w-shop flex-col gap-1.5 px-3 py-5 text-xs leading-relaxed text-white/65 sm:px-4">
            @if (d().copyright) {<p>{{ d().copyright }}</p>}
            @if (d().business) {<p>{{ d().business }}</p>}
          </div>
        </div>
      }
    </footer>
  `,
})
export class BazaarFooter {
  protected readonly site = inject(SiteService).site;
  protected readonly d = computed(() => footerData(this.site()));
  protected readonly list = computed(() => assurances(this.site()));
  protected readonly HEADING = HEADING;
  protected readonly Scale = Scale;
  protected readonly Mail = Mail;
  protected readonly Phone = Phone;
  protected readonly Clock = Clock;
  protected readonly ArrowRight = ArrowRight;

  protected tel(p: string): string {
    return p.replace(/[^\d+]/g, "");
  }
}
