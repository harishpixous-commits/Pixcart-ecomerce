"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Modal, PageLoader, Pill, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { STATE_OPTIONS, STATES } from "@/lib/format";

type W = { id: string; code: string; name: string; line1: string; line2: string; city: string; state_code: string; pincode: string; contact_name: string; contact_phone: string; gstin: string; is_default: boolean; is_active: boolean; units: number; skus: number };
const EMPTY = { code: "", name: "", line1: "", line2: "", city: "", state_code: "33", pincode: "", contact_name: "", contact_phone: "", gstin: "", is_active: true };

export default function WarehousesPage() {
  const toast = useToast();
  const [items, setItems] = useState<W[] | null>(null);
  const [edit, setEdit] = useState<W | "new" | null>(null);
  const [f, setF] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const load = useCallback(() => api<W[]>("/api/seller/warehouses").then(setItems), []);
  useEffect(() => { load(); }, [load]);
  const bind = (k: keyof typeof EMPTY) => ({ value: String(f[k]), onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value }) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFields({});
    try {
      const list = edit === "new" ? await api<W[]>("/api/seller/warehouses", { method: "POST", body: f }) : await api<W[]>(`/api/seller/warehouses/${(edit as W).id}`, { method: "PUT", body: f });
      setItems(list);
      setEdit(null);
      toast("Warehouse saved");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      }
    }
  }

  const isMainEdit = edit !== null && edit !== "new" && edit.is_default;
  if (!items) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Warehouses" sub="Where you keep stock and ship from. A warehouse in another state needs your GSTIN for that state." actions={<Button onClick={() => { setF(EMPTY); setEdit("new"); setError(null); }}>Add warehouse</Button>} />
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((w) => (
          <section key={w.id} className="rounded-xl bg-white p-4">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="text-lg font-semibold">{w.name}</h2>
              <Pill tone="blue">{w.code}</Pill>
              {w.is_default && <Pill tone="green">Main</Pill>}
              {!w.is_active && <Pill tone="red">Off</Pill>}
            </div>
            <p className="text-ink-soft">{w.line1}{w.line2 ? `, ${w.line2}` : ""}, {w.city}, {STATES[w.state_code]} {w.pincode}</p>
            {w.gstin && <p className="text-sm text-ink-faint">GSTIN {w.gstin}</p>}
            <p className="mt-2 text-sm">{w.units.toLocaleString("en-IN")} units across {w.skus} product options</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => { setF({ ...EMPTY, ...w }); setEdit(w); setError(null); }}>Edit</Button>
          </section>
        ))}
      </div>
      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === "new" ? "Add warehouse" : "Edit warehouse"} wide>
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><ErrorNote message={error} /></div>
          <TextField label="Short code" {...bind("code")} required maxLength={20} placeholder="e.g. BLR1" disabled={edit !== "new"} hint="Used in stock CSV files" />
          <TextField label="Name" {...bind("name")} required />
          <TextField className="sm:col-span-2" label="Address" {...bind("line1")} required disabled={isMainEdit} />
          <TextField className="sm:col-span-2" label="Area (optional)" {...bind("line2")} />
          <TextField label="City" {...bind("city")} required />
          <TextField label="PIN code" {...bind("pincode")} required maxLength={6} inputMode="numeric" error={fields.pincode} disabled={isMainEdit} />
          <Field label="State" htmlFor="ws">
            <Select id="ws" {...bind("state_code")} disabled={isMainEdit}>{STATE_OPTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>
          </Field>
          <TextField label="GSTIN for this state" {...bind("gstin")} maxLength={15} error={fields.gstin} hint="Only if the state differs from your main GSTIN" />
          <TextField label="Contact person" {...bind("contact_name")} />
          <TextField label="Contact mobile" {...bind("contact_phone")} error={fields.contact_phone} />
          <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" className="accent-peacock" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Ship orders from this warehouse</label>
          <Button type="submit" className="self-start">Save warehouse</Button>
        </form>
      </Modal>
    </div>
  );
}
