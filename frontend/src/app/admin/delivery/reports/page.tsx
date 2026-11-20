"use client";

/*
 * Admin → Delivery → Reports: deliveries per day (delivered and not delivered), success rate, cash collected, and how
 * each partner performs (deliveries, failures, declines, average time from accepting to delivering, earnings, rating).
 */

import clsx from "clsx";
import { Banknote, CheckCircle2, Download, Percent, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ColumnChart } from "@/components/charts/columns";
import { Kpi } from "@/components/delivery/admin";
import { PageHeader } from "@/components/portal-shell";
import { ErrorNote, PageLoader } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { rupees } from "@/lib/format";

type Report = {
  days: { date: string; delivered: number; failed: number; cod: number }[];
  delivered: number; failed: number; success_rate: number | null; cod_collected: number;
  partners: { id: string; name: string; rating_avg: number; rating_count: number; delivered: number; failed: number; declined: number; earned: number; cod: number;
    avg_minutes: number | null; success_rate: number | null }[];
};

const RANGES = [7, 30, 90, 180];

function short(iso: string) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function DeliveryReports() {
  const [days, setDays] = useState(30);
  const [r, setR] = useState<{ days: number; data: Report } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [track] = useState(latestOnly);
  const load = useCallback(() => {
    track(api<Report>("/api/admin/delivery/reports", { query: { days } }), (x) => { setR({ days, data: x }); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the report"));
  }, [days, track]);
  useEffect(() => { load(); }, [load]);

  function download(rep: Report) {
    const head = ["Partner", "Delivered", "Not delivered", "Declined or missed", "Success rate %", "Avg minutes accept to deliver", "Earned (₹)", "Cash collected (₹)", "Rating", "Ratings"];
    const rows = rep.partners.map((p) => [p.name, p.delivered, p.failed, p.declined, p.success_rate ?? "", p.avg_minutes ?? "", (p.earned / 100).toFixed(2), (p.cod / 100).toFixed(2), p.rating_avg, p.rating_count]);
    const blob = new Blob(["﻿" + [head, ...rows].map((x) => x.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `delivery-partners-${days}-days.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const rep = r?.data ?? null;
  const stale = !!r && r.days !== days; // the previous report stays on screen, faded, while the new one loads
  const every = days <= 7 ? 1 : days <= 30 ? 5 : days <= 90 ? 15 : 30;
  return (
    <div className="flex flex-col gap-4" data-testid="delivery-reports">
      <PageHeader title="Delivery reports" sub="How the delivery fleet performs: deliveries, failures, cash collected and each partner's numbers." />
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Period">
        {RANGES.map((n) => (
          <button key={n} type="button" role="tab" aria-selected={days === n} onClick={() => setDays(n)}
            className={clsx("rounded-full px-3.5 py-1.5 text-sm font-semibold", days === n ? "bg-peacock text-white" : "bg-white text-ink-soft ring-1 ring-line hover:text-ink")}>
            Last {n} days
          </button>
        ))}
      </div>
      <ErrorNote message={error} />
      {!rep ? (error ? null : <PageLoader />) : (
        <div className={clsx("flex flex-col gap-4 transition-opacity", stale && "opacity-60")}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi icon={CheckCircle2} label="Delivered" value={rep.delivered.toLocaleString("en-IN")} tone="green" />
            <Kpi icon={XCircle} label="Not delivered" value={rep.failed.toLocaleString("en-IN")} tone={rep.failed ? "red" : "gray"} hint="Failed attempts" />
            <Kpi icon={Percent} label="Success rate" value={rep.success_rate === null ? "–" : `${rep.success_rate}%`} tone="blue" hint="Delivered of all attempts" />
            <Kpi icon={Banknote} label="Cash collected" value={rupees(rep.cod_collected)} tone="amber" hint="Cash on delivery" />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
              <h2 className="font-semibold">Deliveries per day</h2>
              <p className="mb-3 text-sm text-ink-soft">Delivered and not delivered attempts</p>
              <ColumnChart
                caption={`Deliveries per day, last ${days} days`}
                series={[{ key: "delivered", label: "Delivered" }, { key: "failed", label: "Not delivered" }]}
                data={rep.days.map((x, i) => ({ key: x.date, label: short(x.date), title: short(x.date), values: { delivered: x.delivered, failed: x.failed }, highlight: i === rep.days.length - 1 }))}
                format={(n) => Math.round(n).toLocaleString("en-IN")}
                labelEvery={every}
              />
            </section>
            <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
              <h2 className="font-semibold">Cash collected per day</h2>
              <p className="mb-3 text-sm text-ink-soft">Cash on delivery handed over by customers</p>
              <ColumnChart
                caption={`Cash collected per day, last ${days} days`}
                series={[{ key: "cod", label: "Cash collected" }]}
                data={rep.days.map((x, i) => ({ key: x.date, label: short(x.date), title: short(x.date), values: { cod: x.cod }, highlight: i === rep.days.length - 1 }))}
                format={(n) => rupees(Math.round(n))}
                labelEvery={every}
              />
            </section>
          </div>
          <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">Partners</h2>
              {rep.partners.length > 0 && (
                <button type="button" onClick={() => download(rep)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-peacock"><Download className="h-4 w-4" aria-hidden />Download CSV</button>
              )}
            </div>
            {rep.partners.length === 0 ? <p className="text-ink-soft">No deliveries in this period.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm" data-testid="partner-report">
                  <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-faint">
                    <tr>
                      <th className="py-2 pr-3 font-semibold">Partner</th>
                      <th className="px-3 py-2 text-right font-semibold">Delivered</th>
                      <th className="px-3 py-2 text-right font-semibold">Not delivered</th>
                      <th className="px-3 py-2 text-right font-semibold">Declined or missed</th>
                      <th className="px-3 py-2 text-right font-semibold">Success</th>
                      <th className="px-3 py-2 text-right font-semibold">Avg time</th>
                      <th className="px-3 py-2 text-right font-semibold">Earned</th>
                      <th className="px-3 py-2 text-right font-semibold">Cash</th>
                      <th className="py-2 pl-3 text-right font-semibold">Rating</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line tabular-nums">
                    {rep.partners.map((p) => (
                      <tr key={p.id}>
                        <td className="py-2 pr-3 font-semibold">{p.name}</td>
                        <td className="px-3 py-2 text-right">{p.delivered}</td>
                        <td className={clsx("px-3 py-2 text-right", p.failed > 0 && "text-vermilion")}>{p.failed}</td>
                        <td className="px-3 py-2 text-right">{p.declined}</td>
                        <td className="px-3 py-2 text-right">{p.success_rate === null ? "–" : `${p.success_rate}%`}</td>
                        <td className="px-3 py-2 text-right">{p.avg_minutes === null ? "–" : `${Math.round(p.avg_minutes)} min`}</td>
                        <td className="px-3 py-2 text-right">{rupees(p.earned)}</td>
                        <td className="px-3 py-2 text-right">{rupees(p.cod)}</td>
                        <td className="py-2 pl-3 text-right">{p.rating_count ? `★ ${p.rating_avg.toFixed(1)} (${p.rating_count})` : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
