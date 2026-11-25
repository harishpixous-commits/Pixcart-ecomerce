/* Admin → AI assistant settings: behaviour, decision layer, voice, tools and my memory notes. Port of frontend/src/app/admin/assistant/page.tsx. */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { Bot, Gauge, Mic, Wand2 } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, quietly } from "../../core/api";
import { openAssistant } from "../../core/assistant-bus";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Input, Select, Textarea, TextField, Toast } from "../../shared/ui/ui";

type Decision = { provider: "off" | "rules" | "laya"; min_confidence: number; prefetch: boolean; laya_url: string; laya_path: string; laya_key: string; laya_key_set?: boolean; laya_timeout_ms: number; clear_laya_key?: boolean };
type Voice = { enabled: boolean; languages: string[]; default_language: string; speak_replies: boolean; rate: number; pitch: number; voice_name: string; auto_listen: boolean };
type Settings = {
  enabled: boolean; name: string; max_steps: number; max_output_tokens: number; history_messages: number; share_contact_details: boolean; instructions: string; suggestions: string[];
  decision: Decision; voice: Voice;
};
type D = { settings: Settings; languages: Record<string, string>; tools: { name: string; label: string; description: string; permissions: string[] }[]; actions: { kind: string; label: string; permission: string }[] };

const PROVIDERS = [
  ["rules", "Built-in rules", "Instant; understands English, Tamil, Hindi and Tanglish keywords and dates."],
  ["laya", "Laya decision model", "Open-weight System 1 model (Apache-2.0) on your own server via laya-serve. Falls back to the rules if it is slow or down."],
  ["off", "Off", "Every question goes to the model with all tools."],
] as const;

@Component({
  selector: "pc-admin-assistant-page",
  imports: [PageHeader, Icon, PcLink, PageLoader, Button, ErrorNote, Field, Input, Select, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!d() || !s()) {
      <pc-page-loader />
    } @else {
      <form (submit)="save($event)" class="flex flex-col gap-4">
        <pc-page-header title="AI assistant" sub="The chat and voice assistant in the admin panel. Which staff can chat, analyse files, use voice or prepare changes is set per role in Staff and roles. Models and keys are in AI providers." [withActions]="true">
          <button actions pcButton type="button" variant="secondary" (click)="open()"><svg [pcIcon]="Bot" class="h-4 w-4" />Open assistant</button>
          <button actions pcButton type="submit" [loading]="busy()">Save</button>
        </pc-page-header>
        <pc-error-note [message]="error()" />

        <section class="grid gap-3 rounded-xl bg-white p-4 md:grid-cols-2">
          <h2 class="flex items-center gap-2 text-lg font-semibold md:col-span-2"><svg [pcIcon]="Bot" class="h-5 w-5 text-peacock" />Behaviour</h2>
          <label class="flex items-center gap-2"><input type="checkbox" [checked]="s()!.enabled" (change)="set({ enabled: $any($event.target).checked })" /> Assistant switched on</label>
          <label class="flex items-start gap-2"><input type="checkbox" class="mt-1" [checked]="s()!.share_contact_details" (change)="set({ share_contact_details: $any($event.target).checked })" />
            <span>Send customer phone, email and address to the AI provider<span class="block text-xs text-ink-faint">Off: the model sees them masked; staff still see them on screen.</span></span></label>
          <pc-text-field label="Name shown in the chat" [value]="s()!.name" [maxlength]="40" (valueChange)="set({ name: $event })" />
          <pc-text-field label="Tool rounds per question" type="number" [min]="1" [max]="15" [value]="'' + s()!.max_steps" (valueChange)="set({ max_steps: num($event) })" />
          <pc-text-field label="Longest answer (tokens)" type="number" [min]="256" [max]="8000" [value]="'' + s()!.max_output_tokens" (valueChange)="set({ max_output_tokens: num($event) })" />
          <pc-text-field label="Messages remembered word for word" type="number" [min]="4" [max]="60" [value]="'' + s()!.history_messages" (valueChange)="set({ history_messages: num($event) })" hint="Older messages are kept as a short summary" />
          <pc-field label="House rules for the assistant" hint="Added to its instructions, e.g. “Always show amounts with GST” or “Reply in Tamil unless asked otherwise”." for="ins" class="md:col-span-2">
            <textarea pcTextarea id="ins" rows="3" maxlength="2000" [value]="s()!.instructions" (input)="set({ instructions: $any($event.target).value })"></textarea>
          </pc-field>
          <pc-field label="Suggested questions (one per line)" for="sug" class="md:col-span-2">
            <textarea pcTextarea id="sug" rows="4" [value]="s()!.suggestions.join('\\n')" (input)="set({ suggestions: $any($event.target).value.split('\\n') })"></textarea>
          </pc-field>
        </section>

        <section class="grid gap-3 rounded-xl bg-white p-4 md:grid-cols-2">
          <h2 class="flex items-center gap-2 text-lg font-semibold md:col-span-2"><svg [pcIcon]="Gauge" class="h-5 w-5 text-peacock" />Decision layer (faster answers)</h2>
          <p class="text-sm text-ink-soft md:col-span-2">Before the model is called, a fast decision step reads the question: which area, which period, and what to look up straight away. Common questions then need one model call instead of two. It never hides a tool: when unsure, every tool is offered.</p>
          <div role="radiogroup" aria-label="Decision layer" class="flex flex-col gap-2 md:col-span-2">
            @for (p of providers; track p[0]) {
              <label class="flex items-start gap-2"><input type="radio" name="dl" class="mt-1" [checked]="s()!.decision.provider === p[0]" (change)="setDec({ provider: p[0] })" /><span><span class="font-medium">{{ p[1] }}</span><span class="block text-xs text-ink-faint">{{ p[2] }}</span></span></label>
            }
          </div>
          @if (s()!.decision.provider === "laya") {
            @if (!canLaya()) {<p class="text-sm text-ink-soft md:col-span-2">Only staff with the AI providers permission can change the Laya server and its token.</p>}
            <pc-text-field label="Laya server address" placeholder="https://laya.example.com" [disabled]="!canLaya()" [value]="s()!.decision.laya_url" (valueChange)="setDec({ laya_url: $event })" hint="A public https address. Run: pip install “laya[serve]” then laya-serve (see docs/AI_ASSISTANT.md)" />
            <pc-text-field label="Path" [disabled]="!canLaya()" [value]="s()!.decision.laya_path" (valueChange)="setDec({ laya_path: $event })" />
            <pc-text-field label="Bearer token (LAYA_API_KEY)" type="password" autocomplete="off" [disabled]="!canLaya()" [placeholder]="s()!.decision.laya_key_set && !layaMoved() ? 'Saved. Type to replace.' : 'Optional'" [value]="s()!.decision.laya_key" (valueChange)="setDec({ laya_key: $event })"
              [hint]="s()!.decision.laya_key_set && layaMoved() && !s()!.decision.laya_key ? 'A new address or path removes the saved token. Enter it again if the server needs one.' : undefined" />
            <pc-text-field label="Wait at most (ms)" type="number" [min]="100" [max]="5000" [value]="'' + s()!.decision.laya_timeout_ms" (valueChange)="setDec({ laya_timeout_ms: num($event) })" />
          }
          @if (layaChanged()) {
            <pc-text-field label="Your password" type="password" autocomplete="current-password" [value]="password()" (valueChange)="password.set($event)" [required]="true" hint="Needed to change the Laya server or its token" />
            @if (me()?.totp_enabled) {<pc-text-field label="Authenticator code" inputmode="numeric" autocomplete="one-time-code" [maxlength]="8" [value]="totp()" (valueChange)="totp.set($event)" [required]="true" />}
          }
          @if (s()!.decision.provider !== "off") {
            <pc-text-field label="Minimum confidence to narrow tools (0–1)" type="number" step="0.05" [min]="0" [max]="1" [value]="'' + s()!.decision.min_confidence" (valueChange)="setDec({ min_confidence: num($event) })" />
            <label class="flex items-center gap-2 self-end pb-2"><input type="checkbox" [checked]="s()!.decision.prefetch" (change)="setDec({ prefetch: $any($event.target).checked })" /> Look up the obvious first answer before calling the model</label>
            <div class="flex flex-wrap items-end gap-2 md:col-span-2">
              <pc-field label="Try a question" for="probe" class="min-w-0 flex-1"><input pcInput id="probe" [value]="probe()" (input)="probe.set($any($event.target).value)" /></pc-field>
              <button pcButton type="button" variant="secondary" (click)="tryProbe()"><svg [pcIcon]="Wand2" class="h-4 w-4" />Try</button>
            </div>
            @if (probeOut()) {<pre class="overflow-auto rounded-lg bg-mist p-3 text-xs md:col-span-2">{{ json(probeOut()) }}</pre>}
            <p class="text-xs text-ink-faint md:col-span-2">Save first to try a newly entered Laya address.</p>
          }
        </section>

        <section class="grid gap-3 rounded-xl bg-white p-4 md:grid-cols-2">
          <h2 class="flex items-center gap-2 text-lg font-semibold md:col-span-2"><svg [pcIcon]="Mic" class="h-5 w-5 text-peacock" />Voice</h2>
          <p class="text-sm text-ink-soft md:col-span-2">Dictation and the hands-free voice mode use the browser's own speech engines (best in Chrome and Edge). Answers are spoken sentence by sentence while they are still being written.</p>
          <label class="flex items-center gap-2"><input type="checkbox" [checked]="s()!.voice.enabled" (change)="setVoice({ enabled: $any($event.target).checked })" /> Voice switched on</label>
          <label class="flex items-center gap-2"><input type="checkbox" [checked]="s()!.voice.speak_replies" (change)="setVoice({ speak_replies: $any($event.target).checked })" /> Speak answers in voice mode</label>
          <label class="flex items-center gap-2"><input type="checkbox" [checked]="s()!.voice.auto_listen" (change)="setVoice({ auto_listen: $any($event.target).checked })" /> Listen again after speaking (hands-free)</label>
          <fieldset class="md:col-span-2">
            <legend class="text-sm font-medium">Languages</legend>
            <div class="mt-1 flex flex-wrap gap-3">
              @for (l of languages(); track l[0]) {
                <label class="flex items-center gap-1.5 text-sm"><input type="checkbox" [checked]="s()!.voice.languages.includes(l[0])" (change)="toggleLang(l[0], $any($event.target).checked)" />{{ l[1] }}</label>
              }
            </div>
          </fieldset>
          <pc-field label="Default language" for="dlang"><select pcSelect id="dlang" (change)="setVoice({ default_language: $any($event.target).value })">@for (l of s()!.voice.languages; track l) {<option [value]="l" [selected]="l === s()!.voice.default_language">{{ d()!.languages[l] }}</option>}</select></pc-field>
          <pc-field label="Voice" hint="Voices come from this device; others choose the best match for the language." for="vname">
            <select pcSelect id="vname" (change)="setVoice({ voice_name: $any($event.target).value })">
              <option value="" [selected]="s()!.voice.voice_name === ''">Best match</option>
              @for (v of langVoices(); track v.name) {<option [value]="v.name" [selected]="v.name === s()!.voice.voice_name">{{ v.name }} ({{ v.lang }})</option>}
            </select>
          </pc-field>
          <pc-text-field label="Speaking speed (0.5–2)" type="number" step="0.05" [min]="0.5" [max]="2" [value]="'' + s()!.voice.rate" (valueChange)="setVoice({ rate: num($event) })" />
          <pc-text-field label="Pitch (0.5–2)" type="number" step="0.05" [min]="0.5" [max]="2" [value]="'' + s()!.voice.pitch" (valueChange)="setVoice({ pitch: num($event) })" />
        </section>

        <section class="rounded-xl bg-white p-4">
          <h2 class="text-lg font-semibold">What the assistant can do</h2>
          <p class="mb-2 text-sm text-ink-soft">Each tool needs one of the listed permissions. Changes are prepared with “propose” and only run when the person presses Confirm. <a pcLink="/admin/staff" class="text-peacock underline">Edit roles</a></p>
          <div class="grid gap-2 md:grid-cols-2">
            @for (t of d()!.tools; track t.name) {<p class="text-sm"><span class="font-medium">{{ t.label }}</span>{{ " " }}<span class="text-xs text-ink-faint">({{ t.permissions.join(" or ") }})</span><span class="block text-xs text-ink-soft">{{ t.description }}</span></p>}
          </div>
          <p class="mt-3 text-sm font-medium">Changes it can prepare</p>
          <p class="text-sm text-ink-soft">{{ actionsText() }}</p>
        </section>

        <section class="rounded-xl bg-white p-4">
          <h2 class="text-lg font-semibold">My memory notes</h2>
          <p class="mb-2 text-sm text-ink-soft">Things the assistant remembers for you across chats. You can also say “remember that…” in the chat.</p>
          <textarea pcTextarea rows="4" [value]="notes()" (input)="notes.set($any($event.target).value)" aria-label="Memory notes, one per line"></textarea>
          <button pcButton type="button" variant="secondary" class="mt-2" (click)="saveNotes()">Save my notes</button>
        </section>
      </form>
    }
  `,
})
export class AdminAssistantPage {
  private readonly toast = inject(Toast);
  private readonly admin = inject(AdminContext);
  protected readonly me = this.admin.me;
  protected readonly canLaya = computed(() => this.admin.can("ai_providers")); // the Laya server receives every staff question, like an AI provider
  protected readonly Bot = Bot;
  protected readonly Gauge = Gauge;
  protected readonly Mic = Mic;
  protected readonly Wand2 = Wand2;
  protected readonly providers = PROVIDERS;
  protected readonly num = Number;
  protected readonly d = signal<D | null>(null);
  protected readonly s = signal<Settings | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly password = signal("");
  protected readonly totp = signal("");
  protected readonly probe = signal("இன்னைக்கு sales evlo?");
  protected readonly probeOut = signal<Record<string, unknown> | null>(null);
  private readonly voices = signal<SpeechSynthesisVoice[]>([]);
  protected readonly notes = signal("");
  protected readonly languages = computed(() => Object.entries(this.d()?.languages ?? {}));
  // A new Laya address or path drops the saved token; changing the server or token asks for the password again.
  protected readonly layaMoved = computed(() => {
    const s = this.s(), d = this.d();
    return !!s && !!d && (s.decision.laya_url !== d.settings.decision.laya_url || s.decision.laya_path !== d.settings.decision.laya_path);
  });
  protected readonly layaChanged = computed(() => this.layaMoved() || this.s()?.decision.laya_key !== "");
  protected readonly langVoices = computed(() => {
    const langs = this.s()?.voice.languages ?? [];
    return this.voices().filter((v) => langs.some((l) => v.lang.toLowerCase().startsWith(l.slice(0, 2).toLowerCase())));
  });
  protected readonly actionsText = computed(() => (this.d()?.actions ?? []).map((a) => `${a.label} (${a.permission})`).join(" · "));

  constructor() {
    api<D>("/api/admin/assistant/settings").then((x) => { this.d.set(x); this.s.set(x.settings); }).catch(quietly);
    api<{ notes: string[] }>("/api/admin/assistant/memory").then((m) => this.notes.set(m.notes.join("\n"))).catch(() => {});
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const load = () => this.voices.set(window.speechSynthesis.getVoices());
      load();
      window.speechSynthesis.onvoiceschanged = load;
      inject(DestroyRef).onDestroy(() => { if (window.speechSynthesis.onvoiceschanged === load) window.speechSynthesis.onvoiceschanged = null; });
    }
  }

  protected json(v: unknown): string {
    return JSON.stringify(v, null, 2);
  }

  protected open(): void {
    openAssistant({});
  }

  protected set(x: Partial<Settings>): void {
    this.s.update((s) => (s ? { ...s, ...x } : s));
  }

  protected setDec(x: Partial<Decision>): void {
    this.s.update((s) => (s ? { ...s, decision: { ...s.decision, ...x } } : s));
  }

  protected setVoice(x: Partial<Voice>): void {
    this.s.update((s) => (s ? { ...s, voice: { ...s.voice, ...x } } : s));
  }

  protected toggleLang(code: string, on: boolean): void {
    const langs = this.s()!.voice.languages;
    this.setVoice({ languages: on ? [...langs, code] : langs.filter((x) => x !== code) });
  }

  protected async tryProbe(): Promise<void> {
    this.probeOut.set(await api<Record<string, unknown>>("/api/admin/assistant/decision-test", { method: "POST", body: { text: this.probe() } }));
  }

  protected async saveNotes(): Promise<void> {
    const r = await api<{ notes: string[] }>("/api/admin/assistant/memory", { method: "PUT", body: { notes: this.notes().split("\n") } });
    this.notes.set(r.notes.join("\n"));
    this.toast.show("Memory saved");
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const s = this.s();
    if (!s) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<D>("/api/admin/assistant/settings", { method: "PUT", body: this.layaChanged() ? { ...s, password: this.password(), totp: this.totp() } : s });
      this.d.set(r);
      this.s.set(r.settings);
      this.password.set("");
      this.totp.set("");
      this.toast.show("Assistant settings saved");
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}
