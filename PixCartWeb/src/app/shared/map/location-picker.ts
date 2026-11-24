/*
 * "Pin your exact location": asks the browser for the shopper's position (only when they tap the button), shows it on
 * the map and lets them drag the pin or tap the map to correct it. The pin is saved with the address so the delivery
 * partner can navigate to the right door. Nothing is sent anywhere else. Port of components/map/location-picker.tsx:
 *   <pc-location-picker [value]="{lat,lng}|null" (changed)="..." [compact]="true" />
 *   currentPosition(): the useCurrentPosition() hook as signals (status, accuracy, locate(cb)).
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { Crosshair, Loader2, LocateFixed, MapPinOff } from "lucide-angular";
import { loadDeliveryOptions } from "../../delivery/shell/delivery-app";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { LiveMap, type MapMarker } from "./live-map";

export type Pos = { lat: number; lng: number } | null;
export type PositionStatus = "idle" | "asking" | "ok" | "denied" | "error" | "unsupported";

/** useCurrentPosition(): call in a field initialiser. */
export function currentPosition() {
  const status = signal<PositionStatus>("idle");
  const accuracy = signal<number | null>(null);
  function locate(onFound: (lat: number, lng: number) => void) {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      status.set("unsupported");
      accuracy.set(null);
      return;
    }
    status.set("asking");
    accuracy.set(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        status.set("ok");
        accuracy.set(Math.round(p.coords.accuracy));
        onFound(p.coords.latitude, p.coords.longitude);
      },
      (e) => status.set(e.code === e.PERMISSION_DENIED ? "denied" : "error"),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }
  return { status, accuracy, locate };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

@Component({
  selector: "pc-location-picker",
  imports: [Icon, LiveMap],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cls()", "data-testid": "location-picker" },
  template: `
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" (click)="here.locate(set)" [disabled]="here.status() === 'asking'"
        class="inline-flex items-center gap-2 rounded-full bg-peacock px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-peacock-dark disabled:opacity-70">
        @if (here.status() === "asking") {<svg [pcIcon]="Loader2" class="h-4 w-4 animate-spin" />} @else {<svg [pcIcon]="Crosshair" class="h-4 w-4" />} Use my current location
      </button>
      @if (value()) {<span class="inline-flex items-center gap-1 text-sm font-semibold text-leaf"><svg [pcIcon]="LocateFixed" class="h-4 w-4" /> Location pinned{{ here.accuracy() ? " (about " + here.accuracy() + " m)" : "" }}</span>}
    </div>
    @if (here.status() === "denied") {
      <p class="flex items-start gap-2 rounded-xl bg-vermilion-light px-3 py-2 text-sm text-vermilion"><svg [pcIcon]="MapPinOff" class="mt-0.5 h-4 w-4 shrink-0" /> Location is blocked for this site. Allow it in your browser&apos;s site settings, or tap the map to place the pin yourself.</p>
    }
    @if (here.status() === "error" || here.status() === "unsupported") {<p class="text-sm text-ink-soft">Could not get your location. Tap the map to place the pin.</p>}
    @if (tiles(); as t) {
      <pc-live-map [mapClass]="compact() ? 'h-48' : 'h-64'" [tiles]="t.url" [attribution]="t.attribution" [pickable]="true" (pick)="set($event.lat, $event.lng)"
        [center]="center()" [zoom]="value() ? 17 : 5" [fitKey]="fitKey()" [markers]="markers()" />
    }
    <p class="text-xs text-ink-faint">{{ value() ? "Drag the pin or tap the map to fine-tune it to your door." : "Tap the map to drop a pin, or use your current location." }}</p>
  `,
})
export class LocationPicker {
  readonly value = input<Pos>(null);
  readonly compact = input(false);
  readonly extra = input<string>("", { alias: "pickerClass" });
  readonly changed = output<{ lat: number; lng: number }>();
  protected readonly here = currentPosition();
  protected readonly tiles = signal<{ url: string; attribution: string } | null>(null);
  protected readonly Crosshair = Crosshair;
  protected readonly Loader2 = Loader2;
  protected readonly LocateFixed = LocateFixed;
  protected readonly MapPinOff = MapPinOff;
  protected readonly cls = computed(() => cx("flex flex-col gap-2", this.extra()));
  protected readonly center = computed<[number, number] | undefined>(() => {
    const v = this.value();
    return v ? [v.lat, v.lng] : undefined;
  });
  protected readonly fitKey = computed(() => {
    const v = this.value();
    return v ? `${v.lat},${v.lng}` : undefined;
  });
  protected readonly markers = computed<MapMarker[]>(() => {
    const v = this.value();
    return v ? [{ id: "pin", lat: v.lat, lng: v.lng, kind: "pin", title: "Your delivery location" }] : [];
  });
  protected readonly set = (lat: number, lng: number) => this.changed.emit({ lat: round(lat), lng: round(lng) });

  constructor() {
    loadDeliveryOptions().then((o) => this.tiles.set({ url: o.map_tiles, attribution: o.map_attribution })).catch(() => this.tiles.set({ url: "", attribution: "" }));
  }
}
