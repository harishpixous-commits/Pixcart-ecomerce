"use client";

/*
 * Bazaar footer: a strip of shopping promises taken from the marketplace's own settings (only what is switched on is
 * said), then a dark brand footer with the logo, the link columns, contact details, the grievance officer (required by
 * the Consumer Protection (E-Commerce) Rules 2020) and the legal line. The data comes from useFooter(), like every theme.
 */

import { ArrowRight, BadgeCheck, Banknote, Clock, Headset, Mail, Phone, RotateCcw, Scale, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { FooterLink, Logo, useFooter } from "@/components/shop-chrome";
import { ContactList, SocialLinks } from "@/components/social";
import type { Site } from "@/lib/types";

interface Assurance {
  icon: typeof BadgeCheck;
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

function TrustStrip({ site }: { site: Site }) {
  const list = assurances(site);
  return (
    <section aria-label="Shopping with us" className="border-y border-line bg-white text-ink">
      <ul className="mx-auto grid max-w-shop grid-cols-2 gap-x-4 gap-y-5 px-3 py-6 sm:px-4 md:grid-cols-3 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none lg:gap-x-6 lg:py-7">
        {list.map(({ icon: Icon, title, text, href }) => (
          <li key={title} className="flex min-w-0 items-center gap-3 lg:justify-center">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-peacock/10 text-peacock">
              <Icon className="h-[22px] w-[22px]" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block font-display text-sm font-semibold leading-snug">{title}</span>
              {href
                ? <Link href={href} className="text-xs text-ink-soft underline-offset-2 hover:text-peacock hover:underline">{text}</Link>
                : <span className="block text-xs text-ink-soft">{text}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const HEADING = "font-display text-xs font-semibold uppercase tracking-wider text-white";

export function BazaarFooter() {
  const { site, columns, contactOn, socialOn, grievance, copyright, business } = useFooter();
  return (
    <footer className="mt-10 bg-peacock-dark pb-20 text-white/75 sm:mt-12 sm:pb-0">
      <TrustStrip site={site} />
      <div className="h-1 bg-marigold" aria-hidden />
      <div className="mx-auto grid max-w-shop gap-x-8 gap-y-10 px-3 py-10 sm:px-4 md:grid-cols-12 lg:py-12">
        <div className="flex flex-col items-start gap-4 md:col-span-12 lg:col-span-3">
          <Logo />
          {site.tagline && <p className="max-w-xs text-sm leading-relaxed">{site.tagline}</p>}
          {socialOn && (
            <div>
              {site.social.title && <p className={`mb-2.5 ${HEADING}`}>{site.social.title}</p>}
              <SocialLinks links={site.social.links} />
            </div>
          )}
        </div>
        {columns.length > 0 && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 md:col-span-7 lg:col-span-5">
            {columns.map((col) => (
              <nav key={col.title} aria-label={col.title} className="flex min-w-0 flex-col items-start gap-2.5 text-sm">
                <p className={`mb-0.5 ${HEADING}`}>{col.title}</p>
                {col.links.map((l) => (
                  <FooterLink key={l.href + l.label} href={l.href} label={l.label} className="text-white/75 underline-offset-2 hover:text-white hover:underline" />
                ))}
              </nav>
            ))}
          </div>
        )}
        {(contactOn || grievance) && (
          <div className="flex flex-col gap-6 text-sm md:col-span-5 lg:col-span-4">
            {contactOn && (
              <div>
                <p className={`mb-3 ${HEADING}`}>{site.contact.title || "Contact us"}</p>
                <ContactList items={site.contact.items} />
              </div>
            )}
            {grievance && (
              <div className="rounded-xl bg-white/[0.06] p-4 ring-1 ring-white/10" data-testid="grievance-officer">
                <p className={`flex items-center gap-2 ${HEADING}`}>
                  <Scale className="h-4 w-4 text-marigold" aria-hidden /> Grievance officer
                </p>
                <p className="mt-2.5 font-semibold text-white">
                  {grievance.name}
                  {grievance.designation && <span className="font-normal text-white/75">, {grievance.designation}</span>}
                </p>
                <div className="mt-1.5 flex flex-col gap-1">
                  {grievance.email && (
                    <a href={`mailto:${grievance.email}`} className="flex min-w-0 items-center gap-2 hover:text-white">
                      <Mail className="h-4 w-4 shrink-0 text-white/60" aria-hidden /><span className="truncate">{grievance.email}</span>
                    </a>
                  )}
                  {grievance.phone && (
                    <a href={`tel:${grievance.phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-2 hover:text-white">
                      <Phone className="h-4 w-4 shrink-0 text-white/60" aria-hidden />{grievance.phone}
                    </a>
                  )}
                  {grievance.hours && (
                    <p className="flex items-start gap-2">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-white/60" aria-hidden />{grievance.hours}
                    </p>
                  )}
                </div>
                <Link href="/help/grievance" className="mt-3 inline-flex items-center gap-1 font-semibold text-marigold underline-offset-2 hover:underline">
                  How to raise a complaint <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
      {(copyright || business) && (
        <div className="border-t border-white/10">
          <div className="mx-auto flex max-w-shop flex-col gap-1.5 px-3 py-5 text-xs leading-relaxed text-white/65 sm:px-4">
            {copyright && <p>{copyright}</p>}
            {business && <p>{business}</p>}
          </div>
        </div>
      )}
    </footer>
  );
}
