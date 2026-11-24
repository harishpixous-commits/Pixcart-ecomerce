/* Delivery address at checkout: the chosen address, a list to switch to another one, and the form to add one. Port of components/checkout/address.tsx. */

import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input, output, signal } from "@angular/core";
import { Briefcase, Check, Crosshair, House, LocateFixed, MapPin, Plus } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import type { Address } from "../../core/types";
import { AddressForm } from "../../shared/commerce/address-form";
import { LocationPicker, currentPosition } from "../../shared/map/location-picker";
import { Icon } from "../../shared/ui/icon";
import { Button, Modal, Toast } from "../../shared/ui/ui";
import { CARD, CardHeading } from "./card";

const KIND_LABEL: Record<Address["kind"], string> = { home: "Home", work: "Work", other: "Other" };

export function addressName(a: Address): string {
  return a.label?.trim() || KIND_LABEL[a.kind] || "Address";
}

export function addressLine(a: Address): string {
  return `${[a.line1, a.line2, a.landmark, a.city].filter(Boolean).join(", ")}, ${a.state} ${a.pincode}`;
}

@Component({
  selector: "span[pcAddressText]",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block min-w-0" },
  template: `
    <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span class="inline-flex items-center gap-1 rounded-md bg-peacock-light px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-peacock"><svg [pcIcon]="kindIcon()" class="h-3.5 w-3.5" />{{ name() }}</span>
      @if (a().is_default) {<span class="text-xs font-semibold text-ink-faint">Default</span>}
    </span>
    <span class="mt-1.5 block font-semibold text-ink">{{ a().full_name }} <span class="font-normal text-ink-soft">· {{ a().phone }}</span></span>
    <span class="block text-sm leading-snug text-ink-soft" translate="no">{{ line() }}</span>
  `,
})
export class AddressText {
  readonly a = input.required<Address>({ alias: "pcAddressText" });
  protected readonly name = computed(() => addressName(this.a()));
  protected readonly line = computed(() => addressLine(this.a()));
  protected readonly kindIcon = computed(() => (this.a().kind === "home" ? House : this.a().kind === "work" ? Briefcase : MapPin));
}

/**
 * "Pin your exact location" for the chosen address: one tap asks the browser for the location (the person's own
 * tap, so the permission prompt is expected) and saves it, or pick the spot on the map. Pinned addresses show a
 * short confirmation with "Adjust".
 */
@Component({
  selector: "pc-pin-prompt",
  imports: [Icon, Button, Modal, LocationPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (pinned()) {
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-ink-soft" data-testid="checkout-pinned">
        <svg [pcIcon]="LocateFixed" class="h-4 w-4 text-leaf" />
        <span>Location pinned on the map</span>
        <button type="button" (click)="open.set(true)" class="font-semibold text-peacock hover:underline">Adjust</button>
      </p>
    } @else {
      <div class="flex flex-col gap-2 rounded-xl border border-dashed border-peacock/40 bg-peacock-light/30 p-3 sm:flex-row sm:items-center" data-testid="checkout-pin-prompt">
        <span class="flex min-w-0 flex-1 items-start gap-2.5">
          <svg [pcIcon]="MapPin" class="mt-0.5 h-5 w-5 shrink-0 text-peacock" />
          <span class="text-sm">
            <span class="block font-semibold text-ink">Pin your exact location</span>
            <span class="text-ink-soft">{{ here.status() === "denied" ? "Location is blocked for this site. Allow it in your browser settings, or pick the spot on the map." : "Helps the delivery partner reach your door without calling you." }}</span>
          </span>
        </span>
        <span class="flex shrink-0 gap-2">
          @if (here.status() !== "denied" && here.status() !== "unsupported") {
            <button pcButton size="sm" [loading]="here.status() === 'asking' || busy()" (click)="useHere()"><svg [pcIcon]="Crosshair" class="h-4 w-4" /> Use my location</button>
          }
          <button pcButton size="sm" variant="secondary" (click)="open.set(true)">Pick on map</button>
        </span>
      </div>
    }
    <pc-modal [open]="open()" (close)="open.set(false)" title="Pin your delivery location" [wide]="true">
      <div class="flex flex-col gap-3">
        <p class="text-sm text-ink-soft" translate="no">{{ line() }}</p>
        @if (open()) {<pc-location-picker [value]="pin()" (changed)="pin.set($event)" />}
        <button pcButton class="self-start" [disabled]="!pin()" [loading]="busy()" (click)="pin() && save(pin()!)">Save this location</button>
      </div>
    </pc-modal>
  `,
})
export class PinPrompt {
  readonly address = input.required<Address>();
  readonly saved = output<Address>();
  private readonly toast = inject(Toast);
  protected readonly here = currentPosition();
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly pin = signal<{ lat: number; lng: number } | null>(null);
  protected readonly pinned = computed(() => this.address().lat != null && this.address().lng != null);
  protected readonly line = computed(() => addressLine(this.address()));
  protected readonly LocateFixed = LocateFixed;
  protected readonly MapPin = MapPin;
  protected readonly Crosshair = Crosshair;

  ngOnInit(): void {
    const a = this.address();
    this.pin.set(a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null);
  }

  protected useHere(): void {
    this.here.locate((lat, lng) => this.save({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }));
  }

  protected async save(p: { lat: number; lng: number }): Promise<void> {
    this.busy.set(true);
    try {
      const a = await api<Address>(`/api/addresses/${this.address().id}/location`, { method: "PATCH", body: p });
      this.toast.show("Location pinned. Your delivery partner will navigate straight to it.");
      this.open.set(false);
      this.saved.emit(a);
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not save the location", "error");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-address-section",
  imports: [Icon, CardHeading, AddressForm, AddressText, PinPrompt],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section aria-labelledby="co-address-h" data-testid="checkout-address" [class]="CARD">
      <div pcCardHeading headingId="co-address-h" [icon]="MapPin" title="Delivery address" [sub]="adding() ? 'Where should we deliver this order?' : undefined" [hasAction]="!adding() && !!selected()">
        <button action type="button" (click)="picking.set(!picking())" [attr.aria-expanded]="picking()" aria-controls="co-address-list"
          class="rounded-lg px-2.5 py-1.5 text-sm font-bold uppercase tracking-wide text-peacock hover:bg-peacock-light">{{ picking() ? "Done" : "Change" }}</button>
      </div>

      @if (adding()) {
        <pc-address-form [cancellable]="cancellable()" (saved)="saved.emit($event)" (cancelled)="cancelAdd.emit()" />
      } @else if (showList()) {
        <fieldset id="co-address-list">
          <legend class="sr-only">Choose a delivery address</legend>
          <div class="flex flex-col gap-2">
            @for (a of addresses(); track a.id) {
              <label [class]="a.id === selectedId() ? 'flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-peacock has-[:focus-visible]:ring-offset-1 border-peacock bg-peacock-light/40' : 'flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-peacock has-[:focus-visible]:ring-offset-1 border-line hover:border-peacock/40'">
                <input type="radio" name="address" class="sr-only" [checked]="a.id === selectedId()" (change)="select.emit(a.id)" />
                <span aria-hidden="true" [class]="a.id === selectedId() ? 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-peacock bg-peacock text-white' : 'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-line bg-white'">
                  @if (a.id === selectedId()) {<svg [pcIcon]="Check" class="h-3 w-3" [strokeWidth]="3.5" />}
                </span>
                <span [pcAddressText]="a"></span>
              </label>
            }
          </div>
          <button type="button" (click)="picking.set(false); add.emit()"
            class="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-peacock/40 py-2.5 font-semibold text-peacock hover:bg-peacock-light/50">
            <svg [pcIcon]="Plus" class="h-4 w-4" /> Add a new address
          </button>
        </fieldset>
      } @else if (selected(); as s) {
        <div class="flex flex-col gap-2">
          <div class="rounded-xl bg-mist/70 p-3 ring-1 ring-inset ring-line/70" data-testid="checkout-address-chosen"><span [pcAddressText]="s"></span></div>
          @for (x of [s]; track x.id) {<pc-pin-prompt [address]="x" (saved)="saved.emit($event)" />}
        </div>
      }
    </section>
  `,
})
export class AddressSection {
  readonly addresses = input.required<Address[]>();
  readonly selectedId = input<string | null>(null);
  readonly adding = input(false);
  readonly cancellable = input(false, { transform: booleanAttribute });
  readonly select = output<string>();
  readonly add = output<void>();
  readonly cancelAdd = output<void>();
  readonly saved = output<Address>();
  protected readonly picking = signal(false);
  protected readonly selected = computed(() => this.addresses().find((a) => a.id === this.selectedId()) ?? null);
  protected readonly showList = computed(() => !this.adding() && (this.picking() || !this.selected()));
  protected readonly CARD = CARD;
  protected readonly MapPin = MapPin;
  protected readonly Check = Check;
  protected readonly Plus = Plus;
}
