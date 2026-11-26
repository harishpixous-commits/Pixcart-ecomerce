/*
 * One trip, step by step, built for one hand on a phone: the map with the store, the customer and you; the next thing
 * to do in a big card (reached the store, the seller's pickup code, start the trip, arrived, the customer's OTP, the
 * cash collected and a photo of the delivered package); navigation and call buttons; the address, instructions and
 * items. "Could not deliver" records why. A return trip brings a package back to the store with the seller's code; a
 * return pickup collects a customer's return (their pickup code) and hands it to the store (the seller's code).
 * Port of frontend/src/app/delivery/trips/[id]/page.tsx (with Action, CodeInput, PlaceCard, TeamHelp, ProofThumb and
 * FailDialog).
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, model, output, signal, untracked } from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ActivatedRoute } from "@angular/router";
import { map } from "rxjs";
import {
  ArrowLeft, Banknote, Camera, Check, CheckCircle2, ChevronDown, CircleAlert, House, KeyRound, LifeBuoy, MapPin, MessageCircle, Navigation, Package, Phone, ShoppingBag, Store,
  Undo2, X, type LucideIconData,
} from "lucide-angular";
import { ApiError, api, downloadBlob } from "../../core/api";
import type { TripView } from "../../core/delivery-types";
import { rupees, toPaise } from "../../core/format";
import { shrinkImage } from "../../core/image";
import { LiveMap, type MapLine, type MapMarker } from "../../shared/map/live-map";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, Input, Modal, Textarea, Toast } from "../../shared/ui/ui";
import { DeliveryFeedService } from "../components/feed";
import { deliveryOptions } from "../components/partner";
import { TripPill, TripProgress, navigateUrl, telUrl, time, usePolling } from "../components/trip";
import { FullLoader } from "../shell/delivery-app";

type Step = "at_store" | "picked" | "on_the_way" | "reached";
type Pos = { lat: number; lng: number } | null;

/** Where the partner is now: the last shared position if it is recent, else one quick reading. */
function here(last: GeolocationPosition | null): Promise<Pos> {
  if (last && Date.now() - last.timestamp < 60_000) return Promise.resolve({ lat: last.coords.latitude, lng: last.coords.longitude });
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 30_000 },
    );
  });
}

/* ---------------------------------------------------------------- pieces */

/** The next thing to do: an icon, a title, a line of text and the controls (projected). */
@Component({
  selector: "pc-trip-action",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3" },
  template: `
    <div class="flex items-start gap-3">
      <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-peacock-light text-peacock"><svg [pcIcon]="icon()" class="h-6 w-6" /></span>
      <div class="min-w-0">
        <h2 class="font-display text-xl font-bold leading-tight">{{ title() }}</h2>
        <p class="text-ink-soft">{{ text() }}</p>
      </div>
    </div>
    <ng-content />
  `,
})
export class TripAction {
  readonly icon = input.required<LucideIconData>();
  readonly title = input.required<string>();
  readonly text = input.required<string>();
}

@Component({
  selector: "pc-code-input",
  imports: [Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <label class="block">
      <span class="text-sm font-semibold">{{ label() }}</span>
      @if (hint()) {<span class="block text-xs text-ink-faint">{{ hint() }}</span>}
      <input pcInput [value]="value()" (input)="changed($event)" inputmode="numeric" autocomplete="one-time-code" placeholder="••••"
        class="mt-1 h-14 text-center font-mono text-2xl font-bold tracking-[0.5em]" [attr.data-testid]="testId()" />
    </label>
  `,
})
export class CodeInput {
  readonly label = input.required<string>();
  readonly hint = input<string | undefined>(undefined);
  readonly value = model("");
  readonly testId = input.required<string>();
  protected changed(e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = el.value.replace(/\D/g, "").slice(0, 6);
    if (v !== el.value) el.value = v;
    this.value.set(v);
  }
}

@Component({
  selector: "pc-place-card",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5" },
  template: `
    <p class="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-ink-faint">
      <span [class]="tone() === 'store' ? 'flex h-6 w-6 items-center justify-center rounded-full text-white bg-marigold' : 'flex h-6 w-6 items-center justify-center rounded-full text-white bg-vermilion'"><svg [pcIcon]="icon()" class="h-3.5 w-3.5" /></span>
      {{ title() }}
    </p>
    <p class="font-semibold">{{ name() }}</p>
    <p class="text-sm text-ink-soft">{{ address() }}</p>
    @if (instructions()) {<p class="rounded-xl bg-marigold-light/70 px-3 py-2 text-sm"><b>Instructions:</b> {{ instructions() }}</p>}
    @if (noBag()) {<p class="text-sm font-semibold text-leaf">Customer asked for no carry bag</p>}
    @if (phone() || nav()) {
      <div class="mt-1 flex gap-2">
        @if (phone()) {
          <a [href]="tel(phone()!)" class="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-peacock-light font-semibold text-peacock hover:bg-peacock hover:text-white">
            <svg [pcIcon]="Phone" class="h-4 w-4" /> Call
          </a>
        }
        @if (nav()) {
          <a [href]="nav()" target="_blank" rel="noopener noreferrer" class="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-peacock-light font-semibold text-peacock hover:bg-peacock hover:text-white">
            <svg [pcIcon]="Navigation" class="h-4 w-4" /> Directions
          </a>
        }
      </div>
    }
  `,
})
export class PlaceCard {
  readonly icon = input.required<LucideIconData>();
  readonly tone = input.required<"store" | "home">();
  readonly title = input.required<string>();
  readonly name = input.required<string>();
  readonly address = input.required<string>();
  readonly phone = input<string | undefined>(undefined);
  readonly nav = input<string | undefined>(undefined);
  readonly instructions = input<string | undefined>(undefined);
  readonly noBag = input<boolean | undefined>(undefined);
  protected readonly tel = telUrl;
  protected readonly Phone = Phone;
  protected readonly Navigation = Navigation;
}

/** A problem on the road (accident, wrong item, unsafe place, app trouble): call or message the delivery team. */
@Component({
  selector: "pc-team-help",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (phone() || whatsapp()) {
      <section class="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5" aria-label="Help from the delivery team" data-testid="trip-help">
        <svg [pcIcon]="LifeBuoy" class="h-5 w-5 shrink-0 text-vermilion" />
        <p class="min-w-0 flex-1 text-sm"><span class="font-semibold">Problem on the way?</span> <span class="text-ink-soft">Talk to the delivery team.</span></p>
        @if (phone()) {<a [href]="tel(phone())" class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-vermilion-light px-3 text-sm font-semibold text-vermilion"><svg [pcIcon]="Phone" class="h-4 w-4" />Call</a>}
        @if (wa()) {<a [href]="wa()" target="_blank" rel="noopener noreferrer" class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-leaf-light px-3 text-sm font-semibold text-leaf"><svg [pcIcon]="MessageCircle" class="h-4 w-4" />WhatsApp</a>}
      </section>
    }
  `,
})
export class TeamHelp {
  readonly orderNumber = input.required<string>();
  private readonly options = deliveryOptions();
  protected readonly phone = computed(() => this.options()?.support_phone ?? "");
  protected readonly whatsapp = computed(() => (this.options()?.support_whatsapp ?? "").replace(/\D/g, ""));
  protected readonly wa = computed(() => {
    const w = this.whatsapp();
    return w ? `https://wa.me/${w.length === 10 ? `91${w}` : w}?text=${encodeURIComponent(`Help with delivery ${this.orderNumber()}`)}` : "";
  });
  protected readonly tel = telUrl;
  protected readonly LifeBuoy = LifeBuoy;
  protected readonly Phone = Phone;
  protected readonly MessageCircle = MessageCircle;
}

@Component({
  selector: "pc-proof-thumb",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (url()) {<img [src]="url()" alt="Delivery photo" class="mt-1 h-28 w-28 rounded-2xl object-cover ring-1 ring-line" />}`,
})
export class ProofThumb {
  readonly id = input.required<string>();
  protected readonly url = signal<string | null>(null);
  constructor() {
    effect((onCleanup) => {
      const id = this.id();
      let live = true;
      let made = "";
      downloadBlob(`/api/delivery/trips/${id}/proof`).then((b) => {
        made = URL.createObjectURL(b);
        if (live) this.url.set(made);
      }).catch(() => {});
      onCleanup(() => { live = false; if (made) URL.revokeObjectURL(made); });
    });
  }
}

@Component({
  selector: "pc-fail-dialog",
  imports: [Modal, ErrorNote, Textarea, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="open()" (close)="closed.emit()" [title]="collecting() ? 'Why could you not collect the return?' : 'Why could you not deliver?'">
      <form (submit)="submit($event)" class="flex flex-col gap-3" data-testid="fail-dialog">
        <p class="text-sm text-ink-soft">{{ collecting() ? "Call the customer first. If you still cannot collect it, choose why." : "Call the customer first. If you still cannot deliver, choose why. Keep the package safe with you." }}</p>
        <pc-error-note [message]="error()" />
        <fieldset class="flex flex-col gap-2">
          <legend class="sr-only">Reason</legend>
          @for (r of reasons(); track r[0]) {
            <label [class]="reason() === r[0] ? 'flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition bg-vermilion-light ring-vermilion' : 'flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition ring-line hover:bg-mist'">
              <input type="radio" name="fail" [value]="r[0]" [checked]="reason() === r[0]" (change)="reason.set(r[0])" class="h-4 w-4 accent-vermilion" />
              <span class="font-medium">{{ r[1] }}</span>
            </label>
          }
        </fieldset>
        <textarea pcTextarea [value]="note()" (input)="note.set($any($event.target).value)" placeholder="Add details (optional)" rows="2" maxlength="200" aria-label="Details"></textarea>
        <button pcButton type="submit" variant="danger" [loading]="busy()" [disabled]="!reason()" class="self-start">{{ collecting() ? "Report not collected" : "Report not delivered" }}</button>
      </form>
    </pc-modal>
  `,
})
export class FailDialog {
  readonly open = input(false);
  readonly tripId = input.required<string>();
  readonly collecting = input(false);
  readonly last = input<GeolocationPosition | null>(null);
  readonly closed = output<void>();
  readonly done = output<TripView>();
  private readonly options = deliveryOptions();
  protected readonly reasons = computed(() => Object.entries(this.options()?.fail_reasons ?? {}).filter(([k]) => !(this.collecting() && k === "no_cash")));
  protected readonly reason = signal("");
  protected readonly note = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.reason()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const pos = await here(this.last());
      const next = await api<TripView>(`/api/delivery/trips/${this.tripId()}/fail`, { method: "POST", body: { reason: this.reason(), note: this.note().trim(), ...(pos ?? {}) } });
      this.reason.set("");
      this.note.set("");
      this.done.emit(next);
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save. Try again.");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- the page */

@Component({
  selector: "pc-delivery-trips-id-page",
  imports: [Icon, PcLink, Button, ErrorNote, Input, LiveMap, FullLoader, TripPill, TripProgress, TripAction, CodeInput, PlaceCard, TeamHelp, ProofThumb, FailDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (trip(); as t) {
      <div class="flex flex-col gap-4" data-testid="trip-page">
        <header class="flex flex-wrap items-center gap-2">
          <a pcLink="/delivery" class="flex h-10 w-10 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-black/5" aria-label="Back to home">
            <svg [pcIcon]="ArrowLeft" class="h-5 w-5" />
          </a>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">{{ collecting() ? "Return pickup" + (t.return_number ? " · " + t.return_number : "") : back() ? "Return to store" : "Delivery" }}</p>
            <h1 class="font-display text-xl font-bold leading-tight">{{ t.order_number }}</h1>
          </div>
          <pc-trip-pill [trip]="t" />
        </header>

        @if (!ended()) {
          <div class="relative isolate">
            <pc-live-map [markers]="map().markers" [lines]="map().lines" [fitKey]="t.id + ':' + (toStore() ? 'store' : 'home') + ':' + map().markers.length" boxClass="h-56 sm:h-72" />
            <a [href]="navUrl()" target="_blank" rel="noopener noreferrer" data-testid="navigate"
              class="absolute bottom-3 right-3 z-10 inline-flex h-11 items-center gap-2 rounded-full bg-peacock px-4 font-semibold text-white shadow-lg hover:bg-peacock-dark">
              <svg [pcIcon]="Navigation" class="h-4 w-4" /> Navigate to {{ toStore() ? "store" : "customer" }}
            </a>
          </div>
        }

        <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <ol pcTripProgress [trip]="t"></ol>
        </section>

        <!-- the next thing to do -->
        <section class="rounded-2xl bg-white p-4 shadow-sm ring-2 ring-peacock/20 sm:p-5" aria-live="polite" data-testid="trip-action">
          <pc-error-note [message]="actionError()" />
          @if (t.status === "offered") {
            <pc-trip-action [icon]="Package" title="New request" text="Accept or reject it in the request window." />
          }

          @if (isDelivery() && t.status === "accepted") {
            <pc-trip-action [icon]="Store" title="Go to the store" [text]="'Pick up ' + t.order_number + ' from ' + t.pickup.name + '.'">
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'at_store'" (click)="step('at_store', 'Marked as at the store')" data-testid="step-at-store">
                <svg [pcIcon]="Store" class="h-5 w-5" /> I have reached the store
              </button>
            </pc-trip-action>
          }

          @if (isDelivery() && t.status === "at_store") {
            <pc-trip-action [icon]="KeyRound" title="Collect the package" [text]="t.needs.pickup_code ? 'Check the items, then ask the seller for the 4-digit pickup code shown on their order screen.' : 'Check the items and take the package.'">
              @if (t.needs.pickup_code) {<pc-code-input label="Seller's pickup code" [(value)]="code" testId="pickup-code" />}
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'picked'" [disabled]="t.needs.pickup_code && code().trim().length < 4"
                (click)="step('picked', 'Picked up. Now head to the customer.')" data-testid="step-picked">
                <svg [pcIcon]="Package" class="h-5 w-5" /> Picked up
              </button>
            </pc-trip-action>
          }

          @if (isDelivery() && t.status === "picked") {
            <pc-trip-action [icon]="Navigation" title="Package with you" text="Start the trip and head to the customer. They can see you on the map.">
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'on_the_way'" (click)="step('on_the_way', 'Trip started')" data-testid="step-on-the-way">
                <svg [pcIcon]="Navigation" class="h-5 w-5" /> Start the trip
              </button>
            </pc-trip-action>
          }

          @if (isDelivery() && t.status === "on_the_way") {
            <pc-trip-action [icon]="MapPin" title="On the way to the customer" [text]="t.drop.instructions ? 'Note from the customer: ' + t.drop.instructions : 'Call the customer if you can\\'t find the address.'">
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'reached'" (click)="step('reached', 'Marked as arrived. The customer was told.')" data-testid="step-reached">
                <svg [pcIcon]="House" class="h-5 w-5" /> I have arrived
              </button>
            </pc-trip-action>
          }

          @if (isDelivery() && t.status === "reached") {
            <pc-trip-action [icon]="CheckCircle2" title="Hand over the package" text="Give the package to the customer, then fill in the details below.">
              <div class="flex flex-col gap-4">
                @if (t.needs.otp) {<pc-code-input label="Delivery OTP from the customer" hint="The customer sees it in their SMS and on their order page." [(value)]="otp" testId="delivery-otp" />}
                @if (collect()) {
                  <div class="rounded-2xl bg-marigold-light/70 p-4">
                    <p class="flex items-center gap-2 font-semibold text-[#8A5A00]"><svg [pcIcon]="Banknote" class="h-5 w-5" /> Collect {{ rupees(t.cod_amount) }}</p>
                    <div class="mt-3 grid grid-cols-2 gap-2">
                      @for (m of codMethods; track m) {
                        <button type="button" (click)="codMethod.set(m)" [attr.aria-pressed]="codMethod() === m" [attr.data-testid]="'cod-' + m"
                          [class]="codMethod() === m ? 'h-11 rounded-xl font-semibold ring-1 transition bg-peacock text-white ring-peacock' : 'h-11 rounded-xl font-semibold ring-1 transition bg-white text-ink ring-line'">
                          {{ m === "cash" ? "Cash" : "UPI" }}
                        </button>
                      }
                    </div>
                    <label class="mt-3 block">
                      <span class="text-sm font-semibold">Amount collected (₹)</span>
                      <input pcInput [value]="cod()" (input)="cod.set($any($event.target).value)" inputmode="decimal" [placeholder]="'' + t.cod_amount / 100" class="mt-1 text-lg font-bold" data-testid="cod-amount" />
                    </label>
                  </div>
                }
                @if (t.needs.photo) {
                  <div>
                    <p class="text-sm font-semibold">Photo of the delivered package</p>
                    <p class="text-xs text-ink-faint">At the door or in the customer's hands. Avoid faces.</p>
                    <label [class]="photo() ? 'mt-2 flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-dashed p-3 transition border-leaf bg-leaf-light/40' : 'mt-2 flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-dashed p-3 transition border-line hover:border-peacock'">
                      @if (photo(); as ph) {
                        <img [src]="ph.url" alt="Delivered package" class="h-20 w-20 rounded-xl object-cover" />
                      } @else {
                        <span class="flex h-20 w-20 items-center justify-center rounded-xl bg-mist text-peacock"><svg [pcIcon]="Camera" class="h-8 w-8" /></span>
                      }
                      <span class="font-semibold text-peacock">{{ photo() ? "Retake photo" : "Take photo" }}</span>
                      <input type="file" accept="image/*" capture="environment" class="sr-only" data-testid="proof-photo" (change)="pickPhoto($event)" />
                    </label>
                  </div>
                }
                <button pcButton size="lg" class="w-full !bg-leaf hover:!bg-leaf/90" [loading]="busy() === 'deliver'" (click)="deliver()" data-testid="mark-delivered">
                  <svg [pcIcon]="Check" class="h-5 w-5" /> Mark as delivered
                </button>
              </div>
            </pc-trip-action>
          }

          @if (collecting() && t.status === "accepted") {
            <pc-trip-action [icon]="MapPin" title="Go to the customer" [text]="'Collect return ' + (t.return_number ?? '') + ' from ' + (t.drop.name || 'the customer') + '.'">
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'reached'" (click)="step('reached', 'Marked as at the customer')" data-testid="step-at-customer">
                <svg [pcIcon]="House" class="h-5 w-5" /> I have reached the customer
              </button>
            </pc-trip-action>
          }

          @if (collecting() && t.status === "reached") {
            <pc-trip-action [icon]="KeyRound" title="Collect the return" [text]="t.needs.otp ? 'Check the items below, then ask the customer for their pickup code (on their order page and SMS).' : 'Check the items below and collect them.'">
              @if (t.needs.otp) {<pc-code-input label="Customer's pickup code" [(value)]="code" testId="customer-pickup-code" />}
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'picked'" [disabled]="t.needs.otp && code().trim().length < 4"
                (click)="step('picked', 'Collected. Now bring it to the store.')" data-testid="step-collected">
                <svg [pcIcon]="Package" class="h-5 w-5" /> Collected
              </button>
            </pc-trip-action>
          }

          @if (collecting() && t.status === "picked") {
            <pc-trip-action [icon]="Store" title="Bring it to the store" [text]="'Take return ' + (t.return_number ?? '') + ' to ' + t.pickup.name + '.'">
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'on_the_way'" (click)="step('on_the_way', 'On the way to the store')" data-testid="step-to-store">
                <svg [pcIcon]="Navigation" class="h-5 w-5" /> Start going to the store
              </button>
            </pc-trip-action>
          }

          @if (collecting() && t.status === "on_the_way") {
            <pc-trip-action [icon]="KeyRound" title="Hand it to the store" [text]="t.needs.pickup_code ? 'Give the return to the seller and enter the pickup code they show you.' : 'Give the return to the seller.'">
              @if (t.needs.pickup_code) {<pc-code-input label="Seller's pickup code" [(value)]="code" testId="return-code" />}
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'returned'" [disabled]="t.needs.pickup_code && code().trim().length < 4" (click)="handBack()" data-testid="handed-to-store">
                <svg [pcIcon]="Undo2" class="h-5 w-5" /> Handed to the store
              </button>
            </pc-trip-action>
          }

          @if (back() && (t.status === "picked" || t.status === "on_the_way")) {
            <pc-trip-action [icon]="Undo2" title="Bring the package back" [text]="'Take ' + t.order_number + ' back to ' + t.pickup.name + '.'">
              @if (t.status === "picked") {
                <button pcButton size="lg" class="w-full" [loading]="busy() === 'on_the_way'" (click)="step('on_the_way', 'On the way back to the store')">
                  <svg [pcIcon]="Navigation" class="h-5 w-5" /> Start going back
                </button>
              } @else {
                <button pcButton size="lg" class="w-full" [loading]="busy() === 'reached'" (click)="step('reached', 'Marked as at the store')">
                  <svg [pcIcon]="Store" class="h-5 w-5" /> I have reached the store
                </button>
              }
            </pc-trip-action>
          }

          @if (back() && t.status === "reached") {
            <pc-trip-action [icon]="KeyRound" title="Hand the package back" [text]="t.needs.pickup_code ? 'Give the package to the seller and enter their pickup code.' : 'Give the package to the seller.'">
              @if (t.needs.pickup_code) {<pc-code-input label="Seller's pickup code" [(value)]="code" testId="return-code" />}
              <button pcButton size="lg" class="w-full" [loading]="busy() === 'returned'" [disabled]="t.needs.pickup_code && code().trim().length < 4" (click)="handBack()">
                <svg [pcIcon]="Undo2" class="h-5 w-5" /> Handed back to the store
              </button>
            </pc-trip-action>
          }

          @if (t.status === "delivered") {
            <div class="flex flex-col items-center gap-2 py-2 text-center" data-testid="trip-done">
              <span class="flex h-16 w-16 items-center justify-center rounded-full bg-leaf text-white"><svg [pcIcon]="Check" [strokeWidth]="3" class="h-9 w-9" /></span>
              <p class="font-display text-2xl font-bold">{{ back() || collecting() ? "Returned to the store" : "Delivered" }}</p>
              <p class="text-ink-soft">{{ time(t.delivered_at) }}{{ t.distance_km ? " · " + t.distance_km + " km" : "" }}</p>
              <p class="rounded-full bg-leaf-light px-4 py-1.5 font-semibold text-leaf">You earned {{ rupees(t.fee + t.tip) }}{{ t.tip ? " (incl. " + rupees(t.tip) + " tip)" : "" }}</p>
              @if (t.cod_collected > 0) {<p class="text-sm text-ink-soft">Cash collected {{ rupees(t.cod_collected) }} by {{ t.cod_method === "upi" ? "UPI" : "cash" }}. Deposit cash with the team.</p>}
              @if (t.has_proof) {<pc-proof-thumb [id]="t.id" />}
              <a pcLink="/delivery" class="mt-2 inline-flex h-11 items-center rounded-full bg-peacock px-6 font-semibold text-white">Back to home</a>
            </div>
          }

          @if (t.status === "failed") {
            <pc-trip-action [icon]="CircleAlert" [title]="collecting() ? 'Return not collected' : 'Delivery not completed'"
              [text]="collecting() ? (t.fail_reason || 'Reason recorded') + '. The delivery team will arrange another pickup.' : (t.fail_reason || 'Reason recorded') + '. Keep the package safe; the delivery team will tell you whether to try again or bring it back to the store.'">
              <a pcLink="/delivery" class="inline-flex h-11 items-center rounded-full bg-peacock px-6 font-semibold text-white">Back to home</a>
            </pc-trip-action>
          }

          @if (t.status === "cancelled" || t.status === "rejected" || t.status === "expired") {
            <pc-trip-action [icon]="X" [title]="t.status === 'cancelled' ? 'Trip cancelled' : t.status === 'rejected' ? 'You rejected this request' : 'Request timed out'" [text]="lastNote() || t.status_label">
              <a pcLink="/delivery" class="inline-flex h-11 items-center rounded-full bg-peacock px-6 font-semibold text-white">Back to home</a>
            </pc-trip-action>
          }

          @if (isDelivery() && (t.status === "picked" || t.status === "on_the_way" || t.status === "reached")) {
            <button type="button" (click)="failing.set(true)" class="mt-3 w-full rounded-xl py-2 text-sm font-semibold text-vermilion hover:bg-vermilion-light" data-testid="cannot-deliver">
              Could not deliver?
            </button>
          }
          @if (collecting() && (t.status === "accepted" || t.status === "reached")) {
            <button type="button" (click)="failing.set(true)" class="mt-3 w-full rounded-xl py-2 text-sm font-semibold text-vermilion hover:bg-vermilion-light" data-testid="cannot-collect">
              Could not collect?
            </button>
          }
        </section>

        @if (!ended()) {<pc-team-help [orderNumber]="t.order_number" />}

        <div [class]="collecting() ? 'grid gap-3 md:grid-cols-2 [&>*:first-child]:order-2' : 'grid gap-3 md:grid-cols-2'">
          <pc-place-card [icon]="Store" tone="store" [title]="back() || collecting() ? 'Bring to' : 'Pick up from'" [name]="t.pickup.name" [address]="join([t.pickup.address, t.pickup.city, t.pickup.pincode], ', ')"
            [phone]="t.pickup.phone" [nav]="nav(t.pickup)" />
          @if (!back()) {
            @if (t.status === "offered") {
              <pc-place-card [icon]="MapPin" tone="home" [title]="collecting() ? 'Collect from' : 'Deliver to'" [name]="join([t.drop.city, t.drop.pincode], ' ')" address="The full address shows after you accept." />
            } @else if (ended() && !t.drop.phone) {
              <pc-place-card [icon]="MapPin" tone="home" [title]="collecting() ? 'Collected from' : 'Delivered to'" [name]="join([t.drop.city, t.drop.pincode], ' ')"
                address="The customer's name, phone and address are hidden once the trip ends, to protect their privacy." />
            } @else {
              <pc-place-card [icon]="MapPin" tone="home" [title]="collecting() ? 'Collect from' : 'Deliver to'" [name]="t.drop.name" [address]="join([t.drop.address, t.drop.city, t.drop.pincode], ', ')"
                [phone]="t.drop.phone" [nav]="nav(t.drop)" [instructions]="t.drop.instructions" [noBag]="t.drop.no_bag" />
            }
          }
        </div>

        <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 class="mb-2 flex items-center gap-2 font-semibold"><svg [pcIcon]="ShoppingBag" class="h-4 w-4 text-peacock" /> {{ collecting() ? "Items to collect" : "Items" }} ({{ itemCount() }})</h2>
          <ul class="divide-y divide-line">
            @for (i of t.items; track $index) {
              <li class="flex items-center gap-3 py-2">
                @if (i.image) {
                  <img [src]="i.image" alt="" class="h-12 w-12 rounded-lg object-cover ring-1 ring-line" />
                } @else {
                  <span class="flex h-12 w-12 items-center justify-center rounded-lg bg-mist"><svg [pcIcon]="Package" class="h-5 w-5 text-ink-faint" /></span>
                }
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{{ i.title }}</span>
                  @if (i.variant) {<span class="text-sm text-ink-soft">{{ i.variant }}</span>}
                </span>
                <span class="font-semibold">× {{ i.qty }}</span>
              </li>
            }
          </ul>
          <div class="mt-3 flex flex-wrap gap-2 border-t border-line pt-3 text-sm">
            @if (collect()) {
              <span class="rounded-full bg-marigold-light px-3 py-1 font-semibold text-[#8A5A00]">Cash on delivery: collect {{ rupees(t.cod_amount) }}</span>
            } @else {
              <span class="rounded-full bg-leaf-light px-3 py-1 font-semibold text-leaf">{{ collecting() ? "Return pickup: collect no money" : back() ? "Return trip" : "Prepaid: collect nothing" }}</span>
            }
            @if (!ended()) {
              <span class="rounded-full bg-mist px-3 py-1 font-semibold">
                You earn about {{ rupees(t.fee_estimate) }}{{ (t.bonus_now ?? 0) > 0 ? " (incl. " + rupees(t.bonus_now ?? 0) + " bad weather bonus)" : "" }}
              </span>
            }
            @if (t.status === "delivered") {
              <span class="rounded-full bg-leaf-light px-3 py-1 font-semibold text-leaf" data-testid="trip-earned">
                You earned {{ rupees(t.fee + t.tip + (t.bonus ?? 0)) }}@if (t.tip || t.bonus) {<span class="font-normal"> ({{ earnedParts(t) }})</span>}
              </span>
            }
          </div>
        </section>

        @if (t.log && t.log.length > 0) {
          <details class="group rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <summary class="flex cursor-pointer list-none items-center justify-between font-semibold">
              Trip history <svg [pcIcon]="ChevronDown" class="h-4 w-4 transition group-open:rotate-180" />
            </summary>
            <ol class="mt-3 flex flex-col gap-2 border-l-2 border-line pl-4">
              @for (x of t.log; track $index) {
                <li class="text-sm">
                  <span class="font-semibold">{{ x.status.replace(underscores, " ") }}</span> <span class="text-ink-faint">{{ time(x.at) }}</span>
                  @if (x.note) {<p class="text-ink-soft">{{ x.note }}</p>}
                </li>
              }
            </ol>
          </details>
        }
      </div>
      <!-- outside the column: the dialog's host element would otherwise take a gap -->
      <pc-fail-dialog [open]="failing()" [tripId]="t.id" [collecting]="collecting()" (closed)="failing.set(false)" (done)="failed($event)" [last]="feeds.location.last()" />
    } @else if (!error()) {
      <pc-full-loader label="Opening the trip" />
    } @else {
      <div class="mx-auto mt-8 max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm">
        <pc-error-note [message]="error()" />
        <a pcLink="/delivery" class="mt-4 inline-block font-semibold text-peacock">Back to home</a>
      </div>
    }
  `,
})
export class DeliveryTripsIdPage {
  protected readonly feeds = inject(DeliveryFeedService);
  private readonly toast = inject(Toast);
  /** the trip in the address (the page is reused when a new request is accepted from here) */
  private readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => p.get("id") ?? "")), { initialValue: "" });
  protected readonly trip = signal<TripView | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly code = signal("");
  protected readonly otp = signal("");
  protected readonly cod = signal("");
  protected readonly codMethod = signal<"cash" | "upi" | "">("");
  protected readonly photo = signal<{ file: File; url: string } | null>(null);
  protected readonly failing = signal(false);
  protected readonly codMethods = ["cash", "upi"] as const;
  protected readonly underscores = /_/g;
  protected readonly rupees = rupees;
  protected readonly time = time;
  protected readonly nav = navigateUrl;

  protected readonly ArrowLeft = ArrowLeft;
  protected readonly Navigation = Navigation;
  protected readonly Package = Package;
  protected readonly Store = Store;
  protected readonly KeyRound = KeyRound;
  protected readonly MapPin = MapPin;
  protected readonly House = House;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly Banknote = Banknote;
  protected readonly Camera = Camera;
  protected readonly Check = Check;
  protected readonly Undo2 = Undo2;
  protected readonly CircleAlert = CircleAlert;
  protected readonly X = X;
  protected readonly ShoppingBag = ShoppingBag;
  protected readonly ChevronDown = ChevronDown;

  protected readonly back = computed(() => this.trip()?.kind === "return");
  /** a customer's return: first to the customer, then to the store */
  protected readonly collecting = computed(() => this.trip()?.kind === "pickup");
  protected readonly isDelivery = computed(() => this.trip()?.kind === "delivery");
  protected readonly toStore = computed(() => {
    const t = this.trip();
    if (!t) return false;
    return this.collecting() ? ["picked", "on_the_way", "delivered"].includes(t.status) : this.back() || ["offered", "accepted", "at_store"].includes(t.status);
  });
  protected readonly collect = computed(() => this.isDelivery() && (this.trip()?.cod_amount ?? 0) > 0);
  protected readonly ended = computed(() => ["delivered", "failed", "cancelled", "rejected", "expired"].includes(this.trip()?.status ?? ""));
  protected readonly lastNote = computed(() => [...(this.trip()?.log ?? [])].reverse().find((x) => x.note)?.note ?? "");
  protected readonly itemCount = computed(() => (this.trip()?.items ?? []).reduce((n, i) => n + i.qty, 0));
  protected readonly navUrl = computed(() => {
    const t = this.trip();
    return t ? navigateUrl(this.toStore() ? t.pickup : t.drop) : "";
  });

  private readonly me = computed<Pos>(() => {
    const last = this.feeds.location.last();
    const t = this.trip();
    return last ? { lat: last.coords.latitude, lng: last.coords.longitude }
      : t?.partner.lat != null && t.partner.lng != null ? { lat: t.partner.lat, lng: t.partner.lng } : null;
  });
  private readonly meKey = computed(() => {
    const me = this.me();
    return me ? `${me.lat.toFixed(5)},${me.lng.toFixed(5)}` : "";
  });
  protected readonly map = computed(() => {
    const m: MapMarker[] = [];
    const l: MapLine[] = [];
    const trip = this.trip();
    if (!trip) return { markers: m, lines: l };
    const meKey = this.meKey();
    const back = this.back();
    const toStore = this.toStore();
    const [la, ln] = meKey ? meKey.split(",").map(Number) : [NaN, NaN];
    const mine = meKey ? ([la, ln] as [number, number]) : null;
    const store = trip.pickup.lat !== null && trip.pickup.lng !== null ? ([trip.pickup.lat, trip.pickup.lng] as [number, number]) : null;
    const home = trip.drop.lat !== null && trip.drop.lng !== null ? ([trip.drop.lat, trip.drop.lng] as [number, number]) : null;
    if (store) m.push({ id: "store", lat: store[0], lng: store[1], kind: "store", title: trip.pickup.name, popup: `${trip.pickup.name}\n${trip.pickup.address}` });
    if (home && !back) m.push({ id: "home", lat: home[0], lng: home[1], kind: "home", title: "Customer", popup: [trip.drop.name, trip.drop.address].filter(Boolean).join("\n") || "Customer" });
    if (mine) m.push({ id: "me", lat: mine[0], lng: mine[1], kind: "partner", title: "You" });
    const target = toStore ? store : home;
    if (mine && target) l.push({ id: "go", points: [mine, target], color: toStore ? "#F5A524" : "#0B5563", dashed: true });
    return { markers: m, lines: l };
  }, { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });

  constructor() {
    usePolling(() => this.load(), 15_000);
    let first = true;
    effect(() => {
      this.id();
      if (first) first = false;
      // another trip in the address: Next mounts a fresh page (the old trip, codes, photo and dialogs go)
      else untracked(() => { this.reset(); this.load(); });
    });
    inject(DestroyRef).onDestroy(() => {
      const p = this.photo();
      if (p) URL.revokeObjectURL(p.url);
    });
  }

  private reset(): void {
    const p = this.photo();
    if (p) URL.revokeObjectURL(p.url);
    this.trip.set(null);
    this.error.set(null);
    this.busy.set(null);
    this.actionError.set(null);
    this.code.set("");
    this.otp.set("");
    this.cod.set("");
    this.codMethod.set("");
    this.photo.set(null);
    this.failing.set(false);
  }

  /** Shows the trip an action answered with, unless the page has moved on to another trip meanwhile. */
  private show(t: TripView, next: TripView): void {
    if (t.id === this.id()) this.trip.set({ ...t, ...next });
  }

  private load(): void {
    const id = this.id();
    if (!id) return;
    api<TripView>(`/api/delivery/trips/${id}`)
      .then((t) => { if (id !== this.id()) return; this.trip.set(t); this.error.set(null); })
      .catch((e) => { if (id === this.id()) this.error.set(e instanceof ApiError ? e.message : "Could not open this trip"); });
  }

  protected join(parts: (string | null | undefined)[], sep: string): string {
    return parts.filter(Boolean).join(sep);
  }

  protected earnedParts(t: TripView): string {
    return [`fee ${rupees(t.fee)}`, t.tip ? `tip ${rupees(t.tip)}` : "", t.bonus ? `bonus ${rupees(t.bonus)}` : ""].filter(Boolean).join(", ");
  }

  protected async step(to: Step, label: string): Promise<void> {
    const t = this.trip();
    if (!t) return;
    this.busy.set(to);
    this.actionError.set(null);
    try {
      const pos = await here(this.feeds.location.last());
      const next = await api<TripView>(`/api/delivery/trips/${t.id}/status`, {
        method: "POST",
        body: { to, code: to === "picked" ? this.code().trim() : "", ...(pos ?? {}) },
      });
      this.show(t, next);
      this.code.set("");
      this.toast.show(label);
      this.feeds.refresh();
      this.load();
    } catch (e) {
      this.actionError.set(e instanceof ApiError ? e.message : "Could not update. Check your internet and try again.");
    } finally {
      this.busy.set(null);
    }
  }

  protected async deliver(): Promise<void> {
    const t = this.trip();
    if (!t) return;
    this.actionError.set(null);
    const collect = this.collect();
    if (t.needs.otp && !/^\d{4,6}$/.test(this.otp().trim())) return void this.actionError.set("Enter the 4-digit OTP from the customer.");
    const paise = collect ? toPaise(this.cod()) : 0;
    if (collect && paise === null) return void this.actionError.set(`Enter the cash you collected: ${rupees(t.cod_amount)}.`);
    if (collect && !this.codMethod()) return void this.actionError.set("Choose how the customer paid: cash or UPI.");
    const photo = this.photo();
    if (t.needs.photo && !photo) return void this.actionError.set("Take a photo of the package at the door.");
    this.busy.set("deliver");
    try {
      const pos = await here(this.feeds.location.last());
      const form = new FormData();
      form.append("otp", this.otp().trim());
      if (collect) {
        form.append("cod_collected", String(paise));
        form.append("cod_method", this.codMethod());
      }
      if (pos) {
        form.append("lat", String(pos.lat));
        form.append("lng", String(pos.lng));
      }
      if (photo) form.append("photo", photo.file);
      const next = await api<TripView>(`/api/delivery/trips/${t.id}/deliver`, { method: "POST", form });
      this.show(t, next);
      (navigator as Navigator & { vibrate?: (p: number[]) => boolean }).vibrate?.([60, 40, 120]);
      this.toast.show("Delivered. Great job!");
      this.feeds.refresh();
      this.load();
    } catch (e) {
      this.actionError.set(e instanceof ApiError ? e.message : "Could not mark delivered. Check your internet and try again.");
    } finally {
      this.busy.set(null);
    }
  }

  protected async handBack(): Promise<void> {
    const t = this.trip();
    if (!t) return;
    this.busy.set("returned");
    this.actionError.set(null);
    try {
      const pos = await here(this.feeds.location.last());
      const next = await api<TripView>(`/api/delivery/trips/${t.id}/returned`, { method: "POST", body: { code: this.code().trim(), ...(pos ?? {}) } });
      this.show(t, next);
      this.toast.show("Returned to the store");
      this.feeds.refresh();
      this.load();
    } catch (e) {
      this.actionError.set(e instanceof ApiError ? e.message : "Could not update. Try again.");
    } finally {
      this.busy.set(null);
    }
  }

  protected async pickPhoto(e: Event): Promise<void> {
    const el = e.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = "";
    if (!file) return;
    const small = await shrinkImage(file);
    const old = this.photo();
    if (old) URL.revokeObjectURL(old.url);
    this.photo.set({ file: small, url: URL.createObjectURL(small) });
  }

  protected failed(next: TripView): void {
    const t = this.trip();
    this.failing.set(false);
    if (t) this.show(t, next);
    this.feeds.refresh();
    this.load();
  }
}
