import type { Metadata } from "next";
import Link from "next/link";
import { ContactList, SocialLinks } from "@/components/social";
import { loadSiteServer } from "@/lib/server-api";

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSiteServer();
  return { title: site.contact.title || "Contact us", description: `How to reach ${site.brand_name}: customer care, address and social media.` };
}

export default async function ContactPage() {
  const site = await loadSiteServer();
  const b = site.business;
  const contactOn = site.contact.enabled && site.contact.items.some((i) => i.enabled);
  const socialOn = site.social.enabled && site.social.links.some((l) => l.enabled && l.url);
  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-3xl font-semibold">{site.contact.title || "Contact us"}</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl bg-white p-5">
          <h2 className="mb-3 text-lg font-semibold">Questions about an order?</h2>
          <p className="mb-3 text-ink-soft">Open the order in Your orders to track, cancel or return it. For anything else, raise a request and we reply within 48 hours.</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/orders" className="rounded-lg border border-line px-4 py-2 font-semibold">Your orders</Link>
            <Link href="/support/new" className="rounded-lg bg-peacock px-4 py-2 font-semibold text-white">Get help</Link>
          </div>
        </section>
        {contactOn && (
          <section className="rounded-xl bg-white p-5">
            <h2 className="mb-3 text-lg font-semibold">Reach us</h2>
            <ContactList items={site.contact.items} tone="dark" />
          </section>
        )}
        {socialOn && (
          <section className="rounded-xl bg-white p-5">
            <h2 className="mb-3 text-lg font-semibold">{site.social.title || "Follow us"}</h2>
            <SocialLinks links={site.social.links} tone="dark" />
          </section>
        )}
        {(b.legal_name || b.registered_address) && (
          <section className="rounded-xl bg-white p-5">
            <h2 className="mb-3 text-lg font-semibold">Registered office</h2>
            <p className="font-medium">{b.legal_name}</p>
            {b.registered_address && <p className="whitespace-pre-line text-ink-soft">{b.registered_address}</p>}
            {b.gstin && <p className="text-sm text-ink-faint">GSTIN {b.gstin}</p>}
            {b.cin && <p className="text-sm text-ink-faint">CIN {b.cin}</p>}
            <Link href="/help/grievance" className="mt-2 inline-block text-sm font-semibold text-peacock">Grievance officer</Link>
          </section>
        )}
      </div>
    </article>
  );
}
