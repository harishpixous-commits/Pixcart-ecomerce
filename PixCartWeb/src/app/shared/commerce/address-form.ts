/*
 * Add or edit a delivery address: an optional map pin for the exact door ("use my current location" or tap the map),
 * the address itself (the state fills in from the PIN code), a name for it (Home, Work or your own, like "Mom's
 * house"), and standing delivery instructions with quick choices. The pin and instructions reach the delivery partner.
 * Port of components/address-form.tsx: <pc-address-form [initial]="a" (saved)="..." (cancelled)="..." [cancellable]="true" />
 */

import { ChangeDetectionStrategy, Component, OnInit, booleanAttribute, input, output, signal } from "@angular/core";
import { Briefcase, ChevronDown, House, MapPin, Tag, type LucideIconData } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { STATE_OPTIONS } from "../../core/format";
import { stateForPin } from "../../core/pin-state";
import type { Address } from "../../core/types";
import { LocationPicker } from "../map/location-picker";
import { Icon } from "../ui/icon";
import { Button, ErrorNote, Field, Select, TextField, Textarea } from "../ui/ui";

type FormState = {
  full_name: string; phone: string; line1: string; line2: string; landmark: string; city: string;
  state_code: string; pincode: string; kind: "home" | "work" | "other"; is_default: boolean;
  label: string; instructions: string; lat: number | null; lng: number | null;
};
const EMPTY: FormState = {
  full_name: "", phone: "", line1: "", line2: "", landmark: "", city: "", state_code: "33", pincode: "", kind: "home", is_default: false,
  label: "", instructions: "", lat: null, lng: null,
};

const QUICK_NOTES = ["Leave at the door", "Call when you arrive", "Ring the bell", "Hand it to security", "Do not ring the bell"];

const KINDS: { key: FormState["kind"]; label: string; icon: LucideIconData }[] = [
  { key: "home", label: "Home", icon: House },
  { key: "work", label: "Work", icon: Briefcase },
  { key: "other", label: "Other", icon: Tag },
];

@Component({
  selector: "pc-address-form",
  imports: [Icon, Button, ErrorNote, Field, Select, TextField, Textarea, LocationPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="submit($event)" class="grid gap-3 sm:grid-cols-2" data-testid="address-form">
      <div class="sm:col-span-2"><pc-error-note [message]="error()" /></div>

      <div class="rounded-2xl bg-mist/70 p-3 ring-1 ring-line sm:col-span-2">
        <button type="button" (click)="mapOpen.set(!mapOpen())" [attr.aria-expanded]="mapOpen()" class="flex w-full items-center gap-3 text-left">
          <span [class]="pinned() ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-leaf text-white' : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-peacock-light text-peacock'"><svg [pcIcon]="MapPin" class="h-5 w-5" /></span>
          <span class="min-w-0 flex-1">
            <span class="block font-semibold">{{ pinned() ? "Location pinned on the map" : "Pin your location (recommended)" }}</span>
            <span class="block text-sm text-ink-soft">{{ pinned() ? "The delivery partner navigates straight to this spot." : "Helps the delivery partner reach your door without calls." }}</span>
          </span>
          <svg [pcIcon]="ChevronDown" [class]="mapOpen() ? 'h-5 w-5 shrink-0 text-ink-faint transition-transform rotate-180' : 'h-5 w-5 shrink-0 text-ink-faint transition-transform'" />
        </button>
        @if (mapOpen()) {
          <div class="mt-3">
            <pc-location-picker [compact]="true" [value]="pinned() ? { lat: f().lat!, lng: f().lng! } : null" (changed)="patch({ lat: $event.lat, lng: $event.lng })" />
            @if (pinned()) {
              <button type="button" (click)="patch({ lat: null, lng: null })" class="mt-1 text-xs font-semibold text-vermilion">Remove pin</button>
            }
          </div>
        }
      </div>

      <pc-text-field label="Full name" [value]="f().full_name" (valueChange)="patch({ full_name: $event })" [required]="true" autocomplete="name" [error]="fields().full_name" />
      <pc-text-field label="Mobile number" type="tel" [value]="f().phone" (valueChange)="patch({ phone: $event })" [required]="true" autocomplete="tel-national" [error]="fields().phone" />
      <pc-text-field class="sm:col-span-2" label="House no., building, street" [value]="f().line1" (valueChange)="patch({ line1: $event })" [required]="true" autocomplete="address-line1" [error]="fields().line1" />
      <pc-text-field class="sm:col-span-2" label="Area, locality (optional)" [value]="f().line2" (valueChange)="patch({ line2: $event })" autocomplete="address-line2" />
      <pc-text-field label="Landmark (optional)" [value]="f().landmark" (valueChange)="patch({ landmark: $event })" placeholder="Near the temple, opposite the park" />
      <pc-text-field label="PIN code" inputmode="numeric" [maxlength]="6" [value]="f().pincode" [filter]="pinFilter" (valueChange)="setPin($event)" [required]="true" autocomplete="postal-code" [error]="fields().pincode" />
      <pc-text-field label="Town or city" [value]="f().city" (valueChange)="patch({ city: $event })" [required]="true" autocomplete="address-level2" [error]="fields().city" />
      <pc-field label="State" for="addr-state">
        <select pcSelect id="addr-state" [value]="f().state_code" (change)="setState($event)" autocomplete="address-level1">
          @for (o of states; track o[0]) {<option [value]="o[0]" [selected]="o[0] === f().state_code">{{ o[1] }}</option>}
        </select>
      </pc-field>

      <fieldset class="flex flex-col gap-2 sm:col-span-2">
        <legend class="mb-1 text-sm font-medium text-ink">Save as</legend>
        <div class="flex flex-wrap gap-2">
          @for (k of kinds; track k.key) {
            <label [class]="f().kind === k.key ? 'inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-peacock bg-peacock text-white ring-peacock' : 'inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-peacock bg-white text-ink ring-line hover:ring-peacock/40'">
              <input type="radio" name="kind" class="sr-only" [checked]="f().kind === k.key" (change)="patch({ kind: k.key })" />
              <svg [pcIcon]="k.icon" class="h-4 w-4" /> {{ k.label }}
            </label>
          }
        </div>
        @if (f().kind === "other") {
          <pc-text-field label="Name this address" [value]="f().label" (valueChange)="patch({ label: $event })" [maxlength]="40" placeholder="e.g. Mom's house, Hostel" [error]="fields().label" />
        }
      </fieldset>

      <div class="flex flex-col gap-2 sm:col-span-2">
        <pc-field label="Delivery instructions (optional)" for="addr-notes" hint="Saved with this address and shown to the delivery partner.">
          <textarea pcTextarea id="addr-notes" [value]="f().instructions" (input)="patch({ instructions: $any($event.target).value })" maxlength="300" rows="2" class="min-h-[64px]" placeholder="e.g. Second floor, blue gate"></textarea>
        </pc-field>
        <div class="flex flex-wrap gap-1.5" aria-label="Quick instructions">
          @for (n of notes; track n) {
            <button type="button" (click)="addNote(n)" class="rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink-soft ring-1 ring-line hover:text-peacock hover:ring-peacock/40">+ {{ n }}</button>
          }
        </div>
      </div>

      <label class="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="f().is_default" (change)="patch({ is_default: $any($event.target).checked })" /> Make this my default address
      </label>
      <div class="flex gap-2 sm:col-span-2">
        <button pcButton type="submit" [loading]="busy()">Save address</button>
        @if (cancellable()) {<button pcButton type="button" variant="ghost" (click)="cancelled.emit()">Cancel</button>}
      </div>
    </form>
  `,
})
export class AddressForm implements OnInit {
  readonly initial = input<Address | undefined>(undefined);
  /** shows Cancel (the reference's onCancel prop) */
  readonly cancellable = input(false, { transform: booleanAttribute });
  readonly saved = output<Address>();
  readonly cancelled = output<void>();
  protected readonly f = signal<FormState>(EMPTY);
  // the state follows the PIN code until the person picks one themselves
  private stateTouched = false;
  protected readonly mapOpen = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fields = signal<Record<string, string>>({});
  protected readonly states = STATE_OPTIONS;
  protected readonly kinds = KINDS;
  protected readonly notes = QUICK_NOTES;
  protected readonly MapPin = MapPin;
  protected readonly ChevronDown = ChevronDown;
  protected readonly pinFilter = (v: string) => v.replace(/\D/g, "").slice(0, 6);
  protected readonly pinned = () => this.f().lat !== null && this.f().lng !== null;

  ngOnInit(): void {
    const a = this.initial();
    this.stateTouched = !!a;
    this.mapOpen.set(!a || a.lat == null);
    if (a) {
      const { full_name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default } = a;
      this.f.set({ full_name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default, label: a.label ?? "", instructions: a.instructions ?? "", lat: a.lat ?? null, lng: a.lng ?? null });
    }
  }

  protected patch(p: Partial<FormState>): void {
    this.f.update((cur) => ({ ...cur, ...p }));
  }

  protected setPin(value: string): void {
    const pin = value.replace(/\D/g, "").slice(0, 6);
    const st = stateForPin(pin);
    this.f.update((cur) => ({ ...cur, pincode: pin, state_code: !this.stateTouched && st ? st : cur.state_code }));
  }

  protected setState(e: Event): void {
    this.stateTouched = true;
    this.patch({ state_code: (e.target as HTMLSelectElement).value });
  }

  protected addNote(text: string): void {
    this.f.update((cur) => {
      const has = cur.instructions.toLowerCase().includes(text.toLowerCase());
      if (has) return cur;
      const joined = cur.instructions.trim() ? `${cur.instructions.trim().replace(/[.,;]$/, "")}. ${text}` : text;
      return { ...cur, instructions: joined.slice(0, 300) };
    });
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    const f = this.f();
    const initial = this.initial();
    this.busy.set(true);
    this.error.set(null);
    this.fields.set({});
    try {
      const body = {
        full_name: f.full_name, phone: f.phone, line1: f.line1, line2: f.line2, landmark: f.landmark, city: f.city, state_code: f.state_code, pincode: f.pincode,
        kind: f.kind, is_default: f.is_default, label: f.kind === "other" ? f.label.trim() : "", instructions: f.instructions.trim(),
        lat: f.lat, lng: f.lng,
      };
      const saved = initial
        ? await api<Address>(`/api/addresses/${initial.id}`, { method: "PUT", body })
        : await api<Address>("/api/addresses", { method: "POST", body });
      this.saved.emit(saved);
    } catch (err) {
      if (err instanceof ApiError) {
        this.error.set(err.message);
        this.fields.set(err.fields);
      } else this.error.set("Could not save the address. Try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
