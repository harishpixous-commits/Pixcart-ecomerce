"use client";

/*
 * Admin → Delivery → Live partners: everyone online right now (and anyone still on a trip), in detail: where they are
 * and how fresh that position is, whether they are free or carrying packages, how long they have been online, today's
 * deliveries and earnings, the cash they hold against the limit, and their rating. The map shows the same partners
 * with the store and customer of each trip. Refreshes every 10 seconds while the page is open.
 */

import clsx from "clsx";
import {
  AlertTriangle, Banknote, Bike, ChevronRight, Clock, Hourglass, ListChecks, LocateFixed, LocateOff, MapPin, Phone, RefreshCw, Search, Star, Store, UserRound, Wifi,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { Kpi, OnlineDot, PartnerAvatar } from "@/components/delivery/admin";
import { initials, minutesLabel, secondsLabel, telUrl, time, TripPill, useNow, usePolling } from "@/components/delivery/trip";
import type { MapLine, MapMarker } from "@/components/map/live-map";
import { PageHeader } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Input, PageLoader, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { LiveData, LivePartner, TripView } from "@/lib/delivery-types";
import { rupees } from "@/lib/format";

const LiveMap = dynamic(() => import("@/components/map/live-map").then((m) => m.LiveMap), {
  ssr: false,
  loading: () => <div className="h-full min-h-[320px] animate-pulse rounded-2xl bg-mist" />,
});

type Filter = "all" | "free" | "on_trip" | "no_location" | "cash";

const BEFORE_PICKUP = ["offered", "accepted", "at_store"];

function matches(p: LivePartner, f: Filter): boolean {
  if (f === "free") return p.online && p.state === "free";
  if (f === "on_trip") return p.state === "on_trip";
  if (f === "no_location") return p.location_state !== "live";
  if (f === "cash") return p.cash_in_hand > p.cash_limit;
  return true;
}

export default function LivePartnersPage() {
  const [data, setData] = useState<LiveData | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [zone, setZone] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [fit, setFit] = useState({ key: "all:0", n: 0 });
  const now = useNow(1000);
  const cards = useRef(new Map<string, HTMLLIElement>());

  const load = useCallback(() => {
    setBusy(true);
    api<LiveData>("/api/admin/delivery/live")
      .then((d) => {
        setData(d);
        setFetchedAt(Date.now());
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not refresh the live view"))
      .finally(() => setBusy(false));
  }, []);
  usePolling(load, 10_000);

  const partners = useMemo(() => data?.partners ?? [], [data]);
  const trips = useMemo(() => data?.trips ?? [], [data]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return partners.filter((p) =>
      matches(p, filter) &&
      (!zone || (p.zone?.id ?? "none") === zone) &&
      (!needle || p.name.toLowerCase().includes(needle) || p.phone.includes(needle) || p.vehicle_no.toLowerCase().replace(/\s/g, "").includes(needle.replace(/\s/g, ""))),
    );
  }, [partners, filter, zone, q]);

  const counts = useMemo(() => ({
    all: partners.length,
    free: partners.filter((p) => matches(p, "free")).length,
    on_trip: partners.filter((p) => matches(p, "on_trip")).length,
    no_location: partners.filter((p) => matches(p, "no_location")).length,
    cash: partners.filter((p) => matches(p, "cash")).length,
  }), [partners]);

  const { markers, lines } = useMemo(() => buildMap(shown, trips), [shown, trips]);

  const focusPoints = useMemo(() => {
    if (!selected) return undefined;
    const p = partners.find((x) => x.id === selected);
    if (!p) return undefined;
    const pts: [number, number][] = [];
    if (p.lat !== null && p.lng !== null && p.location_state !== "unknown") pts.push([p.lat, p.lng]);
    for (const t of trips.filter((x) => x.partner.id === p.id)) {
      if (t.pickup.lat !== null && t.pickup.lng !== null) pts.push([t.pickup.lat, t.pickup.lng]);
      if (t.drop.lat !== null && t.drop.lng !== null) pts.push([t.drop.lat, t.drop.lng]);
    }
    return pts.length ? pts : undefined;
  }, [selected, partners, trips]);

  function choose(id: string, scroll: boolean) {
    setSelected(id);
    setFit((f) => ({ key: `p:${id}:${f.n + 1}`, n: f.n + 1 }));
    if (scroll) cards.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  if (!data) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const s = data.summary;
  const zones = [...new Map(partners.filter((p) => p.zone).map((p) => [p.zone!.id, p.zone!])).values()];
  const noZone = partners.some((p) => !p.zone);
  const updated = fetchedAt ? Math.max(0, Math.round((now - fetchedAt) / 1000)) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="delivery-live">
      <PageHeader
        title="Live partners"
        sub="Who is online right now, where they are and what they are carrying. Updates every 10 seconds."
        actions={
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink-soft ring-1 ring-line" aria-live="polite">
              <span className={clsx("h-2 w-2 rounded-full", error ? "bg-vermilion" : "bg-leaf shadow-[0_0_0_3px_rgba(30,142,62,0.2)]")} />
              {error ? "Reconnecting…" : updated === null ? "Live" : updated < 3 ? "Live · just now" : `Live · ${updated} s ago`}
            </span>
            <Button variant="secondary" size="sm" onClick={load} disabled={busy} aria-label="Refresh now">
              <RefreshCw className={clsx("h-4 w-4", busy && "animate-spin")} aria-hidden /> <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Kpi icon={Wifi} label="Online now" value={s.online} hint={`${s.free} free, ${s.on_trip} on a trip`} tone="green" pulse={s.online > 0} testId="live-online" />
        <Kpi icon={Bike} label="Free to deliver" value={s.free} hint="Online with no trip" tone="green" />
        <Kpi icon={MapPin} label="On a trip" value={s.on_trip} hint={`${trips.length} package${trips.length === 1 ? "" : "s"} moving`} />
        <Kpi icon={AlertTriangle} label="Stuck trips" value={s.stuck} hint="Same step for too long" alert={s.stuck > 0} tone="gray" href="/admin/delivery/trips?status=active" />
        <Kpi icon={Hourglass} label="Waiting for a partner" value={s.waiting} hint="Ready for pickup" tone={s.waiting ? "amber" : "gray"} href="/admin/delivery/queue" />
        <Kpi icon={Banknote} label="Cash with partners" value={rupees(s.cash_in_hand)} hint={counts.cash ? `${counts.cash} over the limit` : "Cash on delivery to deposit"} tone={counts.cash ? "red" : "gray"} href="/admin/delivery/payouts?tab=cash" />
      </div>

      {data.by_zone.length > 0 && (
        <div className="scroll-x -mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="By zone">
          {data.by_zone.map((z) => (
            <div key={z.zone} className="flex shrink-0 items-center gap-3 rounded-xl bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-black/5">
              <span className="font-semibold">{z.zone}</span>
              <span className="flex items-center gap-1 text-leaf"><span className="h-2 w-2 rounded-full bg-leaf" />{z.online} online</span>
              <span className="text-ink-soft">{z.free} free</span>
              <span className="text-peacock">{z.on_trip} on trip</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_460px]">
        <section className="flex flex-col gap-2 xl:sticky xl:top-[84px] xl:h-[calc(100vh-110px)]" aria-label="Map">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
              <Legend color="#1E8E3E" label="Free" />
              <Legend color="#0B5563" label="On a trip" />
              <Legend color="#8A97A0" label="Location old" />
              <Legend color="#F5A524" label="Store" />
              <Legend color="#D7263D" label="Customer" />
            </p>
            {selected && (
              <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setFit((f) => ({ key: `all:${f.n + 1}`, n: f.n + 1 })); }}>
                Show everyone
              </Button>
            )}
          </div>
          <LiveMap
            markers={markers}
            lines={lines}
            tiles={data.map_tiles}
            attribution={data.map_attribution}
            fitKey={fit.key}
            fitPoints={selected ? focusPoints : undefined}
            onMarker={(id) => { if (id.startsWith("p:")) choose(id.slice(2), true); }}
            className="h-[52vh] min-h-[320px] xl:h-auto xl:flex-1"
          />
          {markers.length === 0 && (
            <p className="text-sm text-ink-soft">No one online has shared a location yet. Partners share it from the app while they are online.</p>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-3" aria-label="Partners online">
          <div className="scroll-x -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Show">
            {([
              ["all", "Everyone"],
              ["free", "Free"],
              ["on_trip", "On a trip"],
              ["no_location", "Location off"],
              ["cash", "Over cash limit"],
            ] as [Filter, string][]).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
                className={clsx("flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors",
                  filter === key ? "bg-peacock text-white" : "bg-white text-ink-soft ring-1 ring-line hover:text-ink")}>
                {label}
                <span className={clsx("rounded-full px-1.5 text-xs", filter === key ? "bg-white/20" : "bg-mist")}>{counts[key]}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, mobile or vehicle number" aria-label="Search partners" className="pl-9" />
            </div>
            {(zones.length > 1 || (zones.length && noZone)) && (
              <Select value={zone} onChange={(e) => setZone(e.target.value)} aria-label="Zone" className="w-auto min-w-[160px]">
                <option value="">All zones</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                {noZone && <option value="none">No zone</option>}
              </Select>
            )}
          </div>
          {error && <ErrorNote message={`${error}. Showing the last update.`} />}

          {partners.length === 0 ? (
            <EmptyState title="No one is online right now" body="Partners appear here the moment they go online in the partner app."
              action={<Link href="/admin/delivery/partners?status=approved" className="font-semibold text-peacock">See all partners</Link>} />
          ) : shown.length === 0 ? (
            <p className="rounded-xl bg-white p-6 text-center text-ink-soft ring-1 ring-black/5">No partner matches. Try another filter.</p>
          ) : (
            <ul className="flex flex-col gap-2.5 xl:max-h-[calc(100vh-250px)] xl:overflow-y-auto xl:pr-1" data-testid="live-partners">
              {shown.map((p) => (
                <li key={p.id} ref={(el) => { if (el) cards.current.set(p.id, el); else cards.current.delete(p.id); }}>
                  <PartnerCard p={p} trips={trips.filter((t) => t.partner.id === p.id)} now={now} fetchedAt={fetchedAt}
                    selected={selected === p.id} onSelect={() => choose(p.id, false)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <TripsTable trips={trips} />
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} /> {label}
    </span>
  );
}

function buildMap(partners: LivePartner[], trips: TripView[]): { markers: MapMarker[]; lines: MapLine[] } {
  const markers: MapMarker[] = [];
  const lines: MapLine[] = [];
  const ids = new Set(partners.map((p) => p.id));
  for (const p of partners) {
    if (p.lat === null || p.lng === null || p.location_state === "unknown") continue;
    const kind = p.location_state === "stale" ? "partner-stale" : p.state === "on_trip" ? "partner-busy" : "partner";
    const state = p.state === "on_trip" ? `On a trip (${p.trips.map((t) => t.order_number).join(", ")})` : p.online ? "Free" : "Offline";
    markers.push({ id: `p:${p.id}`, lat: p.lat, lng: p.lng, kind, label: initials(p.name), title: p.name,
      popup: `${p.name}\n${state}\n${p.vehicle}${p.vehicle_no ? ` ${p.vehicle_no}` : ""}\n${p.phone}` });
  }
  for (const t of trips) {
    if (!ids.has(t.partner.id)) continue;
    const store = t.pickup.lat !== null && t.pickup.lng !== null ? ([t.pickup.lat, t.pickup.lng] as [number, number]) : null;
    const home = t.drop.lat !== null && t.drop.lng !== null ? ([t.drop.lat, t.drop.lng] as [number, number]) : null;
    if (store) markers.push({ id: `s:${t.id}`, lat: store[0], lng: store[1], kind: "store", title: t.pickup.name, popup: `Pickup for ${t.order_number}\n${t.pickup.name}\n${t.pickup.address}` });
    if (home) markers.push({ id: `h:${t.id}`, lat: home[0], lng: home[1], kind: "home", title: `Customer, ${t.order_number}`, popup: `Drop for ${t.order_number}\n${t.drop.city} ${t.drop.pincode}` });
    const me = t.partner.lat !== null && t.partner.lng !== null ? ([t.partner.lat, t.partner.lng] as [number, number]) : null;
    // where the partner is heading now: a return pickup goes to the customer first, then the store
    const goingToStore = t.kind === "pickup" ? ["picked", "on_the_way"].includes(t.status) : t.kind === "return" || BEFORE_PICKUP.includes(t.status);
    const target = goingToStore ? store : home;
    if (me && target) lines.push({ id: `l:${t.id}`, points: [me, target], color: goingToStore ? "#F5A524" : "#0B5563", dashed: t.status === "offered" });
    else if (store && home && !goingToStore) lines.push({ id: `r:${t.id}`, points: [store, home], color: "#0B5563", dashed: true });
  }
  return { markers, lines };
}

function PartnerCard({ p, trips, now, fetchedAt, selected, onSelect }: {
  p: LivePartner; trips: TripView[]; now: number; fetchedAt: number; selected: boolean; onSelect: () => void;
}) {
  // the position's age as of now (the server measured it at the last refresh)
  const age = p.location_age_seconds === null ? null : p.location_age_seconds + Math.max(0, Math.round((now - fetchedAt) / 1000));
  const overCash = p.cash_in_hand > p.cash_limit;
  const cashPct = p.cash_limit > 0 ? Math.min(100, Math.round((100 * p.cash_in_hand) / p.cash_limit)) : 0;
  return (
    <article
      className={clsx("rounded-2xl bg-white p-3.5 shadow-sm ring-1 transition sm:p-4", selected ? "ring-2 ring-peacock" : "ring-black/5 hover:ring-peacock/30")}
      data-testid="live-partner"
    >
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left" aria-pressed={selected} aria-label={`Show ${p.name} on the map`}>
        <span className="relative">
          <PartnerAvatar p={p} />
          <span className={clsx("absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-2 ring-white",
            !p.online ? "bg-ink-faint" : p.state === "free" ? "bg-leaf" : "bg-peacock")} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink">{p.name}</span>
            {p.state === "on_trip" ? (
              <span className="rounded-full bg-peacock-light px-2 py-0.5 text-xs font-semibold text-peacock">On a trip · {p.load}/{p.max_active}</span>
            ) : p.online ? (
              <span className="rounded-full bg-leaf-light px-2 py-0.5 text-xs font-semibold text-leaf">Free</span>
            ) : null}
            {!p.online && <OnlineDot online={false} />}
          </span>
          <span className="block truncate text-sm text-ink-soft">
            {p.vehicle}{p.vehicle_no ? ` · ${p.vehicle_no}` : ""}{p.zone ? ` · ${p.zone.name}` : " · No zone"}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {p.location_state === "live" ? (
              <span className="inline-flex items-center gap-1 font-semibold text-leaf"><LocateFixed className="h-3.5 w-3.5" aria-hidden />Location live · {secondsLabel(age)} ago</span>
            ) : p.location_state === "stale" ? (
              <span className="inline-flex items-center gap-1 font-semibold text-marigold-dark"><LocateFixed className="h-3.5 w-3.5" aria-hidden />Last seen {secondsLabel(age)} ago</span>
            ) : (
              <span className="inline-flex items-center gap-1 font-semibold text-vermilion"><LocateOff className="h-3.5 w-3.5" aria-hidden />{age === null ? "No location shared" : `Location ${secondsLabel(age)} old`}</span>
            )}
            {p.online && p.online_minutes !== null && (
              <span className="inline-flex items-center gap-1 text-ink-soft"><Clock className="h-3.5 w-3.5" aria-hidden />Online {minutesLabel(p.online_minutes)}{p.online_since ? ` (since ${time(p.online_since)})` : ""}</span>
            )}
          </span>
        </span>
        <ChevronRight className={clsx("mt-1 h-5 w-5 shrink-0 text-ink-faint transition-transform", selected && "rotate-90")} aria-hidden />
      </button>

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Mini label="Today" value={`${p.today_trips} deliver${p.today_trips === 1 ? "y" : "ies"}`} />
        <Mini label="Earned today" value={rupees(p.today_earned)} />
        <Mini label="Rating" value={p.rating_count ? <span className="inline-flex items-center gap-1"><Star className="h-3.5 w-3.5 fill-marigold text-marigold" aria-hidden />{p.rating_avg.toFixed(1)}<span className="font-normal text-ink-faint">({p.rating_count})</span></span> : "New"} />
        <div className={clsx("rounded-xl px-2.5 py-2", overCash ? "bg-vermilion-light" : "bg-mist")}>
          <dt className={clsx("text-[11px] font-semibold uppercase tracking-wide", overCash ? "text-vermilion" : "text-ink-faint")}>Cash in hand</dt>
          <dd className={clsx("text-sm font-bold", overCash ? "text-vermilion" : "text-ink")}>{rupees(p.cash_in_hand)}</dd>
          {p.cash_limit > 0 && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white" title={`Limit ${rupees(p.cash_limit)}`}>
              <div className={clsx("h-full rounded-full", overCash ? "bg-vermilion" : cashPct > 75 ? "bg-marigold" : "bg-leaf")} style={{ width: `${cashPct}%` }} />
            </div>
          )}
        </div>
      </dl>

      {trips.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {trips.map((t) => (
            <li key={t.id}>
              <Link href={`/admin/delivery/trips/${t.id}`}
                className={clsx("flex items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 transition hover:bg-mist", t.stuck ? "bg-vermilion-light/60 ring-vermilion/30" : "ring-line")}>
                <span className="font-semibold">{t.order_number}</span>
                <TripPill trip={t} />
                {t.kind !== "delivery" && <span className="text-xs font-semibold text-marigold-dark">{t.kind === "pickup" ? "Return pickup" : "Return"}</span>}
                <span className={clsx("ml-auto shrink-0 text-xs", t.stuck ? "font-bold text-vermilion" : "text-ink-faint")}>
                  {t.stuck ? "Stuck · " : ""}{minutesLabel(t.minutes_in_step ?? 0)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
        <a href={telUrl(p.phone)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-peacock px-3 text-sm font-semibold text-white hover:bg-peacock-dark">
          <Phone className="h-4 w-4" aria-hidden /> Call {p.phone}
        </a>
        <Link href={`/admin/delivery/partners/${p.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light">
          <UserRound className="h-4 w-4" aria-hidden /> Profile
        </Link>
        <Link href={`/admin/delivery/trips?partner_id=${p.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-peacock hover:bg-peacock-light">
          <ListChecks className="h-4 w-4" aria-hidden /> Trips
        </Link>
        <span className="ml-auto self-center text-xs text-ink-faint">{p.location_state !== "unknown" && p.lat !== null ? `${p.lat.toFixed(4)}, ${p.lng?.toFixed(4)}` : ""}</span>
      </div>
    </article>
  );
}

function Mini({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-mist px-2.5 py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="text-sm font-bold text-ink">{value}</dd>
    </div>
  );
}

function TripsTable({ trips }: { trips: TripView[] }) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5" aria-labelledby="live-trips-h">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="live-trips-h" className="text-lg font-semibold">Trips in progress <span className="text-ink-faint">({trips.length})</span></h2>
        <Link href="/admin/delivery/trips?status=active" className="text-sm font-semibold text-peacock">All trips</Link>
      </div>
      {trips.length === 0 ? (
        <p className="text-ink-soft">No packages are moving right now.</p>
      ) : (
        <ul className="divide-y divide-line">
          {trips.map((t) => (
            <li key={t.id}>
              <Link href={`/admin/delivery/trips/${t.id}`} className="flex flex-col gap-1 py-3 hover:bg-mist/60 sm:flex-row sm:items-center sm:gap-4 sm:px-2">
                <span className="flex min-w-0 items-center gap-2 sm:w-56">
                  <span className="font-semibold">{t.order_number}</span>
                  <TripPill trip={t} />
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink-soft">
                  <Store className="h-4 w-4 shrink-0 text-marigold-dark" aria-hidden />
                  <span className="truncate">{t.pickup.name}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  <MapPin className="h-4 w-4 shrink-0 text-vermilion" aria-hidden />
                  <span className="truncate">{[t.drop.city, t.drop.pincode].filter(Boolean).join(" ")}</span>
                </span>
                <span className="flex items-center gap-3 text-sm sm:w-72 sm:justify-end">
                  <span className="truncate">{t.partner.name}</span>
                  {t.payment === "cod" && t.cod_amount > 0 && <span className="shrink-0 rounded-full bg-marigold-light px-2 py-0.5 text-xs font-semibold text-[#8A5A00]">COD {rupees(t.cod_amount)}</span>}
                  <span className={clsx("shrink-0 text-xs", t.stuck ? "font-bold text-vermilion" : "text-ink-faint")}>{t.stuck ? "Stuck " : ""}{minutesLabel(t.minutes_in_step ?? 0)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
