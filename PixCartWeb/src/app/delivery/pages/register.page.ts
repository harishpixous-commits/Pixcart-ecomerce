/*
 * Delivery partner registration: start (name and city) → about you and photo → vehicle → documents → payouts →
 * review and submit. Each step saves as the partner goes, so they can stop and continue later on any device.
 * Port of frontend/src/app/delivery/register/page.tsx (Start, Wizard, About, Vehicle, Documents, Payouts, Review,
 * UnderReview).
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from "@angular/core";
import {
  ArrowLeft, ArrowRight, BadgeCheck, Bike, Car, Check, CircleAlert, FileText, Hourglass, Landmark, PartyPopper, Truck, UserRound, Zap, type LucideIconData,
} from "lucide-angular";
import { ApiError, api } from "../../core/api";
import type { DeliveryOptions, IdProof, Partner, VehicleType } from "../../core/delivery-types";
import { date } from "../../core/format";
import { SessionService } from "../../core/session";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, Field, Input, Select, TextField, Textarea } from "../../shared/ui/ui";
import { PartnerGetTheApp } from "../components/install";
import { PartnerService, deliveryOptions } from "../components/partner";
import { UploadTile } from "../components/upload-tile";
import { FullLoader } from "../shell/delivery-app";

const STEPS = [
  { key: "about", title: "About you", icon: UserRound },
  { key: "vehicle", title: "Vehicle", icon: Bike },
  { key: "documents", title: "Documents", icon: FileText },
  { key: "payouts", title: "Payouts", icon: Landmark },
  { key: "review", title: "Submit", icon: BadgeCheck },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

const VEHICLE_ICON: Record<VehicleType, LucideIconData> = { bike: Bike, scooter: Bike, ev: Zap, cycle: Bike, auto: Car, van: Truck };

function firstOpenStep(p: Partner): StepKey {
  const open = new Set(p.checklist.filter((i) => !i.done).map((i) => i.key));
  if (open.has("profile") || open.has("photo")) return "about";
  if (open.has("vehicle") || open.has("vehicle_rc")) return "vehicle";
  if (open.has("license") || open.has("id_proof")) return "documents";
  if (open.has("bank")) return "payouts";
  return "review";
}

const digits = (v: string) => v.replace(/\D/g, "");
const upper = (v: string) => v.toUpperCase();
const trimmed = (v: string) => v.trim();

/** useSave(): busy, error and save(path, body) → onSaved(partner) */
class Saver {
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  constructor(private readonly onSaved: (p: Partner) => void) {}
  async save(path: string, body: unknown): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.onSaved(await api<Partner>(path, { method: "PUT", body }));
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save. Check your connection and try again.");
    } finally {
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- step title */

@Component({
  selector: "pc-step-title",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "mb-5 block" },
  template: `<h2 class="text-xl font-semibold">{{ title() }}</h2><p class="text-ink-soft">{{ sub() }}</p>`,
})
export class StepTitle {
  readonly title = input.required<string>();
  readonly sub = input.required<string>();
}

/* ---------------------------------------------------------------- start */

@Component({
  selector: "pc-register-start",
  imports: [Icon, Button, ErrorNote, Field, Input, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!options().registration_open || !options().enabled) {
      <div class="mx-auto mt-8 max-w-md rounded-2xl bg-white p-6 text-center shadow-sm">
        <p class="font-display text-xl font-semibold">Registrations are closed</p>
        <p class="mt-1 text-ink-soft">We are not adding new delivery partners right now. Please check again soon.</p>
      </div>
    } @else {
      <div class="mx-auto mt-4 max-w-md">
        <div class="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-black/5">
          <div class="bg-gradient-to-br from-peacock to-peacock-dark p-6 text-white">
            <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15"><svg [pcIcon]="Bike" class="h-7 w-7" /></span>
            <h1 class="mt-3 text-2xl font-bold">Become a delivery partner</h1>
            <p class="text-white/80">5 short steps. You can stop and continue later.</p>
          </div>
          <form (submit)="start($event)" class="flex flex-col gap-4 p-6" data-testid="register-start">
            <pc-error-note [message]="error()" />
            <pc-text-field label="Your full name (as on your ID)" autocomplete="name" [(value)]="name" [required]="true" [minlength]="2" [maxlength]="120" />
            <pc-field label="City you want to deliver in">
              @if (cities().length) {
                <select pcSelect [value]="city()" (change)="city.set($any($event.target).value)">
                  @for (c of cities(); track c) {<option [value]="c" [selected]="c === city()">{{ c }}</option>}
                </select>
              } @else {
                <input pcInput [value]="city()" (input)="city.set($any($event.target).value)" required minlength="2" />
              }
            </pc-field>
            <button pcButton type="submit" size="lg" [loading]="busy()" class="rounded-xl">Start registration <svg [pcIcon]="ArrowRight" class="h-5 w-5" /></button>
          </form>
        </div>
      </div>
    }
  `,
})
export class RegisterStart implements OnInit {
  readonly options = input.required<DeliveryOptions>();
  private readonly session = inject(SessionService);
  private readonly partners = inject(PartnerService);
  protected readonly name = signal("");
  protected readonly city = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly cities = computed(() => Array.from(new Set(this.options().zones.map((z) => z.city))));
  protected readonly Bike = Bike;
  protected readonly ArrowRight = ArrowRight;

  ngOnInit(): void {
    this.name.set(this.session.user()?.name ?? "");
    this.city.set(this.options().zones[0]?.city ?? "");
  }

  protected async start(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      this.partners.set(await api<Partner>("/api/delivery/register", { method: "POST", body: { name: this.name(), city: this.city() } }));
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not start your registration");
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- steps */

@Component({
  selector: "pc-register-about",
  imports: [Icon, Button, ErrorNote, Field, Input, Select, TextField, Textarea, UploadTile, StepTitle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="submit($event)" class="flex flex-col gap-4">
      <pc-step-title title="About you" sub="Your photo and name are shown to customers when you deliver to them." />
      <pc-error-note [message]="s.error()" />
      <pc-upload-tile kind="photo" label="Your photo" hint="A clear selfie, face visible, no sunglasses" [done]="!!partner().photo" [preview]="partner().photo || undefined" (uploaded)="partners.set($event)" />
      <div class="grid gap-4 sm:grid-cols-2">
        <pc-text-field label="Full name (as on your ID)" [(value)]="name" [required]="true" [minlength]="2" />
        <pc-field label="City">
          <input pcInput [value]="city()" (input)="city.set($any($event.target).value); zone.set('')" required minlength="2" list="partner-cities" />
        </pc-field>
        <datalist id="partner-cities">@for (c of allCities(); track c) {<option [value]="c"></option>}</datalist>
      </div>
      @if (zones().length > 0) {
        <pc-field label="Area you prefer (the team confirms it)">
          <select pcSelect [value]="zone()" (change)="zone.set($any($event.target).value)">
            <option value="" [selected]="zone() === ''">Any area in {{ city() || "my city" }}</option>
            @for (z of zones(); track z.id) {<option [value]="z.id" [selected]="z.id === zone()">{{ z.name }}</option>}
          </select>
        </pc-field>
      }
      <pc-field label="Home address">
        <textarea pcTextarea rows="3" [value]="address()" (input)="address.set($any($event.target).value)" required minlength="10" maxlength="500" placeholder="House number, street, area, PIN code"></textarea>
      </pc-field>
      <button pcButton type="submit" size="lg" [loading]="s.busy()" class="rounded-xl sm:self-end">Save and continue <svg [pcIcon]="ArrowRight" class="h-5 w-5" /></button>
    </form>
  `,
})
export class RegisterAbout implements OnInit {
  readonly partner = input.required<Partner>();
  readonly options = input.required<DeliveryOptions>();
  readonly saved = output<Partner>();
  protected readonly partners = inject(PartnerService);
  protected readonly s = new Saver((p) => this.saved.emit(p));
  protected readonly name = signal("");
  protected readonly city = signal("");
  protected readonly address = signal("");
  protected readonly zone = signal("");
  protected readonly allCities = computed(() => Array.from(new Set(this.options().zones.map((z) => z.city))));
  protected readonly zones = computed(() => {
    const city = this.city();
    return this.options().zones.filter((z) => !city || z.city.toLowerCase() === city.toLowerCase());
  });
  protected readonly ArrowRight = ArrowRight;

  ngOnInit(): void {
    const p = this.partner();
    this.name.set(p.name);
    this.city.set(p.city);
    this.address.set(p.address);
    this.zone.set(p.zone?.id ?? "");
  }

  protected submit(e: Event): void {
    e.preventDefault();
    if (!this.partner().photo) {
      this.s.error.set("Add your photo. Customers see it when you deliver.");
      return;
    }
    void this.s.save("/api/delivery/me", { name: this.name(), city: this.city(), address: this.address(), ...(this.zone() ? { zone_id: this.zone() } : {}) });
  }
}

@Component({
  selector: "pc-register-vehicle",
  imports: [Icon, Button, ErrorNote, TextField, UploadTile, StepTitle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="submit($event)" class="flex flex-col gap-4">
      <pc-step-title title="Your vehicle" sub="Requests are matched to what you ride." />
      <pc-error-note [message]="s.error()" />
      <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="Vehicle type">
        @for (v of vehicles(); track v[0]) {
          <button type="button" role="radio" [attr.aria-checked]="type() === v[0]" (click)="type.set(v[0])"
            [class]="type() === v[0] ? 'flex flex-col items-center gap-2 rounded-2xl border-2 p-4 text-center font-semibold transition-all border-peacock bg-peacock-light/50 text-peacock shadow-sm' : 'flex flex-col items-center gap-2 rounded-2xl border-2 p-4 text-center font-semibold transition-all border-line hover:border-peacock/40'">
            <svg [pcIcon]="icon(v[0])" class="h-7 w-7" />
            <span class="text-sm">{{ v[1] }}</span>
          </button>
        }
      </div>
      @if (!cycle()) {
        <pc-text-field label="Vehicle number" [(value)]="no" [filter]="upper" [required]="true" placeholder="TN 38 AB 1234" hint="As on the number plate" class="[&_input]:uppercase" />
        <pc-upload-tile kind="vehicle_rc" [label]="'Registration certificate (RC)' + (options().require_vehicle_doc ? '' : ' (optional)')" [done]="partner().docs.vehicle_rc" (uploaded)="partners.set($event)" />
      }
      <button pcButton type="submit" size="lg" [loading]="s.busy()" class="rounded-xl sm:self-end">Save and continue <svg [pcIcon]="ArrowRight" class="h-5 w-5" /></button>
    </form>
  `,
})
export class RegisterVehicle implements OnInit {
  readonly partner = input.required<Partner>();
  readonly options = input.required<DeliveryOptions>();
  readonly saved = output<Partner>();
  protected readonly partners = inject(PartnerService);
  protected readonly s = new Saver((p) => this.saved.emit(p));
  protected readonly type = signal<VehicleType>("bike");
  protected readonly no = signal("");
  protected readonly cycle = computed(() => this.type() === "cycle");
  protected readonly vehicles = computed(() => Object.entries(this.options().vehicles) as [VehicleType, string][]);
  protected readonly upper = upper;
  protected readonly ArrowRight = ArrowRight;
  protected icon(k: VehicleType): LucideIconData {
    return VEHICLE_ICON[k];
  }

  ngOnInit(): void {
    this.type.set(this.partner().vehicle_type);
    this.no.set(this.partner().vehicle_no);
  }

  protected submit(e: Event): void {
    e.preventDefault();
    if (this.options().require_vehicle_doc && !this.cycle() && !this.partner().docs.vehicle_rc) {
      this.s.error.set("Upload your vehicle registration (RC)");
      return;
    }
    void this.s.save("/api/delivery/me", { vehicle_type: this.type(), vehicle_no: this.cycle() ? "" : this.no() });
  }
}

@Component({
  selector: "pc-register-documents",
  imports: [Icon, Button, ErrorNote, TextField, UploadTile, StepTitle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="submit($event)" class="flex flex-col gap-5">
      <pc-step-title title="Documents" sub="Only the verification team sees these. Keep the photos sharp and readable." />
      <pc-error-note [message]="s.error()" />
      @if (cycle()) {
        <p class="rounded-xl bg-mist px-4 py-3 text-sm text-ink-soft">You ride a bicycle, so no driving licence is needed.</p>
      } @else {
        <div class="flex flex-col gap-3 rounded-2xl bg-mist/60 p-4">
          <p class="font-semibold">Driving licence</p>
          <pc-text-field label="Licence number" [(value)]="license" [filter]="upper" [required]="true" placeholder="TN38 20190012345" />
          <pc-upload-tile kind="license" label="Licence photo (front)" [done]="partner().docs.license" (uploaded)="partners.set($event)" />
        </div>
      }
      <div class="flex flex-col gap-3 rounded-2xl bg-mist/60 p-4">
        <p class="font-semibold">ID proof</p>
        <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="ID type">
          @for (k of idProofs(); track k[0]) {
            <button type="button" role="radio" [attr.aria-checked]="idType() === k[0]" (click)="idType.set(k[0]); idNo.set('')"
              [class]="idType() === k[0] ? 'rounded-full px-4 py-1.5 text-sm font-semibold ring-1 bg-peacock text-white ring-peacock' : 'rounded-full px-4 py-1.5 text-sm font-semibold ring-1 bg-white ring-line hover:ring-peacock/50'">
              {{ k[1] }}
            </button>
          }
        </div>
        <pc-text-field [label]="options().id_proofs[idType()] + ' number'" [(value)]="idNo" [placeholder]="haveId() ? 'Saved: ending ' + partner().id_proof_last4 : ''"
          [hint]="idType() === 'aadhaar' ? 'We keep only the last 4 digits of your Aadhaar.' : 'Stored encrypted.'" [inputmode]="idType() === 'aadhaar' ? 'numeric' : 'text'" />
        <pc-upload-tile kind="id_proof" [label]="options().id_proofs[idType()] + ' photo'" [done]="partner().docs.id_proof" (uploaded)="partners.set($event)" />
      </div>
      <button pcButton type="submit" size="lg" [loading]="s.busy()" class="rounded-xl sm:self-end">Save and continue <svg [pcIcon]="ArrowRight" class="h-5 w-5" /></button>
    </form>
  `,
})
export class RegisterDocuments implements OnInit {
  readonly partner = input.required<Partner>();
  readonly options = input.required<DeliveryOptions>();
  readonly saved = output<Partner>();
  protected readonly partners = inject(PartnerService);
  protected readonly s = new Saver((p) => this.saved.emit(p));
  protected readonly license = signal("");
  protected readonly idType = signal<IdProof>("aadhaar");
  protected readonly idNo = signal("");
  protected readonly cycle = computed(() => this.partner().vehicle_type === "cycle");
  protected readonly haveId = computed(() => !!this.partner().id_proof_last4 && this.partner().id_proof_type === this.idType());
  protected readonly idProofs = computed(() => Object.entries(this.options().id_proofs) as [IdProof, string][]);
  protected readonly upper = upper;
  protected readonly ArrowRight = ArrowRight;

  ngOnInit(): void {
    this.license.set(this.partner().license_no);
    this.idType.set(this.partner().id_proof_type || "aadhaar");
  }

  protected submit(e: Event): void {
    e.preventDefault();
    const p = this.partner();
    if (!this.cycle() && !p.docs.license) return void this.s.error.set("Upload a photo of your driving licence");
    if (!p.docs.id_proof) return void this.s.error.set("Upload a photo of your ID proof");
    if (!this.idNo() && !this.haveId()) return void this.s.error.set("Enter your ID number");
    void this.s.save("/api/delivery/me", { ...(this.cycle() ? {} : { license_no: this.license() }), id_proof_type: this.idType(), ...(this.idNo() ? { id_proof_no: this.idNo() } : {}) });
  }
}

@Component({
  selector: "pc-register-payouts",
  imports: [Icon, Button, ErrorNote, TextField, StepTitle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="submit($event)" class="flex flex-col gap-4">
      <pc-step-title title="Where should we pay you?" sub="Your earnings are paid every week to this account." />
      <pc-error-note [message]="s.error()" />
      @if (partner().bank.set) {
        <p class="flex items-center gap-2 rounded-xl bg-leaf-light px-4 py-3 text-sm text-leaf">
          <svg [pcIcon]="Check" class="h-4 w-4" /> Saved: {{ partner().bank.account_last4 ? "account ending " + partner().bank.account_last4 + " (" + partner().bank.ifsc + ")" : partner().bank.upi }}
        </p>
      }
      <div class="grid grid-cols-2 gap-1 rounded-xl bg-mist p-1" role="tablist">
        @for (m of modes; track m) {
          <button type="button" role="tab" [attr.aria-selected]="mode() === m" (click)="mode.set(m)" [class]="mode() === m ? 'rounded-lg py-2 font-semibold bg-white shadow-sm' : 'rounded-lg py-2 font-semibold text-ink-soft'">
            {{ m === "bank" ? "Bank account" : "UPI ID" }}
          </button>
        }
      </div>
      <pc-text-field label="Account holder name" [(value)]="holder" [required]="true" [minlength]="3" />
      @if (mode() === "bank") {
        <div class="grid gap-4 sm:grid-cols-2">
          <pc-text-field label="Account number" inputmode="numeric" [(value)]="account" [filter]="digits" [required]="!partner().bank.set" [placeholder]="partner().bank.set ? 'Leave empty to keep' : ''" />
          <pc-text-field label="Re-enter account number" inputmode="numeric" [(value)]="confirm" [filter]="digits" [required]="!!account()" />
          <pc-text-field label="IFSC" [(value)]="ifsc" [filter]="upper" [required]="!!account()" placeholder="SBIN0001234" [maxlength]="11" />
        </div>
      } @else {
        <pc-text-field label="UPI ID" [(value)]="upi" [filter]="trimmed" [required]="true" placeholder="name@okaxis" />
      }
      <button pcButton type="submit" size="lg" [loading]="s.busy()" class="rounded-xl sm:self-end">Save and continue <svg [pcIcon]="ArrowRight" class="h-5 w-5" /></button>
    </form>
  `,
})
export class RegisterPayouts implements OnInit {
  readonly partner = input.required<Partner>();
  readonly saved = output<Partner>();
  protected readonly s = new Saver((p) => this.saved.emit(p));
  protected readonly modes = ["bank", "upi"] as const;
  protected readonly mode = signal<"bank" | "upi">("bank");
  protected readonly holder = signal("");
  protected readonly account = signal("");
  protected readonly confirm = signal("");
  protected readonly ifsc = signal("");
  protected readonly upi = signal("");
  protected readonly digits = digits;
  protected readonly upper = upper;
  protected readonly trimmed = trimmed;
  protected readonly Check = Check;
  protected readonly ArrowRight = ArrowRight;

  ngOnInit(): void {
    const p = this.partner();
    this.mode.set(p.bank.upi && !p.bank.account_last4 ? "upi" : "bank");
    this.holder.set(p.bank.holder || p.name);
    this.ifsc.set(p.bank.ifsc);
    this.upi.set(p.bank.upi);
  }

  protected submit(e: Event): void {
    e.preventDefault();
    const p = this.partner();
    if (p.bank.set && !this.account() && this.mode() === "bank" && this.upi() === p.bank.upi) return void this.saved.emit(p); // nothing changed
    void this.s.save("/api/delivery/me/bank", this.mode() === "bank"
      ? { holder: this.holder(), account_number: this.account(), confirm_account_number: this.confirm(), ifsc: this.ifsc() }
      : { holder: this.holder(), upi: this.upi() });
  }
}

const STEP_FOR: Record<string, StepKey> = { profile: "about", photo: "about", vehicle: "vehicle", vehicle_rc: "vehicle", license: "documents", id_proof: "documents", bank: "payouts" };

@Component({
  selector: "pc-register-review",
  imports: [Icon, Button, ErrorNote, StepTitle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4" },
  template: `
    <pc-step-title title="Check and submit" sub="Make sure everything is right. The team reviews your registration, usually within a day." />
    <pc-error-note [message]="error()" />
    <ul class="flex flex-col divide-y divide-line rounded-2xl ring-1 ring-line" data-testid="register-checklist">
      @for (i of partner().checklist; track i.key) {
        <li class="flex items-center gap-3 px-4 py-3">
          <span [class]="i.done ? 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-leaf text-white' : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-vermilion-light text-vermilion'">
            <svg [pcIcon]="i.done ? Check : CircleAlert" class="h-4 w-4" />
          </span>
          <span class="flex-1">{{ i.label }}</span>
          @if (!i.done) {<button type="button" (click)="go.emit(stepFor[i.key] ?? 'about')" class="text-sm font-semibold text-peacock">Add</button>}
        </li>
      }
    </ul>
    <label class="flex items-start gap-3 rounded-xl bg-mist p-3 text-sm">
      <input type="checkbox" class="mt-0.5 h-5 w-5 accent-peacock" [checked]="agree()" (change)="agree.set($any($event.target).checked)" />
      <span>I confirm these details and documents are mine and correct. I agree to the delivery partner terms, including handing over cash collected on delivery.</span>
    </label>
    <button pcButton size="lg" class="rounded-xl" (click)="submit()" [loading]="busy()" [disabled]="!partner().can_submit || !agree()" data-testid="register-submit">
      Submit for review
    </button>
  `,
})
export class RegisterReview {
  readonly partner = input.required<Partner>();
  readonly go = output<StepKey>();
  private readonly partners = inject(PartnerService);
  protected readonly agree = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly stepFor = STEP_FOR;
  protected readonly Check = Check;
  protected readonly CircleAlert = CircleAlert;

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.partners.set(await api<Partner>("/api/delivery/me/submit", { method: "POST" }));
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not submit");
      this.busy.set(false);
    }
  }
}

/* ---------------------------------------------------------------- wizard */

@Component({
  selector: "pc-register-wizard",
  imports: [Icon, RegisterAbout, RegisterVehicle, RegisterDocuments, RegisterPayouts, RegisterReview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4 pt-2" },
  template: `
    <div>
      <p class="text-sm font-semibold text-peacock">Delivery partner registration</p>
      <h1 class="text-2xl font-bold sm:text-3xl">Hi {{ partner().name.split(" ")[0] }}, let's get you on the road</h1>
    </div>
    @if (partner().kyc_status === "rejected") {
      <div class="flex gap-3 rounded-2xl bg-vermilion-light p-4 text-vermilion" role="alert">
        <svg [pcIcon]="CircleAlert" class="mt-0.5 h-5 w-5 shrink-0" />
        <div><p class="font-semibold">Please fix your registration</p><p class="text-ink">{{ partner().kyc_note || "Some details could not be verified." }}</p></div>
      </div>
    }
    <!-- progress -->
    <ol class="grid grid-cols-5 gap-1.5" aria-label="Registration steps">
      @for (s of rows(); track s.key) {
        <li>
          <button type="button" (click)="go(s.key)" [attr.aria-current]="s.current ? 'step' : null" class="flex w-full flex-col items-center gap-1.5 text-center">
            <span [class]="s.bar"></span>
            <span [class]="s.dot"><svg [pcIcon]="s.complete && !s.current ? Check : s.icon" class="h-4 w-4" /></span>
            <span [class]="s.current ? 'hidden text-xs font-semibold sm:block text-peacock' : 'hidden text-xs font-semibold sm:block text-ink-soft'">{{ s.title }}</span>
          </button>
        </li>
      }
    </ol>
    <section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-7" [attr.data-testid]="'step-' + step()">
      @switch (step()) {
        @case ("about") {<pc-register-about [partner]="partner()" [options]="options()" (saved)="saved($event)" />}
        @case ("vehicle") {<pc-register-vehicle [partner]="partner()" [options]="options()" (saved)="saved($event)" />}
        @case ("documents") {<pc-register-documents [partner]="partner()" [options]="options()" (saved)="saved($event)" />}
        @case ("payouts") {<pc-register-payouts [partner]="partner()" (saved)="saved($event)" />}
        @case ("review") {<pc-register-review [partner]="partner()" (go)="go($event)" />}
      }
    </section>
    @if (index() > 0 && step() !== "review") {
      <button type="button" (click)="go(steps[index() - 1].key)" class="flex items-center gap-1.5 self-start text-sm font-semibold text-ink-soft hover:text-peacock">
        <svg [pcIcon]="ArrowLeft" class="h-4 w-4" /> Back to {{ steps[index() - 1].title.toLowerCase() }}
      </button>
    }
  `,
})
export class RegisterWizard implements OnInit {
  readonly partner = input.required<Partner>();
  readonly options = input.required<DeliveryOptions>();
  private readonly partners = inject(PartnerService);
  protected readonly step = signal<StepKey>("about");
  protected readonly steps = STEPS;
  protected readonly index = computed(() => STEPS.findIndex((s) => s.key === this.step()));
  protected readonly Check = Check;
  protected readonly CircleAlert = CircleAlert;
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly rows = computed(() => {
    const p = this.partner();
    const step = this.step();
    const index = this.index();
    const done = (key: string) => p.checklist.filter((i) => key.split(",").includes(i.key)).every((i) => i.done);
    const stepDone: Record<StepKey, boolean> = {
      about: done("profile,photo"), vehicle: done("vehicle,vehicle_rc"), documents: done("license,id_proof"), payouts: done("bank"), review: false,
    };
    return STEPS.map((s, i) => {
      const current = s.key === step;
      const complete = stepDone[s.key];
      return {
        key: s.key as StepKey,
        title: s.title,
        icon: s.icon as LucideIconData,
        current,
        complete,
        bar: cx("h-1.5 w-full rounded-full transition-colors", complete ? "bg-leaf" : current ? "bg-peacock" : i < index ? "bg-peacock/40" : "bg-line"),
        dot: cx("flex h-9 w-9 items-center justify-center rounded-full transition-colors", current ? "bg-peacock text-white shadow-md" : complete ? "bg-leaf-light text-leaf" : "bg-white text-ink-faint ring-1 ring-line"),
      };
    });
  });

  ngOnInit(): void {
    this.step.set(firstOpenStep(this.partner()));
  }

  protected go(k: StepKey): void {
    this.step.set(k);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  protected saved(p: Partner): void {
    this.partners.set(p);
    this.go(STEPS[Math.min(this.index() + 1, STEPS.length - 1)].key);
  }
}

/* ---------------------------------------------------------------- after submitting */

@Component({
  selector: "pc-register-under-review",
  imports: [Icon, Button, PcLink, PartnerGetTheApp],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "mx-auto flex max-w-lg flex-col gap-4 pt-4", "data-testid": "under-review" },
  template: `
    <div class="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
      <span class="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-marigold-light text-marigold-dark"><svg [pcIcon]="Hourglass" class="h-8 w-8" /></span>
      <h1 class="mt-4 text-2xl font-bold">Thanks, {{ partner().name.split(" ")[0] }}! You are under review</h1>
      <p class="mt-1 text-ink-soft">We are checking your documents. We will send a message to <b class="text-ink">{{ partner().phone }}</b> as soon as you are approved.</p>
      <ol class="mt-6 flex flex-col gap-0 text-left">
        @for (s of steps(); track s.label; let i = $index) {
          <li class="flex gap-3">
            <div class="flex flex-col items-center">
              <span [class]="s.done ? 'flex h-7 w-7 items-center justify-center rounded-full bg-leaf text-white' : i === 2 ? 'flex h-7 w-7 items-center justify-center rounded-full bg-marigold text-ink' : 'flex h-7 w-7 items-center justify-center rounded-full bg-mist text-ink-faint'">
                @if (s.done) {<svg [pcIcon]="Check" class="h-4 w-4" />} @else if (i === 2) {<svg [pcIcon]="Hourglass" class="h-3.5 w-3.5" />} @else {<svg [pcIcon]="PartyPopper" class="h-3.5 w-3.5" />}
              </span>
              @if (i < steps().length - 1) {<span [class]="s.done ? 'w-0.5 flex-1 bg-leaf' : 'w-0.5 flex-1 bg-line'"></span>}
            </div>
            <div class="pb-5">
              <p class="font-semibold">{{ s.label }}</p>
              @if (s.note) {<p class="text-sm text-ink-soft">{{ s.note }}</p>}
            </div>
          </li>
        }
      </ol>
      <button pcButton variant="secondary" [loading]="checking()" (click)="check()">Check my status</button>
    </div>
    <div class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
      <p class="font-semibold">Meanwhile, install the partner app</p>
      <p class="mb-3 text-sm text-ink-soft">So delivery requests reach you instantly once you are approved.</p>
      <pc-partner-get-the-app [options]="options()" [compact]="true" />
    </div>
    <p class="text-center text-sm text-ink-soft">Questions? <a pcLink="/delivery/help" class="font-semibold text-peacock">Contact the delivery team</a></p>
  `,
})
export class RegisterUnderReview {
  readonly partner = input.required<Partner>();
  readonly options = input.required<DeliveryOptions>();
  private readonly partners = inject(PartnerService);
  protected readonly checking = signal(false);
  protected readonly Hourglass = Hourglass;
  protected readonly Check = Check;
  protected readonly PartyPopper = PartyPopper;
  protected readonly steps = computed(() => {
    const p = this.partner();
    return [
      { label: "Registered", done: true, note: p.created_at ? date(p.created_at) : "" },
      { label: "Documents sent", done: true, note: "" },
      { label: "Verification by our team", done: false, note: "Usually within a day" },
      { label: "Start delivering", done: false, note: "" },
    ];
  });

  protected check(): void {
    this.checking.set(true);
    void this.partners.reload().finally(() => this.checking.set(false));
  }
}

/* ---------------------------------------------------------------- page */

@Component({
  selector: "pc-delivery-register-page",
  imports: [FullLoader, RegisterStart, RegisterWizard, RegisterUnderReview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (status() === "loading" || !options()) {
      <pc-full-loader />
    } @else if (!partner()) {
      <pc-register-start [options]="options()!" />
    } @else if (partner()!.kyc_status === "submitted") {
      <pc-register-under-review [partner]="partner()!" [options]="options()!" />
    } @else {
      @for (id of [partner()!.id]; track id) {<pc-register-wizard [partner]="partner()!" [options]="options()!" />}
    }
  `,
})
export class DeliveryRegisterPage {
  private readonly partners = inject(PartnerService);
  protected readonly partner = this.partners.partner;
  protected readonly status = this.partners.status;
  protected readonly options = deliveryOptions();
}
