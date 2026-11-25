/*
 * Hands-free voice agent: listen → answer (spoken while it streams) → listen again. Uses the same chat, tools and
 * permissions as typing; cards still appear in the chat behind. Port of components/assistant/voice.tsx:
 *   <pc-voice-mode [status] [lang] (langChange) [ask] [onDelta] (close) />
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from "@angular/core";
import { Mic, MicOff, PhoneOff, Square } from "lucide-angular";
import { listen, type Listener, micLevel, Speaker } from "../../core/speech";
import { Icon } from "../../shared/ui/icon";
import type { AssistantStatus } from "./dock";

type Phase = "idle" | "listening" | "thinking" | "speaking";
type Msg = { text: string } | null;

const LABEL: Record<Phase, string> = { idle: "Tap the microphone and speak", listening: "Listening…", thinking: "Working on it…", speaking: "Speaking — tap to interrupt" };

@Component({
  selector: "pc-voice-mode",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: "dialog", "aria-label": "Voice assistant", class: "absolute inset-0 z-30 flex flex-col items-center justify-between bg-gradient-to-b from-[#06262D] via-[#0B3F49] to-[#06262D] p-5 text-white" },
  template: `
    <div class="flex w-full items-center justify-between">
      <span class="text-sm font-semibold opacity-90">{{ status().name }} · voice</span>
      <select (change)="langChange.emit($any($event.target).value)" aria-label="Spoken language" class="rounded-lg bg-white/10 px-2 py-1 text-sm">
        @for (l of status().voice.languages; track l.code) {<option [value]="l.code" [selected]="l.code === lang()" class="text-ink">{{ l.label }}</option>}
      </select>
    </div>

    <button (click)="primary()" [attr.aria-label]="label[phase()]" class="relative grid h-64 w-64 place-items-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-white/40">
      @if (phase() === "speaking") {
        @for (i of three; track i) {<span class="absolute inset-6 rounded-full border-2 border-[#F2B33D]/60 motion-safe:animate-ping" style="animation-duration: 1.8s" [style.animation-delay]="i * 0.5 + 's'"></span>}
      }
      @if (phase() === "thinking") {
        <span class="absolute inset-3 rounded-full motion-safe:animate-spin"
          style="background: conic-gradient(from 0deg, transparent 0 60%, rgba(242,179,61,.9) 80%, transparent); animation-duration: 1.2s; -webkit-mask: radial-gradient(circle, transparent 62%, #000 63%); mask: radial-gradient(circle, transparent 62%, #000 63%)"></span>
      }
      <span class="absolute inset-10 rounded-full bg-white/5 transition-transform duration-75" [style.transform]="'scale(' + (1 + level() * 0.9) + ')'"></span>
      <span class="relative grid h-40 w-40 place-items-center rounded-full shadow-[0_0_60px_rgba(242,179,61,.35)] transition-transform duration-100" [style.transform]="'scale(' + scale() + ')'" [style.background]="orb()">
        @if (phase() === "listening") {<svg [pcIcon]="Mic" class="h-12 w-12 text-[#4A2A00]" />} @else if (phase() === "speaking") {<svg [pcIcon]="Square" class="h-10 w-10 text-white/90" />} @else {<svg [pcIcon]="Mic" class="h-12 w-12 text-white/90" />}
      </span>
    </button>

    <div class="w-full max-w-md text-center" aria-live="polite">
      <p class="text-lg font-semibold">{{ label[phase()] }}</p>
      @if (heard()) {<p class="mt-2 text-sm opacity-80">“{{ heard() }}”</p>}
      @if (said()) {<p class="mt-3 max-h-28 overflow-auto text-base leading-relaxed">{{ saidShown() }}</p>}
      @if (err()) {<p class="mt-2 rounded-lg bg-white/10 px-3 py-1.5 text-sm text-[#FFD3C2]">{{ err() }}</p>}
    </div>

    <div class="flex items-center gap-6">
      <button (click)="micButton()" [attr.aria-label]="phase() === 'listening' ? 'Stop listening' : 'Start listening'" class="grid h-16 w-16 place-items-center rounded-full bg-white/15 hover:bg-white/25">
        <svg [pcIcon]="phase() === 'listening' ? MicOff : Mic" class="h-7 w-7" />
      </button>
      <button (click)="close.emit()" aria-label="End voice mode" class="grid h-16 w-16 place-items-center rounded-full bg-[#D9472B] hover:bg-[#C03A20]"><svg [pcIcon]="PhoneOff" class="h-7 w-7" /></button>
    </div>
  `,
})
export class VoiceMode {
  readonly status = input.required<AssistantStatus>();
  readonly lang = input.required<string>();
  readonly ask = input.required<(text: string) => Promise<Msg>>();
  readonly onDelta = input.required<(fn: ((t: string) => void) | undefined) => void>();
  readonly langChange = output<string>();
  readonly close = output<void>();
  protected readonly Mic = Mic; protected readonly MicOff = MicOff; protected readonly PhoneOff = PhoneOff; protected readonly Square = Square;
  protected readonly label = LABEL;
  protected readonly three = [0, 1, 2];
  protected readonly phase = signal<Phase>("idle");
  protected readonly heard = signal("");
  protected readonly said = signal("");
  protected readonly level = signal(0);
  protected readonly err = signal("");
  private rec: Listener | null = null;
  private speaker: Speaker | null = null;
  private stopMic: (() => void) | null = null;
  private alive = true;
  protected readonly scale = computed(() => 1 + (this.phase() === "listening" ? this.level() * 0.6 : 0));
  protected readonly saidShown = computed(() => this.said().replace(/[*#_`|]/g, "").slice(-600));
  protected readonly orb = computed(() => {
    const p = this.phase();
    return p === "listening" ? "radial-gradient(circle at 35% 30%, #FFE3A3, #F2B33D 45%, #C77800)"
      : p === "speaking" ? "radial-gradient(circle at 35% 30%, #9FE7F2, #1AA6B7 50%, #0B5563)" : "radial-gradient(circle at 35% 30%, #D8F3F6, #4CB3C1 50%, #0B5563)";
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.alive = false;
      this.rec?.abort();
      this.speaker?.cancel();
      this.releaseMic();
      this.onDelta()(undefined);
    });
  }

  private releaseMic(): void {
    this.stopMic?.();
    this.stopMic = null;
    this.level.set(0);
  }

  private async think(text: string): Promise<void> {
    this.phase.set("thinking");
    this.said.set("");
    const status = this.status();
    const s = new Speaker({
      lang: this.lang(), rate: status.voice.rate, pitch: status.voice.pitch, voiceName: status.voice.voice_name,
      onStart: () => { if (this.alive) this.phase.set("speaking"); },
      onIdle: () => {
        if (!this.alive || this.phase() === "listening") return;
        this.phase.set("idle");
        if (status.voice.auto_listen) setTimeout(() => { if (this.alive && this.phase() === "idle") void this.start(); }, 250);
      },
    });
    this.speaker = s;
    this.onDelta()((d) => { this.said.update((x) => x + d); if (status.voice.speak_replies) s.feed(d); });
    const m = await this.ask()(text);
    this.onDelta()(undefined);
    if (!m) {
      this.err.set("No answer this time. Try again.");
      this.phase.set("idle");
      return;
    }
    if (status.voice.speak_replies) s.flush();
    else this.phase.set("idle");
  }

  private async start(): Promise<void> {
    this.err.set("");
    this.speaker?.cancel();
    this.heard.set("");
    try {
      if (!this.stopMic) this.stopMic = await micLevel((l) => { if (this.alive) this.level.set(l); });
    } catch {
      this.err.set("Allow microphone access in the browser to talk to the assistant.");
      return;
    }
    let text = "";
    const l = listen(this.lang(), {
      onText: (t) => { text = t; this.heard.set(t); },
      onEnd: (e) => {
        this.rec = null;
        this.releaseMic();
        if (!this.alive) return;
        if (text.trim()) void this.think(text.trim());
        else {
          this.phase.set("idle");
          if (e && e !== "no-speech" && e !== "aborted") this.err.set(`Microphone: ${e}`);
        }
      },
    });
    if (!l) {
      this.err.set("Voice needs Chrome or Edge on this device.");
      this.releaseMic();
      return;
    }
    this.rec = l;
    this.phase.set("listening");
  }

  protected primary(): void {
    const phase = this.phase();
    if (phase === "listening") this.rec?.stop();
    else if (phase === "speaking") { this.speaker?.cancel(); void this.start(); }
    else if (phase === "idle") void this.start();
  }

  protected micButton(): void {
    if (this.phase() === "listening") this.rec?.abort();
    else void this.start();
  }
}
