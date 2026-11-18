"use client";

import { AlertTriangle, Check, ClipboardCopy, Download, ExternalLink, FileText, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Markdown } from "@/components/markdown";
import { api, ApiError, downloadFile } from "@/lib/api";

export type Block =
  | { type: "text"; text: string }
  | { type: "metrics"; title: string; note?: string; items: { label: string; value: string; hint?: string }[] }
  | { type: "table"; title: string; columns: string[]; rows: (string | number)[][]; total_rows?: number; note?: string; link?: string }
  | { type: "chart"; title: string; kind: "bar" | "line"; labels: string[]; unit?: string; series: { name: string; values: number[] }[] }
  | { type: "file"; title: string; format: string; path: string; filename: string; detail?: string }
  | { type: "links"; title: string; items: { label: string; href: string }[] }
  | { type: "action"; action_id: string; kind: string; summary: string; details: [string, string][]; status: string }
  | { type: "error"; text: string }
  | { type: "files"; items: { id: string; filename: string; rows: number }[] };

export function copyText(text: string) {
  return navigator.clipboard?.writeText(text);
}

function tsv(cols: string[], rows: (string | number)[][]) {
  return [cols, ...rows].map((r) => r.map((c) => String(c ?? "").replace(/\t|\n/g, " ")).join("\t")).join("\n");
}

function Metrics({ b }: { b: Extract<Block, { type: "metrics" }> }) {
  return (
    <figure className="rounded-xl border border-line bg-white p-3">
      <figcaption className="mb-2 text-sm font-semibold">{b.title}</figcaption>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {b.items.map((i) => (
          <div key={i.label} className="rounded-lg bg-mist/70 px-3 py-2">
            <p className="text-xs text-ink-faint">{i.label}</p>
            <p className="font-semibold tabular-nums">{i.value}</p>
            {i.hint && <p className={`text-xs ${i.hint.startsWith("+") ? "text-leaf" : i.hint.startsWith("-") ? "text-vermilion" : "text-ink-faint"}`}>{i.hint}</p>}
          </div>
        ))}
      </div>
      {b.note && <p className="mt-2 text-xs text-ink-faint">{b.note}</p>}
    </figure>
  );
}

function Table({ b }: { b: Extract<Block, { type: "table" }> }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ i: number; dir: 1 | -1 } | null>(null);
  const [copied, setCopied] = useState(false);
  const rows = useMemo(() => {
    let r = b.rows;
    if (q.trim()) r = r.filter((row) => row.some((c) => String(c).toLowerCase().includes(q.toLowerCase())));
    if (sort) {
      const num = (v: string | number) => Number(String(v).replace(/[₹,%\s]/g, ""));
      r = [...r].sort((x, y) => {
        const a = x[sort.i], c = y[sort.i];
        const na = num(a), nc = num(c);
        return (Number.isFinite(na) && Number.isFinite(nc) && String(a).trim() !== "" ? na - nc : String(a).localeCompare(String(c))) * sort.dir;
      });
    }
    return r;
  }, [b.rows, q, sort]);
  if (!b.rows.length) return <p className="rounded-xl border border-line bg-white p-3 text-sm text-ink-soft">{b.title}: nothing found.</p>;
  return (
    <figure className="min-w-0 rounded-xl border border-line bg-white">
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-sm font-semibold">{b.title}</span>
        <span className="text-xs text-ink-faint">{b.total_rows && b.total_rows > b.rows.length ? `${b.rows.length} of ${b.total_rows}` : `${b.rows.length} rows`}</span>
        <span className="ml-auto flex items-center gap-1">
          {b.rows.length > 8 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label={`Filter ${b.title}`} className="h-7 w-28 rounded-md border border-line px-2 text-xs" />}
          <button className="rounded p-1 text-ink-faint hover:bg-mist" title="Copy table (paste into Excel)" aria-label="Copy table"
            onClick={async () => { await copyText(tsv(b.columns, rows)); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check className="h-4 w-4 text-leaf" /> : <ClipboardCopy className="h-4 w-4" />}
          </button>
          {b.link && <Link href={b.link} className="rounded p-1 text-ink-faint hover:bg-mist" title="Open the page" aria-label="Open the page"><ExternalLink className="h-4 w-4" /></Link>}
        </span>
      </figcaption>
      <div className="max-h-80 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-mist">
            <tr>{b.columns.map((c, i) => (
              <th key={c + i} className="whitespace-nowrap px-2 py-1.5 text-left font-semibold">
                <button onClick={() => setSort(sort?.i === i ? { i, dir: sort.dir === 1 ? -1 : 1 } : { i, dir: 1 })} className="hover:text-peacock">
                  {c}{sort?.i === i ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                </button>
              </th>))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-t border-line/70 odd:bg-white even:bg-mist/30">
                {r.map((c, ci) => <td key={ci} className="whitespace-nowrap px-2 py-1 tabular-nums">{String(c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {b.note && <p className="border-t border-line px-3 py-1.5 text-xs text-ink-faint">{b.note}</p>}
    </figure>
  );
}

const PALETTE = ["rgb(var(--c-primary))", "rgb(var(--c-accent))", "#5B7F2B", "#7A4E9C"];

function Chart({ b }: { b: Extract<Block, { type: "chart" }> }) {
  const W = 560, H = 190, P = { l: 52, r: 8, t: 10, b: 34 };
  const all = b.series.flatMap((s) => s.values);
  const max = Math.max(1, ...all), min = Math.min(0, ...all);
  const x = (i: number, n: number) => P.l + (n <= 1 ? (W - P.l - P.r) / 2 : (i * (W - P.l - P.r)) / (n - 1));
  const y = (v: number) => P.t + (H - P.t - P.b) * (1 - (v - min) / (max - min || 1));
  const fmt = (v: number) => (b.unit === "₹" ? "₹" : "") + (v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(v % 1 ? 1 : 0));
  const n = b.labels.length;
  const step = Math.max(1, Math.ceil(n / 8));
  const bw = Math.max(4, ((W - P.l - P.r) / Math.max(n, 1)) * 0.7 / b.series.length);
  return (
    <figure className="rounded-xl border border-line bg-white p-3">
      <figcaption className="mb-1 text-sm font-semibold">{b.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={b.title}>
        {[0, 0.5, 1].map((t) => {
          const v = min + (max - min) * t;
          return <g key={t}><line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="#E3E7EA" /><text x={P.l - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#7A8594">{fmt(v)}</text></g>;
        })}
        {b.series.map((s, si) => b.kind === "line" ? (
          <g key={s.name}>
            <polyline fill="none" stroke={PALETTE[si % 4]} strokeWidth="2" points={s.values.map((v, i) => `${x(i, n)},${y(v)}`).join(" ")} />
            {s.values.map((v, i) => <circle key={i} cx={x(i, n)} cy={y(v)} r="2.5" fill={PALETTE[si % 4]}><title>{`${b.labels[i]}: ${fmt(v)}`}</title></circle>)}
          </g>
        ) : (
          <g key={s.name}>
            {s.values.map((v, i) => {
              const cx = P.l + ((i + 0.5) * (W - P.l - P.r)) / n - (bw * b.series.length) / 2 + si * bw;
              return <rect key={i} x={cx} width={bw} y={y(Math.max(v, 0))} height={Math.abs(y(v) - y(0))} rx="2" fill={PALETTE[si % 4]}><title>{`${b.labels[i]}: ${fmt(v)}`}</title></rect>;
            })}
          </g>
        ))}
        {b.labels.map((l, i) => i % step === 0 && (
          <text key={i} x={b.kind === "line" ? x(i, n) : P.l + ((i + 0.5) * (W - P.l - P.r)) / n} y={H - 14} textAnchor="middle" fontSize="10" fill="#4A5565">{l.length > 12 ? l.slice(0, 11) + "…" : l}</text>
        ))}
      </svg>
      {b.series.length > 1 && <p className="flex gap-3 text-xs">{b.series.map((s, i) => <span key={s.name}><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: PALETTE[i % 4] }} />{s.name}</span>)}</p>}
    </figure>
  );
}

function FileCard({ b }: { b: Extract<Block, { type: "file" }> }) {
  const [state, setState] = useState<{ busy: boolean; msg?: string; err?: string }>({ busy: false });
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-peacock/30 bg-peacock-light/40 p-3">
      <FileText className="h-6 w-6 text-peacock" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{b.title} · {b.format.toUpperCase()}</p>
        {b.detail && <p className="truncate text-xs text-ink-soft">{b.detail}</p>}
        {state.msg && <p className="text-xs text-leaf">{state.msg}</p>}
        {state.err && <p className="text-xs text-vermilion">{state.err}</p>}
      </div>
      <button className="inline-flex items-center gap-1.5 rounded-lg bg-peacock px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60" disabled={state.busy}
        onClick={async () => {
          setState({ busy: true });
          try { setState({ busy: false, msg: `Saved ${await downloadFile(b.path, undefined, b.filename)}` }); }
          catch (e) { setState({ busy: false, err: e instanceof ApiError ? e.message : "Download failed" }); }
        }}>
        {state.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download
      </button>
    </div>
  );
}

function ActionCard({ b, onDone }: { b: Extract<Block, { type: "action" }>; onDone?: (status: string) => void }) {
  const [status, setStatus] = useState(b.status);
  const [busy, setBusy] = useState<"" | "confirm" | "cancel">("");
  const [err, setErr] = useState("");
  async function decide(what: "confirm" | "cancel") {
    setBusy(what);
    setErr("");
    try {
      const r = await api<{ status: string }>(`/api/admin/assistant/actions/${b.action_id}/${what}`, { method: "POST" });
      setStatus(r.status);
      onDone?.(r.status);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not do that");
      if (e instanceof ApiError && e.status === 409) setStatus("failed");
    } finally {
      setBusy("");
    }
  }
  const tone = status === "done" ? "border-leaf/40 bg-leaf-light/40" : status === "pending" ? "border-marigold/50 bg-marigold-light/50" : "border-line bg-mist/60";
  return (
    <div className={`rounded-xl border p-3 ${tone}`} role="group" aria-label={`Proposed change: ${b.summary}`}>
      <p className="font-semibold">{b.summary}</p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        {b.details.map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-faint">{k}</dt><dd className="break-words">{v}</dd></div>)}
      </dl>
      {status === "pending" ? (
        <div className="mt-2 flex gap-2">
          <button onClick={() => decide("confirm")} disabled={!!busy} className="inline-flex items-center gap-1 rounded-lg bg-peacock px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">
            {busy === "confirm" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Confirm
          </button>
          <button onClick={() => decide("cancel")} disabled={!!busy} className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold">
            <X className="h-4 w-4" /> Cancel
          </button>
        </div>
      ) : (
        <p className="mt-2 text-sm font-semibold">{status === "done" ? "Done" : status === "cancelled" ? "Cancelled" : status === "expired" ? "Expired — ask again" : "Not done"}</p>
      )}
      {err && <p className="mt-1 text-sm text-vermilion">{err}</p>}
    </div>
  );
}

export function BlockView({ b, streaming }: { b: Block; streaming?: boolean }) {
  switch (b.type) {
    case "text":
      return <div className="assistant-md min-w-0 text-[15px] leading-relaxed"><Markdown source={b.text} />{streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-peacock align-middle" aria-hidden />}</div>;
    case "metrics":
      return <Metrics b={b} />;
    case "table":
      return <Table b={b} />;
    case "chart":
      return <Chart b={b} />;
    case "file":
      return <FileCard b={b} />;
    case "links":
      return <div className="flex flex-wrap gap-2">{b.items.map((l) => <Link key={l.href} href={l.href} className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-3 py-1 text-sm hover:border-peacock">{l.label}<ExternalLink className="h-3 w-3" /></Link>)}</div>;
    case "action":
      return <ActionCard b={b} />;
    case "error":
      return <p className="flex items-start gap-2 rounded-lg bg-vermilion-light p-3 text-sm text-vermilion"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{b.text}</p>;
    case "files":
      return <div className="flex flex-wrap justify-end gap-1">{b.items.map((f) => <span key={f.id} className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-xs"><FileText className="h-3 w-3" />{f.filename} · {f.rows} rows</span>)}</div>;
    default:
      return null;
  }
}
