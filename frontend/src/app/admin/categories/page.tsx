"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Modal, PageLoader, Pill, Select, TextField, useToast } from "@/components/ui";
import { ImageField } from "@/components/media-picker";
import { useCan } from "@/lib/admin";
import { api, ApiError, quietly } from "@/lib/api";
import { GST_RATES, pct } from "@/lib/format";

type Cat = { id: string; name: string; slug: string; parent_id: string | null; image_url: string; commission_bps: number; default_gst_bps: number; position: number; is_active: boolean };
const EMPTY = { name: "", parent_id: "", commission: "10", gst: 1800, position: "0", is_active: true, image_url: "" };

export default function AdminCategories() {
  const toast = useToast();
  const canMedia = useCan("marketing");
  const [cats, setCats] = useState<Cat[] | null>(null);
  const [editing, setEditing] = useState<Cat | "new" | null>(null);
  const [f, setF] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Cat[]>("/api/admin/categories").then(setCats).catch(quietly), []);
  useEffect(() => { load(); }, [load]);

  const ordered = useMemo(() => {
    if (!cats) return [];
    const out: { c: Cat; depth: number }[] = [];
    const walk = (pid: string | null, depth: number) => cats.filter((c) => c.parent_id === pid).forEach((c) => { out.push({ c, depth }); walk(c.id, depth + 1); });
    walk(null, 0);
    return out;
  }, [cats]);

  function open(c: Cat | "new") {
    setError(null);
    setEditing(c);
    setF(c === "new" ? EMPTY : { name: c.name, parent_id: c.parent_id ?? "", commission: String(c.commission_bps / 100), gst: c.default_gst_bps, position: String(c.position), is_active: c.is_active, image_url: c.image_url });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = { name: f.name, parent_id: f.parent_id || null, commission_bps: Math.round(parseFloat(f.commission) * 100), default_gst_bps: f.gst, position: Number(f.position) || 0, is_active: f.is_active, image_url: f.image_url };
    try {
      if (editing === "new") await api("/api/admin/categories", { method: "POST", body });
      else if (editing) await api(`/api/admin/categories/${editing.id}`, { method: "PUT", body });
      toast("Category saved");
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  if (!cats) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Categories" sub="Sellers list products in the most specific category. Commission and GST here are defaults." actions={<Button onClick={() => open("new")}>Add category</Button>} />
      <Table head={["Category", "Commission", "Default GST", "Order", "Status", ""]}>
        {ordered.map(({ c, depth }) => (
          <tr key={c.id}>
            <td className="px-4 py-2.5" style={{ paddingLeft: 16 + depth * 24 }}>{depth ? "└ " : ""}<span className={depth ? "" : "font-semibold"}>{c.name}</span></td>
            <td className="px-4 py-2.5">{pct(c.commission_bps)}</td>
            <td className="px-4 py-2.5">{pct(c.default_gst_bps)}</td>
            <td className="px-4 py-2.5">{c.position}</td>
            <td className="px-4 py-2.5">{c.is_active ? <Pill tone="green">Active</Pill> : <Pill>Hidden</Pill>}</td>
            <td className="px-4 py-2.5"><Button size="sm" variant="ghost" onClick={() => open(c)}>Edit</Button></td>
          </tr>
        ))}
      </Table>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Add category" : "Edit category"}>
        <form onSubmit={save} className="flex flex-col gap-3">
          <ErrorNote message={error} />
          <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          {canMedia ? <ImageField label="Image" value={f.image_url} onChange={(url) => setF({ ...f, image_url: url })} aspect="aspect-square" hint="Shown on the home page category row" />
            : f.image_url ? <p className="text-sm text-ink-faint">This category has an image; it is kept when you save.</p> : null}
          <Field label="Parent" htmlFor="parent">
            <Select id="parent" value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}>
              <option value="">None (top level)</option>
              {ordered.filter(({ c }) => editing === "new" || c.id !== (editing as Cat | null)?.id).map(({ c, depth }) => <option key={c.id} value={c.id}>{"— ".repeat(depth)}{c.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Commission %" inputMode="decimal" value={f.commission} onChange={(e) => setF({ ...f, commission: e.target.value })} required />
            <Field label="Default GST" htmlFor="gst">
              <Select id="gst" value={f.gst} onChange={(e) => setF({ ...f, gst: Number(e.target.value) })}>{GST_RATES.map((r) => <option key={r} value={r}>{pct(r)}</option>)}</Select>
            </Field>
            <TextField label="Display order" inputMode="numeric" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} />
            <label className="flex items-center gap-2 pt-6"><input type="checkbox" className="accent-peacock" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Visible</label>
          </div>
          <Button type="submit">Save category</Button>
        </form>
      </Modal>
    </div>
  );
}
