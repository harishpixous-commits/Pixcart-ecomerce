"use client";

import clsx from "clsx";
import { LocateFixed, MapPinOff, Navigation, Radar, Smartphone, Volume2 } from "lucide-react";
import { OnlineSwitch, useDeliveryOptions, usePartner } from "@/components/delivery/app";
import { useLocationSharing } from "@/components/delivery/location";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default function PartnerHome() {
  const { partner } = usePartner();
  const options = useDeliveryOptions();
  const online = !!partner?.is_online;
  const loc = useLocationSharing(online, options?.location_seconds ?? 20);
  if (!partner) return null;
  return (
    <div className="flex flex-col gap-4" data-testid="partner-home">
      <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <p className="text-sm text-ink-soft" suppressHydrationWarning>{greeting()},</p>
        <h1 className="text-2xl font-bold">{partner.name.split(" ")[0]}</h1>
        <p className="mb-4 text-sm text-ink-soft">{partner.zone ? `${partner.zone.name}, ${partner.zone.city}` : "Delivery area not set yet"}</p>
        <OnlineSwitch large />
      </section>

      {online ? (
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-6 text-center text-white shadow-sm" data-testid="waiting">
          <div className="relative mx-auto flex h-28 w-28 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-white/15 motion-reduce:animate-none" />
            <span className="absolute inset-3 rounded-full bg-white/10" />
            <Radar className="relative h-12 w-12" aria-hidden />
          </div>
          <p className="mt-2 font-display text-xl font-semibold">Looking for deliveries near you</p>
          <p className="text-white/80">Keep the app open. A new request pops up with a sound.</p>
        </section>
      ) : (
        <section className="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
          <p className="font-display text-xl font-semibold">You are offline</p>
          <p className="text-ink-soft">Go online to start getting delivery requests.</p>
        </section>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        <Tip icon={loc.state === "denied" ? MapPinOff : loc.state === "on" ? LocateFixed : Navigation} tone={loc.state === "denied" ? "bad" : loc.state === "on" ? "good" : "plain"}
          title={loc.state === "on" ? "Location is on" : loc.state === "denied" ? "Location is blocked" : online ? "Turning on location…" : "Location"}
          text={loc.state === "denied" ? "Allow location for this site in your browser settings to get requests." : loc.state === "on" ? "Nearby requests and live tracking work." : "Shared only while you are online."} />
        <Tip icon={Volume2} tone="plain" title="Sound on" text="Keep your volume up so you hear new requests." />
        <Tip icon={Smartphone} tone="plain" title="Keep the app open" text="Install the app from Profile for the best experience." />
      </section>
    </div>
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
