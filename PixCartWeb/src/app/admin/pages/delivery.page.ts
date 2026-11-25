/*
 * Admin → Delivery overview: today at a glance (partners online, packages waiting for a partner, trips in progress,
 * stuck trips, delivered and failed today), the setup checklist until the fleet is ready, and shortcuts to every
 * delivery page. Refreshes every 30 seconds. Port of frontend/src/app/admin/delivery/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, signal } from "@angular/core";
import {
  AlertTriangle, Bike, ChartColumn, Check, CheckCircle2, ChevronRight, Hourglass, MapPin, MapPinned, MessageSquareWarning, PackageCheck, Radar, Route,
  SlidersHorizontal, UserCheck, Wallet, Wifi, XCircle,
} from "lucide-angular";
import { api, ApiError } from "../../core/api";
import type { DeliveryOverview as Overview } from "../../core/delivery-types";
import { usePolling } from "../../delivery/components/trip";
import { PageHeader } from "../../shared/portal-shell";
import { PushPrompt } from "../../shared/portal/push-prompt";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { ErrorNote } from "../../shared/ui/ui";
import { Kpi } from "../shared/delivery-admin";

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

@Component({
  selector: "pc-admin-delivery-page",
  imports: [PageHeader, PushPrompt, Icon, PcLink, PageLoader, ErrorNote, Kpi],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!o()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <div class="flex flex-col gap-4" data-testid="delivery-overview">
        <pc-page-header title="Delivery overview" [sub]="sub()" />
        <pc-error-note [message]="error()" />
        <pc-push-prompt app="admin" title="Get delivery alerts on this device" text="Stuck trips, packages no partner took, failed deliveries and new partner sign-ups, as notifications." />
        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <pc-kpi [icon]="I.Wifi" label="Online now" [value]="o()!.online" [hint]="'of ' + approved() + ' approved partners'" tone="green" [pulse]="o()!.online > 0" href="/admin/delivery/live" />
          <pc-kpi [icon]="I.Hourglass" label="Waiting for a partner" [value]="o()!.queue" [hint]="queueHint()" [tone]="o()!.queue ? 'amber' : 'gray'" href="/admin/delivery/queue" />
          <pc-kpi [icon]="I.MapPin" label="On a trip" [value]="o()!.on_trip" hint="Packages moving now" href="/admin/delivery/trips?status=active" />
          <pc-kpi [icon]="I.AlertTriangle" label="Stuck trips" [value]="o()!.stuck" [hint]="'Same step over ' + o()!.stuck_minutes + ' min'" [alert]="o()!.stuck > 0" tone="gray" href="/admin/delivery/live" />
          <pc-kpi [icon]="I.CheckCircle2" label="Delivered today" [value]="o()!.delivered_today" tone="green" href="/admin/delivery/trips?status=delivered" />
          <pc-kpi [icon]="I.XCircle" label="Not delivered today" [value]="o()!.failed_today" [tone]="o()!.failed_today ? 'red' : 'gray'" href="/admin/delivery/queue?tab=failed" />
          <pc-kpi [icon]="I.UserCheck" label="Waiting for review" [value]="submitted()" hint="New partner registrations" [tone]="submitted() ? 'amber' : 'gray'" href="/admin/delivery/partners?status=submitted" />
          <pc-kpi [icon]="I.MapPinned" label="Active zones" [value]="o()!.zones" tone="blue" href="/admin/delivery/zones" />
        </div>

        @if (!allDone()) {
          <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
            <h2 class="text-lg font-semibold">Set up your delivery fleet</h2>
            <ol class="mt-3 flex flex-col gap-2">
              @for (s of steps(); track s.title; let i = $index) {
                <li>
                  <a [pcLink]="s.href" class="flex items-center gap-3 rounded-xl p-3 ring-1 ring-line hover:bg-mist">
                    <span [class]="s.done ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-leaf text-white' : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-peacock-light text-peacock'">
                      @if (s.done) {<svg [pcIcon]="I.Check" class="h-5 w-5" />} @else {<span class="font-bold">{{ i + 1 }}</span>}
                    </span>
                    <span class="min-w-0 flex-1"><span class="block font-semibold">{{ s.title }}</span><span class="text-sm text-ink-soft">{{ s.text }}</span></span>
                    <svg [pcIcon]="s.icon" class="h-5 w-5 text-ink-faint" aria-hidden="true" />
                    <svg [pcIcon]="I.ChevronRight" class="h-5 w-5 text-ink-faint" aria-hidden="true" />
                  </a>
                </li>
              }
            </ol>
          </section>
        }

        <section aria-label="Delivery pages" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          @for (l of links; track l.href) {
            <a [pcLink]="l.href" class="group flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/30">
              <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-peacock-light text-peacock"><svg [pcIcon]="l.icon" class="h-5 w-5" aria-hidden="true" /></span>
              <span class="min-w-0 flex-1">
                <span class="block font-semibold">{{ l.title }}</span>
                <span class="block text-sm text-ink-soft">{{ l.text }}</span>
              </span>
              <svg [pcIcon]="I.ChevronRight" class="h-5 w-5 shrink-0 text-ink-faint transition group-hover:translate-x-0.5" aria-hidden="true" />
            </a>
          }
        </section>

        <section class="flex flex-wrap items-center gap-3 rounded-2xl bg-gradient-to-r from-peacock to-peacock-dark p-5 text-white">
          <svg [pcIcon]="I.Bike" class="h-8 w-8" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="font-semibold">Recruit delivery partners</p>
            <p class="break-all text-sm text-white/80">Share the partner sign-up page: {{ origin }}/delivery/join</p>
          </div>
          <a href="/delivery/join" target="_blank" rel="noreferrer" class="rounded-full bg-white px-4 py-2 font-semibold text-peacock">Open the page</a>
        </section>
      </div>
    }
  `,
})
export class AdminDeliveryPage {
  protected readonly I = { Wifi, Hourglass, MapPin, AlertTriangle, CheckCircle2, XCircle, UserCheck, MapPinned, Check, ChevronRight, Bike };
  protected readonly links = LINKS;
  protected readonly origin = window.location.origin;
  protected readonly o = signal<Overview | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly approved = computed(() => this.o()?.partners["approved"] ?? 0);
  protected readonly submitted = computed(() => this.o()?.partners["submitted"] ?? 0);
  protected readonly queueHint = computed(() => {
    const n = this.o()?.offered ?? 0;
    return n ? `${n} request${n === 1 ? "" : "s"} sent` : "Ready for pickup";
  });
  protected readonly steps = computed(() => {
    const o = this.o();
    if (!o) return [];
    return [
      { done: o.zones > 0, title: "Create delivery zones", text: "The PIN codes your partners cover.", href: "/admin/delivery/zones", icon: MapPinned },
      { done: this.approved() > 0, title: "Approve delivery partners", text: "Check documents and choose each partner's zone.", href: "/admin/delivery/partners?status=submitted", icon: UserCheck },
      { done: o.enabled && o.fleet_mode !== "off", title: "Choose which orders they deliver", text: "Fees, cash limits and safety checks too.", href: "/admin/delivery/settings", icon: SlidersHorizontal },
    ];
  });
  protected readonly allDone = computed(() => this.steps().every((s) => s.done));
  protected readonly sub = computed(() => {
    const o = this.o();
    if (!o) return "";
    return `Your own delivery fleet: ${o.enabled ? MODE[o.fleet_mode] ?? o.fleet_mode : "paused"}${o.enabled && o.fleet_mode !== "off" ? `, ${o.auto_assign ? "auto-assign on" : "staff assign every package"}` : ""}.`;
  });

  constructor() {
    usePolling(() => {
      api<Overview>("/api/admin/delivery/overview").then((x) => { this.o.set(x); this.error.set(null); })
        .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load the overview"));
    }, 30_000);
  }
}
