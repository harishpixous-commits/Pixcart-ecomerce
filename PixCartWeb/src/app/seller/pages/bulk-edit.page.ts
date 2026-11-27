/* Bulk edit: pick product options, choose price / stock / on-off, preview, apply. Port of frontend/src/app/seller/bulk-edit/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, signal } from "@angular/core";
import { ApiError, api, downloadFile } from "../../core/api";
import { PageHeader } from "../../shared/portal-shell";
import { Button, ErrorNote } from "../../shared/ui/ui";

type Item = { variant_id: string; title: string; sku: string; label: string; total: number; is_active: boolean };
type Row = { id: string; sku: string | null; ok: boolean; reason: string | null; before?: number | boolean; after?: number | boolean };
type CsvRow = { row: number; id: string; sku: string | null; ok: boolean; reason: string | null; changes: Record<string, { before: number | boolean; after: number | boolean }> };
type CsvResult = { dry_run: boolean; changed: number; skipped: number; rows: CsvRow[] };
type Result = { dry_run: boolean; changed: number; skipped: number; rows: Row[] };

@Component({
  selector: "pc-seller-bulk-edit-page",
  imports: [PageHeader, Button, ErrorNote],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div class="flex max-w-5xl flex-col gap-4">
      <pc-page-header [back]="{ href: '/seller/inventory', label: 'Inventory' }" title="Bulk edit" sub="Pick product options, choose a change and preview it before applying. Options in a running deal keep their price." />
      <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
        <input class="rounded-lg border px-3 py-2 text-sm" placeholder="Search title or SKU" [value]="q()" (input)="search($event)" />
        <ul class="max-h-80 overflow-auto text-sm">
          @for (i of items(); track i.variant_id) {
            <li class="flex items-center gap-2 border-b py-1.5">
              <input type="checkbox" [checked]="picked().has(i.variant_id)" (change)="toggle(i.variant_id)" [attr.aria-label]="'Select ' + i.title + ' ' + i.sku" />
              <span class="flex-1">{{ i.title }} <span class="text-ink-faint">{{ i.label }} ({{ i.sku }})</span></span>
              <span>{{ i.total }} in stock{{ i.is_active ? "" : ", off" }}</span>
            </li>
          }
        </ul>
      </section>
      <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
        <div class="flex flex-wrap items-center gap-2">
          <select class="rounded-lg border px-3 py-2 text-sm" [value]="action()" (change)="setAction($event)">
            @for (a of actions; track a[0]) {<option [value]="a[0]">{{ a[1] }}</option>}
          </select>
          @if (needsValue()) {
            <input class="w-28 rounded-lg border px-3 py-2 text-sm" inputmode="numeric" placeholder="Number" [value]="value()" (input)="setValue($event)" />
          }
          <span class="text-sm text-ink-soft">{{ picked().size }} selected</span>
        </div>
        <pc-error-note [message]="error()" />
        <div class="flex gap-2">
          <button pcButton (click)="run(true)" [loading]="busy() === 'preview'" [disabled]="!ready()">Preview</button>
          @if (res()?.dry_run && res()!.changed > 0) {
            <button pcButton variant="buy" (click)="run(false)" [loading]="busy() === 'apply'">Apply to {{ res()!.changed }}</button>
          }
        </div>
        @if (res(); as r) {
          <div class="text-sm">
            <p class="font-semibold">{{ r.dry_run ? "Would change" : "Changed" }} {{ r.changed }}, skipped {{ r.skipped }}.</p>
            <ul class="mt-1 max-h-60 overflow-auto">
              @for (x of r.rows; track x.id) {<li>{{ x.sku ?? x.id }}: {{ x.ok ? x.before + " to " + x.after : "skipped (" + (x.reason ?? "").replaceAll("_", " ") + ")" }}</li>}
            </ul>
          </div>
        }
      </section>
      <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 class="font-semibold">Or edit in a spreadsheet</h2>
        <p class="text-sm text-ink-soft">Download all your options, change price (in rupees), stock or active (yes/no), then upload the file. Leave a cell blank to keep it. If you add rows of your own, leave the id blank and fill the sku. Check it first, then apply.</p>
        <div class="flex flex-wrap items-center gap-2">
          <button pcButton variant="secondary" (click)="downloadCsv()">Download CSV</button>
          <input type="file" accept=".csv,text/csv" aria-label="Edited CSV file" class="text-sm" (change)="pickFile($event)" />
          <button pcButton (click)="sendCsv(true)" [loading]="csvBusy() === 'check'" [disabled]="!file()">Check file</button>
          @if (csv()?.dry_run && csv()!.changed > 0) {
            <button pcButton variant="buy" (click)="sendCsv(false)" [loading]="csvBusy() === 'apply'">Apply to {{ csv()!.changed }}</button>
          }
        </div>
        @if (csv(); as c) {
          <div class="text-sm">
            <p class="font-semibold">{{ c.dry_run ? "Would change" : "Changed" }} {{ c.changed }}, skipped {{ c.skipped }}.</p>
            <ul class="mt-1 max-h-60 overflow-auto">
              @for (x of c.rows; track x.row) {<li>Row {{ x.row }} {{ x.sku ?? "" }}: {{ x.ok ? describe(x) : "skipped (" + (x.reason ?? "").replaceAll("_", " ") + ")" }}</li>}
            </ul>
          </div>
        }
      </section>
    </div>
  `,
})
export class SellerBulkEditPage {
  protected readonly actions: [string, string, boolean][] = [
    ["price_percent", "Change price by %", true],
    ["stock_set", "Set stock to", true],
    ["stock_add", "Add to stock", true],
    ["activate", "Switch on", false],
    ["deactivate", "Switch off", false],
  ];
  protected readonly q = signal("");
  protected readonly items = signal<Item[]>([]);
  protected readonly picked = signal<Set<string>>(new Set());
  protected readonly action = signal("price_percent");
  protected readonly value = signal("");
  protected readonly res = signal<Result | null>(null);
  protected readonly busy = signal<"preview" | "apply" | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly needsValue = computed(() => this.actions.find((a) => a[0] === this.action())?.[2] ?? false);
  protected readonly ready = computed(() => this.picked().size > 0 && (!this.needsValue() || (this.value().trim() !== "" && Number.isFinite(Number(this.value())))));

  protected readonly file = signal<File | null>(null);
  protected readonly csv = signal<CsvResult | null>(null);
  protected readonly csvBusy = signal<"check" | "apply" | null>(null);

  protected downloadCsv(): void {
    downloadFile("/api/seller/variants/bulk-edit.csv", undefined, "my-versions.csv").catch(() => {});
  }

  protected pickFile(e: Event): void {
    this.file.set((e.target as HTMLInputElement).files?.[0] ?? null);
    this.csv.set(null);
  }

  protected describe(r: CsvRow): string {
    return Object.entries(r.changes)
      .map(([k, c]) => (k === "price" ? `price ₹${(Number(c.before) / 100).toFixed(2)} to ₹${(Number(c.after) / 100).toFixed(2)}` : `${k} ${String(c.before)} to ${String(c.after)}`))
      .join(", ");
  }

  protected async sendCsv(dry: boolean): Promise<void> {
    const file = this.file();
    if (!file) return;
    this.csvBusy.set(dry ? "check" : "apply");
    this.error.set(null);
    try {
      const form = new FormData();
      form.append("file", file);
      this.csv.set(await api<CsvResult>("/api/seller/variants/bulk-edit.csv", { method: "POST", form, query: { dry_run: dry } }));
      if (!dry) void this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      this.csvBusy.set(null);
    }
  }

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.items.set((await api<{ items: Item[] }>("/api/seller/inventory", { query: { q: this.q() } })).items);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not load products");
    }
  }

  protected search(e: Event): void {
    this.q.set((e.target as HTMLInputElement).value);
    void this.load();
  }

  protected toggle(id: string): void {
    const n = new Set(this.picked());
    if (n.has(id)) n.delete(id);
    else n.add(id);
    this.picked.set(n);
    this.res.set(null);
  }

  protected setAction(e: Event): void {
    this.action.set((e.target as HTMLSelectElement).value);
    this.res.set(null);
  }

  protected setValue(e: Event): void {
    this.value.set((e.target as HTMLInputElement).value);
    this.res.set(null);
  }

  protected async run(dry: boolean): Promise<void> {
    this.busy.set(dry ? "preview" : "apply");
    this.error.set(null);
    try {
      const body = { variant_ids: [...this.picked()], action: this.action(), value: this.needsValue() ? Number(this.value()) : null, dry_run: dry };
      this.res.set(await api<Result>("/api/seller/variants/bulk-edit", { method: "POST", body }));
      if (!dry) void this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Bulk edit failed");
    } finally {
      this.busy.set(null);
    }
  }
}
