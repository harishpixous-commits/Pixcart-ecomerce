/* Admin → AI providers: model connections, keys and the fallback routes. Port of frontend/src/app/admin/ai-providers/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { ArrowDown, ArrowUp, Cpu, KeyRound, PlugZap, Plus, Trash2 } from "lucide-angular";
import { api, ApiError, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Input, Modal, Pill, Select, Textarea, TextField, Toast } from "../../shared/ui/ui";

type Conn = { id: string; name: string; type: string; base_url: string; models: string[]; enabled: boolean; timeout_s: number; builtin: boolean;
  keys: { id: string; label: string; hint: string; added_at?: string }[]; last_test?: { ok: boolean; message: string; at: string } | null };
type PType = { key: string; name: string; protocol: string; base_url: string; needs_key: boolean; local: boolean; example_models: string[]; docs_url: string; notes: string };
type Target = { connection: string; model: string };
type D = { connections: Conn[]; routes: Record<string, Target[]>; route_info: Record<string, { label: string; help: string }>; types: PType[] };
type Draft = { id: string | null; type: string; name: string; base_url: string; models: string; timeout_s: number; enabled: boolean; add: { key: string; label: string }[]; remove: string[] };

@Component({
  selector: "pc-ai-test-button",
  imports: [Icon, Button, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-center gap-1" },
  template: `
    @if (c().models.length > 1) {
      <select pcSelect aria-label="Model to test" (change)="model.set($any($event.target).value)" class="h-8 w-auto py-0 text-sm">
        @for (m of c().models; track m) {<option [selected]="m === picked()">{{ m }}</option>}
      </select>
    }
    <button pcButton size="sm" variant="secondary" [loading]="busy()" (click)="test.emit({ c: c(), model: picked() })"><svg [pcIcon]="PlugZap" class="h-4 w-4" />Test</button>
  `,
})
export class AiTestButton {
  readonly c = input.required<Conn>();
  readonly busy = input(false);
  readonly test = output<{ c: Conn; model: string }>();
  protected readonly PlugZap = PlugZap;
  protected readonly model = signal<string | null>(null);
  protected readonly picked = computed(() => this.model() ?? this.c().models[0] ?? "");
}

@Component({
  selector: "pc-admin-ai-providers-page",
  imports: [PageHeader, Icon, PageLoader, Button, ErrorNote, Field, Input, Modal, Pill, Select, Textarea, TextField, AiTestButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!d()) {
      <pc-page-loader />
    } @else {
      <div class="flex flex-col gap-5">
        <pc-page-header title="AI providers" sub="Connect any language model: Claude, OpenAI, Gemini, Groq, Mistral, DeepSeek, OpenRouter, Azure, or your own server (Ollama, LM Studio, vLLM). Add several keys per provider; when one is rate-limited or out of credit the next key, then the next provider, is used." [withActions]="true">
          <button actions pcButton (click)="error.set(null); draft.set(newDraft())"><svg [pcIcon]="Plus" class="h-4 w-4" />Add connection</button>
        </pc-page-header>
        <pc-error-note [message]="error()" />

        <section class="grid gap-3 lg:grid-cols-2">
          @if (d()!.connections.length === 0) {<p class="rounded-xl bg-white p-4 text-ink-soft">No model connected yet. The assistant and AI studio run in sandbox mode until you add one.</p>}
          @for (c of d()!.connections; track c.id) {
            <article class="flex min-w-0 flex-col gap-2 rounded-xl bg-white p-4">
              <div class="flex items-center gap-2">
                <svg [pcIcon]="Cpu" class="h-5 w-5 text-peacock" />
                <h2 class="truncate text-lg font-semibold">{{ c.name }}</h2>
                <span class="ml-auto flex gap-1">@if (c.builtin) {<pc-pill tone="blue">From Integrations</pc-pill>}<pc-pill [tone]="c.enabled ? 'green' : 'gray'">{{ c.enabled ? "On" : "Off" }}</pc-pill></span>
              </div>
              <p class="break-all text-sm text-ink-soft">{{ typeOf(c.type)?.name ?? c.type }} · {{ c.base_url }}</p>
              <p class="text-sm"><span class="text-ink-faint">Models:</span> {{ c.models.join(", ") }}</p>
              <p class="flex flex-wrap items-center gap-1 text-sm"><svg [pcIcon]="KeyRound" class="h-4 w-4 text-ink-faint" />@if (c.keys.length) {@for (k of c.keys; track k.id) {<code class="rounded bg-mist px-1.5 text-xs">{{ k.label ? k.label + " " : "" }}{{ k.hint }}</code>}} @else {<span class="text-ink-faint">No key</span>}</p>
              <div class="mt-1 flex flex-wrap items-center gap-2">
                <pc-ai-test-button [c]="c" [busy]="!!tests()[c.id]?.busy" (test)="test($event.c, $event.model)" />
                @if (!c.builtin) {<button pcButton size="sm" variant="secondary" (click)="edit(c)">Edit</button>}
                @if (!c.builtin) {<button pcButton size="sm" variant="danger" (click)="remove(c)"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>}
              </div>
              @if (tests()[c.id]?.message || c.last_test) {
                <p role="status" [class]="(tests()[c.id]?.ok ?? c.last_test?.ok) ? 'text-sm text-leaf' : 'text-sm text-vermilion'">{{ tests()[c.id]?.message ?? (c.last_test?.message + " (" + dateTime(c.last_test!.at) + ")") }}</p>
              }
            </article>
          }
        </section>

        <section class="rounded-xl bg-white p-4">
          <h2 class="text-lg font-semibold">Which model answers, and the fallbacks</h2>
          <p class="mb-3 text-sm text-ink-soft">For each use, models are tried top to bottom. Empty routes use the assistant route, then the Claude key from Integrations.</p>
          <div class="grid gap-4 lg:grid-cols-3">
            @for (r of routeKeys(); track r) {
              <div class="flex flex-col gap-2 rounded-lg border border-line p-3">
                <p class="font-semibold">{{ d()!.route_info[r].label }}</p>
                <p class="text-xs text-ink-faint">{{ d()!.route_info[r].help }}</p>
                @for (t of chain(r); track $index; let i = $index; let last = $last) {
                  <div class="flex items-center gap-1">
                    <span class="w-5 text-xs text-ink-faint">{{ i + 1 }}.</span>
                    <select pcSelect [attr.aria-label]="'Connection ' + (i + 1)" (change)="setConn(r, i, $any($event.target).value)" class="min-w-0 flex-1">
                      @for (c of d()!.connections; track c.id) {<option [value]="c.id" [selected]="c.id === t.connection">{{ c.name }}</option>}
                    </select>
                    <select pcSelect [attr.aria-label]="'Model ' + (i + 1)" (change)="setModel(r, i, $any($event.target).value)" class="min-w-0 flex-1">
                      @for (m of modelsOf(t); track m) {<option [value]="m" [selected]="m === t.model">{{ m }}</option>}
                    </select>
                    <button type="button" aria-label="Move up" [disabled]="i === 0" class="p-1 disabled:opacity-30" (click)="move(r, i, -1)"><svg [pcIcon]="ArrowUp" class="h-4 w-4" /></button>
                    <button type="button" aria-label="Move down" [disabled]="last" class="p-1 disabled:opacity-30" (click)="move(r, i, 1)"><svg [pcIcon]="ArrowDown" class="h-4 w-4" /></button>
                    <button type="button" aria-label="Remove" class="p-1 text-vermilion" (click)="drop(r, i)"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>
                  </div>
                }
                @if (d()!.connections.length > 0) {
                  <button pcButton size="sm" variant="secondary" (click)="addTarget(r)"><svg [pcIcon]="Plus" class="h-4 w-4" />Add {{ chain(r).length ? "fallback" : "model" }}</button>
                }
              </div>
            }
          </div>
          <button pcButton class="mt-3" (click)="saveRoutes()">Save routes</button>
        </section>

        <pc-modal [open]="!!draft()" (close)="draft.set(null)" [title]="draft()?.id ? 'Edit ' + draft()!.name : 'Add an AI connection'" [wide]="true">
          @if (draft(); as f) {
            <form (submit)="saveDraft($event)" class="flex flex-col gap-3">
              <pc-error-note [message]="error()" />
              <div class="grid gap-3 md:grid-cols-2">
                <pc-field label="Provider" for="ptype">
                  <select pcSelect id="ptype" [disabled]="!!f.id" (change)="changeType($any($event.target).value)">
                    @for (x of d()!.types; track x.key) {<option [value]="x.key" [selected]="x.key === f.type">{{ x.name }}</option>}
                  </select>
                </pc-field>
                <pc-text-field label="Name" [value]="f.name" (valueChange)="patch({ name: $event })" [required]="true" [maxlength]="60" />
              </div>
              @if (typeOf(f.type)?.notes; as notes) {
                <p class="text-sm text-ink-soft">{{ notes }} @if (typeOf(f.type)!.docs_url) {<a class="text-peacock underline" [href]="typeOf(f.type)!.docs_url" target="_blank" rel="noreferrer">Provider docs</a>}</p>
              }
              <pc-text-field label="API address" [value]="f.base_url" (valueChange)="patch({ base_url: $event })" [required]="true" spellcheck="false"
                [hint]="typeOf(f.type)?.protocol === 'openai' ? 'The address before /chat/completions' : 'The address before /v1/messages'" />
              <pc-field label="Models (one per line)" hint="The first model is the default. Pick models that support tool calling for the assistant." for="pmodels">
                <textarea pcTextarea id="pmodels" rows="3" [value]="f.models" (input)="patch({ models: $any($event.target).value })" spellcheck="false"></textarea>
              </pc-field>
              <div class="flex flex-col gap-2">
                <p class="text-sm font-medium">API keys {{ typeOf(f.type)?.needs_key ? "" : "(optional for this provider)" }}</p>
                @for (k of currentKeys(); track k.id) {
                  <label class="flex items-center gap-2 text-sm">
                    <code class="rounded bg-mist px-1.5">{{ k.label ? k.label + " " : "" }}{{ k.hint }}</code>
                    <input type="checkbox" [checked]="f.remove.includes(k.id)" (change)="toggleRemove(k.id, $any($event.target).checked)" /> remove
                  </label>
                }
                @for (k of f.add; track $index; let i = $index) {
                  <div class="flex gap-2">
                    <input pcInput type="password" autocomplete="off" placeholder="Paste a key" [value]="k.key" (input)="setKey(i, 'key', $any($event.target).value)" [attr.aria-label]="'New key ' + (i + 1)" />
                    <input pcInput placeholder="Label (optional)" [value]="k.label" (input)="setKey(i, 'label', $any($event.target).value)" class="max-w-[10rem]" [attr.aria-label]="'Label ' + (i + 1)" />
                  </div>
                }
                <button pcButton type="button" size="sm" variant="secondary" class="self-start" (click)="patch({ add: [...f.add, { key: '', label: '' }] })"><svg [pcIcon]="Plus" class="h-4 w-4" />Another key</button>
              </div>
              <div class="grid gap-3 md:grid-cols-2">
                <pc-text-field label="Timeout (seconds)" type="number" [min]="5" [max]="300" [value]="'' + f.timeout_s" (valueChange)="patch({ timeout_s: num($event) })" />
                <label class="flex items-center gap-2 self-end pb-2"><input type="checkbox" [checked]="f.enabled" (change)="patch({ enabled: $any($event.target).checked })" /> Switched on</label>
              </div>
              <button pcButton type="submit">{{ f.id ? "Save" : "Add connection" }}</button>
            </form>
          }
        </pc-modal>
      </div>
    }
  `,
})
export class AdminAiProvidersPage {
  private readonly toast = inject(Toast);
  protected readonly Plus = Plus;
  protected readonly Cpu = Cpu;
  protected readonly KeyRound = KeyRound;
  protected readonly Trash2 = Trash2;
  protected readonly ArrowUp = ArrowUp;
  protected readonly ArrowDown = ArrowDown;
  protected readonly dateTime = dateTime;
  protected readonly num = Number;
  protected readonly d = signal<D | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly routes = signal<Record<string, Target[]>>({});
  protected readonly error = signal<string | null>(null);
  protected readonly tests = signal<Record<string, { busy: boolean; ok?: boolean; message?: string }>>({});
  protected readonly routeKeys = computed(() => Object.keys(this.d()?.route_info ?? {}));
  protected readonly currentKeys = computed(() => this.d()?.connections.find((c) => c.id === this.draft()?.id)?.keys ?? []);

  constructor() {
    api<D>("/api/admin/ai-providers").then((x) => this.apply(x)).catch(quietly);
  }

  private apply(x: D): void {
    this.d.set(x);
    this.routes.set(x.routes);
  }

  protected typeOf(k: string): PType | undefined {
    return this.d()?.types.find((t) => t.key === k);
  }

  protected newDraft(type = "anthropic"): Draft {
    const t = this.typeOf(type)!;
    return { id: null, type, name: t.name, base_url: t.base_url, models: t.example_models.join("\n"), timeout_s: 60, enabled: true, add: [{ key: "", label: "" }], remove: [] };
  }

  protected edit(c: Conn): void {
    this.error.set(null);
    this.draft.set({ id: c.id, type: c.type, name: c.name, base_url: c.base_url, models: c.models.join("\n"), timeout_s: c.timeout_s, enabled: c.enabled, add: [], remove: [] });
  }

  protected patch(x: Partial<Draft>): void {
    this.draft.update((f) => (f ? { ...f, ...x } : f));
  }

  protected changeType(type: string): void {
    const f = this.draft();
    if (f) this.draft.set({ ...this.newDraft(type), add: f.add });
  }

  protected toggleRemove(id: string, on: boolean): void {
    const f = this.draft();
    if (f) this.patch({ remove: on ? [...f.remove, id] : f.remove.filter((x) => x !== id) });
  }

  protected setKey(i: number, k: "key" | "label", v: string): void {
    const f = this.draft();
    if (f) this.patch({ add: f.add.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  }

  protected chain(r: string): Target[] {
    return this.routes()[r] ?? [];
  }

  private setChain(r: string, c: Target[]): void {
    this.routes.update((all) => ({ ...all, [r]: c }));
  }

  protected modelsOf(t: Target): string[] {
    return this.d()?.connections.find((c) => c.id === t.connection)?.models ?? [t.model];
  }

  protected setConn(r: string, i: number, id: string): void {
    const c = this.d()?.connections.find((x) => x.id === id);
    this.setChain(r, this.chain(r).map((x, j) => (j === i ? { connection: id, model: c?.models[0] ?? "" } : x)));
  }

  protected setModel(r: string, i: number, model: string): void {
    this.setChain(r, this.chain(r).map((x, j) => (j === i ? { ...x, model } : x)));
  }

  protected move(r: string, i: number, by: -1 | 1): void {
    const c = [...this.chain(r)];
    [c[i + by], c[i]] = [c[i], c[i + by]];
    this.setChain(r, c);
  }

  protected drop(r: string, i: number): void {
    this.setChain(r, this.chain(r).filter((_, j) => j !== i));
  }

  protected addTarget(r: string): void {
    const first = this.d()!.connections[0];
    this.setChain(r, [...this.chain(r), { connection: first.id, model: first.models[0] ?? "" }]);
  }

  private async run(fn: () => Promise<D>, msg: string): Promise<boolean> {
    this.error.set(null);
    try {
      this.apply(await fn());
      this.toast.show(msg);
      return true;
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
      return false;
    }
  }

  protected remove(c: Conn): void {
    if (window.confirm(`Remove ${c.name}? Routes using it are updated.`)) void this.run(() => api<D>(`/api/admin/ai-providers/connections/${c.id}`, { method: "DELETE" }), "Removed");
  }

  protected saveRoutes(): void {
    void this.run(() => api<D>("/api/admin/ai-providers/routes", { method: "PUT", body: { routes: this.routes() } }), "Routes saved");
  }

  protected async saveDraft(e: Event): Promise<void> {
    e.preventDefault();
    const draft = this.draft();
    if (!draft) return;
    const body = { type: draft.type, name: draft.name, base_url: draft.base_url, models: draft.models.split(/[\n,]/).map((m) => m.trim()).filter(Boolean),
      timeout_s: draft.timeout_s, enabled: draft.enabled, add_keys: draft.add.filter((k) => k.key.trim()), remove_keys: draft.remove };
    const ok = await this.run(() => draft.id ? api<D>(`/api/admin/ai-providers/connections/${draft.id}`, { method: "PUT", body }) : api<D>("/api/admin/ai-providers/connections", { method: "POST", body }),
      draft.id ? "Connection saved" : "Connection added");
    if (ok) this.draft.set(null);
  }

  protected async test(c: Conn, model: string): Promise<void> {
    this.tests.update((t) => ({ ...t, [c.id]: { busy: true } }));
    try {
      const r = await api<{ ok: boolean; message: string }>(`/api/admin/ai-providers/connections/${c.id}/test`, { method: "POST", body: { model } });
      this.tests.update((t) => ({ ...t, [c.id]: { busy: false, ...r } }));
    } catch (e) {
      this.tests.update((t) => ({ ...t, [c.id]: { busy: false, ok: false, message: e instanceof ApiError ? e.message : "Test failed" } }));
    }
  }
}
