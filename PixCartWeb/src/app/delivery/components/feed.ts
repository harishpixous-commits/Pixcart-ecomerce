/*
 * The partner app's heartbeat. While the app is open (on any partner screen) it asks the server every 5 seconds for new
 * delivery requests and trips in progress, shares the partner's location while they are online or carrying a package,
 * and pops a new request up full screen with a countdown, a chime and a vibration. Accept opens the trip; Reject asks
 * for a reason. A push notification covers the time the app is closed (see core/push.ts).
 * Port of components/delivery/feed.tsx: FeedProvider + useFeed() = DeliveryFeedService, <pc-offer-popup>, RejectSheet.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, Injector, computed, effect, inject, input, output, signal, untracked } from "@angular/core";
import { Router } from "@angular/router";
import { Banknote, Bike, Check, Clock, MapPin, Package, Store, X } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import type { DeliveryOptions, PartnerFeed, TripView } from "../../core/delivery-types";
import { rupees } from "../../core/format";
import { onForegroundPush } from "../../core/push";
import { RouteState } from "../../core/route-state";
import { Icon } from "../../shared/ui/icon";
import { Button, ErrorNote, Modal, Textarea, Toast } from "../../shared/ui/ui";
import { LocationSharing } from "./location";
import { PartnerService, loadDeliveryOptions } from "./partner";
import { useNow } from "./trip";

/* ---------------------------------------------------------------- sound */

let audioCtx: AudioContext | null = null;

/** Browsers only allow sound after the person has touched the page once; the shell calls this on the first tap. */
export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

function chime(): void {
  const c = audioCtx;
  if (!c || c.state !== "running") return;
  const t0 = c.currentTime;
  [880, 1175, 1568, 1175].forEach((freq, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    const t = t0 + i * 0.15;
    o.type = "triangle";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 0.15);
  });
}

function vibrate(pattern: number | number[]): void {
  (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate?.(pattern);
}

/* ---------------------------------------------------------------- the feed (FeedProvider) */

export type Offer = TripView & { deadline: number };
export type Feed = Omit<PartnerFeed, "offers"> & { offers: Offer[] };

/** useFeed(): the feed, refresh(), the location sharing state and drop(). The shell calls connect() while it is on screen. */
@Injectable({ providedIn: "root" })
export class DeliveryFeedService {
  private readonly partners = inject(PartnerService);
  private readonly raw = signal<Feed | null>(null);
  private readonly dropped = signal<string[]>([]);
  private seq = 0;
  readonly options = signal<DeliveryOptions | null>(null);
  /** { state, last }: the partner's position while online or on a trip */
  readonly location = new LocationSharing();
  readonly feed = computed<Feed | null>(() => {
    const f = this.raw();
    const dropped = this.dropped();
    return f ? { ...f, offers: f.offers.filter((o) => !dropped.includes(o.id)) } : null;
  });

  refresh(): void {
    const id = ++this.seq;
    api<PartnerFeed>("/api/delivery/feed")
      .then((f) => {
        if (id !== this.seq) return;
        const at = Date.now();
        this.raw.set({ ...f, offers: f.offers.map((o) => ({ ...o, deadline: at + (o.seconds_left ?? 0) * 1000 })) });
        const p = this.partners.partner();
        if (p && p.is_online !== f.is_online) this.partners.set({ ...p, is_online: f.is_online }); // switched off elsewhere (or by the system)
      })
      .catch(() => {});
  }

  /** Removes a request from the screen at once (after accepting, rejecting or when it ran out). */
  drop(id: string): void {
    this.dropped.update((d) => (d.includes(id) ? d : [...d.slice(-20), id]));
  }

  /** Starts polling and location sharing for the lifetime of the component whose injector is given (the shell). */
  connect(injector: Injector): void {
    loadDeliveryOptions().then((o) => this.options.set(o)).catch(() => {});
    this.refresh();
    const tick = () => {
      if (document.visibilityState === "visible") this.refresh();
    };
    const t = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    const stopPush = onForegroundPush(() => this.refresh()); // a push while the app is open: fetch the new request now

    const sharing = computed(() => !!this.partners.partner()?.is_online || (this.raw()?.active.length ?? 0) > 0);
    const every = computed(() => this.options()?.location_seconds ?? 20);
    effect((onCleanup) => {
      const on = sharing();
      const s = every();
      onCleanup(untracked(() => this.location.run(on, s)));
    }, { injector });

    injector.get(DestroyRef).onDestroy(() => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
      stopPush();
      this.seq++;
      this.raw.set(null);
      this.dropped.set([]);
    });
  }
}

/* ---------------------------------------------------------------- the request popup */

function distanceKm(a: { lat: number | null; lng: number | null }, b: { lat: number | null; lng: number | null }): number | null {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h)) * 1.3; // roads are longer than a straight line
}

function km(n: number | null): string {
  return n === null ? "" : n < 1 ? `${Math.round(n * 1000)} m` : `${n.toFixed(1)} km`;
}

const R = 34;
const C = 2 * Math.PI * R;

@Component({
  selector: "pc-reject-sheet",
  imports: [Modal, ErrorNote, Textarea, Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="!!offer()" (close)="closed.emit()" title="Why are you rejecting?">
      <form (submit)="submit($event)" class="flex flex-col gap-3" data-testid="reject-sheet">
        <pc-error-note [message]="error()" />
        <fieldset class="flex flex-col gap-2">
          <legend class="sr-only">Reason</legend>
          @for (r of list(); track r[0]) {
            <label [class]="reason() === r[0] ? 'flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition bg-peacock-light ring-peacock' : 'flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition ring-line hover:bg-mist'">
              <input type="radio" name="reject" [value]="r[0]" [checked]="reason() === r[0]" (change)="reason.set(r[0])" class="h-4 w-4 accent-peacock" />
              <span class="font-medium">{{ r[1] }}</span>
            </label>
          }
        </fieldset>
        @if (reason() === "other") {
          <textarea pcTextarea [value]="note()" (input)="note.set($any($event.target).value)" placeholder="Tell us more (optional)" rows="2" maxlength="200" aria-label="More details"></textarea>
        }
        <p class="flex items-center gap-1.5 text-xs text-ink-faint"><svg [pcIcon]="Clock" class="h-3.5 w-3.5" />The request goes to the next partner right away.</p>
        <button pcButton type="submit" variant="danger" [loading]="busy()" [disabled]="!reason()" class="self-start">Reject request</button>
      </form>
    </pc-modal>
  `,
})
export class RejectSheet {
  readonly offer = input<Offer | null>(null);
  readonly reasons = input<Record<string, string>>({});
  readonly closed = output<void>();
  readonly done = output<string>();
  private readonly toast = inject(Toast);
  protected readonly list = computed(() => Object.entries(this.reasons()));
  protected readonly reason = signal("");
  protected readonly note = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly Clock = Clock;

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    const offer = this.offer();
    if (!offer || !this.reason()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/delivery/offers/${offer.id}/reject`, { method: "POST", body: { reason: this.reason(), note: this.note().trim() } });
      this.toast.show("Request rejected");
      this.reason.set("");
      this.note.set("");
      this.done.emit(offer.id);
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not reject");
    } finally {
      this.busy.set(false);
    }
  }
}

/** The new-request window over every partner screen (rendered by the shell). */
@Component({
  selector: "pc-offer-popup",
  imports: [Icon, Button, RejectSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (offer(); as o) {
      <div class="fixed inset-0 z-[60] flex items-end justify-center bg-ink/60 backdrop-blur-sm sm:items-center sm:p-4" role="alertdialog" aria-modal="true"
        aria-labelledby="offer-title" aria-describedby="offer-desc" data-testid="offer-popup">
        <div class="w-full max-w-md overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl motion-safe:animate-[pc-rise_220ms_ease-out]">
          <div class="relative bg-gradient-to-br from-peacock to-peacock-dark px-5 pb-5 pt-6 text-white">
            <div class="flex items-center gap-4">
              <div class="relative h-20 w-20 shrink-0" aria-hidden="true">
                <svg viewBox="0 0 80 80" class="h-20 w-20 -rotate-90">
                  <circle cx="40" cy="40" [attr.r]="R" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="7" />
                  <circle cx="40" cy="40" [attr.r]="R" fill="none" [attr.stroke]="left() <= 10 ? '#FFB4B4' : '#fff'" stroke-width="7" stroke-linecap="round"
                    [attr.stroke-dasharray]="C" [attr.stroke-dashoffset]="C * (1 - left() / total())" class="transition-[stroke-dashoffset] duration-300 ease-linear" />
                </svg>
                <span class="absolute inset-0 flex flex-col items-center justify-center leading-none">
                  <span class="font-display text-2xl font-bold">{{ left() }}</span>
                  <span class="text-[10px] font-semibold uppercase tracking-wider text-white/80">sec</span>
                </span>
              </div>
              <div class="min-w-0">
                <p class="text-xs font-bold uppercase tracking-[0.14em] text-white/75">{{ live().length > 1 ? "Request 1 of " + live().length : "New request" }}</p>
                <h2 id="offer-title" class="font-display text-2xl font-bold leading-tight">{{ o.kind === "pickup" ? "Return pickup request" : o.kind === "return" ? "Return to store" : "New delivery request" }}</h2>
                <p class="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-sm font-semibold">You earn about {{ rupees(o.fee_estimate) }}@if ((o.bonus_now ?? 0) > 0) {<span class="text-white/80">(incl. {{ rupees(o.bonus_now ?? 0) }} bad weather bonus)</span>}</p>
              </div>
            </div>
            <span class="sr-only" aria-live="assertive">{{ left() }} seconds left to accept</span>
          </div>

          <div id="offer-desc" class="flex flex-col gap-3 px-5 py-4">
            <div [class]="o.kind === 'pickup' ? 'relative flex flex-col gap-3 pl-8 flex-col-reverse' : 'relative flex flex-col gap-3 pl-8'">
              <span class="absolute bottom-6 left-[11px] top-6 w-0.5 bg-gradient-to-b from-marigold to-vermilion" aria-hidden="true"></span>
              <div class="relative">
                <span class="absolute -left-8 top-0 flex h-6 w-6 items-center justify-center rounded-full bg-marigold text-white"><svg [pcIcon]="Store" class="h-3.5 w-3.5" /></span>
                <p class="text-xs font-semibold uppercase tracking-wide text-ink-faint">{{ o.kind === "pickup" ? "Bring to" : "Pick up" }}{{ toStore() !== null && o.kind !== "pickup" ? " · " + km(toStore()) + " from you" : "" }}</p>
                <p class="font-semibold text-ink">{{ o.pickup.name }}</p>
                <p class="text-sm text-ink-soft">{{ join([o.pickup.address, o.pickup.city, o.pickup.pincode], ", ") }}</p>
              </div>
              <div class="relative">
                <span class="absolute -left-8 top-0 flex h-6 w-6 items-center justify-center rounded-full bg-vermilion text-white"><svg [pcIcon]="MapPin" class="h-3.5 w-3.5" /></span>
                <p class="text-xs font-semibold uppercase tracking-wide text-ink-faint">{{ o.kind === "pickup" ? "Collect from" : "Deliver to" }}{{ toCustomer() !== null ? " · " + km(toCustomer()) + " from the store" : "" }}</p>
                <p class="font-semibold text-ink">{{ join([o.drop.city, o.drop.pincode], " ") || "Customer" }}</p>
                <p class="text-sm text-ink-soft">Full address shows after you accept.</p>
              </div>
            </div>
            <div class="flex flex-wrap gap-2 text-sm">
              <span class="inline-flex items-center gap-1.5 rounded-full bg-mist px-3 py-1 font-semibold"><svg [pcIcon]="Package" class="h-4 w-4 text-peacock" />{{ items() }} item{{ items() === 1 ? "" : "s" }}</span>
              @if (o.kind === "pickup") {
                <span class="inline-flex items-center gap-1.5 rounded-full bg-peacock-light px-3 py-1 font-semibold text-peacock"><svg [pcIcon]="Package" class="h-4 w-4" />Customer return{{ o.return_number ? " " + o.return_number : "" }}</span>
              } @else if (o.payment === "cod" && o.cod_amount > 0) {
                <span class="inline-flex items-center gap-1.5 rounded-full bg-marigold-light px-3 py-1 font-semibold text-[#8A5A00]"><svg [pcIcon]="Banknote" class="h-4 w-4" />Collect {{ rupees(o.cod_amount) }} cash</span>
              } @else {
                <span class="inline-flex items-center gap-1.5 rounded-full bg-leaf-light px-3 py-1 font-semibold text-leaf"><svg [pcIcon]="Check" class="h-4 w-4" />Prepaid</span>
              }
              @if (o.mode === "manual") {<span class="inline-flex items-center gap-1.5 rounded-full bg-peacock-light px-3 py-1 font-semibold text-peacock"><svg [pcIcon]="Bike" class="h-4 w-4" />Sent by the team</span>}
            </div>
          </div>

          <div class="grid grid-cols-[auto_1fr] gap-3 border-t border-line px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
            <button pcButton variant="danger" size="lg" (click)="rejecting.set(o)" [disabled]="!!busy()" data-testid="offer-reject">
              <svg [pcIcon]="X" class="h-5 w-5" /> Reject
            </button>
            <button pcButton size="lg" class="!bg-leaf text-lg hover:!bg-leaf/90" [loading]="busy() === 'accept'" (click)="accept(o)" data-testid="offer-accept">
              <svg [pcIcon]="Check" class="h-5 w-5" /> Accept
            </button>
          </div>
        </div>
      </div>
    }
    <pc-reject-sheet [offer]="rejectOpen()" [reasons]="feeds.options()?.reject_reasons ?? {}" (closed)="rejecting.set(null)" (done)="rejected($event)" />
  `,
})
export class OfferPopup {
  protected readonly feeds = inject(DeliveryFeedService);
  private readonly router = inject(Router);
  private readonly path = inject(RouteState).pathname;
  private readonly toast = inject(Toast);
  private readonly now = useNow(250);
  protected readonly busy = signal<"accept" | null>(null);
  protected readonly rejecting = signal<Offer | null>(null);
  protected readonly R = R;
  protected readonly C = C;
  protected readonly rupees = rupees;
  protected readonly km = km;
  protected readonly Store = Store;
  protected readonly MapPin = MapPin;
  protected readonly Package = Package;
  protected readonly Banknote = Banknote;
  protected readonly Check = Check;
  protected readonly Bike = Bike;
  protected readonly X = X;

  protected readonly live = computed(() => {
    const now = this.now();
    return (this.feeds.feed()?.offers ?? []).filter((o) => o.deadline > now);
  });
  // while the partner picks a reason the request stays theirs; it closes if the time runs out
  protected readonly rejectOpen = computed(() => {
    const r = this.rejecting();
    return r && r.deadline > this.now() && this.live().some((o) => o.id === r.id) ? r : null;
  });
  protected readonly offer = computed(() => (this.rejectOpen() ? null : this.live()[0] ?? null));
  private readonly offerId = computed(() => this.offer()?.id ?? null);
  protected readonly total = computed(() => Math.max(1, this.feeds.feed()?.offer_seconds ?? 30));
  protected readonly left = computed(() => {
    const o = this.offer();
    return o ? Math.max(0, Math.ceil((o.deadline - this.now()) / 1000)) : 0;
  });
  private readonly me = computed(() => {
    const last = this.feeds.location.last();
    return last ? { lat: last.coords.latitude, lng: last.coords.longitude } : { lat: null, lng: null };
  });
  protected readonly toStore = computed(() => {
    const o = this.offer();
    return o ? distanceKm(this.me(), o.pickup) : null;
  });
  protected readonly toCustomer = computed(() => {
    const o = this.offer();
    return o ? distanceKm(o.pickup, o.drop) : null;
  });
  protected readonly items = computed(() => (this.offer()?.items ?? []).reduce((n, i) => n + i.qty, 0));

  constructor() {
    // chime and vibrate every 2 seconds while a request is on screen; flash the tab title
    effect((onCleanup) => {
      if (!this.offerId()) return;
      const ring = () => {
        chime();
        vibrate([250, 120, 250]);
      };
      ring();
      const t = setInterval(ring, 2000);
      const title = document.title;
      document.title = "New delivery request";
      onCleanup(() => {
        clearInterval(t);
        vibrate(0);
        document.title = title;
      });
    });
  }

  protected join(parts: (string | null | undefined)[], sep: string): string {
    return parts.filter(Boolean).join(sep);
  }

  protected rejected(id: string): void {
    this.rejecting.set(null);
    this.feeds.drop(id);
    this.feeds.refresh();
  }

  protected async accept(offer: Offer): Promise<void> {
    this.busy.set("accept");
    try {
      await api(`/api/delivery/offers/${offer.id}/accept`, { method: "POST" });
      this.feeds.drop(offer.id);
      vibrate(0);
      this.toast.show("Accepted. Head to the store.");
      this.feeds.refresh();
      if (this.path() !== `/delivery/trips/${offer.id}`) void this.router.navigateByUrl(`/delivery/trips/${offer.id}`);
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not accept. Try again.", "error");
      if (e instanceof ApiError && ["offer_gone", "offer_expired", "not_found"].includes(e.code)) this.feeds.drop(offer.id);
      this.feeds.refresh();
    } finally {
      this.busy.set(null);
    }
  }
}
