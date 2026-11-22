"use client";

/*
 * Sign-in and sign-up pages in the theme's "sign-in" layout: a centred card (Classic, Fresh), or split with a brand
 * panel on large screens (Bazaar, Luxe). The panel lists only what is true for this shop (from its settings).
 */

import clsx from "clsx";
import { BadgeCheck, RotateCcw, ShieldCheck, Wallet } from "lucide-react";
import { Logo } from "@/components/shop-chrome";
import { useSite } from "@/lib/site";
import { useLayout } from "@/themes/context";

function BrandPanel() {
  const site = useSite();
  const points = [
    { icon: BadgeCheck, text: "Every seller is verified before they can sell" },
    site.cod_enabled ? { icon: Wallet, text: "Pay online or cash on delivery" } : { icon: ShieldCheck, text: "Secure online payments" },
    site.features.returns ? { icon: RotateCcw, text: "Easy returns from your orders page" } : null,
  ].filter((x): x is { icon: typeof BadgeCheck; text: string } => Boolean(x));
  return (
    <div className="relative hidden flex-col justify-between overflow-hidden bg-peacock p-10 text-white lg:flex" aria-hidden={false}>
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10" />
      <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-marigold/20" />
      <div className="relative"><Logo /></div>
      <div className="relative flex flex-col gap-5">
        <p className="max-w-sm font-display text-3xl font-semibold leading-tight">{site.tagline || `Welcome to ${site.brand_name}`}</p>
        <ul className="flex flex-col gap-3">
          {points.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3 text-white/90">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15"><Icon className="h-5 w-5" /></span>
              {text}
            </li>
          ))}
        </ul>
      </div>
      <p className="relative text-sm text-white/70">{site.business.legal_name || site.brand_name}</p>
    </div>
  );
}

export function AuthFrame({ children }: { children: React.ReactNode }) {
  const split = useLayout().auth.layout === "split";
  if (!split) return <div className="mx-auto max-w-md py-6">{children}</div>;
  return (
    <div className={clsx("mx-auto grid max-w-5xl overflow-hidden lg:my-4 lg:grid-cols-2 lg:rounded-2xl lg:bg-white lg:shadow-card")} data-auth-layout="split">
      <BrandPanel />
      <div className="mx-auto w-full max-w-md py-6 lg:px-6 lg:py-12">{children}</div>
    </div>
  );
}
