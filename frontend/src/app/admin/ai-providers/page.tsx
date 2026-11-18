"use client";

import { ArrowDown, ArrowUp, Cpu, KeyRound, PlugZap, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Input, Modal, PageLoader, Pill, Select, TextField, Textarea, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Conn = { id: string; name: string; type: string; base_url: string; models: string[]; enabled: boolean; timeout_s: number; builtin: boolean;
  keys: { id: string; label: string; hint: string; added_at?: string }[]; last_test?: { ok: boolean; message: string; at: string } | null };
type PType = { key: string; name: string; protocol: string; base_url: string; needs_key: boolean; local: boolean; example_models: string[]; docs_url: string; notes: string };
type Target = { connection: string; model: string };
type D = { connections: Conn[]; routes: Record<string, Target[]>; route_info: Record<string, { label: string; help: string }>; types: PType[] };
type Draft = { id: string | null; type: string; name: string; base_url: string; models: string; timeout_s: number; enabled: boolean; add: { key: string; label: string }[]; remove: string[] };

export default function AiProviders() {
  const toast = useToast();
  const [d, setD] = useState<D | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [routes, setRoutes] = useState<Record<string, Target[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { busy: boolean; ok?: boolean; message?: string }>>({});

  const apply = useCallback((x: D) => { setD(x); setRoutes(x.routes); }, []);
  useEffect(() => { api<D>("/api/admin/ai-providers").then(apply).catch(quietly); }, [apply]);

  async function run(fn: () => Promise<D>, msg: string) {
    setError(null);
    try { apply(await fn()); toast(msg); return true; }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not save"); return false; }
  }

  async function saveDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const body = { type: draft.type, name: draft.name, base_url: draft.base_url, models: draft.models.split(/[\n,]/).map((m) => m.trim()).filter(Boolean),
      timeout_s: draft.timeout_s, enabled: draft.enabled, add_keys: draft.add.filter((k) => k.key.trim()), remove_keys: draft.remove };
    const ok = await run(() => draft.id ? api<D>(`/api/admin/ai-providers/connections/${draft.id}`, { method: "PUT", body }) : api<D>("/api/admin/ai-providers/connections", { method: "POST", body }),
      draft.id ? "Connection saved" : "Connection added");
    if (ok) setDraft(null);
  }

  async function test(c: Conn, model: string) {
    setTests((t) => ({ ...t, [c.id]: { busy: true } }));
    try {
      const r = await api<{ ok: boolean; message: string }>(`/api/admin/ai-providers/connections/${c.id}/test`, { method: "POST", body: { model } });
      setTests((t) => ({ ...t, [c.id]: { busy: false, ...r } }));
    } catch (e) {
      setTests((t) => ({ ...t, [c.id]: { busy: false, ok: false, message: e instanceof ApiError ? e.message : "Test failed" } }));
    }
  }

  if (!d) return <PageLoader />;
  const typeOf = (k: string) => d.types.find((t) => t.key === k);
  const newDraft = (type = "anthropic"): Draft => {
    const t = typeOf(type)!;
    return { id: null, type, name: t.name, base_url: t.base_url, models: t.example_models.join("\n"), timeout_s: 60, enabled: true, add: [{ key: "", label: "" }], remove: [] };
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="AI providers" sub="Connect any language model: Claude, OpenAI, Gemini, Groq, Mistral, DeepSeek, OpenRouter, Azure, or your own server (Ollama, LM Studio, vLLM). Add several keys per provider; when one is rate-limited or out of credit the next key, then the next provider, is used."
        actions={<Button onClick={() => { setError(null); setDraft(newDraft()); }}><Plus className="h-4 w-4" />Add connection</Button>} />
      <ErrorNote message={error} />

      <section className="grid gap-3 lg:grid-cols-2">
        {d.connections.length === 0 && <p className="rounded-xl bg-white p-4 text-ink-soft">No model connected yet. The assistant and AI studio run in sandbox mode until you add one.</p>}
        {d.connections.map((c) => {
          const t = tests[c.id];
          return (
            <article key={c.id} className="flex min-w-0 flex-col gap-2 rounded-xl bg-white p-4">
              <div className="flex items-center gap-2">
                <Cpu className="h-5 w-5 text-peacock" />
                <h2 className="truncate text-lg font-semibold">{c.name}</h2>
                <span className="ml-auto flex gap-1">{c.builtin && <Pill tone="blue">From Integrations</Pill>}<Pill tone={c.enabled ? "green" : "gray"}>{c.enabled ? "On" : "Off"}</Pill></span>
              </div>
              <p className="break-all text-sm text-ink-soft">{typeOf(c.type)?.name ?? c.type} · {c.base_url}</p>
              <p className="text-sm"><span className="text-ink-faint">Models:</span> {c.models.join(", ")}</p>
              <p className="flex flex-wrap items-center gap-1 text-sm"><KeyRound className="h-4 w-4 text-ink-faint" />{c.keys.length ? c.keys.map((k) => <code key={k.id} className="rounded bg-mist px-1.5 text-xs">{k.label ? `${k.label} ` : ""}{k.hint}</code>) : <span className="text-ink-faint">No key</span>}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <TestBtn c={c} busy={!!t?.busy} onTest={test} />
                {!c.builtin && <Button size="sm" variant="secondary" onClick={() => { setError(null); setDraft({ id: c.id, type: c.type, name: c.name, base_url: c.base_url, models: c.models.join("\n"), timeout_s: c.timeout_s, enabled: c.enabled, add: [], remove: [] }); }}>Edit</Button>}
                {!c.builtin && <Button size="sm" variant="danger" onClick={() => window.confirm(`Remove ${c.name}? Routes using it are updated.`) && run(() => api<D>(`/api/admin/ai-providers/connections/${c.id}`, { method: "DELETE" }), "Removed")}><Trash2 className="h-4 w-4" /></Button>}
              </div>
              {(t?.message || c.last_test) && <p role="status" className={`text-sm ${(t?.ok ?? c.last_test?.ok) ? "text-leaf" : "text-vermilion"}`}>{t?.message ?? `${c.last_test?.message} (${dateTime(c.last_test!.at)})`}</p>}
            </article>
          );
        })}
      </section>

      <section className="rounded-xl bg-white p-4">
        <h2 className="text-lg font-semibold">Which model answers, and the fallbacks</h2>
        <p className="mb-3 text-sm text-ink-soft">For each use, models are tried top to bottom. Empty routes use the assistant route, then the Claude key from Integrations.</p>
        <div className="grid gap-4 lg:grid-cols-3">
          {Object.entries(d.route_info).map(([r, info]) => {
            const chain = routes[r] ?? [];
            const setChain = (c: Target[]) => setRoutes({ ...routes, [r]: c });
            return (
              <div key={r} className="flex flex-col gap-2 rounded-lg border border-line p-3">
                <p className="font-semibold">{info.label}</p>
                <p className="text-xs text-ink-faint">{info.help}</p>
                {chain.map((t, i) => {
                  const conn = d.connections.find((c) => c.id === t.connection);
                  return (
                    <div key={i} className="flex items-center gap-1">
                      <span className="w-5 text-xs text-ink-faint">{i + 1}.</span>
                      <Select aria-label={`Connection ${i + 1}`} value={t.connection} onChange={(e) => { const c = d.connections.find((x) => x.id === e.target.value); setChain(chain.map((x, j) => j === i ? { connection: e.target.value, model: c?.models[0] ?? "" } : x)); }} className="min-w-0 flex-1">
                        {d.connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </Select>
                      <Select aria-label={`Model ${i + 1}`} value={t.model} onChange={(e) => setChain(chain.map((x, j) => j === i ? { ...x, model: e.target.value } : x))} className="min-w-0 flex-1">
                        {(conn?.models ?? [t.model]).map((m) => <option key={m} value={m}>{m}</option>)}
                      </Select>
                      <button type="button" aria-label="Move up" disabled={i === 0} className="p-1 disabled:opacity-30" onClick={() => { const c = [...chain]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; setChain(c); }}><ArrowUp className="h-4 w-4" /></button>
                      <button type="button" aria-label="Move down" disabled={i === chain.length - 1} className="p-1 disabled:opacity-30" onClick={() => { const c = [...chain]; [c[i + 1], c[i]] = [c[i], c[i + 1]]; setChain(c); }}><ArrowDown className="h-4 w-4" /></button>
                      <button type="button" aria-label="Remove" className="p-1 text-vermilion" onClick={() => setChain(chain.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  );
                })}
                {d.connections.length > 0 && <Button size="sm" variant="secondary" onClick={() => setChain([...chain, { connection: d.connections[0].id, model: d.connections[0].models[0] ?? "" }])}><Plus className="h-4 w-4" />Add {chain.length ? "fallback" : "model"}</Button>}
              </div>
            );
          })}
        </div>
        <Button className="mt-3" onClick={() => run(() => api<D>("/api/admin/ai-providers/routes", { method: "PUT", body: { routes } }), "Routes saved")}>Save routes</Button>
      </section>

      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? `Edit ${draft.name}` : "Add an AI connection"} wide>
        {draft && (() => {
          const t = typeOf(draft.type);
          const current = d.connections.find((c) => c.id === draft.id);
          return (
            <form onSubmit={saveDraft} className="flex flex-col gap-3">
              <ErrorNote message={error} />
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Provider" htmlFor="ptype">
                  <Select id="ptype" value={draft.type} disabled={!!draft.id} onChange={(e) => setDraft({ ...newDraft(e.target.value), add: draft.add })}>
                    {d.types.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
                  </Select>
                </Field>
                <TextField label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required maxLength={60} />
              </div>
              {t?.notes && <p className="text-sm text-ink-soft">{t.notes} {t.docs_url && <a className="text-peacock underline" href={t.docs_url} target="_blank" rel="noreferrer">Provider docs</a>}</p>}
              <TextField label="API address" value={draft.base_url} onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} required spellCheck={false} hint={t?.protocol === "openai" ? "The address before /chat/completions" : "The address before /v1/messages"} />
              <Field label="Models (one per line)" hint="The first model is the default. Pick models that support tool calling for the assistant." htmlFor="pmodels">
                <Textarea id="pmodels" rows={3} value={draft.models} onChange={(e) => setDraft({ ...draft, models: e.target.value })} spellCheck={false} />
              </Field>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">API keys {t?.needs_key ? "" : "(optional for this provider)"}</p>
                {current?.keys.map((k) => (
                  <label key={k.id} className="flex items-center gap-2 text-sm">
                    <code className="rounded bg-mist px-1.5">{k.label ? `${k.label} ` : ""}{k.hint}</code>
                    <input type="checkbox" checked={draft.remove.includes(k.id)} onChange={(e) => setDraft({ ...draft, remove: e.target.checked ? [...draft.remove, k.id] : draft.remove.filter((x) => x !== k.id) })} /> remove
                  </label>
                ))}
                {draft.add.map((k, i) => (
                  <div key={i} className="flex gap-2">
                    <Input type="password" autoComplete="off" placeholder="Paste a key" value={k.key} onChange={(e) => setDraft({ ...draft, add: draft.add.map((x, j) => j === i ? { ...x, key: e.target.value } : x) })} aria-label={`New key ${i + 1}`} />
                    <Input placeholder="Label (optional)" value={k.label} onChange={(e) => setDraft({ ...draft, add: draft.add.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} className="max-w-[10rem]" aria-label={`Label ${i + 1}`} />
                  </div>
                ))}
                <Button type="button" size="sm" variant="secondary" className="self-start" onClick={() => setDraft({ ...draft, add: [...draft.add, { key: "", label: "" }] })}><Plus className="h-4 w-4" />Another key</Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <TextField label="Timeout (seconds)" type="number" min={5} max={300} value={String(draft.timeout_s)} onChange={(e) => setDraft({ ...draft, timeout_s: Number(e.target.value) })} />
                <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Switched on</label>
              </div>
              <Button type="submit">{draft.id ? "Save" : "Add connection"}</Button>
            </form>
          );
        })()}
      </Modal>
    </div>
  );
}

function TestBtn({ c, busy, onTest }: { c: Conn; busy: boolean; onTest: (c: Conn, model: string) => void }) {
  const [model, setModel] = useState(c.models[0] ?? "");
  return (
    <span className="flex items-center gap-1">
      {c.models.length > 1 && <Select aria-label="Model to test" value={model} onChange={(e) => setModel(e.target.value)} className="h-8 w-auto py-0 text-sm">{c.models.map((m) => <option key={m}>{m}</option>)}</Select>}
      <Button size="sm" variant="secondary" loading={busy} onClick={() => onTest(c, model)}><PlugZap className="h-4 w-4" />Test</Button>
    </span>
  );
}
