"use client";

/*
 * "Pin your exact location": asks the browser for the shopper's position (only when they tap the button), shows it on
 * the map and lets them drag the pin or tap the map to correct it. The pin is saved with the address so the delivery
 * partner can navigate to the right door. Nothing is sent anywhere else.
 */

import clsx from "clsx";
import { Crosshair, Loader2, LocateFixed, MapPinOff } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { loadDeliveryOptions } from "@/components/delivery/app";

const LiveMap = dynamic(() => import("@/components/map/live-map").then((m) => m.LiveMap), { ssr: false, loading: () => <div className="h-56 animate-pulse rounded-2xl bg-mist" /> });

type Pos = { lat: number; lng: number } | null;

export function useCurrentPosition() {
  const [state, setState] = useState<{ status: "idle" | "asking" | "ok" | "denied" | "error" | "unsupported"; accuracy: number | null }>({ status: "idle", accuracy: null });
  function locate(onFound: (lat: number, lng: number) => void) {
    if (typeof navigator === "undefined" || !navigator.geolocation) return setState({ status: "unsupported", accuracy: null });
    setState({ status: "asking", accuracy: null });
    navigator.geolocation.getCurrentPosition(
      (p) => { setState({ status: "ok", accuracy: Math.round(p.coords.accuracy) }); onFound(p.coords.latitude, p.coords.longitude); },
      (e) => setState({ status: e.code === e.PERMISSION_DENIED ? "denied" : "error", accuracy: null }),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }
  return { ...state, locate };
}

export function LocationPicker({ value, onChange, compact, className }: { value: Pos; onChange: (lat: number, lng: number) => void; compact?: boolean; className?: string }) {
  const here = useCurrentPosition();
  const [tiles, setTiles] = useState<{ url: string; attribution: string } | null>(null);
  useEffect(() => {
    let live = true;
    loadDeliveryOptions().then((o) => { if (live) setTiles({ url: o.map_tiles, attribution: o.map_attribution }); }).catch(() => { if (live) setTiles({ url: "", attribution: "" }); });
    return () => { live = false; };
  }, []);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const set = (lat: number, lng: number) => onChange(round(lat), round(lng));
  return (
    <div className={clsx("flex flex-col gap-2", className)} data-testid="location-picker">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => here.locate(set)} disabled={here.status === "asking"}
          className="inline-flex items-center gap-2 rounded-full bg-peacock px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-peacock-dark disabled:opacity-70">
          {here.status === "asking" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Crosshair className="h-4 w-4" />} Use my current location
        </button>
        {value && <span className="inline-flex items-center gap-1 text-sm font-semibold text-leaf"><LocateFixed className="h-4 w-4" /> Location pinned{here.accuracy ? ` (about ${here.accuracy} m)` : ""}</span>}
      </div>
      {here.status === "denied" && (
        <p className="flex items-start gap-2 rounded-xl bg-vermilion-light px-3 py-2 text-sm text-vermilion"><MapPinOff className="mt-0.5 h-4 w-4 shrink-0" />
          Location is blocked for this site. Allow it in your browser&apos;s site settings, or tap the map to place the pin yourself.</p>
      )}
      {(here.status === "error" || here.status === "unsupported") && <p className="text-sm text-ink-soft">Could not get your location. Tap the map to place the pin.</p>}
      {tiles && (
        <LiveMap className={compact ? "h-48" : "h-64"} tiles={tiles.url} attribution={tiles.attribution} pickable onPick={set}
          center={value ? [value.lat, value.lng] : undefined} zoom={value ? 17 : 5} fitKey={value ? `${value.lat},${value.lng}` : undefined}
          markers={value ? [{ id: "pin", lat: value.lat, lng: value.lng, kind: "pin", title: "Your delivery location" }] : []} />
      )}
      <p className="text-xs text-ink-faint">{value ? "Drag the pin or tap the map to fine-tune it to your door." : "Tap the map to drop a pin, or use your current location."}</p>
    </div>
  );
}
