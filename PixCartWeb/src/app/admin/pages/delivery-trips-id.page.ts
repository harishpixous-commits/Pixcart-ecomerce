/*
 * Admin → Delivery → one trip: the map (store, customer, partner), the steps with times, both addresses, the money
 * (cash to collect and collected, fee, tip, distance), the pickup code, the delivery photo, the customer's rating and
 * the full log with who did what and where. Staff can take a trip off a partner before pickup, or decide what happens
 * after a failed attempt. Port of frontend/src/app/admin/delivery/trips/[id]/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { ArrowLeft, Camera, ExternalLink, KeyRound, MapPin, Phone, RotateCcw, Star, Store, Undo2, UserRound, type LucideIconData } from "lucide-angular";
import { api, ApiError } from "../../core/api";
import type { TripView } from "../../core/delivery-types";
import { dateTime, rupees } from "../../core/format";
import { minutesLabel, navigateUrl, telUrl, TripPill, TripProgress } from "../../delivery/components/trip";
import { LiveMap, type MapLine, type MapMarker } from "../../shared/map/live-map";
import { usePolling } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Modal, Textarea, Toast } from "../../shared/ui/ui";
import { DocViewer, PartnerAvatar } from "../shared/delivery-admin";

const ACTOR: Record<string, string | undefined> = { delivery: "Partner", admin: "Staff", seller: "Seller", system: "System", customer: "Customer" };

@Component({
  selector: "pc-trip-place",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="flex flex-col gap-1.5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p class="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-ink-faint">
        <span [class]="tone() === 'store' ? 'flex h-6 w-6 items-center justify-center rounded-full text-white bg-marigold' : 'flex h-6 w-6 items-center justify-center rounded-full text-white bg-vermilion'"><svg [pcIcon]="icon()" class="h-3.5 w-3.5" aria-hidden="true" /></span>{{ title() }}
      </p>
      <p class="font-semibold">{{ name() }}</p>
      @for (l of shownLines(); track $index) {<p class="text-sm text-ink-soft">{{ l }}</p>}
      @if (note()) {<p class="rounded-lg bg-mist px-2 py-1 text-sm"><b>Instructions:</b> {{ note() }}</p>}
      @if (noBag()) {<p class="text-xs font-semibold text-leaf">No carry bag</p>}
      <div class="mt-1 flex gap-3 text-sm font-semibold text-peacock">
        @if (phone()) {<a [href]="tel(phone())" class="inline-flex items-center gap-1"><svg [pcIcon]="I.Phone" class="h-3.5 w-3.5" aria-hidden="true" />{{ phone() }}</a>}
        <a [href]="nav()" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1"><svg [pcIcon]="I.MapPin" class="h-3.5 w-3.5" aria-hidden="true" />Map</a>
      </div>
    </section>
  `,
})
export class TripPlace {
  readonly icon = input.required<LucideIconData>();
  readonly title = input.required<string>();
  readonly tone = input.required<"store" | "home">();
  readonly name = input.required<string>();
  readonly lines = input.required<string[]>();
  readonly phone = input.required<string>();
  readonly nav = input.required<string>();
  readonly note = input<string | undefined>(undefined);
  readonly noBag = input<boolean | undefined>(undefined);
  protected readonly I = { Phone, MapPin };
  protected readonly tel = telUrl;
  protected readonly shownLines = computed(() => this.lines().filter(Boolean));
}

@Component({
  selector: "pc-cancel-trip",
  imports: [Button, ErrorNote, Modal, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="open()" (close)="close.emit()" title="Take this trip off the partner">
      <form (submit)="submit($event)" class="flex flex-col gap-3">
        <p class="text-sm text-ink-soft">{{ partner() }} is told right away. Assign someone else from the queue.</p>
        <pc-error-note [message]="error()" />
        <textarea pcTextarea [value]="reason()" (input)="reason.set($any($event.target).value)" rows="3" required minlength="3" maxlength="300" placeholder="Reason (the partner sees it)" aria-label="Reason"></textarea>
        <button pcButton type="submit" variant="danger" [loading]="busy()" [disabled]="reason().trim().length < 3" class="self-start">Take off partner</button>
      </form>
    </pc-modal>
  `,
})
export class CancelTrip {
  readonly open = input.required<boolean>();
  readonly id = input.required<string>();
  readonly partner = input.required<string>();
  readonly close = output<void>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly reason = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/admin/delivery/assignments/${this.id()}/cancel`, { method: "POST", body: { reason: this.reason().trim() } });
      this.toast.show("Trip taken off the partner. The package is back in the queue.");
      this.reason.set("");
      this.done.emit();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not take the trip off");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-admin-delivery-trips-id-page",
  imports: [Icon, PcLink, PageLoader, Button, ErrorNote, TripPill, TripProgress, LiveMap, PartnerAvatar, DocViewer, TripPlace, CancelTrip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!t()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <div class="flex flex-col gap-4" data-testid="admin-trip">
        <div class="flex flex-wrap items-center gap-3">
          <a pcLink="/admin/delivery/trips" class="flex h-10 w-10 items-center justify-center rounded-xl bg-white ring-1 ring-line" aria-label="Back to trips"><svg [pcIcon]="I.ArrowLeft" class="h-5 w-5" /></a>
          <div class="min-w-0 flex-1">
            <h1 class="font-display text-2xl font-bold">{{ t()!.order_number }}</h1>
            <p class="text-sm text-ink-soft">{{ kindLabel() }} · {{ t()!.mode === "auto" ? "auto-assign" : "assigned by staff" }} · {{ dateTime(t()!.assigned_at) }}</p>
          </div>
          <pc-trip-pill [trip]="t()!" />
          <a [pcLink]="'/admin/orders/' + t()!.order_id" class="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 font-semibold text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light">
            Order <svg [pcIcon]="I.ExternalLink" class="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
        <pc-error-note [message]="error()" />

        @if (beforePickup() || t()!.status === "failed") {
          <section class="flex flex-wrap items-center gap-3 rounded-2xl bg-marigold-light/60 p-4 ring-1 ring-marigold/30">
            <p class="min-w-0 flex-1 text-sm">
              {{ beforePickup() ? "The partner does not have the package yet. You can take this trip off them; the package goes back to the queue." : "Not delivered: " + t()!.fail_reason + ". The partner still has the package." }}
            </p>
            @if (beforePickup()) {<button pcButton variant="danger" (click)="cancelling.set(true)"><svg [pcIcon]="I.Undo2" class="h-4 w-4" aria-hidden="true" /> Take off partner</button>}
            @if (t()!.status === "failed") {
              <button pcButton [loading]="busy() === 'retry'" (click)="resolve('retry')"><svg [pcIcon]="I.RotateCcw" class="h-4 w-4" aria-hidden="true" /> Try again</button>
              <button pcButton variant="danger" [loading]="busy() === 'return'" (click)="resolve('return')"><svg [pcIcon]="I.Undo2" class="h-4 w-4" aria-hidden="true" /> Bring back to store</button>
            }
          </section>
        }

        <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div class="flex min-w-0 flex-col gap-4">
            @if (map().markers.length > 0) {<pc-live-map [markers]="map().markers" [lines]="map().lines" [fitKey]="t()!.id + ':' + map().markers.length" boxClass="h-72 sm:h-80" />}
            <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5"><ol pcTripProgress [trip]="t()!"></ol></section>
            <div class="grid gap-3 md:grid-cols-2">
              <pc-trip-place [icon]="I.Store" [title]="t()!.kind === 'return' || t()!.kind === 'pickup' ? 'Store (bring to)' : 'Pick up from'" tone="store" [name]="t()!.pickup.name"
                [lines]="[t()!.pickup.address, join([t()!.pickup.city, t()!.pickup.pincode])]" [phone]="t()!.pickup.phone" [nav]="nav(t()!.pickup)" />
              <pc-trip-place [icon]="I.MapPin" [title]="t()!.kind === 'pickup' ? 'Collect from' : 'Deliver to'" tone="home" [name]="t()!.drop.name || 'Customer'"
                [lines]="[t()!.drop.address, join([t()!.drop.city, t()!.drop.pincode])]" [phone]="t()!.drop.phone" [nav]="nav(t()!.drop)" [note]="t()!.drop.instructions" [noBag]="t()!.drop.no_bag" />
            </div>
            <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              <h2 class="mb-2 font-semibold">Trip log</h2>
              <ol class="flex flex-col gap-3 border-l-2 border-line pl-4">
                @for (x of log(); track $index) {
                  <li class="relative text-sm">
                    <span class="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-peacock ring-2 ring-white" aria-hidden="true"></span>
                    <p><span class="font-semibold">{{ words(x.status) }}</span> <span class="text-ink-faint">· {{ actor[x.actor ?? ""] ?? x.actor }} · {{ dateTime(x.at) }}</span></p>
                    @if (x.note) {<p class="text-ink-soft">{{ x.note }}</p>}
                    @if (x.lat != null && x.lng != null) {
                      <a [href]="'https://www.google.com/maps?q=' + x.lat + ',' + x.lng" target="_blank" rel="noopener noreferrer" class="text-xs font-semibold text-peacock">
                        {{ x.lat.toFixed(5) }}, {{ x.lng.toFixed(5) }}
                      </a>
                    }
                  </li>
                }
              </ol>
            </section>
          </div>

          <aside class="flex min-w-0 flex-col gap-4">
            <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              <div class="flex items-center gap-3">
                <pc-partner-avatar [p]="t()!.partner" />
                <div class="min-w-0 flex-1">
                  <p class="font-semibold">{{ t()!.partner.name }}</p>
                  <p class="text-sm text-ink-soft">{{ t()!.partner.vehicle }}{{ t()!.partner.vehicle_no ? " · " + t()!.partner.vehicle_no : "" }}</p>
                </div>
              </div>
              <div class="mt-3 flex gap-2">
                <a [href]="tel(t()!.partner.phone)" class="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-peacock text-sm font-semibold text-white"><svg [pcIcon]="I.Phone" class="h-4 w-4" aria-hidden="true" />Call</a>
                <a [pcLink]="'/admin/delivery/partners/' + t()!.partner.id" class="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold text-peacock ring-1 ring-inset ring-peacock/40"><svg [pcIcon]="I.UserRound" class="h-4 w-4" aria-hidden="true" />Profile</a>
              </div>
              @if (live() && t()!.minutes_in_step !== undefined) {<p class="mt-2 text-xs text-ink-faint">In this step for {{ minutesLabel(t()!.minutes_in_step) }}</p>}
            </section>

            <section class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              <h2 class="mb-2 font-semibold">Money</h2>
              <dl class="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm">
                <dt class="text-ink-soft">Payment</dt><dd class="font-semibold">{{ t()!.kind === "pickup" ? "Return pickup, no money" : t()!.payment === "cod" ? "Cash on delivery" : "Prepaid" }}</dd>
                @if (t()!.cod_amount > 0) {<dt class="text-ink-soft">Cash to collect</dt><dd class="font-semibold">{{ rupees(t()!.cod_amount) }}</dd>}
                @if (t()!.cod_collected > 0) {<dt class="text-ink-soft">Collected</dt><dd class="font-semibold text-leaf">{{ rupees(t()!.cod_collected) }} {{ t()!.cod_method === "upi" ? "by UPI" : "in cash" }}</dd>}
                <dt class="text-ink-soft">Partner fee</dt><dd class="font-semibold">{{ t()!.status === "delivered" ? rupees(t()!.fee) : "about " + rupees(t()!.fee_estimate) }}</dd>
                @if (t()!.tip > 0) {<dt class="text-ink-soft">Customer tip</dt><dd class="font-semibold">{{ rupees(t()!.tip) }}</dd>}
                @if (bonus() > 0) {<dt class="text-ink-soft">Bad weather bonus</dt><dd class="font-semibold">{{ rupees(bonus()) }}</dd>}
                @if (t()!.distance_km !== null) {<dt class="text-ink-soft">Distance</dt><dd class="font-semibold">{{ t()!.distance_km }} km</dd>}
              </dl>
            </section>

            @if (t()!.pickup_code) {
              <section class="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
                <svg [pcIcon]="I.KeyRound" class="h-5 w-5 text-marigold-dark" aria-hidden="true" />
                <div>
                  <p class="text-xs font-semibold uppercase tracking-wide text-ink-faint">Pickup code</p>
                  <p class="font-mono text-xl font-bold tracking-[0.3em]">{{ t()!.pickup_code }}</p>
                </div>
              </section>
            }

            @if (t()!.has_proof || t()!.rating) {
              <section class="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
                @if (t()!.has_proof) {<button pcButton variant="secondary" (click)="proof.set(true)"><svg [pcIcon]="I.Camera" class="h-4 w-4" aria-hidden="true" /> Delivery photo</button>}
                @if (t()!.rating) {
                  <div>
                    <p class="flex items-center gap-0.5" [attr.aria-label]="'Rated ' + t()!.rating + ' of 5'">
                      @for (n of five; track n) {<svg [pcIcon]="I.Star" [class]="n <= rating() ? 'h-5 w-5 fill-marigold text-marigold' : 'h-5 w-5 text-line'" aria-hidden="true" />}
                    </p>
                    @if (t()!.rating_comment) {<p class="mt-1 text-sm text-ink-soft">“{{ t()!.rating_comment }}”</p>}
                  </div>
                }
              </section>
            }
          </aside>
        </div>

        <pc-doc-viewer [path]="proof() ? '/api/admin/delivery/trips/' + t()!.id + '/proof' : null" [title]="'Delivery photo, ' + t()!.order_number" (close)="proof.set(false)" />
        <pc-cancel-trip [open]="cancelling()" [id]="t()!.id" [partner]="t()!.partner.name" (close)="cancelling.set(false)" (done)="cancelling.set(false); load()" />
      </div>
    }
  `,
})
export class AdminDeliveryTripsIdPage {
  readonly id = input.required<string>();
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  protected readonly I = { ArrowLeft, ExternalLink, Undo2, RotateCcw, Store, MapPin, Phone, UserRound, KeyRound, Camera, Star };
  protected readonly five = [1, 2, 3, 4, 5];
  protected readonly actor = ACTOR;
  protected readonly dateTime = dateTime;
  protected readonly rupees = rupees;
  protected readonly tel = telUrl;
  protected readonly nav = navigateUrl;
  protected readonly minutesLabel = minutesLabel;
  protected readonly t = signal<TripView | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly proof = signal(false);
  protected readonly cancelling = signal(false);
  protected readonly busy = signal<string | null>(null);
  protected readonly log = computed(() => this.t()?.log ?? []);
  protected readonly bonus = computed(() => this.t()?.bonus ?? 0);
  protected readonly rating = computed(() => this.t()?.rating ?? 0);
  protected readonly live = computed(() => {
    const t = this.t();
    return !!t && ["offered", "accepted", "at_store", "picked", "on_the_way", "reached"].includes(t.status);
  });
  protected readonly beforePickup = computed(() => ["offered", "accepted", "at_store"].includes(this.t()?.status ?? ""));
  protected readonly kindLabel = computed(() => {
    const t = this.t();
    if (!t) return "";
    return t.kind === "pickup" ? `Return pickup${t.return_number ? ` ${t.return_number}` : ""}` : t.kind === "return" ? "Return to store" : "Delivery";
  });
  protected readonly map = computed(() => {
    const m: MapMarker[] = [];
    const l: MapLine[] = [];
    const t = this.t();
    if (!t) return { markers: m, lines: l };
    const store = t.pickup.lat !== null && t.pickup.lng !== null ? ([t.pickup.lat, t.pickup.lng] as [number, number]) : null;
    const home = t.drop.lat !== null && t.drop.lng !== null ? ([t.drop.lat, t.drop.lng] as [number, number]) : null;
    if (store) m.push({ id: "store", lat: store[0], lng: store[1], kind: "store", title: t.pickup.name, popup: `${t.pickup.name}\n${t.pickup.address}` });
    if (home) m.push({ id: "home", lat: home[0], lng: home[1], kind: "home", title: t.drop.name || "Customer", popup: `${t.drop.name}\n${t.drop.address}` });
    if (this.live() && t.partner.lat !== null && t.partner.lng !== null) {
      m.push({ id: "partner", lat: t.partner.lat, lng: t.partner.lng, kind: "partner-busy", title: t.partner.name, label: t.partner.name.slice(0, 2).toUpperCase() });
    }
    for (const x of t.log ?? []) {
      if (x.lat != null && x.lng != null && ["picked", "delivered", "failed", "returned"].includes(x.status)) {
        m.push({ id: `log:${x.status}:${x.at}`, lat: x.lat, lng: x.lng, kind: "pin", title: `${x.status.replace(/_/g, " ")} here` });
      }
    }
    if (store && home) l.push({ id: "route", points: [store, home], dashed: true, color: "#0B5563" });
    return { markers: m, lines: l };
  });
  // polls while the trip is moving (and until the first answer), like usePolling(load, 15_000, live || !t)
  private readonly polling = computed(() => this.live() || !this.t());

  constructor() {
    usePolling(() => untracked(() => this.load()), 15_000, this.polling);
    // another trip (after "Try again" / "Bring back"): start over, as the reference's page remounts for a new id
    let first = true;
    effect(() => {
      this.id();
      if (first) {
        first = false;
        return;
      }
      untracked(() => {
        this.t.set(null);
        this.load();
      });
    });
  }

  protected load(): void {
    const id = this.id();
    api<TripView>(`/api/admin/delivery/trips/${id}`).then((x) => { this.t.set(x); this.error.set(null); })
      .catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load the trip"));
  }

  protected join(parts: string[]): string {
    return parts.filter(Boolean).join(" ");
  }

  protected words(s: string): string {
    return s.replace(/_/g, " ");
  }

  protected async resolve(action: "retry" | "return"): Promise<void> {
    const t = this.t();
    if (!t) return;
    if (action === "return" && !window.confirm("Bring the package back to the seller? The order part is cancelled and a prepaid amount refunded when it reaches the store.")) return;
    this.busy.set(action);
    try {
      const next = await api<{ id: string }>(`/api/admin/delivery/assignments/${t.id}/resolve`, { method: "POST", body: { action } });
      this.toast.show(action === "retry" ? "The partner will try the delivery again" : "The partner will bring the package back");
      void this.router.navigateByUrl(`/admin/delivery/trips/${next.id}`); // the new trip
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not update", "error");
    } finally {
      this.busy.set(null);
    }
  }
}
