"use client";

/*
 * While a partner is online the app shares their position every few seconds (Admin → Delivery → Settings sets how
 * often). It powers "nearest partner" assignment, the live map and the customer's tracking. The browser asks for
 * permission once; the state is shown on the home screen so partners know when it is blocked.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export type LocationState = "off" | "asking" | "on" | "denied" | "unsupported";

export function useLocationSharing(active: boolean, everySeconds: number): { state: LocationState; last: GeolocationPosition | null } {
  const [state, setState] = useState<LocationState>("off");
  const [last, setLast] = useState<GeolocationPosition | null>(null);
  const sentAt = useRef(0);
  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      const t = setTimeout(() => setState("unsupported"), 0);
      return () => clearTimeout(t);
    }
    const asking = setTimeout(() => setState((s) => (s === "on" ? s : "asking")), 0);
    const send = (pos: GeolocationPosition, force = false) => {
      setLast(pos);
      setState("on");
      const now = Date.now();
      if (!force && now - sentAt.current < everySeconds * 1000) return;
      sentAt.current = now;
      api("/api/delivery/me/location", { method: "POST", body: { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } }).catch(() => {});
    };
    const watch = navigator.geolocation.watchPosition(
      (pos) => send(pos),
      (err) => setState(err.code === err.PERMISSION_DENIED ? "denied" : "asking"),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    // a heartbeat even when the partner stands still (watchPosition only fires on movement on some phones)
    const beat = setInterval(() => {
      navigator.geolocation.getCurrentPosition((pos) => send(pos, true), () => {}, { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 });
    }, Math.max(everySeconds, 15) * 1000);
    return () => { clearTimeout(asking); navigator.geolocation.clearWatch(watch); clearInterval(beat); };
  }, [active, everySeconds]);
  return { state: active ? state : "off", last };
}
