/* Admin → AI studio: features, model, brand voice, budget and the activity log. Port of frontend/src/app/admin/ai/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { Bot, Download } from "lucide-angular";
import { api, ApiError, downloadFile, latestOnly, quietly } from "../../core/api";
import { dateTime } from "../../core/format";
import type { AiRun } from "../../shared/portal/ai";
import { PageHeader, Stat, Table, Tabs } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Modal, Pagination, Pill, Select, Textarea, TextField, Toast } from "../../shared/ui/ui";

type Cfg = { enabled: boolean; model: string; monthly_token_budget: number; price_input_per_mtok: number; price_output_per_mtok: number; brand_voice: string; tasks: Record<string, { enabled: boolean; instructions: string }> };
type TaskInfo = { key: string; label: string; description: string; audience: string; output: string; rules: string; enabled: boolean; instructions: string; runs_this_month: number; used_this_month: number };
type Studio = {
  settings: Cfg; status: { mode: "live" | "sandbox"; key_configured: boolean; environment: string }; models: { id: string; label: string }[];
  usage: { runs: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number; budget_left: number | null };
  tasks: TaskInfo[];
};
type Runs = { items: AiRun[]; total: number; page: number; page_size: number };
type Detail = AiRun & { inputs: Record<string, unknown> };

const AUDIENCE: Record<string, string> = { seller: "Sellers", admin: "Staff", system: "Automatic" };
const STATUS: Record<string, string> = { draft: "Draft", applied: "Used", sent: "Sent", discarded: "Discarded", failed: "Failed" };
const n = (x: number) => x.toLocaleString("en-IN");

@Component({
  selector: "pc-ai-runs",
  imports: [Icon, Table, PageLoader, Button, EmptyState, ErrorNote, Field, Modal, Pagination, Pill, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3" },
  template: `
    <div class="flex flex-wrap items-end gap-3">
      <h2 class="mr-auto text-lg font-semibold">Activity</h2>
      <pc-field label="Feature" class="w-52"><select pcSelect (change)="task.set($any($event.target).value); page.set(1)"><option value="">All</option>@for (t of tasks(); track t.key) {<option [value]="t.key" [selected]="t.key === task()">{{ t.label }}</option>}</select></pc-field>
      <pc-field label="Outcome" class="w-40"><select pcSelect (change)="status.set($any($event.target).value); page.set(1)"><option value="">All</option>@for (s of statuses; track s[0]) {<option [value]="s[0]" [selected]="s[0] === status()">{{ s[1] }}</option>}</select></pc-field>
      <button pcButton variant="secondary" (click)="exportCsv()"><svg [pcIcon]="Download" class="h-4 w-4" /> Export</button>
    </div>
    @if (!d()) {
      <pc-page-loader />
    } @else if (d()!.items.length === 0) {
      <pc-empty-state title="No AI activity yet" body="Drafts appear here as staff and sellers use AI features." [hasAction]="false" />
    } @else {
      <pc-table [head]="['When', 'Feature', 'By', 'Outcome', 'Tokens in / out', 'Time', 'Cost']">
        @for (r of d()!.items; track r.id) {
          <tr class="cursor-pointer hover:bg-mist/60" (click)="open(r)">
            <td class="px-4 py-2 text-sm">{{ dateTime(r.created_at) }}</td>
            <td class="px-4 py-2">{{ r.task_label }}{{ " " }}@if (r.mode === "sandbox") {<pc-pill tone="blue">Sandbox</pc-pill>}</td>
            <td class="px-4 py-2 text-sm">{{ r.by }}</td>
            <td class="px-4 py-2"><pc-pill [tone]="r.status === 'failed' ? 'red' : r.status === 'discarded' ? 'gray' : r.status === 'draft' ? 'blue' : 'green'">{{ label[r.status] }}</pc-pill></td>
            <td class="px-4 py-2 text-sm">{{ n(r.input_tokens + r.cache_creation_tokens + r.cache_read_tokens) }} / {{ n(r.output_tokens) }}</td>
            <td class="px-4 py-2 text-sm">{{ r.latency_ms ? (r.latency_ms / 1000).toFixed(1) + " s" : "—" }}</td>
            <td class="px-4 py-2 text-sm">{{ r.cost_usd ? "$" + r.cost_usd.toFixed(4) : "—" }}</td>
          </tr>
        }
      </pc-table>
      <pc-pagination [page]="d()!.page" [pageSize]="d()!.page_size" [total]="d()!.total" (pageChange)="page.set($event)" />
    }
    <pc-modal [open]="!!detail()" (close)="detail.set(null)" [title]="detail() ? detail()!.task_label + ', ' + dateTime(detail()!.created_at) : ''" [wide]="true">
      @if (detail(); as x) {
        <div class="flex flex-col gap-3 text-sm">
          <p>Model {{ x.model }}. {{ n(x.input_tokens) }} input, {{ n(x.cache_read_tokens) }} from cache, {{ n(x.output_tokens) }} output tokens. Outcome: {{ label[x.status] }}.</p>
          @if (x.error) {<pc-error-note [message]="x.error" />}
          <div><p class="mb-1 font-semibold">Request</p><pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-mist p-2 text-xs">{{ json(x.inputs) }}</pre></div>
          <div><p class="mb-1 font-semibold">AI output</p><pre class="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-mist p-2 text-xs">{{ x.output.text ?? json(x.output) }}</pre></div>
          @if (x.final_text) {<div><p class="mb-1 font-semibold">What was used</p><pre class="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-leaf-light p-2 text-xs">{{ x.final_text }}</pre></div>}
        </div>
      }
    </pc-modal>
  `,
})
export class AiRuns {
  readonly tasks = input.required<TaskInfo[]>();
  protected readonly Download = Download;
  protected readonly dateTime = dateTime;
  protected readonly n = n;
  protected readonly label = STATUS;
  protected readonly statuses = Object.entries(STATUS);
  protected readonly task = signal("");
  protected readonly status = signal("");
  protected readonly page = signal(1);
  protected readonly d = signal<Runs | null>(null);
  protected readonly detail = signal<Detail | null>(null);
  private readonly track = latestOnly();

  constructor() {
    effect(() => {
      const query = { task: this.task() || undefined, status: this.status() || undefined, page: this.page() };
      void this.track(api<Runs>("/api/admin/ai/runs", { query }), (x) => this.d.set(x));
    });
  }

  protected json(v: unknown): string {
    return JSON.stringify(v, null, 2);
  }

  protected open(r: AiRun): void {
    api<Detail>(`/api/admin/ai/runs/${r.id}`).then((x) => this.detail.set(x)).catch(quietly);
  }

  protected exportCsv(): void {
    downloadFile("/api/admin/exports/ai-runs.csv", { status: this.status() || undefined }, "ai-usage.csv").catch(() => {});
  }
}

@Component({
  selector: "pc-admin-ai-page",
  imports: [PageHeader, Stat, Tabs, Icon, PageLoader, Button, ErrorNote, Field, Modal, Pill, Select, Textarea, TextField, AiRuns],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!s() || !cfg()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <div class="flex flex-col gap-4">
        <pc-page-header title="AI studio" sub="Every AI feature in one place: switch features on or off, choose the model, set the brand voice and a monthly budget, and see what each draft cost. People review every draft before it is used." [withActions]="true">
          @if (dirty()) {<span actions class="self-center text-sm text-ink-soft">Unsaved changes</span>}
          <button actions pcButton variant="ghost" [disabled]="!dirty()" (click)="cfg.set(parse(saved()))">Discard</button>
          <button actions pcButton (click)="save()" [loading]="busy()" [disabled]="!dirty()">Save changes</button>
        </pc-page-header>
        <pc-error-note [message]="error()" />
        <section [class]="'flex flex-wrap items-center gap-3 rounded-xl p-4 ' + (s()!.status.mode === 'live' ? 'bg-leaf-light' : 'bg-marigold-light')">
          <svg [pcIcon]="Bot" class="h-6 w-6" />
          <div class="flex-1">
            <p class="font-semibold">{{ s()!.status.mode === "live" ? "Connected to Claude" : "Sandbox mode: no API key" }}</p>
            <p class="text-sm text-ink-soft">{{ s()!.status.mode === "live" ? "Drafts are written by the model chosen below." : "Features return clearly marked placeholder drafts so you can try every screen. Add ANTHROPIC_API_KEY to the server secrets to switch to real AI. Sellers do not see AI buttons in production until then." }}</p>
          </div>
          <label class="flex items-center gap-2 font-semibold"><input type="checkbox" role="switch" [attr.aria-checked]="cfg()!.enabled" class="h-5 w-5 accent-peacock" [checked]="cfg()!.enabled" (change)="setCfg({ enabled: $any($event.target).checked })" /> AI features on</label>
        </section>
        <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <pc-stat label="Drafts this month" [value]="n(s()!.usage.runs)" />
          <pc-stat label="Tokens this month" [value]="n(used())" [hint]="cfg()!.monthly_token_budget ? pct() + '% of the ' + n(cfg()!.monthly_token_budget) + ' budget' : 'No budget limit'" />
          <pc-stat label="Estimated cost" [value]="'$' + s()!.usage.cost_usd.toFixed(2)" hint="At the prices set below" />
          <pc-stat label="Served from cache" [value]="cacheShare() + '%'" hint="Input tokens billed at the lower cache rate" />
        </div>
        @if (cfg()!.monthly_token_budget > 0) {
          <div class="h-2 overflow-hidden rounded-full bg-white" role="progressbar" [attr.aria-valuenow]="pct()" aria-valuemin="0" aria-valuemax="100" aria-label="Budget used"><div [class]="pct() > 85 ? 'h-full rounded-full bg-vermilion' : 'h-full rounded-full bg-peacock'" [style.width.%]="pct()"></div></div>
        }

        <pc-tabs [value]="tab()" (valueChange)="tab.set($event)" [items]="tabItems" />

        @if (tab() === "features") {
          <div class="grid gap-3 lg:grid-cols-2">
            @for (task of s()!.tasks; track task.key) {
              <section [class]="'flex flex-col gap-2 rounded-xl bg-white p-4 ' + (t(task.key).enabled ? '' : 'opacity-70')">
                <div class="flex items-start gap-3">
                  <div class="flex-1">
                    <div class="flex flex-wrap items-center gap-2"><h2 class="font-semibold">{{ task.label }}</h2><pc-pill tone="gray">{{ audience[task.audience] }}</pc-pill></div>
                    <p class="text-sm text-ink-soft">{{ task.description }}</p>
                  </div>
                  <label class="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" [attr.aria-label]="task.label + ' on'" [attr.aria-checked]="t(task.key).enabled" class="h-4 w-4 accent-peacock" [checked]="t(task.key).enabled" (change)="setTask(task.key, { enabled: $any($event.target).checked })" /> On</label>
                </div>
                <p class="text-xs text-ink-faint">{{ task.runs_this_month }} drafts this month, {{ task.used_this_month }} used or sent</p>
                <pc-field label="Extra instructions (optional)" hint="Style or content preferences. The fixed safety rules always apply.">
                  <textarea pcTextarea rows="2" maxlength="1000" [value]="t(task.key).instructions" (input)="setTask(task.key, { instructions: $any($event.target).value })"></textarea>
                </pc-field>
                <button type="button" class="self-start text-sm font-semibold text-peacock" (click)="rules.set(task)">View fixed rules</button>
              </section>
            }
          </div>
        }

        @if (tab() === "model") {
          <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
            <pc-field label="Model">
              <select pcSelect (change)="pickModel($any($event.target).value)">
                @for (m of s()!.models; track m.id) {<option [value]="m.id" [selected]="m.id === modelChoice()">{{ m.label }}</option>}
                <option value="_custom" [selected]="modelChoice() === '_custom'">Other model id…</option>
              </select>
            </pc-field>
            <pc-text-field label="Model id" [value]="cfg()!.model" (valueChange)="setCfg({ model: $event.trim() })" hint="Any Claude model id, e.g. claude-haiku-5-5" />
            <pc-field label="Brand voice" class="sm:col-span-2" hint="Used by every feature that writes text for customers or sellers.">
              <textarea pcTextarea rows="3" maxlength="600" [value]="cfg()!.brand_voice" (input)="setCfg({ brand_voice: $any($event.target).value })"></textarea>
            </pc-field>
            <pc-text-field label="Monthly token budget" inputmode="numeric" [value]="'' + cfg()!.monthly_token_budget" (valueChange)="setCfg({ monthly_token_budget: toInt($event) })" hint="AI stops for the rest of the month when used up. 0 means no limit." />
            <div class="grid grid-cols-2 gap-3">
              <pc-text-field label="Input price ($ per million tokens)" inputmode="decimal" [value]="'' + cfg()!.price_input_per_mtok" (valueChange)="setCfg({ price_input_per_mtok: toNum($event) })" />
              <pc-text-field label="Output price ($ per million tokens)" inputmode="decimal" [value]="'' + cfg()!.price_output_per_mtok" (valueChange)="setCfg({ price_output_per_mtok: toNum($event) })" />
            </div>
            <p class="text-xs text-ink-faint sm:col-span-2">Prices are for the cost estimate only; take them from your provider's current price list.</p>
          </section>
        }

        @if (tab() === "activity") {<pc-ai-runs [tasks]="s()!.tasks" />}

        <pc-modal [open]="!!rules()" (close)="rules.set(null)" [title]="'Fixed rules: ' + (rules()?.label ?? '')" [wide]="true">
          <p class="mb-2 text-sm text-ink-soft">These rules are part of the product and are sent first with every request. Extra instructions are added after them and cannot override them.</p>
          <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-mist p-3 text-sm">{{ rules()?.rules }}</pre>
        </pc-modal>
      </div>
    }
  `,
})
export class AdminAiPage {
  private readonly toast = inject(Toast);
  protected readonly Bot = Bot;
  protected readonly n = n;
  protected readonly audience = AUDIENCE;
  protected readonly parse = (x: string) => JSON.parse(x) as Cfg;
  protected readonly tabItems = [{ value: "features", label: "Features" }, { value: "model", label: "Model, voice and budget" }, { value: "activity", label: "Activity" }];
  protected readonly s = signal<Studio | null>(null);
  protected readonly cfg = signal<Cfg | null>(null);
  protected readonly saved = signal("");
  protected readonly tab = signal("features");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly rules = signal<TaskInfo | null>(null);
  protected readonly dirty = computed(() => this.cfg() !== null && JSON.stringify(this.cfg()) !== this.saved());
  protected readonly used = computed(() => { const u = this.s()!.usage; return u.input_tokens + u.output_tokens; });
  protected readonly pct = computed(() => { const b = this.cfg()!.monthly_token_budget; return b ? Math.min(100, Math.round((this.used() * 100) / b)) : 0; });
  protected readonly cacheShare = computed(() => { const u = this.s()!.usage; return u.input_tokens ? Math.round((u.cache_read_tokens * 100) / u.input_tokens) : 0; });
  protected readonly modelChoice = computed(() => (this.s()!.models.some((m) => m.id === this.cfg()!.model) ? this.cfg()!.model : "_custom"));

  constructor() {
    api<Studio>("/api/admin/ai").then((x) => this.apply(x)).catch((e) => this.error.set(e.message));
  }

  private apply(x: Studio): void {
    this.s.set(x);
    this.cfg.set(x.settings);
    this.saved.set(JSON.stringify(x.settings));
  }

  protected t(k: string): { enabled: boolean; instructions: string } {
    return this.cfg()!.tasks[k] ?? { enabled: true, instructions: "" };
  }

  protected setCfg(x: Partial<Cfg>): void {
    this.cfg.update((c) => (c ? { ...c, ...x } : c));
  }

  protected setTask(k: string, patch: Partial<{ enabled: boolean; instructions: string }>): void {
    const c = this.cfg()!;
    this.cfg.set({ ...c, tasks: { ...c.tasks, [k]: { ...this.t(k), ...patch } } });
  }

  protected pickModel(v: string): void {
    if (v !== "_custom") this.setCfg({ model: v });
  }

  protected toInt(v: string): number {
    return Number(v.replace(/\D/g, "")) || 0;
  }

  protected toNum(v: string): number {
    return Number(v) || 0;
  }

  protected async save(): Promise<void> {
    const cfg = this.cfg();
    if (!cfg) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      this.apply(await api<Studio>("/api/admin/ai", { method: "PUT", body: cfg }));
      this.toast.show("AI settings saved");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }
}
