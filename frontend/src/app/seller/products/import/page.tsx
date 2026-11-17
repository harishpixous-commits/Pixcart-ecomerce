"use client";

import { CheckCircle2, Download, FileUp, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { Button, ErrorNote, Pill } from "@/components/ui";
import { api, ApiError, downloadFile } from "@/lib/api";

type Row = { key: string; row: number; title: string; category: string; variants: number; errors: string[] };
type Result = { dry_run: boolean; file_errors: { row: number; error: string }[]; products: Row[]; valid: number; invalid: number; created: { key: string; id: string; title: string }[] };

export default function ImportListings() {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"check" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(dry: boolean) {
    if (!file) return;
    setBusy(dry ? "check" : "create");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      setRes(await api<Result>("/api/seller/products/import", { method: "POST", form, query: { dry_run: dry } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <PageHeader title="Bulk upload listings" sub="Add many products at once from a spreadsheet. Products are saved as drafts; add photos to each and submit them for review." />
      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">1. Fill in the template</h2>
        <p className="text-sm text-ink-soft">One row per product option (size, colour). Rows with the same <code className="rounded bg-mist px-1">product_key</code> become one product; product details are read from its first row. Prices are in rupees, the category is a sub-category name exactly as shown in the listing form, GST rate is a percentage (leave empty for the category default). Up to 300 products and 2,000 rows per file.</p>
        <Button variant="secondary" className="self-start" onClick={() => downloadFile("/api/seller/products/import-template.csv", undefined, "listing-upload-template.csv").catch(() => {})}><Download className="h-4 w-4" /> Download template</Button>
      </section>
      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">2. Upload and check</h2>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-peacock/40 p-5 hover:bg-peacock-light">
          <FileUp className="h-6 w-6 text-peacock" />
          <span><span className="font-semibold">{file ? file.name : "Choose a CSV file"}</span><br /><span className="text-sm text-ink-soft">Save from Excel or Google Sheets as &quot;CSV UTF-8&quot;</span></span>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRes(null); }} />
        </label>
        <ErrorNote message={error} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => send(true)} loading={busy === "check"} disabled={!file}>Check file</Button>
          {res?.dry_run && res.valid > 0 && <Button variant="buy" onClick={() => send(false)} loading={busy === "create"}>Create {res.valid} draft{res.valid === 1 ? "" : "s"}</Button>}
        </div>
      </section>
      {res && (
        <section className="flex flex-col gap-3">
          {res.file_errors.map((e, i) => <ErrorNote key={i} message={e.row ? `Row ${e.row}: ${e.error}` : e.error} />)}
          {!res.dry_run && (
            <div className="rounded-xl bg-leaf-light p-4">
              <p className="font-semibold">{res.created.length} draft{res.created.length === 1 ? "" : "s"} created{res.invalid ? `; ${res.invalid} skipped because of the problems below` : ""}.</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">{res.created.slice(0, 20).map((c) => <li key={c.id}><Link href={`/seller/products/${c.id}`} className="text-peacock hover:underline">{c.title}</Link>: add photos and submit</li>)}</ul>
            </div>
          )}
          {res.products.length > 0 && (
            <Table head={["", "Product", "Category", "Options", "Problems"]}>
              {res.products.map((p) => (
                <tr key={p.key} className="align-top">
                  <td className="px-3 py-2">{p.errors.length ? <XCircle className="h-5 w-5 text-vermilion" aria-label="Has problems" /> : <CheckCircle2 className="h-5 w-5 text-leaf" aria-label="Ready" />}</td>
                  <td className="px-3 py-2"><p className="font-medium">{p.title || p.key}</p><p className="text-xs text-ink-faint">{p.key}, from row {p.row}</p></td>
                  <td className="px-3 py-2 text-sm">{p.category}</td>
                  <td className="px-3 py-2">{p.variants}</td>
                  <td className="px-3 py-2 text-sm">{p.errors.length ? <ul className="list-disc pl-4 text-vermilion">{p.errors.map((e) => <li key={e}>{e}</li>)}</ul> : <Pill tone="green">Ready</Pill>}</td>
                </tr>
              ))}
            </Table>
          )}
        </section>
      )}
    </div>
  );
}
