"use client";

import { Bot, Gauge, Mic, Wand2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Input, PageLoader, Select, TextField, Textarea, useToast } from "@/components/ui";
import { useAdmin, useCan } from "@/lib/admin";
import { api, ApiError, quietly } from "@/lib/api";
import { openAssistant } from "@/lib/assistant-bus";

type Settings = {
  enabled: boolean; name: string; max_steps: number; max_output_tokens: number; history_messages: number; share_contact_details: boolean; instructions: string; suggestions: string[];
  decision: { provider: "off" | "rules" | "laya"; min_confidence: number; prefetch: boolean; laya_url: string; laya_path: string; laya_key: string; laya_key_set?: boolean; laya_timeout_ms: number; clear_laya_key?: boolean };
  voice: { enabled: boolean; languages: string[]; default_language: string; speak_replies: boolean; rate: number; pitch: number; voice_name: string; auto_listen: boolean };
};
type D = { settings: Settings; languages: Record<string, string>; tools: { name: string; label: string; description: string; permissions: string[] }[]; actions: { kind: string; label: string; permission: string }[] };

export default function AssistantSettings() {
  const toast = useToast();
  const me = useAdmin();
  const canLaya = useCan("ai_providers"); // the Laya server receives every staff question, like an AI provider
  const [d, setD] = useState<D | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [probe, setProbe] = useState("இன்னைக்கு sales evlo?");
  const [probeOut, setProbeOut] = useState<Record<string, unknown> | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    api<D>("/api/admin/assistant/settings").then((x) => { setD(x); setS(x.settings); }).catch(quietly);
    api<{ notes: string[] }>("/api/admin/assistant/memory").then((m) => setNotes(m.notes.join("\n"))).catch(() => {});
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const load = () => setVoices(window.speechSynthesis.getVoices());
      load();
      window.speechSynthesis.onvoiceschanged = load;
    }
  }, []);
  if (!d || !s) return <PageLoader />;
  const setDec = (x: Partial<Settings["decision"]>) => setS({ ...s, decision: { ...s.decision, ...x } });
  const setVoice = (x: Partial<Settings["voice"]>) => setS({ ...s, voice: { ...s.voice, ...x } });
  // A new Laya address or path drops the saved token; changing the server or token asks for the password again.
  const layaMoved = s.decision.laya_url !== d.settings.decision.laya_url || s.decision.laya_path !== d.settings.decision.laya_path;
  const layaChanged = layaMoved || s.decision.laya_key !== "";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<D>("/api/admin/assistant/settings", { method: "PUT", body: layaChanged ? { ...s, password, totp } : s });
      setD(r);
      setS(r.settings);
      setPassword("");
      setTotp("");
      toast("Assistant settings saved");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const langVoices = voices.filter((v) => s.voice.languages.some((l) => v.lang.toLowerCase().startsWith(l.slice(0, 2).toLowerCase())));
  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <PageHeader title="AI assistant" sub="The chat and voice assistant in the admin panel. Which staff can chat, analyse files, use voice or prepare changes is set per role in Staff and roles. Models and keys are in AI providers."
        actions={<><Button type="button" variant="secondary" onClick={() => openAssistant({})}><Bot className="h-4 w-4" />Open assistant</Button><Button type="submit" loading={busy}>Save</Button></>} />
      <ErrorNote message={error} />

      <section className="grid gap-3 rounded-xl bg-white p-4 md:grid-cols-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold md:col-span-2"><Bot className="h-5 w-5 text-peacock" />Behaviour</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Assistant switched on</label>
        <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={s.share_contact_details} onChange={(e) => setS({ ...s, share_contact_details: e.target.checked })} />
          <span>Send customer phone, email and address to the AI provider<span className="block text-xs text-ink-faint">Off: the model sees them masked; staff still see them on screen.</span></span></label>
        <TextField label="Name shown in the chat" value={s.name} maxLength={40} onChange={(e) => setS({ ...s, name: e.target.value })} />
        <TextField label="Tool rounds per question" type="number" min={1} max={15} value={String(s.max_steps)} onChange={(e) => setS({ ...s, max_steps: Number(e.target.value) })} />
        <TextField label="Longest answer (tokens)" type="number" min={256} max={8000} value={String(s.max_output_tokens)} onChange={(e) => setS({ ...s, max_output_tokens: Number(e.target.value) })} />
        <TextField label="Messages remembered word for word" type="number" min={4} max={60} value={String(s.history_messages)} onChange={(e) => setS({ ...s, history_messages: Number(e.target.value) })} hint="Older messages are kept as a short summary" />
        <Field label="House rules for the assistant" hint="Added to its instructions, e.g. “Always show amounts with GST” or “Reply in Tamil unless asked otherwise”." htmlFor="ins" className="md:col-span-2">
          <Textarea id="ins" rows={3} maxLength={2000} value={s.instructions} onChange={(e) => setS({ ...s, instructions: e.target.value })} />
        </Field>
        <Field label="Suggested questions (one per line)" htmlFor="sug" className="md:col-span-2">
          <Textarea id="sug" rows={4} value={s.suggestions.join("\n")} onChange={(e) => setS({ ...s, suggestions: e.target.value.split("\n") })} />
        </Field>
      </section>

      <section className="grid gap-3 rounded-xl bg-white p-4 md:grid-cols-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold md:col-span-2"><Gauge className="h-5 w-5 text-peacock" />Decision layer (faster answers)</h2>
        <p className="text-sm text-ink-soft md:col-span-2">Before the model is called, a fast decision step reads the question: which area, which period, and what to look up straight away. Common questions then need one model call instead of two. It never hides a tool: when unsure, every tool is offered.</p>
        <div role="radiogroup" aria-label="Decision layer" className="flex flex-col gap-2 md:col-span-2">
          {([["rules", "Built-in rules", "Instant; understands English, Tamil, Hindi and Tanglish keywords and dates."],
            ["laya", "Laya decision model", "Open-weight System 1 model (Apache-2.0) on your own server via laya-serve. Falls back to the rules if it is slow or down."],
            ["off", "Off", "Every question goes to the model with all tools."]] as const).map(([v, l, h]) => (
            <label key={v} className="flex items-start gap-2"><input type="radio" name="dl" className="mt-1" checked={s.decision.provider === v} onChange={() => setDec({ provider: v })} /><span><span className="font-medium">{l}</span><span className="block text-xs text-ink-faint">{h}</span></span></label>
          ))}
        </div>
        {s.decision.provider === "laya" && (
          <>
            {!canLaya && <p className="text-sm text-ink-soft md:col-span-2">Only staff with the AI providers permission can change the Laya server and its token.</p>}
            <TextField label="Laya server address" placeholder="https://laya.example.com" disabled={!canLaya} value={s.decision.laya_url} onChange={(e) => setDec({ laya_url: e.target.value })} hint="A public https address. Run: pip install “laya[serve]” then laya-serve (see docs/AI_ASSISTANT.md)" />
            <TextField label="Path" disabled={!canLaya} value={s.decision.laya_path} onChange={(e) => setDec({ laya_path: e.target.value })} />
            <TextField label="Bearer token (LAYA_API_KEY)" type="password" autoComplete="off" disabled={!canLaya} placeholder={s.decision.laya_key_set && !layaMoved ? "Saved. Type to replace." : "Optional"} value={s.decision.laya_key} onChange={(e) => setDec({ laya_key: e.target.value })}
              hint={s.decision.laya_key_set && layaMoved && !s.decision.laya_key ? "A new address or path removes the saved token. Enter it again if the server needs one." : undefined} />
            <TextField label="Wait at most (ms)" type="number" min={100} max={5000} value={String(s.decision.laya_timeout_ms)} onChange={(e) => setDec({ laya_timeout_ms: Number(e.target.value) })} />
          </>
        )}
        {layaChanged && (
          <>
            <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required hint="Needed to change the Laya server or its token" />
            {me?.totp_enabled && <TextField label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={totp} onChange={(e) => setTotp(e.target.value)} required />}
          </>
        )}
        {s.decision.provider !== "off" && (
          <>
            <TextField label="Minimum confidence to narrow tools (0–1)" type="number" step="0.05" min={0} max={1} value={String(s.decision.min_confidence)} onChange={(e) => setDec({ min_confidence: Number(e.target.value) })} />
            <label className="flex items-center gap-2 self-end pb-2"><input type="checkbox" checked={s.decision.prefetch} onChange={(e) => setDec({ prefetch: e.target.checked })} /> Look up the obvious first answer before calling the model</label>
            <div className="flex flex-wrap items-end gap-2 md:col-span-2">
              <Field label="Try a question" htmlFor="probe" className="min-w-0 flex-1"><Input id="probe" value={probe} onChange={(e) => setProbe(e.target.value)} /></Field>
              <Button type="button" variant="secondary" onClick={async () => setProbeOut(await api("/api/admin/assistant/decision-test", { method: "POST", body: { text: probe } }))}><Wand2 className="h-4 w-4" />Try</Button>
            </div>
            {probeOut && <pre className="overflow-auto rounded-lg bg-mist p-3 text-xs md:col-span-2">{JSON.stringify(probeOut, null, 2)}</pre>}
            <p className="text-xs text-ink-faint md:col-span-2">Save first to try a newly entered Laya address.</p>
          </>
        )}
      </section>

      <section className="grid gap-3 rounded-xl bg-white p-4 md:grid-cols-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold md:col-span-2"><Mic className="h-5 w-5 text-peacock" />Voice</h2>
        <p className="text-sm text-ink-soft md:col-span-2">Dictation and the hands-free voice mode use the browser&apos;s own speech engines (best in Chrome and Edge). Answers are spoken sentence by sentence while they are still being written.</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.voice.enabled} onChange={(e) => setVoice({ enabled: e.target.checked })} /> Voice switched on</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.voice.speak_replies} onChange={(e) => setVoice({ speak_replies: e.target.checked })} /> Speak answers in voice mode</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.voice.auto_listen} onChange={(e) => setVoice({ auto_listen: e.target.checked })} /> Listen again after speaking (hands-free)</label>
        <fieldset className="md:col-span-2">
          <legend className="text-sm font-medium">Languages</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {Object.entries(d.languages).map(([code, label]) => (
              <label key={code} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={s.voice.languages.includes(code)}
                onChange={(e) => setVoice({ languages: e.target.checked ? [...s.voice.languages, code] : s.voice.languages.filter((x) => x !== code) })} />{label}</label>
            ))}
          </div>
        </fieldset>
        <Field label="Default language" htmlFor="dlang"><Select id="dlang" value={s.voice.default_language} onChange={(e) => setVoice({ default_language: e.target.value })}>{s.voice.languages.map((l) => <option key={l} value={l}>{d.languages[l]}</option>)}</Select></Field>
        <Field label="Voice" hint="Voices come from this device; others choose the best match for the language." htmlFor="vname">
          <Select id="vname" value={s.voice.voice_name} onChange={(e) => setVoice({ voice_name: e.target.value })}>
            <option value="">Best match</option>
            {langVoices.map((v) => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
          </Select>
        </Field>
        <TextField label="Speaking speed (0.5–2)" type="number" step="0.05" min={0.5} max={2} value={String(s.voice.rate)} onChange={(e) => setVoice({ rate: Number(e.target.value) })} />
        <TextField label="Pitch (0.5–2)" type="number" step="0.05" min={0.5} max={2} value={String(s.voice.pitch)} onChange={(e) => setVoice({ pitch: Number(e.target.value) })} />
      </section>

      <section className="rounded-xl bg-white p-4">
        <h2 className="text-lg font-semibold">What the assistant can do</h2>
        <p className="mb-2 text-sm text-ink-soft">Each tool needs one of the listed permissions. Changes are prepared with “propose” and only run when the person presses Confirm. <Link href="/admin/staff" className="text-peacock underline">Edit roles</Link></p>
        <div className="grid gap-2 md:grid-cols-2">
          {d.tools.map((t) => <p key={t.name} className="text-sm"><span className="font-medium">{t.label}</span> <span className="text-xs text-ink-faint">({t.permissions.join(" or ")})</span><span className="block text-xs text-ink-soft">{t.description}</span></p>)}
        </div>
        <p className="mt-3 text-sm font-medium">Changes it can prepare</p>
        <p className="text-sm text-ink-soft">{d.actions.map((a) => `${a.label} (${a.permission})`).join(" · ")}</p>
      </section>

      <section className="rounded-xl bg-white p-4">
        <h2 className="text-lg font-semibold">My memory notes</h2>
        <p className="mb-2 text-sm text-ink-soft">Things the assistant remembers for you across chats. You can also say “remember that…” in the chat.</p>
        <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Memory notes, one per line" />
        <Button type="button" variant="secondary" className="mt-2" onClick={async () => { const r = await api<{ notes: string[] }>("/api/admin/assistant/memory", { method: "PUT", body: { notes: notes.split("\n") } }); setNotes(r.notes.join("\n")); toast("Memory saved"); }}>Save my notes</Button>
      </section>
    </form>
  );
}
