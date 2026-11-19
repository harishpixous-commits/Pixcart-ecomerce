import { BadgeCheck, Bike, CalendarClock, ChevronDown, CircleDollarSign, FileCheck2, IdCard, IndianRupee, MapPin, Package, Phone, ShieldCheck, Smartphone, Timer, UserPlus, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { GetTheApp } from "@/components/delivery/install";
import { Logo } from "@/components/shop-chrome";
import type { DeliveryOptions } from "@/lib/delivery-types";
import { rupees } from "@/lib/format";
import { loadSiteServer, serverGet } from "@/lib/server-api";

export const metadata: Metadata = {
  title: "Become a delivery partner",
  description: "Deliver orders in your area on your own time. Weekly payouts, flexible hours, simple sign-up with your mobile number.",
};

const STEPS = [
  { icon: UserPlus, title: "Sign up with your mobile", text: "One-time code, no passwords." },
  { icon: FileCheck2, title: "Add your documents", text: "Licence, ID proof, vehicle and bank or UPI." },
  { icon: BadgeCheck, title: "Get approved", text: "Our team checks your details, usually within a day." },
  { icon: Bike, title: "Go online and earn", text: "Accept requests near you and deliver." },
];

const NEEDS = [
  { icon: Bike, text: "A motorbike, scooter, electric bike or bicycle" },
  { icon: IdCard, text: "Driving licence (not needed for bicycles) and an ID proof" },
  { icon: Smartphone, text: "An Android phone or iPhone with internet and GPS" },
  { icon: Wallet, text: "A bank account or UPI ID for your weekly payouts" },
];

const FAQ = [
  ["How much can I earn?", "You earn a fee for every delivery you complete, shown before you accept a request. Your earnings add up in the app and are paid every week."],
  ["Can I choose my own hours?", "Yes. Switch Online when you want to work and Offline when you are done. You only get requests while you are online."],
  ["What happens with cash on delivery?", "Collect the amount shown in the app, enter it, and deposit the cash with the team. The app shows how much cash you are holding."],
  ["Do I need to buy anything?", "No joining fee. You need your own vehicle and a smartphone."],
  ["Is my information safe?", "Your documents are visible only to you and the verification team. Aadhaar numbers are never stored, only the last 4 digits."],
];

export default async function JoinPage() {
  const [site, opts] = await Promise.all([loadSiteServer(), serverGet<DeliveryOptions>("/api/delivery/options", 60).catch(() => null)]);
  const fee = !opts ? null : opts.fee_mode === "fixed" ? `${rupees(opts.fee_fixed_paise)} a delivery` : `${rupees(opts.fee_base_paise)} + ${rupees(opts.fee_per_km_paise)} a km`;
  const open = opts?.registration_open !== false && opts?.enabled !== false;
  const cities = Array.from(new Set((opts?.zones ?? []).map((z) => z.city))).slice(0, 8);
  return (
    <div className="min-h-screen bg-mist">
      {/* hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-peacock via-peacock to-peacock-dark text-white">
        <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-2xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-marigold/20 blur-3xl" aria-hidden />
        <header className="relative mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Logo />
          <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">Delivery partners</span>
          <Link href="/delivery/login" className="ml-auto rounded-full px-4 py-2 text-sm font-semibold ring-1 ring-white/50 hover:bg-white/10">Partner sign in</Link>
        </header>
        <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-6 md:grid-cols-[1.1fr_1fr] md:pb-24 md:pt-10">
          <div>
            <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold"><MapPin className="h-4 w-4" aria-hidden /> Deliveries near you{cities.length ? ` in ${cities.join(", ")}` : ""}</p>
            <h1 className="text-4xl font-bold leading-[1.1] sm:text-5xl">Deliver with {site.brand_name}.<br /><span className="text-marigold">Earn on your own time.</span></h1>
            <p className="mt-4 max-w-lg text-lg text-white/85">Pick up packages from local sellers and deliver them to shoppers nearby. Go online when you want, get paid every week.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              {open ? (
                <Link href="/delivery/login?next=/delivery/register" className="rounded-full bg-marigold px-7 py-3.5 text-lg font-bold text-ink shadow-lg shadow-black/20 transition-transform hover:-translate-y-0.5 hover:bg-marigold-dark" data-testid="join-register">
                  Register now
                </Link>
              ) : (
                <p className="rounded-xl bg-white/15 px-4 py-3 font-semibold">New registrations are closed right now. Please check back soon.</p>
              )}
              <Link href="/delivery/login" className="rounded-full px-6 py-3.5 font-semibold ring-1 ring-white/60 hover:bg-white/10">I am already a partner</Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-3 text-sm font-semibold">
              {fee && <li className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20"><IndianRupee className="h-4 w-4 text-marigold" aria-hidden /> {fee}</li>}
              <li className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20"><CalendarClock className="h-4 w-4 text-marigold" aria-hidden /> Weekly payouts</li>
              <li className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 ring-1 ring-white/20"><Timer className="h-4 w-4 text-marigold" aria-hidden /> Your own hours</li>
            </ul>
          </div>
          {/* phone mock-up of a delivery request */}
          <div className="relative mx-auto w-full max-w-sm" aria-hidden>
            <div className="rotate-2 rounded-[2.2rem] bg-ink p-2.5 shadow-2xl shadow-black/40">
              <div className="overflow-hidden rounded-[1.8rem] bg-mist text-ink">
                <div className="flex items-center justify-between bg-peacock px-4 py-3 text-white">
                  <span className="font-display font-semibold">{site.brand_name} Partner</span>
                  <span className="flex items-center gap-1.5 rounded-full bg-leaf px-2.5 py-1 text-xs font-bold"><span className="h-2 w-2 rounded-full bg-white" /> Online</span>
                </div>
                <div className="p-3">
                  <div className="rounded-2xl bg-white p-4 shadow-sm">
                    <p className="text-xs font-bold uppercase tracking-wider text-vermilion">New delivery request</p>
                    <p className="mt-1 font-display text-2xl font-bold">{fee ? fee.split(" ")[0] : "₹35"} <span className="text-sm font-medium text-ink-soft">earning</span></p>
                    <div className="mt-3 flex flex-col gap-2 text-sm">
                      <p className="flex items-start gap-2"><Package className="mt-0.5 h-4 w-4 shrink-0 text-peacock" /> <span><b>Pickup</b> · Local store, 1.2 km away</span></p>
                      <p className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-vermilion" /> <span><b>Drop</b> · 3.4 km from the store</span></p>
                    </div>
                    <div className="mt-4 grid grid-cols-[1fr_2fr] gap-2">
                      <span className="rounded-xl bg-mist py-2.5 text-center text-sm font-semibold text-ink-soft">Reject</span>
                      <span className="relative overflow-hidden rounded-xl bg-leaf py-2.5 text-center text-sm font-bold text-white">
                        <span className="absolute inset-y-0 left-0 w-2/3 bg-white/20" /> <span className="relative">Accept · 0:21</span>
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    {[["Today", "₹420"], ["Trips", "12"], ["Rating", "4.9★"]].map(([k, v]) => (
                      <div key={k} className="rounded-xl bg-white p-2 shadow-sm"><p className="text-[11px] text-ink-faint">{k}</p><p className="font-display font-bold">{v}</p></div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="awning bg-mist" aria-hidden style={{ transform: "scaleY(-1)" }} />
      </section>

      <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-10">
        <section aria-labelledby="how">
          <h2 id="how" className="text-2xl font-semibold sm:text-3xl">How it works</h2>
          <ol className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
                <span className="absolute right-4 top-3 font-display text-4xl font-bold text-peacock/10">{i + 1}</span>
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-peacock-light text-peacock"><s.icon className="h-6 w-6" aria-hidden /></span>
                <p className="mt-3 font-semibold">{s.title}</p>
                <p className="text-sm text-ink-soft">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
            <h2 className="text-xl font-semibold">What you need</h2>
            <ul className="mt-4 flex flex-col gap-3">
              {NEEDS.map((n) => (
                <li key={n.text} className="flex items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-marigold-light text-marigold-dark"><n.icon className="h-5 w-5" aria-hidden /></span>{n.text}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl bg-gradient-to-br from-white to-peacock-light/60 p-6 shadow-sm ring-1 ring-black/5">
            <h2 className="text-xl font-semibold">Get the partner app</h2>
            <p className="mb-4 mt-1 text-ink-soft">Use it in your phone&apos;s browser or install it like any other app. Everything works the same on a computer.</p>
            <GetTheApp options={opts} />
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-3">
          {[
            { icon: CircleDollarSign, title: "Clear earnings", text: "See the fee before you accept. Track today, this week and every payout." },
            { icon: ShieldCheck, title: "Safe handovers", text: "Pickup codes at the store and OTP at the door protect you and the customer." },
            { icon: Phone, title: "Help when you need it", text: "Call or message the delivery team from the app at any time." },
          ].map((c) => (
            <div key={c.title} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <c.icon className="h-7 w-7 text-peacock" aria-hidden />
              <p className="mt-2 font-semibold">{c.title}</p>
              <p className="text-sm text-ink-soft">{c.text}</p>
            </div>
          ))}
        </section>

        <section aria-labelledby="faq" className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
          <h2 id="faq" className="text-xl font-semibold">Questions</h2>
          <div className="mt-3 divide-y divide-line">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold">{q}<ChevronDown className="h-5 w-5 shrink-0 text-ink-faint transition-transform group-open:rotate-180" aria-hidden /></summary>
                <p className="mt-2 text-ink-soft">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {open && (
          <section className="flex flex-col items-center gap-3 rounded-2xl bg-peacock px-6 py-10 text-center text-white">
            <h2 className="text-2xl font-semibold sm:text-3xl">Ready to start?</h2>
            <p className="text-white/85">It takes about 5 minutes. Keep your licence, ID proof and bank details handy.</p>
            <Link href="/delivery/login?next=/delivery/register" className="mt-2 rounded-full bg-marigold px-7 py-3.5 text-lg font-bold text-ink hover:bg-marigold-dark">Register now</Link>
          </section>
        )}
        <p className="text-center text-sm text-ink-faint">
          {opts?.support_phone ? <>Questions? Call <a className="font-semibold text-peacock" href={`tel:${opts.support_phone}`}>{opts.support_phone}</a> · </> : null}
          <Link href="/" className="font-semibold text-peacock">Shop on {site.brand_name}</Link>
        </p>
      </main>
    </div>
  );
}
