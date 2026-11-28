"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

type Col = {
  id: string; slug: string; title: string; description: string; image_url: string; is_active: boolean; position: number;
  product_slugs: string[]; category_slug: string; brand: string; min_price_paise: number | null; max_price_paise: number | null;
};
type Form = { title: string; slug: string; description: string; image_url: string; is_active: boolean; position: string; products: string; category_slug: string; brand: string; min: string; max: string };
const EMPTY: Form = { title: "", slug: "", description: "", image_url: "", is_active: true, position: "0", products: "", category_slug: "", brand: "", min: "", max: "" };
const rupeesToPaise = (v: string) => (v.trim() ? Math.round(Number(v) * 100) : null);

/** Collections: a page of chosen products at /collections/<link name>. Hand-picked by product link name, or by category, brand and price. */
export default function AdminCollections() {
  const toast = useToast();
  const [items, setItems] = useState<Col[] | null>(null);
  const [edit, setEdit] = useState<{ id: string | null; f: Form } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<{ items: Col[] }>("/api/admin/collections").then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  useEffect(() => { load(); }, [load]);

  function open(c?: Col) {
    setError(null);
    setEdit(c ? { id: c.id, f: { title: c.title, slug: c.slug, description: c.description, image_url: c.image_url, is_active: c.is_active, position: String(c.position), products: c.product_slugs.join(", "),
      category_slug: c.category_slug, brand: c.brand, min: c.min_price_paise == null ? "" : String(c.min_price_paise / 100), max: c.max_price_paise == null ? "" : String(c.max_price_paise / 100) } } : { id: null, f: EMPTY });
  }
  async function save() {
    if (!edit) return;
    const f = edit.f;
    setBusy(true);
    setError(null);
    const body = { title: f.title, slug: f.slug, description: f.description, image_url: f.image_url, is_active: f.is_active, position: Number(f.position) || 0,
      product_slugs: f.products.split(",").map((s) => s.trim()).filter(Boolean), category_slug: f.category_slug, brand: f.brand, min_price_paise: rupeesToPaise(f.min), max_price_paise: rupeesToPaise(f.max) };
    try {
      await api(edit.id ? `/api/admin/collections/${edit.id}` : "/api/admin/collections", { method: edit.id ? "PUT" : "POST", body });
      toast("Collection saved");
      setEdit(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the collection");
    } finally {
      setBusy(false);
    }
  }
  async function remove(c: Col) {
    if (!window.confirm(`Delete the collection "${c.title}"? Its page stops working. Products are not touched.`)) return;
    try {
      await api(`/api/admin/collections/${c.id}`, { method: "DELETE" });
      toast("Collection deleted");
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not delete", "error");
    }
  }
  const set = (patch: Partial<Form>) => setEdit((e) => (e ? { ...e, f: { ...e.f, ...patch } } : e));

  return (
    <div>
      <PageHeader title="Collections" sub="Pages of chosen products, like Diwali gifts or Under 999. Customers open them at /collections/<link name>." actions={<Button onClick={() => open()}>New collection</Button>} />
      {!items ? <PageLoader /> : items.length === 0 ? <EmptyState title="No collections yet" /> : (
        <ul className="flex flex-col gap-2">
          {items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-4">
              <div>
                <p className="font-semibold">{c.title} {!c.is_active && <span className="text-sm text-ink-faint">(hidden)</span>}</p>
                <p className="text-sm text-ink-soft">/collections/{c.slug} · {c.product_slugs.length ? `${c.product_slugs.length} chosen products` : "by rules"}</p>
              </div>
              <div className="flex gap-2"><Button variant="secondary" onClick={() => open(c)}>Edit</Button><Button variant="ghost" onClick={() => remove(c)}>Delete</Button></div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit collection" : "New collection"} wide>
        {edit && (
          <div className="flex flex-col gap-3">
            <Field label="Title"><Input value={edit.f.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} /></Field>
            <Field label="Link name" hint="Leave empty to make it from the title."><Input value={edit.f.slug} maxLength={80} onChange={(e) => set({ slug: e.target.value })} /></Field>
            <Field label="Description"><Textarea rows={2} maxLength={1000} value={edit.f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
            <Field label="Banner image address (optional)"><Input value={edit.f.image_url} maxLength={500} onChange={(e) => set({ image_url: e.target.value })} /></Field>
            <Field label="Chosen products" hint="Product link names (the last part of a product page address), comma separated, in the order shown. If you fill this, the rules below are not used."><Textarea rows={2} value={edit.f.products} onChange={(e) => set({ products: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Rule: category link name"><Input value={edit.f.category_slug} onChange={(e) => set({ category_slug: e.target.value })} /></Field>
              <Field label="Rule: brand"><Input value={edit.f.brand} onChange={(e) => set({ brand: e.target.value })} /></Field>
              <Field label="Rule: lowest price (₹)"><Input type="number" min="0" value={edit.f.min} onChange={(e) => set({ min: e.target.value })} /></Field>
              <Field label="Rule: highest price (₹)"><Input type="number" min="0" value={edit.f.max} onChange={(e) => set({ max: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.f.is_active} onChange={(e) => set({ is_active: e.target.checked })} />Shown to customers</label>
            <ErrorNote message={error} />
            <Button loading={busy} onClick={save}>Save collection</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
