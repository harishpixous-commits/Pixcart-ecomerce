/*
 * Small helpers the seller hub shares with other areas:
 *   openPdf(path, onError)        opens an invoice or credit note (from components/order-returns.tsx)
 *   RETURN_STATUS                 return statuses as customers and sellers read them (components/order-returns.tsx)
 *   telUrl(phone)                 a tel: link with +91 for 10-digit numbers (components/delivery/trip.tsx)
 *   usePolling(load, ms, enabled) reloads every few seconds while enabled and the page is visible (components/delivery/trip.tsx)
 *   <pc-stars [value]="4.2" size="h-4 w-4" />   five stars (components/reviews.tsx)
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, type Signal } from "@angular/core";
import { Star } from "lucide-angular";
import { downloadBlob } from "../../core/api";
import { Icon } from "../ui/icon";

export const RETURN_STATUS: Record<string, string> = {
  requested: "Waiting for the seller",
  approved: "Approved, pickup pending",
  picked_up: "Picked up",
  received: "Received, refund pending",
  refunded: "Refunded",
  rejected: "Not accepted",
  cancelled: "Cancelled",
};

export async function openPdf(path: string, onError: (m: string) => void) {
  try {
    const blob = await downloadBlob(path);
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  } catch (e) {
    onError(e instanceof Error ? e.message : "Could not open the document");
  }
}

export function telUrl(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  return `tel:${digits.length === 10 ? `+91${digits}` : digits}`;
}

/** Calls load now and every `ms` while enabled() is true and the page is visible (also on coming back online). Call in a constructor. */
export function usePolling(load: () => void, ms: number, enabled: Signal<boolean>) {
  const destroy = inject(DestroyRef);
  let stop: (() => void) | null = null;
  effect(() => {
    stop?.();
    stop = null;
    if (!enabled()) return;
    load();
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const t = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    stop = () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
    };
  });
  destroy.onDestroy(() => stop?.());
}

@Component({
  selector: "pc-stars",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "inline-flex", "[attr.aria-label]": "value() + ' out of 5 stars'" },
  template: `@for (n of five; track n) {<svg [pcIcon]="Star" [class]="size() + (n <= rounded() ? ' fill-marigold text-marigold' : ' text-line')" />}`,
})
export class Stars {
  readonly value = input.required<number>();
  readonly size = input("h-4 w-4");
  protected readonly Star = Star;
  protected readonly five = [1, 2, 3, 4, 5];
  protected readonly rounded = computed(() => Math.round(this.value()));
}
