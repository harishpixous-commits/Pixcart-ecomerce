/*
 * Lists the exports this person may run: CSV, Excel or PDF, with filters and columns, one by one or many at once.
 * Port of components/export-center.tsx: <pc-export-center base="/api/seller/exports" title="..." sub="..." />
 */

import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from "@angular/core";
import { Download, FileArchive, FileSpreadsheet, ShieldAlert, Sparkles } from "lucide-angular";
import { api, ApiError, downloadFile, downloadPost } from "../../core/api";
import { openAssistant } from "../../core/assistant-bus";
import { PageHeader } from "../portal-shell";
import { Icon } from "../ui/icon";
import { PageLoader } from "../ui/page-loader";
import { Button, EmptyState, ErrorNote, Field, Input, Pill, Select } from "../ui/ui";

type Filter = { key: string; label: string; kind: "lookup" | "choice" | "text" | "number"; options?: { value: string; label: string }[]; placeholder?: string };
export type ExportInfo = {
  name: string; label: string; description: string; columns: string[]; date_filter: string;
  statuses: { value: string; label: string }[]; needs_month: boolean; personal_data: boolean; date_optional?: boolean;
  filters?: Filter[]; formats?: string[]; pdf_columns?: string[]; pdf_max_columns?: number; pdf_max_rows?: number;
};
type Fmt = "csv" | "xlsx" | "pdf";
type Config = { format: Fmt; from?: string; to?: string; month?: string; status?: string; columns?: string[]; [k: string]: string | string[] | undefined };

const FMT_LABEL: Record<Fmt, string> = { csv: "CSV", xlsx: "Excel", pdf: "PDF" };
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

@Component({
  selector: "pc-lookup-select",
  imports: [Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <select pcSelect [id]="id()" (change)="valueChange.emit($any($event.target).value)">
      <option value="" [selected]="value() === ''">All</option>
      @for (o of opts(); track o.value) {<option [value]="o.value" [selected]="o.value === value()">{{ o.label }}</option>}
    </select>
  `,
})
export class LookupSelect {
  readonly base = input.required<string>();
  readonly kind = input.required<string>();
  readonly value = input.required<string>();
  readonly id = input.required<string>();
  readonly valueChange = output<string>();
  protected readonly opts = signal<{ value: string; label: string }[]>([]);
  constructor() {
    effect(() => {
      const url = `${this.base()}/lookup/${this.kind()}`;
      api<{ items: { value: string; label: string }[] }>(url).then((r) => this.opts.set(r.items)).catch(() => this.opts.set([]));
    });
  }
}

@Component({
  selector: "pc-export-card",
  imports: [Icon, Pill, Field, Input, Select, Button, ErrorNote, LookupSelect],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "selected() ? 'flex flex-col gap-3 rounded-xl bg-white p-4 ring-peacock/50 ring-2' : 'flex flex-col gap-3 rounded-xl bg-white p-4 ring-peacock/50 '" },
  template: `
    <div class="flex items-start gap-3">
      <svg [pcIcon]="FileSpreadsheet" class="mt-0.5 h-5 w-5 shrink-0 text-peacock" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold">{{ info().label }}</h2>
          @if (info().personal_data) {<pc-pill tone="red">Personal data</pc-pill>}
        </div>
        <p class="text-sm text-ink-soft">{{ info().description }}</p>
      </div>
      @if (canBulk()) {
        <label class="flex shrink-0 items-center gap-1.5 text-sm font-medium">
          <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="selected()" (change)="pick.emit({ name: info().name, cfg: $any($event.target).checked ? query() : null })" [attr.aria-label]="'Select ' + info().label + ' for bulk download'" />
          Select
        </label>
      }
    </div>
    @if (info().date_optional) {
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" class="accent-peacock" [checked]="useRange()" (change)="useRange.set($any($event.target).checked)" /> Filter by {{ info().date_filter }}</label>
    }
    <div class="flex flex-wrap items-end gap-3">
      @if (info().needs_month) {
        <pc-field label="Month" class="w-44"><input pcInput type="month" [value]="cfg().month" [max]="today().slice(0, 7)" (input)="set('month', $any($event.target).value)" /></pc-field>
      } @else if (info().date_filter && useRange()) {
        <pc-field label="From" class="w-40"><input pcInput type="date" [value]="cfg().from" [max]="cfg().to" (input)="set('from', $any($event.target).value)" /></pc-field>
        <pc-field label="To" class="w-40"><input pcInput type="date" [value]="cfg().to" [min]="cfg().from" [max]="today()" (input)="set('to', $any($event.target).value)" /></pc-field>
      }
      @if (info().statuses.length > 0) {
        <pc-field label="Status" class="w-44">
          <select pcSelect (change)="set('status', $any($event.target).value)">
            <option value="" [selected]="!cfg().status">All</option>
            @for (s of info().statuses; track s.value) {<option [value]="s.value" [selected]="s.value === cfg().status">{{ s.label }}</option>}
          </select>
        </pc-field>
      }
      @for (f of info().filters ?? []; track f.key) {
        <pc-field [label]="f.label" [for]="info().name + '-' + f.key" class="w-44">
          @if (f.kind === "lookup") {
            <pc-lookup-select [id]="info().name + '-' + f.key" [base]="base()" [kind]="f.key" [value]="val(f.key)" (valueChange)="set(f.key, $event)" />
          } @else if (f.kind === "choice") {
            <select pcSelect [id]="info().name + '-' + f.key" (change)="set(f.key, $any($event.target).value)">
              <option value="" [selected]="val(f.key) === ''">All</option>
              @for (o of f.options ?? []; track o.value) {<option [value]="o.value" [selected]="o.value === val(f.key)">{{ o.label }}</option>}
            </select>
          } @else {
            <input pcInput [id]="info().name + '-' + f.key" [type]="f.kind === 'number' ? 'number' : 'search'" min="0" [attr.placeholder]="f.placeholder || null" [value]="val(f.key)" (input)="set(f.key, $any($event.target).value)" />
          }
        </pc-field>
      }
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label="File format" class="flex rounded-lg bg-mist p-0.5">
        @for (f of formats(); track f) {
          <button role="radio" [attr.aria-checked]="cfg().format === f" (click)="setFormat(f)"
            [class]="cfg().format === f ? 'rounded-md px-3 py-1.5 text-sm font-semibold bg-white text-peacock shadow-sm' : 'rounded-md px-3 py-1.5 text-sm font-semibold text-ink-soft'">{{ fmtLabel[f] }}</button>
        }
      </div>
      <button pcButton (click)="run()" [loading]="st().state === 'busy'" [disabled]="tooMany()"><svg [pcIcon]="Download" class="h-4 w-4" /> Download {{ fmtLabel[cfg().format] }}</button>
      @if (base().startsWith("/api/admin")) {
        <button pcButton variant="secondary" (click)="ask()"><svg [pcIcon]="Sparkles" class="h-4 w-4" /> Ask AI</button>
      }
    </div>
    @if (info().date_filter && useRange()) {
      <p class="text-xs text-ink-faint">Dates are by {{ info().date_filter }}, in Indian time, up to {{ maxDays() }} days per file.{{ cfg().format === "pdf" ? " PDFs show up to " + (info().pdf_max_rows ?? 2000) + " rows." : "" }}</p>
    }
    @if (st().state === "done") {<p class="text-sm text-leaf" role="status">{{ st().message }}</p>}
    @if (st().state === "failed") {<pc-error-note [message]="st().message" />}
    <button type="button" class="self-start text-sm font-semibold text-peacock" (click)="showCols.set(!showCols())" [attr.aria-expanded]="showCols()">
      {{ showCols() ? "Hide columns" : "Choose columns (" + effectiveCols().length + " of " + info().columns.length + ")" }}
    </button>
    @if (showCols()) {
      <div class="flex flex-col gap-2">
        <div class="flex gap-3 text-sm">
          <button class="text-peacock underline" (click)="cols.set(cfg().format === 'pdf' ? info().columns.slice(0, pdfMax()) : [...info().columns])">All{{ cfg().format === "pdf" ? " (first " + pdfMax() + ")" : "" }}</button>
          <button class="text-peacock underline" (click)="cols.set(null)">Default</button>
        </div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-3">
          @for (c of info().columns; track c) {
            <label class="flex items-center gap-1.5">
              <input type="checkbox" class="accent-peacock" [checked]="effectiveCols().includes(c)" (change)="toggleCol(c, $any($event.target).checked)" />
              <span class="truncate">{{ c }}</span>
            </label>
          }
        </div>
        @if (tooMany()) {<p class="text-sm text-vermilion">A PDF fits {{ pdfMax() }} columns. Untick some, or choose Excel for all of them.</p>}
      </div>
    }
  `,
})
export class ExportCard {
  readonly base = input.required<string>();
  readonly info = input.required<ExportInfo>();
  readonly maxDays = input.required<number>();
  readonly selected = input.required<boolean>();
  readonly canBulk = input(false);
  readonly pick = output<{ name: string; cfg: Config | null }>();
  protected readonly FileSpreadsheet = FileSpreadsheet;
  protected readonly Download = Download;
  protected readonly Sparkles = Sparkles;
  protected readonly fmtLabel = FMT_LABEL;
  protected readonly today = today;
  protected readonly cfg = signal<Config>({ format: "xlsx", from: daysAgo(30), to: today(), month: today().slice(0, 7), status: "" });
  protected readonly useRange = signal(true);
  protected readonly cols = signal<string[] | null>(null);
  protected readonly showCols = signal(false);
  protected readonly st = signal<{ state: "idle" | "busy" | "done" | "failed"; message?: string }>({ state: "idle" });
  private busy = false;
  protected readonly formats = computed(() => (this.info().formats ?? ["csv"]) as Fmt[]);
  protected readonly pdfMax = computed(() => this.info().pdf_max_columns ?? 14);
  protected readonly effectiveCols = computed(() => {
    const info = this.info();
    return this.cols() ?? (this.cfg().format === "pdf" ? info.pdf_columns ?? info.columns.slice(0, this.pdfMax()) : info.columns);
  });
  protected readonly tooMany = computed(() => this.cfg().format === "pdf" && this.effectiveCols().length > this.pdfMax());
  protected readonly query = computed((): Config => {
    const info = this.info();
    const cfg = this.cfg();
    const ranged = !!info.date_filter && this.useRange();
    const q: Config = { format: cfg.format };
    if (info.needs_month) q.month = cfg.month;
    else if (ranged) { q.from = cfg.from; q.to = cfg.to; }
    if (cfg.status) q.status = cfg.status;
    for (const f of info.filters ?? []) if (cfg[f.key]) q[f.key] = cfg[f.key];
    const cols = this.cols();
    if (cols) q.columns = cols;
    return q;
  });

  constructor() {
    let first = true;
    effect(() => {
      if (first) {
        first = false;
        untracked(() => this.useRange.set(!this.info().date_optional));
      }
    });
    effect(() => {
      const q = this.query();
      if (this.selected()) untracked(() => this.pick.emit({ name: this.info().name, cfg: q }));
    });
  }

  protected val(k: string): string {
    return (this.cfg()[k] as string) ?? "";
  }
  protected set(k: string, v: string): void {
    this.cfg.update((c) => ({ ...c, [k]: v }));
  }
  protected setFormat(f: Fmt): void {
    this.cfg.update((c) => ({ ...c, format: f }));
    const cols = this.cols();
    if (f === "pdf" && cols && cols.length > this.pdfMax()) this.cols.set(null);
  }
  protected toggleCol(c: string, on: boolean): void {
    const eff = this.effectiveCols();
    this.cols.set(on ? this.info().columns.filter((x) => x === c || eff.includes(x)) : eff.filter((x) => x !== c));
  }
  protected ask(): void {
    const info = this.info();
    openAssistant({ context: { path: `/admin/exports#${info.name}`, title: info.label, filters: JSON.stringify(this.query()) },
      prompt: `Summarise the ${info.label.toLowerCase()} for the selected period and point out anything unusual.`, attach: true });
  }
  protected async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.st.set({ state: "busy" });
    try {
      const { format, ...q } = this.query();
      const name = await downloadFile(`${this.base()}/${this.info().name}.${format}`, q, `${this.info().name}.${format}`);
      this.st.set({ state: "done", message: `Saved ${name}` });
    } catch (e) {
      this.st.set({ state: "failed", message: e instanceof ApiError ? e.message : "The export failed. Try again." });
    } finally {
      this.busy = false;
    }
  }
}

@Component({
  selector: "pc-export-center",
  imports: [PageHeader, Button, Icon, ErrorNote, PageLoader, EmptyState, ExportCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-4" },
  template: `
    <pc-page-header [title]="title()" [sub]="sub()" [withActions]="!!d() && d()!.items.length > 1">
      @if (d() && d()!.items.length > 1) {
        <button actions pcButton variant="secondary" (click)="toggleAll()">{{ order().length === d()!.items.length ? "Clear selection" : "Select all" }}</button>
      }
    </pc-page-header>
    <pc-error-note [message]="error()" />
    @if (!d()) {
      @if (!error()) {<pc-page-loader />}
    } @else if (d()!.items.length === 0) {
      <pc-empty-state title="No exports for your role" [hasAction]="false" />
    } @else {
      @if (hasPersonal()) {
        <p class="flex items-start gap-2 rounded-lg bg-marigold-light p-3 text-sm">
          <svg [pcIcon]="ShieldAlert" class="mt-0.5 h-4 w-4 shrink-0" />
          Files marked Personal data contain names and contact details. Keep them on work devices, share them only for the purpose they were downloaded for, and delete them when done. Every download is recorded in the audit log.
        </p>
      }
      <div class="grid gap-3 xl:grid-cols-2">
        @for (i of d()!.items; track i.name) {
          <pc-export-card [base]="base()" [info]="i" [maxDays]="d()!.max_days" [selected]="!!picked()[i.name]" (pick)="onSelect($event.name, $event.cfg)" [canBulk]="true" />
        }
      </div>
      @if (order().length > 0) {
        <div class="sticky bottom-3 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white p-3 shadow-lg sm:mr-20" role="region" aria-label="Bulk download">
          <svg [pcIcon]="FileArchive" class="h-5 w-5 text-peacock" />
          <span class="font-semibold">{{ order().length }} selected</span>
          <span class="text-sm text-ink-soft">{{ pickedText() }}</span>
          @if (canZip()) {
            <label class="ml-auto flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" class="accent-peacock" [checked]="asZip()" (change)="asZip.set($any($event.target).checked)" /> One ZIP file
            </label>
          }
          <button pcButton (click)="downloadSelected()" [loading]="bulk().busy" [class]="canZip() ? '' : 'ml-auto'"><svg [pcIcon]="Download" class="h-4 w-4" /> {{ asZip() && canZip() ? "Download ZIP" : "Download all" }}</button>
          @if (bulk().message) {<p class="w-full text-sm text-leaf" role="status">{{ bulk().message }}</p>}
          @if (bulk().error) {<div class="w-full"><pc-error-note [message]="bulk().error" /></div>}
        </div>
      }
    }
  `,
})
export class ExportCenter {
  readonly base = input.required<string>();
  readonly title = input.required<string>();
  readonly sub = input.required<string>();
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly FileArchive = FileArchive;
  protected readonly Download = Download;
  protected readonly d = signal<{ items: ExportInfo[]; max_days: number } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly picked = signal<Record<string, Config>>({});
  protected readonly asZip = signal(true);
  protected readonly bulk = signal<{ busy: boolean; message?: string; error?: string }>({ busy: false });
  protected readonly canZip = computed(() => this.base() === "/api/admin/exports");
  protected readonly order = computed(() => (this.d()?.items ?? []).map((i) => i.name).filter((n) => this.picked()[n]));
  protected readonly hasPersonal = computed(() => (this.d()?.items ?? []).some((i) => i.personal_data));
  protected readonly pickedText = computed(() => {
    const d = this.d();
    const p = this.picked();
    return this.order().map((n) => `${d?.items.find((i) => i.name === n)?.label} (${FMT_LABEL[p[n].format]})`).join(", ");
  });

  constructor() {
    effect(() => {
      const base = this.base();
      api<{ items: ExportInfo[]; max_days: number }>(base).then((x) => this.d.set(x)).catch((e) => this.error.set(e instanceof ApiError ? e.message : "Could not load exports"));
    });
  }

  protected onSelect(name: string, cfg: Config | null): void {
    this.picked.update((p) => {
      if (cfg === null) {
        const { [name]: _, ...rest } = p;
        void _;
        return rest;
      }
      if (JSON.stringify(p[name]) === JSON.stringify(cfg)) return p;
      return { ...p, [name]: cfg };
    });
  }

  protected toggleAll(): void {
    const d = this.d();
    if (!d) return;
    const p = this.picked();
    this.picked.set(this.order().length === d.items.length ? {} : Object.fromEntries(d.items.map((i) => [i.name, p[i.name] ?? { format: "xlsx" as Fmt }])));
  }

  protected async downloadSelected(): Promise<void> {
    this.bulk.set({ busy: true });
    const base = this.base();
    const picked = this.picked();
    try {
      if (this.asZip() && this.canZip()) {
        const items = this.order().map((name) => ({ name, ...picked[name] }));
        const file = await downloadPost(`${base}/bulk`, { items }, "reports.zip");
        this.bulk.set({ busy: false, message: `Saved ${file} with ${items.length} reports` });
      } else {
        const saved: string[] = [];
        for (const name of this.order()) {
          const { format, ...q } = picked[name];
          saved.push(await downloadFile(`${base}/${name}.${format}`, q, `${name}.${format}`));
          await new Promise((r) => setTimeout(r, 400)); // browsers allow several downloads when spaced out
        }
        this.bulk.set({ busy: false, message: `Saved ${saved.length} files: ${saved.join(", ")}` });
      }
    } catch (e) {
      this.bulk.set({ busy: false, error: e instanceof ApiError ? e.message : "Download failed" });
    }
  }
}
