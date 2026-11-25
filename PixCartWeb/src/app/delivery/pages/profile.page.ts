/*
 * The partner's profile: photo, rating, vehicle and area, documents, payout account, home address, the app installer,
 * help and sign out. Port of frontend/src/app/delivery/profile/page.tsx (with its BankForm and AddressForm).
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { BadgeCheck, Bike, Camera, CheckCircle2, CircleAlert, CircleHelp, FileText, Landmark, LogOut, MapPin, Phone, Star } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import type { Partner } from "../../core/delivery-types";
import { date } from "../../core/format";
import { SessionService } from "../../core/session";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, Modal, TextField, Textarea, Toast } from "../../shared/ui/ui";
import { PartnerGetTheApp } from "../components/install";
import { PartnerService, deliveryOptions } from "../components/partner";
import { UploadTile } from "../components/upload-tile";

const digits = (v: string) => v.replace(/\D/g, "");
const upper = (v: string) => v.toUpperCase();
const trimmed = (v: string) => v.trim();

@Component({
  selector: "pc-partner-bank-form",
  imports: [Icon, Button, ErrorNote, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form (submit)="save($event)" class="flex flex-col gap-3">
      <pc-error-note [message]="error()" />
      <p class="flex items-center gap-2 rounded-lg bg-marigold-light px-3 py-2 text-sm"><svg [pcIcon]="CircleAlert" class="h-4 w-4 shrink-0" /> For your safety, the team checks a changed account before paying into it.</p>
      <pc-text-field label="Account holder name" [(value)]="holder" [required]="true" [minlength]="3" />
      <pc-text-field label="New account number" inputmode="numeric" [(value)]="account" [filter]="digits" />
      @if (account()) {
        <pc-text-field label="Re-enter account number" inputmode="numeric" [(value)]="confirm" [filter]="digits" [required]="true" />
        <pc-text-field label="IFSC" [(value)]="ifsc" [filter]="upper" [required]="true" [maxlength]="11" />
      }
      <pc-text-field label="UPI ID (optional)" [(value)]="upi" [filter]="trimmed" placeholder="name@okaxis" />
      <button pcButton type="submit" [loading]="busy()">Save</button>
    </form>
  `,
})
export class PartnerBankForm {
  readonly partner = input.required<Partner>();
  readonly done = output<Partner>();
  private readonly toast = inject(Toast);
  protected readonly holder = signal("");
  protected readonly account = signal("");
  protected readonly confirm = signal("");
  protected readonly ifsc = signal("");
  protected readonly upi = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly digits = digits;
  protected readonly upper = upper;
  protected readonly trimmed = trimmed;
  protected readonly CircleAlert = CircleAlert;

  ngOnInit(): void {
    const p = this.partner();
    this.holder.set(p.bank.holder || p.name);
    this.upi.set(p.bank.upi);
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      const body = this.account()
        ? { holder: this.holder(), account_number: this.account(), confirm_account_number: this.confirm(), ifsc: this.ifsc(), upi: this.upi() }
        : { holder: this.holder(), upi: this.upi() };
      this.done.emit(await api<Partner>("/api/delivery/me/bank", { method: "PUT", body }));
      this.toast.show("Payout account saved. The team checks changes before the next payout.");
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-partner-address-form",
  imports: [Button, ErrorNote, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form class="flex flex-col gap-3" (submit)="save($event)">
      <pc-error-note [message]="error()" />
      <textarea pcTextarea rows="4" [value]="address()" (input)="address.set($any($event.target).value)" minlength="10" maxlength="500" required aria-label="Home address"></textarea>
      <button pcButton type="submit" [loading]="busy()">Save address</button>
    </form>
  `,
})
export class PartnerAddressForm {
  readonly partner = input.required<Partner>();
  readonly done = output<Partner>();
  protected readonly address = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.address.set(this.partner().address);
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      this.done.emit(await api<Partner>("/api/delivery/me", { method: "PUT", body: { address: this.address() } }));
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-delivery-profile-page",
  imports: [Icon, PcLink, Button, Modal, UploadTile, PartnerGetTheApp, PartnerBankForm, PartnerAddressForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (partner(); as p) {
      <div class="flex flex-col gap-4" data-testid="partner-profile">
        <section class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-5 text-white shadow-sm sm:p-6">
          <div class="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" aria-hidden="true"></div>
          <div class="relative flex items-center gap-4">
            <button type="button" (click)="photo.set(true)" class="group relative shrink-0" aria-label="Change your photo">
              @if (p.photo) {
                <img [src]="p.photo" alt="" class="h-20 w-20 rounded-full object-cover ring-4 ring-white/30" />
              } @else {
                <span class="flex h-20 w-20 items-center justify-center rounded-full bg-white/15 text-3xl font-bold">{{ p.name[0] }}</span>
              }
              <span class="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full bg-marigold text-ink shadow"><svg [pcIcon]="Camera" class="h-4 w-4" /></span>
            </button>
            <div class="min-w-0">
              <h1 class="truncate text-2xl font-bold">{{ p.name }}</h1>
              <p class="text-white/80">{{ p.phone }}</p>
              <p class="mt-1 flex flex-wrap items-center gap-2 text-sm">
                <span class="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5"><svg [pcIcon]="BadgeCheck" class="h-4 w-4 text-marigold" /> Verified partner</span>
                @if (p.rating_count > 0) {
                  <span class="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5"><svg [pcIcon]="Star" class="h-4 w-4 fill-marigold text-marigold" /> {{ p.rating_avg.toFixed(1) }} ({{ p.rating_count }})</span>
                }
              </p>
            </div>
          </div>
          <div class="relative mt-5 grid grid-cols-3 gap-2 text-center text-sm">
            <div class="rounded-2xl bg-white/10 p-2.5"><svg [pcIcon]="Bike" class="mx-auto h-5 w-5" /><p class="mt-1 font-semibold">{{ p.vehicle_label }}</p><p class="text-xs text-white/70">{{ p.vehicle_no || "No plate" }}</p></div>
            <div class="rounded-2xl bg-white/10 p-2.5"><svg [pcIcon]="MapPin" class="mx-auto h-5 w-5" /><p class="mt-1 font-semibold">{{ p.zone?.name ?? "Not set" }}</p><p class="text-xs text-white/70">{{ p.zone?.city ?? p.city }}</p></div>
            <div class="rounded-2xl bg-white/10 p-2.5"><svg [pcIcon]="CheckCircle2" class="mx-auto h-5 w-5" /><p class="mt-1 font-semibold">Since</p><p class="text-xs text-white/70">{{ p.approved_at ? date(p.approved_at) : "—" }}</p></div>
          </div>
        </section>

        <section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
          <h2 class="mb-3 flex items-center gap-2 text-lg font-semibold"><svg [pcIcon]="FileText" class="h-5 w-5 text-peacock" /> Documents</h2>
          <ul class="divide-y divide-line">
            @for (d of docs(); track d[0]) {
              <li class="flex items-center justify-between gap-3 py-2.5">
                <span>{{ d[0] }}</span>
                <span [class]="d[1] ? 'inline-flex items-center gap-1 text-sm font-semibold text-leaf' : 'inline-flex items-center gap-1 text-sm font-semibold text-ink-faint'">@if (d[1]) {<svg [pcIcon]="CheckCircle2" class="h-4 w-4" /> Verified} @else {Not added}</span>
              </li>
            }
          </ul>
          <p class="mt-2 text-xs text-ink-faint">Verified documents can only be changed by the delivery team.</p>
        </section>

        <section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="flex items-center gap-2 text-lg font-semibold"><svg [pcIcon]="Landmark" class="h-5 w-5 text-peacock" /> Payout account</h2>
              <p class="mt-1 text-ink-soft">{{ p.bank.account_last4 ? "Bank account ending " + p.bank.account_last4 + " · " + p.bank.ifsc : p.bank.upi ? "UPI " + p.bank.upi : "Not added" }}</p>
              <p class="text-sm text-ink-faint">{{ p.bank.holder }}</p>
            </div>
            <button pcButton size="sm" variant="secondary" (click)="bank.set(true)">Change</button>
          </div>
        </section>

        <section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="flex items-center gap-2 text-lg font-semibold"><svg [pcIcon]="MapPin" class="h-5 w-5 text-peacock" /> Home address</h2>
              <p class="mt-1 whitespace-pre-line text-ink-soft">{{ p.address }}</p>
            </div>
            <button pcButton size="sm" variant="secondary" (click)="address.set(true)">Edit</button>
          </div>
        </section>

        <section class="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
          <h2 class="mb-1 text-lg font-semibold">Partner app</h2>
          <p class="mb-3 text-sm text-ink-soft">Install it so requests reach you even when the browser is closed.</p>
          <pc-partner-get-the-app [options]="options()" [compact]="true" />
        </section>

        <div class="grid grid-cols-2 gap-3 lg:hidden">
          <a pcLink="/delivery/help" class="flex items-center justify-center gap-2 rounded-2xl bg-white p-4 font-semibold shadow-sm ring-1 ring-black/5"><svg [pcIcon]="CircleHelp" class="h-5 w-5 text-peacock" /> Help</a>
          <button type="button" (click)="signOut()" class="flex items-center justify-center gap-2 rounded-2xl bg-white p-4 font-semibold text-vermilion shadow-sm ring-1 ring-black/5"><svg [pcIcon]="LogOut" class="h-5 w-5" /> Sign out</button>
        </div>
        @if (options()?.support_phone) {
          <a [href]="'tel:' + options()!.support_phone" class="flex items-center justify-center gap-2 text-sm font-semibold text-peacock"><svg [pcIcon]="Phone" class="h-4 w-4" /> Delivery team: {{ options()!.support_phone }}</a>
        }

        <pc-modal [open]="photo()" (close)="photo.set(false)" title="Your photo">
          <pc-upload-tile kind="photo" label="Take a new photo" [done]="!!p.photo" [preview]="p.photo || undefined" (uploaded)="partners.set($event); photo.set(false)" />
        </pc-modal>
        <pc-modal [open]="bank()" (close)="bank.set(false)" title="Change payout account">
          @if (bank()) {<pc-partner-bank-form [partner]="p" (done)="partners.set($event); bank.set(false)" />}
        </pc-modal>
        <pc-modal [open]="address()" (close)="address.set(false)" title="Home address">
          @if (address()) {<pc-partner-address-form [partner]="p" (done)="partners.set($event); address.set(false)" />}
        </pc-modal>
      </div>
    }
  `,
})
export class DeliveryProfilePage {
  protected readonly partners = inject(PartnerService);
  private readonly session = inject(SessionService);
  protected readonly partner = this.partners.partner;
  protected readonly options = deliveryOptions();
  protected readonly photo = signal(false);
  protected readonly bank = signal(false);
  protected readonly address = signal(false);
  protected readonly date = date;
  protected readonly Camera = Camera;
  protected readonly BadgeCheck = BadgeCheck;
  protected readonly Star = Star;
  protected readonly Bike = Bike;
  protected readonly MapPin = MapPin;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly FileText = FileText;
  protected readonly Landmark = Landmark;
  protected readonly CircleHelp = CircleHelp;
  protected readonly LogOut = LogOut;
  protected readonly Phone = Phone;
  protected readonly docs = computed<[string, boolean][]>(() => {
    const p = this.partner();
    if (!p) return [];
    return [
      ["Driving licence", p.docs.license || p.vehicle_type === "cycle"],
      [`${p.id_proof_label || "ID proof"} ending ${p.id_proof_last4}`, p.docs.id_proof],
      ["Vehicle registration (RC)", p.docs.vehicle_rc],
    ];
  });

  protected signOut(): void {
    void this.session.signOut().then(() => window.location.assign(new URL("/delivery/login", window.location.origin)));
  }
}
