"use client";

/*
 * A small editor for a group of marketplace settings (Admin → Deals → Rules, Admin → Advertising → Settings, ...).
 * It reads the current values, edits only its own keys, checks the ranges the server accepts and saves them together.
 */

import { useEffect, useState } from "react";
import { Button, ErrorNote, PageLoader, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { paiseToInput, rupees, toPaise } from "@/lib/format";

export type SettingField =
  | { k: string; kind: "bool"; label: string; hint: string }
  | { k: string; kind: "int"; label: string; hint: string; min: number; max: number; needs?: string }
  | { k: string; kind: "rupees"; label: string; hint: string; min: number; max: number; needs?: string };

type Values = Record<string, boolean | number>;

export function SettingsBlock({ title, sub, fields, saveLabel = "Save", onSaved }: {
  title: string; sub?: string; fields: SettingField[]; saveLabel?: string; onSaved?: (v: Values) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string | boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api<Values>("/api/admin/settings").then((v) => {
      if (!live) return;
      setDraft(Object.fromEntries(fields.map((f) => [f.k, f.kind === "bool" ? Boolean(v[f.k]) : f.kind === "rupees" ? paiseToInput(Number(v[f.k] ?? 0)) : String(v[f.k] ?? "")])));
    }).catch((e) => { quietly(e); if (live) setError(e instanceof ApiError ? e.message : "Could not load the settings"); });
    return () => { live = false; };
    // the field list is fixed for each page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!draft) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const off = (f: SettingField) => "needs" in f && f.needs ? !draft[f.needs] : false;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setError(null);
    const body: Values = {};
    for (const f of fields) {
      if (f.kind === "bool") { body[f.k] = Boolean(draft[f.k]); continue; }
      const raw = String(draft[f.k] ?? "");
      const n = f.kind === "rupees" ? toPaise(raw) : /^\d+$/.test(raw) ? Number(raw) : null;
      if (n === null || n < f.min || n > f.max) {
        return setError(f.kind === "rupees" ? `${f.label}: enter ${rupees(f.min)} to ${rupees(f.max)}` : `${f.label}: enter ${f.min} to ${f.max}`);
      }
      body[f.k] = n;
    }
    setBusy(true);
    try {
      const saved = await api<Values>("/api/admin/settings", { method: "PUT", body });
      toast(`${title} saved`);
      onSaved?.(saved);
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex max-w-3xl flex-col gap-3 rounded-xl bg-white p-5" data-testid="settings-block">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {sub && <p className="text-sm text-ink-soft">{sub}</p>}
      </div>
      <ErrorNote message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => f.kind === "bool" ? (
          <label key={f.k} className="flex items-start gap-3 rounded-lg border border-line p-3 sm:col-span-2">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={Boolean(draft[f.k])} onChange={(e) => setDraft({ ...draft, [f.k]: e.target.checked })} data-testid={`toggle-${f.k}`} />
            <span><span className="font-semibold">{f.label}</span><br /><span className="text-sm text-ink-soft">{f.hint}</span></span>
          </label>
        ) : (
          <TextField key={f.k} label={f.label} hint={f.hint} inputMode={f.kind === "rupees" ? "decimal" : "numeric"} value={String(draft[f.k] ?? "")} disabled={off(f)}
            onChange={(e) => setDraft({ ...draft, [f.k]: f.kind === "rupees" ? e.target.value : e.target.value.replace(/\D/g, "") })} />
        ))}
      </div>
      <Button type="submit" loading={busy} className="self-start">{saveLabel}</Button>
    </form>
  );
}
