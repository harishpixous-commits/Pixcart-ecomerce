"use client";

/*
 * Luxe footer: white, quiet and spacious. The brand name set large in the serif with a short gold rule and the
 * tagline; the owner's link columns and contact details under small capitals; social links; the grievance officer
 * (required by the Consumer Protection (E-Commerce) Rules 2020) on its own row; the legal line at the bottom.
 * What it shows comes from useFooter() (components/shop-chrome); this file only arranges and styles it.
 */

import Link from "next/link";
import { FooterLink, useFooter } from "@/components/shop-chrome";
import { ContactList, SocialLinks } from "@/components/social";

const HEADING = "text-[11px] font-medium uppercase tracking-[0.16em] text-ink";
const LINK = "text-ink-soft transition-colors hover:text-ink";

export function LuxeFooter() {
  const { site, columns, contactOn, socialOn, grievance, copyright, business } = useFooter();
  return (
    <footer className="mt-16 border-t border-line bg-white pb-20 sm:mt-20 sm:pb-0">
      <div className="mx-auto max-w-shop px-3 sm:px-4">
        <div className="grid gap-12 py-14 sm:py-16 lg:grid-cols-12 lg:gap-10 lg:py-20">
          <div className="lg:col-span-4">
            <Link href="/" className="font-display text-[34px] leading-none text-ink transition-colors hover:text-ink-soft sm:text-[40px]">
              {site.brand_name}
            </Link>
            <span aria-hidden className="mt-6 block h-px w-16 bg-marigold" />
            {site.tagline && <p className="mt-6 max-w-xs text-[15px] leading-relaxed text-ink-soft">{site.tagline}</p>}
            {socialOn && (
              <div className="mt-8">
                {site.social.title && <p className={HEADING}>{site.social.title}</p>}
                {/* Luxe's outlined circles over the shared links' own look; they fill with the theme colour on hover */}
                <SocialLinks links={site.social.links} tone="dark" iconClass="h-[18px] w-[18px]"
                  className="mt-4 gap-3 [&_a]:h-10 [&_a]:w-10 [&_a]:bg-transparent [&_a]:text-ink [&_a]:ring-1 [&_a]:ring-line" />
              </div>
            )}
          </div>

          {(columns.length > 0 || contactOn) && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:col-span-8 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none">
              {columns.map((col) => (
                <nav key={col.title} aria-label={col.title} className="min-w-0">
                  <p className={HEADING}>{col.title}</p>
                  <ul className="mt-5 flex flex-col gap-3 text-[14px]">
                    {col.links.map((l) => (
                      <li key={l.href + l.label}><FooterLink href={l.href} label={l.label} className={LINK} /></li>
                    ))}
                  </ul>
                </nav>
              ))}
              {contactOn && (
                <div className="min-w-0">
                  <p className={HEADING}>{site.contact.title || "Contact us"}</p>
                  <div className="mt-5 text-[14px] text-ink-soft [&_a]:font-normal [&_a]:text-ink [&_a]:[overflow-wrap:anywhere] [&_svg]:text-ink-faint">
                    <ContactList items={site.contact.items} tone="dark" />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {grievance && (
          <section aria-label="Grievance officer" className="grid gap-4 border-t border-line py-10 lg:grid-cols-12 lg:gap-10" data-testid="footer-grievance">
            <p className={`${HEADING} lg:col-span-4`}>Grievance officer</p>
            <div className="flex flex-col gap-1.5 text-[14px] text-ink-soft lg:col-span-8 lg:flex-row lg:flex-wrap lg:items-baseline lg:gap-x-8 lg:gap-y-2">
              <p className="text-ink">{grievance.name}{grievance.designation ? `, ${grievance.designation}` : ""}</p>
              {grievance.email && <a href={`mailto:${grievance.email}`} className={`${LINK} break-all`}>{grievance.email}</a>}
              {grievance.phone && <p>{grievance.phone}</p>}
              {grievance.hours && <p>{grievance.hours}</p>}
              <Link href="/help/grievance" className="mt-2 w-fit text-ink underline decoration-marigold underline-offset-[6px] transition-colors hover:decoration-ink lg:mt-0">
                How to raise a complaint
              </Link>
            </div>
          </section>
        )}
      </div>

      {(copyright || business) && (
        <div className="border-t border-line">
          <div className="mx-auto flex max-w-shop flex-col gap-1.5 px-3 py-6 text-[12px] leading-relaxed text-ink-soft sm:px-4">
            {copyright && <p>{copyright}</p>}
            {business && <p>{business}</p>}
          </div>
        </div>
      )}
    </footer>
  );
}
