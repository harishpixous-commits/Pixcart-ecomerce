"use client";

import { CheckCircle2, CircleDashed, Copy, ExternalLink, KeyRound, PlugZap, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Input, Modal, PageLoader, Pill, Select, TextField, useToast } from "@/components/ui";
import { useAdmin } from "@/lib/admin";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";

type FieldInfo = {
  key: string; label: string; kind: "text" | "secret" | "email" | "url" | "number" | "select" | "bool"; required: boolean; options: string[]; help: string;
  placeholder: string; pattern_hint: string; min: number | null; max: number | null; set: boolean; source: "admin" | "environment" | ""; undecryptable: boolean;
  hint?: string; value?: string | number | boolean;
};
type Item = {
  key: string; name: string; group: string; purpose: string; docs_url: string; setup_steps: string[]; needed_for_launch: boolean; testable: boolean;
  webhook_url: string; webhook_events: string[]; enabled: boolean; switch_source: string; ready: boolean; missing: string[]; mode: string; warnings: string[];
  fields: FieldInfo[]; last_test: { ok: boolean; message: string; at: string } | null; updated_at: string | null; updated_by: string;
};
type Infra = { key: string; name: string; ready: boolean; detail: string; how: string };
type D = { environment: string; groups: Record<string, string>; items: Item[]; infrastructure: Infra[] };

export default function Integrations() {
  const toast = useToast();
  const [d, setD] = useState<D | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  const load = useCallback(() => api<D>("/api/admin/integrations").then(setD), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!d || typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    const it = d.items.find((i) => i.key === hash);
    if (it) setOpen(it);
  }, [d]);
  if (!d) return <PageLoader />;
  const groups = Object.entries(d.groups);
  const live = d.items.filter((i) => i.ready).length;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Integrations"
        sub="Connect payments, SMS, email, WhatsApp, shipping, AI and analytics. Keys are encrypted before they are saved and are never shown again. Server environment values are used until you save your own."
        actions={<><Pill tone={d.environment === "production" ? "green" : "blue"}>{d.environment}</Pill><Pill tone="gray">{live}/{d.items.length} connected</Pill></>}
      />
      {groups.map(([g, label]) => {
        const items = d.items.filter((i) => i.group === g);
        if (!items.length) return null;
        return (
          <section key={g}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">{label}</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((i) => (
                <button key={i.key} id={i.key} onClick={() => setOpen(i)} className="min-w-0 rounded-xl bg-white p-4 text-left ring-peacock/40 transition hover:ring-2 focus-visible:ring-2">
                  <div className="flex items-center gap-2">
                    {i.ready ? <CheckCircle2 className="h-5 w-5 shrink-0 text-leaf" /> : <CircleDashed className="h-5 w-5 shrink-0 text-ink-faint" />}
                    <span className="truncate text-lg font-semibold">{i.name}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      {i.mode && <Pill tone={i.mode === "live" ? "green" : "amber"}>{i.mode === "live" ? "Live keys" : "Test keys"}</Pill>}
                      {i.needed_for_launch && !i.ready && <Pill tone="red">Needed for launch</Pill>}
                      <Pill tone={i.ready ? "green" : i.enabled ? "amber" : "gray"}>{i.ready ? "On" : i.enabled ? "Incomplete" : "Off"}</Pill>
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-ink-soft">{i.purpose}</p>
                  {i.last_test && <p className={`mt-2 text-xs ${i.last_test.ok ? "text-leaf" : "text-red-700"}`}>Last test: {i.last_test.message}</p>}
                  {i.warnings.map((w) => <p key={w} className="mt-1 text-xs text-amber-700">{w}</p>)}
                </button>
              ))}
            </div>
          </section>
        );
      })}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-faint">Set on the servers (Terraform)</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {d.infrastructure.map((x) => (
            <div key={x.key} className="rounded-xl bg-white p-4">
              <p className="flex items-center gap-2 font-semibold"><Server className="h-4 w-4 text-ink-faint" />{x.name}<span className="ml-auto">{x.ready ? <Pill tone="green">Ready</Pill> : <Pill tone="gray">Not yet</Pill>}</span></p>
              <p className="mt-1 break-all text-sm text-ink-soft">{x.detail}</p>
              <p className="mt-1 text-xs text-ink-faint">{x.how}</p>
            </div>
          ))}
        </div>
      </section>
      {open && <Editor item={d.items.find((i) => i.key === open.key) ?? open} onClose={() => { setOpen(null); history.replaceState(null, "", " "); }} onSaved={async (msg) => { toast(msg); await load(); }} />}
    </div>
  );
}

function Editor({ item, onClose, onSaved }: { item: Item; onClose: () => void; onSaved: (msg: string) => Promise<void> }) {
  const me = useAdmin();
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => Object.fromEntries(item.fields.filter((f) => f.kind !== "secret").map((f) => [f.key, f.value ?? ""])));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(item.enabled);
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(item.last_test);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const changed: Record<string, unknown> = {};
    for (const f of item.fields) {
      if (f.kind === "secret") { if (secrets[f.key]?.trim()) changed[f.key] = secrets[f.key].trim(); }
      else if (values[f.key] !== (f.value ?? "") && !(values[f.key] === "" && !f.set)) changed[f.key] = f.kind === "number" ? Number(values[f.key]) : values[f.key];
    }
    try {
      const r = await api<{ changed: string[] }>(`/api/admin/integrations/${item.key}`, { method: "PUT", body: { values: changed, clear, enabled, password, totp } });
      setSecrets({});
      setPassword("");
      setTotp("");
      setClear([]);
      await onSaved(r.changed.length ? `${item.name} saved` : "Nothing changed");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setTesting(true);
    setError(null);
    try {
      const body = item.key === "msg91" ? { phone: testTo } : item.key === "email" ? { to: testTo } : {};
      setResult(await api<{ ok: boolean; message: string; at: string }>(`/api/admin/integrations/${item.key}/test`, { method: "POST", body }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text);
  }

  return (
    <Modal open onClose={onClose} title={item.name} wide>
      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <form onSubmit={save} className="flex min-w-0 flex-col gap-3">
          <ErrorNote message={error} />
          <label className="flex items-center gap-3 rounded-lg bg-mist px-3 py-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="font-medium">{enabled ? "Switched on" : "Switched off"}</span>
            <span className="ml-auto text-xs text-ink-faint">{item.switch_source === "admin" ? "Set here" : "From server environment"}</span>
          </label>
          {item.fields.map((f) => {
            const id = `int-${item.key}-${f.key}`;
            const sourceNote = f.source === "admin" ? "Saved here" : f.source === "environment" ? "From server environment" : f.undecryptable ? "Saved value can no longer be read — enter it again" : "";
            if (f.kind === "bool") {
              return (
                <label key={f.key} className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={!!values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} />
                  <span><span className="font-medium">{f.label}</span><span className="block text-xs text-ink-faint">{f.help}</span></span>
                </label>
              );
            }
            if (f.kind === "select") {
              return (
                <Field key={f.key} label={f.label} hint={f.help} htmlFor={id}>
                  <Select id={id} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </Select>
                </Field>
              );
            }
            if (f.kind === "secret") {
              return (
                <Field key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`} hint={[f.help, sourceNote].filter(Boolean).join(" · ")} htmlFor={id}>
                  <div className="flex gap-2">
                    <Input id={id} type="password" autoComplete="off" spellCheck={false} placeholder={f.set ? `Saved (${f.hint}). Type to replace.` : f.placeholder || "Paste here"}
                      value={secrets[f.key] ?? ""} onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })} />
                    {f.source === "admin" && (
                      <Button type="button" size="sm" variant="secondary" onClick={() => setClear(clear.includes(f.key) ? clear.filter((k) => k !== f.key) : [...clear, f.key])}>
                        {clear.includes(f.key) ? "Keep" : "Remove"}
                      </Button>
                    )}
                  </div>
                </Field>
              );
            }
            return (
              <TextField key={f.key} label={`${f.label}${f.required ? "" : " (optional)"}`} type={f.kind === "number" ? "number" : f.kind === "email" ? "email" : "text"}
                min={f.min ?? undefined} max={f.max ?? undefined} step={f.kind === "number" && (f.max ?? 2) <= 1 ? "0.01" : undefined}
                placeholder={f.placeholder} value={String(values[f.key] ?? "")} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                hint={[f.help, f.pattern_hint, sourceNote].filter(Boolean).join(" · ")} spellCheck={false} autoComplete="off" />
            );
          })}
          <div className="grid gap-3 border-t border-line pt-3 md:grid-cols-2">
            <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required hint="Needed to change keys" />
            {me?.totp_enabled && <TextField label="Authenticator code" inputMode="numeric" maxLength={8} value={totp} onChange={(e) => setTotp(e.target.value)} required />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={busy}><KeyRound className="h-4 w-4" />{busy ? "Saving…" : "Save"}</Button>
            {item.updated_at && <span className="text-xs text-ink-faint">Last changed {dateTime(item.updated_at)}{item.updated_by && ` by ${item.updated_by}`}</span>}
          </div>
          {item.testable && (
            <div className="rounded-lg border border-line p-3">
              <p className="mb-2 font-medium">Test connection</p>
              {(item.key === "msg91" || item.key === "email") && (
                <Input className="mb-2" placeholder={item.key === "msg91" ? "Your 10-digit mobile number" : "Send a test email to (default: you)"} value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Test recipient" />
              )}
              <Button type="button" variant="secondary" onClick={test} disabled={testing}><PlugZap className="h-4 w-4" />{testing ? "Testing…" : "Test with saved settings"}</Button>
              {result && <p role="status" className={`mt-2 text-sm ${result.ok ? "text-leaf" : "text-red-700"}`}>{result.message}</p>}
            </div>
          )}
        </form>
        <aside className="flex min-w-0 flex-col gap-3 text-sm">
          {item.webhook_url && (
            <div className="rounded-lg bg-mist p-3">
              <p className="font-medium">Webhook address</p>
              <p className="mt-1 flex items-start gap-1 break-all font-mono text-xs">{item.webhook_url}
                <button type="button" onClick={() => copy(item.webhook_url)} aria-label="Copy webhook address" className="shrink-0 text-peacock"><Copy className="h-3.5 w-3.5" /></button></p>
              <p className="mt-2 font-medium">Events</p>
              <p className="text-xs text-ink-soft">{item.webhook_events.join(", ")}</p>
            </div>
          )}
          <div>
            <p className="font-medium">How to set it up</p>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-ink-soft">{item.setup_steps.map((s) => <li key={s}>{s}</li>)}</ol>
            <a className="mt-2 inline-flex items-center gap-1 text-peacock underline" href={item.docs_url} target="_blank" rel="noreferrer">Provider guide<ExternalLink className="h-3.5 w-3.5" /></a>
          </div>
          {item.missing.length > 0 && <p className="text-amber-700">Still needed: {item.missing.join(", ")}</p>}
        </aside>
      </div>
    </Modal>
  );
}
