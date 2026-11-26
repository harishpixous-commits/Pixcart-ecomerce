/* Bulk upload: download the CSV template, upload it, check it (dry run) and create the drafts. Port of frontend/src/app/seller/products/import/page.tsx. */

import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { CheckCircle2, Download, FileUp, XCircle } from "lucide-angular";
import { ApiError, api, downloadFile } from "../../core/api";
import { PageHeader, Table } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, Pill } from "../../shared/ui/ui";

type Row = { key: string; row: number; title: string; category: string; variants: number; errors: string[] };
type Result = { dry_run: boolean; file_errors: { row: number; error: string }[]; products: Row[]; valid: number; invalid: number; created: { key: string; id: string; title: string }[] };

@Component({
  selector: "pc-seller-products-import-page",
  imports: [PageHeader, Table, Icon, PcLink, Button, ErrorNote, Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div class="flex max-w-5xl flex-col gap-4">
      <pc-page-header [back]="{ href: '/seller/products', label: 'Products' }" title="Bulk upload listings" sub="Add many products at once from a spreadsheet. Products are saved as drafts; add photos to each and submit them for review." />
      <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 class="text-lg font-semibold">1. Fill in the template</h2>
        <p class="text-sm text-ink-soft">One row per product option (size, colour). Rows with the same <code class="rounded bg-mist px-1">product_key</code> become one product; product details are read from its first row. Prices are in rupees, the category is a sub-category name exactly as shown in the listing form, GST rate is a percentage (leave empty for the category default). Up to 300 products and 2,000 rows per file.</p>
        <button pcButton variant="secondary" class="self-start" (click)="template()"><svg [pcIcon]="Download" class="h-4 w-4" /> Download template</button>
      </section>
      <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 class="text-lg font-semibold">2. Upload and check</h2>
        <label class="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-peacock/40 p-5 hover:bg-peacock-light">
          <svg [pcIcon]="FileUp" class="h-6 w-6 text-peacock" />
          <span><span class="font-semibold">{{ file() ? file()!.name : "Choose a CSV file" }}</span><br /><span class="text-sm text-ink-soft">Save from Excel or Google Sheets as &quot;CSV UTF-8&quot;</span></span>
          <input type="file" accept=".csv,text/csv" class="sr-only" (change)="pick($event)" />
        </label>
        <pc-error-note [message]="error()" />
        <div class="flex flex-wrap gap-2">
          <button pcButton (click)="send(true)" [loading]="busy() === 'check'" [disabled]="!file()">Check file</button>
          @if (res()?.dry_run && res()!.valid > 0) {
            <button pcButton variant="buy" (click)="send(false)" [loading]="busy() === 'create'">Create {{ res()!.valid }} draft{{ res()!.valid === 1 ? "" : "s" }}</button>
          }
        </div>
      </section>
      @if (res(); as r) {
        <section class="flex flex-col gap-3">
          @for (e of r.file_errors; track $index) {<pc-error-note [message]="e.row ? 'Row ' + e.row + ': ' + e.error : e.error" />}
          @if (!r.dry_run) {
            <div class="rounded-xl bg-leaf-light p-4">
              <p class="font-semibold">{{ r.created.length }} draft{{ r.created.length === 1 ? "" : "s" }} created{{ r.invalid ? "; " + r.invalid + " skipped because of the problems below" : "" }}.</p>
              <ul class="mt-1 flex flex-col gap-0.5 text-sm">@for (c of r.created.slice(0, 20); track c.id) {<li><a [pcLink]="'/seller/products/' + c.id" class="text-peacock hover:underline">{{ c.title }}</a>: add photos and submit</li>}</ul>
            </div>
          }
          @if (r.products.length > 0) {
            <pc-table [head]="head">
              @for (p of r.products; track p.key) {
                <tr class="align-top">
                  <td class="px-3 py-2">@if (p.errors.length) {<svg [pcIcon]="XCircle" class="h-5 w-5 text-vermilion" [ariaHidden]="null" aria-label="Has problems" />} @else {<svg [pcIcon]="CheckCircle2" class="h-5 w-5 text-leaf" [ariaHidden]="null" aria-label="Ready" />}</td>
                  <td class="px-3 py-2"><p class="font-medium">{{ p.title || p.key }}</p><p class="text-xs text-ink-faint">{{ p.key }}, from row {{ p.row }}</p></td>
                  <td class="px-3 py-2 text-sm">{{ p.category }}</td>
                  <td class="px-3 py-2">{{ p.variants }}</td>
                  <td class="px-3 py-2 text-sm">@if (p.errors.length) {<ul class="list-disc pl-4 text-vermilion">@for (e of p.errors; track e) {<li>{{ e }}</li>}</ul>} @else {<pc-pill tone="green">Ready</pc-pill>}</td>
                </tr>
              }
            </pc-table>
          }
        </section>
      }
    </div>
  `,
})
export class SellerProductsImportPage {
  protected readonly Download = Download;
  protected readonly FileUp = FileUp;
  protected readonly XCircle = XCircle;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly head = ["", "Product", "Category", "Options", "Problems"];
  protected readonly file = signal<File | null>(null);
  protected readonly res = signal<Result | null>(null);
  protected readonly busy = signal<"check" | "create" | null>(null);
  protected readonly error = signal<string | null>(null);

  protected template(): void {
    downloadFile("/api/seller/products/import-template.csv", undefined, "listing-upload-template.csv").catch(() => {});
  }

  protected pick(e: Event): void {
    this.file.set((e.target as HTMLInputElement).files?.[0] ?? null);
    this.res.set(null);
  }

  protected async send(dry: boolean): Promise<void> {
    const file = this.file();
    if (!file) return;
    this.busy.set(dry ? "check" : "create");
    this.error.set(null);
    try {
      const form = new FormData();
      form.append("file", file);
      this.res.set(await api<Result>("/api/seller/products/import", { method: "POST", form, query: { dry_run: dry } }));
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      this.busy.set(null);
    }
  }
}
