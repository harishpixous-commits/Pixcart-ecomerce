/*
 * Seller registration: create the seller account, then business details, pickup address, bank, grievance officer and
 * documents, and submit for verification. Port of frontend/src/app/seller/onboarding/page.tsx (Section, SaveRow and Forms included).
 */

import { ChangeDetectionStrategy, Component, type OnInit, booleanAttribute, computed, effect, inject, input, output, signal } from "@angular/core";
import { CheckCircle2, Circle, FileText, Upload } from "lucide-angular";
import { ApiError, api } from "../../core/api";
import { STATE_OPTIONS, date } from "../../core/format";
import { SessionService } from "../../core/session";
import type { SellerProfile } from "../../core/types";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ButtonLink, ErrorNote, Field, Select, TextField, Textarea, Toast } from "../../shared/ui/ui";

const BUSINESS_TYPES = [
  ["proprietorship", "Sole proprietorship"],
  ["individual", "Individual"],
  ["partnership", "Partnership firm"],
  ["llp", "LLP"],
  ["private_limited", "Private limited company"],
  ["public_limited", "Public limited company"],
];

const DOCS = [
  ["pan_card", "PAN card", true],
  ["gst_certificate", "GST registration certificate", true],
  ["cancelled_cheque", "Cancelled cheque or bank statement", true],
  ["address_proof", "Address proof of pickup location", false],
] as const;

@Component({
  selector: "pc-seller-onboarding-section",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "locked() ? 'rounded-xl bg-white p-5 opacity-90' : 'rounded-xl bg-white p-5'" },
  template: `
    <h2 class="mb-3 flex items-center gap-2 text-xl font-semibold">
      @if (done()) {<svg [pcIcon]="CheckCircle2" class="h-5 w-5 text-leaf" aria-label="Done" />} @else {<svg [pcIcon]="Circle" class="h-5 w-5 text-ink-faint" aria-label="To do" />}
      {{ title() }}
    </h2>
    <ng-content />
  `,
})
export class SellerOnboardingSection {
  readonly title = input.required<string>();
  readonly done = input(false, { transform: booleanAttribute });
  readonly locked = input(false, { transform: booleanAttribute });
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly Circle = Circle;
}

type Biz = { display_name: string; description: string; legal_name: string; business_type: string; gstin: string; pan: string; contact_email: string; contact_phone: string };
type Pickup = { line1: string; line2: string; city: string; state_code: string; pincode: string };
type Bank = { holder_name: string; account_number: string; confirm_account_number: string; ifsc: string };
type Griev = { name: string; email: string; phone: string };

@Component({
  selector: "pc-seller-onboarding-forms",
  imports: [SellerOnboardingSection, Icon, Button, ErrorNote, Field, Select, TextField, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4" },
  template: `
    <pc-seller-onboarding-section section title="Business details" [done]="done('business')" [locked]="locked()">
      <form class="grid gap-3 sm:grid-cols-2" (submit)="save($event, 'biz', '/api/seller/profile', biz())">
        <pc-text-field label="Store name shown to customers" [value]="biz().display_name" (valueChange)="setBiz('display_name', $event)" [required]="true" [disabled]="locked()" />
        <pc-text-field label="Legal business name (as on GST certificate)" [value]="biz().legal_name" (valueChange)="setBiz('legal_name', $event)" [required]="true" [disabled]="locked()" />
        <pc-field label="Business type" for="btype">
          <select pcSelect id="btype" [disabled]="locked()" (change)="setBiz('business_type', $any($event.target).value)">
            @for (b of businessTypes; track b[0]) {<option [value]="b[0]" [selected]="b[0] === biz().business_type">{{ b[1] }}</option>}
          </select>
        </pc-field>
        <pc-text-field label="GSTIN" [value]="biz().gstin" (valueChange)="setBiz('gstin', $event)" [required]="true" [maxlength]="15" placeholder="33ABCDE1234F1Z5" class="uppercase" [disabled]="locked()" [error]="fieldErr()['gstin']" />
        <pc-text-field label="PAN" [value]="biz().pan" (valueChange)="setBiz('pan', $event)" [required]="true" [maxlength]="10" placeholder="ABCDE1234F" [hint]="panHint()" [disabled]="locked()" [error]="fieldErr()['pan']" />
        <pc-text-field label="Business email" type="email" [value]="biz().contact_email" (valueChange)="setBiz('contact_email', $event)" [required]="true" [disabled]="locked()" [error]="fieldErr()['contact_email']" />
        <pc-text-field label="Business mobile" type="tel" [value]="biz().contact_phone" (valueChange)="setBiz('contact_phone', $event)" [required]="true" [disabled]="locked()" [error]="fieldErr()['contact_phone']" />
        <pc-field label="About your store (optional)" class="sm:col-span-2">
          <textarea pcTextarea [value]="biz().description" (input)="setBiz('description', $any($event.target).value)" maxlength="2000" [disabled]="locked()"></textarea>
        </pc-field>
        <div class="flex flex-col gap-2 sm:col-span-2">
          <pc-error-note [message]="errors()['biz'] ?? null" />
          @if (!locked()) {<button pcButton type="submit" [loading]="busy() === 'biz'" class="self-start">Save</button>}
        </div>
      </form>
    </pc-seller-onboarding-section>

    <pc-seller-onboarding-section title="Pickup address" [done]="done('pickup')" [locked]="locked()">
      <p class="mb-3 text-sm text-ink-soft">Where couriers collect your orders. It must be in the state of your GST registration.</p>
      <form class="grid gap-3 sm:grid-cols-2" (submit)="save($event, 'pickup', '/api/seller/pickup-address', pickup())">
        <pc-text-field class="sm:col-span-2" label="Building, street" [value]="pickup().line1" (valueChange)="setPickup('line1', $event)" [required]="true" [disabled]="locked()" />
        <pc-text-field class="sm:col-span-2" label="Area (optional)" [value]="pickup().line2" (valueChange)="setPickup('line2', $event)" [disabled]="locked()" />
        <pc-text-field label="City" [value]="pickup().city" (valueChange)="setPickup('city', $event)" [required]="true" [disabled]="locked()" />
        <pc-text-field label="PIN code" [value]="pickup().pincode" (valueChange)="setPickup('pincode', $event)" [required]="true" [maxlength]="6" inputmode="numeric" [disabled]="locked()" [error]="fieldErr()['pincode']" />
        <pc-field label="State" for="pstate">
          <select pcSelect id="pstate" [disabled]="locked()" (change)="setPickup('state_code', $any($event.target).value)">
            @for (s of states; track s[0]) {<option [value]="s[0]" [selected]="s[0] === pickup().state_code">{{ s[1] }}</option>}
          </select>
        </pc-field>
        <div class="flex flex-col gap-2 sm:col-span-2">
          <pc-error-note [message]="errors()['pickup'] ?? null" />
          @if (!locked()) {<button pcButton type="submit" [loading]="busy() === 'pickup'" class="self-start">Save</button>}
        </div>
      </form>
    </pc-seller-onboarding-section>

    <pc-seller-onboarding-section title="Bank account for payouts" [done]="done('bank')" [locked]="locked()">
      @if (s().bank.account_number) {<p class="mb-3 text-sm text-ink-soft">Saved: {{ s().bank.holder_name }}, account {{ s().bank.account_number }}, IFSC {{ s().bank.ifsc }}</p>}
      <form class="grid gap-3 sm:grid-cols-2" (submit)="save($event, 'bank', '/api/seller/bank', bank())">
        <pc-text-field label="Account holder name" [value]="bank().holder_name" (valueChange)="setBank('holder_name', $event)" [required]="true" [disabled]="locked()" />
        <pc-text-field label="IFSC" [value]="bank().ifsc" (valueChange)="setBank('ifsc', $event)" [required]="true" [maxlength]="11" class="uppercase" [disabled]="locked()" [error]="fieldErr()['ifsc']" />
        <pc-text-field label="Account number" [value]="bank().account_number" (valueChange)="setBank('account_number', $event)" [required]="true" inputmode="numeric" autocomplete="off" [disabled]="locked()" [error]="fieldErr()['account_number']" />
        <pc-text-field label="Confirm account number" [value]="bank().confirm_account_number" (valueChange)="setBank('confirm_account_number', $event)" [required]="true" inputmode="numeric" autocomplete="off" [disabled]="locked()" [error]="fieldErr()['confirm_account_number']" />
        <div class="flex flex-col gap-2 sm:col-span-2">
          <pc-error-note [message]="errors()['bank'] ?? null" />
          @if (!locked()) {<button pcButton type="submit" [loading]="busy() === 'bank'" class="self-start">Save</button>}
        </div>
      </form>
    </pc-seller-onboarding-section>

    <pc-seller-onboarding-section title="Grievance officer" [done]="done('grievance')" [locked]="false">
      <p class="mb-3 text-sm text-ink-soft">The E-Commerce Rules require every seller to name a person who handles customer complaints. Their name and email are shown on your product pages.</p>
      <form class="grid gap-3 sm:grid-cols-3" (submit)="save($event, 'griev', '/api/seller/grievance-officer', griev())">
        <pc-text-field label="Name" [value]="griev().name" (valueChange)="setGriev('name', $event)" [required]="true" />
        <pc-text-field label="Email" type="email" [value]="griev().email" (valueChange)="setGriev('email', $event)" [required]="true" [error]="fieldErr()['email']" />
        <pc-text-field label="Mobile" type="tel" [value]="griev().phone" (valueChange)="setGriev('phone', $event)" [required]="true" [error]="fieldErr()['phone']" />
        <div class="flex flex-col gap-2 sm:col-span-3">
          <pc-error-note [message]="errors()['griev'] ?? null" />
          <button pcButton type="submit" [loading]="busy() === 'griev'" class="self-start">Save</button>
        </div>
      </form>
    </pc-seller-onboarding-section>

    <pc-seller-onboarding-section title="Documents" [done]="docsDone()" [locked]="locked()">
      <p class="mb-3 text-sm text-ink-soft">PDF, JPG or PNG, up to 5 MB each. Documents are stored privately and seen only by our verification team.</p>
      <pc-error-note [message]="errors()['docs'] ?? null" />
      <ul class="divide-y divide-line">
        @for (doc of docs; track doc[0]) {
          <li class="flex flex-wrap items-center gap-3 py-3">
            <svg [pcIcon]="FileText" class="h-5 w-5 text-ink-faint" />
            <div class="flex-1">
              <p class="font-medium">{{ doc[1] }}{{ doc[2] ? "" : " (optional)" }}</p>
              @if (uploaded().get(doc[0]); as d) {
                <p class="text-sm text-leaf">Uploaded {{ d.filename }} on {{ date(d.uploaded_at) }}</p>
              } @else {
                <p class="text-sm text-ink-faint">Not uploaded</p>
              }
            </div>
            @if (!locked()) {
              <label class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light">
                <svg [pcIcon]="Upload" class="h-4 w-4" />
                {{ busy() === doc[0] ? "Uploading" : uploaded().has(doc[0]) ? "Replace" : "Upload" }}
                <input type="file" accept="application/pdf,image/jpeg,image/png" class="sr-only" (change)="onFile(doc[0], $event)" />
              </label>
            }
          </li>
        }
      </ul>
    </pc-seller-onboarding-section>
  `,
})
export class SellerOnboardingForms implements OnInit {
  readonly s = input.required<SellerProfile>();
  readonly saved = output<SellerProfile>();
  private readonly toast = inject(Toast);
  protected readonly FileText = FileText;
  protected readonly Upload = Upload;
  protected readonly businessTypes = BUSINESS_TYPES;
  protected readonly states = STATE_OPTIONS;
  protected readonly docs = DOCS;
  protected readonly date = date;
  protected readonly locked = computed(() => ["submitted", "approved", "suspended"].includes(this.s().status));
  protected readonly biz = signal<Biz>({ display_name: "", description: "", legal_name: "", business_type: "", gstin: "", pan: "", contact_email: "", contact_phone: "" });
  protected readonly pickup = signal<Pickup>({ line1: "", line2: "", city: "", state_code: "33", pincode: "" });
  protected readonly bank = signal<Bank>({ holder_name: "", account_number: "", confirm_account_number: "", ifsc: "" });
  protected readonly griev = signal<Griev>({ name: "", email: "", phone: "" });
  protected readonly busy = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string | null>>({});
  protected readonly fieldErr = signal<Record<string, string>>({});
  protected readonly uploaded = computed(() => new Map(this.s().documents.map((d) => [d.kind as string, d])));
  protected readonly docsDone = computed(() => ["pan_card", "gst_certificate", "cancelled_cheque"].every((k) => this.uploaded().has(k)));
  protected readonly panHint = computed(() => (this.s().pan ? `Saved as ${this.s().pan}. Enter it again when you save this section.` : "Must match characters 3 to 12 of your GSTIN"));

  ngOnInit(): void {
    // the forms start from the profile as it was when they first showed (later saves keep what was typed)
    const s = this.s();
    this.biz.set({ display_name: s.display_name, description: s.description, legal_name: s.legal_name, business_type: s.business_type, gstin: s.gstin ?? "", pan: "", contact_email: s.contact_email, contact_phone: s.contact_phone });
    this.pickup.set({ line1: s.pickup.line1, line2: s.pickup.line2, city: s.pickup.city, state_code: s.pickup.state_code || "33", pincode: s.pickup.pincode });
    this.bank.set({ holder_name: s.bank.holder_name, account_number: "", confirm_account_number: "", ifsc: s.bank.ifsc });
    this.griev.set({ name: s.grievance.name, email: s.grievance.email, phone: s.grievance.phone });
  }

  protected done(k: string): boolean {
    return this.s().checklist.find((c) => c.key === k)?.done ?? false;
  }

  protected setBiz<K extends keyof Biz>(k: K, v: string): void { this.biz.update((x) => ({ ...x, [k]: v })); }
  protected setPickup<K extends keyof Pickup>(k: K, v: string): void { this.pickup.update((x) => ({ ...x, [k]: v })); }
  protected setBank<K extends keyof Bank>(k: K, v: string): void { this.bank.update((x) => ({ ...x, [k]: v })); }
  protected setGriev<K extends keyof Griev>(k: K, v: string): void { this.griev.update((x) => ({ ...x, [k]: v })); }

  protected async save(e: Event, key: string, path: string, body: object): Promise<void> {
    e.preventDefault();
    this.busy.set(key);
    this.errors.update((x) => ({ ...x, [key]: null }));
    this.fieldErr.set({});
    try {
      this.saved.emit(await api<SellerProfile>(path, { method: "PUT", body }));
      this.toast.show("Saved");
    } catch (err) {
      if (err instanceof ApiError) {
        this.errors.update((x) => ({ ...x, [key]: err.message }));
        this.fieldErr.set(err.fields);
      }
    } finally {
      this.busy.set(null);
    }
  }

  protected onFile(kind: string, e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void this.upload(kind, file);
  }

  private async upload(kind: string, file: File): Promise<void> {
    this.busy.set(kind);
    this.errors.update((x) => ({ ...x, docs: null }));
    const form = new FormData();
    form.append("file", file);
    try {
      this.saved.emit(await api<SellerProfile>(`/api/seller/documents/${kind}`, { method: "POST", form }));
      this.toast.show("Document uploaded");
    } catch (err) {
      this.errors.update((x) => ({ ...x, docs: err instanceof ApiError ? err.message : "Upload failed" }));
    } finally {
      this.busy.set(null);
    }
  }
}

@Component({
  selector: "pc-seller-onboarding-page",
  imports: [PageHeader, PageLoader, Button, ButtonLink, ErrorNote, TextField, SellerOnboardingForms],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (profile() === undefined) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else if (profile() === null) {
      <div class="mx-auto max-w-lg rounded-xl bg-white p-6">
        <h1 class="mb-1 text-2xl font-semibold">Register as a seller</h1>
        <p class="mb-4 text-ink-soft">Choose the store name customers will see. You can add your business documents next.</p>
        <form (submit)="register($event)" class="flex flex-col gap-3">
          <pc-error-note [message]="error()" />
          <pc-text-field label="Store name" [(value)]="storeName" [minlength]="3" [maxlength]="80" [required]="true" [autofocus]="true" />
          <button pcButton type="submit" [loading]="busy()" class="self-start">Create seller account</button>
        </form>
      </div>
    } @else if (profile(); as profile) {
      <div class="flex flex-col gap-4">
        <pc-page-header title="Seller registration" [sub]="profile.display_name" />
        @if (profile.status === "submitted") {
          <div class="rounded-xl bg-marigold-light p-4">
            <p class="font-semibold">Your application is being reviewed</p>
            <p class="text-ink-soft">Submitted on {{ date(profile.submitted_at) }}. We usually finish within two working days and will show the result here.</p>
          </div>
        }
        @if (profile.status === "rejected") {
          <div class="rounded-xl bg-vermilion-light p-4">
            <p class="font-semibold text-vermilion">Changes needed before we can approve your store</p>
            <p class="text-ink">{{ profile.rejection_reason }}</p>
            <p class="text-sm text-ink-soft">Fix the details below and submit again.</p>
          </div>
        }
        @if (profile.status === "suspended") {
          <div class="rounded-xl bg-vermilion-light p-4">
            <p class="font-semibold text-vermilion">Your store is suspended</p>
            <p>{{ profile.rejection_reason }}</p>
          </div>
        }
        @if (profile.status === "approved") {
          <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-leaf-light p-4">
            <p class="font-semibold text-leaf">Your store is approved. You can list products and receive orders.</p>
            <a pcButtonLink href="/seller">Go to dashboard</a>
          </div>
        }
        <pc-seller-onboarding-forms [s]="profile" (saved)="profileSet($event)" />
        @if (profile.status === "draft" || profile.status === "rejected") {
          <section class="sticky bottom-3 flex flex-col gap-3 rounded-xl bg-white p-4 shadow-lg ring-1 ring-line sm:flex-row sm:items-center">
            <div class="flex-1">
              @if (missing().length) {
                <p class="text-ink-soft">Still to do: {{ missingText() }}</p>
              } @else {
                <p class="font-semibold text-leaf">Everything is filled in. Submit for verification.</p>
              }
              <pc-error-note [message]="error()" />
            </div>
            <button pcButton variant="buy" size="lg" (click)="submit()" [loading]="busy()" [disabled]="missing().length > 0">Submit for verification</button>
          </section>
        }
      </div>
    }
  `,
})
export class SellerOnboardingPage {
  private readonly session = inject(SessionService);
  private readonly toast = inject(Toast);
  protected readonly date = date;
  protected readonly profile = signal<SellerProfile | null | undefined>(undefined);
  protected readonly storeName = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly missing = computed(() => (this.profile()?.checklist ?? []).filter((c) => !c.done));
  protected readonly missingText = computed(() => this.missing().map((m) => m.label.replace(/ \(.*\)$/, "")).join(", "));

  constructor() {
    effect(() => {
      if (this.session.user()) this.load();
    });
  }

  private load(): void {
    api<SellerProfile>("/api/seller/me").then((p) => this.profile.set(p)).catch((e) => {
      if (e instanceof ApiError && e.status === 403) this.profile.set(null);
      else this.error.set(e instanceof Error ? e.message : "Could not load");
    });
  }

  protected profileSet(p: SellerProfile): void {
    this.profile.set(p);
  }

  protected async register(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      this.profile.set(await api<SellerProfile>("/api/seller/register", { method: "POST", body: { display_name: this.storeName() } }));
      await this.session.reloadUser();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not register");
    } finally {
      this.busy.set(false);
    }
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.profile.set(await api<SellerProfile>("/api/seller/submit", { method: "POST" }));
      await this.session.reloadUser();
      this.toast.show("Submitted for verification");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not submit");
    } finally {
      this.busy.set(false);
    }
  }
}
