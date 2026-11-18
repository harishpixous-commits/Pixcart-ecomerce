"use client";

import { Download, FileArchive, FileSpreadsheet, ShieldAlert, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, PageLoader, Pill, Select } from "@/components/ui";
import { api, ApiError, downloadFile, downloadPost } from "@/lib/api";
import { openAssistant } from "@/lib/assistant-bus";

type Filter = { key: string; label: string; kind: "lookup" | "choice" | "text" | "number"; options?: { value: string; label: string }[]; placeholder?: string };
export type ExportInfo = {
  name: string; label: string; description: string; columns: string[]; date_filter: string;
  statuses: { value: string; label: string }[]; needs_month: boolean; personal_data: boolean; date_optional?: boolean;
  filters?: Filter[]; formats?: string[]; pdf_columns?: string[]; pdf_max_columns?: number; pdf_max_rows?: number;
};
type Fmt = "csv" | "xlsx" | "pdf";
type Config = { format: Fmt; from?: string; to?: string; month?: string; status?: string; columns?: string[]; [k: string]: string | string[] | undefined };

const FMT_LABEL: Record<Fmt, string> = { csv: "CSV", xlsx: "Excel", pdf: "PDF" };
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

function LookupSelect({ base, kind, value, onChange, id }: { base: string; kind: string; value: string; onChange: (v: string) => void; id: string }) {
  const [opts, setOpts] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    api<{ items: { value: string; label: string }[] }>(`${base}/lookup/${kind}`).then((r) => setOpts(r.items)).catch(() => setOpts([]));
  }, [base, kind]);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All</option>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  );
}

function ExportCard({ base, info, maxDays, selected, onSelect, canBulk }: {
  base: string; info: ExportInfo; maxDays: number; selected: boolean; onSelect: (name: string, cfg: Config | null) => void; canBulk: boolean;
}) {
  const formats = (info.formats ?? ["csv"]) as Fmt[];
  const [cfg, setCfg] = useState<Config>({ format: "xlsx", from: daysAgo(30), to: today(), month: today().slice(0, 7), status: "" });
  const [useRange, setUseRange] = useState(!info.date_optional);
  const [cols, setCols] = useState<string[] | null>(null); // null = default set for the format
  const [showCols, setShowCols] = useState(false);
  const [st, setSt] = useState<{ state: "idle" | "busy" | "done" | "failed"; message?: string }>({ state: "idle" });
  const busy = useRef(false);
  const pdfMax = info.pdf_max_columns ?? 14;
  const effectiveCols = cols ?? (cfg.format === "pdf" ? info.pdf_columns ?? info.columns.slice(0, pdfMax) : info.columns);

  const query = useCallback((): Config => {
    const ranged = !!info.date_filter && useRange;
    const q: Config = { format: cfg.format };
    if (info.needs_month) q.month = cfg.month;
    else if (ranged) { q.from = cfg.from; q.to = cfg.to; }
    if (cfg.status) q.status = cfg.status;
    for (const f of info.filters ?? []) if (cfg[f.key]) q[f.key] = cfg[f.key];
    if (cols) q.columns = cols;
    return q;
  }, [cfg, cols, info, useRange]);

  useEffect(() => { if (selected) onSelect(info.name, query()); }, [selected, query, onSelect, info.name]);

  async function run() {
    if (busy.current) return;
    busy.current = true;
    setSt({ state: "busy" });
    try {
      const { format, ...q } = query();
      const name = await downloadFile(`${base}/${info.name}.${format}`, q, `${info.name}.${format}`);
      setSt({ state: "done", message: `Saved ${name}` });
    } catch (e) {
      setSt({ state: "failed", message: e instanceof ApiError ? e.message : "The export failed. Try again." });
    } finally {
      busy.current = false;
    }
  }

  const set = (k: string, v: string) => setCfg((c) => ({ ...c, [k]: v }));
  const tooMany = cfg.format === "pdf" && effectiveCols.length > pdfMax;

  return (
    <section className={`flex flex-col gap-3 rounded-xl bg-white p-4 ring-peacock/50 ${selected ? "ring-2" : ""}`}>
      <div className="flex items-start gap-3">
        <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-peacock" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{info.label}</h2>
            {info.personal_data && <Pill tone="red">Personal data</Pill>}
          </div>
          <p className="text-sm text-ink-soft">{info.description}</p>
        </div>
        {canBulk && (
          <label className="flex shrink-0 items-center gap-1.5 text-sm font-medium">
            <input type="checkbox" className="h-4 w-4 accent-peacock" checked={selected} onChange={(e) => onSelect(info.name, e.target.checked ? query() : null)} aria-label={`Select ${info.label} for bulk download`} />
            Select
          </label>
        )}
      </div>
      {info.date_optional && (
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-peacock" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} /> Filter by {info.date_filter}</label>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {info.needs_month ? (
          <Field label="Month" className="w-44"><Input type="month" value={cfg.month} max={today().slice(0, 7)} onChange={(e) => set("month", e.target.value)} /></Field>
        ) : info.date_filter && useRange ? (
          <>
            <Field label="From" className="w-40"><Input type="date" value={cfg.from} max={cfg.to} onChange={(e) => set("from", e.target.value)} /></Field>
            <Field label="To" className="w-40"><Input type="date" value={cfg.to} min={cfg.from} max={today()} onChange={(e) => set("to", e.target.value)} /></Field>
          </>
        ) : null}
        {info.statuses.length > 0 && (
          <Field label="Status" className="w-44">
            <Select value={cfg.status as string} onChange={(e) => set("status", e.target.value)}>
              <option value="">All</option>
              {info.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </Field>
        )}
        {(info.filters ?? []).map((f) => {
          const id = `${info.name}-${f.key}`;
          return (
            <Field key={f.key} label={f.label} htmlFor={id} className="w-44">
              {f.kind === "lookup" ? <LookupSelect id={id} base={base} kind={f.key} value={(cfg[f.key] as string) ?? ""} onChange={(v) => set(f.key, v)} />
                : f.kind === "choice" ? (
                  <Select id={id} value={(cfg[f.key] as string) ?? ""} onChange={(e) => set(f.key, e.target.value)}>
                    <option value="">All</option>
                    {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>)
                : <Input id={id} type={f.kind === "number" ? "number" : "search"} min={0} placeholder={f.placeholder} value={(cfg[f.key] as string) ?? ""} onChange={(e) => set(f.key, e.target.value)} />}
            </Field>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="File format" className="flex rounded-lg bg-mist p-0.5">
          {formats.map((f) => (
            <button key={f} role="radio" aria-checked={cfg.format === f} onClick={() => { setCfg((c) => ({ ...c, format: f })); if (f === "pdf" && cols && cols.length > pdfMax) setCols(null); }}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold ${cfg.format === f ? "bg-white text-peacock shadow-sm" : "text-ink-soft"}`}>
              {FMT_LABEL[f]}
            </button>
          ))}
        </div>
        <Button onClick={run} loading={st.state === "busy"} disabled={tooMany}><Download className="h-4 w-4" /> Download {FMT_LABEL[cfg.format]}</Button>
        {base.startsWith("/api/admin") && <Button variant="secondary" onClick={() => openAssistant({ context: { path: `/admin/exports#${info.name}`, title: info.label, filters: JSON.stringify(query()) },
          prompt: `Summarise the ${info.label.toLowerCase()} for the selected period and point out anything unusual.`, attach: true })}>
          <Sparkles className="h-4 w-4" /> Ask AI
        </Button>}
      </div>
      {info.date_filter && useRange && <p className="text-xs text-ink-faint">Dates are by {info.date_filter}, in Indian time, up to {maxDays} days per file.{cfg.format === "pdf" ? ` PDFs show up to ${info.pdf_max_rows ?? 2000} rows.` : ""}</p>}
      {st.state === "done" && <p className="text-sm text-leaf" role="status">{st.message}</p>}
      {st.state === "failed" && <ErrorNote message={st.message} />}
      <button type="button" className="self-start text-sm font-semibold text-peacock" onClick={() => setShowCols(!showCols)} aria-expanded={showCols}>
        {showCols ? "Hide columns" : `Choose columns (${effectiveCols.length} of ${info.columns.length})`}
      </button>
      {showCols && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-3 text-sm">
            <button className="text-peacock underline" onClick={() => setCols(cfg.format === "pdf" ? info.columns.slice(0, pdfMax) : [...info.columns])}>All{cfg.format === "pdf" ? ` (first ${pdfMax})` : ""}</button>
            <button className="text-peacock underline" onClick={() => setCols(null)}>Default</button>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-3">
            {info.columns.map((c) => (
              <label key={c} className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-peacock" checked={effectiveCols.includes(c)}
                  onChange={(e) => setCols(e.target.checked ? info.columns.filter((x) => x === c || effectiveCols.includes(x)) : effectiveCols.filter((x) => x !== c))} />
                <span className="truncate">{c}</span>
              </label>
            ))}
          </div>
          {tooMany && <p className="text-sm text-vermilion">A PDF fits {pdfMax} columns. Untick some, or choose Excel for all of them.</p>}
        </div>
      )}
    </section>
  );
}

/** Lists the exports this person may run: CSV, Excel or PDF, with filters and columns, one by one or many at once. */
export function ExportCenter({ base, title, sub }: { base: string; title: string; sub: string }) {
  const [d, setD] = useState<{ items: ExportInfo[]; max_days: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, Config>>({});
  const [asZip, setAsZip] = useState(true);
  const [bulk, setBulk] = useState<{ busy: boolean; message?: string; error?: string }>({ busy: false });
  const canZip = base === "/api/admin/exports";

  useEffect(() => {
    api<{ items: ExportInfo[]; max_days: number }>(base).then(setD).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load exports"));
  }, [base]);

  const onSelect = useCallback((name: string, cfg: Config | null) => {
    setPicked((p) => {
      if (cfg === null) { const { [name]: _, ...rest } = p; void _; return rest; }
      if (JSON.stringify(p[name]) === JSON.stringify(cfg)) return p;
      return { ...p, [name]: cfg };
    });
  }, []);
  const order = useMemo(() => (d?.items ?? []).map((i) => i.name).filter((n) => picked[n]), [d, picked]);

  async function downloadSelected() {
    setBulk({ busy: true });
    try {
      if (asZip && canZip) {
        const items = order.map((name) => ({ name, ...picked[name] }));
        const file = await downloadPost(`${base}/bulk`, { items }, "reports.zip");
        setBulk({ busy: false, message: `Saved ${file} with ${items.length} reports` });
      } else {
        const saved: string[] = [];
        for (const name of order) {
          const { format, ...q } = picked[name];
          saved.push(await downloadFile(`${base}/${name}.${format}`, q, `${name}.${format}`));
          await new Promise((r) => setTimeout(r, 400)); // browsers allow several downloads when spaced out
        }
        setBulk({ busy: false, message: `Saved ${saved.length} files: ${saved.join(", ")}` });
      }
    } catch (e) {
      setBulk({ busy: false, error: e instanceof ApiError ? e.message : "Download failed" });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} sub={sub} actions={d && d.items.length > 1 ? (
        <Button variant="secondary" onClick={() => setPicked(order.length === d.items.length ? {} : Object.fromEntries(d.items.map((i) => [i.name, picked[i.name] ?? { format: "xlsx" as Fmt }])))}>
          {order.length === d.items.length ? "Clear selection" : "Select all"}
        </Button>) : undefined} />
      <ErrorNote message={error} />
      {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? <EmptyState title="No exports for your role" /> : (
        <>
          {d.items.some((i) => i.personal_data) && (
            <p className="flex items-start gap-2 rounded-lg bg-marigold-light p-3 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              Files marked Personal data contain names and contact details. Keep them on work devices, share them only for the purpose they were downloaded for, and delete them when done. Every download is recorded in the audit log.
            </p>
          )}
          <div className="grid gap-3 xl:grid-cols-2">
            {d.items.map((i) => <ExportCard key={i.name} base={base} info={i} maxDays={d.max_days} selected={!!picked[i.name]} onSelect={onSelect} canBulk />)}
          </div>
          {order.length > 0 && (
            <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white p-3 shadow-lg sm:mr-20" role="region" aria-label="Bulk download">
              <FileArchive className="h-5 w-5 text-peacock" />
              <span className="font-semibold">{order.length} selected</span>
              <span className="text-sm text-ink-soft">{order.map((n) => `${d.items.find((i) => i.name === n)?.label} (${FMT_LABEL[picked[n].format]})`).join(", ")}</span>
              {canZip && (
                <label className="ml-auto flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="accent-peacock" checked={asZip} onChange={(e) => setAsZip(e.target.checked)} /> One ZIP file
                </label>
              )}
              <Button onClick={downloadSelected} loading={bulk.busy} className={canZip ? "" : "ml-auto"}><Download className="h-4 w-4" /> {asZip && canZip ? "Download ZIP" : "Download all"}</Button>
              {bulk.message && <p className="w-full text-sm text-leaf" role="status">{bulk.message}</p>}
              {bulk.error && <div className="w-full"><ErrorNote message={bulk.error} /></div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
