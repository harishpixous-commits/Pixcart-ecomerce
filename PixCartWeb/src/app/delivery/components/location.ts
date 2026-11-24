/*
 * While a partner is online the app shares their position every few seconds (Admin → Delivery → Settings sets how
 * often). It powers "nearest partner" assignment, the live map and the customer's tracking. The browser asks for
 * permission once; the state is shown on the home screen so partners know when it is blocked.
 * Port of components/delivery/location.tsx (useLocationSharing).
 */

import { computed, signal } from "@angular/core";
import { api } from "../../core/api";

export type LocationState = "off" | "asking" | "on" | "denied" | "unsupported";

/** One sharing session: run(active, everySeconds) starts it and returns the stop function (an effect's cleanup). */
export class LocationSharing {
  private readonly raw = signal<LocationState>("off");
  private readonly active = signal(false);
  readonly last = signal<GeolocationPosition | null>(null);
  /** "off" while not sharing */
  readonly state = computed<LocationState>(() => (this.active() ? this.raw() : "off"));
  private sentAt = 0;

  run(active: boolean, everySeconds: number): () => void {
    this.active.set(active);
    if (!active) return () => {};
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      const t = setTimeout(() => this.raw.set("unsupported"), 0);
      return () => clearTimeout(t);
    }
    const asking = setTimeout(() => this.raw.update((s) => (s === "on" ? s : "asking")), 0);
    const send = (pos: GeolocationPosition, force = false) => {
      this.last.set(pos);
      this.raw.set("on");
      const now = Date.now();
      if (!force && now - this.sentAt < everySeconds * 1000) return;
      this.sentAt = now;
      api("/api/delivery/me/location", { method: "POST", body: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } }).catch(() => {});
    };
    const watch = navigator.geolocation.watchPosition(
      (pos) => send(pos),
      (err) => this.raw.set(err.code === err.PERMISSION_DENIED ? "denied" : "asking"),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    // a heartbeat even when the partner stands still (watchPosition only fires on movement on some phones)
    const beat = setInterval(() => {
      navigator.geolocation.getCurrentPosition((pos) => send(pos, true), () => {}, { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 });
    }, Math.max(everySeconds, 15) * 1000);
    return () => { clearTimeout(asking); navigator.geolocation.clearWatch(watch); clearInterval(beat); };
  }
}
