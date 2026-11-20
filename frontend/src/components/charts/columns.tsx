"use client";

/*
 * A small column chart for in-app dashboards (partner earnings, delivery reports). One baseline, columns at most 24px
 * wide with a 4px rounded top, stacked parts separated by a 2px surface gap, hairline gridlines. Every column is a
 * focusable hit target with a tooltip (hover or keyboard) that lists every series; the tallest column carries its
 * value; a legend shows from two series up; "Show as table" gives every number without hovering.
 *
 * Colours: a single series uses the brand colour; two or more use the validated categorical order below
 * (blue, orange, aqua: colour-blind safe as adjacent pairs).
 */

import clsx from "clsx";
import { useId, useState } from "react";

export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"] as const;

export type ColumnSeries = { key: string; label: string; color?: string };
export type ColumnDatum = { key: string; label: string; title: string; values: Record<string, number>; highlight?: boolean };

/** Rounds the axis top up to a clean, even number (2, 4, 6, 8, 10 × 10^n), so the middle gridline is a whole value. */
function niceMax(v: number): number {
  if (v <= 0) return 2;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * exp >= v) return m * exp === 1 ? 2 : m * exp;
  return 10 * exp;
}

export function ColumnChart({ data, series, format, height = 168, labelEvery = 1, caption, className }: {
  data: ColumnDatum[];
  series: ColumnSeries[];
  format: (n: number) => string;
  /** plot height in px */
  height?: number;
  /** show every n-th x label (long ranges) */
  labelEvery?: number;
  /** what the chart shows, for screen readers and the table */
  caption: string;
  className?: string;
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const colors = series.map((s, i) => s.color ?? (series.length === 1 ? "rgb(var(--c-primary))" : SERIES_COLORS[i % SERIES_COLORS.length]));
  const totals = data.map((d) => series.reduce((n, s) => n + Math.max(0, d.values[s.key] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const ticks = [top, top / 2, 0];
  const peak = totals.indexOf(Math.max(...totals));
  const hi = data.findIndex((d) => d.highlight); // the highlighted day always gets its label; close neighbours give way
  const empty = totals.every((t) => t === 0);

  return (
    <figure className={clsx("flex flex-col gap-2", className)} aria-labelledby={`${id}-cap`}>
      <figcaption id={`${id}-cap`} className="sr-only">{caption}</figcaption>
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: colors[i] }} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {/* y axis */}
        <div className="relative w-12 shrink-0 text-right text-[11px] tabular-nums text-ink-faint" style={{ height }} aria-hidden>
          {ticks.map((t, i) => (
            <span key={i} className="absolute right-0 -translate-y-1/2" style={{ top: `${(i / (ticks.length - 1)) * 100}%` }}>{format(t)}</span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* gridlines */}
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height }} aria-hidden>
            {ticks.map((_, i) => (
              <span key={i} className={clsx("absolute inset-x-0 h-px", i === ticks.length - 1 ? "bg-[#c3c2b7]" : "bg-[#e1e0d9]")} style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} />
            ))}
          </div>
          <ol className="relative flex items-end" style={{ height }} onMouseLeave={() => setActive(null)}>
            {data.map((d, i) => {
              const total = totals[i];
              const h = (total / top) * height;
              return (
                <li key={d.key} className="relative flex h-full min-w-0 flex-1 justify-center">
                  <button
                    type="button"
                    className="group relative flex h-full w-full items-end justify-center outline-none"
                    aria-label={`${d.title}: ${series.map((s) => `${s.label} ${format(d.values[s.key] ?? 0)}`).join(", ")}`}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                  >
                    <span className={clsx("flex w-full max-w-[24px] flex-col-reverse gap-[2px] transition-opacity", active !== null && active !== i && "opacity-60",
                      "group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-peacock")}
                      style={{ height: Math.max(total > 0 ? 3 : 0, h) }}>
                      {series.map((s, k) => {
                        const v = Math.max(0, d.values[s.key] ?? 0);
                        if (!v) return null;
                        const isTop = series.slice(k + 1).every((x) => !(d.values[x.key] ?? 0));
                        return <span key={s.key} className={clsx("w-full", isTop && "rounded-t")} style={{ flexGrow: v, flexBasis: 0, minHeight: 2, background: colors[k] }} />;
                      })}
                    </span>
                    {i === peak && !empty && active === null && (
                      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-ink" style={{ bottom: h + 4 }}>
                        {format(total)}
                      </span>
                    )}
                  </button>
                  {active === i && (
                    <div role="tooltip" className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs text-white shadow-lg"
                      style={{ bottom: Math.min(h, height - 8) + 10, left: "50%" }}>
                      <p className="mb-0.5 text-[11px] text-white/70">{d.title}</p>
                      {series.map((s, k) => (
                        <p key={s.key} className="flex items-center gap-1.5">
                          <span className="h-0.5 w-3 rounded-full" style={{ background: colors[k] }} aria-hidden />
                          <b className="tabular-nums">{format(d.values[s.key] ?? 0)}</b>
                          {series.length > 1 && <span className="text-white/70">{s.label}</span>}
                        </p>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          {/* labels sit centred under their column and may spill into the empty neighbours (long ranges label every n-th day) */}
          <ol className="relative mt-1.5 flex h-4" aria-hidden>
            {data.map((d, i) => (
              <li key={d.key} className="relative min-w-0 flex-1">
                {(d.highlight || (i % labelEvery === 0 && (hi < 0 || labelEvery === 1 || Math.abs(hi - i) >= Math.ceil(labelEvery / 2)))) && (
                  <span className={clsx("absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap text-[11px]", d.highlight ? "font-bold text-ink" : "text-ink-faint")}>{d.label}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-semibold text-peacock">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg ring-1 ring-line">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{caption}</caption>
            <thead className="bg-mist text-ink-soft">
              <tr><th className="px-2 py-1.5 font-semibold">Day</th>{series.map((s) => <th key={s.key} className="px-2 py-1.5 text-right font-semibold">{s.label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.map((d) => (
                <tr key={d.key}><td className="px-2 py-1">{d.title}</td>{series.map((s) => <td key={s.key} className="px-2 py-1 text-right tabular-nums">{format(d.values[s.key] ?? 0)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
