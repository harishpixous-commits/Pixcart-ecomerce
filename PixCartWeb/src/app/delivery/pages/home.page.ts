/*
 * Partner home: the big online switch, today's numbers, the cash held, trips in progress (tap one to continue it)
 * and, while waiting, a "looking for deliveries" card. New requests pop up over this screen (components/feed.ts).
 * Port of frontend/src/app/delivery/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import {
  AlertTriangle, Banknote, ChevronRight, CloudRain, IndianRupee, LocateFixed, MapPin, MapPinOff, Navigation, Package, Radar, Smartphone, Store, Volume2,
  type LucideIconData,
} from "lucide-angular";
import type { TripView } from "../../core/delivery-types";
import { rupees } from "../../core/format";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { DeliveryFeedService } from "../components/feed";
import { PartnerService } from "../components/partner";
import { TripPill } from "../components/trip";
import { NoRequestsNotice, OnlineSwitch } from "../shell/delivery-app";

function greeting(): string {
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

const NEXT_PICKUP: Record<string, string> = {
  accepted: "Go to the customer",
  reached: "Collect the return",
  picked: "Bring it to the store",
  on_the_way: "Hand it to the store",
};

@Component({
  selector: "pc-home-num",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "warn() ? 'block rounded-2xl px-2 py-3 bg-vermilion-light' : 'block rounded-2xl px-2 py-3 bg-mist'" },
  template: `
    <svg [pcIcon]="icon()" [class]="warn() ? 'mx-auto h-4 w-4 text-vermilion' : 'mx-auto h-4 w-4 text-peacock'" />
    <p [class]="warn() ? 'mt-1 font-display text-lg font-bold leading-tight text-vermilion' : 'mt-1 font-display text-lg font-bold leading-tight text-ink'">{{ value() }}</p>
    <p class="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{{ label() }}</p>
  `,
})
export class HomeNum {
  readonly icon = input.required<LucideIconData>();
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly warn = input(false);
}

@Component({
  selector: "pc-home-tip",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5" },
  template: `
    <span [class]="cls()"><svg [pcIcon]="icon()" class="h-5 w-5" /></span>
    <div>
      <p class="font-semibold">{{ title() }}</p>
      <p class="text-sm text-ink-soft">{{ text() }}</p>
    </div>
  `,
})
export class HomeTip {
  readonly icon = input.required<LucideIconData>();
  readonly title = input.required<string>();
  readonly text = input.required<string>();
  readonly tone = input<"good" | "bad" | "plain">("plain");
  protected readonly cls = computed(() => cx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
    this.tone() === "good" ? "bg-leaf-light text-leaf" : this.tone() === "bad" ? "bg-vermilion-light text-vermilion" : "bg-peacock-light text-peacock"));
}

@Component({
  selector: "a[pcActiveTrip]",
  imports: [Icon, TripPill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [{ directive: PcLink, inputs: ["pcLink"] }],
  host: { class: "group flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/40", "data-testid": "active-trip" },
  template: `
    <span [class]="toStore() ? 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-marigold-light text-marigold-dark' : 'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-vermilion-light text-vermilion'">
      <svg [pcIcon]="toStore() ? Store : MapPin" class="h-6 w-6" />
    </span>
    <span class="min-w-0 flex-1">
      <span class="flex flex-wrap items-center gap-2">
        <span class="font-semibold">{{ t().order_number }}</span>
        <pc-trip-pill [trip]="t()" />
        @if (t().payment === "cod" && t().cod_amount > 0 && !back()) {<span class="text-xs font-semibold text-[#8A5A00]">Collect {{ rupees(t().cod_amount) }}</span>}
      </span>
      <span class="block font-semibold text-peacock">{{ nextText() }}</span>
      <span class="block truncate text-sm text-ink-soft">{{ where() }}</span>
    </span>
    <svg [pcIcon]="ChevronRight" class="h-5 w-5 shrink-0 text-ink-faint transition group-hover:translate-x-0.5" />
  `,
})
export class ActiveTrip {
  readonly t = input.required<TripView>({ alias: "pcActiveTrip" });
  protected readonly rupees = rupees;
  protected readonly Store = Store;
  protected readonly MapPin = MapPin;
  protected readonly ChevronRight = ChevronRight;
  protected readonly back = computed(() => this.t().kind === "return");
  private readonly collecting = computed(() => this.t().kind === "pickup");
  protected readonly toStore = computed(() => {
    const t = this.t();
    return this.collecting() ? ["picked", "on_the_way"].includes(t.status) : this.back() || ["accepted", "at_store"].includes(t.status);
  });
  protected readonly nextText = computed(() => {
    const t = this.t();
    return this.collecting() ? NEXT_PICKUP[t.status] ?? t.status_label : this.back() ? "Bring the package back to the store" : NEXT[t.status] ?? t.status_label;
  });
  protected readonly where = computed(() => {
    const t = this.t();
    return this.toStore() ? t.pickup.name : `${t.drop.name}, ${[t.drop.city, t.drop.pincode].filter(Boolean).join(" ")}`;
  });
}

@Component({
  selector: "pc-delivery-home-page",
  imports: [Icon, OnlineSwitch, NoRequestsNotice, HomeNum, HomeTip, ActiveTrip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (partner(); as p) {
      <div class="flex flex-col gap-4" data-testid="partner-home">
        <section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
          <p class="text-sm text-ink-soft">{{ greeting }},</p>
          <h1 class="text-2xl font-bold">{{ p.name.split(" ")[0] }}</h1>
          <p class="mb-4 text-sm text-ink-soft">{{ p.zone ? p.zone.name + ", " + p.zone.city : "Delivery area not set yet" }}</p>
          @if (!inactive()) {<pc-online-switch [large]="true" />}
          <div class="mt-4 grid grid-cols-3 gap-2 text-center">
            <pc-home-num [icon]="Package" label="Delivered today" [value]="'' + todayTrips()" />
            <pc-home-num [icon]="IndianRupee" label="Earned today" [value]="rupees(todayEarned())" />
            <pc-home-num [icon]="Banknote" label="Cash in hand" [value]="rupees(cash())" [warn]="over()" />
          </div>
        </section>

        @if (!paused() && (feed()?.bonus_now ?? 0) > 0) {
          <p class="flex items-start gap-3 rounded-2xl bg-gradient-to-r from-[#1d4f91] to-peacock p-4 text-white shadow-sm" data-testid="bonus-banner">
            <svg [pcIcon]="CloudRain" class="mt-0.5 h-5 w-5 shrink-0" />
            <span>
              <b class="block font-display text-lg leading-tight">Bad weather bonus: +{{ rupees(feed()?.bonus_now ?? 0) }} a trip</b>
              <span class="text-sm text-white/85">Added to every trip you finish while it lasts. Ride safely.</span>
            </span>
          </p>
        }

        @if (over()) {
          <p class="flex items-start gap-2 rounded-2xl bg-vermilion-light p-4 text-sm text-vermilion" role="alert">
            <svg [pcIcon]="AlertTriangle" class="mt-0.5 h-4 w-4 shrink-0" />
            You hold {{ rupees(cash()) }} in cash, above the {{ rupees(limit()) }} limit. Deposit it with the delivery team to keep getting cash-on-delivery orders.
          </p>
        }

        @if (active().length > 0) {
          <section aria-labelledby="active-h" class="flex flex-col gap-2">
            <h2 id="active-h" class="px-1 text-sm font-bold uppercase tracking-[0.12em] text-ink-soft">In progress ({{ active().length }})</h2>
            @for (t of active(); track t.id) {<a [pcActiveTrip]="t" [pcLink]="'/delivery/trips/' + t.id"></a>}
          </section>
        }

        @if (paused()) {<pc-no-requests-notice [inactive]="inactive()" [carrying]="active().length > 0" />}

        @if (!paused()) {
          @if (p.is_online) {
            @if (active().length === 0) {
              <section class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-6 text-center text-white shadow-sm" data-testid="waiting">
                <div class="relative mx-auto flex h-28 w-28 items-center justify-center">
                  <span class="absolute inset-0 animate-ping rounded-full bg-white/15 motion-reduce:animate-none"></span>
                  <span class="absolute inset-3 rounded-full bg-white/10"></span>
                  <svg [pcIcon]="Radar" class="relative h-12 w-12" />
                </div>
                <p class="mt-2 font-display text-xl font-semibold">Looking for deliveries near you</p>
                <p class="text-white/80">Keep the app open. A new request pops up with a sound.</p>
              </section>
            }
          } @else {
            <section class="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
              <p class="font-display text-xl font-semibold">You are offline</p>
              <p class="text-ink-soft">{{ active().length ? "Finish your trips in progress. You will not get new requests." : "Go online to start getting delivery requests." }}</p>
            </section>
          }
        }

        <section class="grid gap-3 sm:grid-cols-3">
          <pc-home-tip [icon]="loc() === 'denied' ? MapPinOff : loc() === 'on' ? LocateFixed : Navigation" [tone]="loc() === 'denied' ? 'bad' : loc() === 'on' ? 'good' : 'plain'"
            [title]="loc() === 'on' ? 'Location is on' : loc() === 'denied' ? 'Location is blocked' : p.is_online ? 'Turning on location…' : 'Location'"
            [text]="loc() === 'denied' ? 'Allow location for this site in your browser settings to get requests.' : loc() === 'on' ? 'Nearby requests and live tracking work.' : 'Shared only while you are online or on a trip.'" />
          <pc-home-tip [icon]="Volume2" tone="plain" title="Sound on" text="Keep your volume up so you hear new requests." />
          <pc-home-tip [icon]="Smartphone" tone="plain" title="Keep the app open" text="Install the app from Profile for the best experience." />
        </section>
      </div>
    }
  `,
})
export class DeliveryHomePage {
  private readonly feeds = inject(DeliveryFeedService);
  protected readonly partner = inject(PartnerService).partner;
  protected readonly feed = this.feeds.feed;
  protected readonly greeting = greeting();
  protected readonly rupees = rupees;
  protected readonly active = computed(() => this.feed()?.active ?? []);
  protected readonly todayTrips = computed(() => this.feed()?.today.trips ?? 0);
  protected readonly todayEarned = computed(() => this.feed()?.today.earned ?? 0);
  protected readonly cash = computed(() => this.feed()?.cash_in_hand ?? 0);
  protected readonly limit = computed(() => this.feed()?.cash_limit ?? 0);
  protected readonly over = computed(() => this.limit() > 0 && this.cash() > this.limit());
  protected readonly loc = this.feeds.location.state;
  protected readonly inactive = computed(() => this.partner()?.is_active === false);
  protected readonly paused = computed(() => this.inactive() || this.feed()?.taking_requests === false);
  protected readonly Package = Package;
  protected readonly IndianRupee = IndianRupee;
  protected readonly Banknote = Banknote;
  protected readonly CloudRain = CloudRain;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Radar = Radar;
  protected readonly MapPinOff = MapPinOff;
  protected readonly LocateFixed = LocateFixed;
  protected readonly Navigation = Navigation;
  protected readonly Volume2 = Volume2;
  protected readonly Smartphone = Smartphone;
}
