"use client";

/*
 * Admin → Delivery overview: today at a glance (partners online, packages waiting for a partner, trips in progress,
 * stuck trips, delivered and failed today), the setup checklist until the fleet is ready, and shortcuts to every
 * delivery page. Refreshes every 30 seconds.
 */

import clsx from "clsx";
import {
  AlertTriangle, Bike, Check, CheckCircle2, ChevronRight, Hourglass, MapPin, MapPinned, MessageSquareWarning, PackageCheck, Radar, Route,
  SlidersHorizontal, UserCheck, Wallet, Wifi, XCircle, ChartColumn,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Kpi } from "@/components/delivery/admin";
import { usePolling } from "@/components/delivery/trip";
import { PageHeader } from "@/components/portal-shell";
import { PushPrompt } from "@/components/push-prompt";
import { ErrorNote, PageLoader } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { DeliveryOverview as Overview } from "@/lib/delivery-types";

const MODE: Record<string, string> = { zones: "Zones only", all: "Every order", seller_choice: "Seller chooses", off: "Couriers only" };

const LINKS = [
  { href: "/admin/delivery/live", title: "Live partners", text: "Who is online, where, and what they carry", icon: Radar },
  { href: "/admin/delivery/queue", title: "Assign deliveries", text: "Packages waiting for a partner", icon: PackageCheck },
  { href: "/admin/delivery/trips", title: "Trips", text: "Every request and trip with its log", icon: Route },
  { href: "/admin/delivery/partners", title: "Partners", text: "Registrations, documents and accounts", icon: Bike },
  { href: "/admin/delivery/payouts", title: "Payouts and cash", text: "Weekly payouts and cash on delivery", icon: Wallet },
  { href: "/admin/delivery/reports", title: "Reports", text: "Deliveries, success rate and partner numbers", icon: ChartColumn },
  { href: "/admin/delivery/feedback", title: "Ratings and complaints", text: "What customers said", icon: MessageSquareWarning },
  { href: "/admin/delivery/zones", title: "Zones", text: "PIN codes each team covers", icon: MapPinned },
  { href: "/admin/delivery/settings", title: "Settings", text: "Assignment, fees, cash limit, safety checks, app", icon: SlidersHorizontal },
];

export default function DeliveryOverview() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Overview>("/api/admin/delivery/overview").then((x) => { setO(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the overview"));
  }, []);
  usePolling(load, 30_000);
  if (!o) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const approved = o.partners.approved ?? 0;
  const steps = [
    { done: o.zones > 0, title: "Create delivery zones", text: "The PIN codes your partners cover.", href: "/admin/delivery/zones", icon: MapPinned },
    { done: approved > 0, title: "Approve delivery partners", text: "Check documents and choose each partner's zone.", href: "/admin/delivery/partners?status=submitted", icon: UserCheck },
    { done: o.enabled && o.fleet_mode !== "off", title: "Choose which orders they deliver", text: "Fees, cash limits and safety checks too.", href: "/admin/delivery/settings", icon: SlidersHorizontal },
  ];
  return (
    <div className="flex flex-col gap-4" data-testid="delivery-overview">
      <PageHeader title="Delivery overview" sub={`Your own delivery fleet: ${o.enabled ? MODE[o.fleet_mode] ?? o.fleet_mode : "paused"}${o.enabled && o.fleet_mode !== "off" ? `, ${o.auto_assign ? "auto-assign on" : "staff assign every package"}` : ""}.`} />
      <ErrorNote message={error} />
      <PushPrompt app="admin" title="Get delivery alerts on this device" text="Stuck trips, packages no partner took, failed deliveries and new partner sign-ups, as notifications." />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={Wifi} label="Online now" value={o.online} hint={`of ${approved} approved partners`} tone="green" pulse={o.online > 0} href="/admin/delivery/live" />
        <Kpi icon={Hourglass} label="Waiting for a partner" value={o.queue} hint={o.offered ? `${o.offered} request${o.offered === 1 ? "" : "s"} sent` : "Ready for pickup"} tone={o.queue ? "amber" : "gray"} href="/admin/delivery/queue" />
        <Kpi icon={MapPin} label="On a trip" value={o.on_trip} hint="Packages moving now" href="/admin/delivery/trips?status=active" />
        <Kpi icon={AlertTriangle} label="Stuck trips" value={o.stuck} hint={`Same step over ${o.stuck_minutes} min`} alert={o.stuck > 0} tone="gray" href="/admin/delivery/live" />
        <Kpi icon={CheckCircle2} label="Delivered today" value={o.delivered_today} tone="green" href="/admin/delivery/trips?status=delivered" />
        <Kpi icon={XCircle} label="Not delivered today" value={o.failed_today} tone={o.failed_today ? "red" : "gray"} href="/admin/delivery/queue?tab=failed" />
        <Kpi icon={UserCheck} label="Waiting for review" value={o.partners.submitted ?? 0} hint="New partner registrations" tone={(o.partners.submitted ?? 0) ? "amber" : "gray"} href="/admin/delivery/partners?status=submitted" />
        <Kpi icon={MapPinned} label="Active zones" value={o.zones} tone="blue" href="/admin/delivery/zones" />
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

      <section aria-label="Delivery pages" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="group flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/30">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-peacock-light text-peacock"><l.icon className="h-5 w-5" aria-hidden /></span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{l.title}</span>
              <span className="block text-sm text-ink-soft">{l.text}</span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-ink-faint transition group-hover:translate-x-0.5" aria-hidden />
          </Link>
        ))}
      </section>

      <section className="flex flex-wrap items-center gap-3 rounded-2xl bg-gradient-to-r from-peacock to-peacock-dark p-5 text-white">
        <Bike className="h-8 w-8" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Recruit delivery partners</p>
          <p className="break-all text-sm text-white/80">Share the partner sign-up page: {typeof window !== "undefined" ? window.location.origin : ""}/delivery/join</p>
        </div>
        <a href="/delivery/join" target="_blank" rel="noreferrer" className="rounded-full bg-white px-4 py-2 font-semibold text-peacock">Open the page</a>
      </section>
    </div>
  );
}
