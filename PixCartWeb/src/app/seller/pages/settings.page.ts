/* Store details, selling preferences, grievance officer and the verified business details. Port of frontend/src/app/seller/settings/page.tsx. */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ApiError, api, quietly } from "../../core/api";
import { SessionService } from "../../core/session";
import type { SellerProfile } from "../../core/types";
import { PageHeader } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, TextField, Textarea, Toast } from "../../shared/ui/ui";

type Prefs = { dispatch_days: number; holiday_mode: boolean; invoice_prefix: string; dispatch_cutoff: string; free_shipping_threshold_paise: number | null; free_shipping_bounds: { min_paise: number; max_paise: number } | null };
type Store = { display_name: string; description: string; contact_email: string; contact_phone: string };
type Grievance = { name: string; email: string; phone: string };

@Component({
  selector: "pc-seller-settings-page",
  imports: [PageHeader, PageLoader, Button, ErrorNote, Field, TextField, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!p()) {
      <pc-page-loader />
    } @else {
      <div class="flex max-w-3xl flex-col gap-4">
        <pc-page-header title="Store settings" />
        <pc-error-note [message]="error()" />
        <section class="rounded-xl bg-white p-5">
          <h2 class="mb-3 text-xl font-semibold">Store details</h2>
          <form class="grid gap-3 sm:grid-cols-2" (submit)="$event.preventDefault(); save('store', '/api/seller/store', store())">
            <pc-text-field label="Store name" [value]="store().display_name" (valueChange)="setStore('display_name', $event)" [required]="true" />
            <pc-text-field label="Business email" type="email" [value]="store().contact_email" (valueChange)="setStore('contact_email', $event)" [required]="true" />
            <pc-text-field label="Business mobile" [value]="store().contact_phone" (valueChange)="setStore('contact_phone', $event)" [required]="true" />
            <pc-field label="About your store" class="sm:col-span-2"><textarea pcTextarea [value]="store().description" (input)="setStore('description', $any($event.target).value)" maxlength="2000"></textarea></pc-field>
            <button pcButton type="submit" [loading]="busy() === 'store'" class="self-start">Save store details</button>
          </form>
        </section>
        @if (prefs(); as pr) {
          <section class="rounded-xl bg-white p-5">
            <h2 class="mb-3 text-xl font-semibold">Selling preferences</h2>
            <form class="grid gap-3 sm:grid-cols-2" (submit)="savePrefs($event)">
              <pc-text-field label="Days to dispatch after an order" inputmode="numeric" [value]="'' + pr.dispatch_days" [filter]="dispatchFilter" (valueChange)="setPrefs({ dispatch_days: +$event })" hint="Used for the delivery date customers see" />
              <div class="flex flex-col gap-1">
                <label for="cutoff" class="text-sm font-medium">Daily dispatch cut-off (optional)</label>
                <div class="flex items-center gap-2">
                  <input id="cutoff" type="time" [value]="pr.dispatch_cutoff" (input)="setPrefs({ dispatch_cutoff: $any($event.target).value })" class="h-11 rounded-lg border border-line px-3" />
                  @if (pr.dispatch_cutoff) {<button type="button" (click)="setPrefs({ dispatch_cutoff: '' })" class="text-sm text-ink-faint hover:text-vermilion">Clear</button>}
                </div>
                <p class="text-xs text-ink-faint">Orders before this time count from today; later ones from the next working day. Shoppers see &ldquo;Order within 2 hrs 10 mins&rdquo; on your product pages.</p>
              </div>
              @if (pr.free_shipping_bounds; as fb) {
                <pc-text-field label="Free delivery from (rupees)" inputmode="numeric" [value]="pr.free_shipping_threshold_paise == null ? '' : '' + round(pr.free_shipping_threshold_paise / 100)" [filter]="digits" (valueChange)="setFree($event)"
                  [hint]="'Orders from you above this amount ship free. Between ' + round(fb.min_paise / 100) + ' and ' + round(fb.max_paise / 100) + '. Leave empty to use the marketplace amount.'" />
              }
              <pc-text-field label="Invoice prefix" [value]="pr.invoice_prefix" maxlength="4" [filter]="prefixFilter" (valueChange)="setPrefs({ invoice_prefix: $event })" hint="Up to 4 letters, e.g. KOV gives KOV/26-27/000001" />
              <label class="flex items-start gap-3 rounded-lg bg-marigold-light p-3 sm:col-span-2">
                <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="pr.holiday_mode" (change)="setPrefs({ holiday_mode: $any($event.target).checked })" />
                <span><strong>Holiday mode.</strong> Your products are hidden and no new orders come in. Orders already placed still need to be shipped.</span>
              </label>
              <button pcButton type="submit" [loading]="busy() === 'prefs'" class="self-start">Save preferences</button>
            </form>
          </section>
        }
        <section class="rounded-xl bg-white p-5">
          <h2 class="mb-3 text-xl font-semibold">Grievance officer</h2>
          <form class="grid gap-3 sm:grid-cols-3" (submit)="$event.preventDefault(); save('g', '/api/seller/grievance-officer', g())">
            <pc-text-field label="Name" [value]="g().name" (valueChange)="setG('name', $event)" [required]="true" />
            <pc-text-field label="Email" type="email" [value]="g().email" (valueChange)="setG('email', $event)" [required]="true" />
            <pc-text-field label="Mobile" [value]="g().phone" (valueChange)="setG('phone', $event)" [required]="true" />
            <button pcButton type="submit" [loading]="busy() === 'g'" class="self-start">Save</button>
          </form>
        </section>
        <section class="rounded-xl bg-white p-5">
          <h2 class="mb-2 text-xl font-semibold">Business and bank details</h2>
          <dl class="grid grid-cols-[160px_1fr] gap-y-1 text-[15px]">
            <dt class="text-ink-faint">Legal name</dt><dd>{{ p()!.legal_name }}</dd>
            <dt class="text-ink-faint">GSTIN</dt><dd>{{ p()!.gstin }}</dd>
            <dt class="text-ink-faint">PAN</dt><dd>{{ p()!.pan }}</dd>
            <dt class="text-ink-faint">Pickup</dt><dd>{{ p()!.pickup.line1 }}, {{ p()!.pickup.city }}, {{ p()!.pickup.state }} {{ p()!.pickup.pincode }}</dd>
            <dt class="text-ink-faint">Bank</dt><dd>{{ p()!.bank.holder_name }}, {{ p()!.bank.account_number }}, {{ p()!.bank.ifsc }}</dd>
          </dl>
          <p class="mt-3 text-sm text-ink-soft">To protect your payouts, these verified details can be changed only through seller support.</p>
        </section>
      </div>
    }
  `,
})
export class SellerSettingsPage {
  private readonly toast = inject(Toast);
  private readonly session = inject(SessionService);
  protected readonly p = signal<SellerProfile | null>(null);
  protected readonly store = signal<Store>({ display_name: "", description: "", contact_email: "", contact_phone: "" });
  protected readonly g = signal<Grievance>({ name: "", email: "", phone: "" });
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal<string | null>(null);
  protected readonly prefs = signal<Prefs | null>(null);
  protected readonly dispatchFilter = (v: string) => String(Math.min(10, Number(v.replace(/\D/g, "")) || 0));
  protected readonly prefixFilter = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");

  constructor() {
    api<SellerProfile>("/api/seller/me").then((s) => {
      this.p.set(s);
      this.store.set({ display_name: s.display_name, description: s.description, contact_email: s.contact_email, contact_phone: s.contact_phone });
      this.g.set(s.grievance);
    }).catch(quietly);
    api<Prefs>("/api/seller/preferences").then((x) => this.prefs.set(x)).catch(quietly);
  }

  protected setStore(k: keyof Store, v: string): void {
    this.store.update((s) => ({ ...s, [k]: v }));
  }

  protected setG(k: keyof Grievance, v: string): void {
    this.g.update((s) => ({ ...s, [k]: v }));
  }

  protected readonly digits = (v: string) => v.replace(/\D/g, "");
  protected readonly round = Math.round;
  protected setFree(v: string): void {
    this.setPrefs({ free_shipping_threshold_paise: v === "" ? null : Number(v) * 100 });
  }

  protected setPrefs(patch: Partial<Prefs>): void {
    this.prefs.update((p) => (p ? { ...p, ...patch } : p));
  }

  protected async save(key: string, path: string, body: object): Promise<void> {
    this.busy.set(key);
    this.error.set(null);
    try {
      this.p.set(await api<SellerProfile>(path, { method: "PUT", body }));
      await this.session.reloadUser();
      this.toast.show("Saved");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      this.busy.set(null);
    }
  }

  protected async savePrefs(e: Event): Promise<void> {
    e.preventDefault();
    this.busy.set("prefs");
    this.error.set(null);
    try {
      this.prefs.set(await api<Prefs>("/api/seller/preferences", { method: "PUT", body: this.prefs() }));
      this.toast.show("Saved");
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      this.busy.set(null);
    }
  }
}
