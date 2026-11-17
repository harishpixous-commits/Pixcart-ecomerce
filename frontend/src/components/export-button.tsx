"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorNote, Select } from "@/components/ui";
import { ApiError, downloadFile } from "@/lib/api";

const PERIODS = [["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last 12 months"]] as const;

/**
 * "Export" on a list page: downloads the matching CSV with the list's current status filter.
 * scope picks the endpoint (admin exports are role-checked, seller exports are the seller's own rows).
 */
export function ExportButton({ scope, name, status, dated = true }: { scope: "admin" | "seller"; name: string; status?: string; dated?: boolean }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState("30");
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
      const from = dated ? new Date(Date.now() - (Number(days) - 1) * 86400000).toISOString().slice(0, 10) : undefined;
      await downloadFile(`/api/${scope}/exports/${name}.csv`, { from, status: status || undefined }, `${name}.csv`);
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={box}>
      <Button variant="secondary" onClick={() => (dated ? setOpen(!open) : go())} loading={!dated && busy} aria-expanded={dated ? open : undefined}>
        <Download className="h-4 w-4" /> Export
      </Button>
      {!dated && error && <div className="absolute right-0 top-12 z-20 w-64"><ErrorNote message={error} /></div>}
      {dated && open && (
        <div className="absolute right-0 top-12 z-20 flex w-72 flex-col gap-2 rounded-xl border border-line bg-white p-3 shadow-lg" role="dialog" aria-label="Export">
          <label className="text-sm font-medium" htmlFor={`exp-${name}`}>Period</label>
          <Select id={`exp-${name}`} value={days} onChange={(e) => setDays(e.target.value)}>
            {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          {status && <p className="text-xs text-ink-faint">Only the rows in the current tab.</p>}
          <ErrorNote message={error} />
          <Button onClick={go} loading={busy}><Download className="h-4 w-4" /> Download CSV</Button>
          <Link href={`/${scope}/exports`} className="text-center text-sm font-semibold text-peacock">More options</Link>
        </div>
      )}
    </div>
  );
}
