/*
 * Admin → Delivery → Settings: which orders the own fleet carries, assignment, partner earnings, cash on delivery,
 * safety checks, map, support and the partner Android app (upload and publish an APK).
 * Port of frontend/src/app/admin/delivery/settings/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { api, ApiError, quietly, uploadWithProgress } from "../../core/api";
import { paiseToInput, rupees, toPaise } from "../../core/format";
import { PageHeader } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, TextField, Toast } from "../../shared/ui/ui";

type Values = Record<string, boolean | number | string>;

const MODES: { value: string; title: string; text: string }[] = [
  { value: "zones", title: "Zones only", text: "Your partners deliver when the store and the customer are both in your zones of the same city. Everything else goes by courier." },
  { value: "all", title: "Every order", text: "Your partners deliver every package. Packages outside your zones wait in the queue for you to assign by hand." },
  { value: "seller_choice", title: "Seller chooses", text: "Inside your zones the seller picks \"Ready for pickup\" (your partner) or \"Ship by courier\" for each order." },
  { value: "off", title: "Couriers only", text: "Your partners get no packages; sellers ship every order by courier." },
];

const MONEY = ["fee_fixed_paise", "fee_base_paise", "fee_per_km_paise", "fee_min_paise", "fee_max_paise", "weather_bonus_paise", "cod_limit_paise"];

/** A switch with its label and hint (the reference's local Toggle). */
@Component({
  selector: "pc-delivery-toggle",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <label class="flex items-start gap-3 rounded-lg border border-line p-3">
      <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="checked()" (change)="toggle.emit($any($event.target).checked)" [attr.data-testid]="'toggle-' + k()" />
      <span><span class="font-semibold">{{ label() }}</span><br /><span class="text-sm text-ink-soft">{{ hint() }}</span></span>
    </label>
  `,
})
export class DeliveryToggle {
  readonly k = input.required<string>();
  readonly checked = input.required<boolean>();
  readonly label = input.required<string>();
  readonly hint = input.required<string>();
  readonly toggle = output<boolean>();
}

/** Upload the partner APK: checked by the server, published at /media/apps/…, and set as the download link. */
@Component({
  selector: "pc-app-upload",
  imports: [Button, ErrorNote, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-3 rounded-xl border border-dashed border-line p-4 sm:col-span-2">
      @if (current()) {
        <p class="flex flex-wrap items-center gap-2 text-sm">
          <span class="rounded-full bg-leaf-light px-2.5 py-0.5 text-xs font-semibold text-leaf">Published</span>
          <span class="font-semibold">{{ version() ? "Version " + version() : "Current app" }}</span>
          <a [href]="current()" class="break-all font-semibold text-peacock" download>Download to check</a>
        </p>
      } @else {
        <p class="text-sm text-ink-soft">No app uploaded yet. Partners can still use the web app and add it to their home screen.</p>
      }
      <pc-error-note [message]="error()" />
      <div class="flex flex-wrap items-end gap-3">
        <label class="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
          New APK file
          <input #fileInput type="file" accept=".apk,application/vnd.android.package-archive" (change)="file.set($any($event.target).files?.[0] ?? null)"
            class="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-peacock-light file:px-3 file:py-2 file:font-semibold file:text-peacock" data-testid="apk-file" />
        </label>
        <div class="w-32"><pc-text-field label="Version" [value]="ver()" (valueChange)="ver.set($event)" placeholder="1.0.1" [maxlength]="20" /></div>
        <button pcButton type="button" (click)="upload(fileInput)" [disabled]="!file() || progress() !== null" [loading]="progress() !== null">Upload and publish</button>
      </div>
      @if (progress() !== null) {
        <div class="h-2 overflow-hidden rounded-full bg-mist" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="pctDone()" aria-label="Upload progress">
          <div class="h-full rounded-full bg-peacock transition-[width]" [style.width.%]="pctDone()"></div>
        </div>
      }
    </div>
  `,
})
export class AppUpload {
  readonly current = input.required<string>();
  readonly version = input.required<string>();
  readonly uploaded = output<Values>();
  private readonly toast = inject(Toast);
  protected readonly file = signal<File | null>(null);
  protected readonly ver = signal("");
  protected readonly progress = signal<number | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly pctDone = computed(() => Math.round((this.progress() ?? 0) * 100));

  protected async upload(el: HTMLInputElement): Promise<void> {
    const file = this.file();
    if (!file) return;
    this.error.set(null);
    this.progress.set(0);
    try {
      const r = await uploadWithProgress<{ values: Values; size: number }>(`/api/admin/delivery/app?version=${encodeURIComponent(this.ver().trim())}`, file, (p) => this.progress.set(p));
      this.uploaded.emit({ android_apk_url: r.values["android_apk_url"], app_version: r.values["app_version"] });
      this.toast.show(`App published (${(r.size / 1024 / 1024).toFixed(1)} MB). Partners can download it now.`);
      this.file.set(null);
      this.ver.set("");
      // the reference's file input is uncontrolled and keeps showing the chosen name; nothing to reset here
      void el;
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      this.progress.set(null);
    }
  }
}

@Component({
  selector: "pc-admin-delivery-settings-page",
  imports: [PageHeader, PageLoader, Button, ErrorNote, Field, TextField, DeliveryToggle, AppUpload],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!v()) {
      <pc-page-loader />
    } @else {
      <form (submit)="save($event)" class="flex max-w-4xl flex-col gap-4" data-testid="delivery-settings">
        <pc-page-header title="Delivery settings" sub="How your own delivery fleet works: which orders it carries, how packages are assigned, what partners earn and the safety checks." />
        <pc-error-note [message]="error()" />

        <section [class]="card">
          <h2 class="text-lg font-semibold sm:col-span-2">Delivery fleet</h2>
          <pc-delivery-toggle k="enabled" [checked]="b('enabled')" (toggle)="set('enabled', $event)" label="Own delivery fleet is on" hint="The partner app, assignment and live tracking. Off pauses everything (sellers ship by courier)." />
          <pc-delivery-toggle k="registration_open" [checked]="b('registration_open')" (toggle)="set('registration_open', $event)" label="New partners can register" hint="The Become a delivery partner page and the registration in the app." />
          <fieldset class="sm:col-span-2">
            <legend class="mb-2 font-semibold">Which orders your partners deliver</legend>
            <div class="grid gap-2 sm:grid-cols-2" role="radiogroup">
              @for (m of modes; track m.value) {
                <label [class]="v()!['fleet_mode'] === m.value ? 'flex cursor-pointer gap-3 rounded-xl border-2 p-3 border-peacock bg-peacock-light/40' : 'flex cursor-pointer gap-3 rounded-xl border-2 p-3 border-line hover:border-peacock/40'">
                  <input type="radio" name="fleet_mode" class="mt-1 accent-peacock" [checked]="v()!['fleet_mode'] === m.value" (change)="set('fleet_mode', m.value)" />
                  <span><span class="font-semibold">{{ m.title }}</span><br /><span class="text-sm text-ink-soft">{{ m.text }}</span></span>
                </label>
              }
            </div>
          </fieldset>
        </section>

        <section [class]="card">
          <div class="sm:col-span-2"><h2 class="text-lg font-semibold">Assigning packages</h2><p class="text-sm text-ink-soft">With auto-assign on, a package ready for pickup is offered to the nearest free partner in the store's zone. If they do not accept in time, the next partner gets it.</p></div>
          <pc-delivery-toggle k="auto_assign" [checked]="b('auto_assign')" (toggle)="set('auto_assign', $event)" label="Auto-assign" hint="Off: staff assign every package from the queue." />
          <pc-text-field label="Seconds to accept a request" [value]="s('offer_seconds')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('offer_seconds', $event)" hint="10 to 180 (30 is common)" />
          <pc-text-field label="Search radius around the store (km)" [value]="s('radius_km')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('radius_km', $event)" hint="1 to 100" />
          <pc-text-field label="Packages a partner carries at once" [value]="s('max_active')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('max_active', $event)" hint="1 to 10" />
          <pc-text-field label="Partners to try before the queue" [value]="s('max_offers')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('max_offers', $event)" hint="1 to 30. Then staff are alerted." />
        </section>

        <section [class]="card">
          <div class="sm:col-span-2"><h2 class="text-lg font-semibold">Partner earnings</h2><p class="text-sm text-ink-soft">What a partner earns for each delivery. Shown on every request before they accept, and paid weekly.</p></div>
          <div class="flex gap-2 sm:col-span-2" role="radiogroup">
            @for (m of feeModes; track m) {
              <button type="button" role="radio" [attr.aria-checked]="v()!['fee_mode'] === m" (click)="set('fee_mode', m)"
                [class]="v()!['fee_mode'] === m ? 'rounded-full px-4 py-2 font-semibold ring-1 bg-peacock text-white ring-peacock' : 'rounded-full px-4 py-2 font-semibold ring-1 ring-line hover:ring-peacock/50'">
                {{ m === "fixed" ? "Same fee for every delivery" : "By distance" }}
              </button>
            }
          </div>
          @if (v()!['fee_mode'] === "fixed") {
            <pc-text-field label="Fee per delivery (₹)" [value]="m('fee_fixed_paise')" inputmode="decimal" (valueChange)="setMoney('fee_fixed_paise', $event)" />
          } @else {
            <pc-text-field label="Base fee (₹)" [value]="m('fee_base_paise')" inputmode="decimal" (valueChange)="setMoney('fee_base_paise', $event)" />
            <pc-text-field label="Per km (₹)" [value]="m('fee_per_km_paise')" inputmode="decimal" (valueChange)="setMoney('fee_per_km_paise', $event)" hint="Distance from the store to the customer" />
            <pc-text-field label="Lowest fee (₹)" [value]="m('fee_min_paise')" inputmode="decimal" (valueChange)="setMoney('fee_min_paise', $event)" />
            <pc-text-field label="Highest fee (₹)" [value]="m('fee_max_paise')" inputmode="decimal" (valueChange)="setMoney('fee_max_paise', $event)" />
          }
          <p class="rounded-xl bg-mist px-4 py-3 text-sm sm:col-span-2">
            Example: a 2 km delivery earns <b>{{ rupees(example(2)) }}</b>, a 6 km delivery earns <b>{{ rupees(example(6)) }}</b>.
          </p>
          <div class="flex flex-col gap-3 border-t border-line pt-3 sm:col-span-2 sm:flex-row sm:items-start" id="partner-pay">
            <pc-text-field label="Bad weather bonus per trip (₹)" [value]="m('weather_bonus_paise')" inputmode="decimal" (valueChange)="setMoney('weather_bonus_paise', $event)" class="sm:w-56" testid="weather-bonus" />
            <p class="text-sm text-ink-soft sm:pt-7">
              Added to every trip a partner finishes while the bad weather fee is on (Checkout and fees). Partners see it on each request and in their earnings. 0 for no bonus.
            </p>
          </div>
        </section>

        <section [class]="card">
          <div class="sm:col-span-2"><h2 class="text-lg font-semibold">Cash on delivery</h2><p class="text-sm text-ink-soft">Partners collect cash and deposit it with you. The app shows each partner's cash in hand.</p></div>
          <pc-text-field label="Most cash a partner may hold (₹)" [value]="m('cod_limit_paise')" inputmode="decimal" (valueChange)="setMoney('cod_limit_paise', $event)" hint="Above this they get no cash-on-delivery packages until they deposit" />
          <pc-delivery-toggle k="cod_deduct_from_payout" [checked]="b('cod_deduct_from_payout')" (toggle)="set('cod_deduct_from_payout', $event)" label="Take cash not deposited out of the weekly payout" hint="Off: partners deposit cash; payouts are their fees only." />
        </section>

        <section [class]="card">
          <div class="sm:col-span-2"><h2 class="text-lg font-semibold">Safety and proof</h2></div>
          <pc-delivery-toggle k="pickup_code_required" [checked]="b('pickup_code_required')" (toggle)="set('pickup_code_required', $event)" label="Pickup code at the store" hint="The partner enters the code shown on the seller's order before picking up." />
          <pc-delivery-toggle k="delivery_otp_required" [checked]="b('delivery_otp_required')" (toggle)="set('delivery_otp_required', $event)" label="Customer OTP at the door" hint="The partner enters the code the customer received to finish the delivery." />
          <pc-delivery-toggle k="proof_photo_required" [checked]="b('proof_photo_required')" (toggle)="set('proof_photo_required', $event)" label="Delivery photo" hint="A photo of the handed-over package; the customer can see it." />
          <pc-text-field label="Alert staff when a step takes longer than (minutes)" [value]="s('stuck_minutes')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('stuck_minutes', $event)" hint="5 to 720" />
        </section>

        <section [class]="card">
          <div class="sm:col-span-2"><h2 class="text-lg font-semibold">Location and map</h2></div>
          <pc-text-field label="Partners share their location every (seconds)" [value]="s('location_seconds')" inputmode="numeric" [filter]="digits" (valueChange)="setNum('location_seconds', $event)" hint="5 to 300. Lower is smoother tracking but uses more battery." />
          <pc-field label="Map tiles" for="map-tiles" hint="OpenStreetMap by default (free). For heavy traffic use a tile provider; the address needs {z}, {x} and {y}.">
            <input id="map-tiles" class="h-10 w-full rounded-lg border border-line px-3 font-mono text-sm" [value]="s('map_tiles')" (input)="set('map_tiles', $any($event.target).value)" />
          </pc-field>
          <pc-text-field label="Map credit line" [value]="s('map_attribution')" (valueChange)="set('map_attribution', $event)" />
        </section>

        <section [class]="card">
          <div class="sm:col-span-2"><h2 class="text-lg font-semibold">Partner support and app</h2></div>
          <pc-text-field label="Delivery team phone" [value]="s('support_phone')" (valueChange)="set('support_phone', $event)" hint="Shown in the partner app's Help" />
          <pc-text-field label="Delivery team WhatsApp" [value]="s('support_whatsapp')" (valueChange)="set('support_whatsapp', $event)" />
          <pc-delivery-toggle k="require_vehicle_doc" [checked]="b('require_vehicle_doc')" (toggle)="set('require_vehicle_doc', $event)" label="Vehicle registration (RC) is required" hint="Otherwise it is optional during registration." />
          <pc-delivery-toggle k="return_pickups" [checked]="b('return_pickups')" (toggle)="set('return_pickups', $event)" label="Partners collect customers' returns" hint="For packages our partners delivered: an approved return is collected from the customer (with their pickup code) and brought to the seller." />
        </section>

        <section [class]="card" data-testid="partner-app-settings">
          <div class="sm:col-span-2">
            <h2 class="text-lg font-semibold">Partner Android app</h2>
            <p class="text-sm text-ink-soft">
              Partners download it from <a href="/delivery/download" target="_blank" rel="noreferrer" class="font-semibold text-peacock">/delivery/download</a> and
              from the partner app. Upload the APK here, or paste a link to it (a GitHub release or Google Play).
            </p>
          </div>
          <pc-app-upload (uploaded)="merge($event)" [current]="s('android_apk_url')" [version]="s('app_version')" />
          <pc-text-field label="Android app download link" [value]="s('android_apk_url')" (valueChange)="set('android_apk_url', $event)" hint="Filled in when you upload. Or https:// link to the APK." />
          <pc-text-field label="Google Play link" [value]="s('play_store_url')" (valueChange)="set('play_store_url', $event)" hint="When the app is on Google Play" />
          <pc-text-field label="App version shown" [value]="s('app_version')" (valueChange)="set('app_version', $event)" placeholder="1.0.0" />
          <details class="rounded-xl bg-mist px-4 py-3 text-sm sm:col-span-2">
            <summary class="cursor-pointer font-semibold">How to build the app</summary>
            <ol class="mt-2 list-decimal space-y-1 pl-5 text-ink-soft">
              <li>In your code repository on GitHub, open <b>Actions → Android partner app → Run workflow</b>.</li>
              <li>Enter your live website address (for example https://pixcart.in) and a version, like 1.0.0.</li>
              <li>When it finishes (about 10 minutes), download <b>pixcart-partner.apk</b> from the run or from <b>Releases</b>.</li>
              <li>Upload it above. Partners get the new version from the download page.</li>
            </ol>
            <p class="mt-2 text-ink-soft">For notifications in the app, add your Firebase <b>google-services.json</b> as the repository secret <code>GOOGLE_SERVICES_JSON</code> (base64). For a signed release, add the keystore secrets listed in <code>mobile/partner-app/README.md</code>.</p>
          </details>
        </section>

        <div class="sticky bottom-0 -mx-1 flex justify-end bg-gradient-to-t from-mist via-mist/90 to-transparent px-1 pb-2 pt-6">
          <button pcButton type="submit" size="lg" [loading]="busy()">Save delivery settings</button>
        </div>
      </form>
    }
  `,
})
export class AdminDeliverySettingsPage {
  private readonly toast = inject(Toast);
  protected readonly modes = MODES;
  protected readonly feeModes = ["fixed", "distance"] as const;
  protected readonly rupees = rupees;
  protected readonly card = "grid gap-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:grid-cols-2";
  /** what a numeric field shows after typing, like the reference's Number(digits) || 0 */
  protected readonly digits = (x: string) => String(Number(x.replace(/\D/g, "")) || 0);
  protected readonly v = signal<Values | null>(null);
  private readonly money = signal<Record<string, string>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    api<{ values: Values }>("/api/admin/delivery/settings").then((r) => {
      this.v.set(r.values);
      this.money.set(Object.fromEntries(MONEY.map((k) => [k, paiseToInput(Number(r.values[k]))])));
    }).catch(quietly);
  }

  protected b(k: string): boolean {
    return Boolean(this.v()?.[k]);
  }

  protected s(k: string): string {
    return String(this.v()?.[k] ?? "");
  }

  protected m(k: string): string {
    return this.money()[k] ?? "";
  }

  protected set(k: string, x: boolean | number | string): void {
    this.v.update((v) => (v ? { ...v, [k]: x } : v));
  }

  protected setNum(k: string, x: string): void {
    this.set(k, Number(x.replace(/\D/g, "")) || 0);
  }

  protected setMoney(k: string, x: string): void {
    this.money.update((m) => ({ ...m, [k]: x }));
  }

  protected merge(values: Values): void {
    this.v.update((v) => (v ? { ...v, ...values } : v));
  }

  private p(k: string): number {
    return toPaise(this.money()[k] ?? "") ?? 0;
  }

  protected example(km: number): number {
    return this.v()?.["fee_mode"] === "fixed" ? this.p("fee_fixed_paise")
      : Math.min(Math.max(this.p("fee_base_paise") + Math.round(this.p("fee_per_km_paise") * km), this.p("fee_min_paise")), this.p("fee_max_paise"));
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const v = this.v();
    if (!v) return;
    this.error.set(null);
    const body: Values = { ...v };
    for (const k of MONEY) {
      const paise = toPaise(this.money()[k] ?? "");
      if (paise === null) {
        this.error.set("Enter amounts in rupees, like 30 or 12.50");
        return;
      }
      body[k] = paise;
    }
    this.busy.set(true);
    try {
      const r = await api<{ values: Values }>("/api/admin/delivery/settings", { method: "PUT", body });
      this.v.set(r.values);
      this.toast.show("Delivery settings saved");
    } catch (x) {
      this.error.set(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}
