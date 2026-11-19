"use client";

/*
 * Deals as the seller hub and the admin see them: one card per deal with its product, price, time window, units claimed
 * and status. The pages add their own buttons (cancel, approve, reject, stop).
 */

import { CalendarClock, Timer, Zap, type LucideIcon } from "lucide-react";
import { DealCountdown } from "@/components/product";
import { Pill } from "@/components/ui";
import { dateTime, duration, rupees } from "@/lib/format";

export type DealKind = "lightning" | "deal_of_day" | "limited";
export const DEAL_KINDS: DealKind[] = ["lightning", "deal_of_day", "limited"];

export type DealRow = {
  id: string; kind: DealKind; kind_label: string; status: string; note: string; product: string; slug: string; product_id: string;
  variant_id: string; variant: string; image: string; stock: number; seller: string; seller_id: string; deal_price: number;
  regular_price: number; mrp: number; discount_pct: number; starts_at: string; ends_at: string; qty_limit: number | null;
  sold_qty: number; created_at: string;
};

export type DealRules = {
  enabled: boolean; need_approval: boolean; min_discount_pct: number; max_hours_lightning: number; max_hours_day: number;
  max_days_limited: number; kinds: Record<DealKind, string>;
};

type Tone = "green" | "amber" | "red" | "blue" | "gray";
export const DEAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for approval", tone: "amber" },
  approved: { label: "Scheduled", tone: "blue" },
  active: { label: "Running", tone: "green" },
  ended: { label: "Ended", tone: "gray" },
  rejected: { label: "Not approved", tone: "red" },
  cancelled: { label: "Cancelled", tone: "gray" },
};

/** Statuses a deal can still be stopped from. */
export const DEAL_OPEN = ["pending", "approved", "active"];

export const KIND_ICON: Record<DealKind, LucideIcon> = { lightning: Zap, deal_of_day: Timer, limited: CalendarClock };

export function kindText(kind: DealKind, r: DealRules): string {
  if (kind === "lightning") return `A few hours with a set number of units and a "claimed" bar. Up to ${r.max_hours_lightning} hours.`;
  if (kind === "deal_of_day") return `A one-day offer shown with a countdown. Up to ${r.max_hours_day} hours.`;
  return `A sale price for several days. Up to ${r.max_days_limited} days.`;
}

/** The longest a deal of this kind may run, in milliseconds. */
export function maxDealMs(kind: DealKind, r: DealRules): number {
  if (kind === "limited") return r.max_days_limited * 86_400_000;
  return (kind === "lightning" ? r.max_hours_lightning : r.max_hours_day) * 3_600_000;
}

export function DealItem({ d, showSeller, actions }: { d: DealRow; showSeller?: boolean; actions?: React.ReactNode }) {
  const st = DEAL_STATUS[d.status] ?? { label: d.status, tone: "gray" as Tone };
  const Icon = KIND_ICON[d.kind] ?? Zap;
  const span = new Date(d.ends_at).getTime() - new Date(d.starts_at).getTime();
  const claimed = d.qty_limit ? Math.min(100, Math.round((100 * d.sold_qty) / d.qty_limit)) : null;
  return (
    <article className="flex gap-3 rounded-xl bg-white p-4" data-testid="deal-row">
      {d.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={d.image} alt="" className="h-16 w-16 shrink-0 rounded-lg object-contain ring-1 ring-line sm:h-20 sm:w-20" />
      ) : (
        <div className="h-16 w-16 shrink-0 rounded-lg bg-mist sm:h-20 sm:w-20" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start gap-2">
          <a href={`/p/${d.slug}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 font-semibold hover:text-peacock">{d.product}</a>
          <Pill tone={st.tone}>{st.label}</Pill>
        </div>
        <p className="text-sm text-ink-soft">
          {d.variant}
          {showSeller && <> · Sold by <span className="font-medium text-ink">{d.seller}</span></>}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1 rounded-full bg-vermilion-light px-2 py-0.5 text-xs font-semibold text-vermilion">
            <Icon className="h-3.5 w-3.5" aria-hidden /> {d.kind_label}
          </span>
          <span>
            <span className="font-display text-base font-bold">{rupees(d.deal_price)}</span>
            {d.regular_price > d.deal_price && <span className="ml-1 text-ink-faint line-through">{rupees(d.regular_price)}</span>}
          </span>
          {d.discount_pct > 0 && <span className="font-semibold text-leaf">{d.discount_pct}% off M.R.P.</span>}
        </div>
        <p className="mt-1 text-sm text-ink-soft">
          {dateTime(d.starts_at)} to {dateTime(d.ends_at)} ({duration(span)})
          {d.status === "active" && <> · <DealCountdown endsAt={d.ends_at} className="font-medium text-vermilion" /></>}
          {d.status === "approved" && <> · <DealCountdown endsAt={d.starts_at} prefix="Starts in" doneText="Starting now" className="font-medium text-peacock" /></>}
        </p>
        {d.qty_limit ? (
          <div className="mt-2 flex max-w-md items-center gap-2 text-xs text-ink-soft">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-mist">
              <span className="block h-full rounded-full bg-vermilion" style={{ width: `${claimed}%` }} />
            </span>
            <span className="shrink-0">{d.sold_qty} of {d.qty_limit} units claimed</span>
          </div>
        ) : d.sold_qty > 0 ? (
          <p className="mt-1 text-xs text-ink-soft">{d.sold_qty} sold at the deal price</p>
        ) : null}
        {d.note && <p className="mt-2 rounded-lg bg-mist px-3 py-2 text-sm">{d.note}</p>}
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
    </article>
  );
}
