"use client";

/*
 * Partner earnings: today, this week, this month and all time (delivery fees plus customer tips), the last 7 days as
 * a chart, what is still to be paid, the cash on delivery they hold against the limit (and deposits made), and the
 * weekly payouts with their status and bank reference.
 */

import clsx from "clsx";
import { AlertTriangle, Banknote, CalendarCheck, CheckCircle2, Clock, IndianRupee, Wallet } from "lucide-react";
import { useCallback, useState } from "react";
import { FullLoader } from "@/components/delivery/app";
import { usePolling } from "@/components/delivery/trip";
import { ColumnChart } from "@/components/charts/columns";
import { ErrorNote } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { PartnerEarnings } from "@/lib/delivery-types";
import { date, dateTime, rupees } from "@/lib/format";

const DEPOSIT: Record<string, string> = { cash: "Cash at the office", upi: "UPI", bank: "Bank transfer", payout: "Taken from payout" };

function dayLabel(iso: string, short: boolean) {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-IN", short ? { weekday: "short" } : { weekday: "long", day: "numeric", month: "short" });
}

export default function EarningsPage() {
  const [e, setE] = useState<PartnerEarnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<PartnerEarnings>("/api/delivery/earnings").then((x) => { setE(x); setError(null); })
      .catch((x) => setError(x instanceof ApiError ? x.message : "Could not load your earnings"));
  }, []);
  usePolling(load, 60_000);

  if (!e) return error ? <ErrorNote message={error} /> : <FullLoader label="Loading your earnings" />;
  const last = e.days[e.days.length - 1]?.date;
  const over = e.cash_limit > 0 && e.cash_in_hand > e.cash_limit;
  const cashPct = e.cash_limit > 0 ? Math.min(100, Math.round((100 * e.cash_in_hand) / e.cash_limit)) : 0;
  return (
    <div className="flex flex-col gap-4" data-testid="partner-earnings">
      <h1 className="px-1 font-display text-2xl font-bold">Earnings</h1>

      <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-5 text-white shadow-sm">
        <p className="text-sm font-semibold text-white/80">This week</p>
        <p className="font-display text-4xl font-bold">{rupees(e.week.earned)}</p>
        <p className="mt-1 text-sm text-white/80">
          {e.week.trips} deliver{e.week.trips === 1 ? "y" : "ies"} · fees {rupees(e.week.fees)}{e.week.tips ? ` · tips ${rupees(e.week.tips)}` : ""}
          {e.week.bonuses ? ` · bad weather bonus ${rupees(e.week.bonuses)}` : ""}
        </p>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Period label="Today" p={e.today} />
          <Period label="This month" p={e.month} />
          <Period label="All time" p={e.total} />
        </div>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h2 className="font-semibold">Last 7 days</h2>
        <p className="mb-3 text-sm text-ink-soft">What you earned each day: fees, tips and bonuses</p>
        <ColumnChart
          caption="Earnings per day for the last 7 days"
          series={[{ key: "earned", label: "Earned" }]}
          data={e.days.map((d) => ({ key: d.date, label: d.date === last ? "Today" : dayLabel(d.date, true), title: `${dayLabel(d.date, false)} · ${d.trips} deliver${d.trips === 1 ? "y" : "ies"}`, values: { earned: d.earned }, highlight: d.date === last }))}
          format={(n) => rupees(Math.round(n))}
          height={150}
        />
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <section className="flex flex-col gap-1 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink-soft"><Clock className="h-4 w-4 text-peacock" aria-hidden />To be paid</p>
          <p className="font-display text-2xl font-bold">{rupees(e.unpaid)}</p>
          <p className="text-sm text-ink-soft">Earned but not yet in a payout. Payouts are made every week for the week before.</p>
        </section>
        <section className={clsx("flex flex-col gap-1 rounded-2xl p-4 shadow-sm ring-1", over ? "bg-vermilion-light ring-vermilion/30" : "bg-white ring-black/5")}>
          <p className={clsx("flex items-center gap-2 text-sm font-semibold", over ? "text-vermilion" : "text-ink-soft")}>
            {over ? <AlertTriangle className="h-4 w-4" aria-hidden /> : <Banknote className="h-4 w-4 text-marigold-dark" aria-hidden />}Cash in hand
          </p>
          <p className={clsx("font-display text-2xl font-bold", over && "text-vermilion")}>{rupees(e.cash_in_hand)}</p>
          {e.cash_limit > 0 && (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-mist" role="meter" aria-valuemin={0} aria-valuemax={e.cash_limit} aria-valuenow={e.cash_in_hand} aria-label="Cash held against the limit">
                <div className={clsx("h-full rounded-full", over ? "bg-vermilion" : cashPct > 75 ? "bg-marigold" : "bg-leaf")} style={{ width: `${cashPct}%` }} />
              </div>
              <p className="text-sm text-ink-soft">{over ? "Above" : "Limit"} {rupees(e.cash_limit)}. {over ? "Deposit the cash to keep getting cash-on-delivery orders." : "Deposit cash with the delivery team regularly."}</p>
            </>
          )}
        </section>
      </div>

      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-2 flex items-center gap-2 font-semibold"><Wallet className="h-4 w-4 text-peacock" aria-hidden />Weekly payouts</h2>
        {e.payouts.length === 0 ? (
          <p className="text-sm text-ink-soft">Your first payout appears here after your first full week of deliveries.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="payout-list">
            {e.payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <span className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", p.status === "paid" ? "bg-leaf-light text-leaf" : "bg-marigold-light text-marigold-dark")}>
                  {p.status === "paid" ? <CheckCircle2 className="h-5 w-5" aria-hidden /> : <CalendarCheck className="h-5 w-5" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{date(p.period_start)} to {date(p.period_end)}</span>
                  <span className="block text-sm text-ink-soft">
                    {p.deliveries} deliver{p.deliveries === 1 ? "y" : "ies"} · {rupees(p.amount)}{p.cod_deducted ? ` − ${rupees(p.cod_deducted)} cash held` : ""}
                  </span>
                  {p.status === "paid" && <span className="block text-xs text-ink-faint">Paid {dateTime(p.paid_at)}{p.reference ? ` · Ref ${p.reference}` : ""}</span>}
                </span>
                <span className="text-right">
                  <span className="block font-display text-lg font-bold">{rupees(p.net_amount)}</span>
                  <span className={clsx("text-xs font-semibold", p.status === "paid" ? "text-leaf" : "text-marigold-dark")}>{p.status === "paid" ? "Paid" : "Processing"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {e.deposits.length > 0 && (
        <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><IndianRupee className="h-4 w-4 text-peacock" aria-hidden />Cash deposits</h2>
          <ul className="divide-y divide-line text-sm">
            {e.deposits.map((d, i) => (
              <li key={i} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <span className="block font-medium">{DEPOSIT[d.method] ?? d.method}{d.reference ? ` · ${d.reference}` : ""}</span>
                  <span className="text-xs text-ink-faint">{dateTime(d.at)}</span>
                </span>
                <span className="font-semibold">{rupees(d.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Period({ label, p }: { label: string; p: PartnerEarnings["today"] }) {
  return (
    <div className="rounded-2xl bg-white/10 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-white/70">{label}</p>
      <p className="font-display text-lg font-bold leading-tight">{rupees(p.earned)}</p>
      <p className="text-xs text-white/70">{p.trips} trip{p.trips === 1 ? "" : "s"}</p>
    </div>
  );
}
