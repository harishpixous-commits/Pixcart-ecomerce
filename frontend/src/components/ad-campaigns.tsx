"use client";

/*
 * Sponsored-product campaigns as the seller hub and the admin see them: status, products, where the ads show, the bid
 * and budgets with today's spend, and the results (impressions, clicks, invalid clicks, spend, ad sales, ACOS).
 */

import clsx from "clsx";
import { Pill } from "@/components/ui";
import { date, rupees } from "@/lib/format";

export type AdStats = {
  impressions: number; clicks: number; invalid_clicks: number; spend: number; orders: number; sales: number; ctr: number; acos: number | null;
};

export type Campaign = {
  id: string; name: string; status: string; note: string; placements: string[]; keywords: string[]; bid_paise: number;
  daily_budget_paise: number; total_budget_paise: number | null; starts_at: string; ends_at: string | null; spend_paise: number;
  spent_today_paise: number; products: { id: string; title: string; slug: string; image: string }[]; stats: AdStats; created_at: string;
  seller?: string; seller_id?: string;
};

export type AdRules = {
  enabled: boolean; need_approval: boolean; min_bid_paise: number; min_daily_budget_paise: number; gst_bps: number;
  placements: Record<string, { label: string; enabled: boolean }>; attribution_days: number;
  link_hours: number; paid_clicks_per_address: number; paid_clicks_per_network: number;
};

type Tone = "green" | "amber" | "red" | "blue" | "gray";
export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for approval", tone: "amber" },
  active: { label: "Running", tone: "green" },
  paused: { label: "Paused", tone: "gray" },
  rejected: { label: "Not approved", tone: "red" },
  ended: { label: "Ended", tone: "gray" },
};

export const PLACEMENT_LABEL: Record<string, string> = { search: "Search results", product: "Product pages", home: "Home page" };

/** Why a running campaign is not showing right now, if it is not. */
export function deliveryNote(c: Campaign, now: number): string | null {
  if (c.status !== "active") return null;
  if (new Date(c.starts_at).getTime() > now) return `Starts ${date(c.starts_at)}`;
  if (c.ends_at && new Date(c.ends_at).getTime() <= now) return "Finished";
  if (c.spent_today_paise + c.bid_paise > c.daily_budget_paise) return "Today's budget is used up; ads show again tomorrow";
  if (c.total_budget_paise !== null && c.spend_paise + c.bid_paise > c.total_budget_paise) return "Total budget is used up";
  return null;
}

export type AdDay = { day: string; impressions: number; clicks: number; invalid_clicks: number; spend: number };

/** A continuous run of days ending today (days without ads as zero), for the charts. */
export function fillDays(rows: AdDay[], days: number): { date: string; impressions: number; clicks: number; invalid_clicks: number; spend: number }[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const out = [];
  for (let k = days - 1; k >= 0; k--) {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - k);
    const key = d.toISOString().slice(0, 10);
    const r = byDay.get(key);
    out.push({ date: key, impressions: r?.impressions ?? 0, clicks: r?.clicks ?? 0, invalid_clicks: r?.invalid_clicks ?? 0, spend: r?.spend ?? 0 });
  }
  return out;
}

export function StatsLine({ s, className }: { s: AdStats; className?: string }) {
  const cells: [string, string][] = [
    ["Impressions", s.impressions.toLocaleString("en-IN")],
    ["Clicks", s.clicks.toLocaleString("en-IN")],
    ["Invalid", s.invalid_clicks.toLocaleString("en-IN")],
    ["CTR", `${s.ctr}%`],
    ["Spend", rupees(s.spend)],
    ["Orders", s.orders.toLocaleString("en-IN")],
    ["Ad sales", rupees(s.sales)],
    ["ACOS", s.acos === null ? "—" : `${s.acos}%`],
  ];
  return (
    <dl className={clsx("grid grid-cols-4 gap-x-3 gap-y-2 rounded-lg bg-mist/70 p-3 lg:grid-cols-8", className)}>
      {cells.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-ink-faint">{k}</dt>
          <dd className="truncate font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Meter({ used, of }: { used: number; of: number }) {
  const pct = of > 0 ? Math.min(100, Math.round((100 * used) / of)) : 0;
  return (
    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-mist">
      <span className={clsx("block h-full rounded-full", pct >= 90 ? "bg-vermilion" : "bg-peacock")} style={{ width: `${pct}%` }} />
    </span>
  );
}

export function CampaignCard({ c, now, showSeller, actions }: { c: Campaign; now: number; showSeller?: boolean; actions?: React.ReactNode }) {
  const st = CAMPAIGN_STATUS[c.status] ?? { label: c.status, tone: "gray" as Tone };
  const note = deliveryNote(c, now);
  return (
    <article className="rounded-xl bg-white p-4" data-testid="campaign">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{c.name}</h3>
          <p className="text-xs text-ink-faint">
            {showSeller && c.seller ? <>{c.seller} · </> : null}
            {date(c.starts_at)}{c.ends_at ? ` to ${date(c.ends_at)}` : ", no end date"}
          </p>
        </div>
        <Pill tone={st.tone}>{st.label}</Pill>
      </div>
      {note && <p className="mt-2 rounded-lg bg-marigold-light px-3 py-1.5 text-sm">{note}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {c.products.slice(0, 6).map((p) => (
          <a key={p.id} href={`/p/${p.slug}`} target="_blank" rel="noreferrer" title={p.title} className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {p.image ? <img src={p.image} alt={p.title} className="h-11 w-11 rounded-lg bg-white object-contain ring-1 ring-line" /> : <span className="block h-11 w-11 rounded-lg bg-mist" />}
          </a>
        ))}
        {c.products.length > 6 && <span className="text-sm text-ink-soft">+{c.products.length - 6} more</span>}
        <span className="text-sm text-ink-soft">{c.products.length} product{c.products.length === 1 ? "" : "s"}</span>
      </div>
      <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <p className="text-ink-faint">Shows on</p>
          <p className="font-medium">{c.placements.map((p) => PLACEMENT_LABEL[p] ?? p).join(", ")}</p>
          {c.keywords.length > 0 && <p className="mt-0.5 line-clamp-2 text-xs text-ink-soft">Keywords: {c.keywords.join(", ")}</p>}
        </div>
        <div>
          <p className="text-ink-faint">Today</p>
          <p className="font-medium">{rupees(c.spent_today_paise)} of {rupees(c.daily_budget_paise)} · bid {rupees(c.bid_paise)}/click</p>
          <Meter used={c.spent_today_paise} of={c.daily_budget_paise} />
        </div>
        <div>
          <p className="text-ink-faint">Total spent</p>
          <p className="font-medium">{rupees(c.spend_paise)}{c.total_budget_paise ? ` of ${rupees(c.total_budget_paise)}` : ""}</p>
          {c.total_budget_paise ? <Meter used={c.spend_paise} of={c.total_budget_paise} /> : <p className="text-xs text-ink-faint">No total limit</p>}
        </div>
      </div>
      <StatsLine s={c.stats} className="mt-3" />
      {c.note && <p className="mt-2 rounded-lg bg-mist px-3 py-2 text-sm"><span className="font-semibold">Note:</span> {c.note}</p>}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </article>
  );
}
