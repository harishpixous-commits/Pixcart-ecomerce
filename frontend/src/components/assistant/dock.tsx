"use client";

import {
  Bot, ChevronDown, Copy, Download, History, Loader2, Maximize2, Mic, MicOff, Minimize2, Paperclip, Plus, Send, Sparkles, Square, Trash2, Volume2, X,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, downloadFile, streamPost } from "@/lib/api";
import type { AssistantOpen } from "@/lib/assistant-bus";
import { listen, type Listener, Speaker, speakable, speechSupported } from "@/lib/speech";
import { type Block, BlockView, copyText } from "./blocks";
import { VoiceMode } from "./voice";

export type Status = {
  enabled: boolean; name: string; suggestions: string[]; mode: "live" | "sandbox"; model: string; fallbacks: number; decision: string;
  voice: { enabled: boolean; languages: { code: string; label: string }[]; default_language: string; speak_replies: boolean; rate: number; pitch: number; voice_name: string; auto_listen: boolean };
  can: { chat: boolean; actions: boolean; files: boolean; voice: boolean; settings: boolean; providers: boolean };
  upload: { max_mb: number; types: string[] };
};
type Msg = { id: string; role: "user" | "assistant"; text: string; blocks: Block[]; status?: string; streaming?: boolean; working?: string };
type Conv = { id: string; title: string; updated_at: string };
type Upload = { id: string; filename: string; rows?: number };

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function AssistantDock() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<{ text: string; uploads: Upload[]; voice: boolean }[]>([]);
  const [error, setError] = useState("");
  const [dictating, setDictating] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [lang, setLang] = useState("en-IN");
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dictRef = useRef<Listener | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const voiceHooks = useRef<{ onDelta?: (t: string) => void; onDone?: (m: Msg | null) => void }>({});
  const ctxRef = useRef<AssistantOpen["context"] | null>(null);

  const loadConvs = useCallback(() => api<{ items: Conv[] }>("/api/admin/assistant/conversations").then((r) => setConvs(r.items)).catch(() => {}), []);

  useEffect(() => {
    if (!open || status) return;
    api<Status>("/api/admin/assistant/status").then((s) => { setStatus(s); setLang(store.get("asst-lang") || s.voice.default_language); }).catch((e) => setError(e instanceof ApiError ? e.message : "The assistant is not available"));
    loadConvs();
    const last = store.get("asst-conv");
    if (last) openConv(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Opened from an export card or list page
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<AssistantOpen>).detail ?? {};
      setOpen(true);
      ctxRef.current = d.context ?? null;
      if (d.context) { setConvId(null); setMsgs([]); }
      if (d.prompt) setInput(d.prompt);
      if (d.attach) setTimeout(() => document.getElementById("assistant-input")?.focus(), 50);
    };
    window.addEventListener("assistant:open", onOpen);
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") { e.preventDefault(); setOpen((o) => !o); } };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("assistant:open", onOpen); window.removeEventListener("keydown", key); };
  }, []);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [msgs]);

  async function openConv(id: string) {
    try {
      const c = await api<{ id: string; messages: Msg[] }>(`/api/admin/assistant/conversations/${id}`);
      setConvId(c.id);
      setMsgs(c.messages);
      store.set("asst-conv", c.id);
      setShowHistory(false);
    } catch {
      store.set("asst-conv", "");
    }
  }

  function newChat() {
    abortRef.current?.abort();
    setConvId(null);
    setMsgs([]);
    setUploads([]);
    setQueue([]);
    ctxRef.current = null;
    store.set("asst-conv", "");
    setShowHistory(false);
  }

  const send = useCallback(async (text: string, files: Upload[], voice: boolean) => {
    if (!text.trim()) return;
    setError("");
    setBusy(true);
    let id = convId;
    try {
      if (!id) {
        const ctx = ctxRef.current ?? { path: pathname, title: typeof document !== "undefined" ? document.title : "" };
        const c = await api<{ id: string }>("/api/admin/assistant/conversations", { method: "POST", body: { context: ctx } });
        id = c.id;
        setConvId(id);
        store.set("asst-conv", id);
      }
      const userMsg: Msg = { id: `u-${Date.now()}`, role: "user", text, blocks: files.length ? [{ type: "files", items: files.map((f) => ({ id: f.id, filename: f.filename, rows: f.rows ?? 0 })) }] : [] };
      const draft: Msg = { id: `a-${Date.now()}`, role: "assistant", text: "", blocks: [], streaming: true, working: "Thinking" };
      setMsgs((m) => [...m, userMsg, draft]);
      const ac = new AbortController();
      abortRef.current = ac;
      let final: Msg | null = null;
      const patch = (fn: (m: Msg) => Msg) => setMsgs((all) => all.map((m) => (m.id === draft.id ? fn(m) : m)));
      await streamPost(`/api/admin/assistant/conversations/${id}/messages`,
        { text, upload_ids: files.map((f) => f.id), voice, page: ctxRef.current ?? { path: pathname, title: document.title } },
        (ev) => {
          const t = ev.type as string;
          if (t === "start") {
            const old = draft.id;
            draft.id = String(ev.message_id);
            setMsgs((all) => all.map((m) => (m.id === old ? { ...m, id: draft.id } : m)));
          } else if (t === "tool") patch((m) => ({ ...m, working: String(ev.label || "Working") }));
          else if (t === "text") {
            const delta = String(ev.delta ?? "");
            voiceHooks.current.onDelta?.(delta);
            patch((m) => {
              const blocks = [...m.blocks];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "text") blocks[blocks.length - 1] = { type: "text", text: last.text + delta };
              else blocks.push({ type: "text", text: delta });
              return { ...m, blocks, text: m.text + delta, working: "" };
            });
          } else if (t === "card") patch((m) => ({ ...m, blocks: [...m.blocks, ev.card as Block] }));
          else if (t === "error") patch((m) => ({ ...m, blocks: [...m.blocks, { type: "error", text: String(ev.message) }], streaming: false, working: "" }));
          else if (t === "done") { final = { ...(ev.message as Msg), streaming: false }; patch(() => final as Msg); }
        }, ac.signal);
      patch((m) => ({ ...m, streaming: false, working: "" }));
      voiceHooks.current.onDone?.(final);
      loadConvs();
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setMsgs((all) => all.map((m) => (m.streaming ? { ...m, streaming: false, working: "", blocks: [...m.blocks, { type: "text", text: "\n\n_Stopped._" }] } : m)));
      } else {
        setError(e instanceof ApiError ? e.message : "The assistant could not answer. Try again.");
        setMsgs((all) => all.filter((m) => !m.streaming));
      }
      voiceHooks.current.onDone?.(null);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [convId, pathname, loadConvs]);

  // Messages typed while an answer is streaming wait their turn; the next one goes out once the answer is done (on the
  // next tick, so it uses the conversation the previous message may have just created).
  useEffect(() => {
    if (busy || !queue.length) return;
    const next = queue[0];
    const t = setTimeout(() => {
      setQueue((q) => q.slice(1));
      send(next.text, next.uploads, next.voice);
    }, 0);
    return () => clearTimeout(t);
  }, [busy, queue, send]);

  function submit(text = input, voice = false) {
    const t = text.trim();
    if (!t) return;
    setInput("");
    const files = uploads;
    setUploads([]);
    if (busy) setQueue((q) => [...q, { text: t, uploads: files, voice }]);
    else send(t, files, voice);
  }

  async function attach(file: File) {
    if (!status) return;
    if (file.size > status.upload.max_mb * 1024 * 1024) { setError(`Files up to ${status.upload.max_mb} MB`); return; }
    const form = new FormData();
    form.append("file", file);
    try {
      const r = await api<{ id: string; filename: string; rows?: number }>("/api/admin/assistant/uploads", { method: "POST", form });
      setUploads((u) => [...u, { id: r.id, filename: r.filename, rows: r.rows }]);
      if (!input) setInput("Analyse this file and compare it with our live data.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Upload failed");
    }
  }

  function toggleDictation() {
    if (dictating) { dictRef.current?.stop(); return; }
    const base = input ? input + " " : "";
    const l = listen(lang, {
      onText: (t) => setInput(base + t),
      onEnd: (err) => { setDictating(false); dictRef.current = null; if (err && err !== "no-speech" && err !== "aborted") setError(`Microphone: ${err}`); },
    }, { continuous: true });
    if (!l) { setError("This browser cannot take dictation. Use Chrome or Edge."); return; }
    dictRef.current = l;
    setDictating(true);
  }

  function speak(text: string) {
    speakerRef.current?.cancel();
    if (!status) return;
    const s = new Speaker({ lang, rate: status.voice.rate, pitch: status.voice.pitch, voiceName: status.voice.voice_name });
    speakerRef.current = s;
    s.feed(speakable(text) + "\n");
    s.flush();
  }

  async function download(m: Msg, fmt: string) {
    try { await downloadFile(`/api/admin/assistant/messages/${m.id}/download.${fmt}`, undefined, `assistant.${fmt}`); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Download failed"); }
  }

  const setVoiceDelta = useCallback((fn: ((t: string) => void) | undefined) => { voiceHooks.current.onDelta = fn; }, []);
  const sup = speechSupported();
  const canVoice = !!status?.can.voice && sup.listen;

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} aria-label="Open the AI assistant (Ctrl+J)" title="AI assistant (Ctrl+J)"
        className="group fixed bottom-5 right-5 z-40 grid h-14 w-14 place-items-center rounded-full bg-peacock text-white shadow-xl transition hover:scale-105 focus-visible:outline focus-visible:outline-4 focus-visible:outline-peacock/40">
        <span className="absolute inset-0 animate-ping rounded-full bg-peacock/30 motion-reduce:hidden" style={{ animationDuration: "3s" }} />
        <Sparkles className="relative h-6 w-6" />
      </button>
    );
  }

  return (
    <section aria-label="AI assistant" className={`fixed z-40 flex flex-col overflow-hidden border border-line bg-[#F6F8F9] shadow-2xl ${wide
      ? "inset-2 rounded-2xl sm:inset-6" : "inset-x-2 bottom-2 top-16 rounded-2xl sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(760px,calc(100vh-6rem))] sm:w-[440px]"}`}>
      <header className="flex items-center gap-2 border-b border-line bg-white px-3 py-2">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-peacock text-white"><Bot className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{status?.name ?? "Assistant"}</p>
          <p className="truncate text-xs text-ink-faint">{status ? (status.mode === "live" ? `${status.model}${status.fallbacks ? ` · ${status.fallbacks} fallback${status.fallbacks > 1 ? "s" : ""}` : ""}` : "Sandbox (no AI model connected)") : "Loading…"}</p>
        </div>
        <IconBtn label="Chat history" onClick={() => { setShowHistory(!showHistory); loadConvs(); }}><History className="h-4 w-4" /></IconBtn>
        <IconBtn label="New chat" onClick={newChat}><Plus className="h-4 w-4" /></IconBtn>
        {canVoice && <IconBtn label="Voice mode" onClick={() => setVoiceOpen(true)}><Volume2 className="h-4 w-4" /></IconBtn>}
        <IconBtn label={wide ? "Smaller" : "Full screen"} onClick={() => setWide(!wide)}>{wide ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</IconBtn>
        <IconBtn label="Close" onClick={() => setOpen(false)}><X className="h-4 w-4" /></IconBtn>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {showHistory && (
          <aside className="absolute inset-y-0 left-0 z-10 flex w-72 flex-col border-r border-line bg-white shadow-lg">
            <p className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Your chats</p>
            <ul className="flex-1 overflow-auto p-2">
              {convs.length === 0 && <li className="p-2 text-sm text-ink-faint">No chats yet.</li>}
              {convs.map((c) => (
                <li key={c.id} className={`group flex items-center rounded-lg ${c.id === convId ? "bg-peacock-light" : "hover:bg-mist"}`}>
                  <button className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm" onClick={() => openConv(c.id)}>{c.title}</button>
                  <button aria-label={`Delete ${c.title}`} className="p-1.5 text-ink-faint opacity-0 hover:text-vermilion group-hover:opacity-100 focus:opacity-100"
                    onClick={async () => { if (!window.confirm("Delete this chat?")) return; await api(`/api/admin/assistant/conversations/${c.id}`, { method: "DELETE" }); if (c.id === convId) newChat(); loadConvs(); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            {convId && (
              <div className="flex flex-wrap gap-1 border-t border-line p-2 text-xs">
                <span className="w-full text-ink-faint">Download this chat</span>
                {["pdf", "xlsx", "md", "json"].map((f) => <button key={f} className="rounded border border-line px-2 py-1 uppercase hover:border-peacock" onClick={() => downloadFile(`/api/admin/assistant/conversations/${convId}/download.${f}`, undefined, `chat.${f}`)}>{f}</button>)}
              </div>
            )}
          </aside>
        )}

        <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4" aria-live="polite">
          {msgs.length === 0 && status && (
            <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center">
              <span className="grid h-14 w-14 place-items-center rounded-2xl bg-peacock-light text-peacock"><Sparkles className="h-7 w-7" /></span>
              <p className="text-lg font-semibold">Ask about sales, orders, stock or anything in the panel</p>
              <p className="text-sm text-ink-soft">Any language. Answers use live data your role can see{status.can.files ? "; attach a spreadsheet to compare it" : ""}{status.can.actions ? "; changes wait for your Confirm" : ""}.</p>
              <div className="flex flex-wrap justify-center gap-2">
                {status.suggestions.map((s) => <button key={s} onClick={() => submit(s)} className="rounded-full border border-line bg-white px-3 py-1.5 text-sm hover:border-peacock">{s}</button>)}
              </div>
            </div>
          )}
          {msgs.map((m) => (
            <article key={m.id} className={m.role === "user" ? "ml-auto max-w-[85%]" : "group/msg min-w-0"}>
              {m.role === "user" ? (
                <div className="rounded-2xl rounded-br-md bg-peacock px-3.5 py-2 text-white">
                  <p className="whitespace-pre-wrap">{m.text}</p>
                  {m.blocks.map((b, i) => <BlockView key={i} b={b} />)}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {m.blocks.map((b, i) => <BlockView key={i} b={b} streaming={m.streaming && i === m.blocks.length - 1 && b.type === "text"} />)}
                  {m.streaming && (
                    <p className="flex items-center gap-2 text-sm text-ink-soft" role="status">
                      <span className="flex gap-1" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-peacock" style={{ animationDelay: `${i * 120}ms` }} />)}</span>
                      {m.working ? `${m.working}…` : ""}
                    </p>
                  )}
                  {!m.streaming && !m.id.startsWith("a-") && (
                    <MessageTools onCopy={() => copyText(m.text || m.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n\n"))}
                      onSpeak={sup.speak ? () => speak(m.text) : undefined} onDownload={(f) => download(m, f)} />
                  )}
                </div>
              )}
            </article>
          ))}
          {queue.length > 0 && <div className="ml-auto flex flex-col items-end gap-1">{queue.map((q, i) => <span key={i} className="rounded-xl border border-dashed border-peacock/50 bg-white px-3 py-1 text-sm text-ink-soft">Queued: {q.text}</span>)}</div>}
        </div>
      </div>

      {error && <p className="border-t border-line bg-vermilion-light px-3 py-1.5 text-sm text-vermilion" role="alert">{error}<button className="float-right" onClick={() => setError("")} aria-label="Dismiss">×</button></p>}

      <form className="border-t border-line bg-white p-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {uploads.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {uploads.map((u) => <span key={u.id} className="inline-flex items-center gap-1 rounded-full bg-mist px-2 py-0.5 text-xs">{u.filename}{u.rows ? ` · ${u.rows} rows` : ""}<button type="button" aria-label={`Remove ${u.filename}`} onClick={() => setUploads(uploads.filter((x) => x.id !== u.id))}>×</button></span>)}
          </div>
        )}
        <div className="flex items-end gap-1">
          {status?.can.files && (
            <>
              <IconBtn label="Attach a file (CSV, Excel, text)" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /></IconBtn>
              <input ref={fileRef} type="file" hidden accept={status.upload.types.join(",")} onChange={(e) => { const f = e.target.files?.[0]; if (f) attach(f); e.target.value = ""; }} />
            </>
          )}
          <textarea id="assistant-input" rows={1} value={input} onChange={(e) => setInput(e.target.value)} placeholder={dictating ? "Listening…" : "Ask anything… (Enter to send, Shift+Enter for a new line)"}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            className="max-h-40 min-h-[40px] flex-1 resize-none rounded-xl border border-line px-3 py-2 text-[15px] outline-none focus:border-peacock" style={{ fieldSizing: "content" } as React.CSSProperties} aria-label="Message" />
          {canVoice && (
            <>
              <select value={lang} onChange={(e) => { setLang(e.target.value); store.set("asst-lang", e.target.value); }} aria-label="Language for voice" className="h-10 max-w-[4.5rem] rounded-lg border border-line bg-white px-1 text-xs">
                {status!.voice.languages.map((l) => <option key={l.code} value={l.code}>{l.code}</option>)}
              </select>
              <IconBtn label={dictating ? "Stop dictation" : "Dictate"} active={dictating} onClick={toggleDictation}>{dictating ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}</IconBtn>
            </>
          )}
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} aria-label="Stop" className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-white"><Square className="h-4 w-4" /></button>
          ) : (
            <button type="submit" disabled={!input.trim()} aria-label="Send" className="grid h-10 w-10 place-items-center rounded-xl bg-peacock text-white disabled:opacity-40"><Send className="h-4 w-4" /></button>
          )}
        </div>
        {busy && input.trim() && <p className="mt-1 text-xs text-ink-faint">Sending now adds it to the queue; it runs after the current answer.</p>}
      </form>

      {voiceOpen && status && (
        <VoiceMode status={status} lang={lang} setLang={(l) => { setLang(l); store.set("asst-lang", l); }} busy={busy}
          onClose={() => { voiceHooks.current = {}; setVoiceOpen(false); }}
          ask={(text) => new Promise<Msg | null>((resolve) => {
            voiceHooks.current.onDone = (m) => resolve(m);
            submit(text, true);
          })}
          onDelta={setVoiceDelta} />
      )}
    </section>
  );
}

function IconBtn({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} aria-pressed={active}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${active ? "bg-vermilion text-white" : "text-ink-soft hover:bg-mist"}`}>
      {children}
    </button>
  );
}

function MessageTools({ onCopy, onSpeak, onDownload }: { onCopy: () => void; onSpeak?: () => void; onDownload: (fmt: string) => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1 text-ink-faint opacity-70 transition group-hover/msg:opacity-100">
      <button className="rounded p-1 hover:bg-white" aria-label="Copy answer" title="Copy" onClick={() => { onCopy(); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
        {copied ? <span className="text-xs text-leaf">Copied</span> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {onSpeak && <button className="rounded p-1 hover:bg-white" aria-label="Read aloud" title="Read aloud" onClick={onSpeak}><Volume2 className="h-3.5 w-3.5" /></button>}
      <div className="relative">
        <button className="inline-flex items-center gap-0.5 rounded p-1 hover:bg-white" aria-label="Download this answer" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Download className="h-3.5 w-3.5" /><ChevronDown className="h-3 w-3" />
        </button>
        {open && (
          <div className="absolute bottom-7 left-0 z-10 flex flex-col rounded-lg border border-line bg-white p-1 text-sm text-ink shadow-lg">
            {[["pdf", "PDF"], ["xlsx", "Excel"], ["csv", "CSV"], ["md", "Markdown"], ["json", "JSON"]].map(([f, l]) => (
              <button key={f} className="rounded px-3 py-1 text-left hover:bg-mist" onClick={() => { setOpen(false); onDownload(f); }}>{l}</button>
            ))}
          </div>
        )}
      </div>
      <Loader2 className="hidden" />
    </div>
  );
}
