"use client";

import { useState } from "react";
import { date, rupees } from "@/lib/format";

/** Daily bars with a hover readout; values in paise or counts. */
export function DailyBars({ series, valueKey, money, height = 160 }: { series: { date: string; [k: string]: number | string }[]; valueKey: string; money?: boolean; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = series.map((d) => Number(d[valueKey]) || 0);
  const peak = Math.max(0, ...values);
  const max = Math.max(1, peak);
  const fmt = (v: number) => (money ? rupees(v) : v.toLocaleString("en-IN"));
  const h = hover !== null ? series[hover] : null;
  return (
    <div>
      <p className="mb-1 h-5 text-sm text-ink-soft" aria-live="polite">{h ? `${date(String(h.date))}: ${fmt(Number(h[valueKey]))}` : peak ? `Highest day ${fmt(peak)}` : "Nothing in this period yet"}</p>
      <div className="flex items-end gap-[2px]" style={{ height }} role="img" aria-label={`Daily ${valueKey}`} onMouseLeave={() => setHover(null)}>
        {values.map((v, i) => (
          <div key={i} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
            <div className={`w-full rounded-t ${hover === i ? "bg-peacock" : "bg-peacock/70"}`} style={{ height: `${Math.max(v ? 3 : 1, (v / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink-faint">
        <span>{series[0] && date(String(series[0].date))}</span>
        <span>{series.length > 0 && date(String(series[series.length - 1].date))}</span>
      </div>
    </div>
  );
}

export function HBar({ items }: { items: { label: string; value: number; display: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="flex flex-col gap-2">
      {items.map((i) => (
        <li key={i.label} className="text-sm">
          <div className="mb-0.5 flex justify-between gap-2"><span className="truncate">{i.label}</span><span className="font-semibold">{i.display}</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-mist"><div className="h-full rounded-full bg-peacock" style={{ width: `${(i.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function Delta({ now, before }: { now: number; before: number }) {
  if (!before) return null;
  const pct = Math.round(((now - before) * 100) / before);
  return <span className={pct >= 0 ? "text-sm font-semibold text-leaf" : "text-sm font-semibold text-vermilion"}>{pct >= 0 ? "▲" : "▼"} {Math.abs(pct)}% vs previous period</span>;
}
