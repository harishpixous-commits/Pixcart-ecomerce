/*
 * The seller's listing form (add and edit): basic details with the AI listing writer, photos, videos, versions with
 * options, price/stock/net quantity, tax and returns, specifications and the category's product information; saves as a
 * draft or submits for review. Port of frontend/src/components/product-editor.tsx:
 *   <pc-product-editor />                                      (a new product)
 *   <pc-product-editor [product]="p" (saved)="p = $event" />   (edit)
 */

import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, input, output, signal } from "@angular/core";
import { Router } from "@angular/router";
import { ArrowLeft, ArrowRight, ImagePlus, Plus, Sparkles, Trash2, X } from "lucide-angular";
import { ApiError, api, quietly } from "../../core/api";
import { GST_RATES, paiseToInput, pct, rupees, toPaise } from "../../core/format";
import { SiteService } from "../../core/site";
import type { ProductDetails, ProductVideo, SellerCategory, SellerProduct } from "../../core/types";
import { PageHeader } from "../../shared/portal-shell";
import { AiBadge } from "../../shared/portal/ai";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, Field, Input, Modal, Select, StatusPill, TextField, Textarea, Toast } from "../../shared/ui/ui";
import { EMPTY_DETAILS, ProductInfoSection, UNIT_LABEL } from "./product-info-editor";
import { VideoEditor } from "./video-editor";

type VRow = { id?: string; key: string; sku: string; options: Record<string, string>; mrp: string; price: string; stock: string; weight: string; net: string; is_active: boolean };
type Fees = { commission_gst_bps: number; tcs_bps: number; tds_bps: number };
type AiResult = { title: string; description: string; highlights: string[]; specs: Record<string, string>; missing: string[]; run_id: string; mode: "live" | "sandbox" };

/** What a sale at this price pays, at the rates the marketplace sets (the same ones the payout statement uses). */
function feeNote(price: number, commissionBps: number, f: Fees): string {
  const gst = f.commission_gst_bps > 0 ? ` plus ${pct(f.commission_gst_bps)} GST on the commission` : "";
  const held = [f.tcs_bps > 0 && `TCS (${pct(f.tcs_bps)})`, f.tds_bps > 0 && `TDS (${pct(f.tds_bps)})`].filter(Boolean);
  const tax = held.length ? ` ${held.join(" and ")} ${held.length > 1 ? "are" : "is"} also deducted and can be claimed back in your returns.` : "";
  return `On a sale at ${rupees(price)}, commission is ${rupees(Math.round((price * commissionBps) / 10000))}${gst}.${tax}`;
}

let keySeq = 0;
const newKey = () => `v${++keySeq}`;

function rowFrom(v: SellerProduct["variants"][number]): VRow {
  return { id: v.id, key: newKey(), sku: v.sku, options: v.options, mrp: paiseToInput(v.mrp_paise), price: paiseToInput(v.price_paise), stock: String(v.stock), weight: String(v.weight_grams),
    net: v.net_qty != null ? String(v.net_qty) : "", is_active: v.is_active };
}

function unitPreview(price: number, qty: number, unit: string): string {
  const [base, per] = unit === "g" ? (qty >= 1000 ? [1000, "kg"] : [100, "100 g"]) : unit === "ml" ? (qty >= 1000 ? [1000, "l"] : [100, "100 ml"])
    : unit === "pcs" ? [1, "piece"] : [1, unit];
  return `${rupees(Math.round((price * (base as number)) / qty))}/${per}`;
}

const STATUS_TEXT: Record<string, string> = {
  draft: "Draft: not visible to customers until you submit it for review.",
  pending: "In review: our team checks new listings and content changes, usually within a day.",
  approved: "Live: customers can buy this. Price and stock changes go live at once; other edits send it back for review.",
  rejected: "Needs changes: fix the issue below and submit again.",
  archived: "Archived: hidden from customers.",
};

@Component({
  selector: "pc-product-editor",
  imports: [PageHeader, AiBadge, Icon, PcLink, Button, ErrorNote, Field, Input, Modal, Select, StatusPill, TextField, Textarea, ProductInfoSection, VideoEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4 pb-24" },
  template: `
    <pc-page-header [back]="{ href: '/seller/products', label: 'Products' }" [title]="product() ? 'Edit product' : 'Add a product'"
      [sub]="product() ? product()!.title : 'Fill in the details customers need to decide.'" [withActions]="!!product()">
      @if (product(); as p) {
        <ng-container ngProjectAs="[actions]">
          @if (p.status === "approved") {<a [pcLink]="'/p/' + p.slug" target="_blank" class="inline-flex h-10 items-center rounded-lg px-3 font-semibold text-peacock hover:bg-peacock-light">View on store</a>}
          @if (p.status === "archived") {<button pcButton variant="secondary" (click)="archive(true)">Restore</button>} @else {<button pcButton variant="ghost" (click)="archive(false)">Archive</button>}
        </ng-container>
      }
    </pc-page-header>
    @if (product(); as p) {
      <div class="flex flex-wrap items-center gap-3 rounded-xl bg-white p-4">
        <pc-status-pill [status]="p.status" />
        <p class="text-ink-soft">{{ statusText[p.status] }}</p>
        @if (p.status === "rejected" && p.rejection_reason) {<p class="w-full font-semibold text-vermilion">{{ p.rejection_reason }}</p>}
        @if ((p.missing_details?.length ?? 0) > 0) {
          <p class="w-full rounded-lg bg-marigold-light p-2 text-sm">
            <span class="font-semibold">Still needed for this category:</span> {{ p.missing_details!.join(", ") }}. <a href="#product-information" (click)="jump($event)" class="font-semibold text-peacock">Fill in</a>
          </p>
        }
      </div>
    }
    <pc-error-note [message]="error()" />

    <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
      <div class="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
        <h2 class="text-xl font-semibold">Basic details</h2>
        @if (site().features.ai) {
          <button pcButton type="button" variant="secondary" size="sm" (click)="aiOpen.set(true)"><svg [pcIcon]="Sparkles" class="h-4 w-4" /> Write with AI</button>
        }
      </div>
      <pc-field label="Category" for="cat" class="sm:col-span-2" [hint]="cat() ? 'Commission ' + pct(cat()!.commission_bps) + ' of the selling price' : undefined">
        <select pcSelect id="cat" (change)="pickCategory($any($event.target).value)" required>
          <option value="" [selected]="!categoryId()">Choose a category</option>
          @for (c of cats(); track c.id) {<option [value]="c.id" [selected]="c.id === categoryId()">{{ c.path }}</option>}
        </select>
      </pc-field>
      <pc-text-field class="sm:col-span-2" label="Product title" [(value)]="title" minlength="10" maxlength="200" [required]="true" hint="Brand, product type and key feature, e.g. 'Kavi Men's Cotton Slim Fit Casual Shirt'" />
      <pc-text-field label="Brand" [(value)]="brand" maxlength="80" />
      <pc-text-field label="Country of origin" [(value)]="origin" [required]="true" />
      <pc-field label="Description" class="sm:col-span-2" hint="At least 30 characters. Materials, size guidance, what is in the box.">
        <textarea pcTextarea [value]="description()" (input)="description.set($any($event.target).value)" rows="5" maxlength="10000"></textarea>
      </pc-field>
      <pc-field label="Highlights (one per line, up to 10)" class="sm:col-span-2">
        <textarea pcTextarea [value]="highlights()" (input)="highlights.set($any($event.target).value)" rows="3"></textarea>
      </pc-field>
    </section>

    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-xl font-semibold">Photos</h2>
      <p class="mb-3 text-sm text-ink-soft">Up to 8 photos, at least 200 × 200 pixels. The first photo is the main one. A plain white background works best.</p>
      <div class="flex flex-wrap gap-3">
        @for (src of images(); track src; let i = $index) {
          <div class="relative h-28 w-28 overflow-hidden rounded-lg border border-line bg-white">
            <img [src]="src" [alt]="'Photo ' + (i + 1)" class="h-full w-full object-contain" />
            @if (i === 0) {<span class="absolute left-1 top-1 rounded bg-peacock px-1.5 text-xs font-semibold text-white">Main</span>}
            <div class="absolute inset-x-0 bottom-0 flex justify-between bg-white/90 p-0.5">
              <button type="button" (click)="moveImage(i, -1)" aria-label="Move left" class="p-1 disabled:opacity-30" [disabled]="i === 0"><svg [pcIcon]="ArrowLeft" class="h-4 w-4" /></button>
              <button type="button" (click)="removeImage(src)" aria-label="Remove photo" class="p-1 text-vermilion"><svg [pcIcon]="X" class="h-4 w-4" /></button>
              <button type="button" (click)="moveImage(i, 1)" aria-label="Move right" class="p-1 disabled:opacity-30" [disabled]="i === images().length - 1"><svg [pcIcon]="ArrowRight" class="h-4 w-4" /></button>
            </div>
          </div>
        }
        @if (images().length < 8) {
          <label class="flex h-28 w-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-sm font-semibold text-peacock hover:border-peacock">
            <svg [pcIcon]="ImagePlus" class="h-6 w-6" />
            {{ uploading() ? "Uploading" : "Add photos" }}
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple class="sr-only" [disabled]="uploading()" (change)="pickImages($event)" />
          </label>
        }
      </div>
    </section>

    @if (site().features.product_videos !== false || videos().length > 0) {
      <section class="rounded-xl bg-white p-5">
        <h2 class="mb-1 text-xl font-semibold">Videos <span class="text-base font-normal text-ink-faint">(optional)</span></h2>
        <p class="mb-3 text-sm text-ink-soft">Customers watch these in the photo gallery on your product page.</p>
        <pc-video-editor [videos]="videos()" (videosChange)="videos.set($event)" videoUploadPath="/api/seller/videos" imageUploadPath="/api/seller/images"
          [maxVideos]="site().gallery?.max_videos ?? 3" [maxMb]="site().gallery?.max_video_mb ?? 50" [disabled]="site().features.product_videos === false" />
      </section>
    }

    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-xl font-semibold">Price, stock and options</h2>
      <p class="mb-3 text-sm text-ink-soft">Prices include GST. Add options such as Size or Colour if the product comes in more than one version.</p>
      <div class="mb-4 flex flex-col gap-3 rounded-lg bg-mist p-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-semibold">Option types:</span>
          @for (a of axes(); track $index; let i = $index) {
            <span class="inline-flex items-center gap-1 rounded-full bg-white py-1 pl-3 pr-1 text-sm">
              <input [value]="a" (input)="renameAxis(i, $any($event.target).value)" class="w-20 bg-transparent focus:outline-none" aria-label="Option name" />
              <button type="button" (click)="removeAxis(i)" [attr.aria-label]="'Remove ' + a" class="rounded-full p-0.5 hover:bg-mist"><svg [pcIcon]="X" class="h-3.5 w-3.5" /></button>
            </span>
          }
          @if (axes().length < 3) {
            <button pcButton type="button" variant="ghost" size="sm" (click)="addAxis()"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add option</button>
          }
        </div>
        @if (axes().length > 0) {
          <div class="flex flex-wrap items-end gap-2">
            @for (a of axes(); track $index) {
              <pc-field [label]="a + ' values'" hint="Comma separated, e.g. S, M, L">
                <input pcInput [value]="bulk()[a] ?? ''" (input)="setBulk(a, $any($event.target).value)" class="w-56" />
              </pc-field>
            }
            <button pcButton type="button" variant="secondary" (click)="generate()">Create versions</button>
          </div>
        }
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] text-left text-[15px]">
          <thead class="text-sm text-ink-faint">
            <tr>
              @for (a of axes(); track $index) {<th class="px-2 py-1 font-medium">{{ a }}</th>}
              <th class="px-2 py-1 font-medium">SKU</th>
              <th class="px-2 py-1 font-medium">MRP (₹)</th>
              <th class="px-2 py-1 font-medium">Selling price (₹)</th>
              <th class="px-2 py-1 font-medium">Stock</th>
              <th class="px-2 py-1 font-medium">Weight (g)</th>
              @if (details().net_unit) {<th class="px-2 py-1 font-medium">Net qty ({{ unitLabel[details().net_unit] }}){{ required().includes("net_quantity") ? " *" : "" }}</th>}
              <th class="px-2 py-1 font-medium">On sale</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (r of rows(); track r.key) {
              <tr class="align-top">
                @for (a of axes(); track $index) {
                  <td class="px-1 py-1"><input pcInput [value]="r.options[a] ?? ''" (input)="setOption(r, a, $any($event.target).value)" class="h-9 w-24" [attr.aria-label]="a" /></td>
                }
                <td class="px-1 py-1"><input pcInput [value]="r.sku" (input)="updateRow(r.key, { sku: $any($event.target).value })" class="h-9 w-36" aria-label="SKU" /></td>
                <td class="px-1 py-1"><input pcInput [value]="r.mrp" inputmode="decimal" (input)="updateRow(r.key, { mrp: $any($event.target).value })" class="h-9 w-24" aria-label="MRP" /></td>
                <td class="px-1 py-1">
                  <input pcInput [value]="r.price" inputmode="decimal" (input)="updateRow(r.key, { price: $any($event.target).value })" class="h-9 w-24" [invalid]="bad(r)" aria-label="Selling price" />
                  @if (bad(r)) {<p class="text-xs text-vermilion">More than MRP</p>} @else if (off(r) !== null) {<p class="text-xs text-leaf">{{ off(r) }}% off</p>}
                </td>
                <td class="px-1 py-1"><input pcInput [value]="r.stock" inputmode="numeric" (input)="updateRow(r.key, { stock: $any($event.target).value })" class="h-9 w-20" aria-label="Stock" /></td>
                <td class="px-1 py-1"><input pcInput [value]="r.weight" inputmode="numeric" (input)="updateRow(r.key, { weight: $any($event.target).value })" class="h-9 w-20" aria-label="Weight in grams" /></td>
                @if (details().net_unit) {
                  <td class="px-1 py-1">
                    <input pcInput [value]="r.net" inputmode="decimal" (input)="updateRow(r.key, { net: $any($event.target).value })" class="h-9 w-20" aria-label="Net quantity" />
                    @if (perUnit(r); as u) {<p class="text-[11px] text-ink-faint">{{ u }}</p>}
                  </td>
                }
                <td class="px-2 py-2"><input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="r.is_active" (change)="updateRow(r.key, { is_active: $any($event.target).checked })" aria-label="On sale" /></td>
                <td class="px-1 py-1">
                  @if (rows().length > 1) {<button type="button" (click)="removeRow(r.key)" class="p-2 text-ink-faint hover:text-vermilion" aria-label="Remove version"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <button pcButton type="button" variant="ghost" size="sm" class="mt-2" (click)="addRow()"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add a version</button>
      <p class="mt-1 text-xs text-ink-faint">
        Stock is the total you can sell from your warehouses that are switched on. With more than one warehouse, a change here goes to your main
        warehouse; to move stock or change another warehouse, use <a pcLink="/seller/inventory" class="font-semibold text-peacock hover:underline">Inventory</a>.
      </p>
      @if (fee(); as note) {<p class="mt-3 rounded-lg bg-peacock-light p-3 text-sm text-peacock">{{ note }}</p>}
    </section>

    <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-3">
      <h2 class="text-xl font-semibold sm:col-span-3">Tax and returns</h2>
      <pc-text-field label="HSN code" [value]="hsn()" (valueChange)="hsn.set($event)" [filter]="digits" maxlength="8" [required]="true" hint="4, 6 or 8 digits from your GST invoice" />
      <pc-field label="GST rate" for="gst" hint="Check the rate for your HSN code">
        <select pcSelect id="gst" (change)="gst.set(+$any($event.target).value)">
          @for (r of gstRates; track r) {<option [value]="r" [selected]="r === gst()">{{ pct(r) }}</option>}
        </select>
      </pc-field>
      <pc-field label="Return window" for="ret" [hint]="minReturn() ? 'At least ' + minReturn() + ' days in this category' : undefined">
        <select pcSelect id="ret" (change)="returnDays.set($any($event.target).value)">
          @for (d of returnOptions(); track d) {<option [value]="d" [selected]="'' + d === returnDays()">{{ d === 0 ? "Not returnable" : d + " days" }}</option>}
        </select>
      </pc-field>
      <pc-field label="Size guide (optional)" for="sg" hint="Only for this product. Leave empty to show the category's guide, if there is one. One line per size, columns split with |, first line is the heading.">
        <textarea pcTextarea id="sg" data-testid="product-size-guide" [value]="sizeGuide()" (input)="sizeGuide.set($any($event.target).value)" rows="4" maxlength="2000" placeholder="Size | Chest (in) | Length (in)&#10;S | 38 | 27"></textarea>
      </pc-field>
    </section>

    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-3 text-xl font-semibold">Specifications</h2>
      <div class="flex flex-col gap-2">
        <p class="-mt-2 text-sm text-ink-soft">Tick up to 6 key specifications to show beside the price on your product page.</p>
        @for (s of specs(); track $index; let i = $index) {
          <div class="flex items-center gap-2">
            <input pcInput placeholder="e.g. Material" [value]="s[0]" (input)="setSpec(i, 0, $any($event.target).value)" class="max-w-[220px]" aria-label="Specification name" />
            <input pcInput placeholder="e.g. 100% cotton" [value]="s[1]" (input)="setSpec(i, 1, $any($event.target).value)" aria-label="Specification value" />
            <label class="flex shrink-0 items-center gap-1 text-xs text-ink-soft" title="Show beside the price">
              <input type="checkbox" class="accent-peacock" [checked]="isKey(s[0])" [disabled]="!s[0].trim() || (!isKey(s[0]) && details().key_specs.length >= 6)"
                (change)="toggleKey(s[0].trim(), $any($event.target).checked)" /> Key
            </label>
            <button type="button" (click)="removeSpec(i)" class="p-2 text-ink-faint hover:text-vermilion" aria-label="Remove specification"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>
          </div>
        }
        <button pcButton type="button" variant="ghost" size="sm" class="self-start" (click)="specs.set([...specs(), ['', '']])"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add specification</button>
      </div>
    </section>

    <pc-product-info-section [details]="details()" (detailsChange)="details.set($event)" [required]="required()" [countryOfOrigin]="origin()" />

    <div class="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 px-4 py-3 backdrop-blur">
      <div class="mx-auto flex max-w-[1400px] flex-wrap justify-end gap-2">
        <button pcButton variant="secondary" (click)="save(false)" [loading]="busy() === 'save'" [disabled]="busy() !== null">
          {{ product() ? "Save changes" : "Save as draft" }}
        </button>
        @if (canSubmit()) {
          <button pcButton (click)="save(true)" [loading]="busy() === 'submit'" [disabled]="busy() !== null">Save and submit for review</button>
        }
      </div>
    </div>
    <!-- only while open: a closed dialog still leaves an element in this flex column (an extra gap) -->
    @if (aiOpen()) {<pc-modal [open]="true" (close)="aiOpen.set(false)" title="Write the listing with AI" [wide]="true">
      <div class="flex flex-col gap-3">
        <p class="text-ink-soft">Describe the product in your own words, in English or Tanglish: material, size, colours, what is in the box, who it is for. The assistant drafts a title, description, highlights and specifications. It only uses what you write.</p>
        <textarea pcTextarea [value]="aiNotes()" (input)="aiNotes.set($any($event.target).value)" rows="5" maxlength="4000" aria-label="Product notes" placeholder="e.g. Pure cotton kurta for men, regular fit, sizes S to XXL, colours white and sky blue, machine washable, made in Tiruppur"></textarea>
        <pc-error-note [message]="aiError()" />
        <button pcButton (click)="runAi()" [loading]="aiBusy()" [disabled]="aiNotes().trim().length < 20" class="self-start"><svg [pcIcon]="Sparkles" class="h-4 w-4" /> Draft listing</button>
        @if (aiResult(); as ai) {
          <div class="rounded-lg border border-line p-3">
            <div class="mb-1"><pc-ai-badge [mode]="ai.mode" /></div>
            <p class="font-semibold">{{ ai.title }}</p>
            <p class="mt-1 whitespace-pre-line text-sm text-ink-soft">{{ ai.description }}</p>
            @if (ai.highlights.length > 0) {<ul class="mt-2 list-disc pl-5 text-sm">@for (h of ai.highlights; track h) {<li>{{ h }}</li>}</ul>}
            @if (ai.missing.length > 0) {
              <div class="mt-2 rounded bg-marigold-light p-2 text-sm"><p class="font-semibold">Customers may also ask:</p><ul class="list-disc pl-5">@for (m of ai.missing; track m) {<li>{{ m }}</li>}</ul></div>
            }
            <button pcButton class="mt-3" (click)="useAi()">Use this draft</button>
          </div>
        }
      </div>
    </pc-modal>}
  `,
})
export class ProductEditor implements OnInit {
  readonly product = input<SellerProduct | undefined>(undefined);
  readonly saved = output<SellerProduct>();
  private readonly router = inject(Router);
  private readonly toast = inject(Toast);
  protected readonly site = inject(SiteService).site;
  protected readonly ArrowLeft = ArrowLeft;
  protected readonly ArrowRight = ArrowRight;
  protected readonly ImagePlus = ImagePlus;
  protected readonly Plus = Plus;
  protected readonly Sparkles = Sparkles;
  protected readonly Trash2 = Trash2;
  protected readonly X = X;
  protected readonly pct = pct;
  protected readonly statusText = STATUS_TEXT;
  protected readonly unitLabel = UNIT_LABEL;
  protected readonly gstRates = GST_RATES;
  protected readonly digits = (v: string) => v.replace(/\D/g, "");

  protected readonly cats = signal<SellerCategory[]>([]);
  private readonly fees = signal<Fees | null>(null);
  protected readonly categoryId = signal("");
  protected readonly title = signal("");
  protected readonly brand = signal("");
  protected readonly description = signal("");
  protected readonly highlights = signal("");
  protected readonly specs = signal<[string, string][]>([["", ""]]);
  protected readonly hsn = signal("");
  protected readonly gst = signal(1800);
  protected readonly origin = signal("India");
  protected readonly returnDays = signal("7");
  protected readonly sizeGuide = signal("");
  protected readonly images = signal<string[]>([]);
  protected readonly videos = signal<ProductVideo[]>([]);
  protected readonly details = signal<ProductDetails>({ ...EMPTY_DETAILS });
  protected readonly required = signal<string[]>([]);
  protected readonly axes = signal<string[]>([]);
  protected readonly rows = signal<VRow[]>([]);
  protected readonly bulk = signal<Record<string, string | undefined>>({});
  protected readonly uploading = signal(false);
  protected readonly busy = signal<"save" | "submit" | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly aiOpen = signal(false);
  protected readonly aiNotes = signal("");
  protected readonly aiBusy = signal(false);
  protected readonly aiError = signal<string | null>(null);
  protected readonly aiResult = signal<AiResult | null>(null);

  protected readonly cat = computed(() => this.cats().find((c) => c.id === this.categoryId()));
  protected readonly minReturn = computed(() => this.cat()?.min_return_window_days ?? 0);
  protected readonly returnOptions = computed(() =>
    [...new Set([0, 3, 7, 10, 15, 30, this.cat()?.return_window_days ?? 0, Number(this.returnDays())])].filter((d) => d >= this.minReturn()).sort((a, b) => a - b));
  protected readonly canSubmit = computed(() => {
    const p = this.product();
    return !p || p.status === "draft" || p.status === "rejected";
  });
  protected readonly fee = computed(() => {
    const first = this.rows()[0];
    const price = first ? toPaise(first.price) : null;
    const cat = this.cat();
    const fees = this.fees();
    return price && cat && fees ? feeNote(price, cat.commission_bps, fees) : null;
  });

  constructor() {
    api<SellerCategory[]>("/api/seller/categories").then((c) => this.cats.set(c)).catch(quietly);
    api<Fees>("/api/seller/fees").then((f) => this.fees.set(f)).catch(quietly);
    // what this category requires (net quantity, manufacturer, FSSAI licence...), set by the marketplace per category
    effect(() => {
      const categoryId = this.categoryId();
      if (!categoryId) return;
      api<{ required: string[] }>("/api/seller/listing-requirements", { query: { category_id: categoryId } }).then((r) => this.required.set(r.required)).catch(quietly);
    });
  }

  ngOnInit(): void {
    const p = this.product();
    this.categoryId.set(p?.category_id ?? "");
    this.title.set(p?.title ?? "");
    this.brand.set(p?.brand ?? "");
    this.description.set(p?.description ?? "");
    this.highlights.set((p?.highlights ?? []).join("\n"));
    this.specs.set(Object.entries(p?.specs ?? {}).length ? Object.entries(p!.specs) : [["", ""]]);
    this.hsn.set(p?.hsn_code ?? "");
    this.gst.set(p?.gst_bps ?? 1800);
    this.origin.set(p?.country_of_origin ?? "India");
    this.returnDays.set(String(p?.return_window_days ?? 7));
    this.sizeGuide.set(p?.size_guide ?? "");
    this.images.set(p?.images ?? []);
    this.videos.set(p?.videos ?? []);
    this.details.set({ ...EMPTY_DETAILS, ...(p?.details ?? {}) });
    this.required.set(p?.required_details ?? []);
    const first = p?.variants[0];
    this.axes.set(first ? Object.keys(first.options) : []);
    this.rows.set(p?.variants.length ? p.variants.map(rowFrom) : [{ key: newKey(), sku: "", options: {}, mrp: "", price: "", stock: "", weight: "500", net: "", is_active: true }]);
  }

  /* ------------------------------------------------------------ AI listing writer */

  protected async runAi(): Promise<void> {
    this.aiBusy.set(true);
    this.aiError.set(null);
    try {
      this.aiResult.set(await api<AiResult>("/api/seller/ai/listing", { method: "POST", body: { notes: this.aiNotes(), category_id: this.categoryId() || null, brand: this.brand() } }));
    } catch (e) {
      this.aiError.set(e instanceof ApiError ? e.message : "Could not reach the writing assistant");
    } finally {
      this.aiBusy.set(false);
    }
  }

  protected useAi(): void {
    const ai = this.aiResult();
    if (!ai) return;
    if (ai.title) this.title.set(ai.title);
    if (ai.description) this.description.set(ai.description);
    if (ai.highlights.length) this.highlights.set(ai.highlights.join("\n"));
    const sp = Object.entries(ai.specs);
    if (sp.length) this.specs.set(sp);
    api(`/api/seller/ai/runs/${ai.run_id}/apply`, { method: "POST", body: { final_text: ai.title } }).catch(() => {});
    this.aiOpen.set(false);
    this.toast.show("Draft added. Check every detail before you submit.");
  }

  /* ------------------------------------------------------------ basic details */

  protected pickCategory(id: string): void {
    const product = this.product();
    this.categoryId.set(id);
    const c = this.cats().find((x) => x.id === id);
    if (c && !product) this.gst.set(c.default_gst_bps);
    // the category's return policy: new listings start with its default and none may go below its minimum
    if (c && (!product || Number(this.returnDays()) < c.min_return_window_days)) this.returnDays.set(String(product ? c.min_return_window_days : c.return_window_days));
  }

  protected jump(e: Event): void {
    // an in-page anchor: the router would otherwise treat it as a navigation
    e.preventDefault();
    document.getElementById("product-information")?.scrollIntoView();
    history.replaceState(history.state, "", "#product-information");
  }

  /* ------------------------------------------------------------ photos */

  protected pickImages(e: Event): void {
    const files = (e.target as HTMLInputElement).files;
    if (files) void this.uploadImages(files);
  }

  private async uploadImages(files: FileList): Promise<void> {
    this.uploading.set(true);
    this.error.set(null);
    try {
      for (const file of Array.from(files).slice(0, 8 - this.images().length)) {
        const form = new FormData();
        form.append("file", file);
        const r = await api<{ url: string }>("/api/seller/images", { method: "POST", form });
        this.images.update((cur) => [...cur, r.url]);
      }
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      this.uploading.set(false);
    }
  }

  protected moveImage(i: number, d: -1 | 1): void {
    const next = [...this.images()];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    this.images.set(next);
  }

  protected removeImage(src: string): void {
    this.images.set(this.images().filter((x) => x !== src));
  }

  /* ------------------------------------------------------------ options and versions */

  protected renameAxis(i: number, v: string): void {
    this.axes.set(this.axes().map((x, j) => (j === i ? v : x)));
  }

  protected removeAxis(i: number): void {
    this.axes.set(this.axes().filter((_, j) => j !== i));
  }

  protected addAxis(): void {
    const axes = this.axes();
    this.axes.set([...axes, axes.includes("Size") ? (axes.includes("Colour") ? "Material" : "Colour") : "Size"]);
  }

  protected setBulk(a: string, v: string): void {
    this.bulk.set({ ...this.bulk(), [a]: v });
  }

  protected generate(): void {
    const axes = this.axes();
    const bulk = this.bulk();
    const rows = this.rows();
    const lists = axes.map((a) => (bulk[a] ?? "").split(",").map((x) => x.trim()).filter(Boolean));
    if (!axes.length || lists.some((l) => !l.length)) {
      this.error.set("Enter at least one value for every option, separated by commas");
      return;
    }
    let combos: Record<string, string>[] = [{}];
    axes.forEach((a, i) => (combos = combos.flatMap((c) => lists[i].map((v) => ({ ...c, [a]: v })))));
    const base = rows[0];
    const prefix = (this.title().match(/[A-Za-z0-9]+/g) ?? ["SKU"]).slice(0, 2).join("-").toUpperCase().slice(0, 12);
    this.rows.set(
      combos.slice(0, 50).map((options) => {
        const existing = rows.find((r) => axes.every((a) => r.options[a] === options[a]));
        if (existing) return existing;
        const suffix = Object.values(options).map((v) => v.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6)).join("-");
        return { key: newKey(), sku: `${prefix}-${suffix}`, options, mrp: base?.mrp ?? "", price: base?.price ?? "", stock: base?.stock ?? "", weight: base?.weight ?? "500", net: base?.net ?? "", is_active: true };
      }),
    );
    this.error.set(null);
  }

  protected updateRow(key: string, patch: Partial<VRow>): void {
    this.rows.update((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  protected setOption(r: VRow, a: string, v: string): void {
    const cur = this.rows().find((x) => x.key === r.key) ?? r;
    this.updateRow(r.key, { options: { ...cur.options, [a]: v } });
  }

  protected removeRow(key: string): void {
    this.rows.set(this.rows().filter((x) => x.key !== key));
  }

  protected addRow(): void {
    const rows = this.rows();
    this.rows.set([...rows, { key: newKey(), sku: "", options: {}, mrp: rows[0]?.mrp ?? "", price: rows[0]?.price ?? "", stock: "", weight: "500", net: rows[0]?.net ?? "", is_active: true }]);
  }

  protected bad(r: VRow): boolean {
    const mrp = toPaise(r.mrp);
    const price = toPaise(r.price);
    return mrp !== null && price !== null && price > mrp;
  }

  /** the discount to show under the price (12 for "12% off"), or null when there is none */
  protected off(r: VRow): number | null {
    const mrp = toPaise(r.mrp);
    const price = toPaise(r.price);
    return mrp && price && mrp > price ? Math.floor(((mrp - price) * 100) / mrp) : null;
  }

  protected perUnit(r: VRow): string | null {
    const price = toPaise(r.price);
    const unit = this.details().net_unit;
    return price && Number(r.net) > 0 && unit ? unitPreview(price, Number(r.net), unit) : null;
  }

  /* ------------------------------------------------------------ specifications */

  protected setSpec(i: number, col: 0 | 1, v: string): void {
    this.specs.set(this.specs().map((s, j) => (j === i ? (col === 0 ? [v, s[1]] : [s[0], v]) : s)));
  }

  protected removeSpec(i: number): void {
    this.specs.set(this.specs().filter((_, j) => j !== i));
  }

  protected isKey(k: string): boolean {
    const key = k.trim();
    return Boolean(key) && this.details().key_specs.includes(key);
  }

  protected toggleKey(key: string, on: boolean): void {
    const d = this.details();
    this.details.set({ ...d, key_specs: on ? [...d.key_specs, key] : d.key_specs.filter((x) => x !== key) });
  }

  /* ------------------------------------------------------------ save */

  private buildBody() {
    const details = this.details();
    const axes = this.axes();
    const specs = this.specs();
    const variants = this.rows().map((r, i) => {
      const mrp = toPaise(r.mrp);
      const price = toPaise(r.price);
      const stock = Number(r.stock);
      if (mrp === null || price === null) throw new Error(`Row ${i + 1}: enter MRP and selling price in rupees`);
      if (!Number.isInteger(stock) || stock < 0 || r.stock === "") throw new Error(`Row ${i + 1}: enter stock as a whole number`);
      const options = axes.length ? Object.fromEntries(axes.map((a) => [a, r.options[a] ?? ""])) : {};
      const net = r.net.trim() ? Number(r.net) : null;
      if (net !== null && (!Number.isFinite(net) || net <= 0)) throw new Error(`Row ${i + 1}: enter the net quantity as a number, e.g. 500`);
      return { ...(r.id ? { id: r.id } : {}), sku: r.sku.trim(), options, mrp_paise: mrp, price_paise: price, stock, weight_grams: Number(r.weight) || 500,
        net_qty: details.net_unit ? net : null, is_active: r.is_active };
    });
    return {
      category_id: this.categoryId(),
      title: this.title().trim(),
      brand: this.brand().trim(),
      description: this.description().trim(),
      highlights: this.highlights().split("\n").map((h) => h.trim()).filter(Boolean),
      specs: Object.fromEntries(specs.filter(([k, v]) => k.trim() && v.trim())),
      hsn_code: this.hsn().trim(),
      gst_bps: this.gst(),
      country_of_origin: this.origin().trim(),
      return_window_days: Number(this.returnDays()),
      size_guide: this.sizeGuide(),
      images: this.images(),
      videos: this.videos(),
      variants,
      details: { ...details, key_specs: details.key_specs.filter((k) => specs.some(([s]) => s.trim() === k)) },
    };
  }

  protected async save(andSubmit: boolean): Promise<SellerProduct | undefined> {
    const product = this.product();
    this.busy.set(andSubmit ? "submit" : "save");
    this.error.set(null);
    try {
      const body = this.buildBody();
      let saved = product
        ? await api<SellerProduct>(`/api/seller/products/${product.id}`, { method: "PUT", body })
        : await api<SellerProduct>("/api/seller/products", { method: "POST", body });
      if (andSubmit && (saved.status === "draft" || saved.status === "rejected")) {
        saved = await api<SellerProduct>(`/api/seller/products/${saved.id}/submit`, { method: "POST" });
      }
      this.toast.show(andSubmit ? "Submitted for review" : saved.status === "pending" && product?.status === "approved" ? "Saved. The listing is back in review." : "Saved");
      if (!product) void this.router.navigateByUrl(`/seller/products/${saved.id}`, { replaceUrl: true });
      else this.saved.emit(saved);
      return saved;
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : "Could not save");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return undefined;
    } finally {
      this.busy.set(null);
    }
  }

  protected async archive(restore: boolean): Promise<void> {
    const product = this.product();
    if (!product) return;
    await api(`/api/seller/products/${product.id}/${restore ? "restore" : "archive"}`, { method: "POST" });
    this.toast.show(restore ? "Restored as a draft" : "Archived");
    this.saved.emit(await api<SellerProduct>(`/api/seller/products/${product.id}`));
  }
}
