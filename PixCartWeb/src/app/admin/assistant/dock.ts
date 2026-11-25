/*
 * The admin AI assistant: a round button at the bottom right (Ctrl+J) that opens a chat panel. Answers stream in as they
 * are written (Server-Sent Events), with the tool being used shown while it works, cards (numbers, tables, charts,
 * files, proposed changes to confirm) inside the answer, chat history, downloads of an answer or a whole chat, file
 * attachments, dictation and a hands-free voice mode. Messages typed while an answer streams wait in a queue.
 * Port of components/assistant/dock.tsx: <pc-assistant-dock /> (the admin layout shows it to staff with "assistant").
 */

import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, output, signal, untracked, viewChild } from "@angular/core";
import {
  Bot, ChevronDown, Copy, Download, History, Maximize2, Mic, MicOff, Minimize2, Paperclip, Plus, Send, Sparkles, Square, Trash2, Volume2, X,
} from "lucide-angular";
import { api, ApiError, downloadFile, streamPost } from "../../core/api";
import type { AssistantOpen } from "../../core/assistant-bus";
import { RouteState } from "../../core/route-state";
import { listen, type Listener, Speaker, speakable, speechSupported } from "../../core/speech";
import { Icon } from "../../shared/ui/icon";
import { type Block, BlockView, copyText } from "./blocks";
import { VoiceMode } from "./voice";

export type AssistantStatus = {
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

const ICON_BTN = "grid h-9 w-9 shrink-0 place-items-center rounded-lg";

@Component({
  selector: "pc-message-tools",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-center gap-1 text-ink-faint opacity-70 transition group-hover/msg:opacity-100" },
  template: `
    <button class="rounded p-1 hover:bg-white" aria-label="Copy answer" title="Copy" (click)="doCopy()">
      @if (copied()) {<span class="text-xs text-leaf">Copied</span>} @else {<svg [pcIcon]="Copy" class="h-3.5 w-3.5" />}
    </button>
    @if (canSpeak) {<button class="rounded p-1 hover:bg-white" aria-label="Read aloud" title="Read aloud" (click)="speak.emit()"><svg [pcIcon]="Volume2" class="h-3.5 w-3.5" /></button>}
    <div class="relative">
      <button class="inline-flex items-center gap-0.5 rounded p-1 hover:bg-white" aria-label="Download this answer" [attr.aria-expanded]="open()" (click)="open.set(!open())">
        <svg [pcIcon]="Download" class="h-3.5 w-3.5" /><svg [pcIcon]="ChevronDown" class="h-3 w-3" />
      </button>
      @if (open()) {
        <div class="absolute bottom-7 left-0 z-10 flex flex-col rounded-lg border border-line bg-white p-1 text-sm text-ink shadow-lg">
          @for (f of formats; track f[0]) {<button class="rounded px-3 py-1 text-left hover:bg-mist" (click)="open.set(false); download.emit(f[0])">{{ f[1] }}</button>}
        </div>
      }
    </div>
  `,
})
export class MessageTools {
  readonly copy = output<void>();
  readonly speak = output<void>();
  readonly download = output<string>();
  protected readonly canSpeak = speechSupported().speak;
  protected readonly Copy = Copy; protected readonly Volume2 = Volume2; protected readonly Download = Download; protected readonly ChevronDown = ChevronDown;
  protected readonly formats = [["pdf", "PDF"], ["xlsx", "Excel"], ["csv", "CSV"], ["md", "Markdown"], ["json", "JSON"]];
  protected readonly open = signal(false);
  protected readonly copied = signal(false);

  protected doCopy(): void {
    this.copy.emit();
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}

@Component({
  selector: "pc-assistant-dock",
  imports: [Icon, BlockView, MessageTools, VoiceMode],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!open()) {
      <button (click)="open.set(true)" aria-label="Open the AI assistant (Ctrl+J)" title="AI assistant (Ctrl+J)"
        class="admin-assistant-launcher group fixed bottom-5 right-5 z-40 grid h-14 w-14 place-items-center rounded-full bg-peacock text-white shadow-xl transition hover:scale-105 focus-visible:outline focus-visible:outline-4 focus-visible:outline-peacock/40">
        <span class="absolute inset-0 animate-ping rounded-full bg-peacock/30 motion-reduce:hidden" style="animation-duration: 3s"></span>
        <svg [pcIcon]="Sparkles" class="relative h-6 w-6" />
      </button>
    } @else {
      <section aria-label="AI assistant" [class]="'fixed z-40 flex flex-col overflow-hidden border border-line bg-[#F6F8F9] shadow-2xl ' + (wide() ? 'inset-2 rounded-2xl sm:inset-6' : 'inset-x-2 bottom-2 top-16 rounded-2xl sm:inset-auto sm:bottom-5 sm:right-5 sm:h-[min(760px,calc(100vh-6rem))] sm:w-[440px]')">
        <header class="flex items-center gap-2 border-b border-line bg-white px-3 py-2">
          <span class="grid h-8 w-8 place-items-center rounded-full bg-peacock text-white"><svg [pcIcon]="Bot" class="h-4 w-4" /></span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-semibold leading-tight">{{ status()?.name ?? "Assistant" }}</p>
            <p class="truncate text-xs text-ink-faint">{{ modelLine() }}</p>
          </div>
          <button type="button" (click)="showHistory.set(!showHistory()); loadConvs()" aria-label="Chat history" title="Chat history" [class]="btn(false)"><svg [pcIcon]="History" class="h-4 w-4" /></button>
          <button type="button" (click)="newChat()" aria-label="New chat" title="New chat" [class]="btn(false)"><svg [pcIcon]="Plus" class="h-4 w-4" /></button>
          @if (canVoice()) {<button type="button" (click)="voiceOpen.set(true)" aria-label="Voice mode" title="Voice mode" [class]="btn(false)"><svg [pcIcon]="Volume2" class="h-4 w-4" /></button>}
          <button type="button" (click)="wide.set(!wide())" [attr.aria-label]="wide() ? 'Smaller' : 'Full screen'" [attr.title]="wide() ? 'Smaller' : 'Full screen'" [class]="btn(false)"><svg [pcIcon]="wide() ? Minimize2 : Maximize2" class="h-4 w-4" /></button>
          <button type="button" (click)="open.set(false)" aria-label="Close" title="Close" [class]="btn(false)"><svg [pcIcon]="X" class="h-4 w-4" /></button>
        </header>

        <div class="relative flex min-h-0 flex-1">
          @if (showHistory()) {
            <aside class="absolute inset-y-0 left-0 z-10 flex w-72 flex-col border-r border-line bg-white shadow-lg">
              <p class="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">Your chats</p>
              <ul class="flex-1 overflow-auto p-2">
                @if (convs().length === 0) {<li class="p-2 text-sm text-ink-faint">No chats yet.</li>}
                @for (c of convs(); track c.id) {
                  <li [class]="c.id === convId() ? 'group flex items-center rounded-lg bg-peacock-light' : 'group flex items-center rounded-lg hover:bg-mist'">
                    <button class="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm" (click)="openConv(c.id)">{{ c.title }}</button>
                    <button [attr.aria-label]="'Delete ' + c.title" class="p-1.5 text-ink-faint opacity-0 hover:text-vermilion group-hover:opacity-100 focus:opacity-100" (click)="deleteConv(c)">
                      <svg [pcIcon]="Trash2" class="h-3.5 w-3.5" />
                    </button>
                  </li>
                }
              </ul>
              @if (convId()) {
                <div class="flex flex-wrap gap-1 border-t border-line p-2 text-xs">
                  <span class="w-full text-ink-faint">Download this chat</span>
                  @for (f of chatFormats; track f) {<button class="rounded border border-line px-2 py-1 uppercase hover:border-peacock" (click)="downloadChat(f)">{{ f }}</button>}
                </div>
              }
            </aside>
          }

          <div #list class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4" aria-live="polite">
            @if (msgs().length === 0 && status()) {
              <div class="m-auto flex max-w-sm flex-col items-center gap-3 text-center">
                <span class="grid h-14 w-14 place-items-center rounded-2xl bg-peacock-light text-peacock"><svg [pcIcon]="Sparkles" class="h-7 w-7" /></span>
                <p class="text-lg font-semibold">Ask about sales, orders, stock or anything in the panel</p>
                <p class="text-sm text-ink-soft">Any language. Answers use live data your role can see{{ status()!.can.files ? "; attach a spreadsheet to compare it" : "" }}{{ status()!.can.actions ? "; changes wait for your Confirm" : "" }}.</p>
                <div class="flex flex-wrap justify-center gap-2">
                  @for (s of status()!.suggestions; track s) {<button (click)="submit(s)" class="rounded-full border border-line bg-white px-3 py-1.5 text-sm hover:border-peacock">{{ s }}</button>}
                </div>
              </div>
            }
            @for (m of msgs(); track m.id) {
              <article [class]="m.role === 'user' ? 'ml-auto max-w-[85%]' : 'group/msg min-w-0'">
                @if (m.role === "user") {
                  <div class="rounded-2xl rounded-br-md bg-peacock px-3.5 py-2 text-white">
                    <p class="whitespace-pre-wrap">{{ m.text }}</p>
                    @for (b of m.blocks; track $index) {<pc-block-view [b]="b" />}
                  </div>
                } @else {
                  <div class="flex flex-col gap-2">
                    @for (b of m.blocks; track $index; let i = $index; let last = $last) {<pc-block-view [b]="b" [streaming]="!!m.streaming && last && b.type === 'text'" />}
                    @if (m.streaming) {
                      <p class="flex items-center gap-2 text-sm text-ink-soft" role="status">
                        <span class="flex gap-1" aria-hidden="true">@for (i of dots; track i) {<span class="h-1.5 w-1.5 animate-bounce rounded-full bg-peacock" [style.animation-delay]="i * 120 + 'ms'"></span>}</span>
                        {{ m.working ? m.working + "…" : "" }}
                      </p>
                    }
                    @if (!m.streaming && !m.id.startsWith("a-")) {
                      <pc-message-tools (copy)="copyAnswer(m)" (speak)="speak(m.text)" (download)="download(m, $event)" />
                    }
                  </div>
                }
              </article>
            }
            @if (queue().length > 0) {
              <div class="ml-auto flex flex-col items-end gap-1">@for (q of queue(); track $index) {<span class="rounded-xl border border-dashed border-peacock/50 bg-white px-3 py-1 text-sm text-ink-soft">Queued: {{ q.text }}</span>}</div>
            }
          </div>
        </div>

        @if (error()) {<p class="border-t border-line bg-vermilion-light px-3 py-1.5 text-sm text-vermilion" role="alert">{{ error() }}<button class="float-right" (click)="error.set('')" aria-label="Dismiss">×</button></p>}

        <form class="border-t border-line bg-white p-2" (submit)="$event.preventDefault(); submit()">
          @if (uploads().length > 0) {
            <div class="mb-1.5 flex flex-wrap gap-1">
              @for (u of uploads(); track u.id) {<span class="inline-flex items-center gap-1 rounded-full bg-mist px-2 py-0.5 text-xs">{{ u.filename }}{{ u.rows ? " · " + u.rows + " rows" : "" }}<button type="button" [attr.aria-label]="'Remove ' + u.filename" (click)="removeUpload(u.id)">×</button></span>}
            </div>
          }
          <div class="flex items-end gap-1">
            @if (status()?.can?.files) {
              <button type="button" (click)="fileInput.click()" aria-label="Attach a file (CSV, Excel, text)" title="Attach a file (CSV, Excel, text)" [class]="btn(false)"><svg [pcIcon]="Paperclip" class="h-4 w-4" /></button>
              <input #fileInput type="file" hidden [attr.accept]="status()!.upload.types.join(',')" (change)="onFile($event)" />
            }
            <textarea id="assistant-input" rows="1" [value]="input()" (input)="input.set($any($event.target).value)" [placeholder]="dictating() ? 'Listening…' : 'Ask anything… (Enter to send, Shift+Enter for a new line)'"
              (keydown)="onKey($event)" class="max-h-40 min-h-[40px] flex-1 resize-none rounded-xl border border-line px-3 py-2 text-[15px] outline-none focus:border-peacock" style="field-sizing: content" aria-label="Message"></textarea>
            @if (canVoice()) {
              <select (change)="setLang($any($event.target).value)" aria-label="Language for voice" class="h-10 max-w-[4.5rem] rounded-lg border border-line bg-white px-1 text-xs">
                @for (l of status()!.voice.languages; track l.code) {<option [value]="l.code" [selected]="l.code === lang()">{{ l.code }}</option>}
              </select>
              <button type="button" (click)="toggleDictation()" [attr.aria-label]="dictating() ? 'Stop dictation' : 'Dictate'" [attr.title]="dictating() ? 'Stop dictation' : 'Dictate'" [attr.aria-pressed]="dictating()" [class]="btn(dictating())">
                <svg [pcIcon]="dictating() ? MicOff : Mic" class="h-4 w-4" />
              </button>
            }
            @if (busy()) {
              <button type="button" (click)="abort?.abort()" aria-label="Stop" class="grid h-10 w-10 place-items-center rounded-xl bg-ink text-white"><svg [pcIcon]="Square" class="h-4 w-4" /></button>
            } @else {
              <button type="submit" [disabled]="!input().trim()" aria-label="Send" class="grid h-10 w-10 place-items-center rounded-xl bg-peacock text-white disabled:opacity-40"><svg [pcIcon]="Send" class="h-4 w-4" /></button>
            }
          </div>
          @if (busy() && input().trim()) {<p class="mt-1 text-xs text-ink-faint">Sending now adds it to the queue; it runs after the current answer.</p>}
        </form>

        @if (voiceOpen() && status()) {
          <pc-voice-mode [status]="status()!" [lang]="lang()" (langChange)="setLang($event)" (close)="voiceHooks = {}; voiceOpen.set(false)" [ask]="voiceAsk" [onDelta]="setVoiceDelta" />
        }
      </section>
    }
  `,
})
export class AssistantDock {
  private readonly pathname = inject(RouteState).pathname;
  protected readonly Sparkles = Sparkles; protected readonly Bot = Bot; protected readonly History = History; protected readonly Plus = Plus; protected readonly Volume2 = Volume2;
  protected readonly Minimize2 = Minimize2; protected readonly Maximize2 = Maximize2; protected readonly X = X; protected readonly Trash2 = Trash2; protected readonly Paperclip = Paperclip;
  protected readonly Mic = Mic; protected readonly MicOff = MicOff; protected readonly Square = Square; protected readonly Send = Send;
  protected readonly chatFormats = ["pdf", "xlsx", "md", "json"];
  protected readonly dots = [0, 1, 2];
  protected readonly open = signal(false);
  protected readonly wide = signal(false);
  protected readonly status = signal<AssistantStatus | null>(null);
  protected readonly convs = signal<Conv[]>([]);
  protected readonly showHistory = signal(false);
  protected readonly convId = signal<string | null>(null);
  protected readonly msgs = signal<Msg[]>([]);
  protected readonly input = signal("");
  protected readonly uploads = signal<Upload[]>([]);
  protected readonly busy = signal(false);
  protected readonly queue = signal<{ text: string; uploads: Upload[]; voice: boolean }[]>([]);
  protected readonly error = signal("");
  protected readonly dictating = signal(false);
  protected readonly voiceOpen = signal(false);
  protected readonly lang = signal("en-IN");
  protected abort: AbortController | null = null;
  private readonly list = viewChild<ElementRef<HTMLDivElement>>("list");
  private dict: Listener | null = null;
  private speaker: Speaker | null = null;
  protected voiceHooks: { onDelta?: (t: string) => void; onDone?: (m: Msg | null) => void } = {};
  private ctx: AssistantOpen["context"] | null = null;
  private readonly sup = speechSupported();

  protected canVoice(): boolean {
    return !!this.status()?.can.voice && this.sup.listen;
  }

  protected btn(active: boolean): string {
    return `${ICON_BTN} ${active ? "bg-vermilion text-white" : "text-ink-soft hover:bg-mist"}`;
  }

  protected modelLine(): string {
    const s = this.status();
    if (!s) return "Loading…";
    return s.mode === "live" ? `${s.model}${s.fallbacks ? ` · ${s.fallbacks} fallback${s.fallbacks > 1 ? "s" : ""}` : ""}` : "Sandbox (no AI model connected)";
  }

  constructor() {
    // the first time the panel opens: status, chats and the last conversation
    effect(() => {
      if (!this.open() || untracked(this.status)) return;
      untracked(() => {
        api<AssistantStatus>("/api/admin/assistant/status")
          .then((s) => { this.status.set(s); this.lang.set(store.get("asst-lang") || s.voice.default_language); })
          .catch((e) => this.error.set(e instanceof ApiError ? e.message : "The assistant is not available"));
        this.loadConvs();
        const last = store.get("asst-conv");
        if (last) void this.openConv(last);
      });
    });

    // Opened from an export card or list page
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<AssistantOpen>).detail ?? {};
      this.open.set(true);
      this.ctx = d.context ?? null;
      if (d.context) { this.convId.set(null); this.msgs.set([]); }
      if (d.prompt) this.input.set(d.prompt);
      if (d.attach) setTimeout(() => document.getElementById("assistant-input")?.focus(), 50);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") { e.preventDefault(); this.open.update((o) => !o); }
    };
    window.addEventListener("assistant:open", onOpen);
    window.addEventListener("keydown", key);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener("assistant:open", onOpen);
      window.removeEventListener("keydown", key);
      this.abort?.abort();
      this.dict?.abort();
      this.speaker?.cancel();
    });

    effect(() => {
      this.msgs();
      const el = this.list()?.nativeElement;
      if (el) setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
    });

    // Messages typed while an answer is streaming wait their turn; the next one goes out once the answer is done (on the
    // next tick, so it uses the conversation the previous message may have just created).
    effect((onCleanup) => {
      const q = this.queue();
      if (this.busy() || !q.length) return;
      const next = q[0];
      const t = setTimeout(() => {
        this.queue.update((x) => x.slice(1));
        void this.send(next.text, next.uploads, next.voice);
      }, 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected loadConvs(): void {
    api<{ items: Conv[] }>("/api/admin/assistant/conversations").then((r) => this.convs.set(r.items)).catch(() => {});
  }

  protected async openConv(id: string): Promise<void> {
    try {
      const c = await api<{ id: string; messages: Msg[] }>(`/api/admin/assistant/conversations/${id}`);
      this.convId.set(c.id);
      this.msgs.set(c.messages);
      store.set("asst-conv", c.id);
      this.showHistory.set(false);
    } catch {
      store.set("asst-conv", "");
    }
  }

  protected async deleteConv(c: Conv): Promise<void> {
    if (!window.confirm("Delete this chat?")) return;
    await api(`/api/admin/assistant/conversations/${c.id}`, { method: "DELETE" });
    if (c.id === this.convId()) this.newChat();
    this.loadConvs();
  }

  protected downloadChat(f: string): void {
    void downloadFile(`/api/admin/assistant/conversations/${this.convId()}/download.${f}`, undefined, `chat.${f}`);
  }

  protected newChat(): void {
    this.abort?.abort();
    this.convId.set(null);
    this.msgs.set([]);
    this.uploads.set([]);
    this.queue.set([]);
    this.ctx = null;
    store.set("asst-conv", "");
    this.showHistory.set(false);
  }

  private async send(text: string, files: Upload[], voice: boolean): Promise<void> {
    if (!text.trim()) return;
    this.error.set("");
    this.busy.set(true);
    let id = this.convId();
    try {
      if (!id) {
        const ctx = this.ctx ?? { path: this.pathname(), title: typeof document !== "undefined" ? document.title : "" };
        const c = await api<{ id: string }>("/api/admin/assistant/conversations", { method: "POST", body: { context: ctx } });
        id = c.id;
        this.convId.set(id);
        store.set("asst-conv", id);
      }
      const userMsg: Msg = { id: `u-${Date.now()}`, role: "user", text, blocks: files.length ? [{ type: "files", items: files.map((f) => ({ id: f.id, filename: f.filename, rows: f.rows ?? 0 })) }] : [] };
      const draft: Msg = { id: `a-${Date.now()}`, role: "assistant", text: "", blocks: [], streaming: true, working: "Thinking" };
      this.msgs.update((m) => [...m, userMsg, draft]);
      const ac = new AbortController();
      this.abort = ac;
      let final: Msg | null = null;
      const patch = (fn: (m: Msg) => Msg) => this.msgs.update((all) => all.map((m) => (m.id === draft.id ? fn(m) : m)));
      await streamPost(`/api/admin/assistant/conversations/${id}/messages`,
        { text, upload_ids: files.map((f) => f.id), voice, page: this.ctx ?? { path: this.pathname(), title: document.title } },
        (ev) => {
          const t = ev["type"] as string;
          if (t === "start") {
            const old = draft.id;
            draft.id = String(ev["message_id"]);
            this.msgs.update((all) => all.map((m) => (m.id === old ? { ...m, id: draft.id } : m)));
          } else if (t === "tool") patch((m) => ({ ...m, working: String(ev["label"] || "Working") }));
          else if (t === "text") {
            const delta = String(ev["delta"] ?? "");
            this.voiceHooks.onDelta?.(delta);
            patch((m) => {
              const blocks = [...m.blocks];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "text") blocks[blocks.length - 1] = { type: "text", text: last.text + delta };
              else blocks.push({ type: "text", text: delta });
              return { ...m, blocks, text: m.text + delta, working: "" };
            });
          } else if (t === "card") patch((m) => ({ ...m, blocks: [...m.blocks, ev["card"] as Block] }));
          else if (t === "error") patch((m) => ({ ...m, blocks: [...m.blocks, { type: "error", text: String(ev["message"]) }], streaming: false, working: "" }));
          else if (t === "done") { final = { ...(ev["message"] as Msg), streaming: false }; patch(() => final as Msg); }
        }, ac.signal);
      patch((m) => ({ ...m, streaming: false, working: "" }));
      this.voiceHooks.onDone?.(final);
      this.loadConvs();
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        this.msgs.update((all) => all.map((m) => (m.streaming ? { ...m, streaming: false, working: "", blocks: [...m.blocks, { type: "text", text: "\n\n_Stopped._" }] } : m)));
      } else {
        this.error.set(e instanceof ApiError ? e.message : "The assistant could not answer. Try again.");
        this.msgs.update((all) => all.filter((m) => !m.streaming));
      }
      this.voiceHooks.onDone?.(null);
    } finally {
      this.abort = null;
      this.busy.set(false);
    }
  }

  protected submit(text = this.input(), voice = false): void {
    const t = text.trim();
    if (!t) return;
    this.input.set("");
    const files = this.uploads();
    this.uploads.set([]);
    if (this.busy()) this.queue.update((q) => [...q, { text: t, uploads: files, voice }]);
    else void this.send(t, files, voice);
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.submit();
    }
  }

  protected removeUpload(id: string): void {
    this.uploads.update((u) => u.filter((x) => x.id !== id));
  }

  protected onFile(e: Event): void {
    const el = e.target as HTMLInputElement;
    const f = el.files?.[0];
    if (f) void this.attach(f);
    el.value = "";
  }

  private async attach(file: File): Promise<void> {
    const status = this.status();
    if (!status) return;
    if (file.size > status.upload.max_mb * 1024 * 1024) { this.error.set(`Files up to ${status.upload.max_mb} MB`); return; }
    const form = new FormData();
    form.append("file", file);
    try {
      const r = await api<{ id: string; filename: string; rows?: number }>("/api/admin/assistant/uploads", { method: "POST", form });
      this.uploads.update((u) => [...u, { id: r.id, filename: r.filename, rows: r.rows }]);
      if (!this.input()) this.input.set("Analyse this file and compare it with our live data.");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Upload failed");
    }
  }

  protected setLang(l: string): void {
    this.lang.set(l);
    store.set("asst-lang", l);
  }

  protected toggleDictation(): void {
    if (this.dictating()) { this.dict?.stop(); return; }
    const base = this.input() ? this.input() + " " : "";
    const l = listen(this.lang(), {
      onText: (t) => this.input.set(base + t),
      onEnd: (err) => {
        this.dictating.set(false);
        this.dict = null;
        if (err && err !== "no-speech" && err !== "aborted") this.error.set(`Microphone: ${err}`);
      },
    }, { continuous: true });
    if (!l) { this.error.set("This browser cannot take dictation. Use Chrome or Edge."); return; }
    this.dict = l;
    this.dictating.set(true);
  }

  protected speak(text: string): void {
    this.speaker?.cancel();
    const status = this.status();
    if (!status || !this.sup.speak) return;
    const s = new Speaker({ lang: this.lang(), rate: status.voice.rate, pitch: status.voice.pitch, voiceName: status.voice.voice_name });
    this.speaker = s;
    s.feed(speakable(text) + "\n");
    s.flush();
  }

  protected copyAnswer(m: Msg): void {
    void copyText(m.text || m.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n\n"));
  }

  protected async download(m: Msg, fmt: string): Promise<void> {
    try { await downloadFile(`/api/admin/assistant/messages/${m.id}/download.${fmt}`, undefined, `assistant.${fmt}`); }
    catch (e) { this.error.set(e instanceof ApiError ? e.message : "Download failed"); }
  }

  protected readonly setVoiceDelta = (fn: ((t: string) => void) | undefined) => { this.voiceHooks.onDelta = fn; };
  protected readonly voiceAsk = (text: string) => new Promise<Msg | null>((resolve) => {
    this.voiceHooks.onDone = (m) => resolve(m);
    this.submit(text, true);
  });
}
