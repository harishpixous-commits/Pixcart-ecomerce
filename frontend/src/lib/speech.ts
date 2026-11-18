"use client";

/**
 * Voice for the admin assistant, using the browser's own speech engines (no audio leaves the browser
 * except what the browser's recogniser needs; Chrome and Edge recognise Tamil, Hindi and English (India)).
 *
 * - listen(): speech-to-text with interim results.
 * - Speaker: text-to-speech that starts talking as soon as the first sentence has streamed in, so the
 *   spoken answer begins before the written one is finished.
 * - micLevel(): 0–1 loudness from the microphone, for the listening animation.
 */

type Rec = {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
};

export function speechSupported(): { listen: boolean; speak: boolean } {
  if (typeof window === "undefined") return { listen: false, speak: false };
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return { listen: !!(w.SpeechRecognition || w.webkitSpeechRecognition), speak: "speechSynthesis" in window };
}

export type Listener = { stop: () => void; abort: () => void };

/** Starts recognition. onText(text, final) fires as words arrive; onEnd when the browser stops listening. */
export function listen(lang: string, handlers: { onText: (text: string, final: boolean) => void; onEnd: (error?: string) => void; onSpeech?: () => void },
  opts: { continuous?: boolean } = {}): Listener | null {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = !!opts.continuous;
  rec.maxAlternatives = 1;
  let finalText = "";
  let error: string | undefined;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onText((finalText + " " + interim).trim(), !interim);
  };
  rec.onspeechstart = () => handlers.onSpeech?.();
  rec.onerror = (e) => { error = e.error; };
  rec.onend = () => handlers.onEnd(error);
  try {
    rec.start();
  } catch {
    return null;
  }
  return { stop: () => rec.stop(), abort: () => rec.abort() };
}

/** Plain words for speaking: no markdown, links or table pipes. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_#>`|]+/g, " ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class Speaker {
  private buffer = "";
  private queue = 0;
  private stopped = false;
  constructor(private opts: { lang: string; rate: number; pitch: number; voiceName?: string; onStart?: () => void; onIdle?: () => void }) {}

  private voice(): SpeechSynthesisVoice | undefined {
    const voices = window.speechSynthesis.getVoices();
    if (this.opts.voiceName) {
      const v = voices.find((x) => x.name === this.opts.voiceName);
      if (v) return v;
    }
    const lang = this.opts.lang.toLowerCase();
    return voices.find((v) => v.lang.toLowerCase() === lang) ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)));
  }

  private say(text: string) {
    const clean = speakable(text);
    if (!clean || this.stopped) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = this.opts.lang;
    u.rate = this.opts.rate;
    u.pitch = this.opts.pitch;
    const v = this.voice();
    if (v) u.voice = v;
    this.queue += 1;
    if (this.queue === 1) this.opts.onStart?.();
    const done = () => {
      this.queue = Math.max(0, this.queue - 1);
      if (this.queue === 0 && !this.buffer) this.opts.onIdle?.();
    };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  }

  /** Feed streamed text; complete sentences are spoken at once. */
  feed(delta: string) {
    if (this.stopped) return;
    this.buffer += delta;
    const re = /([^.!?।\n]+[.!?।]+|[^\n]+\n)\s*/g;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = re.exec(this.buffer))) {
      if (m[0].trim().length > 1) this.say(m[0]);
      last = re.lastIndex;
    }
    this.buffer = this.buffer.slice(last);
  }

  flush() {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.trim()) this.say(rest);
    else if (this.queue === 0) this.opts.onIdle?.();
  }

  cancel() {
    this.stopped = true;
    this.buffer = "";
    this.queue = 0;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  get speaking() {
    return this.queue > 0;
  }
}

/** Microphone loudness 0–1, ~30 times a second, for the voice animation. Returns a stop function. */
export async function micLevel(onLevel: (level: number) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const data = new Uint8Array(an.fftSize);
  let raf = 0;
  const tick = () => {
    an.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };
}
