/*
 * The bill shown in the cart, at checkout and on the order page: item total (with M.R.P. struck through), delivery,
 * cash on delivery, the marketplace's own fees (each with a tap-to-read explanation and the GST inside it, a
 * struck-through regular amount when the fee is discounted), the delivery partner tip, the coupon and the amount to pay.
 * Every number comes from the server; this component only lays them out. Port of components/bill.tsx:
 *   <pc-bill-details [bill]="b" deliveryLabel="Delivery fee" deliveryInfo="..." [hints]="[]" totalLabel="To pay" />
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { BadgePercent, ChevronDown, Truck } from "lucide-angular";
import { rupees } from "../../core/format";
import type { FeeLine } from "../../core/types";
import { Icon } from "../ui/icon";
import { uid } from "../ui/ui";

export type BillData = {
  mrp_total?: number;
  items_total: number;
  item_count?: number;
  shipping_total: number;
  cod_fee?: number;
  fees?: FeeLine[];
  fee_savings?: number;
  tip?: number;
  coupon_code?: string | null;
  coupon_discount?: number;
  grand_total: number;
};

@Component({
  selector: "pc-bill-details",
  imports: [Icon, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3", "aria-label": "Bill details", "data-testid": "bill", role: "region" },
  template: `
    <ng-template #amount let-value="value" let-was="was" let-free="free">
      <dd class="whitespace-nowrap text-right tabular-nums">@if (was && was > value) {<span class="mr-1.5 text-sm text-ink-faint line-through">{{ fmt(was) }}</span>}@if (free) {<span class="font-semibold text-leaf">FREE</span>} @else {{{ fmt(value) }}}</dd>
    </ng-template>
    <ng-template #explained let-key="key" let-label="label" let-info="info" let-gst="gst" let-gstBps="gstBps">
      @if (!info && !gst) {
        <dt>{{ label }}</dt>
      } @else {
        <dt>
          <button type="button" [attr.aria-expanded]="isOpen(key)" [attr.aria-controls]="id + '-' + key" (click)="toggle(key)"
            class="inline-flex items-center gap-1 border-b border-dashed border-ink-faint text-left leading-snug hover:border-peacock hover:text-peacock">
            {{ label }}<svg [pcIcon]="ChevronDown" [class]="isOpen(key) ? 'h-3.5 w-3.5 text-ink-faint transition-transform rotate-180' : 'h-3.5 w-3.5 text-ink-faint transition-transform'" />
          </button>
          @if (isOpen(key)) {
            <span [id]="id + '-' + key" class="mt-1 block rounded-lg bg-mist px-2.5 py-1.5 text-xs font-normal leading-relaxed text-ink-soft">
              {{ info }}@if (gst) {<span class="block">Includes GST of {{ fmt(gst) }}{{ gstBps ? " (" + gstBps / 100 + "%)" : "" }}.</span>}
            </span>
          }
        </dt>
      }
    </ng-template>
    <h2 class="text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Bill details</h2>
    <dl class="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2.5 text-[15px]">
      <dt>Item total@if (b().item_count) {<span class="text-ink-faint"> ({{ b().item_count }} item{{ b().item_count === 1 ? "" : "s" }})</span>}</dt>
      <ng-container *ngTemplateOutlet="amount; context: { value: b().items_total, was: b().mrp_total }" />
      <ng-container *ngTemplateOutlet="explained; context: { key: 'delivery', label: deliveryLabel(), info: deliveryInfo() }" />
      <ng-container *ngTemplateOutlet="amount; context: { value: b().shipping_total, free: b().shipping_total === 0 }" />
      @if (b().cod_fee) {
        <dt>Cash on delivery fee</dt>
        <ng-container *ngTemplateOutlet="amount; context: { value: b().cod_fee }" />
      }
      @for (f of b().fees ?? []; track f.code) {
        <div class="contents" [attr.data-testid]="'fee-' + f.code">
          <ng-container *ngTemplateOutlet="explained; context: { key: 'fee-' + f.code, label: f.label, info: f.info, gst: f.gst, gstBps: f.gst_bps }" />
          <ng-container *ngTemplateOutlet="amount; context: { value: f.amount, was: f.list_amount }" />
          @if (f.hint) {<p class="col-span-2 -mt-1.5 text-xs text-ink-faint">{{ f.hint }}</p>}
        </div>
      }
      @if (b().tip) {
        <dt>Delivery partner tip</dt>
        <ng-container *ngTemplateOutlet="amount; context: { value: b().tip }" />
      }
      @if (b().coupon_discount) {
        <dt class="text-leaf">Coupon{{ b().coupon_code ? " " + b().coupon_code : "" }}</dt>
        <dd class="text-right font-semibold tabular-nums text-leaf">−{{ fmt(b().coupon_discount!) }}</dd>
      }
      <dt class="mt-1 border-t border-dashed border-line pt-3 font-display text-lg font-bold">{{ totalLabel() }}</dt>
      <dd class="mt-1 border-t border-dashed border-line pt-3 text-right font-display text-lg font-bold tabular-nums" data-testid="bill-total">{{ fmt(b().grand_total) }}</dd>
    </dl>
    @if (savings() > 0) {
      <p class="flex items-center gap-2 rounded-xl bg-leaf-light px-3 py-2 text-sm font-semibold text-leaf" data-testid="bill-savings">
        <svg [pcIcon]="BadgePercent" class="h-4 w-4 shrink-0" /> You save {{ fmt(savings()) }} on this order
      </p>
    }
    @if (hints().length > 0) {
      <ul class="flex flex-col gap-1.5" data-testid="bill-hints">
        @for (h of hints(); track h) {
          <li class="flex items-start gap-2 rounded-xl bg-marigold-light/70 px-3 py-2 text-sm text-ink">
            <svg [pcIcon]="Truck" class="mt-0.5 h-4 w-4 shrink-0 text-marigold-dark" /> {{ h }}
          </li>
        }
      </ul>
    }
  `,
})
export class BillDetails {
  readonly b = input.required<BillData>({ alias: "bill" });
  readonly deliveryLabel = input<string | undefined, string | undefined>("Delivery fee", { transform: (v) => v ?? "Delivery fee" });
  readonly deliveryInfo = input<string | undefined, string | undefined>("", { transform: (v) => v ?? "" });
  readonly hints = input<string[]>([]);
  readonly totalLabel = input("To pay");
  protected readonly id = uid("bill");
  protected readonly fmt = rupees;
  protected readonly BadgePercent = BadgePercent;
  protected readonly ChevronDown = ChevronDown;
  protected readonly Truck = Truck;
  private readonly open = signal<Set<string>>(new Set());
  protected readonly savings = computed(() => {
    const b = this.b();
    const mrpSaving = Math.max(0, (b.mrp_total ?? b.items_total) - b.items_total);
    return mrpSaving + (b.fee_savings ?? 0) + (b.coupon_discount ?? 0);
  });

  protected isOpen(key: string): boolean {
    return this.open().has(key);
  }

  protected toggle(key: string): void {
    this.open.update((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }
}
