"use client";

/*
 * Partner trip history: every finished request and trip (delivered, not delivered, declined, missed, cancelled),
 * filtered by date range and outcome, with what was earned, the cash collected and the customer's rating.
 */

import clsx from "clsx";
import { Banknote, ChevronRight, MapPin, Star } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FullLoader } from "@/components/delivery/app";
import { TripPill } from "@/components/delivery/trip";
import { ErrorNote, Pagination } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import type { HistoryItem } from "@/lib/delivery-types";
import { dateTime, rupees } from "@/lib/format";

type Data = { items: HistoryItem[]; total: number; page: number; page_size: number };

const FILTERS: [string, string][] = [
  ["", "All"],
  ["delivered", "Delivered"],
  ["failed", "Not delivered"],
  ["rejected", "Declined"],
  ["expired", "Missed"],
  ["cancelled", "Cancelled"],
];

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const RANGES: [string, string, number | null][] = [["7", "Last 7 days", 7], ["30", "Last 30 days", 30], ["90", "Last 90 days", 90], ["all", "All time", null]];

export default function HistoryPage() {
  const [status, setStatus] = useState("");
  const [range, setRange] = useState("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [track] = useState(latestOnly);

  const load = useCallback(() => {
    let start = from;
    let end = to;
    if (range !== "custom") {
      const days = RANGES.find((r) => r[0] === range)?.[2] ?? null;
      start = days ? isoDay(new Date(Date.now() - (days - 1) * 86_400_000)) : "";
      end = "";
    }
    track(api<Data>("/api/delivery/history", { query: { status, from: start || undefined, to: end || undefined, page } }), (x) => { setD(x); setError(null); })
      .catch((x) => setError(x instanceof ApiError ? x.message : "Could not load your history"));
  }, [status, range, from, to, page, track]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3" data-testid="partner-history">
      <h1 className="px-1 font-display text-2xl font-bold">Trip history</h1>
      <div className="flex flex-col gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5">
        <div className="scroll-x -mx-1 flex gap-1.5 overflow-x-auto px-1" role="tablist" aria-label="Period">
          {[...RANGES.map((r) => [r[0], r[1]] as [string, string]), ["custom", "Pick dates"] as [string, string]].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={range === k} onClick={() => { setRange(k); setPage(1); }}
              className={clsx("shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold", range === k ? "bg-peacock text-white" : "bg-mist text-ink-soft")}>
              {label}
            </button>
          ))}
        </div>
        {range === "custom" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold text-ink-soft">From
              <input type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="mt-1 h-10 w-full rounded-lg border border-line px-2 text-sm text-ink" />
            </label>
            <label className="text-xs font-semibold text-ink-soft">To
              <input type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="mt-1 h-10 w-full rounded-lg border border-line px-2 text-sm text-ink" />
            </label>
          </div>
        )}
        <div className="scroll-x -mx-1 flex gap-1.5 overflow-x-auto px-1" role="tablist" aria-label="Outcome">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={status === k} onClick={() => { setStatus(k); setPage(1); }}
              className={clsx("shrink-0 rounded-full px-3 py-1 text-xs font-semibold ring-1", status === k ? "bg-peacock-light text-peacock ring-peacock/40" : "text-ink-soft ring-line")}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote message={error} />
      {!d ? (!error && <FullLoader label="Loading trips" />) : d.items.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-ink-soft shadow-sm ring-1 ring-black/5">No trips in this period.</p>
      ) : (
        <>
          <p className="px-1 text-sm text-ink-soft">{d.total} trip{d.total === 1 ? "" : "s"}</p>
          <ul className="flex flex-col gap-2">
            {d.items.map((t) => (
              <li key={t.id}>
                <Link href={`/delivery/trips/${t.id}`} className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/30" data-testid="history-item">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{t.order_number}</span>
                      <TripPill trip={t} />
                      {t.kind !== "delivery" && <span className="text-xs font-semibold text-marigold-dark">{t.kind === "pickup" ? "Return pickup" : "Return"}</span>}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-ink-soft">
                      <span>{dateTime(t.delivered_at ?? t.assigned_at)}</span>
                      {t.drop_area && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden />{t.drop_area}</span>}
                      {t.cod_collected > 0 && <span className="inline-flex items-center gap-1"><Banknote className="h-3.5 w-3.5" aria-hidden />{rupees(t.cod_collected)} {t.cod_method === "upi" ? "UPI" : "cash"}</span>}
                      {t.rating && <span className="inline-flex items-center gap-0.5"><Star className="h-3.5 w-3.5 fill-marigold text-marigold" aria-hidden />{t.rating}</span>}
                    </span>
                    {(t.fail_reason || (t.status !== "delivered" && t.reject_reason)) && (
                      <span className="mt-0.5 block truncate text-xs text-ink-faint">{t.fail_reason || t.reject_reason}</span>
                    )}
                  </span>
                  {t.status === "delivered" && <span className="font-display text-lg font-bold text-leaf">{rupees(t.fee + t.tip)}</span>}
                  <ChevronRight className="h-5 w-5 shrink-0 text-ink-faint" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}
