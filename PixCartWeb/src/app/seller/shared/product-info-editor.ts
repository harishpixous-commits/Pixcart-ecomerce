/*
 * "Product information" in the seller's product editor: the Legal Metrology declarations an online store
 * must show for packaged goods, food details and the information shoppers look for. Fields the category
 * requires are marked; the listing cannot be submitted for review until they are filled in.
 * Port of frontend/src/components/product-info-editor.tsx:
 *   <pc-product-info-section [details]="d" (detailsChange)="d = $event" [required]="keys" [countryOfOrigin]="origin" />
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { Plus, X } from "lucide-angular";
import type { ProductDetails } from "../../core/types";
import { Icon } from "../../shared/ui/icon";
import { Field, Input, Select, Textarea } from "../../shared/ui/ui";

export const EMPTY_DETAILS: ProductDetails = {
  net_unit: "", min_qty: 0, generic_name: "", model_number: "", manufacturer: "", packer: "", importer: "", customer_care: "", fssai_license: "",
  ingredients: "", directions: "", safety_info: "", legal_disclaimer: "", shelf_life: "", warranty: "", in_the_box: [],
  length_cm: null, width_cm: null, height_cm: null, key_specs: [],
};

export const UNIT_LABEL: Record<string, string> = { g: "g", kg: "kg", ml: "ml", l: "litre", m: "metre", pcs: "pieces", pair: "pairs" };

type TextKey = "generic_name" | "model_number" | "manufacturer" | "packer" | "importer" | "customer_care" | "fssai_license" | "ingredients" | "directions"
  | "safety_info" | "legal_disclaimer" | "shelf_life" | "warranty";
type TextOpts = { key: TextKey; label: string; reqKey?: string; hint?: string; rows?: number; max?: number; placeholder?: string };
type DimKey = "length_cm" | "width_cm" | "height_cm";

@Component({
  selector: "pc-product-info-section",
  imports: [NgTemplateOutlet, Icon, Field, Input, Select, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ng-template #text let-o>
      <pc-field [label]="o.label" [hint]="o.hint">
        @if (req(o.reqKey ?? o.key)) {<span label class="text-vermilion"> *</span>}
        @if (o.rows) {
          <textarea pcTextarea [rows]="o.rows" [attr.maxlength]="o.max ?? 2000" [value]="val(o.key)" [attr.placeholder]="o.placeholder ?? null" (input)="set(o.key, $any($event.target).value)" [attr.aria-label]="o.label"></textarea>
        } @else {
          <input pcInput [attr.maxlength]="o.max ?? 400" [value]="val(o.key)" [attr.placeholder]="o.placeholder ?? null" (input)="set(o.key, $any($event.target).value)" [attr.aria-label]="o.label" />
        }
      </pc-field>
    </ng-template>
    <ng-template #dim let-k let-label="label">
      <input pcInput inputmode="decimal" [placeholder]="label" [attr.aria-label]="label + ' in cm'" [value]="val(k) ?? ''" (input)="setDim($any(k), $event)" />
    </ng-template>

    <section class="flex flex-col gap-4 rounded-xl bg-white p-5" id="product-information">
      <div>
        <h2 class="text-xl font-semibold">Product information</h2>
        <p class="text-sm text-ink-soft">
          Shown on the product page under Item details and Important information. For packaged goods the law expects the generic name, net quantity,
          manufacturer or packer (and importer for imported goods) and consumer care details.@if (required().length > 0) {<ng-container> Fields marked <span class="text-vermilion">*</span> are required in this category.</ng-container>}
        </p>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'generic_name', label: 'Generic name', max: 120, placeholder: 'e.g. Coffee powder, Face serum, Pressure cooker' } }" />
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'model_number', label: 'Model number', max: 60 } }" />
        <pc-field label="Net quantity unit" hint="Enter each version's net quantity in the price table. Shoppers see the price per 100 g, kg, litre or piece.">
          @if (req("net_quantity")) {<span label class="text-vermilion"> *</span>}
          <select pcSelect (change)="set('net_unit', $any($event.target).value)" aria-label="Net quantity unit">
            <option value="" [selected]="details().net_unit === ''">Not applicable</option>
            @for (u of units; track u[0]) {<option [value]="u[0]" [selected]="details().net_unit === u[0]">{{ u[1] }}</option>}
          </select>
        </pc-field>
        <pc-field label="Minimum order quantity" hint="The fewest units one order can hold. 0 or 1 means no minimum.">
          <input pcInput type="number" min="0" max="100" [value]="details().min_qty ?? 0" (input)="set('min_qty', Math.max(0, Math.min(100, +$any($event.target).value || 0)))" aria-label="Minimum order quantity" />
        </pc-field>
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'fssai_license', label: 'FSSAI licence number', max: 14, hint: '14 digits, for food and supplements', placeholder: 'e.g. 10012345000123' } }" />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'manufacturer', label: 'Manufacturer name and address', rows: 2, max: 400 } }" />
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'packer', label: 'Packer name and address', rows: 2, max: 400, hint: 'If someone other than the manufacturer packed it' } }" />
        @if (imported() || req("importer")) {
          <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'importer', label: 'Importer name and address', rows: 2, max: 400, reqKey: imported() ? 'importer' : '_', hint: imported() ? 'Required for imported goods' : undefined } }" />
        }
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'customer_care', label: 'Consumer care details', rows: 2, max: 300, hint: 'Name, phone or email customers can contact for complaints' } }" />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'shelf_life', label: 'Best before / shelf life', max: 80, placeholder: 'e.g. 9 months from packing' } }" />
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'warranty', label: 'Warranty', max: 300, placeholder: 'e.g. 1 year manufacturer warranty' } }" />
        <pc-field label="Product dimensions (cm)" hint="Length × width × height">
          @if (req("dimensions")) {<span label class="text-vermilion"> *</span>}
          <div class="grid grid-cols-3 gap-2">
            <ng-container [ngTemplateOutlet]="dim" [ngTemplateOutletContext]="{ $implicit: 'length_cm', label: 'Length' }" />
            <ng-container [ngTemplateOutlet]="dim" [ngTemplateOutletContext]="{ $implicit: 'width_cm', label: 'Width' }" />
            <ng-container [ngTemplateOutlet]="dim" [ngTemplateOutletContext]="{ $implicit: 'height_cm', label: 'Height' }" />
          </div>
        </pc-field>
        <pc-field label="What's in the box">
          @if (req("in_the_box")) {<span label class="text-vermilion"> *</span>}
          <div class="flex flex-col gap-2">
            @if (details().in_the_box.length > 0) {
              <div class="flex flex-wrap gap-1.5">
                @for (x of details().in_the_box; track x) {
                  <span class="inline-flex items-center gap-1 rounded-full bg-mist py-0.5 pl-2.5 pr-1 text-sm">
                    {{ x }}<button type="button" [attr.aria-label]="'Remove ' + x" (click)="removeBox(x)" class="rounded-full p-0.5 hover:bg-white"><svg [pcIcon]="X" class="h-3.5 w-3.5" /></button>
                  </span>
                }
              </div>
            }
            <div class="flex gap-2">
              <input pcInput [value]="box()" maxlength="120" placeholder="e.g. Charging cable" aria-label="Add an item in the box"
                (input)="box.set($any($event.target).value)" (keydown.enter)="$event.preventDefault(); addBox()" />
              <button type="button" class="rounded-lg px-3 text-sm font-semibold text-peacock ring-1 ring-line hover:bg-mist" (click)="addBox()"><svg [pcIcon]="Plus" class="h-4 w-4" /></button>
            </div>
          </div>
        </pc-field>
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'ingredients', label: 'Ingredients', rows: 3 } }" />
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'directions', label: 'Directions for use', rows: 3 } }" />
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'safety_info', label: 'Safety information', rows: 3, reqKey: 'safety_info' } }" />
        <ng-container [ngTemplateOutlet]="text" [ngTemplateOutletContext]="{ $implicit: { key: 'legal_disclaimer', label: 'Legal disclaimer', rows: 3, max: 1000, reqKey: '_' } }" />
      </div>
    </section>
  `,
})
export class ProductInfoSection {
  readonly details = input.required<ProductDetails>();
  readonly required = input.required<string[]>();
  readonly countryOfOrigin = input.required<string>();
  readonly detailsChange = output<ProductDetails>();
  protected readonly Plus = Plus;
  protected readonly X = X;
  protected readonly units = Object.entries(UNIT_LABEL);
  protected readonly box = signal("");
  protected readonly imported = computed(() => this.countryOfOrigin().trim().toLowerCase() !== "india" && this.countryOfOrigin().trim() !== "");

  protected req(k: string): boolean {
    return this.required().includes(k);
  }

  protected readonly Math = Math;
  protected set<K extends keyof ProductDetails>(k: K, v: ProductDetails[K]): void {
    this.detailsChange.emit({ ...this.details(), [k]: v });
  }

  /** a field's current value (template contexts are untyped) */
  protected val(k: string): string | number | null {
    return this.details()[k as TextKey | DimKey];
  }

  protected setDim(k: DimKey, e: Event): void {
    const el = e.target as HTMLInputElement;
    const v = el.value.replace(/[^\d.]/g, "");
    const n = v ? Number(v) : null;
    // a controlled input: the box shows the stored number, as in the reference
    el.value = n === null ? "" : String(n);
    this.set(k, n);
  }

  protected addBox(): void {
    const box = this.box().trim();
    if (box && this.details().in_the_box.length < 20) {
      this.set("in_the_box", [...this.details().in_the_box, box]);
      this.box.set("");
    }
  }

  protected removeBox(x: string): void {
    this.set("in_the_box", this.details().in_the_box.filter((y) => y !== x));
  }
}

export type { TextOpts };
