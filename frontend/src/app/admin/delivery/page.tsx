"use client";

import clsx from "clsx";
import { Bike, Check, ChevronRight, MapPinned, SlidersHorizontal, UserCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, Stat } from "@/components/portal-shell";
import { PageLoader } from "@/components/ui";
import { api, quietly } from "@/lib/api";

type Overview = { partners: Record<string, number>; online: number; zones: number; fleet_mode: string; auto_assign: boolean; enabled: boolean };

const MODE: Record<string, string> = { zones: "Zones only", all: "Every order", seller_choice: "Seller chooses", off: "Couriers only" };

export default function DeliveryOverview() {
  const [o, setO] = useState<Overview | null>(null);
  useEffect(() => { api<Overview>("/api/admin/delivery/overview").then(setO).catch(quietly); }, []);
  if (!o) return <PageLoader />;
  const approved = o.partners.approved ?? 0;
  const steps = [
    { done: o.zones > 0, title: "Create delivery zones", text: "The PIN codes your partners cover.", href: "/admin/delivery/zones", icon: MapPinned },
    { done: approved > 0, title: "Approve delivery partners", text: "Check documents and choose each partner's zone.", href: "/admin/delivery/partners?status=submitted", icon: UserCheck },
    { done: o.enabled && o.fleet_mode !== "off", title: "Choose which orders they deliver", text: "Fees, cash limits and safety checks too.", href: "/admin/delivery/settings", icon: SlidersHorizontal },
  ];
  return (
    <div className="flex flex-col gap-4" data-testid="delivery-overview">
      <PageHeader title="Delivery overview" sub={`Your own delivery fleet: ${o.enabled ? MODE[o.fleet_mode] ?? o.fleet_mode : "paused"}${o.enabled && o.fleet_mode !== "off" ? `, ${o.auto_assign ? "auto-assign on" : "staff assign every package"}` : ""}.`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Online now" value={o.online} hint={`of ${approved} approved partners`} href="/admin/delivery/partners?status=approved" />
        <Stat label="Waiting for review" value={o.partners.submitted ?? 0} href="/admin/delivery/partners?status=submitted" />
        <Stat label="Approved partners" value={approved} href="/admin/delivery/partners?status=approved" />
        <Stat label="Active zones" value={o.zones} href="/admin/delivery/zones" />
      </div>
      {!steps.every((s) => s.done) && (
        <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
          <h2 className="text-lg font-semibold">Set up your delivery fleet</h2>
          <ol className="mt-3 flex flex-col gap-2">
            {steps.map((s, i) => (
              <li key={s.title}>
                <Link href={s.href} className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-line hover:bg-mist">
                  <span className={clsx("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", s.done ? "bg-leaf text-white" : "bg-peacock-light text-peacock")}>
                    {s.done ? <Check className="h-5 w-5" /> : <span className="font-bold">{i + 1}</span>}
                  </span>
                  <span className="min-w-0 flex-1"><span className="block font-semibold">{s.title}</span><span className="text-sm text-ink-soft">{s.text}</span></span>
                  <s.icon className="h-5 w-5 text-ink-faint" aria-hidden />
                  <ChevronRight className="h-5 w-5 text-ink-faint" aria-hidden />
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="flex flex-wrap items-center gap-3 rounded-2xl bg-gradient-to-r from-peacock to-peacock-dark p-5 text-white">
        <Bike className="h-8 w-8" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Recruit delivery partners</p>
          <p className="text-sm text-white/80">Share the partner sign-up page: {typeof window !== "undefined" ? window.location.origin : ""}/delivery/join</p>
        </div>
        <a href="/delivery/join" target="_blank" rel="noreferrer" className="rounded-full bg-white px-4 py-2 font-semibold text-peacock">Open the page</a>
      </section>
    </div>
  );
}
