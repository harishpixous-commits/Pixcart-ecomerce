"use client";

import { Mic, MicOff, PhoneOff, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type Listener, micLevel, Speaker } from "@/lib/speech";
import type { Status } from "./dock";

type Phase = "idle" | "listening" | "thinking" | "speaking";
type Msg = { text: string } | null;

const LABEL: Record<Phase, string> = { idle: "Tap the microphone and speak", listening: "Listening…", thinking: "Working on it…", speaking: "Speaking — tap to interrupt" };

/**
 * Hands-free voice agent: listen → answer (spoken while it streams) → listen again.
 * Uses the same chat, tools and permissions as typing; cards still appear in the chat behind.
 */
export function VoiceMode({ status, lang, setLang, onClose, ask, onDelta }: {
  status: Status; lang: string; setLang: (l: string) => void; busy: boolean; onClose: () => void;
  ask: (text: string) => Promise<Msg>; onDelta: (fn: ((t: string) => void) | undefined) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState("");
  const rec = useRef<Listener | null>(null);
  const speaker = useRef<Speaker | null>(null);
  const stopMic = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const phaseRef = useRef<Phase>("idle");
  const startRef = useRef<() => void>(() => {});
  const setP = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);
  const releaseMic = useCallback(() => { stopMic.current?.(); stopMic.current = null; setLevel(0); }, []);

  const think = useCallback(async (text: string) => {
    setP("thinking");
    setSaid("");
    const s = new Speaker({
      lang, rate: status.voice.rate, pitch: status.voice.pitch, voiceName: status.voice.voice_name,
      onStart: () => alive.current && setP("speaking"),
      onIdle: () => {
        if (!alive.current || phaseRef.current === "listening") return;
        setP("idle");
        if (status.voice.auto_listen) setTimeout(() => { if (alive.current && phaseRef.current === "idle") startRef.current(); }, 250);
      },
    });
    speaker.current = s;
    onDelta((d) => { setSaid((x) => x + d); if (status.voice.speak_replies) s.feed(d); });
    const m = await ask(text);
    onDelta(undefined);
    if (!m) { setErr("No answer this time. Try again."); setP("idle"); return; }
    if (status.voice.speak_replies) s.flush(); else { setP("idle"); }
  }, [ask, onDelta, lang, status, setP]);

  const start = useCallback(async () => {
    setErr("");
    speaker.current?.cancel();
    setHeard("");
    try {
      if (!stopMic.current) stopMic.current = await micLevel((l) => alive.current && setLevel(l));
    } catch {
      setErr("Allow microphone access in the browser to talk to the assistant.");
      return;
    }
    let text = "";
    const l = listen(lang, {
      onText: (t) => { text = t; setHeard(t); },
      onEnd: (e) => {
        rec.current = null;
        releaseMic();
        if (!alive.current) return;
        if (text.trim()) think(text.trim());
        else { setP("idle"); if (e && e !== "no-speech" && e !== "aborted") setErr(`Microphone: ${e}`); }
      },
    });
    if (!l) { setErr("Voice needs Chrome or Edge on this device."); releaseMic(); return; }
    rec.current = l;
    setP("listening");
  }, [lang, think, releaseMic, setP]);

  useEffect(() => { startRef.current = start; }, [start]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; rec.current?.abort(); speaker.current?.cancel(); releaseMic(); onDelta(undefined); };
  }, [onDelta, releaseMic]);

  function primary() {
    if (phase === "listening") rec.current?.stop();
    else if (phase === "speaking") { speaker.current?.cancel(); start(); }
    else if (phase === "idle") start();
  }

  const scale = 1 + (phase === "listening" ? level * 0.6 : 0);
  return (
    <div role="dialog" aria-label="Voice assistant" className="absolute inset-0 z-30 flex flex-col items-center justify-between bg-gradient-to-b from-[#06262D] via-[#0B3F49] to-[#06262D] p-5 text-white">
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-semibold opacity-90">{status.name} · voice</span>
        <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Spoken language" className="rounded-lg bg-white/10 px-2 py-1 text-sm">
          {status.voice.languages.map((l) => <option key={l.code} value={l.code} className="text-ink">{l.label}</option>)}
        </select>
      </div>

      <button onClick={primary} aria-label={LABEL[phase]} className="relative grid h-64 w-64 place-items-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-white/40">
        {phase === "speaking" && [0, 1, 2].map((i) => (
          <span key={i} className="absolute inset-6 rounded-full border-2 border-[#F2B33D]/60 motion-safe:animate-ping" style={{ animationDuration: "1.8s", animationDelay: `${i * 0.5}s` }} />
        ))}
        {phase === "thinking" && (
          <span className="absolute inset-3 rounded-full motion-safe:animate-spin" style={{ background: "conic-gradient(from 0deg, transparent 0 60%, rgba(242,179,61,.9) 80%, transparent)", animationDuration: "1.2s",
            WebkitMask: "radial-gradient(circle, transparent 62%, #000 63%)", mask: "radial-gradient(circle, transparent 62%, #000 63%)" }} />
        )}
        <span className="absolute inset-10 rounded-full bg-white/5 transition-transform duration-75" style={{ transform: `scale(${1 + level * 0.9})` }} />
        <span className="relative grid h-40 w-40 place-items-center rounded-full shadow-[0_0_60px_rgba(242,179,61,.35)] transition-transform duration-100"
          style={{ transform: `scale(${scale})`, background: phase === "listening" ? "radial-gradient(circle at 35% 30%, #FFE3A3, #F2B33D 45%, #C77800)" :
            phase === "speaking" ? "radial-gradient(circle at 35% 30%, #9FE7F2, #1AA6B7 50%, #0B5563)" : "radial-gradient(circle at 35% 30%, #D8F3F6, #4CB3C1 50%, #0B5563)" }}>
          {phase === "listening" ? <Mic className="h-12 w-12 text-[#4A2A00]" /> : phase === "speaking" ? <Square className="h-10 w-10 text-white/90" /> : <Mic className="h-12 w-12 text-white/90" />}
        </span>
      </button>

      <div className="w-full max-w-md text-center" aria-live="polite">
        <p className="text-lg font-semibold">{LABEL[phase]}</p>
        {heard && <p className="mt-2 text-sm opacity-80">“{heard}”</p>}
        {said && <p className="mt-3 max-h-28 overflow-auto text-base leading-relaxed">{said.replace(/[*#_`|]/g, "").slice(-600)}</p>}
        {err && <p className="mt-2 rounded-lg bg-white/10 px-3 py-1.5 text-sm text-[#FFD3C2]">{err}</p>}
      </div>

      <div className="flex items-center gap-6">
        <button onClick={() => { if (phase === "listening") rec.current?.abort(); else start(); }} aria-label={phase === "listening" ? "Stop listening" : "Start listening"}
          className="grid h-16 w-16 place-items-center rounded-full bg-white/15 hover:bg-white/25">{phase === "listening" ? <MicOff className="h-7 w-7" /> : <Mic className="h-7 w-7" />}</button>
        <button onClick={onClose} aria-label="End voice mode" className="grid h-16 w-16 place-items-center rounded-full bg-[#D9472B] hover:bg-[#C03A20]"><PhoneOff className="h-7 w-7" /></button>
      </div>
    </div>
  );
}
