"use client";

import { Download, FileSpreadsheet, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, PageLoader, Pill, Select } from "@/components/ui";
import { api, ApiError, downloadFile } from "@/lib/api";

export type ExportInfo = {
  name: string; label: string; description: string; columns: string[]; date_filter: string;
  statuses: { value: string; label: string }[]; needs_month: boolean; personal_data: boolean; date_optional?: boolean;
};

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

type Status = { state: "idle" | "exporting" | "done" | "failed"; message?: string };

function ExportCard({ base, info, maxDays }: { base: string; info: ExportInfo; maxDays: number }) {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [status, setStatus] = useState("");
  const [month, setMonth] = useState(today().slice(0, 7));
  const [st, setSt] = useState<Status>({ state: "idle" });
  const [useRange, setUseRange] = useState(!info.date_optional);
  const [showCols, setShowCols] = useState(false);
  const busy = useRef(false); // one download at a time per card, even on double clicks

  async function run() {
    if (busy.current) return;
    busy.current = true;
    setSt({ state: "exporting" });
    try {
      const ranged = info.date_filter && useRange;
      const query = info.needs_month ? { month } : { from: ranged ? from : undefined, to: ranged ? to : undefined, status: status || undefined };
      const name = await downloadFile(`${base}/${info.name}.csv`, query, `${info.name}.csv`);
      setSt({ state: "done", message: `Saved ${name}` });
    } catch (e) {
      setSt({ state: "failed", message: e instanceof ApiError ? e.message : "The export failed. Try again." });
    } finally {
      busy.current = false;
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-white p-4">
      <div className="flex items-start gap-3">
        <FileSpreadsheet className="mt-0.5 h-5 w-5 shrink-0 text-peacock" />
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{info.label}</h2>
            {info.personal_data && <Pill tone="red">Personal data</Pill>}
          </div>
          <p className="text-sm text-ink-soft">{info.description}</p>
        </div>
      </div>
      {info.date_optional && (
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-peacock" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} /> Filter by {info.date_filter}</label>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {info.needs_month ? (
          <Field label="Month" className="w-44"><Input type="month" value={month} max={today().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} /></Field>
        ) : info.date_filter && info.date_optional && !useRange ? null : info.date_filter ? (
          <>
            <Field label="From" className="w-40"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To" className="w-40"><Input type="date" value={to} min={from} max={today()} onChange={(e) => setTo(e.target.value)} /></Field>
          </>
        ) : null}
        {info.statuses.length > 0 && (
          <Field label="Status" className="w-48">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {info.statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          </Field>
        )}
        <Button onClick={run} loading={st.state === "exporting"}><Download className="h-4 w-4" /> Download CSV</Button>
      </div>
      {info.date_filter && useRange && <p className="text-xs text-ink-faint">Dates are by {info.date_filter}, in Indian time, up to {maxDays} days per file.</p>}
      {st.state === "done" && <p className="text-sm text-leaf" role="status">{st.message}</p>}
      {st.state === "failed" && <ErrorNote message={st.message} />}
      <button type="button" className="self-start text-sm font-semibold text-peacock" onClick={() => setShowCols(!showCols)} aria-expanded={showCols}>
        {showCols ? "Hide columns" : `Show the ${info.columns.length} columns`}
      </button>
      {showCols && <p className="text-sm text-ink-soft">{info.columns.join(" · ")}</p>}
    </section>
  );
}

/** Lists the exports this person may run and downloads them as CSV files (opens in Excel or Google Sheets). */
export function ExportCenter({ base, title, sub }: { base: string; title: string; sub: string }) {
  const [d, setD] = useState<{ items: ExportInfo[]; max_days: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: ExportInfo[]; max_days: number }>(base).then(setD).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load exports"));
  }, [base]);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} sub={sub} />
      <ErrorNote message={error} />
      {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? <EmptyState title="No exports for your role" /> : (
        <>
          {d.items.some((i) => i.personal_data) && (
            <p className="flex items-start gap-2 rounded-lg bg-marigold-light p-3 text-sm">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              Files marked Personal data contain names and contact details. Keep them on work devices, share them only for the purpose they were downloaded for, and delete them when done. Every download is recorded in the audit log.
            </p>
          )}
          <div className="grid gap-3 xl:grid-cols-2">{d.items.map((i) => <ExportCard key={i.name} base={base} info={i} maxDays={d.max_days} />)}</div>
        </>
      )}
    </div>
  );
}
