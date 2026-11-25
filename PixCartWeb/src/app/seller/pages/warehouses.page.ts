/* The seller's warehouses: list, add and edit (address, state GSTIN, contact, on/off). Port of frontend/src/app/seller/warehouses/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { ApiError, api, quietly } from "../../core/api";
import { STATES, STATE_OPTIONS } from "../../core/format";
import { PageHeader } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Modal, Pill, Select, TextField, Toast } from "../../shared/ui/ui";

type W = { id: string; code: string; name: string; line1: string; line2: string; city: string; state_code: string; pincode: string; contact_name: string; contact_phone: string; gstin: string; is_default: boolean; is_active: boolean; units: number; skus: number };
const EMPTY = { code: "", name: "", line1: "", line2: "", city: "", state_code: "33", pincode: "", contact_name: "", contact_phone: "", gstin: "", is_active: true };
type F = typeof EMPTY;
type TextKey = Exclude<keyof F, "is_active">;

@Component({
  selector: "pc-seller-warehouses-page",
  imports: [PageHeader, PageLoader, Button, ErrorNote, Field, Modal, Pill, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!items()) {
      <pc-page-loader />
    } @else {
      <div>
        <pc-page-header title="Warehouses" sub="Where you keep stock and ship from. A warehouse in another state needs your GSTIN for that state." [withActions]="true">
          <button actions pcButton (click)="startNew()">Add warehouse</button>
        </pc-page-header>
        <div class="grid gap-3 md:grid-cols-2">
          @for (w of items()!; track w.id) {
            <section class="rounded-xl bg-white p-4">
              <div class="mb-1 flex items-center gap-2">
                <h2 class="text-lg font-semibold">{{ w.name }}</h2>
                <pc-pill tone="blue">{{ w.code }}</pc-pill>
                @if (w.is_default) {<pc-pill tone="green">Main</pc-pill>}
                @if (!w.is_active) {<pc-pill tone="red">Off</pc-pill>}
              </div>
              <p class="text-ink-soft">{{ w.line1 }}{{ w.line2 ? ", " + w.line2 : "" }}, {{ w.city }}, {{ states[w.state_code] }} {{ w.pincode }}</p>
              @if (w.gstin) {<p class="text-sm text-ink-faint">GSTIN {{ w.gstin }}</p>}
              <p class="mt-2 text-sm">{{ w.units.toLocaleString("en-IN") }} units across {{ w.skus }} product options</p>
              <button pcButton variant="ghost" size="sm" class="mt-2" (click)="startEdit(w)">Edit</button>
            </section>
          }
        </div>
        <pc-modal [open]="edit() !== null" (close)="edit.set(null)" [title]="edit() === 'new' ? 'Add warehouse' : 'Edit warehouse'" [wide]="true">
          <form (submit)="save($event)" class="grid gap-3 sm:grid-cols-2">
            <div class="sm:col-span-2"><pc-error-note [message]="error()" /></div>
            <pc-text-field label="Short code" [value]="f().code" (valueChange)="set('code', $event)" [required]="true" maxlength="20" placeholder="e.g. BLR1" [disabled]="edit() !== 'new'" hint="Used in stock CSV files" />
            <pc-text-field label="Name" [value]="f().name" (valueChange)="set('name', $event)" [required]="true" />
            <pc-text-field class="sm:col-span-2" label="Address" [value]="f().line1" (valueChange)="set('line1', $event)" [required]="true" [disabled]="isMainEdit()" />
            <pc-text-field class="sm:col-span-2" label="Area (optional)" [value]="f().line2" (valueChange)="set('line2', $event)" />
            <pc-text-field label="City" [value]="f().city" (valueChange)="set('city', $event)" [required]="true" />
            <pc-text-field label="PIN code" [value]="f().pincode" (valueChange)="set('pincode', $event)" [required]="true" maxlength="6" inputmode="numeric" [error]="fields()['pincode']" [disabled]="isMainEdit()" />
            <pc-field label="State" for="ws">
              <select pcSelect id="ws" (change)="set('state_code', $any($event.target).value)" [disabled]="isMainEdit()">
                @for (s of stateOptions; track s[0]) {<option [value]="s[0]" [selected]="s[0] === f().state_code">{{ s[1] }}</option>}
              </select>
            </pc-field>
            <pc-text-field label="GSTIN for this state" [value]="f().gstin" (valueChange)="set('gstin', $event)" maxlength="15" [error]="fields()['gstin']" hint="Only if the state differs from your main GSTIN" />
            <pc-text-field label="Contact person" [value]="f().contact_name" (valueChange)="set('contact_name', $event)" />
            <pc-text-field label="Contact mobile" [value]="f().contact_phone" (valueChange)="set('contact_phone', $event)" [error]="fields()['contact_phone']" />
            <label class="flex items-center gap-2 sm:col-span-2"><input type="checkbox" class="accent-peacock" [checked]="f().is_active" (change)="f.set({ ...f(), is_active: $any($event.target).checked })" /> Ship orders from this warehouse</label>
            <button pcButton type="submit" class="self-start">Save warehouse</button>
          </form>
        </pc-modal>
      </div>
    }
  `,
})
export class SellerWarehousesPage {
  private readonly toast = inject(Toast);
  protected readonly states = STATES;
  protected readonly stateOptions = STATE_OPTIONS;
  protected readonly items = signal<W[] | null>(null);
  protected readonly edit = signal<W | "new" | null>(null);
  protected readonly f = signal<F>(EMPTY);
  protected readonly error = signal<string | null>(null);
  protected readonly fields = signal<Record<string, string>>({});
  protected readonly isMainEdit = computed(() => {
    const e = this.edit();
    return e !== null && e !== "new" && e.is_default;
  });

  constructor() {
    this.load();
  }

  private load(): void {
    api<W[]>("/api/seller/warehouses").then((x) => this.items.set(x)).catch(quietly);
  }

  protected set(k: TextKey, v: string): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected startNew(): void {
    this.f.set(EMPTY);
    this.edit.set("new");
    this.error.set(null);
  }

  protected startEdit(w: W): void {
    this.f.set({ ...EMPTY, ...w });
    this.edit.set(w);
    this.error.set(null);
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    this.error.set(null);
    this.fields.set({});
    const edit = this.edit();
    try {
      const list = edit === "new"
        ? await api<W[]>("/api/seller/warehouses", { method: "POST", body: this.f() })
        : await api<W[]>(`/api/seller/warehouses/${(edit as W).id}`, { method: "PUT", body: this.f() });
      this.items.set(list);
      this.edit.set(null);
      this.toast.show("Warehouse saved");
    } catch (err) {
      if (err instanceof ApiError) {
        this.error.set(err.message);
        this.fields.set(err.fields);
      }
    }
  }
}
