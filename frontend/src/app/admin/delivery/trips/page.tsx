"use client";

/* Admin → Delivery → Trips: every delivery request and trip, by status, searchable by order, partner name or mobile. */

import { ChevronRight, MapPin, Search, Store, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { TripPill } from "@/components/delivery/trip";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { EmptyState, ErrorNote, Input, PageLoader, Pagination } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import type { TripView } from "@/lib/delivery-types";
import { dateTime, rupees } from "@/lib/format";

type Data = { items: TripView[]; total: number; page: number; page_size: number };

const TABS: [string, string][] = [
  ["active", "In progress"],
  ["offered", "Requests"],
  ["delivered", "Delivered"],
  ["failed", "Not delivered"],
  ["cancelled", "Cancelled"],
  ["rejected", "Declined"],
  ["expired", "Missed"],
  ["", "All"],
];

function TripsPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const status = sp.get("status") ?? "active";
  const partnerId = sp.get("partner_id") ?? "";
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const track = useMemo(() => latestOnly(), []);

  const load = useCallback(() => {
    track(api<Data>("/api/admin/delivery/trips", { query: { status: status === "" ? undefined : status, q: query || undefined, partner_id: partnerId || undefined, page } }),
      (x) => { setD(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load trips"));
  }, [status, query, partnerId, page, track]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const go = (next: { status?: string; partner_id?: string }) => {
    const params = new URLSearchParams();
    const s = next.status ?? status;
    const p = next.partner_id ?? partnerId;
    params.set("status", s);
    if (p) params.set("partner_id", p);
    setPage(1);
    router.replace(`/admin/delivery/trips?${params.toString()}`);
  };
  const partnerName = partnerId && d?.items[0]?.partner.id === partnerId ? d.items[0].partner.name : partnerId ? "this partner" : "";

  return (
    <div>
      <PageHeader title="Delivery trips" sub="Every delivery request and trip, with its partner, step and money." />
      <Tabs value={status} onChange={(v) => go({ status: v })} items={TABS.map(([value, label]) => ({ value, label }))} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order number, partner name or mobile" aria-label="Search trips" className="pl-9" />
        </div>
        {partnerId && (
          <button type="button" onClick={() => go({ partner_id: "" })} className="inline-flex h-10 items-center gap-1.5 rounded-full bg-peacock-light px-3 text-sm font-semibold text-peacock">
            Partner: {partnerName} <X className="h-4 w-4" aria-label="Show all partners" />
          </button>
        )}
      </div>
      <ErrorNote message={error} />
      {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? (
        <EmptyState title="No trips here" body={status === "active" ? "Trips show up here while a partner is carrying a package." : undefined} />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="trip-list">
          {d.items.map((t) => (
            <li key={t.id}>
              <Link href={`/admin/delivery/trips/${t.id}`} className="flex flex-col gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/5 transition hover:ring-peacock/30 sm:flex-row sm:items-center sm:gap-4 sm:p-4">
                <span className="flex min-w-0 flex-wrap items-center gap-2 sm:w-64">
                  <span className="font-semibold">{t.order_number}</span>
                  <TripPill trip={t} />
                  {t.kind === "return" && <span className="text-xs font-semibold text-marigold-dark">Return</span>}
                  <span className="w-full text-xs text-ink-faint">{dateTime(t.assigned_at)} · {t.mode === "auto" ? "auto-assign" : "by staff"}</span>
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink-soft">
                  <Store className="h-4 w-4 shrink-0 text-marigold-dark" aria-hidden /><span className="truncate">{t.pickup.name}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  <MapPin className="h-4 w-4 shrink-0 text-vermilion" aria-hidden /><span className="truncate">{t.drop.name ? `${t.drop.name}, ` : ""}{[t.drop.city, t.drop.pincode].filter(Boolean).join(" ")}</span>
                </span>
                <span className="flex flex-wrap items-center gap-3 text-sm sm:w-72 sm:justify-end">
                  <span className="font-medium">{t.partner.name}</span>
                  {t.cod_amount > 0 && <span className="rounded-full bg-marigold-light px-2 py-0.5 text-xs font-semibold text-[#8A5A00]">COD {rupees(t.cod_amount)}</span>}
                  {t.status === "delivered" && <span className="text-xs text-ink-soft">Fee {rupees(t.fee + t.tip)}</span>}
                  <ChevronRight className="hidden h-5 w-5 text-ink-faint sm:block" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {d && <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<PageLoader />}><TripsPage /></Suspense>;
}
