import Link from "next/link";
import { loadSiteServer } from "@/lib/server-api";

export const metadata = { title: "Grievance redressal" };

export default async function GrievancePage() {
  const site = await loadSiteServer();
  const b = site.business;
  const g = b.grievance;
  const operator = b.legal_name || site.brand_name;
  return (
    <article className="mx-auto max-w-2xl rounded-xl bg-white p-6">
      <h1 className="mb-4 text-3xl font-semibold">Grievance redressal</h1>
      <div className="flex flex-col gap-4 text-ink-soft">
        <p>
          Under the Consumer Protection (E-Commerce) Rules, 2020, {operator} has appointed a grievance officer. We acknowledge every complaint within 48 hours
          and resolve it within one month of receiving it.
        </p>
        {g.name || g.email ? (
          <dl className="grid grid-cols-[120px_1fr] gap-y-1 rounded-lg bg-mist p-4 text-ink">
            {g.name && (<><dt className="text-ink-faint">Name</dt><dd>{g.name}{g.designation ? `, ${g.designation}` : ""}</dd></>)}
            {g.email && (<><dt className="text-ink-faint">Email</dt><dd><a className="text-peacock" href={`mailto:${g.email}`}>{g.email}</a></dd></>)}
            {g.phone && (<><dt className="text-ink-faint">Phone</dt><dd>{g.phone}</dd></>)}
            {g.hours && (<><dt className="text-ink-faint">Hours</dt><dd>{g.hours}</dd></>)}
            {b.registered_address && (<><dt className="text-ink-faint">Address</dt><dd>{operator}, {b.registered_address}</dd></>)}
          </dl>
        ) : (
          <p className="rounded-lg bg-mist p-4">Raise a complaint through our help centre and we will route it to the grievance officer.</p>
        )}
        <p>
          The fastest way is a <Link href="/support/new?grievance=1" className="font-semibold text-peacock">grievance ticket</Link>: it is tracked, and you can see every reply.
          Include your order number. Each seller also has their own grievance officer, shown on the product page.
        </p>
      </div>
    </article>
  );
}
