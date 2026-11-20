"use client";

/*
 * Partner home: the big online switch, today's numbers, the cash held, trips in progress (tap one to continue it)
 * and, while waiting, a "looking for deliveries" card. New requests pop up over this screen (components/delivery/feed).
 */

import clsx from "clsx";
import { AlertTriangle, Banknote, ChevronRight, IndianRupee, LocateFixed, MapPin, MapPinOff, Navigation, Package, Radar, Smartphone, Store, Volume2 } from "lucide-react";
import Link from "next/link";
import { OnlineSwitch, usePartner } from "@/components/delivery/app";
import { useFeed } from "@/components/delivery/feed";
import { TripPill } from "@/components/delivery/trip";
import type { TripView } from "@/lib/delivery-types";
import { rupees } from "@/lib/format";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

const NEXT: Record<string, string> = {
  accepted: "Go to the store",
  at_store: "Collect the package",
  picked: "Start the delivery",
  on_the_way: "Deliver to the customer",
  reached: "Hand over and take the OTP",
};

export default function PartnerHome() {
  const { partner } = usePartner();
  const { feed, location } = useFeed();
  if (!partner) return null;
  const online = partner.is_online;
  const active = feed?.active ?? [];
  const cash = feed?.cash_in_hand ?? 0;
  const limit = feed?.cash_limit ?? 0;
  const loc = location.state;
  return (
    <div className="flex flex-col gap-4" data-testid="partner-home">
      <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <p className="text-sm text-ink-soft" suppressHydrationWarning>{greeting()},</p>
        <h1 className="text-2xl font-bold">{partner.name.split(" ")[0]}</h1>
        <p className="mb-4 text-sm text-ink-soft">{partner.zone ? `${partner.zone.name}, ${partner.zone.city}` : "Delivery area not set yet"}</p>
        <OnlineSwitch large />
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <Num icon={Package} label="Delivered today" value={String(feed?.today.trips ?? 0)} />
          <Num icon={IndianRupee} label="Earned today" value={rupees(feed?.today.earned ?? 0)} />
          <Num icon={Banknote} label="Cash in hand" value={rupees(cash)} warn={limit > 0 && cash > limit} />
        </div>
      </section>

      {limit > 0 && cash > limit && (
        <p className="flex items-start gap-2 rounded-2xl bg-vermilion-light p-4 text-sm text-vermilion" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          You hold {rupees(cash)} in cash, above the {rupees(limit)} limit. Deposit it with the delivery team to keep getting cash-on-delivery orders.
        </p>
      )}

      {active.length > 0 && (
        <section aria-labelledby="active-h" className="flex flex-col gap-2">
          <h2 id="active-h" className="px-1 text-sm font-bold uppercase tracking-[0.12em] text-ink-soft">In progress ({active.length})</h2>
          {active.map((t) => <ActiveTrip key={t.id} t={t} />)}
        </section>
      )}

      {online ? (
        active.length === 0 && (
          <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-6 text-center text-white shadow-sm" data-testid="waiting">
            <div className="relative mx-auto flex h-28 w-28 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-white/15 motion-reduce:animate-none" />
              <span className="absolute inset-3 rounded-full bg-white/10" />
              <Radar className="relative h-12 w-12" aria-hidden />
            </div>
            <p className="mt-2 font-display text-xl font-semibold">Looking for deliveries near you</p>
            <p className="text-white/80">Keep the app open. A new request pops up with a sound.</p>
          </section>
        )
      ) : (
        <section className="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
          <p className="font-display text-xl font-semibold">You are offline</p>
          <p className="text-ink-soft">{active.length ? "Finish your trips in progress. You will not get new requests." : "Go online to start getting delivery requests."}</p>
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        <Tip icon={loc === "denied" ? MapPinOff : loc === "on" ? LocateFixed : Navigation} tone={loc === "denied" ? "bad" : loc === "on" ? "good" : "plain"}
          title={loc === "on" ? "Location is on" : loc === "denied" ? "Location is blocked" : online ? "Turning on location…" : "Location"}
          text={loc === "denied" ? "Allow location for this site in your browser settings to get requests." : loc === "on" ? "Nearby requests and live tracking work." : "Shared only while you are online or on a trip."} />
        <Tip icon={Volume2} tone="plain" title="Sound on" text="Keep your volume up so you hear new requests." />
        <Tip icon={Smartphone} tone="plain" title="Keep the app open" text="Install the app from Profile for the best experience." />
      </section>
    </div>
  );
}

function Num({ icon: Icon, label, value, warn }: { icon: typeof Radar; label: string; value: string; warn?: boolean }) {
  return (
    <div className={clsx("rounded-2xl px-2 py-3", warn ? "bg-vermilion-light" : "bg-mist")}>
      <Icon className={clsx("mx-auto h-4 w-4", warn ? "text-vermilion" : "text-peacock")} aria-hidden />
      <p className={clsx("mt-1 font-display text-lg font-bold leading-tight", warn ? "text-vermilion" : "text-ink")}>{value}</p>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
    </div>
  );
}

function ActiveTrip({ t }: { t: TripView }) {
  const back = t.kind === "return";
  const toStore = back || ["accepted", "at_store"].includes(t.status);
  return (
    <Link href={`/delivery/trips/${t.id}`} className="group flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/40" data-testid="active-trip">
      <span className={clsx("flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl", toStore ? "bg-marigold-light text-marigold-dark" : "bg-vermilion-light text-vermilion")}>
        {toStore ? <Store className="h-6 w-6" aria-hidden /> : <MapPin className="h-6 w-6" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{t.order_number}</span>
          <TripPill trip={t} />
          {t.payment === "cod" && t.cod_amount > 0 && !back && <span className="text-xs font-semibold text-[#8A5A00]">Collect {rupees(t.cod_amount)}</span>}
        </span>
        <span className="block font-semibold text-peacock">{back ? "Bring the package back to the store" : NEXT[t.status] ?? t.status_label}</span>
        <span className="block truncate text-sm text-ink-soft">{toStore ? t.pickup.name : `${t.drop.name}, ${[t.drop.city, t.drop.pincode].filter(Boolean).join(" ")}`}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-ink-faint transition group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}

function Tip({ icon: Icon, title, text, tone }: { icon: typeof Radar; title: string; text: string; tone: "good" | "bad" | "plain" }) {
  return (
    <div className="flex gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <span className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", tone === "good" ? "bg-leaf-light text-leaf" : tone === "bad" ? "bg-vermilion-light text-vermilion" : "bg-peacock-light text-peacock")}>
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-ink-soft">{text}</p>
      </div>
    </div>
  );
}
