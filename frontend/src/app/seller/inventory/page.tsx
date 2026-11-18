"use client";

import { Download, History, Upload } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, Pagination, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError, downloadFile, latestOnly, quietly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Grid = {
  warehouses: { id: string; code: string; name: string; is_active: boolean }[];
  items: { variant_id: string; title: string; sku: string; label: string; total: number; is_active: boolean; levels: Record<string, number> }[];
  total: number;
  page: number;
  page_size: number;
};
type Move = { at: string; warehouse: string; kind: string; delta: number; balance: number; reference: string; note: string };

const KIND: Record<string, string> = { set: "Set", adjust: "Adjusted", sale: "Sold", release: "Cancelled order", return: "Return received", transfer: "Transfer" };

function Inventory() {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const low = sp.get("low_stock") === "1";
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [g, setG] = useState<Grid | null>(null);
  const [edit, setEdit] = useState<{ variant: Grid["items"][number]; wh: string } | null>(null);
  const [mode, setMode] = useState<"set" | "add" | "remove" | "transfer">("set");
  const [qty, setQty] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [moves, setMoves] = useState<{ title: string; items: Move[] } | null>(null);
  const [importResult, setImportResult] = useState<{ updated: number; errors: { row: number; error: string }[] } | null>(null);

  const track = useMemo(() => latestOnly(), []);

  const load = useCallback(() => track(api<Grid>("/api/seller/inventory", { query: { q, page, low_stock: low || undefined } }), setG), [q, page, low, track]);
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function save() {
    if (!edit) return;
    setError(null);
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 0) return setError("Enter a whole number");
    try {
      if (mode === "transfer") {
        await api("/api/seller/inventory/transfer", { method: "POST", body: { variant_id: edit.variant.variant_id, from_warehouse_id: edit.wh, to_warehouse_id: to, quantity: n } });
      } else {
        await api("/api/seller/inventory/adjust", { method: "POST", body: { variant_id: edit.variant.variant_id, warehouse_id: edit.wh, mode, quantity: n, note } });
      }
      toast("Stock updated");
      setEdit(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not update stock");
    }
  }

  async function upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    try {
      setImportResult(await api("/api/seller/inventory/import", { method: "POST", form }));
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Import failed", "error");
    }
  }

  async function exportCsv() {
    try {
      await downloadFile("/api/seller/exports/stock.csv", undefined, "stock.csv");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Export failed", "error");
    }
  }

  return (
    <div>
      <PageHeader
        title="Inventory"
        sub="Stock per warehouse. Orders are shipped from the warehouse closest to the customer that has the items."
        actions={
          <>
            <Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button>
            <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg bg-peacock px-4 font-semibold text-white hover:bg-peacock-dark">
              <Upload className="h-4 w-4" /> Import CSV
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </label>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input placeholder="Search by title or SKU" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-sm" aria-label="Search stock" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-peacock" checked={low} onChange={(e) => router.push(e.target.checked ? "/seller/inventory?low_stock=1" : "/seller/inventory")} /> Only 5 or fewer left</label>
      </div>
      {importResult && (
        <div className="mb-3 rounded-xl bg-white p-4 text-sm">
          <p className="font-semibold">{importResult.updated} rows updated{importResult.errors.length ? `, ${importResult.errors.length} rows skipped` : ""}.</p>
          {importResult.errors.slice(0, 10).map((e) => <p key={e.row} className="text-vermilion">Row {e.row}: {e.error}</p>)}
          <p className="mt-1 text-ink-faint">Columns: sku, warehouse_code, quantity. Quantities replace the current stock.</p>
        </div>
      )}
      {!g ? <PageLoader /> : g.items.length === 0 ? <EmptyState title="No products here" /> : (
        <div className="overflow-x-auto rounded-xl bg-white">
          <table className="w-full min-w-[720px] text-left text-[15px]">
            <thead className="border-b border-line text-sm text-ink-faint">
              <tr>
                <th className="px-4 py-2.5 font-medium">Product</th>
                {g.warehouses.map((w) => <th key={w.id} className="px-3 py-2.5 text-right font-medium">{w.code}{!w.is_active && " (off)"}</th>)}
                <th className="px-4 py-2.5 text-right font-medium">Available</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {g.items.map((it) => (
                <tr key={it.variant_id}>
                  <td className="px-4 py-2.5">
                    <p className="line-clamp-1 font-medium">{it.title}</p>
                    <p className="text-sm text-ink-faint">{it.sku}{it.label ? `, ${it.label}` : ""}</p>
                  </td>
                  {g.warehouses.map((w) => (
                    <td key={w.id} className="px-3 py-2.5 text-right">
                      <button className="rounded px-2 py-1 font-semibold hover:bg-peacock-light" onClick={() => { setEdit({ variant: it, wh: w.id }); setMode("set"); setQty(String(it.levels[w.id] ?? 0)); setNote(""); setError(null); setTo(g.warehouses.find((x) => x.id !== w.id)?.id ?? ""); }}>
                        {it.levels[w.id] ?? 0}
                      </button>
                    </td>
                  ))}
                  <td className={it.total <= 5 ? "px-4 py-2.5 text-right font-semibold text-vermilion" : "px-4 py-2.5 text-right font-semibold"}>{it.total}</td>
                  <td className="px-2 py-2.5">
                    <button aria-label="Stock history" className="rounded p-1.5 text-ink-faint hover:bg-mist" onClick={() => api<{ items: Move[] }>(`/api/seller/inventory/${it.variant_id}/movements`).then((r) => setMoves({ title: `${it.title} (${it.sku})`, items: r.items })).catch(quietly)}>
                      <History className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={g.page} pageSize={g.page_size} total={g.total} onPage={setPage} />
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Update stock">
        {edit && g && (
          <div className="flex flex-col gap-3">
            <p className="text-ink-soft">{edit.variant.title} ({edit.variant.sku}) at {g.warehouses.find((w) => w.id === edit.wh)?.name}: <strong>{edit.variant.levels[edit.wh] ?? 0}</strong> now</p>
            <ErrorNote message={error} />
            <div className="grid grid-cols-4 gap-1 rounded-lg bg-mist p-1 text-sm">
              {(["set", "add", "remove", "transfer"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} disabled={m === "transfer" && g.warehouses.length < 2} className={mode === m ? "rounded-md bg-white py-1.5 font-semibold text-peacock shadow-sm" : "py-1.5 text-ink-soft disabled:opacity-40"}>
                  {m === "set" ? "Set to" : m === "add" ? "Add" : m === "remove" ? "Remove" : "Move"}
                </button>
              ))}
            </div>
            <TextField label="Quantity" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
            {mode === "transfer" ? (
              <Field label="Move to" htmlFor="to">
                <Select id="to" value={to} onChange={(e) => setTo(e.target.value)}>
                  {g.warehouses.filter((w) => w.id !== edit.wh).map((w) => <option key={w.id} value={w.id}>{w.code}, {w.name}</option>)}
                </Select>
              </Field>
            ) : (
              <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. damaged in storage, new stock arrived" />
            )}
            <Button onClick={save}>Save</Button>
          </div>
        )}
      </Modal>
      <Modal open={!!moves} onClose={() => setMoves(null)} title="Stock history" wide>
        {moves && (
          <div>
            <p className="mb-2 text-ink-soft">{moves.title}</p>
            <table className="w-full text-sm">
              <thead className="text-ink-faint"><tr><th className="py-1 text-left">When</th><th className="text-left">Warehouse</th><th className="text-left">What</th><th className="text-right">Change</th><th className="text-right">After</th></tr></thead>
              <tbody>
                {moves.items.map((m, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="py-1">{dateTime(m.at)}</td><td>{m.warehouse}</td>
                    <td>{KIND[m.kind] ?? m.kind}{m.reference ? ` ${m.reference}` : ""}{m.note ? `: ${m.note}` : ""}</td>
                    <td className={m.delta < 0 ? "text-right text-vermilion" : "text-right text-leaf"}>{m.delta > 0 ? `+${m.delta}` : m.delta}</td>
                    <td className="text-right">{m.balance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function InventoryPage() {
  return <Suspense fallback={<PageLoader />}><Inventory /></Suspense>;
}
