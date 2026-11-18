"use client";

import { Download, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorNote, Select } from "@/components/ui";
import { ApiError, downloadFile } from "@/lib/api";
import { openAssistant } from "@/lib/assistant-bus";

const PERIODS = [["1", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last 12 months"]] as const;
const FORMATS = [["xlsx", "Excel"], ["csv", "CSV"], ["pdf", "PDF"]] as const;

/**
 * "Export" on a list page: downloads the matching file (Excel, CSV or PDF) with the list's current status filter.
 * Admin pages also get "Ask AI", which opens the assistant with this list as context (and lets you attach a file to compare).
 */
export function ExportButton({ scope, name, status, dated = true, label }: { scope: "admin" | "seller"; name: string; status?: string; dated?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState("30");
  const [fmt, setFmt] = useState("xlsx");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function go() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const from = dated ? new Date(Date.now() - (Number(days) - 1) * 86400000 + 19800000).toISOString().slice(0, 10) : undefined;
      await downloadFile(`/api/${scope}/exports/${name}.${fmt}`, { from, status: status || undefined }, `${name}.${fmt}`);
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  const what = label ?? name.replace("-", " ");
  return (
    <div className="relative flex gap-2" ref={box}>
      {scope === "admin" && (
        <Button variant="secondary" aria-label={`Ask AI about ${what}`} title="Ask AI about this list or compare a file"
          onClick={() => openAssistant({ context: { path: typeof window !== "undefined" ? window.location.pathname : "", title: what, filters: status ? `status=${status}` : "" },
            prompt: `Give me a quick summary of ${what}${status ? ` (${status})` : ""} for the last 30 days.`, attach: true })}>
          <Sparkles className="h-4 w-4" /><span className="hidden sm:inline">Ask AI</span>
        </Button>
      )}
      <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Download className="h-4 w-4" /> Export
      </Button>
      {open && (
        <div className="absolute right-0 top-12 z-20 flex w-72 flex-col gap-2 rounded-xl border border-line bg-white p-3 shadow-lg" role="dialog" aria-label="Export">
          {dated && (
            <>
              <label className="text-sm font-medium" htmlFor={`exp-${name}`}>Period</label>
              <Select id={`exp-${name}`} value={days} onChange={(e) => setDays(e.target.value)}>
                {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </>
          )}
          <div role="radiogroup" aria-label="File format" className="flex rounded-lg bg-mist p-0.5">
            {FORMATS.map(([v, l]) => (
              <button key={v} role="radio" aria-checked={fmt === v} onClick={() => setFmt(v)}
                className={`flex-1 rounded-md px-2 py-1.5 text-sm font-semibold ${fmt === v ? "bg-white text-peacock shadow-sm" : "text-ink-soft"}`}>{l}</button>
            ))}
          </div>
          {status && <p className="text-xs text-ink-faint">Only the rows in the current tab.</p>}
          <ErrorNote message={error} />
          <Button onClick={go} loading={busy}><Download className="h-4 w-4" /> Download {FORMATS.find(([v]) => v === fmt)?.[1]}</Button>
          <Link href={`/${scope}/exports`} className="text-center text-sm font-semibold text-peacock">More options and bulk download</Link>
        </div>
      )}
    </div>
  );
}
