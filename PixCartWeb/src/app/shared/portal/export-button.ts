/*
 * "Export" on a list page: downloads the matching file (Excel, CSV or PDF) with the list's current status filter.
 * Admin pages also get "Ask AI", which opens the assistant with this list as context. Port of components/export-button.tsx:
 *   <pc-export-button scope="seller" name="orders" [status]="status" [dated]="true" />
 */

import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, signal } from "@angular/core";
import { Download, Sparkles } from "lucide-angular";
import { ApiError, downloadFile } from "../../core/api";
import { openAssistant } from "../../core/assistant-bus";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";
import { Button, ErrorNote, Select } from "../ui/ui";

const PERIODS = [["1", "Today"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last 12 months"]] as const;
const FORMATS = [["xlsx", "Excel"], ["csv", "CSV"], ["pdf", "PDF"]] as const;

@Component({
  selector: "pc-export-button",
  imports: [Button, ErrorNote, Select, Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "relative flex gap-2" },
  template: `
    @if (scope() === "admin") {
      <button pcButton variant="secondary" [attr.aria-label]="'Ask AI about ' + what()" title="Ask AI about this list or compare a file" (click)="ask()">
        <svg [pcIcon]="Sparkles" class="h-4 w-4" /><span class="hidden sm:inline">Ask AI</span>
      </button>
    }
    <button pcButton variant="secondary" (click)="open.set(!open())" [attr.aria-expanded]="open()">
      <svg [pcIcon]="Download" class="h-4 w-4" /> Export
    </button>
    @if (open()) {
      <div class="absolute right-0 top-12 z-20 flex w-72 flex-col gap-2 rounded-xl border border-line bg-white p-3 shadow-lg" role="dialog" aria-label="Export">
        @if (dated()) {
          <label class="text-sm font-medium" [attr.for]="'exp-' + name()">Period</label>
          <select pcSelect [id]="'exp-' + name()" (change)="days.set($any($event.target).value)">
            @for (p of periods; track p[0]) {<option [value]="p[0]" [selected]="p[0] === days()">{{ p[1] }}</option>}
          </select>
        }
        <div role="radiogroup" aria-label="File format" class="flex rounded-lg bg-mist p-0.5">
          @for (f of formats; track f[0]) {
            <button role="radio" [attr.aria-checked]="fmt() === f[0]" (click)="fmt.set(f[0])"
              [class]="fmt() === f[0] ? 'flex-1 rounded-md px-2 py-1.5 text-sm font-semibold bg-white text-peacock shadow-sm' : 'flex-1 rounded-md px-2 py-1.5 text-sm font-semibold text-ink-soft'">{{ f[1] }}</button>
          }
        </div>
        @if (status()) {<p class="text-xs text-ink-faint">Only the rows in the current tab.</p>}
        <pc-error-note [message]="error()" />
        <button pcButton (click)="go()" [loading]="busy()"><svg [pcIcon]="Download" class="h-4 w-4" /> Download {{ fmtLabel() }}</button>
        <a [pcLink]="'/' + scope() + '/exports'" class="text-center text-sm font-semibold text-peacock">More options and bulk download</a>
      </div>
    }
  `,
})
export class ExportButton {
  readonly scope = input.required<"admin" | "seller">();
  readonly name = input.required<string>();
  readonly status = input<string | undefined>(undefined);
  readonly dated = input(true);
  readonly label = input<string | undefined>(undefined);
  protected readonly Download = Download;
  protected readonly Sparkles = Sparkles;
  protected readonly periods = PERIODS;
  protected readonly formats = FORMATS;
  protected readonly open = signal(false);
  protected readonly days = signal("30");
  protected readonly fmt = signal<string>("xlsx");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly what = computed(() => this.label() ?? this.name().replace("-", " "));
  protected readonly fmtLabel = computed(() => FORMATS.find(([v]) => v === this.fmt())?.[1]);

  constructor() {
    const box = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const close = (e: MouseEvent) => { if (!box.contains(e.target as Node)) this.open.set(false); };
    effect((onCleanup) => {
      if (!this.open()) return;
      document.addEventListener("mousedown", close);
      onCleanup(() => document.removeEventListener("mousedown", close));
    });
    inject(DestroyRef).onDestroy(() => document.removeEventListener("mousedown", close));
  }

  protected ask(): void {
    const what = this.what();
    const status = this.status();
    openAssistant({ context: { path: window.location.pathname, title: what, filters: status ? `status=${status}` : "" },
      prompt: `Give me a quick summary of ${what}${status ? ` (${status})` : ""} for the last 30 days.`, attach: true });
  }

  protected async go(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const from = this.dated() ? new Date(Date.now() - (Number(this.days()) - 1) * 86400000 + 19800000).toISOString().slice(0, 10) : undefined;
      const fmt = this.fmt();
      await downloadFile(`/api/${this.scope()}/exports/${this.name()}.${fmt}`, { from, status: this.status() || undefined }, `${this.name()}.${fmt}`);
      this.open.set(false);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Export failed");
    } finally {
      this.busy.set(false);
    }
  }
}
