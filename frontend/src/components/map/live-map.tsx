"use client";

/*
 * One map for the whole store, on OpenStreetMap tiles (Admin → Delivery settings → Map tiles can point to another
 * provider). Used by the admin live map, the partner's trip, the customer's tracking and the address pin.
 * Leaflet is loaded in the browser only. Markers are simple coloured badges so they stay sharp on every screen.
 */

import "leaflet/dist/leaflet.css";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import type * as LeafletNS from "leaflet";

export type MapMarker = {
  id: string;
  lat: number;
  lng: number;
  kind: "partner" | "partner-busy" | "partner-stale" | "store" | "home" | "pin";
  label?: string; // short text in the badge (initials, a number)
  title?: string; // tooltip
  popup?: string; // plain text shown when tapped
};

export type MapLine = { id: string; points: [number, number][]; color?: string; dashed?: boolean };

const STYLE: Record<MapMarker["kind"], { bg: string; ring: string; icon: string }> = {
  partner: { bg: "#1E8E3E", ring: "rgba(30,142,62,0.35)", icon: "bike" },
  "partner-busy": { bg: "#0B5563", ring: "rgba(11,85,99,0.35)", icon: "bike" },
  "partner-stale": { bg: "#8A97A0", ring: "rgba(138,151,160,0.3)", icon: "bike" },
  store: { bg: "#F5A524", ring: "rgba(245,165,36,0.35)", icon: "store" },
  home: { bg: "#D7263D", ring: "rgba(215,38,61,0.35)", icon: "home" },
  pin: { bg: "#D7263D", ring: "rgba(215,38,61,0.35)", icon: "pin" },
};

const ICONS: Record<string, string> = {
  bike: '<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5V14l-3-3 4-3 2 3h2"/>',
  store: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 1 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
};

function escape(text: string) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function badge(m: MapMarker) {
  const s = STYLE[m.kind];
  const pulse = m.kind === "partner" ? `<span class="pc-map-pulse" style="background:${s.ring}"></span>` : "";
  const label = m.label ? `<span class="pc-map-label">${escape(m.label)}</span>` : "";
  return `<span class="pc-map-badge" style="--pc-bg:${s.bg};--pc-ring:${s.ring}">${pulse}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[s.icon]}</svg>${label}</span>`;
}

type Drawn = { marker: LeafletNS.Marker; html: string; popup: string };

export function LiveMap({ markers, lines = [], tiles, attribution, fitKey, fitPoints, center, zoom = 13, className, onPick, onMarker, pickable }: {
  markers: MapMarker[]; lines?: MapLine[]; tiles?: string; attribution?: string;
  fitKey?: string; // when it changes, the map zooms to show every marker (or just fitPoints)
  fitPoints?: [number, number][];
  center?: [number, number]; zoom?: number; className?: string;
  pickable?: boolean; onPick?: (lat: number, lng: number) => void; // tap the map to move the pin
  onMarker?: (id: string) => void; // a marker was tapped
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletNS.Map | null>(null);
  const layer = useRef<LeafletNS.LayerGroup | null>(null);
  const lineLayer = useRef<LeafletNS.LayerGroup | null>(null);
  const drawn = useRef(new Map<string, Drawn>());
  const lib = useRef<typeof LeafletNS | null>(null);
  const fitted = useRef<string | undefined>(undefined);
  const pick = useRef(onPick);
  const tapped = useRef(onMarker);
  const [ready, setReady] = useState(false);

  useEffect(() => { pick.current = onPick; tapped.current = onMarker; }, [onPick, onMarker]);

  // create the map once
  useEffect(() => {
    let cancelled = false;
    import("leaflet").then((L) => {
      if (cancelled || !box.current || map.current) return;
      lib.current = L;
      const m = L.map(box.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(center ?? [20.59, 78.96], center ? zoom : 5);
      L.tileLayer(tiles || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: attribution || "© OpenStreetMap contributors" }).addTo(m);
      lineLayer.current = L.layerGroup().addTo(m);
      layer.current = L.layerGroup().addTo(m);
      m.on("click", (e: LeafletNS.LeafletMouseEvent) => { if (pick.current) pick.current(e.latlng.lat, e.latlng.lng); });
      m.on("focus", () => m.scrollWheelZoom.enable());
      m.on("blur", () => m.scrollWheelZoom.disable());
      map.current = m;
      setReady(true);
    }).catch(() => {});
    const shown = drawn.current;
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      layer.current = null;
      lineLayer.current = null;
      shown.clear();
    };
    // the map is created once; markers, lines and the view update below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers are kept by id and moved in place, so a live update does not close an open popup or make the map flicker.
  useEffect(() => {
    const L = lib.current;
    const m = map.current;
    const group = layer.current;
    const lineGroup = lineLayer.current;
    if (!ready || !L || !m || !group || !lineGroup) return;
    lineGroup.clearLayers();
    for (const ln of lines) {
      if (ln.points.length < 2) continue;
      L.polyline(ln.points, { color: ln.color ?? "#0B5563", weight: 4, opacity: 0.8, dashArray: ln.dashed ? "8 8" : undefined }).addTo(lineGroup);
    }
    const seen = new Set<string>();
    for (const mk of markers) {
      seen.add(mk.id);
      const html = badge(mk);
      const popup = mk.popup ? escape(mk.popup).replace(/\n/g, "<br/>") : "";
      const old = drawn.current.get(mk.id);
      if (old) {
        const at = old.marker.getLatLng();
        if (at.lat !== mk.lat || at.lng !== mk.lng) old.marker.setLatLng([mk.lat, mk.lng]);
        if (old.html !== html) {
          old.marker.setIcon(L.divIcon({ html, className: "pc-map-icon", iconSize: [36, 36], iconAnchor: [18, mk.kind === "pin" ? 34 : 18] }));
          old.html = html;
        }
        if (old.popup !== popup) {
          if (popup) {
            if (old.marker.getPopup()) old.marker.setPopupContent(popup);
            else old.marker.bindPopup(popup);
          } else old.marker.unbindPopup();
          old.popup = popup;
        }
        continue;
      }
      const icon = L.divIcon({ html, className: "pc-map-icon", iconSize: [36, 36], iconAnchor: [18, mk.kind === "pin" ? 34 : 18] });
      const marker = L.marker([mk.lat, mk.lng], { icon, title: mk.title, alt: mk.title, draggable: pickable && mk.kind === "pin", keyboard: true });
      if (popup) marker.bindPopup(popup);
      if (pickable && mk.kind === "pin") marker.on("dragend", () => { const p = marker.getLatLng(); pick.current?.(p.lat, p.lng); });
      marker.on("click", () => tapped.current?.(mk.id));
      marker.addTo(group);
      drawn.current.set(mk.id, { marker, html, popup });
    }
    for (const [id, d] of drawn.current) {
      if (!seen.has(id)) {
        group.removeLayer(d.marker);
        drawn.current.delete(id);
      }
    }
    const pts = fitPoints?.length ? fitPoints : markers.map((x) => [x.lat, x.lng] as [number, number]);
    if (fitKey !== undefined && fitted.current !== fitKey && pts.length) {
      fitted.current = fitKey;
      if (pts.length === 1) m.setView(pts[0], Math.max(m.getZoom(), 15));
      else m.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
    }
  }, [ready, markers, lines, fitKey, fitPoints, pickable]);

  return (
    // "isolate" keeps Leaflet's own z-indexes inside the map, under sticky headers and dialogs
    <div className={clsx("relative isolate overflow-hidden rounded-2xl ring-1 ring-black/5", className ?? "h-80")}>
      <div ref={box} className="absolute inset-0 z-0" role="application" aria-label="Map" tabIndex={0} />
      {!ready && <div className="absolute inset-0 animate-pulse bg-mist" aria-hidden />}
    </div>
  );
}
