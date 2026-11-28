/*
 * Admin → Checkout and fees: every charge a shopper sees on the bill (delivery, cash on delivery, the marketplace's
 * handling, small cart and platform fees, the delivery partner tip) and the extra choices at checkout, with a live
 * preview. The server works out the preview from the values on the screen, saved or not; this page only turns rupees
 * into paise and lays the answer out. Port of frontend/src/app/admin/checkout/page.tsx.
 */

import { ChangeDetectionStrategy, Component, ElementRef, booleanAttribute, computed, effect, inject, input, output, signal } from "@angular/core";
import {
  Banknote, Building2, CircleCheck, CircleSlash, Clock3, CloudRain, HandCoins, ListChecks, Loader2, MoonStar, PackageCheck, Percent, Plus, Receipt, ShoppingBasket, Truck, X,
  type LucideIconData,
} from "lucide-angular";
import { AdminContext } from "../../core/admin";
import { api, ApiError, latestOnly } from "../../core/api";
import { paiseToInput, rupees, toPaise } from "../../core/format";
import type { FeeLine } from "../../core/types";
import { BillDetails } from "../../shared/commerce/bill";
import { PageHeader } from "../../shared/portal-shell";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Input, Pill, Select, TextField, Textarea, Toast, uid } from "../../shared/ui/ui";

type Marketplace = {
  shipping_fee_paise: number; free_shipping_threshold_paise: number; cod_enabled: boolean; cod_fee_paise: number; cod_max_order_paise: number;
};
type Fees = {
  delivery_label: string; delivery_info: string;
  handling_enabled: boolean; handling_paise: number; handling_list_paise: number; handling_free_above_paise: number; handling_label: string; handling_info: string;
  small_cart_enabled: boolean; small_cart_paise: number; small_cart_below_paise: number; small_cart_label: string; small_cart_info: string;
  platform_enabled: boolean; platform_paise: number; platform_label: string; platform_info: string;
  surge_enabled: boolean; surge_paise: number; surge_until: string; surge_label: string; surge_info: string;
  late_night_enabled: boolean; late_night_paise: number; late_night_from: string; late_night_to: string; late_night_label: string; late_night_info: string;
  fees_gst_bps: number; fees_refund_on_cancel: boolean; fees_sac_code: string; fee_invoice_prefix: string;
  tip_enabled: boolean; tip_presets: number[]; tip_max_paise: number;
  gstin_enabled: boolean; instructions_enabled: boolean; no_bag_enabled: boolean; gift_message_enabled: boolean; gift_message_max: number; cancellation_note: string;
};
/** Whether the time-bound fees are being charged at this moment (worked out by the server's clock). */
type FeeStatus = { surge_active: boolean; surge_until: string | null; surge_ended: boolean; late_night_active: boolean; night_window_now: boolean };
type Settings = { marketplace: Marketplace; fees: Fees; status?: FeeStatus };
type Body = { marketplace: Marketplace; fees: Partial<Fees> & { surge_hours?: number } };
type Preview = { items_total: number; shipping: number; cod_fee: number; fees: FeeLine[]; total: number; hints: string[] };

const MARKET_MONEY = ["shipping_fee_paise", "free_shipping_threshold_paise", "cod_fee_paise", "cod_max_order_paise"] as const;
const FEE_MONEY = ["handling_paise", "handling_list_paise", "handling_free_above_paise", "small_cart_paise", "small_cart_below_paise", "platform_paise",
  "surge_paise", "late_night_paise", "tip_max_paise"] as const;
const MONEY = [...MARKET_MONEY, ...FEE_MONEY];
const FEE_FLAGS = ["handling_enabled", "small_cart_enabled", "platform_enabled", "surge_enabled", "late_night_enabled", "fees_refund_on_cancel", "tip_enabled",
  "gstin_enabled", "instructions_enabled", "no_bag_enabled", "gift_message_enabled"] as const;
const FEE_TEXTS = ["delivery_label", "delivery_info", "handling_label", "handling_info", "small_cart_label", "small_cart_info", "platform_label", "platform_info",
  "surge_label", "surge_info", "late_night_label", "late_night_info", "cancellation_note", "fees_sac_code", "fee_invoice_prefix"] as const;
const LABELS = ["delivery_label", "handling_label", "small_cart_label", "platform_label", "surge_label", "late_night_label"] as const;
const TIMES = ["late_night_from", "late_night_to"] as const;
/** How long the bad weather fee runs once saved ("" keeps what is saved; "0" until switched off). */
const SURGE_HOURS = ["1", "2", "3", "4", "6", "8", "12", "24"] as const;

type MoneyKey = (typeof MONEY)[number];
type FlagKey = "cod_enabled" | (typeof FEE_FLAGS)[number];
type TextKey = (typeof FEE_TEXTS)[number];
type LabelKey = (typeof LABELS)[number];
type TimeKey = (typeof TIMES)[number];
type IssueKey = MoneyKey | LabelKey | TimeKey | "gst" | "gift_max" | "surge_for" | "fees_sac_code" | "fee_invoice_prefix";

/** The form as typed: amounts (rupees) and the GST rate (percent) stay text until they are sent. */
type Draft = {
  money: Record<MoneyKey, string>; flags: Record<FlagKey, boolean>; text: Record<TextKey, string>; times: Record<TimeKey, string>;
  gst: string; giftMax: string; tips: number[]; surgeFor: string;
};

/** What this page calls each amount, to put the server's messages (setting keys, paise) in plain words. */
const NAMES: Record<MoneyKey | "fees_gst_bps", string> = {
  shipping_fee_paise: "Delivery fee",
  free_shipping_threshold_paise: "Free delivery amount",
  cod_fee_paise: "Cash on delivery fee",
  cod_max_order_paise: "Highest cash on delivery order",
  handling_paise: "Handling fee",
  handling_list_paise: "Regular handling fee",
  handling_free_above_paise: "Free handling amount",
  small_cart_paise: "Small cart fee",
  small_cart_below_paise: "Small cart limit",
  platform_paise: "Platform fee",
  surge_paise: "Bad weather fee",
  late_night_paise: "Late night fee",
  tip_max_paise: "Largest tip",
  fees_gst_bps: "GST in the fees",
};

function pick<K extends string, V>(keys: readonly K[], value: (k: K) => V): Record<K, V> {
  return Object.fromEntries(keys.map((k) => [k, value(k)])) as Record<K, V>;
}

/** "18" or "12.5" (percent) → basis points; null unless 0 to 28 with at most 2 decimals. */
function toBps(text: string): number | null {
  const clean = text.replace(/[%\s]/g, "");
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(clean)) return null;
  const bps = Math.round(parseFloat(clean) * 100);
  return bps <= 2800 ? bps : null;
}

function toDraft({ marketplace: m, fees: f }: Settings): Draft {
  return {
    money: { ...pick(MARKET_MONEY, (k) => paiseToInput(m[k])), ...pick(FEE_MONEY, (k) => paiseToInput(f[k])) },
    flags: { cod_enabled: m.cod_enabled, ...pick(FEE_FLAGS, (k) => f[k]) },
    text: pick(FEE_TEXTS, (k) => f[k]),
    times: pick(TIMES, (k) => f[k]),
    gst: String(f.fees_gst_bps / 100),
    giftMax: String(f.gift_message_max ?? 150),
    tips: [...f.tip_presets].sort((a, b) => a - b),
    surgeFor: "",
  };
}

/** Both groups with amounts in paise, as the server takes them; null while an amount or the GST rate cannot be read. */
function toBody(d: Draft): Body | null {
  const paise = pick(MONEY, (k) => toPaise(d.money[k]));
  const bps = toBps(d.gst);
  if (bps === null || MONEY.some((k) => paise[k] === null)) return null;
  const p = (k: MoneyKey) => paise[k] ?? 0;
  return {
    marketplace: { ...pick(MARKET_MONEY, p), cod_enabled: d.flags.cod_enabled },
    fees: {
      ...d.text, ...d.times, ...pick(FEE_FLAGS, (k) => d.flags[k]), ...pick(FEE_MONEY, p), fees_gst_bps: bps, gift_message_max: Number(d.giftMax), tip_presets: d.tips,
      ...(d.surgeFor !== "" && d.flags.surge_enabled ? { surge_hours: Number(d.surgeFor) } : {}),
    },
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What must be fixed before saving, by field: the server's own rules, so mistakes show while typing. */
function findIssues(d: Draft, surgeEnded: boolean): Partial<Record<IssueKey, string>> {
  const out: Partial<Record<IssueKey, string>> = {};
  for (const k of MONEY) if (toPaise(d.money[k]) === null) out[k] = "Enter rupees, like 40 or 12.50";
  const fee = toPaise(d.money.handling_paise);
  const list = toPaise(d.money.handling_list_paise);
  if (fee !== null && list !== null && list > 0 && list <= fee) out.handling_list_paise = "Make it higher than the fee charged, or 0 to show none";
  if (toBps(d.gst) === null) out.gst = "Enter 0 to 28";
  if (!/^\d{2,3}$/.test(d.giftMax.trim()) || Number(d.giftMax) < 20 || Number(d.giftMax) > 300) out.gift_max = "Enter 20 to 300";
  for (const k of LABELS) if (d.text[k].trim().length < 2) out[k] = "Use 2 to 40 characters";
  for (const k of TIMES) if (!HHMM.test(d.times[k])) out[k] = "Pick a time";
  if (!out.late_night_to && d.times.late_night_from === d.times.late_night_to) out.late_night_to = "Make it different from the start time";
  if (d.flags.surge_enabled && surgeEnded && d.surgeFor === "") out.surge_for = "The last period ended. Choose how long to charge it now.";
  if (!/^\d{4,8}$/.test(d.text.fees_sac_code.trim())) out.fees_sac_code = "4 to 8 digits, like 998599";
  if (!/^[A-Z0-9]{2,4}$/.test(d.text.fee_invoice_prefix.trim().toUpperCase())) out.fee_invoice_prefix = "2 to 4 letters or digits, like MKT";
  return out;
}

/** "18:30" from the server's ISO time, in India time, with the day when it is not today. */
function untilLabel(iso: string): string {
  const t = new Date(iso);
  const opts = { timeZone: "Asia/Kolkata" } as const;
  const time = t.toLocaleTimeString("en-IN", { ...opts, hour: "numeric", minute: "2-digit" });
  const day = t.toLocaleDateString("en-IN", { ...opts, day: "numeric", month: "short" });
  const today = new Date().toLocaleDateString("en-IN", { ...opts, day: "numeric", month: "short" });
  return day === today ? time : `${time}, ${day}`;
}

/** "23:00" → "11 pm". */
function clock(hhmm: string): string {
  if (!HHMM.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/** The server names a setting by its key and gives limits in paise; say it the way this page does. */
function readable(message: string): string {
  const m = /^(\w+) must be a whole number between (\d+) and (\d+)$/.exec(message);
  const name = m ? NAMES[m[1] as keyof typeof NAMES] : undefined;
  if (!m || !name) return message;
  const lo = Number(m[2]);
  const hi = Number(m[3]);
  return m[1] === "fees_gst_bps" ? `${name}: enter ${lo / 100} to ${hi / 100}%` : `${name}: enter an amount from ${rupees(lo)} to ${rupees(hi)}`;
}

/* ---------------------------------------------------------------- page pieces */

@Component({
  selector: "section[pcFeeSection]",
  imports: [Icon, Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "grid gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:grid-cols-2 sm:p-5" },
  template: `
    <div class="flex items-start gap-3 sm:col-span-2">
      <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-peacock-light text-peacock" aria-hidden="true"><svg [pcIcon]="icon()" class="h-5 w-5" /></span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 class="text-lg font-semibold">{{ title() }}</h2>
          @if (on() !== undefined) {<pc-pill [tone]="on() ? 'green' : 'gray'">{{ on() ? "On" : "Off" }}</pc-pill>}
        </div>
        <p class="text-sm text-ink-soft">{{ sub() }}</p>
      </div>
    </div>
    <ng-content />
  `,
})
export class FeeSection {
  readonly icon = input.required<LucideIconData>();
  readonly title = input.required<string>();
  readonly sub = input.required<string>();
  readonly on = input<boolean | undefined>(undefined);
}

@Component({
  selector: "label[pcFeeToggle]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cls()" },
  template: `
    <input type="checkbox" class="mt-1 h-4 w-4 shrink-0 accent-peacock" [checked]="checked()" (change)="toggled.emit($any($event.target).checked)" [attr.data-testid]="'toggle-' + testId()" />
    <span><span class="font-semibold">{{ label() }}</span><br /><span class="text-sm text-ink-soft">{{ hint() }}</span></span>
  `,
})
export class FeeToggle {
  readonly checked = input.required<boolean>();
  readonly label = input.required<string>();
  readonly hint = input.required<string>();
  readonly testId = input.required<string>();
  readonly toggled = output<boolean>();
  protected readonly cls = computed(() => cx("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors", this.checked() ? "border-peacock/40 bg-peacock-light/40" : "border-line hover:border-peacock/40"));
}

@Component({
  selector: "pc-long-text",
  imports: [Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-1" },
  template: `
    <label [attr.for]="id" class="text-sm font-medium text-ink">{{ label() }}</label>
    <textarea pcTextarea [id]="id" [value]="value()" [attr.maxlength]="max()" rows="3" (input)="edited.emit($any($event.target).value)"></textarea>
    <p class="text-xs text-ink-faint">{{ hint() }} · {{ value().length }}/{{ max() }}</p>
  `,
})
export class LongText {
  readonly label = input.required<string>();
  readonly hint = input.required<string>();
  readonly value = input.required<string>();
  readonly max = input.required<number>();
  readonly edited = output<string>();
  protected readonly id = uid("lt");
}

/** A fee's name on the bill and the explanation shoppers read when they tap it. */
@Component({
  selector: "pc-on-the-bill",
  imports: [TextField, LongText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "grid gap-3 rounded-xl bg-mist/70 p-3 sm:col-span-2" },
  template: `
    <p class="text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">On the bill</p>
    <pc-text-field label="Name" [value]="name()" [maxlength]="40" [placeholder]="placeholder()" [error]="nameError()" hint="2 to 40 characters" (valueChange)="nameChange.emit($event)" />
    <pc-long-text label="Explanation" hint="Shoppers tap the name to read it" [value]="info()" [max]="300" (edited)="infoChange.emit($event)" />
  `,
})
export class OnTheBill {
  readonly name = input.required<string>();
  readonly info = input.required<string>();
  readonly nameError = input<string | undefined>(undefined);
  readonly placeholder = input.required<string>();
  readonly nameChange = output<string>();
  readonly infoChange = output<string>();
}

/* ---------------------------------------------------------------- page */

@Component({
  selector: "pc-admin-checkout-page",
  imports: [PageHeader, Icon, PageLoader, Button, ErrorNote, Field, Input, Pill, Select, TextField, BillDetails, FeeSection, FeeToggle, LongText, OnTheBill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!d() || !saved()) {
      @if (!loadError()) {
        <pc-page-loader />
      } @else {
        <div class="flex max-w-6xl flex-col gap-4">
          <pc-page-header title="Checkout and fees" />
          <pc-error-note [message]="loadError()" />
        </div>
      }
    } @else {
      <div class="flex max-w-6xl flex-col gap-4">
        <pc-page-header title="Checkout and fees" sub="Every charge shoppers see on the bill, and the extra choices at checkout. Try your changes in the live preview, then save." />
        <div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <form (submit)="save($event)" class="flex min-w-0 flex-col gap-4" data-testid="checkout-settings">
            <section pcFeeSection [icon]="Truck" title="Delivery" sub="Charged on each seller's package and part of that seller's sale: it is paid out to the seller and taxed with the goods.">
              <pc-text-field label="Delivery fee per seller package (₹)" inputmode="decimal" [value]="m('shipping_fee_paise')" [error]="issues().shipping_fee_paise" testid="amount-shipping_fee_paise" (valueChange)="setMoney('shipping_fee_paise', $event)" hint="0 makes delivery free" />
              <pc-text-field label="Free delivery from (₹, per seller)" inputmode="decimal" [value]="m('free_shipping_threshold_paise')" [error]="issues().free_shipping_threshold_paise" testid="amount-free_shipping_threshold_paise" (valueChange)="setMoney('free_shipping_threshold_paise', $event)" hint="When a seller's items reach this amount. 0 makes every delivery free." />
              <pc-on-the-bill [name]="tx('delivery_label')" [info]="tx('delivery_info')" [nameError]="issues().delivery_label" (nameChange)="setText('delivery_label', $event)" (infoChange)="setText('delivery_info', $event)" placeholder="Delivery fee" />
            </section>

            <section pcFeeSection [icon]="Banknote" title="Cash on delivery" [on]="fl('cod_enabled')" sub="Charged once per order paid in cash, with the first seller's package. Like the delivery fee, it is part of the seller's sale.">
              <label pcFeeToggle [checked]="fl('cod_enabled')" (toggled)="setFlag('cod_enabled', $event)" testId="cod_enabled" label="Offer cash on delivery" hint="Shoppers pay in cash when the package arrives." class="sm:col-span-2"></label>
              @if (fl("cod_enabled") || has("cod_fee_paise", "cod_max_order_paise")) {
                <pc-text-field label="Cash on delivery fee (₹)" inputmode="decimal" [value]="m('cod_fee_paise')" [error]="issues().cod_fee_paise" testid="amount-cod_fee_paise" (valueChange)="setMoney('cod_fee_paise', $event)" hint="Once per order. 0 for no fee." />
                <pc-text-field label="Highest order value allowed (₹)" inputmode="decimal" [value]="m('cod_max_order_paise')" [error]="issues().cod_max_order_paise" testid="amount-cod_max_order_paise" (valueChange)="setMoney('cod_max_order_paise', $event)" hint="Larger orders must be paid online" />
              }
            </section>

            <section pcFeeSection [icon]="PackageCheck" title="Handling fee" [on]="fl('handling_enabled')" sub="The marketplace's own fee, once per order. GST is included, and it is not part of any seller's payout.">
              <label pcFeeToggle [checked]="fl('handling_enabled')" (toggled)="setFlag('handling_enabled', $event)" testId="handling_enabled" label="Charge a handling fee" hint="Once per order, for packing and handling." class="sm:col-span-2"></label>
              @if (fl("handling_enabled") || has("handling_paise", "handling_list_paise", "handling_free_above_paise", "handling_label")) {
                <pc-text-field label="Fee charged (₹)" inputmode="decimal" [value]="m('handling_paise')" [error]="issues().handling_paise" testid="amount-handling_paise" (valueChange)="setMoney('handling_paise', $event)" />
                <pc-text-field label="Regular fee, shown struck through (₹)" inputmode="decimal" [value]="m('handling_list_paise')" [error]="issues().handling_list_paise" testid="amount-handling_list_paise" (valueChange)="setMoney('handling_list_paise', $event)" hint="Optional. Higher than the fee charged; 0 shows none." />
                <pc-text-field label="Free when the item total reaches (₹)" inputmode="decimal" [value]="m('handling_free_above_paise')" [error]="issues().handling_free_above_paise" testid="amount-handling_free_above_paise" (valueChange)="setMoney('handling_free_above_paise', $event)" hint="0 means it is always charged" />
                <pc-on-the-bill [name]="tx('handling_label')" [info]="tx('handling_info')" [nameError]="issues().handling_label" (nameChange)="setText('handling_label', $event)" (infoChange)="setText('handling_info', $event)" placeholder="Handling fee" />
              }
            </section>

            <section pcFeeSection [icon]="ShoppingBasket" title="Small cart fee" [on]="fl('small_cart_enabled')" sub="The marketplace's own fee on small orders. GST is included, and it is not part of any seller's payout.">
              <label pcFeeToggle [checked]="fl('small_cart_enabled')" (toggled)="setFlag('small_cart_enabled', $event)" testId="small_cart_enabled" label="Charge a small cart fee" hint="Only on orders whose item total is below the amount you set." class="sm:col-span-2"></label>
              @if (fl("small_cart_enabled") || has("small_cart_paise", "small_cart_below_paise", "small_cart_label")) {
                <pc-text-field label="Fee (₹)" inputmode="decimal" [value]="m('small_cart_paise')" [error]="issues().small_cart_paise" testid="amount-small_cart_paise" (valueChange)="setMoney('small_cart_paise', $event)" />
                <pc-text-field label="Charged when the item total is below (₹)" inputmode="decimal" [value]="m('small_cart_below_paise')" [error]="issues().small_cart_below_paise" testid="amount-small_cart_below_paise" (valueChange)="setMoney('small_cart_below_paise', $event)" hint="From this amount up, there is no fee" />
                <pc-on-the-bill [name]="tx('small_cart_label')" [info]="tx('small_cart_info')" [nameError]="issues().small_cart_label" (nameChange)="setText('small_cart_label', $event)" (infoChange)="setText('small_cart_info', $event)" placeholder="Small cart fee" />
              }
            </section>

            <section pcFeeSection [icon]="Building2" title="Platform fee" [on]="fl('platform_enabled')" sub="The marketplace's own flat fee on every order. GST is included, and it is not part of any seller's payout.">
              <label pcFeeToggle [checked]="fl('platform_enabled')" (toggled)="setFlag('platform_enabled', $event)" testId="platform_enabled" label="Charge a platform fee" hint="The same amount on every order." class="sm:col-span-2"></label>
              @if (fl("platform_enabled") || has("platform_paise", "platform_label")) {
                <pc-text-field label="Fee (₹)" inputmode="decimal" [value]="m('platform_paise')" [error]="issues().platform_paise" testid="amount-platform_paise" (valueChange)="setMoney('platform_paise', $event)" hint="On every order" />
                <pc-on-the-bill [name]="tx('platform_label')" [info]="tx('platform_info')" [nameError]="issues().platform_label" (nameChange)="setText('platform_label', $event)" (infoChange)="setText('platform_info', $event)" placeholder="Platform fee" />
              }
            </section>

            <section pcFeeSection [icon]="CloudRain" title="Bad weather fee" [on]="fl('surge_enabled')" sub="Switch it on during heavy rain or very high demand, for a few hours or until you switch it off. The marketplace's own fee, with GST included.">
              <label pcFeeToggle [checked]="fl('surge_enabled')" (toggled)="setFlag('surge_enabled', $event)" testId="surge_enabled" label="Charge a bad weather fee" hint="On every order placed while it is on." class="sm:col-span-2"></label>
              @if (status() && saved()!.fees.surge_enabled && (status()!.surge_active || surgeEnded())) {
                <p [class]="status()!.surge_active ? 'flex items-center gap-2 rounded-lg px-3 py-2 text-sm sm:col-span-2 bg-leaf-light text-ink' : 'flex items-center gap-2 rounded-lg px-3 py-2 text-sm sm:col-span-2 bg-mist text-ink-soft'" data-testid="surge-status">
                  @if (status()!.surge_active) {<svg [pcIcon]="Clock3" class="h-4 w-4 shrink-0 text-leaf" />} @else {<svg [pcIcon]="CircleSlash" class="h-4 w-4 shrink-0" />}
                  {{ surgeText() }}
                </p>
              }
              @if (fl("surge_enabled") || has("surge_paise", "surge_label", "surge_for")) {
                <pc-text-field label="Fee (₹)" inputmode="decimal" [value]="m('surge_paise')" [error]="issues().surge_paise" testid="amount-surge_paise" (valueChange)="setMoney('surge_paise', $event)" hint="On each order, once" />
                <pc-field label="Charge it" hint="It switches off by itself at the end" [error]="issues().surge_for">
                  <select pcSelect (change)="setSurgeFor($any($event.target).value)" data-testid="surge-for" [class.border-vermilion]="!!issues().surge_for" [attr.aria-invalid]="!!issues().surge_for">
                    @for (c of surgeChoices(); track c.value) {<option [value]="c.value" [selected]="c.value === d()!.surgeFor">{{ c.label }}</option>}
                  </select>
                </pc-field>
                <pc-on-the-bill [name]="tx('surge_label')" [info]="tx('surge_info')" [nameError]="issues().surge_label" (nameChange)="setText('surge_label', $event)" (infoChange)="setText('surge_info', $event)" placeholder="Bad weather fee" />
                <p class="text-xs text-ink-faint sm:col-span-2">Delivery partners can earn a bonus on every trip they finish while this fee is on: set it in Delivery → Settings → Partner earnings.</p>
              }
            </section>

            <section pcFeeSection [icon]="MoonStar" title="Late night fee" [on]="fl('late_night_enabled')" sub="On orders placed between the times you set, India time. The marketplace's own fee, with GST included.">
              <label pcFeeToggle [checked]="fl('late_night_enabled')" (toggled)="setFlag('late_night_enabled', $event)" testId="late_night_enabled" label="Charge a late night fee" hint="Only on orders placed inside the time window." class="sm:col-span-2"></label>
              @if (status()?.late_night_active && saved()!.fees.late_night_enabled) {
                <p class="flex items-center gap-2 rounded-lg bg-leaf-light px-3 py-2 text-sm text-ink sm:col-span-2" data-testid="night-status">
                  <svg [pcIcon]="Clock3" class="h-4 w-4 shrink-0 text-leaf" />Being charged now, until {{ clock(saved()!.fees.late_night_to) }}.
                </p>
              }
              @if (fl("late_night_enabled") || has("late_night_paise", "late_night_label", "late_night_from", "late_night_to")) {
                <pc-text-field label="Fee (₹)" inputmode="decimal" [value]="m('late_night_paise')" [error]="issues().late_night_paise" testid="amount-late_night_paise" (valueChange)="setMoney('late_night_paise', $event)" hint="On each order, once" class="sm:col-span-2" />
                <pc-text-field label="From" type="time" [value]="d()!.times.late_night_from" [error]="issues().late_night_from" testid="night-from" [hint]="fromHint()" (valueChange)="setTime('late_night_from', $event)" />
                <pc-text-field label="Until" type="time" [value]="d()!.times.late_night_to" [error]="issues().late_night_to" testid="night-to" [hint]="toHint()" (valueChange)="setTime('late_night_to', $event)" />
                <pc-on-the-bill [name]="tx('late_night_label')" [info]="tx('late_night_info')" [nameError]="issues().late_night_label" (nameChange)="setText('late_night_label', $event)" (infoChange)="setText('late_night_info', $event)" placeholder="Late night fee" />
              }
            </section>

            <section pcFeeSection [icon]="Percent" title="Tax and refunds" sub="For the marketplace's own fees (handling, small cart, platform, bad weather, late night). Delivery and cash on delivery fees are taxed with the goods in each package instead.">
              <pc-text-field label="GST included in these fees (%)" [value]="d()!.gst" inputmode="decimal" [error]="issues().gst" hint="0 to 28. The bill shows the GST inside each fee." testid="gst-percent" (valueChange)="setGst($event)" />
              <label pcFeeToggle [checked]="fl('fees_refund_on_cancel')" (toggled)="setFlag('fees_refund_on_cancel', $event)" testId="fees_refund_on_cancel" label="Refund these fees when every package of an order is cancelled"
                hint="Off: the marketplace keeps the fees. A tip always goes back when nothing of the order is delivered."></label>
              <pc-text-field label="SAC code on the fee invoice" [value]="tx('fees_sac_code')" [error]="issues().fees_sac_code" inputmode="numeric" [maxlength]="8"
                hint="The marketplace issues its own tax invoice for these fees at the first delivery" (valueChange)="setText('fees_sac_code', $event)" />
              <pc-text-field label="Fee invoice number prefix" [value]="tx('fee_invoice_prefix')" [error]="issues().fee_invoice_prefix" [maxlength]="4" [filter]="upper"
                [hint]="'Numbers look like ' + (tx('fee_invoice_prefix') || 'MKT').toUpperCase() + '/26-27/000001. Needs the GSTIN in Storefront → Business.'" (valueChange)="setText('fee_invoice_prefix', $event)" />
            </section>

            <section pcFeeSection [icon]="HandCoins" title="Delivery partner tip" [on]="fl('tip_enabled')" sub="Shoppers can add a tip at checkout. It goes to the delivery partner in full: it is not a marketplace fee or part of a seller's sale.">
              <label pcFeeToggle [checked]="fl('tip_enabled')" (toggled)="setFlag('tip_enabled', $event)" testId="tip_enabled" label="Let shoppers add a tip" hint="Shown at checkout with the amounts below." class="sm:col-span-2"></label>
              @if (fl("tip_enabled") || has("tip_max_paise")) {
                <div class="flex flex-col gap-1.5 sm:col-span-2">
                  <p id="tip-amounts" class="text-sm font-medium text-ink">Amounts to pick from</p>
                  <ul class="flex flex-wrap items-center gap-2" aria-labelledby="tip-amounts" data-testid="tip-presets">
                    @for (t of d()!.tips; track t) {
                      <li class="inline-flex h-9 items-center gap-1 rounded-full bg-peacock-light pl-3.5 pr-1 font-semibold text-peacock">
                        {{ rupees(t) }}
                        <button type="button" [attr.aria-label]="'Remove ' + rupees(t)" [attr.title]="d()!.tips.length === 1 ? 'Keep at least one amount' : null" [disabled]="d()!.tips.length === 1"
                          (click)="removeTip(t)" class="grid h-7 w-7 place-items-center rounded-full hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent">
                          <svg [pcIcon]="X" class="h-3.5 w-3.5" />
                        </button>
                      </li>
                    }
                    @if (d()!.tips.length < 4) {
                      <li class="flex items-center gap-2">
                        <input pcInput [value]="tipText()" inputmode="decimal" placeholder="Amount" aria-label="New tip amount in rupees" aria-describedby="tip-help" [invalid]="!!tipError()" class="w-28" data-testid="tip-new"
                          (input)="tipText.set($any($event.target).value); tipError.set(null)" (keydown.enter)="$event.preventDefault(); addTip()" />
                        <button pcButton type="button" variant="secondary" (click)="addTip()"><svg [pcIcon]="Plus" class="h-4 w-4" />Add</button>
                      </li>
                    }
                  </ul>
                  <p id="tip-help" [class]="tipError() ? 'text-sm text-vermilion' : 'text-xs text-ink-faint'">{{ tipError() ?? "Up to 4 amounts, from ₹1 to ₹1,000 each." }}</p>
                </div>
                <pc-text-field label="Largest tip (₹)" inputmode="decimal" [value]="m('tip_max_paise')" [error]="issues().tip_max_paise" testid="amount-tip_max_paise" (valueChange)="setMoney('tip_max_paise', $event)" hint="The most a shopper can tip on one order" />
                @if (tipsOver().length > 0) {
                  <p class="rounded-lg bg-marigold-light px-3 py-2 text-sm text-ink sm:col-span-2">{{ tipsOverText() }}</p>
                }
              }
            </section>

            <section pcFeeSection [icon]="ListChecks" title="Checkout options" sub="Extra choices shoppers see at checkout.">
              <label pcFeeToggle [checked]="fl('gstin_enabled')" (toggled)="setFlag('gstin_enabled', $event)" testId="gstin_enabled" label="Business purchases (GSTIN on the invoice)" hint="Shoppers can add a GSTIN and business name; the sellers' tax invoices are made out to the business."></label>
              <label pcFeeToggle [checked]="fl('instructions_enabled')" (toggled)="setFlag('instructions_enabled', $event)" testId="instructions_enabled" label="Delivery instructions" hint="Shoppers can leave a note for the delivery partner or courier."></label>
              <label pcFeeToggle [checked]="fl('no_bag_enabled')" (toggled)="setFlag('no_bag_enabled', $event)" testId="no_bag_enabled" label="I don't need a bag" hint="Shoppers can ask for their order without a carry bag."></label>
              <label pcFeeToggle [checked]="fl('gift_message_enabled')" (toggled)="setFlag('gift_message_enabled', $event)" testId="gift_message_enabled" label="Gift message" hint="Shoppers can add a short message the seller packs with the order."></label>
              @if (fl('gift_message_enabled')) {
                <pc-text-field label="Longest gift message (characters)" [value]="d()!.giftMax" inputmode="numeric" [error]="issues().gift_max" hint="20 to 300" (valueChange)="setGiftMax($event)" />
              }
              <pc-long-text label="Cancellation note" hint="Shown at checkout" [value]="tx('cancellation_note')" [max]="600" (edited)="setText('cancellation_note', $event)" class="sm:col-span-2" />
            </section>

            <div class="sticky bottom-0 z-20 -mx-1 flex flex-col gap-2 bg-gradient-to-t from-mist via-mist/90 to-transparent px-1 pb-2 pt-6">
              <pc-error-note [message]="message()" />
              <div [class]="docked() ? 'flex items-center gap-3 rounded-2xl bg-white py-2 pl-4 pr-2 shadow-lg ring-1 ring-black/5 mr-[72px] xl:mr-0' : 'flex items-center gap-3 rounded-2xl bg-white py-2 pl-4 pr-2 shadow-lg ring-1 ring-black/5'">
                <div class="min-w-0 flex-1 text-sm leading-snug">
                  @if (dirty()) {
                    <p class="flex items-center gap-1.5 font-semibold text-ink"><span class="h-2 w-2 shrink-0 rounded-full bg-marigold" aria-hidden="true"></span>Unsaved changes</p>
                  } @else {
                    <p class="flex items-center gap-1.5 font-semibold text-leaf"><svg [pcIcon]="CircleCheck" class="h-4 w-4 shrink-0" />All changes saved</p>
                  }
                  <button type="button" class="font-semibold text-peacock hover:underline xl:hidden" (click)="seeBill()">See the bill{{ shown() ? ": " + rupees(shown()!.bill.total) : "" }}</button>
                </div>
                <button pcButton type="submit" size="lg" [loading]="busy()" class="shrink-0" data-testid="save-checkout">
                  <span class="sm:hidden">Save</span>
                  <span class="hidden sm:inline">Save changes</span>
                </button>
              </div>
            </div>
          </form>

          <aside id="bill-preview" aria-label="Bill preview" data-testid="checkout-preview"
            [class]="'flex scroll-mt-24 flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5 xl:sticky xl:top-[84px] xl:overflow-y-auto ' + (docked() ? 'xl:max-h-[calc(100vh-172px)]' : 'xl:max-h-[calc(100vh-96px)]')">
            <div class="flex items-start gap-3">
              <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-marigold-light text-marigold-dark" aria-hidden="true"><svg [pcIcon]="Receipt" class="h-5 w-5" /></span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 class="text-lg font-semibold">Live preview</h2>
                  @if (dirty()) {<pc-pill tone="amber">Not saved yet</pc-pill>}
                </div>
                <p class="text-sm text-ink-soft">The bill for a sample order from one seller, with the values on this page.</p>
              </div>
              @if (updating()) {
                <span class="inline-flex h-7 shrink-0 items-center gap-1 text-xs font-semibold text-ink-faint"><svg [pcIcon]="Loader2" class="h-3.5 w-3.5 animate-spin" />Updating</span>
              }
            </div>

            <div class="rounded-xl bg-mist p-3">
              <div class="flex flex-wrap items-end gap-x-4 gap-y-2">
                <pc-field label="Item total (₹)" class="w-32">
                  <input pcInput [value]="sample().items" inputmode="decimal" [invalid]="sampleItems() === null" [attr.aria-invalid]="sampleItems() === null" data-testid="preview-items"
                    (input)="setSample({ items: $any($event.target).value })" />
                </pc-field>
                <label [class]="codOn() ? 'flex h-10 items-center gap-2 font-medium cursor-pointer' : 'flex h-10 items-center gap-2 font-medium cursor-not-allowed text-ink-faint'">
                  <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="sample().cod && codOn()" [disabled]="!codOn()" data-testid="preview-cod" (change)="setSample({ cod: $any($event.target).checked })" />
                  Cash on delivery
                </label>
                @if (nightOn()) {
                  <label class="flex h-10 cursor-pointer items-center gap-2 font-medium">
                    <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="sample().night" data-testid="preview-night" (change)="setSample({ night: $any($event.target).checked })" />
                    Placed late at night
                  </label>
                }
              </div>
              @if (sampleItems() === null) {
                <p class="mt-1.5 text-sm text-vermilion">Enter rupees, like 500</p>
              } @else if (!codOn()) {
                <p class="mt-1.5 text-xs text-ink-faint">Cash on delivery is off, so shoppers cannot choose it.</p>
              }
            </div>

            <div [class]="updating() || previewKey() === null ? 'transition-opacity opacity-60' : 'transition-opacity'" [attr.aria-busy]="updating()">
              @if (shown(); as s) {
                <pc-bill-details [bill]="{ items_total: s.bill.items_total, shipping_total: s.bill.shipping, cod_fee: s.bill.cod_fee, fees: s.bill.fees, grand_total: s.bill.total }"
                  [hints]="s.bill.hints" totalLabel="To pay" [deliveryLabel]="tx('delivery_label')" [deliveryInfo]="tx('delivery_info')" />
              } @else if (!previewError()) {
                <div class="flex flex-col gap-3" aria-hidden="true">
                  <div class="skeleton h-3 w-24 rounded"></div>
                  @for (i of four; track i) {
                    <div class="flex justify-between gap-4"><div class="skeleton h-4 w-32 rounded"></div><div class="skeleton h-4 w-14 rounded"></div></div>
                  }
                  <div class="skeleton mt-1 h-7 rounded-lg"></div>
                </div>
              }
            </div>

            @if (previewKey() === null && sampleItems() !== null) {<p class="text-sm text-vermilion">Fix the highlighted amounts to update the preview.</p>}
            @if (previewError()) {
              <div class="flex flex-col items-start gap-2">
                <pc-error-note [message]="previewError()" />
                <button pcButton type="button" variant="secondary" size="sm" (click)="retry.set(retry() + 1)">Try again</button>
              </div>
            }
            @if (codRefused() && codMax() !== null) {
              <p class="rounded-xl bg-marigold-light px-3 py-2 text-sm text-ink">Cash on delivery is not offered on this order: it is above the {{ rupees(codMax()!) }} limit.</p>
            }
            <p class="border-t border-line pt-3 text-xs leading-relaxed text-ink-faint">Shoppers see this bill in the cart, at checkout and on their order. A tip and a coupon, when they add one, show above the total.</p>
          </aside>
        </div>
      </div>
    }
  `,
})
export class AdminCheckoutPage {
  private readonly toast = inject(Toast);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly admin = inject(AdminContext);
  // the AI assistant's round button sits at the bottom right: the save bar and preview keep clear of it
  protected readonly docked = computed(() => this.admin.can("assistant"));
  protected readonly Truck = Truck; protected readonly Banknote = Banknote; protected readonly PackageCheck = PackageCheck; protected readonly ShoppingBasket = ShoppingBasket;
  protected readonly Building2 = Building2; protected readonly CloudRain = CloudRain; protected readonly MoonStar = MoonStar; protected readonly Percent = Percent;
  protected readonly HandCoins = HandCoins; protected readonly ListChecks = ListChecks; protected readonly Clock3 = Clock3; protected readonly CircleSlash = CircleSlash;
  protected readonly CircleCheck = CircleCheck; protected readonly Receipt = Receipt; protected readonly Loader2 = Loader2; protected readonly Plus = Plus; protected readonly X = X;
  protected readonly rupees = rupees;
  protected readonly clock = clock;
  protected readonly upper = (v: string) => v.toUpperCase();
  protected readonly four = [0, 1, 2, 3];

  protected readonly saved = signal<Settings | null>(null);
  protected readonly d = signal<Draft | null>(null);
  protected readonly loadError = signal<string | null>(null);
  private readonly error = signal<string | null>(null);
  private readonly tried = signal(false);
  protected readonly busy = signal(false);
  protected readonly tipText = signal("");
  protected readonly tipError = signal<string | null>(null);
  protected readonly sample = signal({ items: "500", cod: false, night: false });
  protected readonly retry = signal(0);
  protected readonly shown = signal<{ key: string; bill: Preview } | null>(null);
  private readonly failed = signal<{ key: string; message: string } | null>(null);
  private readonly track = latestOnly();

  // The preview asks the server for the bill of a sample order with the values on the screen (saved or not), in paise.
  private readonly body = computed(() => { const d = this.d(); return d ? toBody(d) : null; });
  protected readonly sampleItems = computed(() => toPaise(this.sample().items));
  protected readonly codOn = computed(() => this.d()?.flags.cod_enabled ?? false);
  protected readonly nightOn = computed(() => this.d()?.flags.late_night_enabled ?? false);
  private readonly previewJson = computed(() => {
    const body = this.body();
    const items = this.sampleItems();
    const s = this.sample();
    return body && items !== null ? JSON.stringify({ ...body, items_total: items, cod: s.cod && this.codOn(), night: s.night && this.nightOn() }) : null;
  });
  protected readonly previewKey = computed(() => (this.previewJson() === null ? null : `${this.retry()}:${this.previewJson()}`));

  protected readonly status = computed(() => this.saved()?.status);
  protected readonly surgeEnded = computed(() => !!this.status()?.surge_ended && !!this.saved()?.fees.surge_enabled);
  protected readonly issues = computed(() => { const d = this.d(); return d ? findIssues(d, this.surgeEnded()) : {}; });
  // what saving with "keep" ("") does: keeps a running end time; otherwise it is charged until switched off
  private readonly keepsEnd = computed(() => !!this.saved()?.fees.surge_enabled && !!this.status()?.surge_until && !this.status()!.surge_ended);
  protected readonly surgeChoices = computed(() => [
    { value: "", label: this.keepsEnd() ? `Keep: until ${untilLabel(this.status()!.surge_until!)}` : this.surgeEnded() ? "Choose how long" : "Until I switch it off" },
    ...(this.keepsEnd() || this.surgeEnded() ? [{ value: "0", label: "Until I switch it off" }] : []),
    ...SURGE_HOURS.map((h) => ({ value: h, label: `For ${h} hour${h === "1" ? "" : "s"} from saving` })),
  ]);
  protected readonly surgeText = computed(() => {
    const s = this.status()!;
    return s.surge_active ? (s.surge_until ? `Being charged now, until ${untilLabel(s.surge_until)}.` : "Being charged now, until you switch it off.") : `Stopped by itself at ${untilLabel(s.surge_until!)}.`;
  });
  private readonly blocked = computed(() => Object.keys(this.issues()).length > 0);
  protected readonly dirty = computed(() => { const s = this.saved(); return !!s && JSON.stringify(this.body()) !== JSON.stringify(toBody(toDraft(s))); });
  protected readonly message = computed(() => (this.tried() && this.blocked() ? "Check the highlighted fields, then save again." : this.error()));
  protected readonly updating = computed(() => this.previewKey() !== null && this.shown()?.key !== this.previewKey() && this.failed()?.key !== this.previewKey());
  protected readonly previewError = computed(() => { const f = this.failed(); return f && f.key === this.previewKey() ? f.message : null; });
  protected readonly codMax = computed(() => { const d = this.d(); return d ? toPaise(d.money.cod_max_order_paise) : null; });
  protected readonly codRefused = computed(() => { const s = this.shown(), max = this.codMax(); return this.sample().cod && this.codOn() && s !== null && max !== null && s.bill.total > max; });
  protected readonly tipsOver = computed(() => { const d = this.d(); const max = d ? toPaise(d.money.tip_max_paise) : null; return max === null || !d ? [] : d.tips.filter((t) => t > max); });
  protected readonly tipsOverText = computed(() => {
    const o = this.tipsOver();
    return `${o.map(rupees).join(", ")} ${o.length === 1 ? "is" : "are"} more than the largest tip, so shoppers could not pick ${o.length === 1 ? "it" : "them"}.`;
  });
  protected readonly fromHint = computed(() => { const v = this.d()!.times.late_night_from; return HHMM.test(v) ? clock(v) : "India time"; });
  protected readonly toHint = computed(() => {
    const t = this.d()!.times;
    return HHMM.test(t.late_night_to) ? `${clock(t.late_night_to)}${t.late_night_to < t.late_night_from ? ", the next morning" : ""}` : "India time";
  });

  constructor() {
    api<Settings>("/api/admin/checkout")
      .then((s) => {
        this.saved.set(s);
        this.d.set(toDraft(s));
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return; // a lost session is handled by the session provider
        this.loadError.set(e instanceof ApiError ? e.message : "Could not load the checkout settings. Reload the page to try again.");
      });

    // Nothing is asked while an amount cannot be read; failures come back as values so latestOnly drops stale ones too.
    effect((onCleanup) => {
      const previewKey = this.previewKey();
      const previewJson = this.previewJson();
      if (previewKey === null || previewJson === null) return;
      const timer = setTimeout(() => {
        void this.track(
          api<Preview>("/api/admin/checkout/preview", { method: "POST", body: JSON.parse(previewJson) }).then(
            (bill) => ({ bill, message: "" }),
            (e: unknown) => ({ bill: null, message: e instanceof ApiError ? e.message : "Could not update the preview" }),
          ),
          ({ bill, message }) => {
            if (bill) {
              this.shown.set({ key: previewKey, bill });
              this.failed.set(null);
            } else {
              this.failed.set({ key: previewKey, message });
            }
          },
        );
      }, 300);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected m(k: MoneyKey): string { return this.d()!.money[k]; }
  protected fl(k: FlagKey): boolean { return this.d()!.flags[k]; }
  protected tx(k: TextKey): string { return this.d()!.text[k]; }
  protected has(...keys: IssueKey[]): boolean { const i = this.issues(); return keys.some((k) => k in i); }

  protected setMoney(k: MoneyKey, v: string): void { this.d.update((x) => x && { ...x, money: { ...x.money, [k]: v } }); }
  protected setFlag(k: FlagKey, v: boolean): void { this.d.update((x) => x && { ...x, flags: { ...x.flags, [k]: v } }); }
  protected setText(k: TextKey, v: string): void { this.d.update((x) => x && { ...x, text: { ...x.text, [k]: v } }); }
  protected setTime(k: TimeKey, v: string): void { this.d.update((x) => x && { ...x, times: { ...x.times, [k]: v } }); }
  protected setGiftMax(v: string): void { this.d.update((x) => x && { ...x, giftMax: v }); }
  protected setGst(v: string): void { this.d.update((x) => x && { ...x, gst: v }); }
  protected setSurgeFor(v: string): void { this.d.update((x) => x && { ...x, surgeFor: v }); }
  protected setSample(x: Partial<{ items: string; cod: boolean; night: boolean }>): void { this.sample.update((s) => ({ ...s, ...x })); }

  protected addTip(): void {
    const d = this.d()!;
    const p = toPaise(this.tipText());
    if (p === null || p < 100 || p > 100_000) return void this.tipError.set("Enter an amount from ₹1 to ₹1,000");
    if (d.tips.includes(p)) return void this.tipError.set(`${rupees(p)} is already in the list`);
    if (d.tips.length >= 4) return void this.tipError.set("Up to 4 amounts. Remove one first.");
    this.d.update((x) => x && { ...x, tips: [...x.tips, p].sort((a, b) => a - b) });
    this.tipText.set("");
    this.tipError.set(null);
  }

  protected removeTip(t: number): void {
    this.d.update((x) => x && { ...x, tips: x.tips.filter((y) => y !== t) });
  }

  protected seeBill(): void {
    document.getElementById("bill-preview")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  protected async save(e: Event): Promise<void> {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const d = this.d();
    const payload = d ? toBody(d) : null;
    if (!d || !payload || Object.keys(findIssues(d, this.surgeEnded())).length > 0) {
      this.tried.set(true);
      // the fields show their errors on the next render; then the first one is brought into view
      setTimeout(() => {
        const first = form.querySelector<HTMLElement>('[aria-invalid="true"]');
        first?.scrollIntoView({ block: "center", behavior: "smooth" });
        first?.focus({ preventScroll: true });
      });
      return;
    }
    this.tried.set(false);
    this.error.set(null);
    this.busy.set(true);
    try {
      const s = await api<Settings>("/api/admin/checkout", { method: "PUT", body: payload });
      this.saved.set(s);
      this.d.set(toDraft(s));
      this.toast.show(s.status?.surge_active && s.status.surge_until ? `Checkout and fees saved. The ${s.fees.surge_label.toLowerCase()} stops at ${untilLabel(s.status.surge_until)}.` : "Checkout and fees saved");
    } catch (x) {
      this.error.set(x instanceof ApiError ? readable(x.message) : "Could not save. Try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
