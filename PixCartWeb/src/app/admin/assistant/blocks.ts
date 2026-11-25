/*
 * What the admin AI assistant shows inside an answer: text (markdown, with a cursor while it streams), number cards,
 * sortable and filterable tables, charts, file downloads, links, proposed changes to confirm or cancel, errors and the
 * files a person attached. Port of components/assistant/blocks.tsx: <pc-block-view [b]="block" [streaming]="..." />
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { AlertTriangle, Check, ClipboardCopy, Download, ExternalLink, FileText, Loader2, X } from "lucide-angular";
import { api, ApiError, downloadFile } from "../../core/api";
import { Markdown } from "../../shared/chrome/markdown";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

export type Block =
  | { type: "text"; text: string }
  | { type: "metrics"; title: string; note?: string; items: { label: string; value: string; hint?: string }[] }
  | { type: "table"; title: string; columns: string[]; rows: (string | number)[][]; total_rows?: number; note?: string; link?: string }
  | { type: "chart"; title: string; kind: "bar" | "line"; labels: string[]; unit?: string; series: { name: string; values: number[] }[] }
  | { type: "file"; title: string; format: string; path: string; filename: string; detail?: string }
  | { type: "links"; title: string; items: { label: string; href: string }[] }
  | { type: "action"; action_id: string; kind: string; summary: string; details: [string, string][]; status: string }
  | { type: "error"; text: string }
  | { type: "files"; items: { id: string; filename: string; rows: number }[] };

type Of<T extends Block["type"]> = Extract<Block, { type: T }>;

export function copyText(text: string) {
  return navigator.clipboard?.writeText(text);
}

function tsv(cols: string[], rows: (string | number)[][]) {
  return [cols, ...rows].map((r) => r.map((c) => String(c ?? "").replace(/\t|\n/g, " ")).join("\t")).join("\n");
}

@Component({
  selector: "pc-assistant-metrics",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <figure class="rounded-xl border border-line bg-white p-3">
      <figcaption class="mb-2 text-sm font-semibold">{{ b().title }}</figcaption>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
        @for (i of b().items; track i.label) {
          <div class="rounded-lg bg-mist/70 px-3 py-2">
            <p class="text-xs text-ink-faint">{{ i.label }}</p>
            <p class="font-semibold tabular-nums">{{ i.value }}</p>
            @if (i.hint) {<p [class]="i.hint.startsWith('+') ? 'text-xs text-leaf' : i.hint.startsWith('-') ? 'text-xs text-vermilion' : 'text-xs text-ink-faint'">{{ i.hint }}</p>}
          </div>
        }
      </div>
      @if (b().note) {<p class="mt-2 text-xs text-ink-faint">{{ b().note }}</p>}
    </figure>
  `,
})
export class AssistantMetrics {
  readonly b = input.required<Of<"metrics">>();
}

@Component({
  selector: "pc-assistant-table",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!b().rows.length) {
      <p class="rounded-xl border border-line bg-white p-3 text-sm text-ink-soft">{{ b().title }}: nothing found.</p>
    } @else {
      <figure class="min-w-0 rounded-xl border border-line bg-white">
        <figcaption class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <span class="text-sm font-semibold">{{ b().title }}</span>
          <span class="text-xs text-ink-faint">{{ b().total_rows && b().total_rows! > b().rows.length ? b().rows.length + " of " + b().total_rows : b().rows.length + " rows" }}</span>
          <span class="ml-auto flex items-center gap-1">
            @if (b().rows.length > 8) {<input [value]="q()" (input)="q.set($any($event.target).value)" placeholder="Filter" [attr.aria-label]="'Filter ' + b().title" class="h-7 w-28 rounded-md border border-line px-2 text-xs" />}
            <button class="rounded p-1 text-ink-faint hover:bg-mist" title="Copy table (paste into Excel)" aria-label="Copy table" (click)="copy()">
              @if (copied()) {<svg [pcIcon]="Check" class="h-4 w-4 text-leaf" />} @else {<svg [pcIcon]="ClipboardCopy" class="h-4 w-4" />}
            </button>
            @if (b().link) {<a [pcLink]="b().link!" class="rounded p-1 text-ink-faint hover:bg-mist" title="Open the page" aria-label="Open the page"><svg [pcIcon]="ExternalLink" class="h-4 w-4" /></a>}
          </span>
        </figcaption>
        <div class="max-h-80 overflow-auto">
          <table class="w-full text-xs">
            <thead class="sticky top-0 bg-mist">
              <tr>
                @for (c of b().columns; track $index; let i = $index) {
                  <th class="whitespace-nowrap px-2 py-1.5 text-left font-semibold">
                    <button (click)="sortBy(i)" class="hover:text-peacock">{{ c }}{{ sort()?.i === i ? (sort()!.dir === 1 ? " ↑" : " ↓") : "" }}</button>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (r of rows(); track $index) {
                <tr class="border-t border-line/70 odd:bg-white even:bg-mist/30">@for (c of r; track $index) {<td class="whitespace-nowrap px-2 py-1 tabular-nums">{{ str(c) }}</td>}</tr>
              }
            </tbody>
          </table>
        </div>
        @if (b().note) {<p class="border-t border-line px-3 py-1.5 text-xs text-ink-faint">{{ b().note }}</p>}
      </figure>
    }
  `,
})
export class AssistantTable {
  readonly b = input.required<Of<"table">>();
  protected readonly Check = Check; protected readonly ClipboardCopy = ClipboardCopy; protected readonly ExternalLink = ExternalLink;
  protected readonly q = signal("");
  protected readonly sort = signal<{ i: number; dir: 1 | -1 } | null>(null);
  protected readonly copied = signal(false);
  protected readonly str = String;
  protected readonly rows = computed(() => {
    let r = this.b().rows;
    const q = this.q();
    const sort = this.sort();
    if (q.trim()) r = r.filter((row) => row.some((c) => String(c).toLowerCase().includes(q.toLowerCase())));
    if (sort) {
      const num = (v: string | number) => Number(String(v).replace(/[₹,%\s]/g, ""));
      r = [...r].sort((x, y) => {
        const a = x[sort.i], c = y[sort.i];
        const na = num(a), nc = num(c);
        return (Number.isFinite(na) && Number.isFinite(nc) && String(a).trim() !== "" ? na - nc : String(a).localeCompare(String(c))) * sort.dir;
      });
    }
    return r;
  });

  protected sortBy(i: number): void {
    const s = this.sort();
    this.sort.set(s?.i === i ? { i, dir: s.dir === 1 ? -1 : 1 } : { i, dir: 1 });
  }

  protected async copy(): Promise<void> {
    await copyText(tsv(this.b().columns, this.rows()));
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}

const PALETTE = ["rgb(var(--c-primary))", "rgb(var(--c-accent))", "#5B7F2B", "#7A4E9C"];
const W = 560, H = 190, P = { l: 52, r: 8, t: 10, b: 34 };

@Component({
  selector: "pc-assistant-chart",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <figure class="rounded-xl border border-line bg-white p-3">
      <figcaption class="mb-1 text-sm font-semibold">{{ b().title }}</figcaption>
      <svg [attr.viewBox]="'0 0 ' + W + ' ' + H" class="h-auto w-full" role="img" [attr.aria-label]="b().title">
        @for (t of grid; track t) {
          <svg:g><svg:line [attr.x1]="P.l" [attr.x2]="W - P.r" [attr.y1]="y(v(t))" [attr.y2]="y(v(t))" stroke="#E3E7EA" /><svg:text [attr.x]="P.l - 6" [attr.y]="y(v(t)) + 3" text-anchor="end" font-size="10" fill="#7A8594">{{ fmt(v(t)) }}</svg:text></svg:g>
        }
        @for (s of b().series; track s.name; let si = $index) {
          @if (b().kind === "line") {
            <svg:g>
              <svg:polyline fill="none" [attr.stroke]="color(si)" stroke-width="2" [attr.points]="points(s.values)" />
              @for (val of s.values; track $index; let i = $index) {<svg:circle [attr.cx]="x(i)" [attr.cy]="y(val)" r="2.5" [attr.fill]="color(si)"><svg:title>{{ b().labels[i] }}: {{ fmt(val) }}</svg:title></svg:circle>}
            </svg:g>
          } @else {
            <svg:g>
              @for (val of s.values; track $index; let i = $index) {<svg:rect [attr.x]="barX(i, si)" [attr.width]="bw()" [attr.y]="y(max0(val))" [attr.height]="abs(y(val) - y(0))" rx="2" [attr.fill]="color(si)"><svg:title>{{ b().labels[i] }}: {{ fmt(val) }}</svg:title></svg:rect>}
            </svg:g>
          }
        }
        @for (l of b().labels; track $index; let i = $index) {
          @if (i % step() === 0) {<svg:text [attr.x]="b().kind === 'line' ? x(i) : P.l + ((i + 0.5) * (W - P.l - P.r)) / n()" [attr.y]="H - 14" text-anchor="middle" font-size="10" fill="#4A5565">{{ l.length > 12 ? l.slice(0, 11) + "…" : l }}</svg:text>}
        }
      </svg>
      @if (b().series.length > 1) {
        <p class="flex gap-3 text-xs">@for (s of b().series; track s.name; let i = $index) {<span><span class="mr-1 inline-block h-2 w-2 rounded-full" [style.background]="color(i)"></span>{{ s.name }}</span>}</p>
      }
    </figure>
  `,
})
export class AssistantChart {
  readonly b = input.required<Of<"chart">>();
  protected readonly W = W; protected readonly H = H; protected readonly P = P;
  protected readonly grid = [0, 0.5, 1];
  protected readonly abs = Math.abs;
  private readonly all = computed(() => this.b().series.flatMap((s) => s.values));
  private readonly max = computed(() => Math.max(1, ...this.all()));
  private readonly min = computed(() => Math.min(0, ...this.all()));
  protected readonly n = computed(() => this.b().labels.length);
  protected readonly step = computed(() => Math.max(1, Math.ceil(this.n() / 8)));
  protected readonly bw = computed(() => Math.max(4, ((W - P.l - P.r) / Math.max(this.n(), 1)) * 0.7 / this.b().series.length));

  protected color(i: number): string { return PALETTE[i % 4]; }
  protected v(t: number): number { return this.min() + (this.max() - this.min()) * t; }
  protected x(i: number): number { const n = this.n(); return P.l + (n <= 1 ? (W - P.l - P.r) / 2 : (i * (W - P.l - P.r)) / (n - 1)); }
  protected y(v: number): number { const max = this.max(), min = this.min(); return P.t + (H - P.t - P.b) * (1 - (v - min) / (max - min || 1)); }
  protected max0(v: number): number { return Math.max(v, 0); }
  protected fmt(v: number): string {
    return (this.b().unit === "₹" ? "₹" : "") + (v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(v % 1 ? 1 : 0));
  }
  protected points(values: number[]): string { return values.map((v, i) => `${this.x(i)},${this.y(v)}`).join(" "); }
  protected barX(i: number, si: number): number {
    const n = this.n(), bw = this.bw();
    return P.l + ((i + 0.5) * (W - P.l - P.r)) / n - (bw * this.b().series.length) / 2 + si * bw;
  }
}

@Component({
  selector: "pc-assistant-file",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-wrap items-center gap-3 rounded-xl border border-peacock/30 bg-peacock-light/40 p-3">
      <svg [pcIcon]="FileText" class="h-6 w-6 text-peacock" />
      <div class="min-w-0 flex-1">
        <p class="font-semibold">{{ b().title }} · {{ b().format.toUpperCase() }}</p>
        @if (b().detail) {<p class="truncate text-xs text-ink-soft">{{ b().detail }}</p>}
        @if (state().msg) {<p class="text-xs text-leaf">{{ state().msg }}</p>}
        @if (state().err) {<p class="text-xs text-vermilion">{{ state().err }}</p>}
      </div>
      <button class="inline-flex items-center gap-1.5 rounded-lg bg-peacock px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60" [disabled]="state().busy" (click)="download()">
        <svg [pcIcon]="state().busy ? Loader2 : Download" [class]="state().busy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'" /> Download
      </button>
    </div>
  `,
})
export class AssistantFile {
  readonly b = input.required<Of<"file">>();
  protected readonly FileText = FileText; protected readonly Loader2 = Loader2; protected readonly Download = Download;
  protected readonly state = signal<{ busy: boolean; msg?: string; err?: string }>({ busy: false });

  protected async download(): Promise<void> {
    this.state.set({ busy: true });
    try {
      this.state.set({ busy: false, msg: `Saved ${await downloadFile(this.b().path, undefined, this.b().filename)}` });
    } catch (e) {
      this.state.set({ busy: false, err: e instanceof ApiError ? e.message : "Download failed" });
    }
  }
}

@Component({
  selector: "pc-assistant-action",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div [class]="'rounded-xl border p-3 ' + tone()" role="group" [attr.aria-label]="'Proposed change: ' + b().summary">
      <p class="font-semibold">{{ b().summary }}</p>
      <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        @for (kv of b().details; track kv[0]) {<div class="contents"><dt class="text-ink-faint">{{ kv[0] }}</dt><dd class="break-words">{{ kv[1] }}</dd></div>}
      </dl>
      @if (status() === "pending") {
        <div class="mt-2 flex gap-2">
          <button (click)="decide('confirm')" [disabled]="!!busy()" class="inline-flex items-center gap-1 rounded-lg bg-peacock px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">
            <svg [pcIcon]="busy() === 'confirm' ? Loader2 : Check" [class]="busy() === 'confirm' ? 'h-4 w-4 animate-spin' : 'h-4 w-4'" /> Confirm
          </button>
          <button (click)="decide('cancel')" [disabled]="!!busy()" class="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold">
            <svg [pcIcon]="X" class="h-4 w-4" /> Cancel
          </button>
        </div>
      } @else {
        <p class="mt-2 text-sm font-semibold">{{ status() === "done" ? "Done" : status() === "cancelled" ? "Cancelled" : status() === "expired" ? "Expired — ask again" : "Not done" }}</p>
      }
      @if (err()) {<p class="mt-1 text-sm text-vermilion">{{ err() }}</p>}
    </div>
  `,
})
export class AssistantAction {
  readonly b = input.required<Of<"action">>();
  protected readonly Loader2 = Loader2; protected readonly Check = Check; protected readonly X = X;
  private readonly decided = signal<string | null>(null);
  protected readonly status = computed(() => this.decided() ?? this.b().status);
  protected readonly busy = signal<"" | "confirm" | "cancel">("");
  protected readonly err = signal("");
  protected readonly tone = computed(() => {
    const s = this.status();
    return s === "done" ? "border-leaf/40 bg-leaf-light/40" : s === "pending" ? "border-marigold/50 bg-marigold-light/50" : "border-line bg-mist/60";
  });

  protected async decide(what: "confirm" | "cancel"): Promise<void> {
    this.busy.set(what);
    this.err.set("");
    try {
      const r = await api<{ status: string }>(`/api/admin/assistant/actions/${this.b().action_id}/${what}`, { method: "POST" });
      this.decided.set(r.status);
    } catch (e) {
      this.err.set(e instanceof ApiError ? e.message : "Could not do that");
      if (e instanceof ApiError && e.status === 409) this.decided.set("failed");
    } finally {
      this.busy.set("");
    }
  }
}

@Component({
  selector: "pc-block-view",
  imports: [Icon, PcLink, Markdown, AssistantMetrics, AssistantTable, AssistantChart, AssistantFile, AssistantAction],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @switch (b().type) {
      @case ("text") {<div class="assistant-md min-w-0 text-[15px] leading-relaxed"><pc-markdown [source]="$any(b()).text" />@if (streaming()) {<span class="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-peacock align-middle" aria-hidden="true"></span>}</div>}
      @case ("metrics") {<pc-assistant-metrics [b]="$any(b())" />}
      @case ("table") {<pc-assistant-table [b]="$any(b())" />}
      @case ("chart") {<pc-assistant-chart [b]="$any(b())" />}
      @case ("file") {<pc-assistant-file [b]="$any(b())" />}
      @case ("links") {<div class="flex flex-wrap gap-2">@for (l of $any(b()).items; track l.href) {<a [pcLink]="l.href" class="inline-flex items-center gap-1 rounded-full border border-line bg-white px-3 py-1 text-sm hover:border-peacock">{{ l.label }}<svg [pcIcon]="ExternalLink" class="h-3 w-3" /></a>}</div>}
      @case ("action") {<pc-assistant-action [b]="$any(b())" />}
      @case ("error") {<p class="flex items-start gap-2 rounded-lg bg-vermilion-light p-3 text-sm text-vermilion"><svg [pcIcon]="AlertTriangle" class="mt-0.5 h-4 w-4 shrink-0" />{{ $any(b()).text }}</p>}
      @case ("files") {<div class="flex flex-wrap justify-end gap-1">@for (f of $any(b()).items; track f.id) {<span class="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-xs"><svg [pcIcon]="FileText" class="h-3 w-3" />{{ f.filename }} · {{ f.rows }} rows</span>}</div>}
    }
  `,
})
export class BlockView {
  readonly b = input.required<Block>();
  readonly streaming = input(false);
  protected readonly ExternalLink = ExternalLink; protected readonly AlertTriangle = AlertTriangle; protected readonly FileText = FileText;
}
