import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui";
import { loadSiteServer } from "@/lib/server-api";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `Sell on ${(await loadSiteServer()).brand_name}` };
}

const STEPS = [
  { title: "Sign in with your mobile", body: "Use the same number you will run your shop with." },
  { title: "Add your business details", body: "GSTIN, PAN, pickup address and the bank account for payouts. Keep your PAN card, GST certificate and a cancelled cheque ready as PDF or photo." },
  { title: "Get verified", body: "Our team checks your documents, usually within two working days. You will see the result on your dashboard." },
  { title: "List products and start selling", body: "Add photos, sizes and colours, price and stock. Each listing is reviewed before it goes live." },
];

export default async function SellPage() {
  const brand = (await loadSiteServer()).brand_name;
  return (
    <div className="flex flex-col gap-4">
      <section className="grid overflow-hidden rounded-xl bg-peacock text-white md:grid-cols-2">
        <div className="flex flex-col gap-4 p-6 sm:p-10">
          <h1 className="text-4xl font-bold sm:text-5xl">Sell to customers across India</h1>
          <p className="max-w-md text-lg text-white/85">List your products on {brand}, ship orders from your own premises and get paid to your bank account after the return window closes.</p>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/login?next=/seller/onboarding" variant="cart" className="h-12 px-6">Start selling</ButtonLink>
            <ButtonLink href="/seller" variant="outlineLight" className="h-12 px-6">Go to seller dashboard</ButtonLink>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-px bg-white/10">
          {[
            ["5–17%", "commission, by category"],
            ["0", "listing or signup fees"],
            ["Your choice", "of courier in the first phase"],
            ["Weekly", "payouts once the return window ends"],
          ].map(([big, small]) => (
            <div key={small} className="bg-peacock p-6">
              <dt className="font-display text-3xl font-bold text-marigold">{big}</dt>
              <dd className="text-white/80">{small}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="rounded-xl bg-white p-6">
        <h2 className="mb-4 text-2xl font-semibold">How to get started</h2>
        <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-marigold font-display text-lg font-bold">{i + 1}</span>
              <p className="font-display text-lg font-semibold">{s.title}</p>
              <p className="text-ink-soft">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>
      <p className="px-1 text-sm text-ink-faint">{brand} collects GST TCS and income-tax TDS on your sales as the law requires; both show on your earnings statement and can be claimed in your returns.</p>
    </div>
  );
}
