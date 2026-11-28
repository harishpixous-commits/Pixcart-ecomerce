"use client";

/*
 * Admin → Checkout and fees: every charge a shopper sees on the bill (delivery, cash on delivery, the marketplace's
 * handling, small cart and platform fees, the delivery partner tip) and the extra choices at checkout, with a live
 * preview. The server works out the preview from the values on the screen, saved or not; this page only turns rupees
 * into paise and lays the answer out.
 */

import clsx from "clsx";
import { Banknote, Building2, CircleCheck, CircleSlash, Clock3, CloudRain, HandCoins, ListChecks, Loader2, MoonStar, PackageCheck, Percent, Plus, Receipt, ShoppingBasket, Truck, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BillDetails } from "@/components/bill";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Input, PageLoader, Pill, Select, Textarea, TextField, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError, latestOnly } from "@/lib/api";
import { paiseToInput, rupees, toPaise } from "@/lib/format";
import type { FeeLine } from "@/lib/types";

type Marketplace = {
  shipping_fee_paise: number; free_shipping_threshold_paise: number; cod_enabled: boolean; cod_fee_paise: number; cod_max_order_paise: number;
};
type Fees = {
  delivery_label: string; delivery_info: string;
  handling_enabled: boolean; handling_paise: number; handling_list_paise: number; handling_free_above_paise: number; handling_label: string; handling_info: string;
  small_cart_enabled: boolean; small_cart_paise: number; small_cart_below_paise: number; min_order_paise: number; small_cart_label: string; small_cart_info: string;
  platform_enabled: boolean; platform_paise: number; platform_label: string; platform_info: string;
  surge_enabled: boolean; surge_paise: number; surge_until: string; surge_label: string; surge_info: string;
  late_night_enabled: boolean; late_night_paise: number; late_night_from: string; late_night_to: string; late_night_label: string; late_night_info: string;
  fees_gst_bps: number; fees_refund_on_cancel: boolean; fees_sac_code: string; fee_invoice_prefix: string;
  tip_enabled: boolean; tip_presets: number[]; tip_max_paise: number;
  gstin_enabled: boolean; instructions_enabled: boolean; no_bag_enabled: boolean; gift_message_enabled: boolean; gift_message_max: number; delivery_slots_enabled: boolean; delivery_slots: string; cancellation_note: string;
};
/** Whether the time-bound fees are being charged at this moment (worked out by the server's clock). */
type FeeStatus = { surge_active: boolean; surge_until: string | null; surge_ended: boolean; late_night_active: boolean; night_window_now: boolean };
type Settings = { marketplace: Marketplace; fees: Fees; status?: FeeStatus };
type Body = { marketplace: Marketplace; fees: Partial<Fees> & { surge_hours?: number } };
type Preview = { items_total: number; shipping: number; cod_fee: number; fees: FeeLine[]; total: number; hints: string[] };

const MARKET_MONEY = ["shipping_fee_paise", "free_shipping_threshold_paise", "cod_fee_paise", "cod_max_order_paise"] as const;
const FEE_MONEY = ["handling_paise", "handling_list_paise", "handling_free_above_paise", "small_cart_paise", "small_cart_below_paise", "min_order_paise", "platform_paise",
  "surge_paise", "late_night_paise", "tip_max_paise"] as const;
const MONEY = [...MARKET_MONEY, ...FEE_MONEY];
const FEE_FLAGS = ["handling_enabled", "small_cart_enabled", "platform_enabled", "surge_enabled", "late_night_enabled", "fees_refund_on_cancel", "tip_enabled",
  "gstin_enabled", "instructions_enabled", "no_bag_enabled", "gift_message_enabled", "delivery_slots_enabled"] as const;
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
type IssueKey = MoneyKey | LabelKey | TimeKey | "gst" | "gift_max" | "slots" | "surge_for" | "fees_sac_code" | "fee_invoice_prefix";

/** The form as typed: amounts (rupees) and the GST rate (percent) stay text until they are sent. */
type Draft = {
  money: Record<MoneyKey, string>; flags: Record<FlagKey, boolean>; text: Record<TextKey, string>; times: Record<TimeKey, string>;
  gst: string; giftMax: string; slots: string; tips: number[]; surgeFor: string;
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
  min_order_paise: "Minimum order",
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
    slots: f.delivery_slots ?? "",
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
      ...d.text, ...d.times, ...pick(FEE_FLAGS, (k) => d.flags[k]), ...pick(FEE_MONEY, p), fees_gst_bps: bps, gift_message_max: Number(d.giftMax), delivery_slots: d.slots, tip_presets: d.tips,
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
  if (d.flags.delivery_slots_enabled && (d.slots.split(";").filter((x) => x.trim()).length < 2 || d.slots.split(";").filter((x) => x.trim()).length > 6)) out.slots = "Give 2 to 6 choices, split with ;";
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

function Section({ icon: Icon, title, sub, on, children }: { icon: LucideIcon; title: string; sub: string; on?: boolean; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:grid-cols-2 sm:p-5">
      <div className="flex items-start gap-3 sm:col-span-2">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-peacock-light text-peacock" aria-hidden>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-lg font-semibold">{title}</h2>
            {on !== undefined && <Pill tone={on ? "green" : "gray"}>{on ? "On" : "Off"}</Pill>}
          </div>
          <p className="text-sm text-ink-soft">{sub}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Toggle({ checked, onChange, label, hint, testId, className }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint: string; testId: string; className?: string;
}) {
  return (
    <label className={clsx("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors", checked ? "border-peacock/40 bg-peacock-light/40" : "border-line hover:border-peacock/40", className)}>
      <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-peacock" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={`toggle-${testId}`} />
      <span><span className="font-semibold">{label}</span><br /><span className="text-sm text-ink-soft">{hint}</span></span>
    </label>
  );
}

function LongText({ label, hint, value, max, onChange, className }: {
  label: string; hint: string; value: string; max: number; onChange: (v: string) => void; className?: string;
}) {
  return (
    <Field label={label} hint={`${hint} · ${value.length}/${max}`} className={className}>
      <Textarea value={value} maxLength={max} rows={3} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

/** A fee's name on the bill and the explanation shoppers read when they tap it. */
function OnTheBill({ name, info, nameError, onName, onInfo, placeholder }: {
  name: string; info: string; nameError?: string; onName: (v: string) => void; onInfo: (v: string) => void; placeholder: string;
}) {
  return (
    <div className="grid gap-3 rounded-xl bg-mist/70 p-3 sm:col-span-2">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">On the bill</p>
      <TextField label="Name" value={name} maxLength={40} placeholder={placeholder} error={nameError} hint="2 to 40 characters" onChange={(e) => onName(e.target.value)} />
      <LongText label="Explanation" hint="Shoppers tap the name to read it" value={info} max={300} onChange={onInfo} />
    </div>
  );
}

function BillSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <div className="skeleton h-3 w-24 rounded" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex justify-between gap-4">
          <div className="skeleton h-4 w-32 rounded" />
          <div className="skeleton h-4 w-14 rounded" />
        </div>
      ))}
      <div className="skeleton mt-1 h-7 rounded-lg" />
    </div>
  );
}

export default function CheckoutAndFees() {
  const toast = useToast();
  const docked = useCan("assistant"); // the AI assistant's round button sits at the bottom right: the save bar and preview keep clear of it
  const [saved, setSaved] = useState<Settings | null>(null);
  const [d, setD] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tipText, setTipText] = useState("");
  const [tipError, setTipError] = useState<string | null>(null);
  const [sample, setSample] = useState({ items: "500", cod: false, night: false });
  const [retry, setRetry] = useState(0);
  const [shown, setShown] = useState<{ key: string; bill: Preview } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const track = useMemo(() => latestOnly(), []);

  useEffect(() => {
    api<Settings>("/api/admin/checkout")
      .then((s) => {
        setSaved(s);
        setD(toDraft(s));
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return; // a lost session is handled by the session provider
        setLoadError(e instanceof ApiError ? e.message : "Could not load the checkout settings. Reload the page to try again.");
      });
  }, []);

  // The preview asks the server for the bill of a sample order with the values on the screen (saved or not), in paise.
  // Nothing is asked while an amount cannot be read; failures come back as values so latestOnly drops stale ones too.
  const body = d ? toBody(d) : null;
  const sampleItems = toPaise(sample.items);
  const codOn = d?.flags.cod_enabled ?? false;
  const nightOn = d?.flags.late_night_enabled ?? false;
  const previewJson = body && sampleItems !== null ? JSON.stringify({ ...body, items_total: sampleItems, cod: sample.cod && codOn, night: sample.night && nightOn }) : null;
  const previewKey = previewJson === null ? null : `${retry}:${previewJson}`;

  useEffect(() => {
    if (previewKey === null || previewJson === null) return;
    const timer = setTimeout(() => {
      track(
        api<Preview>("/api/admin/checkout/preview", { method: "POST", body: JSON.parse(previewJson) }).then(
          (bill) => ({ bill, message: "" }),
          (e: unknown) => ({ bill: null, message: e instanceof ApiError ? e.message : "Could not update the preview" }),
        ),
        ({ bill, message }) => {
          if (bill) {
            setShown({ key: previewKey, bill });
            setFailed(null);
          } else {
            setFailed({ key: previewKey, message });
          }
        },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [previewKey, previewJson, track]);

  if (!d || !saved) {
    if (!loadError) return <PageLoader />;
    return (
      <div className="flex max-w-6xl flex-col gap-4">
        <PageHeader title="Checkout and fees" />
        <ErrorNote message={loadError} />
      </div>
    );
  }

  const status = saved.status;
  const surgeEnded = !!status?.surge_ended && saved.fees.surge_enabled;
  const issues = findIssues(d, surgeEnded);
  const has = (...keys: IssueKey[]) => keys.some((k) => k in issues);
  // what saving with "keep" ("") does: keeps a running end time; otherwise it is charged until switched off
  const keepsEnd = saved.fees.surge_enabled && !!status?.surge_until && !status.surge_ended;
  const surgeChoices = [
    { value: "", label: keepsEnd ? `Keep: until ${untilLabel(status!.surge_until!)}` : surgeEnded ? "Choose how long" : "Until I switch it off" },
    ...(keepsEnd || surgeEnded ? [{ value: "0", label: "Until I switch it off" }] : []),
    ...SURGE_HOURS.map((h) => ({ value: h, label: `For ${h} hour${h === "1" ? "" : "s"} from saving` })),
  ];
  const blocked = Object.keys(issues).length > 0;
  const dirty = JSON.stringify(body) !== JSON.stringify(toBody(toDraft(saved)));
  const message = tried && blocked ? "Check the highlighted fields, then save again." : error;
  const updating = previewKey !== null && shown?.key !== previewKey && failed?.key !== previewKey;
  const previewError = failed && failed.key === previewKey ? failed.message : null;
  const codMax = toPaise(d.money.cod_max_order_paise);
  const codRefused = sample.cod && codOn && shown !== null && codMax !== null && shown.bill.total > codMax;
  const tipMax = toPaise(d.money.tip_max_paise);
  const tipsOver = tipMax === null ? [] : d.tips.filter((t) => t > tipMax);

  const setMoney = (k: MoneyKey, v: string) => setD((x) => x && { ...x, money: { ...x.money, [k]: v } });
  const setFlag = (k: FlagKey, v: boolean) => setD((x) => x && { ...x, flags: { ...x.flags, [k]: v } });
  const setText = (k: TextKey, v: string) => setD((x) => x && { ...x, text: { ...x.text, [k]: v } });
  const setTime = (k: TimeKey, v: string) => setD((x) => x && { ...x, times: { ...x.times, [k]: v } });
  const money = (k: MoneyKey) => ({
    value: d.money[k], inputMode: "decimal" as const, error: issues[k], "data-testid": `amount-${k}`,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setMoney(k, e.target.value),
  });
  const toggle = (k: FlagKey) => ({ checked: d.flags[k], onChange: (v: boolean) => setFlag(k, v), testId: k });
  const wording = (label: LabelKey, info: TextKey) => ({
    name: d.text[label], info: d.text[info], nameError: issues[label],
    onName: (v: string) => setText(label, v), onInfo: (v: string) => setText(info, v),
  });

  const addTip = () => {
    const p = toPaise(tipText);
    if (p === null || p < 100 || p > 100_000) return setTipError("Enter an amount from ₹1 to ₹1,000");
    if (d.tips.includes(p)) return setTipError(`${rupees(p)} is already in the list`);
    if (d.tips.length >= 4) return setTipError("Up to 4 amounts. Remove one first.");
    setD((x) => x && { ...x, tips: [...x.tips, p].sort((a, b) => a - b) });
    setTipText("");
    setTipError(null);
  };
  const removeTip = (t: number) => setD((x) => x && { ...x, tips: x.tips.filter((y) => y !== t) });

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const payload = d ? toBody(d) : null;
    if (!d || !payload || Object.keys(findIssues(d, surgeEnded)).length > 0) {
      setTried(true);
      const first = form.querySelector<HTMLElement>('[aria-invalid="true"]');
      first?.scrollIntoView({ block: "center", behavior: "smooth" });
      first?.focus({ preventScroll: true });
      return;
    }
    setTried(false);
    setError(null);
    setBusy(true);
    try {
      const s = await api<Settings>("/api/admin/checkout", { method: "PUT", body: payload });
      setSaved(s);
      setD(toDraft(s));
      toast(s.status?.surge_active && s.status.surge_until ? `Checkout and fees saved. The ${s.fees.surge_label.toLowerCase()} stops at ${untilLabel(s.status.surge_until)}.` : "Checkout and fees saved");
    } catch (x) {
      setError(x instanceof ApiError ? readable(x.message) : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <PageHeader title="Checkout and fees" sub="Every charge shoppers see on the bill, and the extra choices at checkout. Try your changes in the live preview, then save." />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <form onSubmit={save} className="flex min-w-0 flex-col gap-4" data-testid="checkout-settings">
          <Section icon={Truck} title="Delivery" sub="Charged on each seller's package and part of that seller's sale: it is paid out to the seller and taxed with the goods.">
            <TextField label="Delivery fee per seller package (₹)" {...money("shipping_fee_paise")} hint="0 makes delivery free" />
            <TextField label="Free delivery from (₹, per seller)" {...money("free_shipping_threshold_paise")} hint="When a seller's items reach this amount. 0 makes every delivery free." />
            <OnTheBill {...wording("delivery_label", "delivery_info")} placeholder="Delivery fee" />
          </Section>

          <Section icon={Banknote} title="Cash on delivery" on={d.flags.cod_enabled}
            sub="Charged once per order paid in cash, with the first seller's package. Like the delivery fee, it is part of the seller's sale.">
            <Toggle {...toggle("cod_enabled")} label="Offer cash on delivery" hint="Shoppers pay in cash when the package arrives." className="sm:col-span-2" />
            {(d.flags.cod_enabled || has("cod_fee_paise", "cod_max_order_paise")) && (
              <>
                <TextField label="Cash on delivery fee (₹)" {...money("cod_fee_paise")} hint="Once per order. 0 for no fee." />
                <TextField label="Highest order value allowed (₹)" {...money("cod_max_order_paise")} hint="Larger orders must be paid online" />
              </>
            )}
          </Section>

          <Section icon={PackageCheck} title="Handling fee" on={d.flags.handling_enabled}
            sub="The marketplace's own fee, once per order. GST is included, and it is not part of any seller's payout.">
            <Toggle {...toggle("handling_enabled")} label="Charge a handling fee" hint="Once per order, for packing and handling." className="sm:col-span-2" />
            {(d.flags.handling_enabled || has("handling_paise", "handling_list_paise", "handling_free_above_paise", "handling_label")) && (
              <>
                <TextField label="Fee charged (₹)" {...money("handling_paise")} />
                <TextField label="Regular fee, shown struck through (₹)" {...money("handling_list_paise")} hint="Optional. Higher than the fee charged; 0 shows none." />
                <TextField label="Free when the item total reaches (₹)" {...money("handling_free_above_paise")} hint="0 means it is always charged" />
                <OnTheBill {...wording("handling_label", "handling_info")} placeholder="Handling fee" />
              </>
            )}
          </Section>

          <Section icon={ShoppingBasket} title="Small cart fee" on={d.flags.small_cart_enabled}
            sub="The marketplace's own fee on small orders. GST is included, and it is not part of any seller's payout.">
            <Toggle {...toggle("small_cart_enabled")} label="Charge a small cart fee" hint="Only on orders whose item total is below the amount you set." className="sm:col-span-2" />
            {(d.flags.small_cart_enabled || has("small_cart_paise", "small_cart_below_paise", "small_cart_label")) && (
              <>
                <TextField label="Fee (₹)" {...money("small_cart_paise")} />
                <TextField label="Charged when the item total is below (₹)" {...money("small_cart_below_paise")} hint="From this amount up, there is no fee" />
                <OnTheBill {...wording("small_cart_label", "small_cart_info")} placeholder="Small cart fee" />
              </>
            )}
          </Section>

          <Section icon={ShoppingBasket} title="Minimum order" on={(toPaise(d.money.min_order_paise) ?? 0) > 0}
            sub="The lowest item total an order can have. Smaller carts see a note in the cart and cannot be placed.">
            <TextField label="Minimum item total (₹)" {...money("min_order_paise")} hint="0 means no minimum" />
          </Section>

          <Section icon={Building2} title="Platform fee" on={d.flags.platform_enabled}
            sub="The marketplace's own flat fee on every order. GST is included, and it is not part of any seller's payout.">
            <Toggle {...toggle("platform_enabled")} label="Charge a platform fee" hint="The same amount on every order." className="sm:col-span-2" />
            {(d.flags.platform_enabled || has("platform_paise", "platform_label")) && (
              <>
                <TextField label="Fee (₹)" {...money("platform_paise")} hint="On every order" />
                <OnTheBill {...wording("platform_label", "platform_info")} placeholder="Platform fee" />
              </>
            )}
          </Section>

          <Section icon={CloudRain} title="Bad weather fee" on={d.flags.surge_enabled}
            sub="Switch it on during heavy rain or very high demand, for a few hours or until you switch it off. The marketplace's own fee, with GST included.">
            <Toggle {...toggle("surge_enabled")} label="Charge a bad weather fee" hint="On every order placed while it is on." className="sm:col-span-2" />
            {status && saved.fees.surge_enabled && (status.surge_active || surgeEnded) && (
              <p className={clsx("flex items-center gap-2 rounded-lg px-3 py-2 text-sm sm:col-span-2", status.surge_active ? "bg-leaf-light text-ink" : "bg-mist text-ink-soft")}
                data-testid="surge-status">
                {status.surge_active ? <Clock3 className="h-4 w-4 shrink-0 text-leaf" aria-hidden /> : <CircleSlash className="h-4 w-4 shrink-0" aria-hidden />}
                {status.surge_active
                  ? status.surge_until ? `Being charged now, until ${untilLabel(status.surge_until)}.` : "Being charged now, until you switch it off."
                  : `Stopped by itself at ${untilLabel(status.surge_until!)}.`}
              </p>
            )}
            {(d.flags.surge_enabled || has("surge_paise", "surge_label", "surge_for")) && (
              <>
                <TextField label="Fee (₹)" {...money("surge_paise")} hint="On each order, once" />
                <Field label="Charge it" hint="It switches off by itself at the end" error={issues.surge_for}>
                  <Select value={d.surgeFor} onChange={(e) => { const v = e.target.value; setD((x) => x && { ...x, surgeFor: v }); }} data-testid="surge-for"
                    className={issues.surge_for ? "border-vermilion" : undefined} aria-invalid={!!issues.surge_for}>
                    {surgeChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </Select>
                </Field>
                <OnTheBill {...wording("surge_label", "surge_info")} placeholder="Bad weather fee" />
                <p className="text-xs text-ink-faint sm:col-span-2">
                  Delivery partners can earn a bonus on every trip they finish while this fee is on: set it in Delivery → Settings → Partner earnings.
                </p>
              </>
            )}
          </Section>

          <Section icon={MoonStar} title="Late night fee" on={d.flags.late_night_enabled}
            sub="On orders placed between the times you set, India time. The marketplace's own fee, with GST included.">
            <Toggle {...toggle("late_night_enabled")} label="Charge a late night fee" hint="Only on orders placed inside the time window." className="sm:col-span-2" />
            {status?.late_night_active && saved.fees.late_night_enabled && (
              <p className="flex items-center gap-2 rounded-lg bg-leaf-light px-3 py-2 text-sm text-ink sm:col-span-2" data-testid="night-status">
                <Clock3 className="h-4 w-4 shrink-0 text-leaf" aria-hidden />Being charged now, until {clock(saved.fees.late_night_to)}.
              </p>
            )}
            {(d.flags.late_night_enabled || has("late_night_paise", "late_night_label", "late_night_from", "late_night_to")) && (
              <>
                <TextField label="Fee (₹)" {...money("late_night_paise")} hint="On each order, once" className="sm:col-span-2" />
                <TextField label="From" type="time" value={d.times.late_night_from} error={issues.late_night_from} data-testid="night-from"
                  hint={HHMM.test(d.times.late_night_from) ? clock(d.times.late_night_from) : "India time"} onChange={(e) => setTime("late_night_from", e.target.value)} />
                <TextField label="Until" type="time" value={d.times.late_night_to} error={issues.late_night_to} data-testid="night-to"
                  hint={HHMM.test(d.times.late_night_to) ? `${clock(d.times.late_night_to)}${d.times.late_night_to < d.times.late_night_from ? ", the next morning" : ""}` : "India time"}
                  onChange={(e) => setTime("late_night_to", e.target.value)} />
                <OnTheBill {...wording("late_night_label", "late_night_info")} placeholder="Late night fee" />
              </>
            )}
          </Section>

          <Section icon={Percent} title="Tax and refunds"
            sub="For the marketplace's own fees (handling, small cart, platform, bad weather, late night). Delivery and cash on delivery fees are taxed with the goods in each package instead.">
            <TextField label="GST included in these fees (%)" value={d.gst} inputMode="decimal" error={issues.gst} hint="0 to 28. The bill shows the GST inside each fee." data-testid="gst-percent"
              onChange={(e) => { const v = e.target.value; setD((x) => x && { ...x, gst: v }); }} />
            <Toggle {...toggle("fees_refund_on_cancel")} label="Refund these fees when every package of an order is cancelled"
              hint="Off: the marketplace keeps the fees. A tip always goes back when nothing of the order is delivered." />
            <TextField label="SAC code on the fee invoice" value={d.text.fees_sac_code} error={issues.fees_sac_code} inputMode="numeric" maxLength={8}
              hint="The marketplace issues its own tax invoice for these fees at the first delivery" onChange={(e) => setText("fees_sac_code", e.target.value)} />
            <TextField label="Fee invoice number prefix" value={d.text.fee_invoice_prefix} error={issues.fee_invoice_prefix} maxLength={4}
              hint={`Numbers look like ${(d.text.fee_invoice_prefix || "MKT").toUpperCase()}/26-27/000001. Needs the GSTIN in Storefront → Business.`}
              onChange={(e) => setText("fee_invoice_prefix", e.target.value.toUpperCase())} />
          </Section>

          <Section icon={HandCoins} title="Delivery partner tip" on={d.flags.tip_enabled}
            sub="Shoppers can add a tip at checkout. It goes to the delivery partner in full: it is not a marketplace fee or part of a seller's sale.">
            <Toggle {...toggle("tip_enabled")} label="Let shoppers add a tip" hint="Shown at checkout with the amounts below." className="sm:col-span-2" />
            {(d.flags.tip_enabled || has("tip_max_paise")) && (
              <>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <p id="tip-amounts" className="text-sm font-medium text-ink">Amounts to pick from</p>
                  <ul className="flex flex-wrap items-center gap-2" aria-labelledby="tip-amounts" data-testid="tip-presets">
                    {d.tips.map((t) => (
                      <li key={t} className="inline-flex h-9 items-center gap-1 rounded-full bg-peacock-light pl-3.5 pr-1 font-semibold text-peacock">
                        {rupees(t)}
                        <button type="button" aria-label={`Remove ${rupees(t)}`} title={d.tips.length === 1 ? "Keep at least one amount" : undefined} disabled={d.tips.length === 1}
                          onClick={() => removeTip(t)} className="grid h-7 w-7 place-items-center rounded-full hover:bg-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent">
                          <X className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </li>
                    ))}
                    {d.tips.length < 4 && (
                      <li className="flex items-center gap-2">
                        <Input value={tipText} inputMode="decimal" placeholder="Amount" aria-label="New tip amount in rupees" aria-describedby="tip-help" invalid={!!tipError} className="w-28" data-testid="tip-new"
                          onChange={(e) => { setTipText(e.target.value); setTipError(null); }}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTip(); } }} />
                        <Button type="button" variant="secondary" onClick={addTip}><Plus className="h-4 w-4" aria-hidden />Add</Button>
                      </li>
                    )}
                  </ul>
                  <p id="tip-help" className={tipError ? "text-sm text-vermilion" : "text-xs text-ink-faint"}>{tipError ?? "Up to 4 amounts, from ₹1 to ₹1,000 each."}</p>
                </div>
                <TextField label="Largest tip (₹)" {...money("tip_max_paise")} hint="The most a shopper can tip on one order" />
                {tipsOver.length > 0 && (
                  <p className="rounded-lg bg-marigold-light px-3 py-2 text-sm text-ink sm:col-span-2">
                    {tipsOver.map(rupees).join(", ")} {tipsOver.length === 1 ? "is" : "are"} more than the largest tip, so shoppers could not pick {tipsOver.length === 1 ? "it" : "them"}.
                  </p>
                )}
              </>
            )}
          </Section>

          <Section icon={ListChecks} title="Checkout options" sub="Extra choices shoppers see at checkout.">
            <Toggle {...toggle("gstin_enabled")} label="Business purchases (GSTIN on the invoice)" hint="Shoppers can add a GSTIN and business name; the sellers' tax invoices are made out to the business." />
            <Toggle {...toggle("instructions_enabled")} label="Delivery instructions" hint="Shoppers can leave a note for the delivery partner or courier." />
            <Toggle {...toggle("no_bag_enabled")} label="I don't need a bag" hint="Shoppers can ask for their order without a carry bag." />
            <Toggle {...toggle("gift_message_enabled")} label="Gift message" hint="Shoppers can add a short message the seller packs with the order." />
            {d.flags.gift_message_enabled && (
              <TextField label="Longest gift message (characters)" value={d.giftMax} inputMode="numeric" error={issues.gift_max} hint="20 to 300"
                onChange={(e) => { const v = e.target.value; setD((x) => x && { ...x, giftMax: v }); }} />
            )}
            <Toggle {...toggle("delivery_slots_enabled")} label="Preferred delivery time" hint="Shoppers can pick a time of day. Sellers and the delivery team see it as a request, not a promise." />
            {d.flags.delivery_slots_enabled && (
              <TextField label="Choices (split with ;)" value={d.slots} error={issues.slots} hint="2 to 6 choices, like Morning; Afternoon; Evening"
                onChange={(e) => { const v = e.target.value; setD((x) => x && { ...x, slots: v }); }} />
            )}
            <LongText label="Cancellation note" hint="Shown at checkout" value={d.text.cancellation_note} max={600} onChange={(v) => setText("cancellation_note", v)} className="sm:col-span-2" />
          </Section>

          <div className="sticky bottom-0 z-20 -mx-1 flex flex-col gap-2 bg-gradient-to-t from-mist via-mist/90 to-transparent px-1 pb-2 pt-6">
            <ErrorNote message={message} />
            <div className={clsx("flex items-center gap-3 rounded-2xl bg-white py-2 pl-4 pr-2 shadow-lg ring-1 ring-black/5", docked && "mr-[72px] xl:mr-0")}>
              <div className="min-w-0 flex-1 text-sm leading-snug">
                {dirty ? (
                  <p className="flex items-center gap-1.5 font-semibold text-ink"><span className="h-2 w-2 shrink-0 rounded-full bg-marigold" aria-hidden />Unsaved changes</p>
                ) : (
                  <p className="flex items-center gap-1.5 font-semibold text-leaf"><CircleCheck className="h-4 w-4 shrink-0" aria-hidden />All changes saved</p>
                )}
                <button type="button" className="font-semibold text-peacock hover:underline xl:hidden"
                  onClick={() => document.getElementById("bill-preview")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                  See the bill{shown ? `: ${rupees(shown.bill.total)}` : ""}
                </button>
              </div>
              <Button type="submit" size="lg" loading={busy} className="shrink-0" data-testid="save-checkout">
                <span className="sm:hidden">Save</span>
                <span className="hidden sm:inline">Save changes</span>
              </Button>
            </div>
          </div>
        </form>

        <aside id="bill-preview" aria-label="Bill preview" data-testid="checkout-preview"
          className={clsx("flex scroll-mt-24 flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5 xl:sticky xl:top-[84px] xl:overflow-y-auto",
            docked ? "xl:max-h-[calc(100vh-172px)]" : "xl:max-h-[calc(100vh-96px)]")}>
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-marigold-light text-marigold-dark" aria-hidden>
              <Receipt className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-lg font-semibold">Live preview</h2>
                {dirty && <Pill tone="amber">Not saved yet</Pill>}
              </div>
              <p className="text-sm text-ink-soft">The bill for a sample order from one seller, with the values on this page.</p>
            </div>
            {updating && (
              <span className="inline-flex h-7 shrink-0 items-center gap-1 text-xs font-semibold text-ink-faint">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Updating
              </span>
            )}
          </div>

          <div className="rounded-xl bg-mist p-3">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
              <Field label="Item total (₹)" className="w-32">
                <Input value={sample.items} inputMode="decimal" invalid={sampleItems === null} aria-invalid={sampleItems === null} data-testid="preview-items"
                  onChange={(e) => { const v = e.target.value; setSample((s) => ({ ...s, items: v })); }} />
              </Field>
              <label className={clsx("flex h-10 items-center gap-2 font-medium", codOn ? "cursor-pointer" : "cursor-not-allowed text-ink-faint")}>
                <input type="checkbox" className="h-4 w-4 accent-peacock" checked={sample.cod && codOn} disabled={!codOn} data-testid="preview-cod"
                  onChange={(e) => { const v = e.target.checked; setSample((s) => ({ ...s, cod: v })); }} />
                Cash on delivery
              </label>
              {nightOn && (
                <label className="flex h-10 cursor-pointer items-center gap-2 font-medium">
                  <input type="checkbox" className="h-4 w-4 accent-peacock" checked={sample.night} data-testid="preview-night"
                    onChange={(e) => { const v = e.target.checked; setSample((s) => ({ ...s, night: v })); }} />
                  Placed late at night
                </label>
              )}
            </div>
            {sampleItems === null ? (
              <p className="mt-1.5 text-sm text-vermilion">Enter rupees, like 500</p>
            ) : !codOn ? (
              <p className="mt-1.5 text-xs text-ink-faint">Cash on delivery is off, so shoppers cannot choose it.</p>
            ) : null}
          </div>

          <div className={clsx("transition-opacity", (updating || previewKey === null) && "opacity-60")} aria-busy={updating}>
            {shown ? (
              <BillDetails
                bill={{ items_total: shown.bill.items_total, shipping_total: shown.bill.shipping, cod_fee: shown.bill.cod_fee, fees: shown.bill.fees, grand_total: shown.bill.total }}
                hints={shown.bill.hints}
                totalLabel="To pay"
                deliveryLabel={d.text.delivery_label}
                deliveryInfo={d.text.delivery_info}
              />
            ) : previewError ? null : (
              <BillSkeleton />
            )}
          </div>

          {previewKey === null && sampleItems !== null && <p className="text-sm text-vermilion">Fix the highlighted amounts to update the preview.</p>}
          {previewError && (
            <div className="flex flex-col items-start gap-2">
              <ErrorNote message={previewError} />
              <Button type="button" variant="secondary" size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>
            </div>
          )}
          {codRefused && codMax !== null && (
            <p className="rounded-xl bg-marigold-light px-3 py-2 text-sm text-ink">Cash on delivery is not offered on this order: it is above the {rupees(codMax)} limit.</p>
          )}
          <p className="border-t border-line pt-3 text-xs leading-relaxed text-ink-faint">
            Shoppers see this bill in the cart, at checkout and on their order. A tip and a coupon, when they add one, show above the total.
          </p>
        </aside>
      </div>
    </div>
  );
}
