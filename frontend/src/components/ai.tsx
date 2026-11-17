"use client";

import { AlertTriangle, CheckCircle2, ShieldAlert, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, ErrorNote, Field, Input, Pill, Select, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

export type AiRun = {
  id: string; task: string; task_label: string; status: string; mode: "live" | "sandbox"; model: string;
  output: { text?: string; subject?: string; [k: string]: unknown }; final_text: string; error: string;
  input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number; latency_ms: number;
  cost_usd: number | null; created_at: string; by?: string;
};

export type Brief = { score: number; level: "GREEN" | "AMBER" | "RED"; headline: string; factors: { weight: number; text: string }[]; notes: string[]; insufficient_history: boolean };

export function AiBadge({ mode }: { mode: "live" | "sandbox" }) {
  return mode === "sandbox" ? <Pill tone="blue">Sandbox</Pill> : <Pill tone="green">AI draft</Pill>;
}

const TONES = [["friendly", "Friendly"], ["formal", "Formal"], ["apologetic", "Apologetic"]] as const;

/**
 * Asks for an AI draft and hands it back for a person to edit. The draft never goes anywhere on its own.
 * base: "/api/admin/ai" or "/api/seller/ai".
 */
export function AiDraftButton({ base, task, subjectId, onDraft, withIntent, intentLabel = "What should it say? (optional)", label = "Draft with AI", requireIntent }: {
  base: string; task: string; subjectId: string; onDraft: (run: AiRun) => void; withIntent?: boolean; intentLabel?: string; label?: string; requireIntent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tone, setTone] = useState("friendly");
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const run = await api<AiRun>(`${base}/tasks/${task}`, { method: "POST", body: { subject_id: subjectId, tone, intent } });
      onDraft(run);
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The AI draft failed. Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}><Sparkles className="h-4 w-4" /> {label}</Button>;
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-peacock/30 bg-peacock-light/40 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Tone" className="w-40">
          <Select value={tone} onChange={(e) => setTone(e.target.value)}>{TONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        {withIntent && <Field label={intentLabel} className="min-w-[240px] flex-1"><Input value={intent} maxLength={300} onChange={(e) => setIntent(e.target.value)} /></Field>}
        <Button type="button" onClick={go} loading={busy} disabled={requireIntent && intent.trim().length < 5}><Sparkles className="h-4 w-4" /> Write draft</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <ErrorNote message={error} />
      <p className="text-xs text-ink-faint">You review and edit the draft before anything is sent.</p>
    </div>
  );
}

const LEVEL = {
  GREEN: { icon: CheckCircle2, cls: "border-leaf bg-leaf-light", text: "text-leaf" },
  AMBER: { icon: AlertTriangle, cls: "border-marigold bg-marigold-light", text: "text-[#8A5A00]" },
  RED: { icon: ShieldAlert, cls: "border-vermilion bg-vermilion/5", text: "text-vermilion" },
};

/** Explainable risk brief (rule-based score with every factor listed). */
export function RiskBrief({ path, title }: { path: string; title: string }) {
  const [b, setB] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Brief>(path).then(setB).catch((e) => setError(e instanceof ApiError ? e.message : null));
  }, [path]);
  if (error) return null;
  if (!b) return <section className="rounded-xl bg-white p-4"><Spinner /></section>;
  const L = LEVEL[b.level];
  return (
    <section className={`rounded-xl border p-4 ${L.cls}`} aria-label={title}>
      <div className="flex items-center gap-2">
        <L.icon className={`h-5 w-5 ${L.text}`} />
        <h2 className="font-semibold">{title}</h2>
        <span className={`ml-auto text-sm font-bold ${L.text}`}>{b.score}/100</span>
      </div>
      <p className={`mt-1 font-semibold ${L.text}`}>{b.headline}</p>
      {b.factors.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-sm">{b.factors.map((f) => <li key={f.text} className="flex justify-between gap-3"><span>{f.text}</span><span className="text-ink-faint">+{f.weight}</span></li>)}</ul>
      ) : <p className="mt-1 text-sm text-ink-soft">No risk signals found.</p>}
      {b.notes.map((n) => <p key={n} className="mt-2 text-xs text-ink-soft">{n}</p>)}
      {b.insufficient_history && <p className="mt-1 text-xs text-ink-faint">Little history yet, so treat the score as a rough guide.</p>}
    </section>
  );
}
