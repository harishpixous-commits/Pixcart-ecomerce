"use client";

/*
 * Admin → Delivery → one trip: the map (store, customer, partner), the steps with times, both addresses, the money
 * (cash to collect and collected, fee, tip, distance), the pickup code, the delivery photo, the customer's rating and
 * the full log with who did what and where. Staff can take a trip off a partner before pickup, or decide what happens
 * after a failed attempt.
 */

import clsx from "clsx";
import { ArrowLeft, Camera, ExternalLink, KeyRound, MapPin, Phone, RotateCcw, Star, Store, Undo2, UserRound } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DocViewer, PartnerAvatar } from "@/components/delivery/admin";
import { minutesLabel, navigateUrl, telUrl, TripPill, TripProgress, usePolling } from "@/components/delivery/trip";
import type { MapLine, MapMarker } from "@/components/map/live-map";
import { Button, ErrorNote, Modal, PageLoader, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { TripView } from "@/lib/delivery-types";
import { dateTime, rupees } from "@/lib/format";

const LiveMap = dynamic(() => import("@/components/map/live-map").then((m) => m.LiveMap), {
  ssr: false,
  loading: () => <div className="h-72 animate-pulse rounded-2xl bg-mist" />,
});

const ACTOR: Record<string, string> = { delivery: "Partner", admin: "Staff", seller: "Seller", system: "System", customer: "Customer" };

export default function AdminTripPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [t, setT] = useState<TripView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proof, setProof] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<TripView>(`/api/admin/delivery/trips/${id}`).then((x) => { setT(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the trip"));
  }, [id]);
  const live = !!t && ["offered", "accepted", "at_store", "picked", "on_the_way", "reached"].includes(t.status);
  usePolling(load, 15_000, live || !t);

  const { markers, lines } = useMemo(() => {
    const m: MapMarker[] = [];
    const l: MapLine[] = [];
    if (!t) return { markers: m, lines: l };
    const store = t.pickup.lat !== null && t.pickup.lng !== null ? ([t.pickup.lat, t.pickup.lng] as [number, number]) : null;
    const home = t.drop.lat !== null && t.drop.lng !== null ? ([t.drop.lat, t.drop.lng] as [number, number]) : null;
    if (store) m.push({ id: "store", lat: store[0], lng: store[1], kind: "store", title: t.pickup.name, popup: `${t.pickup.name}\n${t.pickup.address}` });
    if (home) m.push({ id: "home", lat: home[0], lng: home[1], kind: "home", title: t.drop.name || "Customer", popup: `${t.drop.name}\n${t.drop.address}` });
    if (live && t.partner.lat !== null && t.partner.lng !== null) {
      m.push({ id: "partner", lat: t.partner.lat, lng: t.partner.lng, kind: "partner-busy", title: t.partner.name, label: t.partner.name.slice(0, 2).toUpperCase() });
    }
    for (const x of t.log ?? []) {
      if (x.lat != null && x.lng != null && ["picked", "delivered", "failed", "returned"].includes(x.status)) {
        m.push({ id: `log:${x.status}:${x.at}`, lat: x.lat, lng: x.lng, kind: "pin", title: `${x.status.replace(/_/g, " ")} here` });
      }
    }
    if (store && home) l.push({ id: "route", points: [store, home], dashed: true, color: "#0B5563" });
    return { markers: m, lines: l };
  }, [t, live]);

  async function resolve(action: "retry" | "return") {
    if (!t) return;
    if (action === "return" && !window.confirm("Bring the package back to the seller? The order part is cancelled and a prepaid amount refunded when it reaches the store.")) return;
    setBusy(action);
    try {
      const next = await api<{ id: string }>(`/api/admin/delivery/assignments/${t.id}/resolve`, { method: "POST", body: { action } });
      toast(action === "retry" ? "The partner will try the delivery again" : "The partner will bring the package back");
      router.push(`/admin/delivery/trips/${next.id}`); // the new trip
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not update", "error");
    } finally {
      setBusy(null);
    }
  }

  if (!t) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const beforePickup = ["offered", "accepted", "at_store"].includes(t.status);
  return (
    <div className="flex flex-col gap-4" data-testid="admin-trip">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin/delivery/trips" className="flex h-10 w-10 items-center justify-center rounded-xl bg-white ring-1 ring-line" aria-label="Back to trips"><ArrowLeft className="h-5 w-5" /></Link>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-bold">{t.order_number}</h1>
          <p className="text-sm text-ink-soft">{t.kind === "pickup" ? `Return pickup${t.return_number ? ` ${t.return_number}` : ""}` : t.kind === "return" ? "Return to store" : "Delivery"} · {t.mode === "auto" ? "auto-assign" : "assigned by staff"} · {dateTime(t.assigned_at)}</p>
        </div>
        <TripPill trip={t} />
        <Link href={`/admin/orders/${t.order_id}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-3 font-semibold text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light">
          Order <ExternalLink className="h-4 w-4" aria-hidden />
        </Link>
      </div>
      <ErrorNote message={error} />

      {(beforePickup || t.status === "failed") && (
        <section className="flex flex-wrap items-center gap-3 rounded-2xl bg-marigold-light/60 p-4 ring-1 ring-marigold/30">
          <p className="min-w-0 flex-1 text-sm">
            {beforePickup ? "The partner does not have the package yet. You can take this trip off them; the package goes back to the queue." : `Not delivered: ${t.fail_reason}. The partner still has the package.`}
          </p>
          {beforePickup && <Button variant="danger" onClick={() => setCancelling(true)}><Undo2 className="h-4 w-4" aria-hidden /> Take off partner</Button>}
          {t.status === "failed" && (
            <>
              <Button loading={busy === "retry"} onClick={() => resolve("retry")}><RotateCcw className="h-4 w-4" aria-hidden /> Try again</Button>
              <Button variant="danger" loading={busy === "return"} onClick={() => resolve("return")}><Undo2 className="h-4 w-4" aria-hidden /> Bring back to store</Button>
            </>
          )}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          {markers.length > 0 && <LiveMap markers={markers} lines={lines} fitKey={`${t.id}:${markers.length}`} className="h-72 sm:h-80" />}
          <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5"><TripProgress trip={t} /></section>
          <div className="grid gap-3 md:grid-cols-2">
            <Place icon={Store} title={t.kind === "return" || t.kind === "pickup" ? "Store (bring to)" : "Pick up from"} tone="store" name={t.pickup.name}
              lines={[t.pickup.address, [t.pickup.city, t.pickup.pincode].filter(Boolean).join(" ")]} phone={t.pickup.phone} nav={navigateUrl(t.pickup)} />
            <Place icon={MapPin} title={t.kind === "pickup" ? "Collect from" : "Deliver to"} tone="home" name={t.drop.name || "Customer"} lines={[t.drop.address, [t.drop.city, t.drop.pincode].filter(Boolean).join(" ")]}
              phone={t.drop.phone} nav={navigateUrl(t.drop)} note={t.drop.instructions} noBag={t.drop.no_bag} />
          </div>
          <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <h2 className="mb-2 font-semibold">Trip log</h2>
            <ol className="flex flex-col gap-3 border-l-2 border-line pl-4">
              {(t.log ?? []).map((x, i) => (
                <li key={i} className="relative text-sm">
                  <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full bg-peacock ring-2 ring-white" aria-hidden />
                  <p><span className="font-semibold">{x.status.replace(/_/g, " ")}</span> <span className="text-ink-faint">· {ACTOR[x.actor ?? ""] ?? x.actor} · {dateTime(x.at)}</span></p>
                  {x.note && <p className="text-ink-soft">{x.note}</p>}
                  {x.lat != null && x.lng != null && (
                    <a href={`https://www.google.com/maps?q=${x.lat},${x.lng}`} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-peacock">
                      {x.lat.toFixed(5)}, {x.lng.toFixed(5)}
                    </a>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <div className="flex items-center gap-3">
              <PartnerAvatar p={t.partner} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{t.partner.name}</p>
                <p className="text-sm text-ink-soft">{t.partner.vehicle}{t.partner.vehicle_no ? ` · ${t.partner.vehicle_no}` : ""}</p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <a href={telUrl(t.partner.phone)} className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-peacock text-sm font-semibold text-white"><Phone className="h-4 w-4" aria-hidden />Call</a>
              <Link href={`/admin/delivery/partners/${t.partner.id}`} className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold text-peacock ring-1 ring-inset ring-peacock/40"><UserRound className="h-4 w-4" aria-hidden />Profile</Link>
            </div>
            {live && t.minutes_in_step !== undefined && <p className="mt-2 text-xs text-ink-faint">In this step for {minutesLabel(t.minutes_in_step)}</p>}
          </section>

          <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <h2 className="mb-2 font-semibold">Money</h2>
            <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-sm">
              <dt className="text-ink-soft">Payment</dt><dd className="font-semibold">{t.kind === "pickup" ? "Return pickup, no money" : t.payment === "cod" ? "Cash on delivery" : "Prepaid"}</dd>
              {t.cod_amount > 0 && (<><dt className="text-ink-soft">Cash to collect</dt><dd className="font-semibold">{rupees(t.cod_amount)}</dd></>)}
              {t.cod_collected > 0 && (<><dt className="text-ink-soft">Collected</dt><dd className="font-semibold text-leaf">{rupees(t.cod_collected)} {t.cod_method === "upi" ? "by UPI" : "in cash"}</dd></>)}
              <dt className="text-ink-soft">Partner fee</dt><dd className="font-semibold">{t.status === "delivered" ? rupees(t.fee) : `about ${rupees(t.fee_estimate)}`}</dd>
              {t.tip > 0 && (<><dt className="text-ink-soft">Customer tip</dt><dd className="font-semibold">{rupees(t.tip)}</dd></>)}
              {t.distance_km !== null && (<><dt className="text-ink-soft">Distance</dt><dd className="font-semibold">{t.distance_km} km</dd></>)}
            </dl>
          </section>

          {t.pickup_code && (
            <section className="flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              <KeyRound className="h-5 w-5 text-marigold-dark" aria-hidden />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Pickup code</p>
                <p className="font-mono text-xl font-bold tracking-[0.3em]">{t.pickup_code}</p>
              </div>
            </section>
          )}

          {(t.has_proof || t.rating) && (
            <section className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
              {t.has_proof && <Button variant="secondary" onClick={() => setProof(true)}><Camera className="h-4 w-4" aria-hidden /> Delivery photo</Button>}
              {t.rating && (
                <div>
                  <p className="flex items-center gap-0.5" aria-label={`Rated ${t.rating} of 5`}>
                    {[1, 2, 3, 4, 5].map((n) => <Star key={n} className={clsx("h-5 w-5", n <= (t.rating ?? 0) ? "fill-marigold text-marigold" : "text-line")} aria-hidden />)}
                  </p>
                  {t.rating_comment && <p className="mt-1 text-sm text-ink-soft">“{t.rating_comment}”</p>}
                </div>
              )}
            </section>
          )}
        </aside>
      </div>

      <DocViewer path={proof ? `/api/admin/delivery/trips/${t.id}/proof` : null} title={`Delivery photo, ${t.order_number}`} onClose={() => setProof(false)} />
      <CancelTrip open={cancelling} id={t.id} partner={t.partner.name} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); load(); }} />
    </div>
  );
}

function Place({ icon: Icon, title, tone, name, lines, phone, nav, note, noBag }: {
  icon: typeof Store; title: string; tone: "store" | "home"; name: string; lines: string[]; phone: string; nav: string; note?: string; noBag?: boolean;
}) {
  return (
    <section className="flex flex-col gap-1.5 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-ink-faint">
        <span className={clsx("flex h-6 w-6 items-center justify-center rounded-full text-white", tone === "store" ? "bg-marigold" : "bg-vermilion")}><Icon className="h-3.5 w-3.5" aria-hidden /></span>{title}
      </p>
      <p className="font-semibold">{name}</p>
      {lines.filter(Boolean).map((l, i) => <p key={i} className="text-sm text-ink-soft">{l}</p>)}
      {note && <p className="rounded-lg bg-mist px-2 py-1 text-sm"><b>Instructions:</b> {note}</p>}
      {noBag && <p className="text-xs font-semibold text-leaf">No carry bag</p>}
      <div className="mt-1 flex gap-3 text-sm font-semibold text-peacock">
        {phone && <a href={telUrl(phone)} className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" aria-hidden />{phone}</a>}
        <a href={nav} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden />Map</a>
      </div>
    </section>
  );
}

function CancelTrip({ open, id, partner, onClose, onDone }: { open: boolean; id: string; partner: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/delivery/assignments/${id}/cancel`, { method: "POST", body: { reason: reason.trim() } });
      toast("Trip taken off the partner. The package is back in the queue.");
      setReason("");
      onDone();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not take the trip off");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Take this trip off the partner">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft">{partner} is told right away. Assign someone else from the queue.</p>
        <ErrorNote message={error} />
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required minLength={3} maxLength={300} placeholder="Reason (the partner sees it)" aria-label="Reason" />
        <Button type="submit" variant="danger" loading={busy} disabled={reason.trim().length < 3} className="self-start">Take off partner</Button>
      </form>
    </Modal>
  );
}
