"use client";

/*
 * "Product information" in the seller's product editor: the Legal Metrology declarations an online store
 * must show for packaged goods, food details and the information shoppers look for. Fields the category
 * requires are marked; the listing cannot be submitted for review until they are filled in.
 */

import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Field, Input, Select, Textarea } from "@/components/ui";
import type { ProductDetails } from "@/lib/types";

export const EMPTY_DETAILS: ProductDetails = {
  net_unit: "", ships_on: "", min_qty: 0, max_qty: 0, generic_name: "", model_number: "", manufacturer: "", packer: "", importer: "", customer_care: "", fssai_license: "",
  ingredients: "", directions: "", safety_info: "", legal_disclaimer: "", shelf_life: "", warranty: "", in_the_box: [],
  length_cm: null, width_cm: null, height_cm: null, key_specs: [],
};

export const UNIT_LABEL: Record<string, string> = { g: "g", kg: "kg", ml: "ml", l: "litre", m: "metre", pcs: "pieces", pair: "pairs" };

function Label({ text, req }: { text: string; req: boolean }) {
  return <>{text}{req && <span className="text-vermilion"> *</span>}</>;
}

export function ProductInfoSection({ details, onChange, required, countryOfOrigin }: {
  details: ProductDetails; onChange: (d: ProductDetails) => void; required: string[]; countryOfOrigin: string;
}) {
  const [box, setBox] = useState("");
  const set = <K extends keyof ProductDetails>(k: K, v: ProductDetails[K]) => onChange({ ...details, [k]: v });
  const req = (k: string) => required.includes(k);
  const imported = countryOfOrigin.trim().toLowerCase() !== "india" && countryOfOrigin.trim() !== "";
  const text = (k: keyof ProductDetails, label: string, opts: { reqKey?: string; hint?: string; rows?: number; max?: number; placeholder?: string } = {}) => (
    <Field label={<Label text={label} req={req(opts.reqKey ?? (k as string))} />} hint={opts.hint}>
      {opts.rows
        ? <Textarea rows={opts.rows} maxLength={opts.max ?? 2000} value={details[k] as string} placeholder={opts.placeholder} onChange={(e) => set(k, e.target.value as never)} aria-label={label} />
        : <Input maxLength={opts.max ?? 400} value={details[k] as string} placeholder={opts.placeholder} onChange={(e) => set(k, e.target.value as never)} aria-label={label} />}
    </Field>
  );
  const dim = (k: "length_cm" | "width_cm" | "height_cm", label: string) => (
    <Input inputMode="decimal" placeholder={label} aria-label={`${label} in cm`} value={details[k] ?? ""}
      onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, ""); set(k, v ? Number(v) : null); }} />
  );
  return (
    <section className="flex flex-col gap-4 rounded-xl bg-white p-5" id="product-information">
      <div>
        <h2 className="text-xl font-semibold">Product information</h2>
        <p className="text-sm text-ink-soft">
          Shown on the product page under Item details and Important information. For packaged goods the law expects the generic name, net quantity,
          manufacturer or packer (and importer for imported goods) and consumer care details.
          {required.length > 0 && <> Fields marked <span className="text-vermilion">*</span> are required in this category.</>}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {text("generic_name", "Generic name", { max: 120, placeholder: "e.g. Coffee powder, Face serum, Pressure cooker" })}
        {text("model_number", "Model number", { max: 60 })}
        <Field label={<Label text="Net quantity unit" req={req("net_quantity")} />} hint="Enter each version's net quantity in the price table. Shoppers see the price per 100 g, kg, litre or piece.">
          <Select value={details.net_unit} onChange={(e) => set("net_unit", e.target.value as ProductDetails["net_unit"])} aria-label="Net quantity unit">
            <option value="">Not applicable</option>
            {Object.entries(UNIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Pre-order: ships from" hint="Leave empty for items in stock. Shoppers see the date on the product and in the cart. Once it passes, the listing is normal again.">
          <input type="date" value={details.ships_on ?? ""} onChange={(e) => set("ships_on", e.target.value as never)} aria-label="Pre-order ship date" className="h-10 w-full rounded-lg border border-line bg-mist px-3" />
        </Field>
        <Field label="Minimum order quantity" hint="The fewest units one order can hold. 0 or 1 means no minimum.">
          <input type="number" min={0} max={100} value={details.min_qty ?? 0} onChange={(e) => set("min_qty", Math.max(0, Math.min(100, Number(e.target.value) || 0)) as never)} aria-label="Minimum order quantity" className="h-10 w-full rounded-lg border border-line bg-mist px-3" />
        </Field>
        <Field label="Most units per order" hint="The most units of one option an order can hold. 0 means no limit from you (the marketplace limit still applies). Not below the minimum.">
          <input type="number" min={0} max={100} value={details.max_qty ?? 0} onChange={(e) => set("max_qty", Math.max(0, Math.min(100, Number(e.target.value) || 0)) as never)} aria-label="Most units per order" className="h-10 w-full rounded-lg border border-line bg-mist px-3" />
        </Field>
        {text("fssai_license", "FSSAI licence number", { max: 14, hint: "14 digits, for food and supplements", placeholder: "e.g. 10012345000123" })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {text("manufacturer", "Manufacturer name and address", { rows: 2, max: 400 })}
        {text("packer", "Packer name and address", { rows: 2, max: 400, hint: "If someone other than the manufacturer packed it" })}
        {(imported || req("importer")) && text("importer", "Importer name and address", { rows: 2, max: 400, reqKey: imported ? "importer" : "_", hint: imported ? "Required for imported goods" : undefined })}
        {text("customer_care", "Consumer care details", { rows: 2, max: 300, hint: "Name, phone or email customers can contact for complaints" })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {text("shelf_life", "Best before / shelf life", { max: 80, placeholder: "e.g. 9 months from packing" })}
        {text("warranty", "Warranty", { max: 300, placeholder: "e.g. 1 year manufacturer warranty" })}
        <Field label={<Label text="Product dimensions (cm)" req={req("dimensions")} />} hint="Length × width × height">
          <div className="grid grid-cols-3 gap-2">{dim("length_cm", "Length")}{dim("width_cm", "Width")}{dim("height_cm", "Height")}</div>
        </Field>
        <Field label={<Label text="What's in the box" req={req("in_the_box")} />}>
          <div className="flex flex-col gap-2">
            {details.in_the_box.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {details.in_the_box.map((x) => (
                  <span key={x} className="inline-flex items-center gap-1 rounded-full bg-mist py-0.5 pl-2.5 pr-1 text-sm">
                    {x}<button type="button" aria-label={`Remove ${x}`} onClick={() => set("in_the_box", details.in_the_box.filter((y) => y !== x))} className="rounded-full p-0.5 hover:bg-white"><X className="h-3.5 w-3.5" /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Input value={box} maxLength={120} placeholder="e.g. Charging cable" aria-label="Add an item in the box"
                onChange={(e) => setBox(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (box.trim() && details.in_the_box.length < 20) { set("in_the_box", [...details.in_the_box, box.trim()]); setBox(""); } } }} />
              <button type="button" className={clsx("rounded-lg px-3 text-sm font-semibold text-peacock ring-1 ring-line hover:bg-mist")}
                onClick={() => { if (box.trim() && details.in_the_box.length < 20) { set("in_the_box", [...details.in_the_box, box.trim()]); setBox(""); } }}><Plus className="h-4 w-4" /></button>
            </div>
          </div>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {text("ingredients", "Ingredients", { rows: 3 })}
        {text("directions", "Directions for use", { rows: 3 })}
        {text("safety_info", "Safety information", { rows: 3, reqKey: "safety_info" })}
        {text("legal_disclaimer", "Legal disclaimer", { rows: 3, max: 1000, reqKey: "_" })}
      </div>
    </section>
  );
}
