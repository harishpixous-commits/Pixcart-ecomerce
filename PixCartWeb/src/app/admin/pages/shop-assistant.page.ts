/* Admin → Shop assistant: the customer chat on the website (settings and switches, help articles, customer chats, statistics).
 * Separate from the staff AI assistant. Port of frontend/src/app/admin/shop-assistant/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from "@angular/core";
import { Bot, Pencil, Plus, Search, Trash2 } from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, quietly } from "../../core/api";
import { Markdown } from "../../shared/chrome/markdown";
import { PageHeader, Stat, Table, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, Pagination, Pill, Select, Textarea, Toast } from "../../shared/ui/ui";

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
type Block = { type: string; [k: string]: unknown };
type ChatDetail = { id: string; title: string; customer: string; phone: string; customer_id: string | null; feedback: number | null; ticket: { id: string; number: string; status: string } | null;
  messages: { id: string; role: string; text: string; blocks: Block[]; intent: string; voice: boolean; mode: string; created_at: string }[] };
type Stats = { days: number; chats: number; customer_chats: number; guest_chats: number; escalated: number; messages: number; voice_messages: number; cancellations: number;
  helpful: number; not_helpful: number; intents: { intent: string; count: number }[]; ai_answers: number; guided_answers: number; top_articles: { title: string; uses: number }[] };
type Hit = { title: string; score: number; answers: boolean; source: string };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

@Component({
  selector: "pc-sa-switch",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <label [class]="'flex items-start gap-3 py-2 ' + (disabled() ? 'opacity-50' : 'cursor-pointer')">
      <span class="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" class="peer sr-only" [checked]="checked()" [disabled]="disabled()" (change)="changed.emit($any($event.target).checked)" />
        <span class="h-6 w-11 rounded-full bg-line transition peer-checked:bg-leaf peer-focus-visible:ring-2 peer-focus-visible:ring-peacock/40"></span>
        <span class="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5"></span>
      </span>
      <span>
        <span class="block font-medium">{{ label() }}</span>
        @if (help()) {<span class="block text-sm text-ink-faint">{{ help() }}</span>}
      </span>
    </label>
  `,
})
export class SaSwitch {
  readonly checked = input.required<boolean>();
  readonly label = input.required<string>();
  readonly help = input<string | undefined>(undefined);
  readonly disabled = input(false);
  readonly changed = output<boolean>();
}

@Component({
  selector: "pc-sa-section",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section class="rounded-xl bg-white p-5">
      <h2 class="text-lg font-semibold">{{ title() }}</h2>
      @if (sub()) {<p class="mb-2 text-sm text-ink-soft">{{ sub() }}</p>}
      <div class="mt-2"><ng-content /></div>
    </section>
  `,
})
export class SaSection {
  readonly title = input.required<string>();
  readonly sub = input<string | undefined>(undefined);
}

/* ---------------------------------------------------------------- settings and switches */

@Component({
  selector: "pc-sa-settings-tab",
  imports: [SaSwitch, SaSection, PcLink, PageLoader, Button, ErrorNote, Field, Input, Select, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!data() || !s()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      @let data = this.data()!;
      @let s = this.s()!;
      <div class="flex flex-col gap-4">
        <section [class]="'flex flex-wrap items-center justify-between gap-3 rounded-xl p-5 ' + (s.enabled ? 'bg-leaf-light' : 'bg-vermilion-light')">
          <div>
            <p class="text-lg font-semibold">The website chat is {{ data.settings.enabled ? "ON" : "OFF" }}</p>
            <p class="text-sm text-ink-soft">
              {{ data.status.mode === "live" ? "Answers with AI: " + data.status.models.join(", ") : "Guided mode: answers with rules and live data, no AI cost" }}{{ " · " }}{{ data.status.tokens_this_month.toLocaleString("en-IN") }} AI tokens this month
            </p>
          </div>
          <button pcButton [variant]="data.settings.enabled ? 'danger' : 'primary'" [loading]="saving()" (click)="save({ enabled: !data.settings.enabled })">
            {{ data.settings.enabled ? "Switch off" : "Switch on" }}
          </button>
        </section>
        <pc-error-note [message]="error()" />

        <pc-sa-section title="Who can use it">
          <pc-sa-switch [checked]="s.allow_guests" (changed)="set('allow_guests', $event)" label="Guests (not signed in)"
            help="Guests can ask about products and policies. Orders, returns and requests always need sign-in." />
        </pc-sa-section>

        <pc-sa-section title="What the chat can do" sub="Switched-off features are not offered; the chat points customers to the right page instead.">
          @for (f of data.features; track f.key) {
            <pc-sa-switch [checked]="s.features[f.key] ?? true" (changed)="feature(f.key, $event)" [label]="f.label" [help]="f.help" />
          }
        </pc-sa-section>

        <pc-sa-section title="Answers" sub="Guided mode always works. AI mode uses the model on the Shop assistant route in AI providers and falls back to guided mode if it fails.">
          <div class="flex flex-col gap-2">
            <label class="flex items-center gap-2"><input type="radio" [checked]="s.ai === 'auto'" (change)="set('ai', 'auto')" /> Use AI when a model is connected</label>
            <label class="flex items-center gap-2"><input type="radio" [checked]="s.ai === 'guided'" (change)="set('ai', 'guided')" /> Guided only (no AI cost)</label>
            <p class="text-sm text-ink-faint">{{ data.status.own_route ? "Its own AI route is set." : "No own route: it uses the AI assistant's route." }} <a class="font-semibold text-peacock" pcLink="/admin/ai-providers">AI providers</a></p>
          </div>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <pc-field label="Monthly AI token budget" hint="0 = no limit. When used up, the chat answers in guided mode."><input pcInput type="number" min="0" [value]="s.monthly_token_budget" (input)="set('monthly_token_budget', num($event))" /></pc-field>
            <pc-field label="Longest answer (tokens)"><input pcInput type="number" min="200" max="2000" [value]="s.max_output_tokens" (input)="set('max_output_tokens', num($event))" /></pc-field>
            <pc-field label="Tool rounds per question"><input pcInput type="number" min="1" max="8" [value]="s.max_steps" (input)="set('max_steps', num($event))" /></pc-field>
            <pc-field label="Messages remembered"><input pcInput type="number" min="2" max="40" [value]="s.history_messages" (input)="set('history_messages', num($event))" /></pc-field>
          </div>
          <pc-field class="mt-3" label="House rules for the AI" hint="E.g. “Always suggest COD for first orders” or “Reply in Tamil unless asked otherwise”. Customers never see this.">
            <textarea pcTextarea [value]="s.instructions" maxlength="3000" (input)="set('instructions', $any($event.target).value)"></textarea>
          </pc-field>
        </pc-sa-section>

        <pc-sa-section title="How it looks">
          <div class="grid gap-3 sm:grid-cols-2">
            <pc-field label="Name"><input pcInput [value]="s.name" maxlength="40" (input)="set('name', $any($event.target).value)" /></pc-field>
            <pc-field label="Quick replies (one per line)"><textarea pcTextarea [value]="s.quick_replies.join('\\n')" (input)="set('quick_replies', $any($event.target).value.split('\\n'))"></textarea></pc-field>
          </div>
          <pc-field class="mt-3" label="Greeting"><textarea pcTextarea [value]="s.greeting" maxlength="400" (input)="set('greeting', $any($event.target).value)"></textarea></pc-field>
        </pc-sa-section>

        <pc-sa-section title="Voice" sub="Uses the customer's browser (best in Chrome and Edge). Customers can speak, hear replies, or talk hands-free.">
          <pc-sa-switch [checked]="s.voice.enabled" (changed)="voice({ enabled: $event })" label="Voice on" />
          <pc-sa-switch [checked]="s.voice.speak_replies" (changed)="voice({ speak_replies: $event })" label="Read replies aloud by default" [disabled]="!s.voice.enabled" />
          <pc-sa-switch [checked]="s.voice.auto_listen" (changed)="voice({ auto_listen: $event })" label="Hands-free: listen again after speaking" [disabled]="!s.voice.enabled" />
          <div class="mt-2 grid gap-3 sm:grid-cols-3">
            <pc-field label="Languages (code | name, one per line)" class="sm:col-span-3"><textarea pcTextarea [value]="langs()" (input)="langs.set($any($event.target).value)"></textarea></pc-field>
            <pc-field label="Default language">
              <select pcSelect (change)="voice({ default_language: $any($event.target).value })">
                @for (l of s.voice.languages; track l.code) {<option [value]="l.code" [selected]="l.code === s.voice.default_language">{{ l.label }}</option>}
              </select>
            </pc-field>
            <pc-field label="Speed"><input pcInput type="number" step="0.1" min="0.5" max="2" [value]="s.voice.rate" (input)="voice({ rate: num($event) })" /></pc-field>
            <pc-field label="Pitch"><input pcInput type="number" step="0.1" min="0.5" max="2" [value]="s.voice.pitch" (input)="voice({ pitch: num($event) })" /></pc-field>
          </div>
        </pc-sa-section>

        <pc-sa-section title="Limits" sub="Protects the store from abuse and AI cost. Guests are counted per chat.">
          <div class="grid gap-3 sm:grid-cols-3">
            <pc-field label="Messages per minute"><input pcInput type="number" min="1" max="60" [value]="s.limits.per_minute" (input)="limit({ per_minute: num($event) })" /></pc-field>
            <pc-field label="Per day, customer"><input pcInput type="number" min="5" max="2000" [value]="s.limits.per_day_customer" (input)="limit({ per_day_customer: num($event) })" /></pc-field>
            <pc-field label="Per day, guest chat" hint="0 = guests cannot chat"><input pcInput type="number" min="0" max="500" [value]="s.limits.per_day_guest" (input)="limit({ per_day_guest: num($event) })" /></pc-field>
          </div>
        </pc-sa-section>

        <div class="sticky bottom-0 -mx-1 bg-mist/90 px-1 py-3 backdrop-blur">
          <button pcButton (click)="save()" [loading]="saving()">Save settings</button>
        </div>
      </div>
    }
  `,
})
export class SaSettingsTab {
  private readonly toast = inject(Toast);
  protected readonly data = signal<SettingsResp | null>(null);
  protected readonly s = signal<Settings | null>(null);
  protected readonly langs = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);

  constructor() {
    api<SettingsResp>("/api/admin/shop-assistant/settings").then((r) => this.load(r)).catch((e) => this.error.set(e.message));
  }

  private load(r: SettingsResp): void {
    this.data.set(r);
    this.s.set(r.settings);
    this.langs.set(r.settings.voice.languages.map((l) => `${l.code} | ${l.label}`).join("\n"));
  }

  protected num(e: Event): number {
    const v = (e.target as HTMLInputElement).value;
    return v === "" ? 0 : Number(v);
  }

  protected set<K extends keyof Settings>(k: K, v: Settings[K]): void {
    this.s.update((s) => (s ? { ...s, [k]: v } : s));
  }

  protected feature(key: string, on: boolean): void {
    this.set("features", { ...this.s()!.features, [key]: on });
  }

  protected voice(patch: Partial<Voice>): void {
    this.set("voice", { ...this.s()!.voice, ...patch });
  }

  protected limit(patch: Partial<Settings["limits"]>): void {
    this.set("limits", { ...this.s()!.limits, ...patch });
  }

  protected async save(patch?: Partial<Settings>): Promise<void> {
    const s = this.s();
    if (!s) return;
    this.saving.set(true);
    this.error.set(null);
    const languages = this.langs().split("\n").map((l) => l.split("|").map((x) => x.trim())).filter((p) => p[0]).map(([code, label]) => ({ code, label: label || code }));
    try {
      this.load(await api<SettingsResp>("/api/admin/shop-assistant/settings", { method: "PUT", body: patch ?? { ...s, voice: { ...s.voice, languages } } }));
      this.toast.show(patch ? (patch.enabled ? "Shop assistant switched on" : "Shop assistant switched off") : "Settings saved");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      this.saving.set(false);
    }
  }
}

/* ---------------------------------------------------------------- help articles */

type Edit = Omit<Article, "id" | "topic_label" | "uses"> & { id?: string };
const EMPTY: Edit = { title: "", body: "", keywords: [], topic: "other", link: "", is_published: true, position: 0 };

@Component({
  selector: "pc-sa-articles-tab",
  imports: [SaSwitch, SaSection, Table, Icon, PageLoader, Button, EmptyState, ErrorNote, Field, Input, Modal, Select, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!data()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      @let data = this.data()!;
      <div class="flex flex-col gap-4">
        <pc-sa-section title="Try a customer question" sub="See which article the chat would answer with. Add keywords to an article if the right one is missing.">
          <form class="flex gap-2" (submit)="$event.preventDefault(); tryIt()">
            <input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="e.g. refund eppo varum? / is COD available" aria-label="Customer question" />
            <button pcButton type="submit" variant="secondary"><svg [pcIcon]="Search" class="h-4 w-4" />Try</button>
          </form>
          @if (hits(); as hits) {
            @if (hits.length) {
              <ul class="mt-2 text-sm">@for (h of hits; track $index) {<li class="py-0.5">{{ h.answers ? "✓" : "·" }} {{ h.title }} <span class="text-ink-faint">({{ h.source }}, score {{ h.score }})</span></li>}</ul>
            } @else {
              <p class="mt-2 text-sm text-ink-faint">No article matches. The chat would offer products or a support request.</p>
            }
          }
        </pc-sa-section>
        <div class="flex justify-between">
          <p class="text-sm text-ink-soft">Placeholders filled from live settings: {{ data.placeholders.join(" ") }}</p>
          <button pcButton (click)="open()"><svg [pcIcon]="Plus" class="h-4 w-4" />New article</button>
        </div>
        @if (data.items.length) {
          <pc-table [head]="['Article', 'Topic', 'Shown', 'Used', '']">
            @for (a of data.items; track a.id) {
              <tr>
                <td class="px-4 py-2"><p class="font-medium">{{ a.title }}</p><p class="line-clamp-1 text-sm text-ink-faint">{{ a.body }}</p></td>
                <td class="px-4 py-2 text-sm">{{ a.topic_label }}</td>
                <td class="px-4 py-2"><pc-sa-switch [checked]="a.is_published" (changed)="togglePublished(a)" [label]="a.is_published ? 'On' : 'Off'" /></td>
                <td class="px-4 py-2 text-sm">{{ a.uses }}</td>
                <td class="px-4 py-2 text-right">
                  <button type="button" (click)="open(a)" [attr.aria-label]="'Edit ' + a.title" class="p-1.5 text-peacock"><svg [pcIcon]="Pencil" class="h-4 w-4" /></button>
                  <button type="button" (click)="remove(a)" [attr.aria-label]="'Delete ' + a.title" class="p-1.5 text-vermilion"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>
                </td>
              </tr>
            }
          </pc-table>
        } @else {
          <pc-empty-state title="No help articles" body="Add the answers your customers ask for most." [hasAction]="false" />
        }
        <pc-modal [open]="!!edit()" (close)="edit.set(null)" [title]="edit()?.id ? 'Edit article' : 'New article'" [wide]="true">
          @if (edit(); as e) {
            <div class="flex flex-col gap-3">
              <pc-field label="Title"><input pcInput [value]="e.title" maxlength="160" (input)="patch({ title: $any($event.target).value })" /></pc-field>
              <pc-field label="Answer" [hint]="'Written for customers. **bold** works. Placeholders like {free_delivery_amount} are filled in.'"><textarea pcTextarea class="min-h-[140px]" [value]="e.body" maxlength="5000" (input)="patch({ body: $any($event.target).value })"></textarea></pc-field>
              <pc-field label="Words customers use (comma separated, any language)" hint="e.g. refund, money back, panam varala, பணம், रिफंड"><input pcInput [value]="kw()" (input)="kw.set($any($event.target).value)" /></pc-field>
              <div class="grid gap-3 sm:grid-cols-3">
                <pc-field label="Topic"><select pcSelect (change)="patch({ topic: $any($event.target).value })">@for (t of data.topics; track t.code) {<option [value]="t.code" [selected]="t.code === e.topic">{{ t.label }}</option>}</select></pc-field>
                <pc-field label="Page to open (optional)" hint="Starts with /"><input pcInput [value]="e.link" placeholder="/pages/returns-policy" (input)="patch({ link: $any($event.target).value })" /></pc-field>
                <pc-field label="Order"><input pcInput type="number" min="0" [value]="e.position" (input)="patch({ position: +$any($event.target).value })" /></pc-field>
              </div>
              <pc-sa-switch [checked]="e.is_published" (changed)="patch({ is_published: $event })" label="Shown to customers" />
              <pc-error-note [message]="error()" />
              <button pcButton (click)="save()" [loading]="busy()" [disabled]="e.title.trim().length < 3 || e.body.trim().length < 10">Save article</button>
            </div>
          }
        </pc-modal>
      </div>
    }
  `,
})
export class SaArticlesTab {
  private readonly toast = inject(Toast);
  protected readonly Pencil = Pencil;
  protected readonly Plus = Plus;
  protected readonly Search = Search;
  protected readonly Trash2 = Trash2;
  protected readonly data = signal<ArticlesResp | null>(null);
  protected readonly edit = signal<Edit | null>(null);
  protected readonly kw = signal("");
  protected readonly q = signal("");
  protected readonly hits = signal<Hit[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    this.load();
  }

  private load(): void {
    api<ArticlesResp>("/api/admin/shop-assistant/articles").then((d) => this.data.set(d)).catch((e) => this.error.set(e.message));
  }

  protected patch(p: Partial<Edit>): void {
    this.edit.update((e) => (e ? { ...e, ...p } : e));
  }

  protected open(a?: Article): void {
    this.edit.set(a ? { ...a } : { ...EMPTY, position: this.data()?.items.length ?? 0 });
    this.kw.set(a ? a.keywords.join(", ") : "");
    this.error.set(null);
  }

  protected async save(): Promise<void> {
    const edit = this.edit();
    if (!edit) return;
    this.busy.set(true);
    this.error.set(null);
    const body = { ...edit, keywords: this.kw().split(",").map((k) => k.trim()).filter(Boolean) };
    try {
      await api(edit.id ? `/api/admin/shop-assistant/articles/${edit.id}` : "/api/admin/shop-assistant/articles", { method: edit.id ? "PUT" : "POST", body });
      this.toast.show("Article saved");
      this.edit.set(null);
      this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }

  protected async togglePublished(a: Article): Promise<void> {
    await api(`/api/admin/shop-assistant/articles/${a.id}`, { method: "PUT", body: { ...a, is_published: !a.is_published } });
    this.load();
  }

  protected async remove(a: Article): Promise<void> {
    if (!window.confirm(`Delete “${a.title}”? The chat will no longer use it.`)) return;
    await api(`/api/admin/shop-assistant/articles/${a.id}`, { method: "DELETE" });
    this.toast.show("Deleted");
    this.load();
  }

  protected async tryIt(): Promise<void> {
    const q = this.q();
    if (q.trim().length < 2) return;
    this.hits.set((await api<{ items: Hit[] }>("/api/admin/shop-assistant/articles/try", { method: "POST", body: { question: q } })).items);
  }
}

/* ---------------------------------------------------------------- customer chats */

function blockSummary(b: Block): string {
  switch (b.type) {
    case "order": return `Order card: ${(b["order"] as { number: string; status: string }).number} (${(b["order"] as { status: string }).status})`;
    case "orders": return `Orders list (${(b["items"] as unknown[]).length})`;
    case "products": return `Products: ${(b["items"] as { title: string }[]).map((p) => p.title).slice(0, 3).join(", ")}`;
    case "tickets": return `Requests: ${(b["items"] as { number: string }[]).map((t) => t.number).join(", ")}`;
    case "article": return `Help article: ${b["title"] as string}`;
    case "confirm": return `Confirm button: ${b["summary"] as string} → ${b["status"] as string}`;
    case "ticket_form": return `Support request form${b["status"] === "sent" ? ` → sent ${b["ticket_number"] as string}` : ""}`;
    case "signin": return "Asked to sign in";
    case "chips": return `Quick replies: ${(b["items"] as string[]).join(" · ")}`;
    case "link": return `Link: ${b["link"] as string}`;
    case "returns": return "Returns and refunds";
    case "error": return `Error: ${b["text"] as string}`;
    default: return b.type;
  }
}

@Component({
  selector: "pc-sa-chats-tab",
  imports: [Table, Markdown, PcLink, PageLoader, Button, EmptyState, ErrorNote, Input, Modal, Pagination, Pill, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3" },
  template: `
    <div class="flex flex-wrap items-center gap-2">
      <select pcSelect (change)="filter.set($any($event.target).value); page.set(1)" aria-label="Filter" class="w-auto">
        <option value="all">All chats</option><option value="not_helpful">Rated not helpful</option><option value="helpful">Rated helpful</option><option value="escalated">Sent to support</option>
      </select>
      <form (submit)="$event.preventDefault(); search()" class="flex gap-2"><input pcInput [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Customer, phone or topic" aria-label="Search chats" /><button pcButton type="submit" variant="secondary">Search</button></form>
    </div>
    <pc-error-note [message]="error()" />
    @if (!data()) {
      <pc-page-loader />
    } @else if (data()!.items.length) {
      <pc-table [head]="['Chat', 'Customer', 'Messages', 'Rating', 'Request', 'Last message']">
        @for (c of data()!.items; track c.id) {
          <tr class="cursor-pointer hover:bg-mist/60" (click)="show(c.id)">
            <td class="px-4 py-2"><p class="font-medium">{{ c.title }}</p><p class="text-xs text-ink-faint">{{ c.page }}{{ c.language && c.language !== "en" ? " · " + c.language : "" }}</p></td>
            <td class="px-4 py-2 text-sm">{{ c.customer }} <span class="text-ink-faint">{{ c.phone }}</span></td>
            <td class="px-4 py-2 text-sm">{{ c.messages }}</td>
            <td class="px-4 py-2">@if (c.feedback === 1) {<pc-pill tone="green">Helpful</pc-pill>} @else if (c.feedback === -1) {<pc-pill tone="red">Not helpful</pc-pill>} @else {—}</td>
            <td class="px-4 py-2 text-sm">{{ c.ticket || "—" }}</td>
            <td class="px-4 py-2 text-sm">{{ when(c.updated_at) }}</td>
          </tr>
        }
      </pc-table>
      <pc-pagination [page]="page()" [pageSize]="25" [total]="data()!.total" (pageChange)="page.set($event)" />
    } @else {
      <pc-empty-state title="No chats yet" body="Customer chats from the website appear here." [hasAction]="false" />
    }
    <pc-modal [open]="!!open()" (close)="open.set(null)" [title]="open() ? open()!.customer + ' ' + open()!.phone : ''" [wide]="true">
      @if (open(); as o) {
        <div class="flex flex-col gap-2">
          @if (o.ticket) {<p class="text-sm">Support request: <a class="font-semibold text-peacock" [pcLink]="'/admin/support/' + o.ticket.id">{{ o.ticket.number }}</a> ({{ o.ticket.status }})</p>}
          @for (m of o.messages; track m.id) {
            <div [class]="'rounded-lg p-2 text-sm ' + (m.role === 'user' ? 'bg-peacock-light' : 'bg-mist')">
              <p class="mb-0.5 text-xs text-ink-faint">{{ m.role === "user" ? "Customer" : "Assistant" }}{{ m.voice ? " · voice" : "" }}{{ m.intent ? " · " + m.intent : "" }}{{ m.mode ? " · " + m.mode : "" }} · {{ when(m.created_at) }}</p>
              @if (m.role === "user") {
                <p class="whitespace-pre-wrap">{{ m.text }}</p>
              } @else {
                @if (m.text) {<pc-markdown [source]="m.text" />}
                @for (b of nonText(m.blocks); track $index) {<p class="text-xs text-ink-soft">▸ {{ summary(b) }}</p>}
              }
            </div>
          }
        </div>
      }
    </pc-modal>
  `,
})
export class SaChatsTab {
  protected readonly when = when;
  protected readonly summary = blockSummary;
  protected readonly filter = signal("all");
  protected readonly q = signal("");
  protected readonly page = signal(1);
  protected readonly data = signal<{ total: number; items: ChatRow[] } | null>(null);
  protected readonly open = signal<ChatDetail | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => this.load(this.filter(), this.page(), this.q()));
  }

  private load(filter: string, page: number, q: string): void {
    const query: Record<string, string | number | boolean> = { page, q };
    if (filter === "helpful") query["feedback"] = 1;
    if (filter === "not_helpful") query["feedback"] = -1;
    if (filter === "escalated") query["escalated"] = true;
    api<{ total: number; items: ChatRow[] }>("/api/admin/shop-assistant/chats", { query }).then((d) => this.data.set(d)).catch((e) => this.error.set(e.message));
  }

  protected search(): void {
    this.page.set(1);
    this.load(this.filter(), this.page(), this.q());
  }

  protected nonText(blocks: Block[]): Block[] {
    return blocks.filter((b) => b.type !== "text");
  }

  protected show(id: string): void {
    api<ChatDetail>(`/api/admin/shop-assistant/chats/${id}`).then((d) => this.open.set(d)).catch(quietly);
  }
}

/* ---------------------------------------------------------------- statistics */

@Component({
  selector: "pc-sa-stats-tab",
  imports: [SaSection, Stat, PageLoader, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!s()) {
      <pc-page-loader />
    } @else {
      @let s = this.s()!;
      <div class="flex flex-col gap-4">
        <select pcSelect (change)="days.set(+$any($event.target).value)" class="w-auto self-start" aria-label="Period">
          <option value="7" [selected]="days() === 7">Last 7 days</option><option value="30" [selected]="days() === 30">Last 30 days</option><option value="90" [selected]="days() === 90">Last 90 days</option>
        </select>
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <pc-stat label="Chats" [value]="s.chats" [hint]="s.customer_chats + ' customers · ' + s.guest_chats + ' guests'" />
          <pc-stat label="Questions" [value]="s.messages" [hint]="s.voice_messages + ' by voice'" />
          <pc-stat label="Sent to support" [value]="s.escalated" [hint]="s.chats ? round((s.escalated * 100) / s.chats) + '% of chats' : undefined" />
          <pc-stat label="Rated helpful" [value]="rated() ? round((s.helpful * 100) / rated()) + '%' : '—'" [hint]="rated() + ' ratings'" />
          <pc-stat label="Cancellations done in chat" [value]="s.cancellations" />
          <pc-stat label="AI answers" [value]="s.ai_answers" [hint]="s.guided_answers + ' guided'" />
        </div>
        <div class="grid gap-4 lg:grid-cols-2">
          <pc-sa-section title="What customers ask">
            @for (i of s.intents; track i.intent) {<p class="flex justify-between border-b border-line py-1 text-sm"><span>{{ i.intent }}</span><b>{{ i.count }}</b></p>}
          </pc-sa-section>
          <pc-sa-section title="Most used help articles">
            @for (a of s.top_articles; track a.title) {<p class="flex justify-between border-b border-line py-1 text-sm"><span>{{ a.title }}</span><b>{{ a.uses }}</b></p>} @empty {<p class="text-sm text-ink-faint">None yet.</p>}
          </pc-sa-section>
        </div>
      </div>
    }
  `,
})
export class SaStatsTab {
  protected readonly round = Math.round;
  protected readonly days = signal(30);
  protected readonly s = signal<Stats | null>(null);
  protected readonly rated = computed(() => (this.s()?.helpful ?? 0) + (this.s()?.not_helpful ?? 0));

  constructor() {
    effect(() => {
      const days = this.days();
      api<Stats>("/api/admin/shop-assistant/stats", { query: { days } }).then((s) => this.s.set(s)).catch(() => {});
    });
  }
}

@Component({
  selector: "pc-admin-shop-assistant-page",
  imports: [PageHeader, Tabs, Icon, PcLink, EmptyState, SaSettingsTab, SaArticlesTab, SaChatsTab, SaStatsTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!tabs().length) {
      <pc-empty-state title="No access" body="Ask an owner for a shop assistant permission." [hasAction]="false" />
    } @else {
      <div>
        <pc-page-header title="Shop assistant" sub="The help chat customers see on the website. Separate from the staff AI assistant: it only sees public information and each customer's own orders." [withActions]="true">
          <a actions pcLink="/" target="_blank" class="inline-flex h-10 items-center gap-1.5 px-3 font-semibold text-peacock"><svg [pcIcon]="Bot" class="h-4 w-4" />Open the store</a>
        </pc-page-header>
        <pc-tabs [value]="tab()" (valueChange)="tab.set($event)" [items]="tabs()" />
        @switch (tab()) {
          @case ("settings") {<pc-sa-settings-tab />}
          @case ("articles") {<pc-sa-articles-tab />}
          @case ("chats") {<pc-sa-chats-tab />}
          @case ("stats") {<pc-sa-stats-tab />}
        }
      </div>
    }
  `,
})
export class AdminShopAssistantPage {
  private readonly admin = inject(AdminContext);
  protected readonly Bot = Bot;
  protected readonly tabs = computed(() => {
    const canSettings = this.admin.can("shop_assistant"), canKb = this.admin.can("shop_assistant_kb"), canChats = this.admin.can("shop_assistant_chats");
    return [
      canSettings && { value: "settings", label: "Settings and switches" },
      canKb && { value: "articles", label: "Help articles" },
      canChats && { value: "chats", label: "Customer chats" },
      canChats && { value: "stats", label: "Statistics" },
    ].filter(Boolean) as { value: string; label: string }[];
  });
  protected readonly tab = signal(this.tabs()[0]?.value ?? "");
}
