"use client";

import { Bot, Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AiRun } from "@/components/ai";
import { PageHeader, Stat, Table, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, Pagination, Pill, Select, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, downloadFile, latestOnly, quietly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Cfg = { enabled: boolean; model: string; monthly_token_budget: number; price_input_per_mtok: number; price_output_per_mtok: number; brand_voice: string; tasks: Record<string, { enabled: boolean; instructions: string }> };
type TaskInfo = { key: string; label: string; description: string; audience: string; output: string; rules: string; enabled: boolean; instructions: string; runs_this_month: number; used_this_month: number };
type Studio = {
  settings: Cfg; status: { mode: "live" | "sandbox"; key_configured: boolean; environment: string }; models: { id: string; label: string }[];
  usage: { runs: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number; budget_left: number | null };
  tasks: TaskInfo[];
};

const AUDIENCE: Record<string, string> = { seller: "Sellers", admin: "Staff", system: "Automatic" };
const STATUS: Record<string, string> = { draft: "Draft", applied: "Used", sent: "Sent", discarded: "Discarded", failed: "Failed" };
const n = (x: number) => x.toLocaleString("en-IN");

function Runs({ tasks }: { tasks: TaskInfo[] }) {
  const [task, setTask] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ items: AiRun[]; total: number; page: number; page_size: number } | null>(null);
  const [detail, setDetail] = useState<(AiRun & { inputs: Record<string, unknown> }) | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<typeof d>("/api/admin/ai/runs", { query: { task: task || undefined, status: status || undefined, page } }), setD), [task, status, page, track]);
  useEffect(() => { load(); }, [load]);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="mr-auto text-lg font-semibold">Activity</h2>
        <Field label="Feature" className="w-52"><Select value={task} onChange={(e) => { setTask(e.target.value); setPage(1); }}><option value="">All</option>{tasks.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select></Field>
        <Field label="Outcome" className="w-40"><Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All</option>{Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Button variant="secondary" onClick={() => downloadFile("/api/admin/exports/ai-runs.csv", { status: status || undefined }, "ai-usage.csv").catch(() => {})}><Download className="h-4 w-4" /> Export</Button>
      </div>
      {!d ? <PageLoader /> : d.items.length === 0 ? <EmptyState title="No AI activity yet" body="Drafts appear here as staff and sellers use AI features." /> : (
        <>
          <Table head={["When", "Feature", "By", "Outcome", "Tokens in / out", "Time", "Cost"]}>
            {d.items.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-mist/60" onClick={() => api<typeof detail>(`/api/admin/ai/runs/${r.id}`).then(setDetail).catch(quietly)}>
                <td className="px-4 py-2 text-sm">{dateTime(r.created_at)}</td>
                <td className="px-4 py-2">{r.task_label} {r.mode === "sandbox" && <Pill tone="blue">Sandbox</Pill>}</td>
                <td className="px-4 py-2 text-sm">{r.by}</td>
                <td className="px-4 py-2"><Pill tone={r.status === "failed" ? "red" : r.status === "discarded" ? "gray" : r.status === "draft" ? "blue" : "green"}>{STATUS[r.status]}</Pill></td>
                <td className="px-4 py-2 text-sm">{n(r.input_tokens + r.cache_creation_tokens + r.cache_read_tokens)} / {n(r.output_tokens)}</td>
                <td className="px-4 py-2 text-sm">{r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)} s` : "—"}</td>
                <td className="px-4 py-2 text-sm">{r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : "—"}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </>
      )}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.task_label}, ${dateTime(detail.created_at)}` : ""} wide>
        {detail && (
          <div className="flex flex-col gap-3 text-sm">
            <p>Model {detail.model}. {n(detail.input_tokens)} input, {n(detail.cache_read_tokens)} from cache, {n(detail.output_tokens)} output tokens. Outcome: {STATUS[detail.status]}.</p>
            {detail.error && <ErrorNote message={detail.error} />}
            <div><p className="mb-1 font-semibold">Request</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-mist p-2 text-xs">{JSON.stringify(detail.inputs, null, 2)}</pre></div>
            <div><p className="mb-1 font-semibold">AI output</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-mist p-2 text-xs">{detail.output.text ?? JSON.stringify(detail.output, null, 2)}</pre></div>
            {detail.final_text && <div><p className="mb-1 font-semibold">What was used</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-leaf-light p-2 text-xs">{detail.final_text}</pre></div>}
          </div>
        )}
      </Modal>
    </section>
  );
}

export default function AiStudio() {
  const toast = useToast();
  const [s, setS] = useState<Studio | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [saved, setSaved] = useState("");
  const [tab, setTab] = useState("features");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<TaskInfo | null>(null);
  const apply = (x: Studio) => { setS(x); setCfg(x.settings); setSaved(JSON.stringify(x.settings)); };
  useEffect(() => { api<Studio>("/api/admin/ai").then(apply).catch((e) => setError(e.message)); }, []);
  const dirty = cfg !== null && JSON.stringify(cfg) !== saved;

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    try {
      apply(await api<Studio>("/api/admin/ai", { method: "PUT", body: cfg }));
      toast("AI settings saved");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!s || !cfg) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const t = (k: string) => cfg.tasks[k] ?? { enabled: true, instructions: "" };
  const setTask = (k: string, patch: Partial<{ enabled: boolean; instructions: string }>) => setCfg({ ...cfg, tasks: { ...cfg.tasks, [k]: { ...t(k), ...patch } } });
  const used = s.usage.input_tokens + s.usage.output_tokens;
  const pct = cfg.monthly_token_budget ? Math.min(100, Math.round((used * 100) / cfg.monthly_token_budget)) : 0;
  const cacheShare = s.usage.input_tokens ? Math.round((s.usage.cache_read_tokens * 100) / s.usage.input_tokens) : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="AI studio"
        sub="Every AI feature in one place: switch features on or off, choose the model, set the brand voice and a monthly budget, and see what each draft cost. People review every draft before it is used."
        actions={<>{dirty && <span className="self-center text-sm text-ink-soft">Unsaved changes</span>}<Button variant="ghost" disabled={!dirty} onClick={() => setCfg(JSON.parse(saved))}>Discard</Button><Button onClick={save} loading={busy} disabled={!dirty}>Save changes</Button></>}
      />
      <ErrorNote message={error} />
      <section className={`flex flex-wrap items-center gap-3 rounded-xl p-4 ${s.status.mode === "live" ? "bg-leaf-light" : "bg-marigold-light"}`}>
        <Bot className="h-6 w-6" />
        <div className="flex-1">
          <p className="font-semibold">{s.status.mode === "live" ? "Connected to Claude" : "Sandbox mode: no API key"}</p>
          <p className="text-sm text-ink-soft">{s.status.mode === "live" ? "Drafts are written by the model chosen below." : "Features return clearly marked placeholder drafts so you can try every screen. Add ANTHROPIC_API_KEY to the server secrets to switch to real AI. Sellers do not see AI buttons in production until then."}</p>
        </div>
        <label className="flex items-center gap-2 font-semibold"><input type="checkbox" role="switch" aria-checked={cfg.enabled} className="h-5 w-5 accent-peacock" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /> AI features on</label>
      </section>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Drafts this month" value={n(s.usage.runs)} />
        <Stat label="Tokens this month" value={n(used)} hint={cfg.monthly_token_budget ? `${pct}% of the ${n(cfg.monthly_token_budget)} budget` : "No budget limit"} />
        <Stat label="Estimated cost" value={`$${s.usage.cost_usd.toFixed(2)}`} hint="At the prices set below" />
        <Stat label="Served from cache" value={`${cacheShare}%`} hint="Input tokens billed at the lower cache rate" />
      </div>
      {cfg.monthly_token_budget > 0 && <div className="h-2 overflow-hidden rounded-full bg-white" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used"><div className={`h-full rounded-full ${pct > 85 ? "bg-vermilion" : "bg-peacock"}`} style={{ width: `${pct}%` }} /></div>}

      <Tabs value={tab} onChange={setTab} items={[{ value: "features", label: "Features" }, { value: "model", label: "Model, voice and budget" }, { value: "activity", label: "Activity" }]} />

      {tab === "features" && (
        <div className="grid gap-3 lg:grid-cols-2">
          {s.tasks.map((task) => (
            <section key={task.key} className={`flex flex-col gap-2 rounded-xl bg-white p-4 ${t(task.key).enabled ? "" : "opacity-70"}`}>
              <div className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{task.label}</h2><Pill tone="gray">{AUDIENCE[task.audience]}</Pill></div>
                  <p className="text-sm text-ink-soft">{task.description}</p>
                </div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" aria-label={`${task.label} on`} aria-checked={t(task.key).enabled} className="h-4 w-4 accent-peacock" checked={t(task.key).enabled} onChange={(e) => setTask(task.key, { enabled: e.target.checked })} /> On</label>
              </div>
              <p className="text-xs text-ink-faint">{task.runs_this_month} drafts this month, {task.used_this_month} used or sent</p>
              <Field label="Extra instructions (optional)" hint="Style or content preferences. The fixed safety rules always apply.">
                <Textarea rows={2} maxLength={1000} value={t(task.key).instructions} onChange={(e) => setTask(task.key, { instructions: e.target.value })} />
              </Field>
              <button type="button" className="self-start text-sm font-semibold text-peacock" onClick={() => setRules(task)}>View fixed rules</button>
            </section>
          ))}
        </div>
      )}

      {tab === "model" && (
        <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <Field label="Model">
            <Select value={s.models.some((m) => m.id === cfg.model) ? cfg.model : "_custom"} onChange={(e) => e.target.value !== "_custom" && setCfg({ ...cfg, model: e.target.value })}>
              {s.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              <option value="_custom">Other model id…</option>
            </Select>
          </Field>
          <TextField label="Model id" value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value.trim() })} hint="Any Claude model id, e.g. claude-haiku-5-5" />
          <Field label="Brand voice" className="sm:col-span-2" hint="Used by every feature that writes text for customers or sellers.">
            <Textarea rows={3} maxLength={600} value={cfg.brand_voice} onChange={(e) => setCfg({ ...cfg, brand_voice: e.target.value })} />
          </Field>
          <TextField label="Monthly token budget" inputMode="numeric" value={String(cfg.monthly_token_budget)} onChange={(e) => setCfg({ ...cfg, monthly_token_budget: Number(e.target.value.replace(/\D/g, "")) || 0 })} hint="AI stops for the rest of the month when used up. 0 means no limit." />
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Input price ($ per million tokens)" inputMode="decimal" value={String(cfg.price_input_per_mtok)} onChange={(e) => setCfg({ ...cfg, price_input_per_mtok: Number(e.target.value) || 0 })} />
            <TextField label="Output price ($ per million tokens)" inputMode="decimal" value={String(cfg.price_output_per_mtok)} onChange={(e) => setCfg({ ...cfg, price_output_per_mtok: Number(e.target.value) || 0 })} />
          </div>
          <p className="text-xs text-ink-faint sm:col-span-2">Prices are for the cost estimate only; take them from your provider&apos;s current price list.</p>
        </section>
      )}

      {tab === "activity" && <Runs tasks={s.tasks} />}

      <Modal open={!!rules} onClose={() => setRules(null)} title={`Fixed rules: ${rules?.label ?? ""}`} wide>
        <p className="mb-2 text-sm text-ink-soft">These rules are part of the product and are sent first with every request. Extra instructions are added after them and cannot override them.</p>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-mist p-3 text-sm">{rules?.rules}</pre>
      </Modal>
    </div>
  );
}
