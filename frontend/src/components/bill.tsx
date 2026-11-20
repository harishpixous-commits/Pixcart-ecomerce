"use client";

/*
 * The bill shown in the cart, at checkout and on the order page: item total (with M.R.P. struck through), delivery,
 * cash on delivery, the marketplace's own fees (each with a tap-to-read explanation and the GST inside it, a
 * struck-through regular amount when the fee is discounted), the delivery partner tip, the coupon and the amount to pay.
 * Every number comes from the server; this component only lays them out.
 */

import clsx from "clsx";
import { BadgePercent, ChevronDown, Truck } from "lucide-react";
import { useId, useState } from "react";
import { rupees } from "@/lib/format";
import type { FeeLine } from "@/lib/types";

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

function Explained({ label, info, gst, gstBps }: { label: string; info: string; gst?: number; gstBps?: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!info && !gst) return <dt>{label}</dt>;
  return (
    <dt>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 border-b border-dashed border-ink-faint text-left leading-snug hover:border-peacock hover:text-peacock">
        {label}
        <ChevronDown className={clsx("h-3.5 w-3.5 text-ink-faint transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <span id={id} className="mt-1 block rounded-lg bg-mist px-2.5 py-1.5 text-xs font-normal leading-relaxed text-ink-soft">
          {info}
          {gst ? <span className="block">Includes GST of {rupees(gst)}{gstBps ? ` (${gstBps / 100}%)` : ""}.</span> : null}
        </span>
      )}
    </dt>
  );
}

function Amount({ value, was, free }: { value: number; was?: number; free?: boolean }) {
  return (
    <dd className="whitespace-nowrap text-right tabular-nums">
      {was && was > value ? <span className="mr-1.5 text-sm text-ink-faint line-through">{rupees(was)}</span> : null}
      {free ? <span className="font-semibold text-leaf">FREE</span> : rupees(value)}
    </dd>
  );
}

export function BillDetails({ bill, deliveryLabel = "Delivery fee", deliveryInfo = "", hints = [], totalLabel = "To pay", className }: {
  bill: BillData; deliveryLabel?: string; deliveryInfo?: string; hints?: string[]; totalLabel?: string; className?: string;
}) {
  const mrpSaving = Math.max(0, (bill.mrp_total ?? bill.items_total) - bill.items_total);
  const savings = mrpSaving + (bill.fee_savings ?? 0) + (bill.coupon_discount ?? 0);
  return (
    <section className={clsx("flex flex-col gap-3", className)} aria-label="Bill details" data-testid="bill">
      <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Bill details</h2>
      <dl className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2.5 text-[15px]">
        <dt>Item total{bill.item_count ? <span className="text-ink-faint"> ({bill.item_count} item{bill.item_count === 1 ? "" : "s"})</span> : null}</dt>
        <Amount value={bill.items_total} was={bill.mrp_total} />
        <Explained label={deliveryLabel} info={deliveryInfo} />
        <Amount value={bill.shipping_total} free={bill.shipping_total === 0} />
        {bill.cod_fee ? (<><dt>Cash on delivery fee</dt><Amount value={bill.cod_fee} /></>) : null}
        {(bill.fees ?? []).map((f) => (
          <div key={f.code} className="contents" data-testid={`fee-${f.code}`}>
            <Explained label={f.label} info={f.info} gst={f.gst} gstBps={f.gst_bps} />
            <Amount value={f.amount} was={f.list_amount} />
            {f.hint && <p className="col-span-2 -mt-1.5 text-xs text-ink-faint">{f.hint}</p>}
          </div>
        ))}
        {bill.tip ? (<><dt>Delivery partner tip</dt><Amount value={bill.tip} /></>) : null}
        {bill.coupon_discount ? (
          <>
            <dt className="text-leaf">Coupon{bill.coupon_code ? ` ${bill.coupon_code}` : ""}</dt>
            <dd className="text-right font-semibold tabular-nums text-leaf">−{rupees(bill.coupon_discount)}</dd>
          </>
        ) : null}
        <dt className="mt-1 border-t border-dashed border-line pt-3 font-display text-lg font-bold">{totalLabel}</dt>
        <dd className="mt-1 border-t border-dashed border-line pt-3 text-right font-display text-lg font-bold tabular-nums" data-testid="bill-total">{rupees(bill.grand_total)}</dd>
      </dl>
      {savings > 0 && (
        <p className="flex items-center gap-2 rounded-xl bg-leaf-light px-3 py-2 text-sm font-semibold text-leaf" data-testid="bill-savings">
          <BadgePercent className="h-4 w-4 shrink-0" aria-hidden /> You save {rupees(savings)} on this order
        </p>
      )}
      {hints.length > 0 && (
        <ul className="flex flex-col gap-1.5" data-testid="bill-hints">
          {hints.map((h) => (
            <li key={h} className="flex items-start gap-2 rounded-xl bg-marigold-light/70 px-3 py-2 text-sm text-ink">
              <Truck className="mt-0.5 h-4 w-4 shrink-0 text-marigold-dark" aria-hidden /> {h}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
