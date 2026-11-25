/*
 * Admin → Delivery → Live partners: everyone online right now (and anyone still on a trip), in detail: where they are
 * and how fresh that position is, whether they are free or carrying packages, how long they have been online, today's
 * deliveries and earnings, the cash they hold against the limit, and their rating. The map shows the same partners
 * with the store and customer of each trip. Refreshes every 10 seconds while the page is open.
 * Port of frontend/src/app/admin/delivery/live/page.tsx.
 */

import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal } from "@angular/core";
import {
  AlertTriangle, Banknote, Bike, ChevronRight, Clock, Hourglass, ListChecks, LocateFixed, LocateOff, MapPin, Phone, RefreshCw, Search, Star, Store, UserRound, Wifi,
} from "lucide-angular";
import { api, ApiError } from "../../core/api";
import type { LiveData, LivePartner, TripView } from "../../core/delivery-types";
import { rupees } from "../../core/format";
import { initials, minutesLabel, secondsLabel, telUrl, time, TripPill, useNow, usePolling } from "../../delivery/components/trip";
import { LiveMap, type MapLine, type MapMarker } from "../../shared/map/live-map";
import { PageHeader } from "../../shared/portal-shell";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Input, Select } from "../../shared/ui/ui";
import { Kpi, OnlineDot, PartnerAvatar } from "../shared/delivery-admin";

type Filter = "all" | "free" | "on_trip" | "no_location" | "cash";

const BEFORE_PICKUP = ["offered", "accepted", "at_store"];
const FILTERS: [Filter, string][] = [["all", "Everyone"], ["free", "Free"], ["on_trip", "On a trip"], ["no_location", "Location off"], ["cash", "Over cash limit"]];
const LEGEND: [string, string][] = [["#1E8E3E", "Free"], ["#0B5563", "On a trip"], ["#8A97A0", "Location old"], ["#F5A524", "Store"], ["#D7263D", "Customer"]];

function matches(p: LivePartner, f: Filter): boolean {
  if (f === "free") return p.online && p.state === "free";
  if (f === "on_trip") return p.state === "on_trip";
  if (f === "no_location") return p.location_state !== "live";
  if (f === "cash") return p.cash_in_hand > p.cash_limit;
  return true;
}

function buildMap(partners: LivePartner[], trips: TripView[]): { markers: MapMarker[]; lines: MapLine[] } {
  const markers: MapMarker[] = [];
  const lines: MapLine[] = [];
  const ids = new Set(partners.map((p) => p.id));
  for (const p of partners) {
    if (p.lat === null || p.lng === null || p.location_state === "unknown") continue;
    const kind = p.location_state === "stale" ? "partner-stale" : p.state === "on_trip" ? "partner-busy" : "partner";
    const state = p.state === "on_trip" ? `On a trip (${p.trips.map((t) => t.order_number).join(", ")})` : p.online ? "Free" : "Offline";
    markers.push({ id: `p:${p.id}`, lat: p.lat, lng: p.lng, kind, label: initials(p.name), title: p.name,
      popup: `${p.name}\n${state}\n${p.vehicle}${p.vehicle_no ? ` ${p.vehicle_no}` : ""}\n${p.phone}` });
  }
  for (const t of trips) {
    if (!ids.has(t.partner.id)) continue;
    const store = t.pickup.lat !== null && t.pickup.lng !== null ? ([t.pickup.lat, t.pickup.lng] as [number, number]) : null;
    const home = t.drop.lat !== null && t.drop.lng !== null ? ([t.drop.lat, t.drop.lng] as [number, number]) : null;
    if (store) markers.push({ id: `s:${t.id}`, lat: store[0], lng: store[1], kind: "store", title: t.pickup.name, popup: `Pickup for ${t.order_number}\n${t.pickup.name}\n${t.pickup.address}` });
    if (home) markers.push({ id: `h:${t.id}`, lat: home[0], lng: home[1], kind: "home", title: `Customer, ${t.order_number}`, popup: `Drop for ${t.order_number}\n${t.drop.city} ${t.drop.pincode}` });
    const me = t.partner.lat !== null && t.partner.lng !== null ? ([t.partner.lat, t.partner.lng] as [number, number]) : null;
    // where the partner is heading now: a return pickup goes to the customer first, then the store
    const goingToStore = t.kind === "pickup" ? ["picked", "on_the_way"].includes(t.status) : t.kind === "return" || BEFORE_PICKUP.includes(t.status);
    const target = goingToStore ? store : home;
    if (me && target) lines.push({ id: `l:${t.id}`, points: [me, target], color: goingToStore ? "#F5A524" : "#0B5563", dashed: t.status === "offered" });
    else if (store && home && !goingToStore) lines.push({ id: `r:${t.id}`, points: [store, home], color: "#0B5563", dashed: true });
  }
  return { markers, lines };
}

@Component({
  selector: "pc-live-partner-card",
  imports: [Icon, PcLink, PartnerAvatar, OnlineDot, TripPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <article [class]="selected() ? 'rounded-2xl bg-white p-3.5 shadow-sm ring-1 transition sm:p-4 ring-2 ring-peacock' : 'rounded-2xl bg-white p-3.5 shadow-sm ring-1 transition sm:p-4 ring-black/5 hover:ring-peacock/30'" data-testid="live-partner">
      <button type="button" (click)="pick.emit()" class="flex w-full items-start gap-3 text-left" [attr.aria-pressed]="selected()" [attr.aria-label]="'Show ' + p().name + ' on the map'">
        <span class="relative">
          <pc-partner-avatar [p]="p()" />
          <span [class]="'absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-2 ring-white ' + (!p().online ? 'bg-ink-faint' : p().state === 'free' ? 'bg-leaf' : 'bg-peacock')" aria-hidden="true"></span>
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="font-semibold text-ink">{{ p().name }}</span>
            @if (p().state === "on_trip") {
              <span class="rounded-full bg-peacock-light px-2 py-0.5 text-xs font-semibold text-peacock">On a trip · {{ p().load }}/{{ p().max_active }}</span>
            } @else if (p().online) {
              <span class="rounded-full bg-leaf-light px-2 py-0.5 text-xs font-semibold text-leaf">Free</span>
            }
            @if (!p().online) {<pc-online-dot [online]="false" />}
          </span>
          <span class="block truncate text-sm text-ink-soft">{{ p().vehicle }}{{ p().vehicle_no ? " · " + p().vehicle_no : "" }}{{ p().zone ? " · " + p().zone!.name : " · No zone" }}</span>
          <span class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            @if (p().location_state === "live") {
              <span class="inline-flex items-center gap-1 font-semibold text-leaf"><svg [pcIcon]="LocateFixed" class="h-3.5 w-3.5" />Location live · {{ secondsLabel(age()) }} ago</span>
            } @else if (p().location_state === "stale") {
              <span class="inline-flex items-center gap-1 font-semibold text-marigold-dark"><svg [pcIcon]="LocateFixed" class="h-3.5 w-3.5" />Last seen {{ secondsLabel(age()) }} ago</span>
            } @else {
              <span class="inline-flex items-center gap-1 font-semibold text-vermilion"><svg [pcIcon]="LocateOff" class="h-3.5 w-3.5" />{{ age() === null ? "No location shared" : "Location " + secondsLabel(age()) + " old" }}</span>
            }
            @if (p().online && p().online_minutes !== null) {
              <span class="inline-flex items-center gap-1 text-ink-soft"><svg [pcIcon]="Clock" class="h-3.5 w-3.5" />Online {{ minutesLabel(p().online_minutes) }}{{ p().online_since ? " (since " + time(p().online_since) + ")" : "" }}</span>
            }
          </span>
        </span>
        <svg [pcIcon]="ChevronRight" [class]="selected() ? 'mt-1 h-5 w-5 shrink-0 text-ink-faint transition-transform rotate-90' : 'mt-1 h-5 w-5 shrink-0 text-ink-faint transition-transform'" />
      </button>

      <dl class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="rounded-xl bg-mist px-2.5 py-2"><dt class="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Today</dt><dd class="text-sm font-bold text-ink">{{ p().today_trips }} deliver{{ p().today_trips === 1 ? "y" : "ies" }}</dd></div>
        <div class="rounded-xl bg-mist px-2.5 py-2"><dt class="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Earned today</dt><dd class="text-sm font-bold text-ink">{{ rupees(p().today_earned) }}</dd></div>
        <div class="rounded-xl bg-mist px-2.5 py-2"><dt class="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Rating</dt><dd class="text-sm font-bold text-ink">@if (p().rating_count) {<span class="inline-flex items-center gap-1"><svg [pcIcon]="Star" class="h-3.5 w-3.5 fill-marigold text-marigold" />{{ p().rating_avg.toFixed(1) }}<span class="font-normal text-ink-faint">({{ p().rating_count }})</span></span>} @else {New}</dd></div>
        <div [class]="overCash() ? 'rounded-xl px-2.5 py-2 bg-vermilion-light' : 'rounded-xl px-2.5 py-2 bg-mist'">
          <dt [class]="overCash() ? 'text-[11px] font-semibold uppercase tracking-wide text-vermilion' : 'text-[11px] font-semibold uppercase tracking-wide text-ink-faint'">Cash in hand</dt>
          <dd [class]="overCash() ? 'text-sm font-bold text-vermilion' : 'text-sm font-bold text-ink'">{{ rupees(p().cash_in_hand) }}</dd>
          @if (p().cash_limit > 0) {
            <div class="mt-1 h-1 overflow-hidden rounded-full bg-white" [attr.title]="'Limit ' + rupees(p().cash_limit)">
              <div [class]="'h-full rounded-full ' + (overCash() ? 'bg-vermilion' : cashPct() > 75 ? 'bg-marigold' : 'bg-leaf')" [style.width.%]="cashPct()"></div>
            </div>
          }
        </div>
      </dl>

      @if (trips().length > 0) {
        <ul class="mt-3 flex flex-col gap-1.5">
          @for (t of trips(); track t.id) {
            <li>
              <a [pcLink]="'/admin/delivery/trips/' + t.id" [class]="t.stuck ? 'flex items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 transition hover:bg-mist bg-vermilion-light/60 ring-vermilion/30' : 'flex items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 transition hover:bg-mist ring-line'">
                <span class="font-semibold">{{ t.order_number }}</span>
                <pc-trip-pill [trip]="t" />
                @if (t.kind !== "delivery") {<span class="text-xs font-semibold text-marigold-dark">{{ t.kind === "pickup" ? "Return pickup" : "Return" }}</span>}
                <span [class]="t.stuck ? 'ml-auto shrink-0 text-xs font-bold text-vermilion' : 'ml-auto shrink-0 text-xs text-ink-faint'">{{ t.stuck ? "Stuck · " : "" }}{{ minutesLabel(t.minutes_in_step ?? 0) }}</span>
              </a>
            </li>
          }
        </ul>
      }

      <div class="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
        <a [href]="tel(p().phone)" class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-peacock px-3 text-sm font-semibold text-white hover:bg-peacock-dark"><svg [pcIcon]="Phone" class="h-4 w-4" /> Call {{ p().phone }}</a>
        <a [pcLink]="'/admin/delivery/partners/' + p().id" class="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light"><svg [pcIcon]="UserRound" class="h-4 w-4" /> Profile</a>
        <a [pcLink]="'/admin/delivery/trips?partner_id=' + p().id" class="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-peacock hover:bg-peacock-light"><svg [pcIcon]="ListChecks" class="h-4 w-4" /> Trips</a>
        <span class="ml-auto self-center text-xs text-ink-faint">{{ p().location_state !== "unknown" && p().lat !== null ? p().lat!.toFixed(4) + ", " + p().lng?.toFixed(4) : "" }}</span>
      </div>
    </article>
  `,
})
export class LivePartnerCard {
  readonly p = input.required<LivePartner>();
  readonly trips = input.required<TripView[]>();
  readonly now = input.required<number>();
  readonly fetchedAt = input.required<number>();
  readonly selected = input(false);
  readonly pick = output<void>();
  protected readonly LocateFixed = LocateFixed; protected readonly LocateOff = LocateOff; protected readonly Clock = Clock; protected readonly ChevronRight = ChevronRight;
  protected readonly Star = Star; protected readonly Phone = Phone; protected readonly UserRound = UserRound; protected readonly ListChecks = ListChecks;
  protected readonly rupees = rupees; protected readonly secondsLabel = secondsLabel; protected readonly minutesLabel = minutesLabel; protected readonly time = time; protected readonly tel = telUrl;
  // the position's age as of now (the server measured it at the last refresh)
  protected readonly age = computed(() => { const a = this.p().location_age_seconds; return a === null ? null : a + Math.max(0, Math.round((this.now() - this.fetchedAt()) / 1000)); });
  protected readonly overCash = computed(() => this.p().cash_in_hand > this.p().cash_limit);
  protected readonly cashPct = computed(() => { const p = this.p(); return p.cash_limit > 0 ? Math.min(100, Math.round((100 * p.cash_in_hand) / p.cash_limit)) : 0; });
}

@Component({
  selector: "pc-live-trips-table",
  imports: [Icon, PcLink, TripPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5" aria-labelledby="live-trips-h">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="live-trips-h" class="text-lg font-semibold">Trips in progress <span class="text-ink-faint">({{ trips().length }})</span></h2>
        <a pcLink="/admin/delivery/trips?status=active" class="text-sm font-semibold text-peacock">All trips</a>
      </div>
      @if (trips().length === 0) {
        <p class="text-ink-soft">No packages are moving right now.</p>
      } @else {
        <ul class="divide-y divide-line">
          @for (t of trips(); track t.id) {
            <li>
              <a [pcLink]="'/admin/delivery/trips/' + t.id" class="flex flex-col gap-1 py-3 hover:bg-mist/60 sm:flex-row sm:items-center sm:gap-4 sm:px-2">
                <span class="flex min-w-0 items-center gap-2 sm:w-56"><span class="font-semibold">{{ t.order_number }}</span><pc-trip-pill [trip]="t" /></span>
                <span class="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink-soft">
                  <svg [pcIcon]="Store" class="h-4 w-4 shrink-0 text-marigold-dark" />
                  <span class="truncate">{{ t.pickup.name }}</span>
                  <svg [pcIcon]="ChevronRight" class="h-4 w-4 shrink-0 text-ink-faint" />
                  <svg [pcIcon]="MapPin" class="h-4 w-4 shrink-0 text-vermilion" />
                  <span class="truncate">{{ dropText(t) }}</span>
                </span>
                <span class="flex items-center gap-3 text-sm sm:w-72 sm:justify-end">
                  <span class="truncate">{{ t.partner.name }}</span>
                  @if (t.payment === "cod" && t.cod_amount > 0) {<span class="shrink-0 rounded-full bg-marigold-light px-2 py-0.5 text-xs font-semibold text-[#8A5A00]">COD {{ rupees(t.cod_amount) }}</span>}
                  <span [class]="t.stuck ? 'shrink-0 text-xs font-bold text-vermilion' : 'shrink-0 text-xs text-ink-faint'">{{ t.stuck ? "Stuck " : "" }}{{ minutesLabel(t.minutes_in_step ?? 0) }}</span>
                </span>
              </a>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class LiveTripsTable {
  readonly trips = input.required<TripView[]>();
  protected readonly Store = Store; protected readonly ChevronRight = ChevronRight; protected readonly MapPin = MapPin;
  protected readonly rupees = rupees; protected readonly minutesLabel = minutesLabel;
  protected dropText(t: TripView): string {
    return [t.drop.city, t.drop.pincode].filter(Boolean).join(" ");
  }
}

@Component({
  selector: "pc-admin-delivery-live-page",
  imports: [PageHeader, Icon, PcLink, PageLoader, Button, EmptyState, ErrorNote, Input, Select, Kpi, LiveMap, LivePartnerCard, LiveTripsTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!data()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <div class="flex flex-col gap-4" data-testid="delivery-live">
        <pc-page-header title="Live partners" sub="Who is online right now, where they are and what they are carrying. Updates every 10 seconds." [withActions]="true">
          <div actions class="flex items-center gap-2">
            <span class="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink-soft ring-1 ring-line" aria-live="polite">
              <span [class]="error() ? 'h-2 w-2 rounded-full bg-vermilion' : 'h-2 w-2 rounded-full bg-leaf shadow-[0_0_0_3px_rgba(30,142,62,0.2)]'"></span>
              {{ liveText() }}
            </span>
            <button pcButton variant="secondary" size="sm" (click)="load()" [disabled]="busy()" aria-label="Refresh now">
              <svg [pcIcon]="RefreshCw" [class]="busy() ? 'h-4 w-4 animate-spin' : 'h-4 w-4'" /> <span class="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </pc-page-header>

        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <pc-kpi [icon]="Wifi" label="Online now" [value]="s().online" [hint]="s().free + ' free, ' + s().on_trip + ' on a trip'" tone="green" [pulse]="s().online > 0" testId="live-online" />
          <pc-kpi [icon]="Bike" label="Free to deliver" [value]="s().free" hint="Online with no trip" tone="green" />
          <pc-kpi [icon]="MapPin" label="On a trip" [value]="s().on_trip" [hint]="trips().length + ' package' + (trips().length === 1 ? '' : 's') + ' moving'" />
          <pc-kpi [icon]="AlertTriangle" label="Stuck trips" [value]="s().stuck" hint="Same step for too long" [alert]="s().stuck > 0" tone="gray" href="/admin/delivery/trips?status=active" />
          <pc-kpi [icon]="Hourglass" label="Waiting for a partner" [value]="s().waiting" hint="Ready for pickup" [tone]="s().waiting ? 'amber' : 'gray'" href="/admin/delivery/queue" />
          <pc-kpi [icon]="Banknote" label="Cash with partners" [value]="rupees(s().cash_in_hand)" [hint]="counts().cash ? counts().cash + ' over the limit' : 'Cash on delivery to deposit'" [tone]="counts().cash ? 'red' : 'gray'" href="/admin/delivery/payouts?tab=cash" />
        </div>

        @if (data()!.by_zone.length > 0) {
          <div class="scroll-x -mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="By zone">
            @for (z of data()!.by_zone; track z.zone) {
              <div class="flex shrink-0 items-center gap-3 rounded-xl bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-black/5">
                <span class="font-semibold">{{ z.zone }}</span>
                <span class="flex items-center gap-1 text-leaf"><span class="h-2 w-2 rounded-full bg-leaf"></span>{{ z.online }} online</span>
                <span class="text-ink-soft">{{ z.free }} free</span>
                <span class="text-peacock">{{ z.on_trip }} on trip</span>
              </div>
            }
          </div>
        }

        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
          <section class="flex flex-col gap-2 xl:sticky xl:top-[84px] xl:h-[calc(100vh-110px)]" aria-label="Map">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
                @for (l of legend; track l[1]) {<span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full" [style.background]="l[0]"></span> {{ l[1] }}</span>}
              </p>
              @if (selected()) {<button pcButton variant="ghost" size="sm" (click)="showAll()">Show everyone</button>}
            </div>
            <pc-live-map [markers]="map().markers" [lines]="map().lines" [tiles]="data()!.map_tiles" [attribution]="data()!.map_attribution" [fitKey]="fit().key"
              [fitPoints]="selected() ? focusPoints() : undefined" (marker)="onMarker($event)" boxClass="h-[52vh] min-h-[320px] xl:h-auto xl:flex-1" />
            @if (map().markers.length === 0) {<p class="text-sm text-ink-soft">No one online has shared a location yet. Partners share it from the app while they are online.</p>}
          </section>

          <section class="flex min-w-0 flex-col gap-3" aria-label="Partners online">
            <div class="scroll-x -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Show">
              @for (f of filters; track f[0]) {
                <button type="button" role="tab" [attr.aria-selected]="filter() === f[0]" (click)="filter.set(f[0])"
                  [class]="filter() === f[0] ? 'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors bg-peacock text-white' : 'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors bg-white text-ink-soft ring-1 ring-line hover:text-ink'">
                  {{ f[1] }}
                  <span [class]="filter() === f[0] ? 'rounded-full px-1.5 text-xs bg-white/20' : 'rounded-full px-1.5 text-xs bg-mist'">{{ counts()[f[0]] }}</span>
                </button>
              }
            </div>
            <div class="flex flex-wrap gap-2">
              <div class="relative min-w-[200px] flex-1">
                <svg [pcIcon]="Search" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Name, mobile or vehicle number" aria-label="Search partners" class="pl-9" />
              </div>
              @if (zones().length > 1 || (zones().length && noZone())) {
                <select pcSelect (change)="zone.set($any($event.target).value)" aria-label="Zone" class="w-auto min-w-[160px]">
                  <option value="" [selected]="zone() === ''">All zones</option>
                  @for (z of zones(); track z.id) {<option [value]="z.id" [selected]="zone() === z.id">{{ z.name }}</option>}
                  @if (noZone()) {<option value="none" [selected]="zone() === 'none'">No zone</option>}
                </select>
              }
            </div>
            @if (error()) {<pc-error-note [message]="error() + '. Showing the last update.'" />}

            @if (partners().length === 0) {
              <pc-empty-state title="No one is online right now" body="Partners appear here the moment they go online in the partner app.">
                <a action pcLink="/admin/delivery/partners?status=approved" class="font-semibold text-peacock">See all partners</a>
              </pc-empty-state>
            } @else if (shown().length === 0) {
              <p class="rounded-xl bg-white p-6 text-center text-ink-soft ring-1 ring-black/5">No partner matches. Try another filter.</p>
            } @else {
              <ul class="flex flex-col gap-2.5 xl:max-h-[calc(100vh-250px)] xl:overflow-y-auto xl:pr-1" data-testid="live-partners">
                @for (p of shown(); track p.id) {
                  <li [attr.data-partner]="p.id">
                    <pc-live-partner-card [p]="p" [trips]="tripsOf(p.id)" [now]="now()" [fetchedAt]="fetchedAt()" [selected]="selected() === p.id" (pick)="choose(p.id, false)" />
                  </li>
                }
              </ul>
            }
          </section>
        </div>

        <pc-live-trips-table [trips]="trips()" />
      </div>
    }
  `,
})
export class AdminDeliveryLivePage {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly Wifi = Wifi; protected readonly Bike = Bike; protected readonly MapPin = MapPin; protected readonly AlertTriangle = AlertTriangle;
  protected readonly Hourglass = Hourglass; protected readonly Banknote = Banknote; protected readonly RefreshCw = RefreshCw; protected readonly Search = Search;
  protected readonly rupees = rupees;
  protected readonly filters = FILTERS;
  protected readonly legend = LEGEND;
  protected readonly data = signal<LiveData | null>(null);
  protected readonly fetchedAt = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly filter = signal<Filter>("all");
  protected readonly zone = signal("");
  protected readonly q = signal("");
  protected readonly selected = signal<string | null>(null);
  protected readonly fit = signal({ key: "all:0", n: 0 });
  protected readonly now = useNow(1000);

  protected readonly partners = computed(() => this.data()?.partners ?? []);
  protected readonly trips = computed(() => this.data()?.trips ?? []);
  protected readonly s = computed(() => this.data()!.summary);
  protected readonly shown = computed(() => {
    const needle = this.q().trim().toLowerCase();
    const f = this.filter(), zone = this.zone();
    return this.partners().filter((p) =>
      matches(p, f) &&
      (!zone || (p.zone?.id ?? "none") === zone) &&
      (!needle || p.name.toLowerCase().includes(needle) || p.phone.includes(needle) || p.vehicle_no.toLowerCase().replace(/\s/g, "").includes(needle.replace(/\s/g, ""))),
    );
  });
  protected readonly counts = computed(() => {
    const ps = this.partners();
    return {
      all: ps.length,
      free: ps.filter((p) => matches(p, "free")).length,
      on_trip: ps.filter((p) => matches(p, "on_trip")).length,
      no_location: ps.filter((p) => matches(p, "no_location")).length,
      cash: ps.filter((p) => matches(p, "cash")).length,
    } as Record<Filter, number>;
  });
  protected readonly map = computed(() => buildMap(this.shown(), this.trips()));
  protected readonly focusPoints = computed(() => {
    const id = this.selected();
    if (!id) return undefined;
    const p = this.partners().find((x) => x.id === id);
    if (!p) return undefined;
    const pts: [number, number][] = [];
    if (p.lat !== null && p.lng !== null && p.location_state !== "unknown") pts.push([p.lat, p.lng]);
    for (const t of this.trips().filter((x) => x.partner.id === p.id)) {
      if (t.pickup.lat !== null && t.pickup.lng !== null) pts.push([t.pickup.lat, t.pickup.lng]);
      if (t.drop.lat !== null && t.drop.lng !== null) pts.push([t.drop.lat, t.drop.lng]);
    }
    return pts.length ? pts : undefined;
  });
  protected readonly zones = computed(() => [...new Map(this.partners().filter((p) => p.zone).map((p) => [p.zone!.id, p.zone!])).values()]);
  protected readonly noZone = computed(() => this.partners().some((p) => !p.zone));
  protected readonly liveText = computed(() => {
    const at = this.fetchedAt();
    const updated = at ? Math.max(0, Math.round((this.now() - at) / 1000)) : null;
    return this.error() ? "Reconnecting…" : updated === null ? "Live" : updated < 3 ? "Live · just now" : `Live · ${updated} s ago`;
  });

  constructor() {
    usePolling(() => this.load(), 10_000);
  }

  protected load(): void {
    this.busy.set(true);
    api<LiveData>("/api/admin/delivery/live")
      .then((d) => {
        this.data.set(d);
        this.fetchedAt.set(Date.now());
        this.error.set(null);
      })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not refresh the live view"))
      .finally(() => this.busy.set(false));
  }

  protected tripsOf(id: string): TripView[] {
    return this.trips().filter((t) => t.partner.id === id);
  }

  protected choose(id: string, scroll: boolean): void {
    this.selected.set(id);
    this.fit.update((f) => ({ key: `p:${id}:${f.n + 1}`, n: f.n + 1 }));
    if (scroll) this.host.querySelector(`[data-partner="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  protected showAll(): void {
    this.selected.set(null);
    this.fit.update((f) => ({ key: `all:${f.n + 1}`, n: f.n + 1 }));
  }

  protected onMarker(id: string): void {
    if (id.startsWith("p:")) this.choose(id.slice(2), true);
  }
}
