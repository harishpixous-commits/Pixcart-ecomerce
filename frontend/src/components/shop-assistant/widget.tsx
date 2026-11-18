"use client";

import { Headphones, Loader2, MessageCircle, Mic, MicOff, Plus, Send, Square, ThumbsDown, ThumbsUp, Volume2, VolumeX, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, streamPost } from "@/lib/api";
import { useSession } from "@/lib/session";
import { listen, type Listener, Speaker, speechSupported } from "@/lib/speech";
import { type Card, CardView, type Msg } from "./cards";

/**
 * The customer help chat on the storefront. Talks only to /api/shop-assistant (customer-scoped); it shares
 * nothing with the admin assistant except the browser's speech engine wrapper (lib/speech).
 */

type Config = {
  enabled: boolean; switched_on: boolean; allow_guests: boolean; signed_in: boolean; name: string; greeting: string; quick_replies: string[]; mode: string;
  voice: { enabled: boolean; languages: { code: string; label: string }[]; default_language: string; speak_replies: boolean; rate: number; pitch: number; auto_listen: boolean };
};
type Saved = { id: string; key: string | null; uid: string | null };

const STORE = "shop-chat";
const store = {
  get<T>(k: string): T | null { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

export function ShopAssistant() {
  const { user, ready } = useSession();
  if (!ready) return null;
  // Remounts when the signed-in person changes, so one person's chat never shows for another.
  return <ShopAssistantPanel key={user?.id ?? "guest"} />;
}

function ShopAssistantPanel() {
  const pathname = usePathname();
  const { user, ready } = useSession();
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<Config | null>(null);
  // A chat belongs to one person: a different signed-in customer starts fresh; a guest chat moves to the account.
  const [chat, setChat] = useState<Saved | null>(() => {
    const saved = store.get<Saved>(STORE);
    if (saved?.uid && saved.uid !== (user?.id ?? null)) {
      store.del(STORE);
      return null;
    }
    return saved;
  });
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<number | null>(null);
  const [lang, setLang] = useState("en-IN");
  const [speak, setSpeak] = useState(false);
  const [listening, setListening] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<Listener | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const handsFreeRef = useRef(false);
  const support = typeof window !== "undefined" ? speechSupported() : { listen: false, speak: false };

  // Config: whether the chat is on, its greeting, quick replies and voice settings (re-read when sign-in changes).
  useEffect(() => {
    if (!ready) return;
    api<Config>("/api/shop-assistant/config").then((c) => {
      setCfg(c);
      setLang(store.get<string>(`${STORE}-lang`) || c.voice.default_language);
      setSpeak(store.get<boolean>(`${STORE}-speak`) ?? c.voice.speak_replies);
    }).catch(() => setCfg(null));
  }, [ready, user?.id]);

  const headers = useCallback((c: Saved | null = chat): Record<string, string> => (c?.key ? { "X-Chat-Key": c.key } : {}), [chat]);

  // Load the saved conversation when the panel opens.
  useEffect(() => {
    if (!open || !chat || msgs.length) return;
    api<{ messages: Msg[]; feedback: number | null }>(`/api/shop-assistant/sessions/${chat.id}`, { headers: headers() })
      .then((r) => {
        setMsgs(r.messages);
        setFeedback(r.feedback);
        if (user && chat.key) { const moved = { id: chat.id, key: null, uid: user.id }; store.set(STORE, moved); setChat(moved); }
      })
      .catch(() => { store.del(STORE); setChat(null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, chat?.id]);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" }); }, [msgs]);
  useEffect(() => () => { recRef.current?.abort(); speakerRef.current?.cancel(); abortRef.current?.abort(); }, []);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("shop-assistant:open", onOpen);
    return () => window.removeEventListener("shop-assistant:open", onOpen);
  }, []);

  function stopVoice() {
    handsFreeRef.current = false;
    setHandsFree(false);
    recRef.current?.abort();
    recRef.current = null;
    setListening(false);
    speakerRef.current?.cancel();
  }

  function newChat() {
    stopVoice();
    abortRef.current?.abort();
    store.del(STORE);
    setChat(null);
    setMsgs([]);
    setFeedback(null);
    setError("");
  }

  const send = useCallback(async (text: string, viaVoice = false) => {
    const t = text.trim();
    if (!t || busy) return;
    setError("");
    setInput("");
    setBusy(true);
    let c = chat;
    try {
      if (!c) {
        const r = await api<{ id: string; guest_key: string | null }>("/api/shop-assistant/sessions", { method: "POST", body: { page: { path: pathname, title: document.title } } });
        c = { id: r.id, key: r.guest_key, uid: user?.id ?? null };
        store.set(STORE, c);
        setChat(c);
      }
      const draft: Msg = { id: `a-${Date.now()}`, role: "assistant", text: "", blocks: [], streaming: true, working: "Thinking" };
      setMsgs((m) => [...m, { id: `u-${Date.now()}`, role: "user", text: t, blocks: [] }, draft]);
      const patch = (fn: (m: Msg) => Msg) => setMsgs((all) => all.map((m) => (m.id === draft.id ? fn(m) : m)));
      const speaking = (speak || viaVoice) && support.speak && cfg?.voice.enabled;
      speakerRef.current?.cancel();
      speakerRef.current = speaking ? new Speaker({ lang, rate: cfg?.voice.rate ?? 1, pitch: cfg?.voice.pitch ?? 1,
        onIdle: () => { if (handsFreeRef.current) startListening(true); } }) : null;
      const ac = new AbortController();
      abortRef.current = ac;
      await streamPost(`/api/shop-assistant/sessions/${c.id}/messages`, { text: t, voice: viaVoice, page: { path: pathname, title: document.title } }, (ev) => {
        if (ev.type === "start") {
          const old = draft.id;
          draft.id = String(ev.message_id);
          setMsgs((all) => all.map((m) => (m.id === old ? { ...m, id: draft.id } : m)));
        } else if (ev.type === "tool") patch((m) => ({ ...m, working: String(ev.label || "Working") }));
        else if (ev.type === "text") {
          const delta = String(ev.delta ?? "");
          speakerRef.current?.feed(delta);
          patch((m) => {
            const blocks = [...m.blocks];
            const i = blocks.findIndex((b) => b.type === "text");
            if (i >= 0) blocks[i] = { type: "text", text: (blocks[i] as { text: string }).text + delta };
            else blocks.unshift({ type: "text", text: delta });
            return { ...m, text: m.text + delta, blocks, working: undefined };
          });
        } else if (ev.type === "card") patch((m) => ({ ...m, blocks: [...m.blocks, ev.card as Card], working: undefined }));
        else if (ev.type === "done") {
          speakerRef.current?.flush();
          const final = ev.message as Msg;
          setMsgs((all) => all.map((m) => (m.id === draft.id ? { ...final } : m)));
        } else if (ev.type === "error") {
          patch((m) => ({ ...m, streaming: false, working: undefined, blocks: [...m.blocks, { type: "error", text: String(ev.message) }] }));
        }
      }, ac.signal, headers(c));
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        const msg = e instanceof ApiError ? e.message : "Could not reach the assistant. Check your connection.";
        setError(msg);
        if (e instanceof ApiError && e.status === 404) { store.del(STORE); setChat(null); }
      }
      setMsgs((all) => all.filter((m) => !(m.streaming && !m.text && !m.blocks.length)));
      speakerRef.current?.cancel();
    } finally {
      setMsgs((all) => all.map((m) => (m.streaming ? { ...m, streaming: false, working: undefined } : m)));
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, chat, cfg, lang, pathname, speak, user?.id]);

  function startListening(auto = false) {
    if (!support.listen) return;
    speakerRef.current?.cancel();
    recRef.current?.abort();
    setListening(true);
    let said = "";
    recRef.current = listen(lang, {
      onText: (t) => { said = t; setInput(t); },
      onEnd: (err) => {
        setListening(false);
        recRef.current = null;
        if (said.trim()) send(said, true);
        else if (err && err !== "no-speech" && err !== "aborted") setError("Microphone not available. Allow mic access in your browser.");
        else if (auto && !said) { handsFreeRef.current = false; setHandsFree(false); }
      },
    });
    if (!recRef.current) { setListening(false); setError("Voice input is not supported in this browser. Try Chrome or Edge."); }
  }

  function toggleHandsFree() {
    if (handsFree) { stopVoice(); return; }
    handsFreeRef.current = true;
    setHandsFree(true);
    startListening(true);
  }

  async function rate(v: 1 | -1) {
    if (!chat) return;
    setFeedback(v);
    await api(`/api/shop-assistant/sessions/${chat.id}/feedback`, { method: "POST", body: { value: v }, headers: headers() }).catch(() => {});
  }

  if (!cfg?.switched_on) return null;
  const voiceOn = cfg.voice.enabled && (support.listen || support.speak);
  const blocked = !cfg.enabled; // guests switched off and nobody signed in
  const greeting: Card[] = [{ type: "text", text: cfg.greeting }, { type: "chips", items: cfg.quick_replies }];

  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} aria-label={`Open ${cfg.name}`}
          className="fixed bottom-20 right-4 z-40 flex items-center gap-2 rounded-full bg-peacock px-4 py-3 font-semibold text-white shadow-lg hover:bg-peacock-dark sm:bottom-6">
          <MessageCircle className="h-5 w-5" /><span className="hidden sm:inline">Help</span>
        </button>
      )}
      {open && (
        <section role="dialog" aria-label={cfg.name}
          className="fixed inset-0 z-50 flex flex-col bg-mist sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[640px] sm:max-h-[calc(100vh-48px)] sm:w-[400px] sm:overflow-hidden sm:rounded-2xl sm:border sm:border-line sm:shadow-2xl">
          <header className="flex items-center gap-2 bg-peacock px-3 py-2.5 text-white">
            <MessageCircle className="h-5 w-5" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold leading-tight">{cfg.name}</p>
              <p className="text-[11px] text-white/80">{handsFree ? "Voice conversation on" : user ? `Signed in as ${user.name || "you"}` : "Orders, returns, refunds and products"}</p>
            </div>
            {voiceOn && cfg.voice.languages.length > 1 && (
              <select value={lang} onChange={(e) => { setLang(e.target.value); store.set(`${STORE}-lang`, e.target.value); }} aria-label="Voice language"
                className="rounded bg-white/15 px-1 py-0.5 text-xs text-white [&>option]:text-ink">
                {cfg.voice.languages.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            )}
            {voiceOn && support.speak && (
              <button type="button" onClick={() => { const v = !speak; setSpeak(v); store.set(`${STORE}-speak`, v); if (!v) speakerRef.current?.cancel(); }}
                aria-label={speak ? "Stop reading replies aloud" : "Read replies aloud"} title={speak ? "Replies are read aloud" : "Read replies aloud"} className="rounded p-1.5 hover:bg-white/15">
                {speak ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
            )}
            <button type="button" onClick={newChat} aria-label="New chat" title="New chat" className="rounded p-1.5 hover:bg-white/15"><Plus className="h-4 w-4" /></button>
            <button type="button" onClick={() => { stopVoice(); setOpen(false); }} aria-label="Close" className="rounded p-1.5 hover:bg-white/15"><X className="h-5 w-5" /></button>
          </header>

          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3" aria-live="polite">
            {!msgs.length && (
              <Bubble role="assistant">
                {greeting.map((c, i) => <CardView key={i} c={c} onSend={(t) => send(t)} onMessage={() => {}} chatId="" chatHeaders={{}} />)}
                {!user && <p className="text-xs text-ink-faint">Sign in to ask about your own orders and requests.</p>}
              </Bubble>
            )}
            {msgs.map((m) => (
              <Bubble key={m.id} role={m.role}>
                {m.role === "user" ? <p className="whitespace-pre-wrap text-[15px]">{m.text}</p> : (
                  <>
                    {m.blocks.map((c, i) => (
                      <CardView key={i} c={c} onSend={(t) => send(t)} chatId={chat?.id ?? ""} chatHeaders={headers()}
                        onMessage={(nm) => nm && setMsgs((all) => [...all, nm])} />
                    ))}
                    {m.working && <p className="flex items-center gap-1.5 text-xs text-ink-faint"><Loader2 className="h-3.5 w-3.5 animate-spin" />{m.working}…</p>}
                  </>
                )}
              </Bubble>
            ))}
            {msgs.length >= 4 && !busy && (
              <div className="flex items-center justify-center gap-2 text-xs text-ink-faint">
                Was this helpful?
                <button type="button" onClick={() => rate(1)} aria-label="Helpful" className={`rounded p-1 ${feedback === 1 ? "text-leaf" : "hover:text-ink"}`}><ThumbsUp className="h-4 w-4" /></button>
                <button type="button" onClick={() => rate(-1)} aria-label="Not helpful" className={`rounded p-1 ${feedback === -1 ? "text-vermilion" : "hover:text-ink"}`}><ThumbsDown className="h-4 w-4" /></button>
              </div>
            )}
          </div>

          {error && <p className="bg-vermilion-light px-3 py-1.5 text-xs text-vermilion">{error}</p>}
          {blocked ? (
            <div className="border-t border-line bg-white p-3 text-center text-sm">
              <a href={`/login?next=${encodeURIComponent(pathname)}`} className="font-semibold text-peacock">Sign in to chat with us</a>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-end gap-1.5 border-t border-line bg-white p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              {voiceOn && support.listen && (
                <button type="button" onClick={toggleHandsFree} aria-label={handsFree ? "End voice conversation" : "Talk to the assistant"} title={handsFree ? "End voice conversation" : "Voice conversation"}
                  className={`rounded-full p-2 ${handsFree ? "bg-vermilion text-white" : "text-peacock hover:bg-peacock-light"}`}>
                  {handsFree ? <Square className="h-5 w-5" /> : <Headphones className="h-5 w-5" />}
                </button>
              )}
              <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1} maxLength={2000} placeholder={listening ? "Listening…" : "Type your question"}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }} aria-label="Message"
                className="max-h-28 min-h-[40px] flex-1 resize-none rounded-xl border border-line px-3 py-2 text-[15px] focus:border-peacock focus:outline-none" />
              {voiceOn && support.listen && !handsFree && (
                <button type="button" onClick={() => (listening ? recRef.current?.stop() : startListening())} aria-label={listening ? "Stop listening" : "Speak your question"}
                  className={`rounded-full p-2 ${listening ? "animate-pulse bg-vermilion text-white" : "text-peacock hover:bg-peacock-light"}`}>
                  {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </button>
              )}
              {busy ? (
                <button type="button" onClick={() => abortRef.current?.abort()} aria-label="Stop" className="rounded-full bg-ink p-2 text-white"><Square className="h-5 w-5" /></button>
              ) : (
                <button type="submit" disabled={!input.trim()} aria-label="Send" className="rounded-full bg-peacock p-2 text-white disabled:opacity-40"><Send className="h-5 w-5" /></button>
              )}
            </form>
          )}
        </section>
      )}
    </>
  );
}

function Bubble({ role, children }: { role: "user" | "assistant"; children: React.ReactNode }) {
  return (
    <div className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[88%] space-y-2 rounded-2xl px-3 py-2 ${role === "user" ? "rounded-br-sm bg-peacock text-white" : "rounded-bl-sm bg-white text-ink shadow-sm"}`}>{children}</div>
    </div>
  );
}
