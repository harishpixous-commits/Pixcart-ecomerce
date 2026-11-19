"use client";

import { Bell, CreditCard, FileText, Headphones, LifeBuoy, MapPin, MessageCircle, Package, RotateCcw, Scale, ShieldCheck, Truck, UserCog } from "lucide-react";
import Link from "next/link";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";

const CARDS = [
  { href: "/orders", icon: Package, title: "Your orders", text: "Track packages, cancel or download invoices" },
  { href: "/help/returns", icon: RotateCcw, title: "Returns and refunds", text: "Return items and check refund status" },
  { href: "/orders", icon: Truck, title: "Track a package", text: "See where your package is right now" },
  { href: "/account", icon: MapPin, title: "Manage addresses", text: "Add, change or remove delivery addresses" },
  { href: "/pages/shipping-policy", icon: CreditCard, title: "Payments and cash on delivery", text: "UPI, cards, net banking and pay on delivery" },
  { href: "/account", icon: UserCog, title: "Account and privacy", text: "Profile, marketing consent, download or delete data" },
  { href: "/support", icon: LifeBuoy, title: "Raise a support request", text: "Tell us what went wrong; we reply within 48 hours" },
  { href: "/alerts", icon: Bell, title: "Your alerts", text: "Back-in-stock and price-drop alerts" },
  { href: "/help/grievance", icon: Scale, title: "Grievance redressal", text: "Contact the grievance officer" },
  { href: "/contact", icon: Headphones, title: "Contact us", text: "Phone, email and address" },
];

const POLICIES = [["Terms of use", "/pages/terms"], ["Privacy policy", "/pages/privacy"], ["Returns and refunds policy", "/pages/returns-policy"], ["Shipping policy", "/pages/shipping-policy"]];

export default function HelpPage() {
  const { user } = useSession();
  const site = useSite();
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl bg-white p-5 sm:p-8">
        <h1 className="text-2xl font-semibold sm:text-3xl">Hello{user?.name ? `, ${user.name.split(" ")[0]}` : ""}. What can we help you with?</h1>
        <p className="mt-1 text-ink-soft">Most answers are one click away. For anything else, chat with us or raise a request.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("shop-assistant:open"))}
            className="flex items-center gap-2 rounded-full bg-peacock px-5 py-2.5 font-semibold text-white hover:bg-peacock-dark">
            <MessageCircle className="h-5 w-5" /> Chat with us
          </button>
          <Link href="/support" className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 font-semibold hover:bg-mist"><LifeBuoy className="h-5 w-5" /> Raise a request</Link>
        </div>
      </section>
      <section aria-labelledby="help-actions" className="flex flex-col gap-3">
        <h2 id="help-actions" className="px-1 text-xl font-semibold">Some things you can do here</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="help-cards">
          {CARDS.map(({ href, icon: Icon, title, text }) => (
            <Link key={title} href={href} className="flex items-start gap-3 rounded-xl bg-white p-4 ring-1 ring-transparent transition hover:ring-peacock">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-peacock-light text-peacock"><Icon className="h-5 w-5" /></span>
              <span><span className="block font-semibold">{title}</span><span className="text-sm text-ink-soft">{text}</span></span>
            </Link>
          ))}
        </div>
      </section>
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-4 sm:p-5">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold"><FileText className="h-5 w-5 text-peacock" /> Policies</h2>
          <ul className="flex flex-col gap-1.5">{POLICIES.map(([label, href]) => <li key={href}><Link href={href} className="text-peacock hover:underline">{label}</Link></li>)}</ul>
        </div>
        <div className="rounded-xl bg-white p-4 sm:p-5">
          <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5 text-peacock" /> Shopping safely on {site.brand_name || "our store"}</h2>
          <p className="text-sm text-ink-soft">Every seller is verified. Seller details, GSTIN and the grievance officer are on each product page. We never ask for your OTP, PIN or card details over the phone.</p>
        </div>
      </section>
    </div>
  );
}
