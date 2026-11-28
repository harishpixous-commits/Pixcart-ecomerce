"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, Select, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

type Rule = { id: string; from_path: string; to_path: string; status_code: number; is_active: boolean; hits: number };
type Form = { from_path: string; to_path: string; status_code: string; is_active: boolean };
const EMPTY: Form = { from_path: "", to_path: "", status_code: "301", is_active: true };

/** URL redirects: an old address sends visitors to a new one when the shop has no page there (the page-not-found screen follows the rule). */
export default function AdminRedirects() {
  const toast = useToast();
  const [items, setItems] = useState<Rule[] | null>(null);
  const [edit, setEdit] = useState<{ id: string | null; f: Form } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<{ items: Rule[] }>("/api/admin/redirects").then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  useEffect(() => { load(); }, [load]);

  function open(r?: Rule) {
    setError(null);
    setEdit(r ? { id: r.id, f: { from_path: r.from_path, to_path: r.to_path, status_code: String(r.status_code), is_active: r.is_active } } : { id: null, f: EMPTY });
  }
  async function save() {
    if (!edit) return;
    setBusy(true);
    setError(null);
    const f = edit.f;
    try {
      await api(edit.id ? `/api/admin/redirects/${edit.id}` : "/api/admin/redirects", { method: edit.id ? "PUT" : "POST", body: { from_path: f.from_path, to_path: f.to_path, status_code: Number(f.status_code), is_active: f.is_active } });
      toast("Redirect saved");
      setEdit(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save the redirect");
    } finally {
      setBusy(false);
    }
  }
  async function remove(r: Rule) {
    if (!window.confirm(`Delete the redirect from ${r.from_path}?`)) return;
    try {
      await api(`/api/admin/redirects/${r.id}`, { method: "DELETE" });
      toast("Redirect deleted");
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not delete", "error");
    }
  }
  const set = (patch: Partial<Form>) => setEdit((e) => (e ? { ...e, f: { ...e.f, ...patch } } : e));

  return (
    <div>
      <PageHeader title="Redirects" sub="Send an old address to a new one, for example after changing a product's link name. It only applies where the shop has no page, so it never hides a working page." actions={<Button onClick={() => open()}>New redirect</Button>} />
      {!items ? <PageLoader /> : items.length === 0 ? <EmptyState title="No redirects yet" /> : (
        <ul className="flex flex-col gap-2">
          {items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-4">
              <div>
                <p className="font-semibold">{r.from_path} → {r.to_path} {!r.is_active && <span className="text-sm text-ink-faint">(off)</span>}</p>
                <p className="text-sm text-ink-soft">{r.status_code === 301 ? "Permanent (301)" : "Temporary (302)"} · used {r.hits} times</p>
              </div>
              <div className="flex gap-2"><Button variant="secondary" onClick={() => open(r)}>Edit</Button><Button variant="ghost" onClick={() => remove(r)}>Delete</Button></div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit redirect" : "New redirect"}>
        {edit && (
          <div className="flex flex-col gap-3">
            <Field label="Old address" hint="Starts with /, like /p/old-shirt. Capital letters and a last slash do not matter."><Input value={edit.f.from_path} maxLength={300} onChange={(e) => set({ from_path: e.target.value })} /></Field>
            <Field label="New address" hint="Starts with / for a page in the shop, or https:// for another site."><Input value={edit.f.to_path} maxLength={500} onChange={(e) => set({ to_path: e.target.value })} /></Field>
            <Field label="Kind" hint="Permanent tells search engines to move to the new address. Temporary is for a short change."><Select value={edit.f.status_code} onChange={(e) => set({ status_code: e.target.value })}><option value="301">Permanent (301)</option><option value="302">Temporary (302)</option></Select></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.f.is_active} onChange={(e) => set({ is_active: e.target.checked })} />Turned on</label>
            <ErrorNote message={error} />
            <Button loading={busy} onClick={save}>Save redirect</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
