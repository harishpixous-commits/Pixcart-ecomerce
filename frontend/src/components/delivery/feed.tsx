"use client";

/*
 * The partner app's heartbeat. While the app is open (on any partner screen) it asks the server every 5 seconds for new
 * delivery requests and trips in progress, shares the partner's location while they are online or carrying a package,
 * and pops a new request up full screen with a countdown, a chime and a vibration. Accept opens the trip; Reject asks
 * for a reason. A push notification covers the time the app is closed (see lib/push.ts).
 */

import clsx from "clsx";
import { Banknote, Bike, Check, Clock, MapPin, Package, Store, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useDeliveryOptions, usePartner } from "@/components/delivery/app";
import { useLocationSharing, type LocationState } from "@/components/delivery/location";
import { useNow } from "@/components/delivery/trip";
import { Button, ErrorNote, Modal, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { PartnerFeed, TripView } from "@/lib/delivery-types";
import { onForegroundPush } from "@/lib/push";
import { rupees } from "@/lib/format";

/* ---------------------------------------------------------------- sound */

let audioCtx: AudioContext | null = null;

/** Browsers only allow sound after the person has touched the page once; the shell calls this on the first tap. */
export function unlockAudio() {
  if (typeof window === "undefined") return;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

function chime() {
  const c = audioCtx;
  if (!c || c.state !== "running") return;
  const t0 = c.currentTime;
  [880, 1175, 1568, 1175].forEach((freq, i) => {
    const o = c.createOscillator();
    const g = c.createGain();
    const t = t0 + i * 0.15;
    o.type = "triangle";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + 0.15);
  });
}

/* ---------------------------------------------------------------- context */

type Offer = TripView & { deadline: number };
type FeedState = {
  feed: (Omit<PartnerFeed, "offers"> & { offers: Offer[] }) | null;
  refresh: () => void;
  location: { state: LocationState; last: GeolocationPosition | null };
  /** Removes a request from the screen at once (after accepting, rejecting or when it ran out). */
  drop: (id: string) => void;
};

const FeedCtx = createContext<FeedState>({ feed: null, refresh: () => {}, location: { state: "off", last: null }, drop: () => {} });

export function useFeed() {
  return useContext(FeedCtx);
}

export function FeedProvider({ children }: { children: React.ReactNode }) {
  const { partner, set } = usePartner();
  const options = useDeliveryOptions();
  const [feed, setFeed] = useState<FeedState["feed"]>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const seq = useRef(0);
  const partnerRef = useRef({ partner, set });
  useEffect(() => {
    partnerRef.current = { partner, set };
  }, [partner, set]);

  const refresh = useCallback(() => {
    const id = ++seq.current;
    api<PartnerFeed>("/api/delivery/feed")
      .then((f) => {
        if (id !== seq.current) return;
        const at = Date.now();
        setFeed({ ...f, offers: f.offers.map((o) => ({ ...o, deadline: at + (o.seconds_left ?? 0) * 1000 })) });
        const { partner: p, set: update } = partnerRef.current;
        if (p && p.is_online !== f.is_online) update({ ...p, is_online: f.is_online }); // switched off elsewhere (or by the system)
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const t = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    const stopPush = onForegroundPush(() => refresh()); // a push while the app is open: fetch the new request now
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
      stopPush();
    };
  }, [refresh]);

  const online = !!partner?.is_online;
  const carrying = (feed?.active.length ?? 0) > 0;
  const location = useLocationSharing(online || carrying, options?.location_seconds ?? 20);

  const value = useMemo<FeedState>(() => ({
    feed: feed ? { ...feed, offers: feed.offers.filter((o) => !dropped.includes(o.id)) } : null,
    refresh,
    location,
    drop: (id) => setDropped((d) => (d.includes(id) ? d : [...d.slice(-20), id])),
  }), [feed, dropped, refresh, location]);

  return <FeedCtx.Provider value={value}>{children}</FeedCtx.Provider>;
}

/* ---------------------------------------------------------------- the request popup */

function distanceKm(a: { lat: number | null; lng: number | null }, b: { lat: number | null; lng: number | null }): number | null {
  if (a.lat === null || a.lng === null || b.lat === null || b.lng === null) return null;
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h)) * 1.3; // roads are longer than a straight line
}

function km(n: number | null): string {
  return n === null ? "" : n < 1 ? `${Math.round(n * 1000)} m` : `${n.toFixed(1)} km`;
}

export function OfferPopup() {
  const { feed, refresh, location, drop } = useFeed();
  const options = useDeliveryOptions();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const now = useNow(250);
  const [busy, setBusy] = useState<"accept" | null>(null);
  const [rejecting, setRejecting] = useState<Offer | null>(null);
  const offers = feed?.offers ?? [];
  const live = offers.filter((o) => o.deadline > now);
  // while the partner picks a reason the request stays theirs; it closes if the time runs out
  const rejectOpen = rejecting && rejecting.deadline > now && live.some((o) => o.id === rejecting.id) ? rejecting : null;
  const offer = rejectOpen ? null : live[0] ?? null;
  const offerId = offer?.id ?? null;

  // chime and vibrate every 2 seconds while a request is on screen; flash the tab title
  useEffect(() => {
    if (!offerId) return;
    const ring = () => {
      chime();
      navigator.vibrate?.([250, 120, 250]);
    };
    ring();
    const t = setInterval(ring, 2000);
    const title = document.title;
    document.title = "New delivery request";
    return () => {
      clearInterval(t);
      navigator.vibrate?.(0);
      document.title = title;
    };
  }, [offerId]);

  const sheet = (
    <RejectSheet offer={rejectOpen} reasons={options?.reject_reasons ?? {}} onClose={() => setRejecting(null)}
      onDone={(id) => { setRejecting(null); drop(id); refresh(); }} />
  );
  if (!offer) return sheet;
  const total = Math.max(1, feed?.offer_seconds ?? 30);
  const left = Math.max(0, Math.ceil((offer.deadline - now) / 1000));
  const me = location.last ? { lat: location.last.coords.latitude, lng: location.last.coords.longitude } : { lat: null, lng: null };
  const toStore = distanceKm(me, offer.pickup);
  const toCustomer = distanceKm(offer.pickup, offer.drop);
  const items = offer.items.reduce((n, i) => n + i.qty, 0);
  const R = 34;
  const C = 2 * Math.PI * R;

  async function accept() {
    if (!offer) return;
    setBusy("accept");
    try {
      await api(`/api/delivery/offers/${offer.id}/accept`, { method: "POST" });
      drop(offer.id);
      navigator.vibrate?.(0);
      toast("Accepted. Head to the store.");
      refresh();
      if (pathname !== `/delivery/trips/${offer.id}`) router.push(`/delivery/trips/${offer.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not accept. Try again.", "error");
      if (e instanceof ApiError && ["offer_gone", "offer_expired", "not_found"].includes(e.code)) drop(offer.id);
      refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-end justify-center bg-ink/60 backdrop-blur-sm sm:items-center sm:p-4" role="alertdialog" aria-modal="true"
        aria-labelledby="offer-title" aria-describedby="offer-desc" data-testid="offer-popup">
        <div className="w-full max-w-md overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl motion-safe:animate-[pc-rise_220ms_ease-out]">
          <div className="relative bg-gradient-to-br from-peacock to-peacock-dark px-5 pb-5 pt-6 text-white">
            <div className="flex items-center gap-4">
              <div className="relative h-20 w-20 shrink-0" aria-hidden>
                <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
                  <circle cx="40" cy="40" r={R} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="7" />
                  <circle cx="40" cy="40" r={R} fill="none" stroke={left <= 10 ? "#FFB4B4" : "#fff"} strokeWidth="7" strokeLinecap="round"
                    strokeDasharray={C} strokeDashoffset={C * (1 - left / total)} className="transition-[stroke-dashoffset] duration-300 ease-linear" />
                </svg>
                <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
                  <span className="font-display text-2xl font-bold">{left}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-white/80">sec</span>
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-white/75">{live.length > 1 ? `Request 1 of ${live.length}` : "New request"}</p>
                <h2 id="offer-title" className="font-display text-2xl font-bold leading-tight">{offer.kind === "pickup" ? "Return pickup request" : offer.kind === "return" ? "Return to store" : "New delivery request"}</h2>
                <p className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-sm font-semibold">
                  You earn about {rupees(offer.fee_estimate)}
                  {(offer.bonus_now ?? 0) > 0 && <span className="text-white/80">(incl. {rupees(offer.bonus_now ?? 0)} bad weather bonus)</span>}
                </p>
              </div>
            </div>
            <span className="sr-only" aria-live="assertive">{left} seconds left to accept</span>
          </div>

          <div id="offer-desc" className="flex flex-col gap-3 px-5 py-4">
            <div className={clsx("relative flex flex-col gap-3 pl-8", offer.kind === "pickup" && "flex-col-reverse")}>
              <span className="absolute bottom-6 left-[11px] top-6 w-0.5 bg-gradient-to-b from-marigold to-vermilion" aria-hidden />
              <div className="relative">
                <span className="absolute -left-8 top-0 flex h-6 w-6 items-center justify-center rounded-full bg-marigold text-white"><Store className="h-3.5 w-3.5" aria-hidden /></span>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{offer.kind === "pickup" ? "Bring to" : "Pick up"}{toStore !== null && offer.kind !== "pickup" ? ` · ${km(toStore)} from you` : ""}</p>
                <p className="font-semibold text-ink">{offer.pickup.name}</p>
                <p className="text-sm text-ink-soft">{[offer.pickup.address, offer.pickup.city, offer.pickup.pincode].filter(Boolean).join(", ")}</p>
              </div>
              <div className="relative">
                <span className="absolute -left-8 top-0 flex h-6 w-6 items-center justify-center rounded-full bg-vermilion text-white"><MapPin className="h-3.5 w-3.5" aria-hidden /></span>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{offer.kind === "pickup" ? "Collect from" : "Deliver to"}{toCustomer !== null ? ` · ${km(toCustomer)} from the store` : ""}</p>
                <p className="font-semibold text-ink">{[offer.drop.city, offer.drop.pincode].filter(Boolean).join(" ") || "Customer"}</p>
                <p className="text-sm text-ink-soft">Full address shows after you accept.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-mist px-3 py-1 font-semibold"><Package className="h-4 w-4 text-peacock" aria-hidden />{items} item{items === 1 ? "" : "s"}</span>
              {offer.kind === "pickup" ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-peacock-light px-3 py-1 font-semibold text-peacock"><Package className="h-4 w-4" aria-hidden />Customer return{offer.return_number ? ` ${offer.return_number}` : ""}</span>
              ) : offer.payment === "cod" && offer.cod_amount > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-marigold-light px-3 py-1 font-semibold text-[#8A5A00]"><Banknote className="h-4 w-4" aria-hidden />Collect {rupees(offer.cod_amount)} cash</span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-leaf-light px-3 py-1 font-semibold text-leaf"><Check className="h-4 w-4" aria-hidden />Prepaid</span>
              )}
              {offer.mode === "manual" && <span className="inline-flex items-center gap-1.5 rounded-full bg-peacock-light px-3 py-1 font-semibold text-peacock"><Bike className="h-4 w-4" aria-hidden />Sent by the team</span>}
            </div>
          </div>

          <div className="grid grid-cols-[auto_1fr] gap-3 border-t border-line px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4">
            <Button variant="danger" size="lg" onClick={() => setRejecting(offer)} disabled={!!busy} data-testid="offer-reject">
              <X className="h-5 w-5" aria-hidden /> Reject
            </Button>
            <Button size="lg" className="!bg-leaf text-lg hover:!bg-leaf/90" loading={busy === "accept"} onClick={accept} data-testid="offer-accept">
              <Check className="h-5 w-5" aria-hidden /> Accept
            </Button>
          </div>
        </div>
      </div>
      {sheet}
    </>
  );
}

function RejectSheet({ offer, reasons, onClose, onDone }: { offer: Offer | null; reasons: Record<string, string>; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!offer || !reason) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/delivery/offers/${offer.id}/reject`, { method: "POST", body: { reason, note: note.trim() } });
      toast("Request rejected");
      setReason("");
      setNote("");
      onDone(offer.id);
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not reject");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!offer} onClose={onClose} title="Why are you rejecting?">
      <form onSubmit={submit} className="flex flex-col gap-3" data-testid="reject-sheet">
        <ErrorNote message={error} />
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Reason</legend>
          {Object.entries(reasons).map(([k, label]) => (
            <label key={k} className={clsx("flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition", reason === k ? "bg-peacock-light ring-peacock" : "ring-line hover:bg-mist")}>
              <input type="radio" name="reject" value={k} checked={reason === k} onChange={() => setReason(k)} className="h-4 w-4 accent-peacock" />
              <span className="font-medium">{label}</span>
            </label>
          ))}
        </fieldset>
        {reason === "other" && <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tell us more (optional)" rows={2} maxLength={200} aria-label="More details" />}
        <p className="flex items-center gap-1.5 text-xs text-ink-faint"><Clock className="h-3.5 w-3.5" aria-hidden />The request goes to the next partner right away.</p>
        <Button type="submit" variant="danger" loading={busy} disabled={!reason} className="self-start">Reject request</Button>
      </form>
    </Modal>
  );
}
