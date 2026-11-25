/* Admin → Categories: the category tree, commission, GST, returns and required product information. Port of frontend/src/app/admin/categories/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { AdminContext } from "../../core/admin";
import { api, ApiError, quietly } from "../../core/api";
import { GST_RATES, pct } from "../../core/format";
import { PageHeader, Table } from "../../shared/portal-shell";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Modal, Pill, Select, TextField, Toast } from "../../shared/ui/ui";
import { ImageField } from "../shared/media-picker";

type Cat = {
  id: string; name: string; slug: string; parent_id: string | null; image_url: string; commission_bps: number; default_gst_bps: number; position: number; is_active: boolean; required_details: string[];
  return_window_days: number; min_return_window_days: number;
};
const EMPTY = { name: "", parent_id: "", commission: "10", gst: 1800, position: "0", is_active: true, image_url: "", required: [] as string[], returnDays: "7", minReturnDays: "0" };
type Form = typeof EMPTY;

function returnPolicy(c: Cat): string {
  const days = c.return_window_days ? `${c.return_window_days} days` : "Not returnable";
  return c.min_return_window_days ? `${days}, at least ${c.min_return_window_days}` : days;
}

@Component({
  selector: "pc-admin-categories-page",
  imports: [PageHeader, Table, PageLoader, Button, ErrorNote, Field, Modal, Pill, Select, TextField, ImageField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!cats()) {
      <pc-page-loader />
    } @else {
      <div>
        <pc-page-header title="Categories" sub="Sellers list products in the most specific category. Commission, GST and returns here apply to that category." [withActions]="true">
          <button actions pcButton (click)="open('new')">Add category</button>
        </pc-page-header>
        <pc-table [head]="['Category', 'Commission', 'Default GST', 'Returns', 'Required information', 'Order', 'Status', '']">
          @for (row of ordered(); track row.c.id) {
            <tr>
              <td class="px-4 py-2.5" [style.padding-left.px]="16 + row.depth * 24">{{ row.depth ? "└ " : "" }}<span [class]="row.depth ? '' : 'font-semibold'">{{ row.c.name }}</span></td>
              <td class="px-4 py-2.5">{{ pct(row.c.commission_bps) }}</td>
              <td class="px-4 py-2.5">{{ pct(row.c.default_gst_bps) }}</td>
              <td class="px-4 py-2.5 text-sm">{{ policy(row.c) }}</td>
              <td class="px-4 py-2.5 text-sm text-ink-soft">{{ row.c.required_details.length ? row.c.required_details.length + " items" : "—" }}</td>
              <td class="px-4 py-2.5">{{ row.c.position }}</td>
              <td class="px-4 py-2.5">@if (row.c.is_active) {<pc-pill tone="green">Active</pc-pill>} @else {<pc-pill>Hidden</pc-pill>}</td>
              <td class="px-4 py-2.5"><button pcButton size="sm" variant="ghost" (click)="open(row.c)">Edit</button></td>
            </tr>
          }
        </pc-table>
        <pc-modal [open]="editing() !== null" (close)="editing.set(null)" [title]="editing() === 'new' ? 'Add category' : 'Edit category'">
          <form (submit)="save($event)" class="flex flex-col gap-3">
            <pc-error-note [message]="error()" />
            <pc-text-field label="Name" [value]="f().name" (valueChange)="set('name', $event)" [required]="true" />
            @if (canMedia()) {
              <pc-image-field label="Image" [value]="f().image_url" (valueChange)="set('image_url', $event)" aspect="aspect-square" hint="Shown on the home page category row" />
            } @else if (f().image_url) {
              <p class="text-sm text-ink-faint">This category has an image; it is kept when you save.</p>
            }
            <pc-field label="Parent" for="parent">
              <select pcSelect id="parent" (change)="set('parent_id', $any($event.target).value)">
                <option value="" [selected]="f().parent_id === ''">None (top level)</option>
                @for (row of parents(); track row.c.id) {<option [value]="row.c.id" [selected]="row.c.id === f().parent_id">{{ "— ".repeat(row.depth) }}{{ row.c.name }}</option>}
              </select>
            </pc-field>
            <div class="grid grid-cols-2 gap-3">
              <pc-text-field label="Commission %" inputmode="decimal" [value]="f().commission" (valueChange)="set('commission', $event)" [required]="true" />
              <pc-field label="Default GST" for="gst">
                <select pcSelect id="gst" (change)="set('gst', +$any($event.target).value)">@for (r of gstRates; track r) {<option [value]="r" [selected]="r === f().gst">{{ pct(r) }}</option>}</select>
              </pc-field>
              <pc-text-field label="Display order" inputmode="numeric" [value]="f().position" (valueChange)="set('position', $event)" />
              <label class="flex items-center gap-2 pt-6"><input type="checkbox" class="accent-peacock" [checked]="f().is_active" (change)="set('is_active', $any($event.target).checked)" /> Visible</label>
            </div>
            <fieldset class="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
              <legend class="px-1 text-sm font-semibold">Returns</legend>
              <pc-text-field label="Return window (days)" inputmode="numeric" [value]="f().returnDays" (valueChange)="set('returnDays', $event)" hint="New listings start with this. 0 means not returnable." [required]="true" />
              <pc-text-field label="Shortest window sellers may set" inputmode="numeric" [value]="f().minReturnDays" (valueChange)="set('minReturnDays', $event)" hint="Days. Listings below it move up to it when you save." [required]="true" />
              <p class="text-xs text-ink-faint sm:col-span-2">Up to 30 days. Damaged, faulty or wrong items can always be returned for the period set in Settings.</p>
            </fieldset>
            <fieldset class="rounded-lg border border-line p-3">
              <legend class="px-1 text-sm font-semibold">Product information sellers must give</legend>
              <p class="mb-2 text-xs text-ink-faint">A listing in this category (or one inside it) cannot be sent for review until these are filled in. For packaged goods, Legal Metrology rules expect net quantity, manufacturer or packer, importer for imports and consumer care details; add FSSAI licence for food.</p>
              <div class="grid gap-1.5 sm:grid-cols-2">
                @for (o of options(); track o[0]) {
                  <label class="flex items-start gap-2 text-sm">
                    <input type="checkbox" class="mt-1 accent-peacock" [checked]="inherited().includes(o[0]) || f().required.includes(o[0])" [disabled]="inherited().includes(o[0])"
                      (change)="toggle(o[0], $any($event.target).checked)" />
                    <span>{{ o[1] }}@if (inherited().includes(o[0])) {<span class="text-xs text-ink-faint"> (from the parent category)</span>}</span>
                  </label>
                }
              </div>
            </fieldset>
            <button pcButton type="submit">Save category</button>
          </form>
        </pc-modal>
      </div>
    }
  `,
})
export class AdminCategoriesPage {
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly canMedia = computed(() => this.admin.can("marketing"));
  protected readonly pct = pct;
  protected readonly policy = returnPolicy;
  protected readonly gstRates = GST_RATES;
  protected readonly cats = signal<Cat[] | null>(null);
  protected readonly editing = signal<Cat | "new" | null>(null);
  protected readonly f = signal<Form>(EMPTY);
  protected readonly error = signal<string | null>(null);
  private readonly opts = signal<Record<string, string>>({});
  protected readonly options = computed(() => Object.entries(this.opts()));
  protected readonly ordered = computed(() => {
    const cats = this.cats();
    if (!cats) return [];
    const out: { c: Cat; depth: number }[] = [];
    const walk = (pid: string | null, depth: number) => cats.filter((c) => c.parent_id === pid).forEach((c) => { out.push({ c, depth }); walk(c.id, depth + 1); });
    walk(null, 0);
    return out;
  });
  protected readonly parents = computed(() => {
    const e = this.editing();
    return this.ordered().filter(({ c }) => e === "new" || c.id !== (e as Cat | null)?.id);
  });
  // what a category inherits from its parents
  protected readonly inherited = computed(() => {
    const cats = this.cats();
    const out: string[] = [];
    let cur = cats?.find((c) => c.id === (this.f().parent_id || null));
    while (cur) {
      out.push(...cur.required_details);
      const parent: string | null = cur.parent_id;
      cur = cats?.find((c) => c.id === parent);
    }
    return out;
  });

  constructor() {
    this.load();
    api<{ options: Record<string, string> }>("/api/admin/categories/requirements").then((r) => this.opts.set(r.options)).catch(quietly);
  }

  private load(): void {
    api<Cat[]>("/api/admin/categories").then((c) => this.cats.set(c)).catch(quietly);
  }

  protected set<K extends keyof Form>(k: K, v: Form[K]): void {
    this.f.update((f) => ({ ...f, [k]: v }));
  }

  protected toggle(k: string, on: boolean): void {
    const req = this.f().required;
    this.set("required", on ? [...req, k] : req.filter((x) => x !== k));
  }

  protected open(c: Cat | "new"): void {
    this.error.set(null);
    this.editing.set(c);
    this.f.set(c === "new" ? EMPTY : {
      name: c.name, parent_id: c.parent_id ?? "", commission: String(c.commission_bps / 100), gst: c.default_gst_bps, position: String(c.position), is_active: c.is_active,
      image_url: c.image_url, required: c.required_details ?? [], returnDays: String(c.return_window_days), minReturnDays: String(c.min_return_window_days),
    });
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    this.error.set(null);
    const f = this.f();
    const editing = this.editing();
    const body = {
      name: f.name, parent_id: f.parent_id || null, commission_bps: Math.round(parseFloat(f.commission) * 100), default_gst_bps: f.gst, position: Number(f.position) || 0,
      is_active: f.is_active, image_url: f.image_url, required_details: f.required, return_window_days: Number(f.returnDays), min_return_window_days: Number(f.minReturnDays),
    };
    try {
      if (editing === "new") await api("/api/admin/categories", { method: "POST", body });
      else if (editing) await api(`/api/admin/categories/${editing.id}`, { method: "PUT", body });
      this.toast.show("Category saved");
      this.editing.set(null);
      this.load();
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save");
    }
  }
}
