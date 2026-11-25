/*
 * Stock per warehouse: edit a cell (set, add, remove, move), stock history, CSV export and import.
 * Port of frontend/src/app/seller/inventory/page.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { Download, History, Upload } from "lucide-angular";
import { ApiError, api, downloadFile, latestOnly, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { RouteState } from "../../core/route-state";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, Pagination, Select, TextField, Toast } from "../../shared/ui/ui";

type Grid = {
  warehouses: { id: string; code: string; name: string; is_active: boolean }[];
  items: { variant_id: string; title: string; sku: string; label: string; total: number; is_active: boolean; levels: Record<string, number | undefined> }[];
  total: number;
  page: number;
  page_size: number;
  /** "low stock" means this many or fewer (Admin → Marketplace settings) */
  low_stock_threshold?: number;
};
type Item = Grid["items"][number];
type Move = { at: string; warehouse: string; kind: string; delta: number; balance: number; reference: string; note: string };
type Mode = "set" | "add" | "remove" | "transfer";

const KIND: Record<string, string | undefined> = { set: "Set", adjust: "Adjusted", sale: "Sold", release: "Cancelled order", return: "Return received", transfer: "Transfer" };
const MODES: Mode[] = ["set", "add", "remove", "transfer"];
const MODE_LABEL: Record<Mode, string> = { set: "Set to", add: "Add", remove: "Remove", transfer: "Move" };

@Component({
  selector: "pc-seller-inventory-page",
  imports: [PageHeader, Icon, PageLoader, Button, EmptyState, ErrorNote, Field, Input, Modal, Pagination, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div>
      <pc-page-header title="Inventory" sub="Stock per warehouse. Orders are shipped from the warehouse closest to the customer that has the items." [withActions]="true">
        <ng-container ngProjectAs="[actions]">
          <button pcButton variant="secondary" (click)="exportCsv()"><svg [pcIcon]="Download" class="h-4 w-4" /> Export CSV</button>
          <label class="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-peacock px-4 font-semibold text-white hover:bg-peacock-dark">
            <svg [pcIcon]="Upload" class="h-4 w-4" /> Import CSV
            <input type="file" accept=".csv,text/csv" class="sr-only" (change)="onFile($event)" />
          </label>
        </ng-container>
      </pc-page-header>
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <input pcInput placeholder="Search by title or SKU" [value]="q()" (input)="search($any($event.target).value)" class="max-w-sm" aria-label="Search stock" />
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="accent-peacock" [checked]="low()" (change)="toggleLow($any($event.target).checked)" /> Only {{ threshold() }} or fewer left</label>
      </div>
      @if (importResult(); as r) {
        <div class="mb-3 rounded-xl bg-white p-4 text-sm">
          <p class="font-semibold">{{ r.updated }} rows updated{{ r.errors.length ? ", " + r.errors.length + " rows skipped" : "" }}.</p>
          @for (e of r.errors.slice(0, 10); track e.row) {<p class="text-vermilion">Row {{ e.row }}: {{ e.error }}</p>}
          <p class="mt-1 text-ink-faint">Columns: sku, warehouse_code, quantity. Quantities replace the current stock.</p>
        </div>
      }
      @if (!g()) {
        <pc-page-loader />
      } @else if (g()!.items.length === 0) {
        <pc-empty-state title="No products here" [hasAction]="false" />
      } @else {
        <div class="overflow-x-auto rounded-xl bg-white">
          <table class="w-full min-w-[720px] text-left text-[15px]">
            <thead class="border-b border-line text-sm text-ink-faint">
              <tr>
                <th class="px-4 py-2.5 font-medium">Product</th>
                @for (w of g()!.warehouses; track w.id) {<th class="px-3 py-2.5 text-right font-medium">{{ w.code }}{{ !w.is_active ? " (off)" : "" }}</th>}
                <th class="px-4 py-2.5 text-right font-medium">Available</th>
                <th></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (it of g()!.items; track it.variant_id) {
                <tr>
                  <td class="px-4 py-2.5">
                    <p class="line-clamp-1 font-medium">{{ it.title }}</p>
                    <p class="text-sm text-ink-faint">{{ it.sku }}{{ it.label ? ", " + it.label : "" }}</p>
                  </td>
                  @for (w of g()!.warehouses; track w.id) {
                    <td class="px-3 py-2.5 text-right">
                      <button class="rounded px-2 py-1 font-semibold hover:bg-peacock-light" (click)="openEdit(it, w.id)">{{ it.levels[w.id] ?? 0 }}</button>
                    </td>
                  }
                  <td [class]="it.total <= threshold() ? 'px-4 py-2.5 text-right font-semibold text-vermilion' : 'px-4 py-2.5 text-right font-semibold'">{{ it.total }}</td>
                  <td class="px-2 py-2.5">
                    <button aria-label="Stock history" class="rounded p-1.5 text-ink-faint hover:bg-mist" (click)="history(it)">
                      <svg [pcIcon]="History" class="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <pc-pagination [page]="g()!.page" [pageSize]="g()!.page_size" [total]="g()!.total" (pageChange)="page.set($event)" />
        </div>
      }
      <pc-modal [open]="!!edit()" (close)="edit.set(null)" title="Update stock">
        @if (edit(); as edit) {
          @if (g(); as g) {
            <div class="flex flex-col gap-3">
              <p class="text-ink-soft">{{ edit.variant.title }} ({{ edit.variant.sku }}) at {{ whName(edit.wh) }}: <strong>{{ edit.variant.levels[edit.wh] ?? 0 }}</strong> now</p>
              <pc-error-note [message]="error()" />
              <div class="grid grid-cols-4 gap-1 rounded-lg bg-mist p-1 text-sm">
                @for (m of modes; track m) {
                  <button (click)="mode.set(m)" [disabled]="m === 'transfer' && g.warehouses.length < 2" [class]="mode() === m ? 'rounded-md bg-white py-1.5 font-semibold text-peacock shadow-sm' : 'py-1.5 text-ink-soft disabled:opacity-40'">{{ modeLabel[m] }}</button>
                }
              </div>
              <pc-text-field label="Quantity" inputmode="numeric" [(value)]="qty" [filter]="digitsOnly" />
              @if (mode() === "transfer") {
                <pc-field label="Move to" for="to">
                  <select pcSelect id="to" (change)="to.set($any($event.target).value)">
                    @for (w of others(); track w.id) {<option [value]="w.id" [selected]="w.id === to()">{{ w.code }}, {{ w.name }}</option>}
                  </select>
                </pc-field>
              } @else {
                <pc-text-field label="Note (optional)" [(value)]="note" placeholder="e.g. damaged in storage, new stock arrived" />
              }
              <button pcButton (click)="save()">Save</button>
            </div>
          }
        }
      </pc-modal>
      <pc-modal [open]="!!moves()" (close)="moves.set(null)" title="Stock history" [wide]="true">
        @if (moves(); as moves) {
          <div>
            <p class="mb-2 text-ink-soft">{{ moves.title }}</p>
            <table class="w-full text-sm">
              <thead class="text-ink-faint"><tr><th class="py-1 text-left">When</th><th class="text-left">Warehouse</th><th class="text-left">What</th><th class="text-right">Change</th><th class="text-right">After</th></tr></thead>
              <tbody>
                @for (m of moves.items; track $index) {
                  <tr class="border-t border-line">
                    <td class="py-1">{{ dateTime(m.at) }}</td><td>{{ m.warehouse }}</td>
                    <td>{{ kind[m.kind] ?? m.kind }}{{ m.reference ? " " + m.reference : "" }}{{ m.note ? ": " + m.note : "" }}</td>
                    <td [class]="m.delta < 0 ? 'text-right text-vermilion' : 'text-right text-leaf'">{{ m.delta > 0 ? "+" + m.delta : m.delta }}</td>
                    <td class="text-right">{{ m.balance }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </pc-modal>
    </div>
  `,
})
export class SellerInventoryPage {
  private readonly router = inject(Router);
  private readonly route = inject(RouteState);
  private readonly toast = inject(Toast);
  protected readonly Download = Download;
  protected readonly Upload = Upload;
  protected readonly History = History;
  protected readonly modes = MODES;
  protected readonly modeLabel = MODE_LABEL;
  protected readonly kind = KIND;
  protected readonly dateTime = dateTime;
  protected readonly digitsOnly = (v: string) => v.replace(/\D/g, "");

  protected readonly low = computed(() => this.route.params().get("low_stock") === "1");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly g = signal<Grid | null>(null);
  protected readonly edit = signal<{ variant: Item; wh: string } | null>(null);
  protected readonly mode = signal<Mode>("set");
  protected readonly qty = signal("");
  protected readonly to = signal("");
  protected readonly note = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly moves = signal<{ title: string; items: Move[] } | null>(null);
  protected readonly importResult = signal<{ updated: number; errors: { row: number; error: string }[] } | null>(null);
  protected readonly threshold = computed(() => this.g()?.low_stock_threshold ?? 5);
  protected readonly others = computed(() => {
    const e = this.edit();
    return (this.g()?.warehouses ?? []).filter((w) => w.id !== e?.wh);
  });
  private readonly track = latestOnly();

  constructor() {
    effect((onCleanup) => {
      const q = this.q();
      this.page();
      this.low();
      const t = setTimeout(() => this.load(), q ? 250 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  private load(): void {
    void this.track(api<Grid>("/api/seller/inventory", { query: { q: this.q(), page: this.page(), low_stock: this.low() || undefined } }), (g) => this.g.set(g));
  }

  protected search(v: string): void {
    this.q.set(v);
    this.page.set(1);
  }

  protected toggleLow(checked: boolean): void {
    void this.router.navigateByUrl(checked ? "/seller/inventory?low_stock=1" : "/seller/inventory");
  }

  protected whName(id: string): string | undefined {
    return this.g()?.warehouses.find((w) => w.id === id)?.name;
  }

  protected openEdit(it: Item, wh: string): void {
    this.edit.set({ variant: it, wh });
    this.mode.set("set");
    this.qty.set(String(it.levels[wh] ?? 0));
    this.note.set("");
    this.error.set(null);
    this.to.set(this.g()?.warehouses.find((x) => x.id !== wh)?.id ?? "");
  }

  protected history(it: Item): void {
    api<{ items: Move[] }>(`/api/seller/inventory/${it.variant_id}/movements`).then((r) => this.moves.set({ title: `${it.title} (${it.sku})`, items: r.items })).catch(quietly);
  }

  protected async save(): Promise<void> {
    const edit = this.edit();
    if (!edit) return;
    this.error.set(null);
    const n = Number(this.qty());
    if (!Number.isInteger(n) || n < 0) return void this.error.set("Enter a whole number");
    try {
      if (this.mode() === "transfer") {
        await api("/api/seller/inventory/transfer", { method: "POST", body: { variant_id: edit.variant.variant_id, from_warehouse_id: edit.wh, to_warehouse_id: this.to(), quantity: n } });
      } else {
        await api("/api/seller/inventory/adjust", { method: "POST", body: { variant_id: edit.variant.variant_id, warehouse_id: edit.wh, mode: this.mode(), quantity: n, note: this.note() } });
      }
      this.toast.show("Stock updated");
      this.edit.set(null);
      this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not update stock");
    }
  }

  protected onFile(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void this.upload(file);
  }

  private async upload(file: File): Promise<void> {
    const form = new FormData();
    form.append("file", file);
    try {
      this.importResult.set(await api("/api/seller/inventory/import", { method: "POST", form }));
      this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Import failed", "error");
    }
  }

  protected async exportCsv(): Promise<void> {
    try {
      await downloadFile("/api/seller/exports/stock.csv", undefined, "stock.csv");
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Export failed", "error");
    }
  }
}
