/*
 * A small column chart for in-app dashboards (partner earnings, delivery reports). One baseline, columns at most 24px
 * wide with a 4px rounded top, stacked parts separated by a 2px surface gap, hairline gridlines. Every column is a
 * focusable hit target with a tooltip (hover or keyboard) that lists every series; the tallest column carries its
 * value; a legend shows from two series up; "Show as table" gives every number without hovering.
 * Port of components/charts/columns.tsx (same as delivery/components/columns.ts on the delivery pages branch; keep one after merging):
 *   <figure pcColumnChart [data] [series] [format] [height]="150" [labelEvery]="1" caption="..."></figure>
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { cx } from "../../shared/ui/cx";
import { uid } from "../../shared/ui/ui";

export const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"] as const;

export type ColumnSeries = { key: string; label: string; color?: string };
export type ColumnDatum = { key: string; label: string; title: string; values: Record<string, number>; highlight?: boolean };

/** Rounds the axis top up to a clean, even number (2, 4, 6, 8, 10 × 10^n), so the middle gridline is a whole value. */
function niceMax(v: number): number {
  if (v <= 0) return 2;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * exp >= v) return m * exp === 1 ? 2 : m * exp;
  return 10 * exp;
}

@Component({
  selector: "figure[pcColumnChart]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cx('flex flex-col gap-2', className())", "[attr.aria-labelledby]": "id + '-cap'" },
  template: `
    <figcaption [id]="id + '-cap'" class="sr-only">{{ caption() }}</figcaption>
    @if (series().length > 1) {
      <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft" aria-label="Legend">
        @for (s of series(); track s.key; let i = $index) {
          <li class="inline-flex items-center gap-1.5">
            <span class="h-2.5 w-2.5 rounded-[3px]" [style.background]="colors()[i]" aria-hidden="true"></span>
            {{ s.label }}
          </li>
        }
      </ul>
    }
    <div class="flex gap-2">
      <!-- y axis -->
      <div class="relative w-12 shrink-0 text-right text-[11px] tabular-nums text-ink-faint" [style.height.px]="height()" aria-hidden="true">
        @for (t of ticks(); track $index; let i = $index) {
          <span class="absolute right-0 -translate-y-1/2" [style.top]="(i / (ticks().length - 1)) * 100 + '%'">{{ format()(t) }}</span>
        }
      </div>
      <div class="relative min-w-0 flex-1">
        <!-- gridlines -->
        <div class="pointer-events-none absolute inset-x-0 top-0" [style.height.px]="height()" aria-hidden="true">
          @for (t of ticks(); track $index; let i = $index) {
            <span [class]="i === ticks().length - 1 ? 'absolute inset-x-0 h-px bg-[#c3c2b7]' : 'absolute inset-x-0 h-px bg-[#e1e0d9]'" [style.top]="(i / (ticks().length - 1)) * 100 + '%'"></span>
          }
        </div>
        <ol class="relative flex items-end" [style.height.px]="height()" (mouseleave)="active.set(null)">
          @for (c of cols(); track c.d.key; let i = $index) {
            <li class="relative flex h-full min-w-0 flex-1 justify-center">
              <button type="button" class="group relative flex h-full w-full items-end justify-center outline-none" [attr.aria-label]="c.aria"
                (mouseenter)="active.set(i)" (focus)="active.set(i)" (blur)="active.set(null)">
                <span [class]="barCls(i)" [style.height.px]="c.barH">
                  @for (p of c.parts; track p.key) {
                    <span [class]="p.top ? 'w-full rounded-t' : 'w-full'" [style.flex-grow]="p.v" style="flex-basis: 0px; min-height: 2px" [style.background]="p.color"></span>
                  }
                </span>
                @if (i === peak() && !empty() && active() === null) {
                  <span class="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] font-semibold text-ink" [style.bottom.px]="c.h + 4">{{ format()(c.total) }}</span>
                }
              </button>
              @if (active() === i) {
                <div role="tooltip" class="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs text-white shadow-lg"
                  [style.bottom.px]="tipBottom(c.h)" style="left: 50%">
                  <p class="mb-0.5 text-[11px] text-white/70">{{ c.d.title }}</p>
                  @for (s of series(); track s.key; let k = $index) {
                    <p class="flex items-center gap-1.5">
                      <span class="h-0.5 w-3 rounded-full" [style.background]="colors()[k]" aria-hidden="true"></span>
                      <b class="tabular-nums">{{ format()(c.d.values[s.key] ?? 0) }}</b>
                      @if (series().length > 1) {<span class="text-white/70">{{ s.label }}</span>}
                    </p>
                  }
                </div>
              }
            </li>
          }
        </ol>
        <!-- labels sit centred under their column and may spill into the empty neighbours (long ranges label every n-th day) -->
        <ol class="relative mt-1.5 flex h-4" aria-hidden="true">
          @for (c of cols(); track c.d.key) {
            <li class="relative min-w-0 flex-1">
              @if (c.showLabel) {
                <span [class]="c.d.highlight ? 'absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold text-ink' : 'absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap text-[11px] text-ink-faint'">{{ c.d.label }}</span>
              }
            </li>
          }
        </ol>
      </div>
    </div>
    <details class="text-sm">
      <summary class="cursor-pointer text-xs font-semibold text-peacock">Show as table</summary>
      <div class="mt-2 max-h-64 overflow-auto rounded-lg ring-1 ring-line">
        <table class="w-full text-left text-xs">
          <caption class="sr-only">{{ caption() }}</caption>
          <thead class="bg-mist text-ink-soft">
            <tr><th class="px-2 py-1.5 font-semibold">Day</th>@for (s of series(); track s.key) {<th class="px-2 py-1.5 text-right font-semibold">{{ s.label }}</th>}</tr>
          </thead>
          <tbody class="divide-y divide-line">
            @for (d of data(); track d.key) {
              <tr><td class="px-2 py-1">{{ d.title }}</td>@for (s of series(); track s.key) {<td class="px-2 py-1 text-right tabular-nums">{{ format()(d.values[s.key] ?? 0) }}</td>}</tr>
            }
          </tbody>
        </table>
      </div>
    </details>
  `,
})
export class ColumnChart {
  readonly data = input.required<ColumnDatum[]>();
  readonly series = input.required<ColumnSeries[]>();
  readonly format = input.required<(n: number) => string>();
  /** plot height in px */
  readonly height = input(168);
  /** show every n-th x label (long ranges) */
  readonly labelEvery = input(1);
  /** what the chart shows, for screen readers and the table */
  readonly caption = input.required<string>();
  readonly className = input<string | undefined>(undefined);

  protected readonly cx = cx;
  protected readonly id = uid("chart");
  protected readonly active = signal<number | null>(null);
  protected readonly colors = computed(() => {
    const series = this.series();
    return series.map((s, i) => s.color ?? (series.length === 1 ? "rgb(var(--c-primary))" : SERIES_COLORS[i % SERIES_COLORS.length]));
  });
  private readonly totals = computed(() => this.data().map((d) => this.series().reduce((n, s) => n + Math.max(0, d.values[s.key] ?? 0), 0)));
  private readonly top = computed(() => niceMax(Math.max(0, ...this.totals())));
  protected readonly ticks = computed(() => [this.top(), this.top() / 2, 0]);
  protected readonly peak = computed(() => this.totals().indexOf(Math.max(...this.totals())));
  protected readonly empty = computed(() => this.totals().every((t) => t === 0));
  protected readonly cols = computed(() => {
    const data = this.data();
    const series = this.series();
    const colors = this.colors();
    const totals = this.totals();
    const top = this.top();
    const height = this.height();
    const format = this.format();
    const labelEvery = this.labelEvery();
    const hi = data.findIndex((d) => d.highlight); // the highlighted day always gets its label; close neighbours give way
    return data.map((d, i) => {
      const total = totals[i];
      const h = (total / top) * height;
      const parts = series
        .map((s, k) => ({ key: s.key, v: Math.max(0, d.values[s.key] ?? 0), color: colors[k], top: series.slice(k + 1).every((x) => !(d.values[x.key] ?? 0)) }))
        .filter((p) => p.v);
      return {
        d,
        total,
        h,
        barH: Math.max(total > 0 ? 3 : 0, h),
        parts,
        aria: `${d.title}: ${series.map((s) => `${s.label} ${format(d.values[s.key] ?? 0)}`).join(", ")}`,
        showLabel: !!d.highlight || (i % labelEvery === 0 && (hi < 0 || labelEvery === 1 || Math.abs(hi - i) >= Math.ceil(labelEvery / 2))),
      };
    });
  });

  protected barCls(i: number): string {
    const a = this.active();
    return cx("flex w-full max-w-[24px] flex-col-reverse gap-[2px] transition-opacity", a !== null && a !== i && "opacity-60",
      "group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-peacock");
  }

  protected tipBottom(h: number): number {
    return Math.min(h, this.height() - 8) + 10;
  }
}
