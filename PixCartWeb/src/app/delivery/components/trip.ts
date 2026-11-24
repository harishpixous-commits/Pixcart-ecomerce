/*
 * Pieces shared by the partner's trip screens, the admin's live map, queue and trips, and the customer's tracking:
 * step progress, status pills, navigation links, and two small helpers (a ticking clock and polling while the tab is
 * visible). Port of components/delivery/trip.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal, type Signal } from "@angular/core";
import { Check } from "lucide-angular";
import type { TripBrief, TripStatus } from "../../core/delivery-types";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { Pill } from "../../shared/ui/ui";

/* ---------------------------------------------------------------- helpers (hooks) */

/** useNow(): the current time, refreshed every `everyMs` (call in a constructor or field initialiser). */
export function useNow(everyMs = 1000): Signal<number> {
  const now = signal(Date.now());
  const t = setInterval(() => now.set(Date.now()), everyMs);
  inject(DestroyRef).onDestroy(() => clearInterval(t));
  return now.asReadonly();
}

/**
 * usePolling(): calls `load` now, then every `ms` while the page is visible, and again as soon as it becomes visible.
 * Call in a constructor or field initialiser; it stops when the component is destroyed.
 */
export function usePolling(load: () => void, ms: number): void {
  load();
  const tick = () => {
    if (document.visibilityState === "visible") load();
  };
  const t = setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("online", tick);
  inject(DestroyRef).onDestroy(() => {
    clearInterval(t);
    document.removeEventListener("visibilitychange", tick);
    window.removeEventListener("online", tick);
  });
}

/* ---------------------------------------------------------------- formatting */

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60 ? `${m % 60} min ` : ""}ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function minutesLabel(min: number | null | undefined): string {
  if (min === null || min === undefined) return "";
  if (min < 60) return `${Math.max(0, min)} min`;
  const h = Math.floor(min / 60);
  return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

export function secondsLabel(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "";
  if (sec < 60) return `${sec} s`;
  return minutesLabel(Math.round(sec / 60));
}

export function time(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "";
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

/* ---------------------------------------------------------------- links */

/** Turn-by-turn directions in Google Maps (the app on phones), to exact coordinates when known. */
export function navigateUrl(p: { lat: number | null; lng: number | null; address?: string; city?: string; pincode?: string }): string {
  const dest = p.lat !== null && p.lng !== null ? `${p.lat},${p.lng}` : [p.address, p.city, p.pincode].filter(Boolean).join(", ");
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

export function telUrl(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  return `tel:${digits.length === 10 ? `+91${digits}` : digits}`;
}

/* ---------------------------------------------------------------- status */

const TONE: Record<TripStatus, "green" | "amber" | "red" | "blue" | "gray"> = {
  offered: "amber",
  accepted: "blue",
  at_store: "blue",
  picked: "blue",
  on_the_way: "blue",
  reached: "blue",
  delivered: "green",
  rejected: "gray",
  expired: "gray",
  cancelled: "gray",
  failed: "red",
};

const SHORT: Record<TripStatus, string> = {
  offered: "Request sent",
  accepted: "Going to store",
  at_store: "At store",
  picked: "Picked up",
  on_the_way: "On the way",
  reached: "At customer",
  delivered: "Delivered",
  rejected: "Declined",
  expired: "Missed",
  cancelled: "Cancelled",
  failed: "Not delivered",
};

const PICKUP_SHORT: Partial<Record<TripStatus, string>> = {
  offered: "Pickup request",
  accepted: "Going to customer",
  reached: "At customer",
  picked: "Collected",
  on_the_way: "To the store",
  delivered: "Returned to store",
  failed: "Not collected",
};

export function tripShort(t: Pick<TripBrief, "status" | "kind">): string {
  if (t.kind === "pickup") return PICKUP_SHORT[t.status] ?? SHORT[t.status] ?? t.status;
  if (t.kind === "return") {
    if (t.status === "delivered") return "Returned to store";
    if (t.status === "reached") return "Back at store";
    if (t.status === "picked" || t.status === "on_the_way") return "Returning";
  }
  return SHORT[t.status] ?? t.status;
}

/** <pc-trip-pill [trip]="t" /> */
@Component({
  selector: "pc-trip-pill",
  imports: [Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-pill [tone]="tone()">{{ text() }}</pc-pill>`,
})
export class TripPill {
  readonly trip = input.required<Pick<TripBrief, "status" | "kind">>();
  protected readonly tone = computed(() => TONE[this.trip().status] ?? "gray");
  protected readonly text = computed(() => tripShort(this.trip()));
}

/* ---------------------------------------------------------------- progress */

type StepDef = { key: TripStatus; label: string; at: keyof TripBrief };

const DELIVERY_STEPS: StepDef[] = [
  { key: "accepted", label: "Accepted", at: "accepted_at" },
  { key: "at_store", label: "At store", at: "at_store_at" },
  { key: "picked", label: "Picked up", at: "picked_at" },
  { key: "on_the_way", label: "On the way", at: "on_the_way_at" },
  { key: "reached", label: "Arrived", at: "reached_at" },
  { key: "delivered", label: "Delivered", at: "delivered_at" },
];

const PICKUP_STEPS: StepDef[] = [
  { key: "accepted", label: "Accepted", at: "accepted_at" },
  { key: "reached", label: "At customer", at: "reached_at" },
  { key: "picked", label: "Collected", at: "picked_at" },
  { key: "on_the_way", label: "To the store", at: "on_the_way_at" },
  { key: "delivered", label: "Handed over", at: "delivered_at" },
];

const RETURN_STEPS: StepDef[] = [
  { key: "picked", label: "Package with you", at: "picked_at" },
  { key: "on_the_way", label: "Going back", at: "on_the_way_at" },
  { key: "reached", label: "At the store", at: "reached_at" },
  { key: "delivered", label: "Returned", at: "delivered_at" },
];

/** <ol pcTripProgress [trip]="t" [compact]="false"></ol> */
@Component({
  selector: "ol[pcTripProgress]",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "olCls()", "aria-label": "Trip progress" },
  template: `
    @for (s of rows(); track s.key) {
      <li class="flex min-w-0 flex-col items-center gap-1 text-center" [attr.aria-current]="s.current ? 'step' : null">
        <span class="relative flex w-full items-center">
          <span [class]="s.before"></span>
          <span [class]="s.dot">
            @if (s.done) {<svg [pcIcon]="Check" [strokeWidth]="3" [class]="compact() ? 'h-3 w-3' : 'h-4 w-4'" />} @else {<span class="text-[11px] font-bold">{{ s.n }}</span>}
          </span>
          <span [class]="s.after"></span>
        </span>
        @if (!compact()) {
          <span [class]="s.labelCls">{{ s.label }}</span>
          @if (s.stamp) {<span class="text-[11px] text-ink-faint">{{ s.stamp }}</span>}
        }
      </li>
    }
  `,
})
export class TripProgress {
  readonly trip = input.required<TripBrief>();
  readonly compact = input(false);
  protected readonly Check = Check;
  protected readonly olCls = computed(() => cx("grid gap-1", this.compact() ? "grid-flow-col" : "grid-cols-3 gap-y-3 sm:grid-flow-col sm:grid-cols-none"));
  protected readonly rows = computed(() => {
    const trip = this.trip();
    const compact = this.compact();
    const steps = trip.kind === "pickup" ? PICKUP_STEPS : trip.kind === "return" ? RETURN_STEPS : DELIVERY_STEPS;
    // The step reached (−1 while it is still a request). A skipped step ("At store") counts as done once a later one is.
    const at = steps.findIndex((s) => s.key === trip.status);
    const ended = ["failed", "cancelled", "rejected", "expired"].includes(trip.status);
    return steps.map((s, i) => {
      const done = i <= at || (ended && !!trip[s.at]);
      const current = !ended && trip.status !== "delivered" && i === at + 1; // the step being worked on now
      const stamp = trip[s.at] as string | null;
      return {
        key: s.key,
        label: s.label,
        n: i + 1,
        done,
        current,
        stamp: stamp ? time(stamp) : "",
        before: cx("h-1 flex-1 rounded-full", i === 0 ? "bg-transparent" : done ? "bg-leaf" : "bg-line"),
        after: cx("h-1 flex-1 rounded-full", i === steps.length - 1 ? "bg-transparent" : at > i ? "bg-leaf" : "bg-line"),
        dot: cx("flex shrink-0 items-center justify-center rounded-full", compact ? "h-5 w-5" : "h-7 w-7",
          done ? "bg-leaf text-white" : current ? "bg-peacock text-white" : "bg-mist text-ink-faint ring-1 ring-line"),
        labelCls: cx("text-xs font-semibold leading-tight", done || current ? "text-ink" : "text-ink-faint"),
      };
    });
  });
}
