"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote } from "@/components/ui";
import { api, ApiError, downloadFile } from "@/lib/api";

type Item = { variant_id: string; title: string; sku: string; label: string; total: number; is_active: boolean };
type Row = { id: string; sku: string | null; ok: boolean; reason: string | null; before?: number | boolean; after?: number | boolean };
type CsvRow = { row: number; id: string; sku: string | null; ok: boolean; reason: string | null; changes: Record<string, { before: number | boolean; after: number | boolean }> };
type CsvResult = { dry_run: boolean; changed: number; skipped: number; rows: CsvRow[] };
type Result = { dry_run: boolean; changed: number; skipped: number; rows: Row[] };

const ACTIONS: [string, string, boolean][] = [
  ["price_percent", "Change price by %", true],
  ["stock_set", "Set stock to", true],
  ["stock_add", "Add to stock", true],
  ["activate", "Switch on", false],
  ["deactivate", "Switch off", false],
];

export default function BulkEdit() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [action, setAction] = useState("price_percent");
  const [value, setValue] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState<CsvResult | null>(null);
  const [csvBusy, setCsvBusy] = useState<"check" | "apply" | null>(null);
  const needsValue = ACTIONS.find((a) => a[0] === action)?.[2] ?? false;

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Item[] }>("/api/seller/inventory", { query: { q } })).items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load products");
    }
  }, [q]);
  useEffect(() => { void load(); }, [load]);

  async function run(dry: boolean) {
    setBusy(dry ? "preview" : "apply");
    setError(null);
    try {
      const body = { variant_ids: [...picked], action, value: needsValue ? Number(value) : null, dry_run: dry };
      setRes(await api<Result>("/api/seller/variants/bulk-edit", { method: "POST", body }));
      if (!dry) void load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Bulk edit failed");
    } finally {
      setBusy(null);
    }
  }

  async function sendCsv(dry: boolean) {
    if (!file) return;
    setCsvBusy(dry ? "check" : "apply");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      setCsv(await api<CsvResult>("/api/seller/variants/bulk-edit.csv", { method: "POST", form, query: { dry_run: dry } }));
      if (!dry) void load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setCsvBusy(null);
    }
  }
  const fmt = (c: { before: number | boolean; after: number | boolean }, k: string) => (k === "price" ? `₹${(Number(c.before) / 100).toFixed(2)} to ₹${(Number(c.after) / 100).toFixed(2)}` : `${String(c.before)} to ${String(c.after)}`);

  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); setRes(null); };
  const ready = picked.size > 0 && (!needsValue || (value.trim() !== "" && Number.isFinite(Number(value))));

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <PageHeader back={{ href: "/seller/inventory", label: "Inventory" }} title="Bulk edit" sub="Pick product options, choose a change and preview it before applying. Options in a running deal keep their price." />
      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <input className="rounded-lg border px-3 py-2 text-sm" placeholder="Search title or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="max-h-80 overflow-auto text-sm">
          {items.map((i) => (
            <li key={i.variant_id} className="flex items-center gap-2 border-b py-1.5">
              <input type="checkbox" checked={picked.has(i.variant_id)} onChange={() => toggle(i.variant_id)} aria-label={`Select ${i.title} ${i.sku}`} />
              <span className="flex-1">{i.title} <span className="text-ink-faint">{i.label} ({i.sku})</span></span>
              <span>{i.total} in stock{i.is_active ? "" : ", off"}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded-lg border px-3 py-2 text-sm" value={action} onChange={(e) => { setAction(e.target.value); setRes(null); }}>
            {ACTIONS.map((a) => <option key={a[0]} value={a[0]}>{a[1]}</option>)}
          </select>
          {needsValue && <input className="w-28 rounded-lg border px-3 py-2 text-sm" inputMode="numeric" placeholder="Number" value={value} onChange={(e) => { setValue(e.target.value); setRes(null); }} />}
          <span className="text-sm text-ink-soft">{picked.size} selected</span>
        </div>
        <ErrorNote message={error} />
        <div className="flex gap-2">
          <Button onClick={() => run(true)} loading={busy === "preview"} disabled={!ready}>Preview</Button>
          {res?.dry_run && res.changed > 0 && <Button variant="buy" onClick={() => run(false)} loading={busy === "apply"}>Apply to {res.changed}</Button>}
        </div>
        {res && (
          <div className="text-sm">
            <p className="font-semibold">{res.dry_run ? "Would change" : "Changed"} {res.changed}, skipped {res.skipped}.</p>
            <ul className="mt-1 max-h-60 overflow-auto">
              {res.rows.map((r) => <li key={r.id}>{r.sku ?? r.id}: {r.ok ? `${String(r.before)} to ${String(r.after)}` : `skipped (${(r.reason ?? "").replaceAll("_", " ")})`}</li>)}
            </ul>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="font-semibold">Or edit in a spreadsheet</h2>
        <p className="text-sm text-ink-soft">Download all your options, change price (in rupees), stock or active (yes/no), then upload the file. Leave a cell blank to keep it. Check it first, then apply.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => downloadFile("/api/seller/variants/bulk-edit.csv", undefined, "my-versions.csv").catch(() => {})}>Download CSV</Button>
          <input type="file" accept=".csv,text/csv" aria-label="Edited CSV file" className="text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setCsv(null); }} />
          <Button onClick={() => sendCsv(true)} loading={csvBusy === "check"} disabled={!file}>Check file</Button>
          {csv?.dry_run && csv.changed > 0 && <Button variant="buy" onClick={() => sendCsv(false)} loading={csvBusy === "apply"}>Apply to {csv.changed}</Button>}
        </div>
        {csv && (
          <div className="text-sm">
            <p className="font-semibold">{csv.dry_run ? "Would change" : "Changed"} {csv.changed}, skipped {csv.skipped}.</p>
            <ul className="mt-1 max-h-60 overflow-auto">
              {csv.rows.map((r) => <li key={r.row}>Row {r.row} {r.sku ?? ""}: {r.ok ? Object.entries(r.changes).map(([k, c]) => `${k} ${fmt(c, k)}`).join(", ") : `skipped (${(r.reason ?? "").replaceAll("_", " ")})`}</li>)}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
