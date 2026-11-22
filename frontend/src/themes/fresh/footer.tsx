"use client";

/*
 * Fresh footer: white and compact, like the last screen of a shopping app. The brand with its tagline and social
 * links, the link columns (two per row on phones), the contact details, the grievance officer on a tinted card (with
 * the link to /help/grievance; legally required) and the legal line. What it shows comes from useFooter()
 * (Admin → Storefront → Navigation and footer, and Business); this file only arranges it.
 * Phones get extra room at the bottom for the tab bar and the floating cart pill.
 */

import clsx from "clsx";
import { ChevronRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { FooterLink, Logo, useFooter } from "@/components/shop-chrome";
import { ContactList, SocialLinks } from "@/components/social";

/** Link columns per row on large screens, by how many columns there are. */
const LG_COLS = ["lg:grid-cols-1", "lg:grid-cols-1", "lg:grid-cols-2", "lg:grid-cols-3", "lg:grid-cols-4"] as const;

const HEADING = "mb-2 text-xs font-extrabold uppercase tracking-wider text-ink";

export function FreshFooter() {
  const { site, columns, contactOn, socialOn, grievance, copyright, business } = useFooter();
  const side = contactOn || Boolean(grievance);
  return (
    <footer className="mt-10 border-t border-line bg-white pb-[calc(7rem+env(safe-area-inset-bottom))] text-sm text-ink-soft sm:mt-12 sm:pb-0">
      <div className="mx-auto grid max-w-shop gap-8 px-3 py-8 sm:px-4 lg:grid-cols-12 lg:gap-10 lg:py-10">
        <div className="flex flex-col items-start gap-3 lg:col-span-3">
          <Logo light={false} />
          {site.tagline && <p className="max-w-xs leading-relaxed">{site.tagline}</p>}
          {socialOn && (
            <div className="mt-1">
              {site.social.title && <p className={HEADING}>{site.social.title}</p>}
              <SocialLinks links={site.social.links} tone="dark" />
            </div>
          )}
        </div>

        {columns.length > 0 && (
          <div className={clsx("grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3", side ? "lg:col-span-6" : "lg:col-span-9", LG_COLS[Math.min(columns.length, 4)])}>
            {columns.map((col) => (
              <nav key={col.title} aria-label={col.title} className="min-w-0">
                <p className={HEADING}>{col.title}</p>
                <ul className="flex flex-col">
                  {col.links.map((l) => (
                    <li key={l.href + l.label}>
                      <FooterLink href={l.href} label={l.label}
                        className="inline-flex min-h-[36px] items-center py-1 transition-colors hover:text-peacock lg:min-h-0" />
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        )}

        {side && (
          <div className={clsx("grid gap-4 sm:grid-cols-2 lg:grid-cols-1", columns.length > 0 ? "lg:col-span-3" : "lg:col-span-9")}>
            {contactOn && (
              <div className="min-w-0">
                <p className={HEADING}>{site.contact.title || "Contact us"}</p>
                <ContactList items={site.contact.items} tone="dark" />
              </div>
            )}
            {grievance && (
              <div className="min-w-0 rounded-xl bg-mist p-4 ring-1 ring-line" data-testid="footer-grievance">
                <p className="flex items-center gap-2 font-bold text-ink">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-peacock ring-1 ring-line">
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                  </span>
                  Grievance officer
                </p>
                <p className="mt-2 text-ink">{grievance.name}{grievance.designation ? `, ${grievance.designation}` : ""}</p>
                {grievance.email && <a href={`mailto:${grievance.email}`} className="block break-all transition-colors hover:text-peacock">{grievance.email}</a>}
                {grievance.phone && <a href={`tel:${grievance.phone.replace(/[^\d+]/g, "")}`} className="block transition-colors hover:text-peacock">{grievance.phone}</a>}
                {grievance.hours && <p className="mt-0.5 text-xs">{grievance.hours}</p>}
                <Link href="/help/grievance" className="mt-2 inline-flex min-h-[32px] items-center gap-0.5 font-semibold text-peacock-dark hover:underline">
                  How to raise a complaint <ChevronRight className="h-4 w-4" aria-hidden />
                </Link>
              </div>
            )}
          </div>
        )}
      </div>

      {(copyright || business) && (
        <div className="border-t border-line">
          <div className="mx-auto flex max-w-shop flex-col gap-1 px-3 py-4 text-xs leading-relaxed text-ink-soft sm:px-4">
            {copyright && <p>{copyright}</p>}
            {business && <p>{business}</p>}
          </div>
        </div>
      )}
    </footer>
  );
}
