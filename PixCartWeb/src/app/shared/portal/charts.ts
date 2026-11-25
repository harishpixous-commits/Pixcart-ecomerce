/*
 * Small charts for the seller hub and the admin panel. Port of components/charts.tsx (same markup and classes):
 *   <pc-daily-bars [series]="rows" valueKey="gmv" [money]="true" [height]="160" />   daily bars with a hover readout
 *   <ul pcHBar [items]="[{ label, value, display }]"></ul>                              horizontal bars
 *   <pc-delta [now]="12" [before]="10" />                                             "▲ 20% vs previous period"
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { date, rupees } from "../../core/format";

export type SeriesRow = { date: string; [k: string]: number | string };

/** Daily bars with a hover readout; values in paise or counts. */
@Component({
  selector: "pc-daily-bars",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <p class="mb-1 h-5 text-sm text-ink-soft" aria-live="polite">{{ readout() }}</p>
    <div class="flex items-end gap-[2px]" [style.height.px]="height()" role="img" [attr.aria-label]="'Daily ' + valueKey()" (mouseleave)="hover.set(null)">
      @for (v of values(); track $index; let i = $index) {
        <div class="flex h-full flex-1 items-end" (mouseenter)="hover.set(i)">
          <div [class]="hover() === i ? 'w-full rounded-t bg-peacock' : 'w-full rounded-t bg-peacock/70'" [style.height.%]="barHeight(v)"></div>
        </div>
      }
    </div>
    <div class="mt-1 flex justify-between text-xs text-ink-faint">
      <span>{{ first() }}</span>
      <span>{{ last() }}</span>
    </div>
  `,
})
export class DailyBars {
  readonly series = input.required<SeriesRow[]>();
  readonly valueKey = input.required<string>();
  readonly money = input(false);
  readonly height = input(160);
  protected readonly hover = signal<number | null>(null);
  protected readonly values = computed(() => this.series().map((d) => Number(d[this.valueKey()]) || 0));
  private readonly peak = computed(() => Math.max(0, ...this.values()));
  private readonly max = computed(() => Math.max(1, this.peak()));
  private fmt(v: number): string {
    return this.money() ? rupees(v) : v.toLocaleString("en-IN");
  }
  protected readonly readout = computed(() => {
    const i = this.hover();
    const h = i !== null ? this.series()[i] : null;
    return h ? `${date(String(h.date))}: ${this.fmt(Number(h[this.valueKey()]))}` : this.peak() ? `Highest day ${this.fmt(this.peak())}` : "Nothing in this period yet";
  });
  protected readonly first = computed(() => {
    const s = this.series();
    return s[0] ? date(String(s[0].date)) : "";
  });
  protected readonly last = computed(() => {
    const s = this.series();
    return s.length > 0 ? date(String(s[s.length - 1].date)) : "";
  });
  protected barHeight(v: number): number {
    return Math.max(v ? 3 : 1, (v / this.max()) * 100);
  }
}

@Component({
  selector: "ul[pcHBar]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-2" },
  template: `
    @for (i of items(); track i.label) {
      <li class="text-sm">
        <div class="mb-0.5 flex justify-between gap-2"><span class="truncate">{{ i.label }}</span><span class="font-semibold">{{ i.display }}</span></div>
        <div class="h-2 overflow-hidden rounded-full bg-mist"><div class="h-full rounded-full bg-peacock" [style.width.%]="(i.value / max()) * 100"></div></div>
      </li>
    }
  `,
})
export class HBar {
  readonly items = input.required<{ label: string; value: number; display: string }[]>();
  protected readonly max = computed(() => Math.max(1, ...this.items().map((i) => i.value)));
}

@Component({
  selector: "pc-delta",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (before()) {<span [class]="pct() >= 0 ? 'text-sm font-semibold text-leaf' : 'text-sm font-semibold text-vermilion'">{{ pct() >= 0 ? "▲" : "▼" }} {{ abs() }}% vs previous period</span>}`,
})
export class Delta {
  readonly now = input.required<number>();
  readonly before = input.required<number>();
  protected readonly pct = computed(() => Math.round(((this.now() - this.before()) * 100) / this.before()));
  protected readonly abs = computed(() => Math.abs(this.pct()));
}
