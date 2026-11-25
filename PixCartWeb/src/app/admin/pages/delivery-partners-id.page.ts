/* Admin → Delivery → one partner: documents, KYC review, details, payouts, switch on or off. Port of frontend/src/app/admin/delivery/partners/[id]/page.tsx. */

import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal, viewChild } from "@angular/core";
import { ArrowLeft, Check, CircleAlert, Eye, MapPin, Phone, Power, ShieldCheck, Upload } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, quietly } from "../../core/api";
import type { IdProof, Partner } from "../../core/delivery-types";
import { date, dateTime } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Modal, Select, Textarea, TextField, Toast } from "../../shared/ui/ui";
import { DocViewer, KycPill, OnlineDot, PartnerAvatar, PartnerStars } from "../shared/delivery-admin";
import { VEHICLES } from "./delivery-partners.page";

type Detail = Partner & { id_proof_no: string; account: { name: string; last_login_at: string | null } };
type Zone = { id: string; name: string; city: string; is_active: boolean };

@Component({
  selector: "div[pcDocRow]",
  imports: [Icon, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-wrap items-center gap-3 py-3" },
  template: `
    <span [class]="'flex h-7 w-7 shrink-0 items-center justify-center rounded-full ' + (ok() ? 'bg-leaf-light text-leaf' : optional() ? 'bg-mist text-ink-faint' : 'bg-vermilion-light text-vermilion')">
      <svg [pcIcon]="ok() ? Check : CircleAlert" class="h-4 w-4" />
    </span>
    <div class="min-w-0 flex-1">
      <p class="font-semibold">{{ label() }}</p>
      <p class="break-words text-sm text-ink-soft">{{ value() }}</p>
    </div>
    @if (canView()) {<button pcButton size="sm" variant="secondary" (click)="view.emit()"><svg [pcIcon]="Eye" class="h-4 w-4" /> View</button>}
    <button pcButton size="sm" variant="ghost" [loading]="busy()" (click)="file.click()"><svg [pcIcon]="Upload" class="h-4 w-4" /> Upload</button>
    <input #file type="file" class="sr-only" accept="image/*,application/pdf" (change)="onFile($event)" [attr.aria-label]="'Upload ' + label()" />
  `,
})
export class DocRow {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly ok = input.required<boolean>();
  readonly optional = input(false);
  readonly canView = input(false);
  readonly partnerId = input.required<string>();
  readonly kind = input.required<string>();
  readonly view = output<void>();
  readonly uploaded = output<Partner>();
  private readonly toast = inject(Toast);
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>("file");
  protected readonly Check = Check; protected readonly CircleAlert = CircleAlert; protected readonly Eye = Eye; protected readonly Upload = Upload;
  protected readonly busy = signal(false);

  protected onFile(e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void this.send(f);
  }

  private async send(file: File): Promise<void> {
    this.busy.set(true);
    try {
      const form = new FormData();
      form.append("file", file);
      this.uploaded.emit(await api<Partner>(`/api/admin/delivery/partners/${this.partnerId()}/docs/${this.kind()}`, { method: "POST", form }));
      this.toast.show(`${this.label()} uploaded`);
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not upload", "error");
    } finally {
      this.busy.set(false);
      const el = this.fileInput()?.nativeElement;
      if (el) el.value = "";
    }
  }
}

@Component({
  selector: "pc-partner-review",
  imports: [Button, ErrorNote, Field, Select, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form class="flex flex-col gap-3" (submit)="submit($event)">
      <pc-error-note [message]="error()" />
      @if (action() === "approve") {
        <p class="text-sm text-ink-soft">Check the documents match the name and photo. The partner can go online as soon as you approve.</p>
        <pc-field label="Delivers in zone">
          <select pcSelect (change)="zone.set($any($event.target).value)" required>
            <option value="" [selected]="zone() === ''">Choose a zone</option>
            @for (z of active(); track z.id) {<option [value]="z.id" [selected]="z.id === zone()">{{ z.name }} ({{ z.city }})</option>}
          </select>
        </pc-field>
        @if (active().length === 0) {<p class="text-sm text-vermilion">Create a zone first in Delivery zones.</p>}
        <pc-text-field label="Note to the partner (optional)" [value]="note()" (valueChange)="note.set($event)" [maxlength]="500" />
        <button pcButton type="submit" [loading]="busy()" [disabled]="!zone()">Approve partner</button>
      } @else {
        <p class="text-sm text-ink-soft">The partner sees this message and can fix their registration and send it again.</p>
        <textarea pcTextarea rows="3" [value]="note()" (input)="note.set($any($event.target).value)" minlength="5" maxlength="500" required aria-label="What to fix"
          placeholder="e.g. The licence photo is blurred. Upload a clear photo of the front."></textarea>
        <button pcButton type="submit" variant="danger" [loading]="busy()" [disabled]="note().trim().length < 5">Send to the partner</button>
      }
    </form>
  `,
})
export class PartnerReview {
  readonly partner = input.required<Partner>();
  readonly zones = input.required<Zone[]>();
  readonly action = input.required<"approve" | "reject">();
  readonly done = output<Partner>();
  protected readonly zone = signal("");
  protected readonly note = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly active = computed(() => this.zones().filter((z) => z.is_active));

  ngOnInit(): void {
    this.zone.set(this.partner().zone?.id ?? "");
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      this.done.emit(await api<Partner>(`/api/admin/delivery/partners/${this.partner().id}/kyc`, { method: "POST", body: { action: this.action(), note: this.note(), zone_id: this.zone() || undefined } }));
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-partner-switch-off",
  imports: [Button, ErrorNote, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form class="flex flex-col gap-3" (submit)="submit($event)">
      <pc-error-note [message]="error()" />
      <p class="text-sm text-ink-soft">They go offline at once and get no new requests until you switch them on again; requests and trips not yet picked up go to other partners. Packages already with them can still be delivered or brought back. They see your reason.</p>
      <textarea pcTextarea rows="3" [value]="reason()" (input)="reason.set($any($event.target).value)" required minlength="5" maxlength="300" aria-label="Reason" placeholder="e.g. Documents expired"></textarea>
      <button pcButton type="submit" variant="danger" [loading]="busy()" [disabled]="reason().trim().length < 5">Switch off</button>
    </form>
  `,
})
export class PartnerSwitchOff {
  readonly partnerId = input.required<string>();
  readonly done = output<Partner & { trips_in_hand?: number }>();
  protected readonly reason = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      this.done.emit(await api<Partner & { trips_in_hand?: number }>(`/api/admin/delivery/partners/${this.partnerId()}/active`, { method: "POST", body: { active: false, reason: this.reason() } }));
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not switch off");
    } finally {
      this.busy.set(false);
    }
  }
}

type EditForm = { name: string; city: string; address: string; zone_id: string; vehicle_type: string; vehicle_no: string; license_no: string; id_proof_type: string; id_proof_no: string };

@Component({
  selector: "pc-partner-edit",
  imports: [Button, ErrorNote, Field, Select, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <form class="grid gap-3 sm:grid-cols-2" (submit)="submit($event)">
      <div class="sm:col-span-2"><pc-error-note [message]="error()" /></div>
      <pc-text-field label="Name" [value]="f().name" (valueChange)="set({ name: $event })" [required]="true" />
      <pc-text-field label="City" [value]="f().city" (valueChange)="set({ city: $event })" />
      <pc-field label="Home address" class="sm:col-span-2"><textarea pcTextarea rows="2" [value]="f().address" (input)="set({ address: $any($event.target).value })"></textarea></pc-field>
      <pc-field label="Zone">
        <select pcSelect (change)="set({ zone_id: $any($event.target).value })">
          <option value="" [selected]="f().zone_id === ''">No zone</option>
          @for (z of zones(); track z.id) {<option [value]="z.id" [selected]="z.id === f().zone_id">{{ z.name }} ({{ z.city }}){{ z.is_active ? "" : " (off)" }}</option>}
        </select>
      </pc-field>
      <pc-field label="Vehicle">
        <select pcSelect (change)="set({ vehicle_type: $any($event.target).value })">
          @for (v of vehicles; track v[0]) {<option [value]="v[0]" [selected]="v[0] === f().vehicle_type">{{ v[1] }}</option>}
        </select>
      </pc-field>
      @if (f().vehicle_type !== "cycle") {<pc-text-field label="Vehicle number" [value]="f().vehicle_no" (valueChange)="set({ vehicle_no: $event })" [filter]="upper" />}
      <pc-text-field label="Licence number" [value]="f().license_no" (valueChange)="set({ license_no: $event })" [filter]="upper" />
      <pc-field label="ID proof">
        <select pcSelect (change)="set({ id_proof_type: $any($event.target).value })">
          @for (o of proofs; track o[0]) {<option [value]="o[0]" [selected]="o[0] === f().id_proof_type">{{ o[1] }}</option>}
        </select>
      </pc-field>
      <pc-text-field label="New ID number (optional)" [value]="f().id_proof_no" (valueChange)="set({ id_proof_no: $event })" [placeholder]="partner().id_proof_last4 ? 'Now ending ' + partner().id_proof_last4 : ''" />
      <button pcButton type="submit" [loading]="busy()" class="sm:col-span-2 sm:justify-self-start">Save details</button>
    </form>
  `,
})
export class PartnerEdit {
  readonly partner = input.required<Detail>();
  readonly zones = input.required<Zone[]>();
  readonly done = output<Partner>();
  protected readonly vehicles = VEHICLES;
  protected readonly proofs: [IdProof, string][] = [["aadhaar", "Aadhaar"], ["pan", "PAN card"], ["voter", "Voter ID"], ["passport", "Passport"]];
  protected readonly upper = (v: string) => v.toUpperCase();
  protected readonly f = signal<EditForm>({ name: "", city: "", address: "", zone_id: "", vehicle_type: "bike", vehicle_no: "", license_no: "", id_proof_type: "aadhaar", id_proof_no: "" });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    const p = this.partner();
    this.f.set({ name: p.name, city: p.city, address: p.address, zone_id: p.zone?.id ?? "", vehicle_type: p.vehicle_type, vehicle_no: p.vehicle_no, license_no: p.license_no,
      id_proof_type: p.id_proof_type || "aadhaar", id_proof_no: "" });
  }

  protected set(x: Partial<EditForm>): void {
    this.f.update((f) => ({ ...f, ...x }));
  }

  protected async submit(e: Event): Promise<void> {
    e.preventDefault();
    const f = this.f();
    this.busy.set(true);
    this.error.set(null);
    try {
      this.done.emit(await api<Partner>(`/api/admin/delivery/partners/${this.partner().id}`, { method: "PUT", body: {
        name: f.name, city: f.city, address: f.address, zone_id: f.zone_id || undefined, vehicle_type: f.vehicle_type,
        vehicle_no: f.vehicle_type === "cycle" ? "" : f.vehicle_no, license_no: f.license_no, id_proof_type: f.id_proof_type, id_proof_no: f.id_proof_no || undefined,
      } }));
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "pc-admin-delivery-partners-id-page",
  imports: [Icon, PcLink, PageLoader, Button, Modal, DocViewer, KycPill, OnlineDot, PartnerAvatar, PartnerStars, DocRow, PartnerReview, PartnerSwitchOff, PartnerEdit],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!p()) {
      <pc-page-loader />
    } @else {
      <div class="flex flex-col gap-4" data-testid="partner-detail">
        <a pcLink="/admin/delivery/partners" class="flex items-center gap-1.5 self-start text-sm font-semibold text-ink-soft hover:text-peacock"><svg [pcIcon]="ArrowLeft" class="h-4 w-4" /> All partners</a>
        <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
          <div class="flex flex-wrap items-center gap-4">
            <pc-partner-avatar [p]="p()!" size="lg" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="text-2xl font-bold">{{ p()!.name }}</h1>
                <pc-kyc-pill [status]="p()!.kyc_status" [active]="p()!.is_active" />
                @if (p()!.kyc_status === "approved" && p()!.is_active) {<pc-online-dot [online]="p()!.is_online" />}
              </div>
              <p class="mt-0.5 flex flex-wrap items-center gap-3 text-sm text-ink-soft">
                <a [href]="'tel:' + p()!.phone" class="inline-flex items-center gap-1 font-semibold text-peacock"><svg [pcIcon]="Phone" class="h-4 w-4" /> {{ p()!.phone }}</a>
                <span>{{ p()!.vehicle_label }}{{ p()!.vehicle_no ? " · " + p()!.vehicle_no : "" }}</span>
                <span>{{ p()!.zone ? p()!.zone!.name + ", " + p()!.zone!.city : "No zone" }}</span>
                <pc-partner-stars [value]="p()!.rating_avg" [count]="p()!.rating_count" />
              </p>
              <p class="text-xs text-ink-faint">{{ registered() }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              @if (p()!.kyc_status !== "approved") {<button pcButton (click)="modal.set('approve')" [disabled]="!allDone()"><svg [pcIcon]="Check" class="h-4 w-4" /> Approve</button>}
              @if (p()!.kyc_status !== "approved" && p()!.kyc_status !== "rejected") {<button pcButton variant="danger" (click)="modal.set('reject')">Ask for changes</button>}
              <button pcButton variant="secondary" (click)="modal.set('edit')">Edit details</button>
              @if (p()!.is_active) {
                <button pcButton variant="ghost" (click)="modal.set('off')"><svg [pcIcon]="Power" class="h-4 w-4" /> Switch off</button>
              } @else {
                <button pcButton (click)="switchOn()"><svg [pcIcon]="Power" class="h-4 w-4" /> Switch on</button>
              }
            </div>
          </div>
          @if (p()!.kyc_note) {<p [class]="p()!.kyc_status === 'rejected' ? 'mt-3 rounded-lg px-3 py-2 text-sm bg-vermilion-light text-vermilion' : 'mt-3 rounded-lg px-3 py-2 text-sm bg-mist'"><b>Note:</b> {{ p()!.kyc_note }}</p>}
        </section>

        <div class="grid gap-4 lg:grid-cols-[1fr_320px]">
          <div class="flex flex-col gap-4">
            <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <h2 class="mb-3 flex items-center gap-2 text-lg font-semibold"><svg [pcIcon]="ShieldCheck" class="h-5 w-5 text-peacock" /> Documents</h2>
              <div class="divide-y divide-line">
                <div pcDocRow label="Photo" [value]="p()!.photo ? 'Added' : 'Missing'" [ok]="!!p()!.photo" [canView]="!!p()!.photo" (view)="openPhoto()" [partnerId]="id()" kind="photo" (uploaded)="merge($event)"></div>
                <div pcDocRow label="Driving licence" [value]="p()!.vehicle_type === 'cycle' ? 'Not needed for bicycles' : p()!.license_no || 'Number missing'" [ok]="p()!.vehicle_type === 'cycle' || (p()!.docs.license && !!p()!.license_no)"
                  [canView]="p()!.docs.license" (view)="doc.set({ path: '/api/admin/delivery/partners/' + id() + '/docs/license', title: 'Driving licence ' + p()!.license_no })" [partnerId]="id()" kind="license" (uploaded)="merge($event)"></div>
                <div pcDocRow [label]="p()!.id_proof_label || 'ID proof'" [value]="idValue()" [ok]="p()!.docs.id_proof && !!p()!.id_proof_last4"
                  [canView]="p()!.docs.id_proof" (view)="doc.set({ path: '/api/admin/delivery/partners/' + id() + '/docs/id_proof', title: p()!.id_proof_label || 'ID proof' })" [partnerId]="id()" kind="id_proof" (uploaded)="merge($event)"></div>
                <div pcDocRow label="Vehicle registration (RC)" [value]="p()!.docs.vehicle_rc ? 'Added' : 'Not added'" [ok]="p()!.docs.vehicle_rc" [optional]="true"
                  [canView]="p()!.docs.vehicle_rc" (view)="doc.set({ path: '/api/admin/delivery/partners/' + id() + '/docs/vehicle_rc', title: 'Vehicle registration' })" [partnerId]="id()" kind="vehicle_rc" (uploaded)="merge($event)"></div>
              </div>
            </section>

            <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <h2 class="mb-3 text-lg font-semibold">Details</h2>
              <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                @for (kv of details(); track kv[0]) {<div><dt class="text-xs uppercase tracking-wide text-ink-faint">{{ kv[0] }}</dt><dd class="whitespace-pre-line">{{ kv[1] }}</dd></div>}
              </dl>
            </section>
          </div>

          <aside class="flex flex-col gap-4">
            <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <h2 class="text-lg font-semibold">Registration</h2>
              <p class="mb-2 text-sm text-ink-soft">{{ doneCount() }} of {{ p()!.checklist.length }} done</p>
              <ul class="flex flex-col gap-2">
                @for (i of p()!.checklist; track i.key) {
                  <li class="flex items-center gap-2 text-sm">
                    <span [class]="i.done ? 'flex h-5 w-5 items-center justify-center rounded-full bg-leaf text-white' : 'flex h-5 w-5 items-center justify-center rounded-full bg-vermilion-light text-vermilion'"><svg [pcIcon]="i.done ? Check : CircleAlert" class="h-3 w-3" /></span>
                    {{ i.label }}
                  </li>
                }
              </ul>
            </section>
            <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <h2 class="text-lg font-semibold">Payouts</h2>
              @if (p()!.bank.set) {
                <div class="mt-1 text-sm">
                  <p>{{ p()!.bank.holder }}</p>
                  @if (p()!.bank.account_last4) {<p>Account @if (bank()) {<b class="font-mono">{{ bank()!.account_number }}</b>} @else {ending {{ p()!.bank.account_last4 }}} · {{ p()!.bank.ifsc }}</p>}
                  @if (p()!.bank.upi) {<p>UPI {{ p()!.bank.upi }}</p>}
                  @if (canPayouts() && p()!.bank.account_last4 && !bank()) {<button type="button" (click)="revealBank()" class="mt-2 inline-flex items-center gap-1 font-semibold text-peacock"><svg [pcIcon]="Eye" class="h-4 w-4" /> Show account number</button>}
                </div>
              } @else {<p class="text-sm text-ink-soft">Not added yet</p>}
            </section>
            <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <h2 class="text-lg font-semibold">Last location</h2>
              @if (p()!.location.lat !== null && p()!.location.lng !== null) {
                <div class="mt-1 text-sm">
                  <p>{{ p()!.location.at ? dateTime(p()!.location.at) : "" }}</p>
                  <a [href]="'https://www.google.com/maps?q=' + p()!.location.lat + ',' + p()!.location.lng" target="_blank" rel="noreferrer" class="mt-1 inline-flex items-center gap-1 font-semibold text-peacock"><svg [pcIcon]="MapPin" class="h-4 w-4" /> Open in Google Maps</a>
                </div>
              } @else {<p class="text-sm text-ink-soft">Shared only while the partner is online.</p>}
            </section>
          </aside>
        </div>

        <pc-doc-viewer [path]="doc()?.path ?? null" [title]="doc()?.title ?? ''" (close)="doc.set(null)" />
        <pc-modal [open]="modal() === 'approve'" (close)="modal.set(null)" [title]="'Approve ' + p()!.name">
          @if (modal() === "approve") {<pc-partner-review [partner]="p()!" [zones]="zones()" action="approve" (done)="merge($event); modal.set(null); toast.show('Approved. The partner was told by SMS and in the app.')" />}
        </pc-modal>
        <pc-modal [open]="modal() === 'reject'" (close)="modal.set(null)" title="Ask for changes">
          @if (modal() === "reject") {<pc-partner-review [partner]="p()!" [zones]="zones()" action="reject" (done)="merge($event); modal.set(null); toast.show('The partner was told what to fix.')" />}
        </pc-modal>
        <pc-modal [open]="modal() === 'off'" (close)="modal.set(null)" [title]="'Switch off ' + p()!.name">
          @if (modal() === "off") {<pc-partner-switch-off [partnerId]="id()" (done)="switchedOff($event)" />}
        </pc-modal>
        <pc-modal [open]="modal() === 'edit'" (close)="modal.set(null)" title="Edit details" [wide]="true">
          @if (modal() === "edit") {<pc-partner-edit [partner]="p()!" [zones]="zones()" (done)="merge($event); modal.set(null); toast.show('Saved')" />}
        </pc-modal>
      </div>
    }
  `,
})
export class AdminDeliveryPartnersIdPage {
  readonly id = input.required<string>();
  protected readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly canPayouts = computed(() => this.admin.can("payouts"));
  protected readonly ArrowLeft = ArrowLeft; protected readonly Check = Check; protected readonly CircleAlert = CircleAlert; protected readonly Eye = Eye;
  protected readonly MapPin = MapPin; protected readonly Phone = Phone; protected readonly Power = Power; protected readonly ShieldCheck = ShieldCheck;
  protected readonly dateTime = dateTime;
  protected readonly p = signal<Detail | null>(null);
  protected readonly zones = signal<Zone[]>([]);
  protected readonly modal = signal<"approve" | "reject" | "off" | "edit" | null>(null);
  protected readonly doc = signal<{ path: string; title: string } | null>(null);
  protected readonly bank = signal<{ account_number: string } | null>(null);
  protected readonly doneCount = computed(() => this.p()?.checklist.filter((i) => i.done).length ?? 0);
  protected readonly allDone = computed(() => this.p()?.checklist.every((i) => i.done) ?? false);
  protected readonly registered = computed(() => {
    const p = this.p()!;
    return `Registered ${p.created_at ? date(p.created_at) : ""}${p.approved_at ? ` · approved ${date(p.approved_at)}` : ""}${p.account.last_login_at ? ` · last signed in ${dateTime(p.account.last_login_at)}` : ""}`;
  });
  protected readonly idValue = computed(() => {
    const p = this.p()!;
    return p.id_proof_no || (p.id_proof_last4 ? `ending ${p.id_proof_last4}${p.id_proof_type === "aadhaar" ? " (Aadhaar numbers are not stored)" : ""}` : "Number missing");
  });
  protected readonly details = computed(() => {
    const p = this.p()!;
    return [["Name", p.name], ["City", p.city || "—"], ["Home address", p.address || "—"], ["Zone", p.zone ? `${p.zone.name}, ${p.zone.city}` : "Not set"],
      ["Vehicle", `${p.vehicle_label}${p.vehicle_no ? ` · ${p.vehicle_no}` : ""}`], ["Account name", p.account.name || "—"]];
  });

  constructor() {
    effect(() => {
      this.id();
      this.load();
    });
    api<Zone[]>("/api/admin/delivery/zones").then((z) => this.zones.set(z)).catch(quietly);
  }

  private load(): void {
    api<Detail>(`/api/admin/delivery/partners/${this.id()}`).then((p) => this.p.set(p)).catch(quietly);
  }

  protected merge(x: Partial<Detail>): void {
    this.p.update((p) => (p ? { ...p, ...x } : p));
  }

  protected openPhoto(): void {
    window.open(this.p()!.photo, "_blank", "noopener");
  }

  protected switchedOff(x: Partner & { trips_in_hand?: number }): void {
    this.merge(x);
    this.modal.set(null);
    this.toast.show(x.trips_in_hand
      ? `Switched off. Their requests went to other partners; ${x.trips_in_hand} package${x.trips_in_hand === 1 ? " is" : "s are"} still with them to deliver or bring back.`
      : "Switched off. Their requests went to other partners.");
  }

  protected async switchOn(): Promise<void> {
    try {
      await api(`/api/admin/delivery/partners/${this.id()}/active`, { method: "POST", body: { active: true } });
      this.toast.show("Partner switched on");
      this.load();
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not switch on", "error");
    }
  }

  protected async revealBank(): Promise<void> {
    try {
      this.bank.set(await api<{ account_number: string }>(`/api/admin/delivery/partners/${this.id()}/bank`));
    } catch (x) {
      this.toast.show(x instanceof ApiError ? x.message : "Could not show the account number", "error");
    }
  }
}
