/*
 * The customer's view of a package our own delivery partner carries: who is coming (photo, vehicle, rating, call),
 * where they are on the map while on the way, the OTP to share at the door, and after delivery the photo of the
 * package, a rating for the partner and "report a problem". Port of components/delivery/tracking.tsx (and DocViewer
 * from components/delivery/admin.tsx):
 *   <pc-delivery-tracking [orderId] [subId] [f] [packageStatus] (changed)="..." />
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import { DomSanitizer } from "@angular/platform-browser";
import { Bike, Camera, Check, FileText, KeyRound, Loader2, MessageSquareWarning, Phone, Star } from "lucide-angular";
import { ApiError, api, downloadBlob } from "../../core/api";
import type { FleetTracking } from "../../core/types";
import { ago, time, useNow } from "../../delivery/components/trip";
import { LiveMap, type MapLine, type MapMarker } from "../../shared/map/live-map";
import { telUrl } from "../../shared/portal/helpers";
import { Icon } from "../../shared/ui/icon";
import { Button, ErrorNote, Modal, Textarea, Toast } from "../../shared/ui/ui";

const HEADLINE: Record<string, string> = {
  accepted: "Your delivery partner is going to the store",
  at_store: "Your delivery partner is at the store",
  picked: "Picked up. Your package is on its way",
  on_the_way: "On the way to you",
  reached: "Your delivery partner has arrived",
  delivered: "Delivered",
  failed: "Delivery attempt failed",
};

const COMPLAINTS: [string, string][] = [
  ["late", "Delivered late"],
  ["rude", "Rude or unprofessional"],
  ["damaged", "Package damaged"],
  ["not_received", "Marked delivered but not received"],
  ["extra_money", "Asked for extra money"],
  ["other", "Something else"],
];

type StepAt = "accepted_at" | "picked_at" | "on_the_way_at" | "reached_at" | "delivered_at";
const STEPS: { key: string; label: string; at: StepAt }[] = [
  { key: "accepted", label: "Partner assigned", at: "accepted_at" },
  { key: "picked", label: "Picked up", at: "picked_at" },
  { key: "on_the_way", label: "On the way", at: "on_the_way_at" },
  { key: "reached", label: "Arrived", at: "reached_at" },
  { key: "delivered", label: "Delivered", at: "delivered_at" },
];
const ORDER = ["accepted", "at_store", "picked", "on_the_way", "reached", "delivered"];

/** Opens a private file (KYC document or delivery proof) through the signed-in API and shows it in a modal. */
@Component({
  selector: "pc-doc-viewer",
  imports: [Icon, Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="path() !== null" (close)="onClose()" [title]="title()" [wide]="true">
      @if (error()) {
        <p class="text-vermilion">{{ error() }}</p>
      } @else if (!shown()) {
        <div class="flex h-64 items-center justify-center text-ink-soft"><svg [pcIcon]="Loader2" class="h-6 w-6 animate-spin" /></div>
      } @else if (shown()!.type === "application/pdf") {
        <div class="flex flex-col gap-2">
          <iframe [src]="shown()!.safe" [title]="title()" class="h-[70vh] w-full rounded-lg ring-1 ring-line"></iframe>
          <a [href]="shown()!.url" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-peacock"><svg [pcIcon]="FileText" class="h-4 w-4" /> Open in a new tab</a>
        </div>
      } @else {
        <img [src]="shown()!.url" [alt]="title()" class="mx-auto max-h-[70vh] rounded-lg object-contain ring-1 ring-line" />
      }
    </pc-modal>
  `,
})
export class DocViewer {
  readonly path = input<string | null>(null);
  readonly title = input.required<string>();
  readonly closed = output<void>();
  private readonly file = signal<{ path: string; url: string; type: string; safe: unknown } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly shown = computed(() => {
    const f = this.file();
    return f && f.path === this.path() ? f : null;
  });
  protected readonly Loader2 = Loader2;
  protected readonly FileText = FileText;
  private readonly sanitizer = inject(DomSanitizer);

  constructor() {
    effect((onCleanup) => {
      const path = this.path();
      if (!path) return;
      let live = true;
      let url = "";
      downloadBlob(path)
        .then((b) => {
          url = URL.createObjectURL(b);
          if (live) this.file.set({ path, url, type: b.type, safe: this.sanitizer.bypassSecurityTrustResourceUrl(url) });
        })
        .catch(() => {
          if (live) this.error.set("Could not open the file");
        });
      onCleanup(() => {
        live = false;
        if (url) URL.revokeObjectURL(url);
      });
    });
  }

  protected onClose(): void {
    this.file.set(null);
    this.error.set(null);
    this.closed.emit();
  }
}

@Component({
  selector: "pc-rate-form",
  imports: [Icon, Button, ErrorNote, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="rounded-xl bg-white p-3 ring-1 ring-black/5" data-testid="rate-delivery">
      <p class="font-semibold">How was your delivery by {{ name() }}?</p>
      <div class="mt-1 flex gap-1" role="radiogroup" aria-label="Rating" (mouseleave)="hover.set(0)">
        @for (n of [1, 2, 3, 4, 5]; track n) {
          <button type="button" role="radio" [attr.aria-checked]="stars() === n" [attr.aria-label]="n + ' star' + (n === 1 ? '' : 's')"
            (click)="stars.set(n)" (mouseenter)="hover.set(n)" class="rounded-lg p-1 transition hover:scale-110">
            <svg [pcIcon]="Star" [class]="n <= shownStars() ? 'h-8 w-8 fill-marigold text-marigold' : 'h-8 w-8 text-line'" />
          </button>
        }
      </div>
      @if (stars() > 0) {
        <div class="mt-2 flex flex-col gap-2">
          <textarea pcTextarea [value]="comment()" (input)="comment.set($any($event.target).value)" rows="2" maxlength="500"
            [placeholder]="stars() >= 4 ? 'What did you like? (optional)' : 'What went wrong? (optional)'" aria-label="Comment"></textarea>
          <pc-error-note [message]="error()" />
          <button pcButton size="sm" class="self-start" [loading]="busy()" (click)="submit()">Submit rating</button>
        </div>
      }
    </div>
  `,
})
export class RateForm {
  readonly orderId = input.required<string>();
  readonly subId = input.required<string>();
  readonly name = input.required<string>();
  readonly done = output<void>();
  private readonly toast = inject(Toast);
  protected readonly stars = signal(0);
  protected readonly hover = signal(0);
  protected readonly comment = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly shownStars = computed(() => this.hover() || this.stars());
  protected readonly Star = Star;

  protected async submit(): Promise<void> {
    if (!this.stars()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/orders/${this.orderId()}/delivery-rating`, { method: "POST", body: { sub_order_id: this.subId(), rating: this.stars(), comment: this.comment().trim() } });
      this.toast.show("Thanks for rating your delivery");
      this.done.emit();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save your rating");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-complaint-dialog",
  imports: [Button, ErrorNote, Modal, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="open()" (close)="closed.emit()" title="Report a delivery problem">
      <form (submit)="submit($event)" class="flex flex-col gap-3">
        <pc-error-note [message]="error()" />
        <fieldset class="flex flex-col gap-2">
          <legend class="sr-only">What happened?</legend>
          @for (c of complaints; track c[0]) {
            <label [class]="category() === c[0] ? 'flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition bg-peacock-light ring-peacock' : 'flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition ring-line hover:bg-mist'">
              <input type="radio" name="complaint" [value]="c[0]" [checked]="category() === c[0]" (change)="category.set(c[0])" class="h-4 w-4 accent-peacock" />
              <span class="font-medium">{{ c[1] }}</span>
            </label>
          }
        </fieldset>
        <textarea pcTextarea [value]="text()" (input)="text.set($any($event.target).value)" rows="3" maxlength="1000" placeholder="Tell us what happened" aria-label="Details"></textarea>
        <button pcButton type="submit" [loading]="busy()" [disabled]="!category()" class="self-start">Send</button>
      </form>
    </pc-modal>
  `,
})
export class ComplaintDialog {
  readonly open = input(false);
  readonly orderId = input.required<string>();
  readonly subId = input.required<string>();
  readonly closed = output<void>();
  private readonly toast = inject(Toast);
  protected readonly complaints = COMPLAINTS;
  protected readonly category = signal("");
  protected readonly text = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    if (!this.category()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await api(`/api/orders/${this.orderId()}/delivery-complaint`, { method: "POST", body: { sub_order_id: this.subId(), category: this.category(), text: this.text().trim() } });
      this.toast.show("Thanks for telling us. Our delivery team will look into it.");
      this.category.set("");
      this.text.set("");
      this.closed.emit();
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not send your complaint");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-delivery-tracking",
  imports: [Icon, Button, LiveMap, DocViewer, RateForm, ComplaintDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!a()) {
      @if (f().ready_for_pickup_at && packageStatus() === "packed") {
        <div class="flex items-center gap-3 rounded-2xl bg-peacock-light/50 p-3 text-sm ring-1 ring-peacock/15" data-testid="tracking-finding">
          <span class="relative flex h-3 w-3 shrink-0"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-peacock/40"></span><span class="relative inline-flex h-3 w-3 rounded-full bg-peacock"></span></span>
          <span><b>Packed and ready.</b> We are assigning a delivery partner near the seller.</span>
        </div>
      }
    } @else {
      @let asg = a()!;
      @let p = f().partner;
      <div class="flex flex-col gap-3 rounded-2xl bg-gradient-to-br from-peacock-light/60 to-white p-3 ring-1 ring-peacock/15 sm:p-4" [id]="'delivery-' + subId()" data-testid="delivery-tracking">
        <p [class]="asg.status === 'failed' ? 'flex items-center gap-2 font-display text-lg font-semibold text-vermilion' : asg.status === 'delivered' ? 'flex items-center gap-2 font-display text-lg font-semibold text-leaf' : 'flex items-center gap-2 font-display text-lg font-semibold text-peacock-dark'">
          <svg [pcIcon]="asg.status === 'delivered' ? Check : Bike" class="h-5 w-5" />
          {{ HEADLINE[asg.status] ?? asg.status_label }}
          @if (asg.status === "delivered" && asg.delivered_at) {<span class="text-sm font-normal text-ink-soft">at {{ time(asg.delivered_at) }}</span>}
        </p>

        @if (asg.status !== "failed") {
          <ol class="grid grid-cols-5 gap-1" aria-label="Delivery steps">
            @for (s of STEPS; track s.key) {
              @let done = reached() >= ORDER.indexOf(s.key);
              <li class="flex flex-col gap-1">
                <span [class]="done ? 'h-1.5 rounded-full bg-leaf' : 'h-1.5 rounded-full bg-line'"></span>
                <span [class]="done ? 'text-[11px] leading-tight font-semibold text-ink' : 'text-[11px] leading-tight text-ink-faint'">{{ s.label }}</span>
                @if (asg[s.at]) {<span class="text-[10px] text-ink-faint">{{ time(asg[s.at]) }}</span>}
              </li>
            }
          </ol>
        }
        @if (asg.status === "failed" && asg.fail_reason) {<p class="text-sm text-ink-soft">Reason: {{ asg.fail_reason }}. We will contact you to try again.</p>}

        @if (f().otp) {
          <div class="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-marigold/40" data-testid="delivery-otp-customer">
            <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-marigold-light text-marigold-dark"><svg [pcIcon]="KeyRound" class="h-5 w-5" /></span>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold uppercase tracking-wide text-ink-faint">Delivery OTP</p>
              <p class="font-mono text-2xl font-bold tracking-[0.35em]">{{ f().otp }}</p>
            </div>
            <p class="max-w-[11rem] text-xs text-ink-soft">Share it with the partner only when you receive the package.</p>
          </div>
        }

        @if (moving() && map().markers.length > 0) {
          <div>
            <pc-live-map [markers]="map().markers" [lines]="map().lines" [fitKey]="subId() + ':' + (f().location ? 'with' : 'without')" boxClass="h-52 sm:h-60" />
            <p class="mt-1 text-xs text-ink-faint">{{ f().location ? "Partner location updated " + ago(f().location!.at, now()) : "The partner's location shows here once they share it." }}</p>
          </div>
        }

        @if (p) {
          <div class="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-black/5">
            @if (p.photo) {
              <img [src]="p.photo" alt="" class="h-12 w-12 rounded-full object-cover" />
            } @else {
              <span class="flex h-12 w-12 items-center justify-center rounded-full bg-peacock-light font-bold text-peacock">{{ p.name.slice(0, 1) }}</span>
            }
            <div class="min-w-0 flex-1">
              <p class="font-semibold">{{ p.name }}</p>
              <p class="text-sm text-ink-soft">{{ p.vehicle }}{{ p.vehicle_no ? " · " + p.vehicle_no : "" }}@if (p.rating_count > 0) {<span class="ml-2 inline-flex items-center gap-0.5"><svg [pcIcon]="Star" class="h-3.5 w-3.5 fill-marigold text-marigold" />{{ p.rating_avg.toFixed(1) }}</span>}</p>
            </div>
            @if (asg.status !== "delivered" && asg.status !== "failed" && p.phone) {
              <a [href]="tel(p.phone)" class="inline-flex h-10 items-center gap-1.5 rounded-lg bg-peacock px-3 text-sm font-semibold text-white hover:bg-peacock-dark"><svg [pcIcon]="Phone" class="h-4 w-4" /> Call</a>
            }
          </div>
        }

        @if (asg.status === "delivered") {
          <div class="flex flex-col gap-3">
            @if (f().can_rate) {
              <pc-rate-form [orderId]="orderId()" [subId]="subId()" [name]="p?.name ?? 'your delivery partner'" (done)="changed.emit()" />
            } @else if (asg.rating) {
              <p class="flex items-center gap-1 text-sm text-ink-soft">You rated this delivery @for (i of range(asg.rating); track i) {<svg [pcIcon]="Star" class="h-4 w-4 fill-marigold text-marigold" />}</p>
            }
            <div class="flex flex-wrap gap-2">
              @if (asg.has_proof) {<button pcButton variant="secondary" size="sm" (click)="proof.set(true)"><svg [pcIcon]="Camera" class="h-4 w-4" /> Delivery photo</button>}
              <button pcButton variant="ghost" size="sm" (click)="complaint.set(true)"><svg [pcIcon]="MessageSquareWarning" class="h-4 w-4" /> Report a problem</button>
            </div>
          </div>
        }
        @if (asg.status === "failed") {
          <button pcButton variant="ghost" size="sm" class="self-start" (click)="complaint.set(true)"><svg [pcIcon]="MessageSquareWarning" class="h-4 w-4" /> Report a problem</button>
        }

        <pc-doc-viewer [path]="proof() ? '/api/orders/' + orderId() + '/delivery-proof/' + subId() : null" title="Delivery photo" (closed)="proof.set(false)" />
        <pc-complaint-dialog [open]="complaint()" [orderId]="orderId()" [subId]="subId()" (closed)="complaint.set(false)" />
      </div>
    }
  `,
})
export class DeliveryTracking {
  readonly orderId = input.required<string>();
  readonly subId = input.required<string>();
  readonly f = input.required<FleetTracking>();
  readonly packageStatus = input.required<string>();
  readonly changed = output<void>();
  protected readonly now = useNow(15_000);
  protected readonly proof = signal(false);
  protected readonly complaint = signal(false);
  protected readonly a = computed(() => this.f().assignment);
  protected readonly reached = computed(() => ORDER.indexOf(this.a()?.status ?? ""));
  protected readonly moving = computed(() => ["picked", "on_the_way", "reached"].includes(this.a()?.status ?? ""));
  protected readonly map = computed(() => {
    const f = this.f();
    const p = f.partner;
    const m: MapMarker[] = [];
    const l: MapLine[] = [];
    if (f.drop.lat !== null && f.drop.lng !== null) m.push({ id: "home", lat: f.drop.lat, lng: f.drop.lng, kind: "home", title: "Your address" });
    if (f.location) {
      m.push({ id: "partner", lat: f.location.lat, lng: f.location.lng, kind: "partner", title: p?.name ?? "Delivery partner", popup: p ? `${p.name}\n${p.vehicle} ${p.vehicle_no}` : undefined });
      if (f.drop.lat !== null && f.drop.lng !== null) l.push({ id: "route", points: [[f.location.lat, f.location.lng], [f.drop.lat, f.drop.lng]], dashed: true });
    }
    return { markers: m, lines: l };
  });
  protected readonly HEADLINE: Record<string, string | undefined> = HEADLINE;
  protected readonly STEPS = STEPS;
  protected readonly ORDER = ORDER;
  protected readonly time = time;
  protected readonly ago = ago;
  protected readonly tel = telUrl;
  protected readonly range = (n: number) => Array.from({ length: n }, (_, i) => i);
  protected readonly Bike = Bike;
  protected readonly Check = Check;
  protected readonly KeyRound = KeyRound;
  protected readonly Phone = Phone;
  protected readonly Star = Star;
  protected readonly Camera = Camera;
  protected readonly MessageSquareWarning = MessageSquareWarning;
}
