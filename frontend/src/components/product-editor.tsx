"use client";

import { ArrowLeft, ArrowRight, ImagePlus, Plus, Sparkles, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Input, Modal, Select, StatusPill, Textarea, TextField, useToast } from "@/components/ui";
import { useSite } from "@/lib/site";
import { AiBadge } from "@/components/ai";
import { api, ApiError } from "@/lib/api";
import { GST_RATES, paiseToInput, pct, rupees, toPaise } from "@/lib/format";
import type { SellerCategory, SellerProduct } from "@/lib/types";

type VRow = { id?: string; key: string; sku: string; options: Record<string, string>; mrp: string; price: string; stock: string; weight: string; is_active: boolean };

let keySeq = 0;
const newKey = () => `v${++keySeq}`;

function rowFrom(v: SellerProduct["variants"][number]): VRow {
  return { id: v.id, key: newKey(), sku: v.sku, options: v.options, mrp: paiseToInput(v.mrp_paise), price: paiseToInput(v.price_paise), stock: String(v.stock), weight: String(v.weight_grams), is_active: v.is_active };
}

const STATUS_TEXT: Record<string, string> = {
  draft: "Draft: not visible to customers until you submit it for review.",
  pending: "In review: our team checks new listings and content changes, usually within a day.",
  approved: "Live: customers can buy this. Price and stock changes go live at once; other edits send it back for review.",
  rejected: "Needs changes: fix the issue below and submit again.",
  archived: "Archived: hidden from customers.",
};

export function ProductEditor({ product, onSaved }: { product?: SellerProduct; onSaved?: (p: SellerProduct) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [cats, setCats] = useState<SellerCategory[]>([]);
  const [categoryId, setCategoryId] = useState(product?.category_id ?? "");
  const [title, setTitle] = useState(product?.title ?? "");
  const [brand, setBrand] = useState(product?.brand ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [highlights, setHighlights] = useState((product?.highlights ?? []).join("\n"));
  const [specs, setSpecs] = useState<[string, string][]>(Object.entries(product?.specs ?? {}).length ? Object.entries(product!.specs) : [["", ""]]);
  const [hsn, setHsn] = useState(product?.hsn_code ?? "");
  const [gst, setGst] = useState<number>(product?.gst_bps ?? 1800);
  const [origin, setOrigin] = useState(product?.country_of_origin ?? "India");
  const [returnDays, setReturnDays] = useState(String(product?.return_window_days ?? 7));
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [axes, setAxes] = useState<string[]>(() => {
    const first = product?.variants[0];
    return first ? Object.keys(first.options) : [];
  });
  const [rows, setRows] = useState<VRow[]>(() =>
    product?.variants.length ? product.variants.map(rowFrom) : [{ key: newKey(), sku: "", options: {}, mrp: "", price: "", stock: "", weight: "500", is_active: true }],
  );
  const [bulk, setBulk] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState<"save" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const site = useSite();
  const [aiOpen, setAiOpen] = useState(false);
  const [aiNotes, setAiNotes] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<{ title: string; description: string; highlights: string[]; specs: Record<string, string>; missing: string[]; run_id: string; mode: "live" | "sandbox" } | null>(null);

  async function runAi() {
    setAiBusy(true);
    setAiError(null);
    try {
      setAiResult(await api("/api/seller/ai/listing", { method: "POST", body: { notes: aiNotes, category_id: categoryId || null, brand } }));
    } catch (e) {
      setAiError(e instanceof ApiError ? e.message : "Could not reach the writing assistant");
    } finally {
      setAiBusy(false);
    }
  }

  function useAi() {
    if (!aiResult) return;
    if (aiResult.title) setTitle(aiResult.title);
    if (aiResult.description) setDescription(aiResult.description);
    if (aiResult.highlights.length) setHighlights(aiResult.highlights.join("\n"));
    const sp = Object.entries(aiResult.specs);
    if (sp.length) setSpecs(sp);
    api(`/api/seller/ai/runs/${aiResult.run_id}/apply`, { method: "POST", body: { final_text: aiResult.title } }).catch(() => {});
    setAiOpen(false);
    toast("Draft added. Check every detail before you submit.");
  }

  useEffect(() => {
    api<SellerCategory[]>("/api/seller/categories").then(setCats);
  }, []);

  const cat = useMemo(() => cats.find((c) => c.id === categoryId), [cats, categoryId]);

  function pickCategory(id: string) {
    setCategoryId(id);
    const c = cats.find((x) => x.id === id);
    if (c && !product) setGst(c.default_gst_bps);
  }

  async function uploadImages(files: FileList) {
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files).slice(0, 8 - images.length)) {
        const form = new FormData();
        form.append("file", file);
        const r = await api<{ url: string }>("/api/seller/images", { method: "POST", form });
        setImages((cur) => [...cur, r.url]);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function moveImage(i: number, d: -1 | 1) {
    const next = [...images];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setImages(next);
  }

  function generate() {
    const lists = axes.map((a) => (bulk[a] ?? "").split(",").map((x) => x.trim()).filter(Boolean));
    if (!axes.length || lists.some((l) => !l.length)) {
      setError("Enter at least one value for every option, separated by commas");
      return;
    }
    let combos: Record<string, string>[] = [{}];
    axes.forEach((a, i) => (combos = combos.flatMap((c) => lists[i].map((v) => ({ ...c, [a]: v })))));
    const base = rows[0];
    const prefix = (title.match(/[A-Za-z0-9]+/g) ?? ["SKU"]).slice(0, 2).join("-").toUpperCase().slice(0, 12);
    setRows(
      combos.slice(0, 50).map((options) => {
        const existing = rows.find((r) => axes.every((a) => r.options[a] === options[a]));
        if (existing) return existing;
        const suffix = Object.values(options).map((v) => v.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6)).join("-");
        return { key: newKey(), sku: `${prefix}-${suffix}`, options, mrp: base?.mrp ?? "", price: base?.price ?? "", stock: base?.stock ?? "", weight: base?.weight ?? "500", is_active: true };
      }),
    );
    setError(null);
  }

  function updateRow(key: string, patch: Partial<VRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function buildBody() {
    const variants = rows.map((r, i) => {
      const mrp = toPaise(r.mrp);
      const price = toPaise(r.price);
      const stock = Number(r.stock);
      if (mrp === null || price === null) throw new Error(`Row ${i + 1}: enter MRP and selling price in rupees`);
      if (!Number.isInteger(stock) || stock < 0 || r.stock === "") throw new Error(`Row ${i + 1}: enter stock as a whole number`);
      const options = axes.length ? Object.fromEntries(axes.map((a) => [a, r.options[a] ?? ""])) : {};
      return { ...(r.id ? { id: r.id } : {}), sku: r.sku.trim(), options, mrp_paise: mrp, price_paise: price, stock, weight_grams: Number(r.weight) || 500, is_active: r.is_active };
    });
    return {
      category_id: categoryId,
      title: title.trim(),
      brand: brand.trim(),
      description: description.trim(),
      highlights: highlights.split("\n").map((h) => h.trim()).filter(Boolean),
      specs: Object.fromEntries(specs.filter(([k, v]) => k.trim() && v.trim())),
      hsn_code: hsn.trim(),
      gst_bps: gst,
      country_of_origin: origin.trim(),
      return_window_days: Number(returnDays),
      images,
      variants,
    };
  }

  async function save(andSubmit: boolean) {
    setBusy(andSubmit ? "submit" : "save");
    setError(null);
    try {
      const body = buildBody();
      let saved = product
        ? await api<SellerProduct>(`/api/seller/products/${product.id}`, { method: "PUT", body })
        : await api<SellerProduct>("/api/seller/products", { method: "POST", body });
      if (andSubmit && (saved.status === "draft" || saved.status === "rejected")) {
        saved = await api<SellerProduct>(`/api/seller/products/${saved.id}/submit`, { method: "POST" });
      }
      toast(andSubmit ? "Submitted for review" : saved.status === "pending" && product?.status === "approved" ? "Saved. The listing is back in review." : "Saved");
      if (!product) router.replace(`/seller/products/${saved.id}`);
      else onSaved?.(saved);
      return saved;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setBusy(null);
    }
  }

  async function archive(restore: boolean) {
    if (!product) return;
    await api(`/api/seller/products/${product.id}/${restore ? "restore" : "archive"}`, { method: "POST" });
    toast(restore ? "Restored as a draft" : "Archived");
    onSaved?.(await api<SellerProduct>(`/api/seller/products/${product.id}`));
  }

  const canSubmit = !product || product.status === "draft" || product.status === "rejected";

  return (
    <div className="flex flex-col gap-4 pb-24">
      <PageHeader
        title={product ? "Edit product" : "Add a product"}
        sub={product ? product.title : "Fill in the details customers need to decide."}
        actions={product && (
          <>
            {product.status === "approved" && <Link href={`/p/${product.slug}`} target="_blank" className="inline-flex h-10 items-center rounded-lg px-3 font-semibold text-peacock hover:bg-peacock-light">View on store</Link>}
            {product.status === "archived" ? <Button variant="secondary" onClick={() => archive(true)}>Restore</Button> : <Button variant="ghost" onClick={() => archive(false)}>Archive</Button>}
          </>
        )}
      />
      {product && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-4">
          <StatusPill status={product.status} />
          <p className="text-ink-soft">{STATUS_TEXT[product.status]}</p>
          {product.status === "rejected" && product.rejection_reason && <p className="w-full font-semibold text-vermilion">{product.rejection_reason}</p>}
        </div>
      )}
      <ErrorNote message={error} />

      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
          <h2 className="text-xl font-semibold">Basic details</h2>
          {site.features.ai && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setAiOpen(true)}><Sparkles className="h-4 w-4" /> Write with AI</Button>
          )}
        </div>
        <Field label="Category" htmlFor="cat" className="sm:col-span-2" hint={cat ? `Commission ${pct(cat.commission_bps)} of the selling price` : undefined}>
          <Select id="cat" value={categoryId} onChange={(e) => pickCategory(e.target.value)} required>
            <option value="">Choose a category</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
          </Select>
        </Field>
        <TextField className="sm:col-span-2" label="Product title" value={title} onChange={(e) => setTitle(e.target.value)} minLength={10} maxLength={200} required hint="Brand, product type and key feature, e.g. 'Kavi Men's Cotton Slim Fit Casual Shirt'" />
        <TextField label="Brand" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
        <TextField label="Country of origin" value={origin} onChange={(e) => setOrigin(e.target.value)} required />
        <Field label="Description" className="sm:col-span-2" hint="At least 30 characters. Materials, size guidance, what is in the box.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={10000} />
        </Field>
        <Field label="Highlights (one per line, up to 10)" className="sm:col-span-2">
          <Textarea value={highlights} onChange={(e) => setHighlights(e.target.value)} rows={3} />
        </Field>
      </section>

      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-xl font-semibold">Photos</h2>
        <p className="mb-3 text-sm text-ink-soft">Up to 8 photos, at least 200 × 200 pixels. The first photo is the main one. A plain white background works best.</p>
        <div className="flex flex-wrap gap-3">
          {images.map((src, i) => (
            <div key={src} className="relative h-28 w-28 overflow-hidden rounded-lg border border-line bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Photo ${i + 1}`} className="h-full w-full object-contain" />
              {i === 0 && <span className="absolute left-1 top-1 rounded bg-peacock px-1.5 text-xs font-semibold text-white">Main</span>}
              <div className="absolute inset-x-0 bottom-0 flex justify-between bg-white/90 p-0.5">
                <button type="button" onClick={() => moveImage(i, -1)} aria-label="Move left" className="p-1 disabled:opacity-30" disabled={i === 0}><ArrowLeft className="h-4 w-4" /></button>
                <button type="button" onClick={() => setImages(images.filter((x) => x !== src))} aria-label="Remove photo" className="p-1 text-vermilion"><X className="h-4 w-4" /></button>
                <button type="button" onClick={() => moveImage(i, 1)} aria-label="Move right" className="p-1 disabled:opacity-30" disabled={i === images.length - 1}><ArrowRight className="h-4 w-4" /></button>
              </div>
            </div>
          ))}
          {images.length < 8 && (
            <label className="flex h-28 w-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-sm font-semibold text-peacock hover:border-peacock">
              <ImagePlus className="h-6 w-6" />
              {uploading ? "Uploading" : "Add photos"}
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" disabled={uploading} onChange={(e) => e.target.files && uploadImages(e.target.files)} />
            </label>
          )}
        </div>
      </section>

      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-xl font-semibold">Price, stock and options</h2>
        <p className="mb-3 text-sm text-ink-soft">Prices include GST. Add options such as Size or Colour if the product comes in more than one version.</p>
        <div className="mb-4 flex flex-col gap-3 rounded-lg bg-mist p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">Option types:</span>
            {axes.map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-white py-1 pl-3 pr-1 text-sm">
                <input value={a} onChange={(e) => setAxes(axes.map((x, j) => (j === i ? e.target.value : x)))} className="w-20 bg-transparent focus:outline-none" aria-label="Option name" />
                <button type="button" onClick={() => setAxes(axes.filter((_, j) => j !== i))} aria-label={`Remove ${a}`} className="rounded-full p-0.5 hover:bg-mist"><X className="h-3.5 w-3.5" /></button>
              </span>
            ))}
            {axes.length < 3 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAxes([...axes, axes.includes("Size") ? (axes.includes("Colour") ? "Material" : "Colour") : "Size"])}>
                <Plus className="h-4 w-4" /> Add option
              </Button>
            )}
          </div>
          {axes.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              {axes.map((a) => (
                <Field key={a} label={`${a} values`} hint="Comma separated, e.g. S, M, L">
                  <Input value={bulk[a] ?? ""} onChange={(e) => setBulk({ ...bulk, [a]: e.target.value })} className="w-56" />
                </Field>
              ))}
              <Button type="button" variant="secondary" onClick={generate}>Create versions</Button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[15px]">
            <thead className="text-sm text-ink-faint">
              <tr>
                {axes.map((a) => <th key={a} className="px-2 py-1 font-medium">{a}</th>)}
                <th className="px-2 py-1 font-medium">SKU</th>
                <th className="px-2 py-1 font-medium">MRP (₹)</th>
                <th className="px-2 py-1 font-medium">Selling price (₹)</th>
                <th className="px-2 py-1 font-medium">Stock</th>
                <th className="px-2 py-1 font-medium">Weight (g)</th>
                <th className="px-2 py-1 font-medium">On sale</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const mrp = toPaise(r.mrp);
                const price = toPaise(r.price);
                const bad = mrp !== null && price !== null && price > mrp;
                return (
                  <tr key={r.key} className="align-top">
                    {axes.map((a) => (
                      <td key={a} className="px-1 py-1"><Input value={r.options[a] ?? ""} onChange={(e) => updateRow(r.key, { options: { ...r.options, [a]: e.target.value } })} className="h-9 w-24" aria-label={a} /></td>
                    ))}
                    <td className="px-1 py-1"><Input value={r.sku} onChange={(e) => updateRow(r.key, { sku: e.target.value })} className="h-9 w-36" aria-label="SKU" /></td>
                    <td className="px-1 py-1"><Input value={r.mrp} inputMode="decimal" onChange={(e) => updateRow(r.key, { mrp: e.target.value })} className="h-9 w-24" aria-label="MRP" /></td>
                    <td className="px-1 py-1">
                      <Input value={r.price} inputMode="decimal" onChange={(e) => updateRow(r.key, { price: e.target.value })} className="h-9 w-24" invalid={bad} aria-label="Selling price" />
                      {bad ? <p className="text-xs text-vermilion">More than MRP</p> : mrp && price && mrp > price ? <p className="text-xs text-leaf">{Math.floor(((mrp - price) * 100) / mrp)}% off</p> : null}
                    </td>
                    <td className="px-1 py-1"><Input value={r.stock} inputMode="numeric" onChange={(e) => updateRow(r.key, { stock: e.target.value })} className="h-9 w-20" aria-label="Stock" /></td>
                    <td className="px-1 py-1"><Input value={r.weight} inputMode="numeric" onChange={(e) => updateRow(r.key, { weight: e.target.value })} className="h-9 w-20" aria-label="Weight in grams" /></td>
                    <td className="px-2 py-2"><input type="checkbox" className="h-4 w-4 accent-peacock" checked={r.is_active} onChange={(e) => updateRow(r.key, { is_active: e.target.checked })} aria-label="On sale" /></td>
                    <td className="px-1 py-1">
                      {rows.length > 1 && <button type="button" onClick={() => setRows(rows.filter((x) => x.key !== r.key))} className="p-2 text-ink-faint hover:text-vermilion" aria-label="Remove version"><Trash2 className="h-4 w-4" /></button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setRows([...rows, { key: newKey(), sku: "", options: {}, mrp: rows[0]?.mrp ?? "", price: rows[0]?.price ?? "", stock: "", weight: "500", is_active: true }])}>
          <Plus className="h-4 w-4" /> Add a version
        </Button>
        {rows[0] && toPaise(rows[0].price) && cat && (
          <p className="mt-3 rounded-lg bg-peacock-light p-3 text-sm text-peacock">
            On a sale at {rupees(toPaise(rows[0].price)!)}, commission is {rupees(Math.round((toPaise(rows[0].price)! * cat.commission_bps) / 10000))} plus 18% GST on the commission. TCS (0.5%) and TDS (0.1%) are also deducted and can be claimed back in your returns.
          </p>
        )}
      </section>

      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-3">
        <h2 className="text-xl font-semibold sm:col-span-3">Tax and returns</h2>
        <TextField label="HSN code" value={hsn} onChange={(e) => setHsn(e.target.value.replace(/\D/g, ""))} maxLength={8} required hint="4, 6 or 8 digits from your GST invoice" />
        <Field label="GST rate" htmlFor="gst" hint="Check the rate for your HSN code">
          <Select id="gst" value={gst} onChange={(e) => setGst(Number(e.target.value))}>
            {GST_RATES.map((r) => <option key={r} value={r}>{pct(r)}</option>)}
          </Select>
        </Field>
        <Field label="Return window" htmlFor="ret">
          <Select id="ret" value={returnDays} onChange={(e) => setReturnDays(e.target.value)}>
            {[0, 3, 7, 10, 15, 30].map((d) => <option key={d} value={d}>{d === 0 ? "Not returnable" : `${d} days`}</option>)}
          </Select>
        </Field>
      </section>

      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-3 text-xl font-semibold">Specifications</h2>
        <div className="flex flex-col gap-2">
          {specs.map(([k, v], i) => (
            <div key={i} className="flex gap-2">
              <Input placeholder="e.g. Material" value={k} onChange={(e) => setSpecs(specs.map((s, j) => (j === i ? [e.target.value, s[1]] : s)))} className="max-w-[220px]" aria-label="Specification name" />
              <Input placeholder="e.g. 100% cotton" value={v} onChange={(e) => setSpecs(specs.map((s, j) => (j === i ? [s[0], e.target.value] : s)))} aria-label="Specification value" />
              <button type="button" onClick={() => setSpecs(specs.filter((_, j) => j !== i))} className="p-2 text-ink-faint hover:text-vermilion" aria-label="Remove specification"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setSpecs([...specs, ["", ""]])}><Plus className="h-4 w-4" /> Add specification</Button>
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => save(false)} loading={busy === "save"} disabled={busy !== null}>
            {product ? "Save changes" : "Save as draft"}
          </Button>
          {canSubmit && (
            <Button onClick={() => save(true)} loading={busy === "submit"} disabled={busy !== null}>Save and submit for review</Button>
          )}
        </div>
      </div>
      <Modal open={aiOpen} onClose={() => setAiOpen(false)} title="Write the listing with AI" wide>
        <div className="flex flex-col gap-3">
          <p className="text-ink-soft">Describe the product in your own words, in English or Tanglish: material, size, colours, what is in the box, who it is for. The assistant drafts a title, description, highlights and specifications. It only uses what you write.</p>
          <Textarea value={aiNotes} onChange={(e) => setAiNotes(e.target.value)} rows={5} maxLength={4000} aria-label="Product notes" placeholder="e.g. Pure cotton kurta for men, regular fit, sizes S to XXL, colours white and sky blue, machine washable, made in Tiruppur" />
          <ErrorNote message={aiError} />
          <Button onClick={runAi} loading={aiBusy} disabled={aiNotes.trim().length < 20} className="self-start"><Sparkles className="h-4 w-4" /> Draft listing</Button>
          {aiResult && (
            <div className="rounded-lg border border-line p-3">
              <div className="mb-1"><AiBadge mode={aiResult.mode} /></div>
              <p className="font-semibold">{aiResult.title}</p>
              <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{aiResult.description}</p>
              {aiResult.highlights.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{aiResult.highlights.map((h) => <li key={h}>{h}</li>)}</ul>}
              {aiResult.missing.length > 0 && (
                <div className="mt-2 rounded bg-marigold-light p-2 text-sm"><p className="font-semibold">Customers may also ask:</p><ul className="list-disc pl-5">{aiResult.missing.map((m) => <li key={m}>{m}</li>)}</ul></div>
              )}
              <Button className="mt-3" onClick={useAi}>Use this draft</Button>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
