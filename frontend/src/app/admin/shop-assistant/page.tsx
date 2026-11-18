"use client";

import { Bot, Pencil, Plus, Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { PageHeader, Stat, Table, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, Pagination, Pill, Select, Textarea, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError } from "@/lib/api";

/* Admin → Shop assistant: the customer chat on the website. Separate from the staff AI assistant. */

type Voice = { enabled: boolean; languages: { code: string; label: string }[]; default_language: string; speak_replies: boolean; rate: number; pitch: number; auto_listen: boolean };
type Settings = {
  enabled: boolean; name: string; greeting: string; allow_guests: boolean; ai: "auto" | "guided"; instructions: string; quick_replies: string[];
  features: Record<string, boolean>; max_steps: number; max_output_tokens: number; history_messages: number; monthly_token_budget: number;
  limits: { per_minute: number; per_day_customer: number; per_day_guest: number }; voice: Voice;
};
type SettingsResp = { settings: Settings; features: { key: string; label: string; help: string }[]; status: { mode: string; models: string[]; own_route: boolean; tokens_this_month: number } };
type Article = { id: string; title: string; body: string; keywords: string[]; topic: string; topic_label: string; link: string; is_published: boolean; position: number; uses: number };
type ArticlesResp = { items: Article[]; topics: { code: string; label: string }[]; placeholders: string[] };
type ChatRow = { id: string; title: string; customer: string; phone: string; messages: number; feedback: number | null; language: string; ticket: string; page: string; updated_at: string };
type ChatDetail = { id: string; title: string; customer: string; phone: string; customer_id: string | null; feedback: number | null; ticket: { id: string; number: string; status: string } | null;
  messages: { id: string; role: string; text: string; blocks: { type: string; [k: string]: unknown }[]; intent: string; voice: boolean; mode: string; created_at: string }[] };
type Stats = { days: number; chats: number; customer_chats: number; guest_chats: number; escalated: number; messages: number; voice_messages: number; cancellations: number;
  helpful: number; not_helpful: number; intents: { intent: string; count: number }[]; ai_answers: number; guided_answers: number; top_articles: { title: string; uses: number }[] };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

function Switch({ checked, onChange, label, help, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 py-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-6 w-11 rounded-full bg-line transition peer-checked:bg-leaf peer-focus-visible:ring-2 peer-focus-visible:ring-peacock/40" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
      </span>
      <span>
        <span className="block font-medium">{label}</span>
        {help && <span className="block text-sm text-ink-faint">{help}</span>}
      </span>
    </label>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-white p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      {sub && <p className="mb-2 text-sm text-ink-soft">{sub}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/* ---------------------------------------------------------------- settings and switches */

function SettingsTab() {
  const toast = useToast();
  const [data, setData] = useState<SettingsResp | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [langs, setLangs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback((r: SettingsResp) => {
    setData(r);
    setS(r.settings);
    setLangs(r.settings.voice.languages.map((l) => `${l.code} | ${l.label}`).join("\n"));
  }, []);
  useEffect(() => { api<SettingsResp>("/api/admin/shop-assistant/settings").then(load).catch((e) => setError(e.message)); }, [load]);

  async function save(patch?: Partial<Settings>) {
    if (!s) return;
    setSaving(true);
    setError(null);
    const languages = langs.split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((p) => p[0]).map(([code, label]) => ({ code, label: label || code }));
    try {
      load(await api<SettingsResp>("/api/admin/shop-assistant/settings", { method: "PUT", body: patch ?? { ...s, voice: { ...s.voice, languages } } }));
      toast(patch ? (patch.enabled ? "Shop assistant switched on" : "Shop assistant switched off") : "Settings saved");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (!data || !s) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <div className="flex flex-col gap-4">
      <section className={`flex flex-wrap items-center justify-between gap-3 rounded-xl p-5 ${s.enabled ? "bg-leaf-light" : "bg-vermilion-light"}`}>
        <div>
          <p className="text-lg font-semibold">The website chat is {data.settings.enabled ? "ON" : "OFF"}</p>
          <p className="text-sm text-ink-soft">
            {data.status.mode === "live" ? `Answers with AI: ${data.status.models.join(", ")}` : "Guided mode: answers with rules and live data, no AI cost"}
            {" · "}{data.status.tokens_this_month.toLocaleString("en-IN")} AI tokens this month
          </p>
        </div>
        <Button variant={data.settings.enabled ? "danger" : "primary"} loading={saving} onClick={() => save({ enabled: !data.settings.enabled })}>
          {data.settings.enabled ? "Switch off" : "Switch on"}
        </Button>
      </section>
      <ErrorNote message={error} />

      <Section title="Who can use it">
        <Switch checked={s.allow_guests} onChange={(v) => set("allow_guests", v)} label="Guests (not signed in)"
          help="Guests can ask about products and policies. Orders, returns and requests always need sign-in." />
      </Section>

      <Section title="What the chat can do" sub="Switched-off features are not offered; the chat points customers to the right page instead.">
        {data.features.map((f) => (
          <Switch key={f.key} checked={s.features[f.key] ?? true} onChange={(v) => set("features", { ...s.features, [f.key]: v })} label={f.label} help={f.help} />
        ))}
      </Section>

      <Section title="Answers" sub="Guided mode always works. AI mode uses the model on the Shop assistant route in AI providers and falls back to guided mode if it fails.">
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2"><input type="radio" checked={s.ai === "auto"} onChange={() => set("ai", "auto")} /> Use AI when a model is connected</label>
          <label className="flex items-center gap-2"><input type="radio" checked={s.ai === "guided"} onChange={() => set("ai", "guided")} /> Guided only (no AI cost)</label>
          <p className="text-sm text-ink-faint">{data.status.own_route ? "Its own AI route is set." : "No own route: it uses the AI assistant's route."} <Link className="font-semibold text-peacock" href="/admin/ai-providers">AI providers</Link></p>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Monthly AI token budget" hint="0 = no limit. When used up, the chat answers in guided mode."><Input type="number" min={0} value={s.monthly_token_budget} onChange={(e) => set("monthly_token_budget", num(e.target.value))} /></Field>
          <Field label="Longest answer (tokens)"><Input type="number" min={200} max={2000} value={s.max_output_tokens} onChange={(e) => set("max_output_tokens", num(e.target.value))} /></Field>
          <Field label="Tool rounds per question"><Input type="number" min={1} max={8} value={s.max_steps} onChange={(e) => set("max_steps", num(e.target.value))} /></Field>
          <Field label="Messages remembered"><Input type="number" min={2} max={40} value={s.history_messages} onChange={(e) => set("history_messages", num(e.target.value))} /></Field>
        </div>
        <Field className="mt-3" label="House rules for the AI" hint="E.g. “Always suggest COD for first orders” or “Reply in Tamil unless asked otherwise”. Customers never see this.">
          <Textarea value={s.instructions} maxLength={3000} onChange={(e) => set("instructions", e.target.value)} />
        </Field>
      </Section>

      <Section title="How it looks">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={s.name} maxLength={40} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Quick replies (one per line)"><Textarea value={s.quick_replies.join("\n")} onChange={(e) => set("quick_replies", e.target.value.split("\n"))} /></Field>
        </div>
        <Field className="mt-3" label="Greeting"><Textarea value={s.greeting} maxLength={400} onChange={(e) => set("greeting", e.target.value)} /></Field>
      </Section>

      <Section title="Voice" sub="Uses the customer's browser (best in Chrome and Edge). Customers can speak, hear replies, or talk hands-free.">
        <Switch checked={s.voice.enabled} onChange={(v) => set("voice", { ...s.voice, enabled: v })} label="Voice on" />
        <Switch checked={s.voice.speak_replies} onChange={(v) => set("voice", { ...s.voice, speak_replies: v })} label="Read replies aloud by default" disabled={!s.voice.enabled} />
        <Switch checked={s.voice.auto_listen} onChange={(v) => set("voice", { ...s.voice, auto_listen: v })} label="Hands-free: listen again after speaking" disabled={!s.voice.enabled} />
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <Field label="Languages (code | name, one per line)" className="sm:col-span-3"><Textarea value={langs} onChange={(e) => setLangs(e.target.value)} /></Field>
          <Field label="Default language">
            <Select value={s.voice.default_language} onChange={(e) => set("voice", { ...s.voice, default_language: e.target.value })}>
              {s.voice.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </Select>
          </Field>
          <Field label="Speed"><Input type="number" step="0.1" min={0.5} max={2} value={s.voice.rate} onChange={(e) => set("voice", { ...s.voice, rate: num(e.target.value) })} /></Field>
          <Field label="Pitch"><Input type="number" step="0.1" min={0.5} max={2} value={s.voice.pitch} onChange={(e) => set("voice", { ...s.voice, pitch: num(e.target.value) })} /></Field>
        </div>
      </Section>

      <Section title="Limits" sub="Protects the store from abuse and AI cost. Guests are counted per chat.">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Messages per minute"><Input type="number" min={1} max={60} value={s.limits.per_minute} onChange={(e) => set("limits", { ...s.limits, per_minute: num(e.target.value) })} /></Field>
          <Field label="Per day, customer"><Input type="number" min={5} max={2000} value={s.limits.per_day_customer} onChange={(e) => set("limits", { ...s.limits, per_day_customer: num(e.target.value) })} /></Field>
          <Field label="Per day, guest chat" hint="0 = guests cannot chat"><Input type="number" min={0} max={500} value={s.limits.per_day_guest} onChange={(e) => set("limits", { ...s.limits, per_day_guest: num(e.target.value) })} /></Field>
        </div>
      </Section>

      <div className="sticky bottom-0 -mx-1 bg-mist/90 px-1 py-3 backdrop-blur">
        <Button onClick={() => save()} loading={saving}>Save settings</Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- help articles */

const EMPTY: Omit<Article, "id" | "topic_label" | "uses"> = { title: "", body: "", keywords: [], topic: "other", link: "", is_published: true, position: 0 };

function ArticlesTab() {
  const toast = useToast();
  const [data, setData] = useState<ArticlesResp | null>(null);
  const [edit, setEdit] = useState<(typeof EMPTY & { id?: string }) | null>(null);
  const [kw, setKw] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ title: string; score: number; answers: boolean; source: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<ArticlesResp>("/api/admin/shop-assistant/articles").then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);

  function open(a?: Article) {
    setEdit(a ? { ...a } : { ...EMPTY, position: (data?.items.length ?? 0) });
    setKw(a ? a.keywords.join(", ") : "");
    setError(null);
  }
  async function save() {
    if (!edit) return;
    setBusy(true);
    setError(null);
    const body = { ...edit, keywords: kw.split(",").map((k) => k.trim()).filter(Boolean) };
    try {
      await api(edit.id ? `/api/admin/shop-assistant/articles/${edit.id}` : "/api/admin/shop-assistant/articles", { method: edit.id ? "PUT" : "POST", body });
      toast("Article saved");
      setEdit(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  async function togglePublished(a: Article) {
    await api(`/api/admin/shop-assistant/articles/${a.id}`, { method: "PUT", body: { ...a, is_published: !a.is_published } });
    load();
  }
  async function remove(a: Article) {
    if (!window.confirm(`Delete “${a.title}”? The chat will no longer use it.`)) return;
    await api(`/api/admin/shop-assistant/articles/${a.id}`, { method: "DELETE" });
    toast("Deleted");
    load();
  }
  async function tryIt() {
    if (q.trim().length < 2) return;
    setHits((await api<{ items: { title: string; score: number; answers: boolean; source: string }[] }>("/api/admin/shop-assistant/articles/try", { method: "POST", body: { question: q } })).items);
  }

  if (!data) return error ? <ErrorNote message={error} /> : <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <Section title="Try a customer question" sub="See which article the chat would answer with. Add keywords to an article if the right one is missing.">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); tryIt(); }}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. refund eppo varum? / is COD available" aria-label="Customer question" />
          <Button type="submit" variant="secondary"><Search className="h-4 w-4" />Try</Button>
        </form>
        {hits && (hits.length ? (
          <ul className="mt-2 text-sm">{hits.map((h, i) => <li key={i} className="py-0.5">{h.answers ? "✓" : "·"} {h.title} <span className="text-ink-faint">({h.source}, score {h.score})</span></li>)}</ul>
        ) : <p className="mt-2 text-sm text-ink-faint">No article matches. The chat would offer products or a support request.</p>)}
      </Section>
      <div className="flex justify-between">
        <p className="text-sm text-ink-soft">Placeholders filled from live settings: {data.placeholders.join(" ")}</p>
        <Button onClick={() => open()}><Plus className="h-4 w-4" />New article</Button>
      </div>
      {data.items.length ? (
        <Table head={["Article", "Topic", "Shown", "Used", ""]}>
          {data.items.map((a) => (
            <tr key={a.id}>
              <td className="px-4 py-2"><p className="font-medium">{a.title}</p><p className="line-clamp-1 text-sm text-ink-faint">{a.body}</p></td>
              <td className="px-4 py-2 text-sm">{a.topic_label}</td>
              <td className="px-4 py-2"><Switch checked={a.is_published} onChange={() => togglePublished(a)} label={a.is_published ? "On" : "Off"} /></td>
              <td className="px-4 py-2 text-sm">{a.uses}</td>
              <td className="px-4 py-2 text-right">
                <button type="button" onClick={() => open(a)} aria-label={`Edit ${a.title}`} className="p-1.5 text-peacock"><Pencil className="h-4 w-4" /></button>
                <button type="button" onClick={() => remove(a)} aria-label={`Delete ${a.title}`} className="p-1.5 text-vermilion"><Trash2 className="h-4 w-4" /></button>
              </td>
            </tr>
          ))}
        </Table>
      ) : <EmptyState title="No help articles" body="Add the answers your customers ask for most." />}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit article" : "New article"} wide>
        {edit && (
          <div className="flex flex-col gap-3">
            <Field label="Title"><Input value={edit.title} maxLength={160} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Answer" hint="Written for customers. **bold** works. Placeholders like {free_delivery_amount} are filled in."><Textarea className="min-h-[140px]" value={edit.body} maxLength={5000} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
            <Field label="Words customers use (comma separated, any language)" hint="e.g. refund, money back, panam varala, பணம், रिफंड"><Input value={kw} onChange={(e) => setKw(e.target.value)} /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Topic"><Select value={edit.topic} onChange={(e) => setEdit({ ...edit, topic: e.target.value })}>{data.topics.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</Select></Field>
              <Field label="Page to open (optional)" hint="Starts with /"><Input value={edit.link} placeholder="/pages/returns-policy" onChange={(e) => setEdit({ ...edit, link: e.target.value })} /></Field>
              <Field label="Order"><Input type="number" min={0} value={edit.position} onChange={(e) => setEdit({ ...edit, position: Number(e.target.value) })} /></Field>
            </div>
            <Switch checked={edit.is_published} onChange={(v) => setEdit({ ...edit, is_published: v })} label="Shown to customers" />
            <ErrorNote message={error} />
            <Button onClick={save} loading={busy} disabled={edit.title.trim().length < 3 || edit.body.trim().length < 10}>Save article</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------------- customer chats */

function blockSummary(b: { type: string; [k: string]: unknown }): string {
  switch (b.type) {
    case "order": return `Order card: ${(b.order as { number: string; status: string }).number} (${(b.order as { status: string }).status})`;
    case "orders": return `Orders list (${(b.items as unknown[]).length})`;
    case "products": return `Products: ${(b.items as { title: string }[]).map((p) => p.title).slice(0, 3).join(", ")}`;
    case "tickets": return `Requests: ${(b.items as { number: string }[]).map((t) => t.number).join(", ")}`;
    case "article": return `Help article: ${b.title as string}`;
    case "confirm": return `Confirm button: ${b.summary as string} → ${b.status as string}`;
    case "ticket_form": return `Support request form${b.status === "sent" ? ` → sent ${b.ticket_number as string}` : ""}`;
    case "signin": return "Asked to sign in";
    case "chips": return `Quick replies: ${(b.items as string[]).join(" · ")}`;
    case "link": return `Link: ${b.link as string}`;
    case "returns": return "Returns and refunds";
    case "error": return `Error: ${b.text as string}`;
    default: return b.type;
  }
}

function ChatsTab() {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; items: ChatRow[] } | null>(null);
  const [open, setOpen] = useState<ChatDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    const query: Record<string, string | number | boolean> = { page, q };
    if (filter === "helpful") query.feedback = 1;
    if (filter === "not_helpful") query.feedback = -1;
    if (filter === "escalated") query.escalated = true;
    api<{ total: number; items: ChatRow[] }>("/api/admin/shop-assistant/chats", { query }).then(setData).catch((e) => setError(e.message));
  }, [filter, page, q]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); }} aria-label="Filter" className="w-auto">
          <option value="all">All chats</option><option value="not_helpful">Rated not helpful</option><option value="helpful">Rated helpful</option><option value="escalated">Sent to support</option>
        </Select>
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }} className="flex gap-2"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, phone or topic" aria-label="Search chats" /><Button type="submit" variant="secondary">Search</Button></form>
      </div>
      <ErrorNote message={error} />
      {!data ? <PageLoader /> : data.items.length ? (
        <>
          <Table head={["Chat", "Customer", "Messages", "Rating", "Request", "Last message"]}>
            {data.items.map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-mist/60" onClick={() => api<ChatDetail>(`/api/admin/shop-assistant/chats/${c.id}`).then(setOpen)}>
                <td className="px-4 py-2"><p className="font-medium">{c.title}</p><p className="text-xs text-ink-faint">{c.page}{c.language && c.language !== "en" ? ` · ${c.language}` : ""}</p></td>
                <td className="px-4 py-2 text-sm">{c.customer} <span className="text-ink-faint">{c.phone}</span></td>
                <td className="px-4 py-2 text-sm">{c.messages}</td>
                <td className="px-4 py-2">{c.feedback === 1 ? <Pill tone="green">Helpful</Pill> : c.feedback === -1 ? <Pill tone="red">Not helpful</Pill> : "—"}</td>
                <td className="px-4 py-2 text-sm">{c.ticket || "—"}</td>
                <td className="px-4 py-2 text-sm">{when(c.updated_at)}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />
        </>
      ) : <EmptyState title="No chats yet" body="Customer chats from the website appear here." />}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${open.customer} ${open.phone}` : ""} wide>
        {open && (
          <div className="flex flex-col gap-2">
            {open.ticket && <p className="text-sm">Support request: <Link className="font-semibold text-peacock" href={`/admin/support/${open.ticket.id}`}>{open.ticket.number}</Link> ({open.ticket.status})</p>}
            {open.messages.map((m) => (
              <div key={m.id} className={`rounded-lg p-2 text-sm ${m.role === "user" ? "bg-peacock-light" : "bg-mist"}`}>
                <p className="mb-0.5 text-xs text-ink-faint">{m.role === "user" ? "Customer" : "Assistant"}{m.voice ? " · voice" : ""}{m.intent ? ` · ${m.intent}` : ""}{m.mode ? ` · ${m.mode}` : ""} · {when(m.created_at)}</p>
                {m.role === "user" ? <p className="whitespace-pre-wrap">{m.text}</p> : (
                  <>
                    {m.text && <Markdown source={m.text} />}
                    {m.blocks.filter((b) => b.type !== "text").map((b, i) => <p key={i} className="text-xs text-ink-soft">▸ {blockSummary(b)}</p>)}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------------- statistics */

function StatsTab() {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => { api<Stats>("/api/admin/shop-assistant/stats", { query: { days } }).then(setS).catch(() => {}); }, [days]);
  if (!s) return <PageLoader />;
  const rated = s.helpful + s.not_helpful;
  return (
    <div className="flex flex-col gap-4">
      <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto self-start" aria-label="Period">
        <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
      </Select>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Chats" value={s.chats} hint={`${s.customer_chats} customers · ${s.guest_chats} guests`} />
        <Stat label="Questions" value={s.messages} hint={`${s.voice_messages} by voice`} />
        <Stat label="Sent to support" value={s.escalated} hint={s.chats ? `${Math.round((s.escalated * 100) / s.chats)}% of chats` : undefined} />
        <Stat label="Rated helpful" value={rated ? `${Math.round((s.helpful * 100) / rated)}%` : "—"} hint={`${rated} ratings`} />
        <Stat label="Cancellations done in chat" value={s.cancellations} />
        <Stat label="AI answers" value={s.ai_answers} hint={`${s.guided_answers} guided`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="What customers ask">
          {s.intents.map((i) => <p key={i.intent} className="flex justify-between border-b border-line py-1 text-sm"><span>{i.intent}</span><b>{i.count}</b></p>)}
        </Section>
        <Section title="Most used help articles">
          {s.top_articles.length ? s.top_articles.map((a) => <p key={a.title} className="flex justify-between border-b border-line py-1 text-sm"><span>{a.title}</span><b>{a.uses}</b></p>) : <p className="text-sm text-ink-faint">None yet.</p>}
        </Section>
      </div>
    </div>
  );
}

export default function ShopAssistantAdmin() {
  const canSettings = useCan("shop_assistant");
  const canKb = useCan("shop_assistant_kb");
  const canChats = useCan("shop_assistant_chats");
  const tabs = [
    canSettings && { value: "settings", label: "Settings and switches" },
    canKb && { value: "articles", label: "Help articles" },
    canChats && { value: "chats", label: "Customer chats" },
    canChats && { value: "stats", label: "Statistics" },
  ].filter(Boolean) as { value: string; label: string }[];
  const [tab, setTab] = useState(tabs[0]?.value ?? "");
  if (!tabs.length) return <EmptyState title="No access" body="Ask an owner for a shop assistant permission." />;
  return (
    <div>
      <PageHeader title="Shop assistant" sub="The help chat customers see on the website. Separate from the staff AI assistant: it only sees public information and each customer's own orders."
        actions={<Link href="/" target="_blank" className="inline-flex h-10 items-center gap-1.5 px-3 font-semibold text-peacock"><Bot className="h-4 w-4" />Open the store</Link>} />
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {tab === "settings" && <SettingsTab />}
      {tab === "articles" && <ArticlesTab />}
      {tab === "chats" && <ChatsTab />}
      {tab === "stats" && <StatsTab />}
    </div>
  );
}
