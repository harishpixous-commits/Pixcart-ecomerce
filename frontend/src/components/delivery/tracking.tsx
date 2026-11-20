"use client";

/*
 * The customer's view of a package our own delivery partner carries: who is coming (photo, vehicle, rating, call),
 * where they are on the map while on the way, the OTP to share at the door, and after delivery the photo of the
 * package, a rating for the partner and "report a problem".
 */

import clsx from "clsx";
import { Bike, Camera, Check, KeyRound, MessageSquareWarning, Phone, Star } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { DocViewer } from "@/components/delivery/admin";
import { ago, telUrl, time, useNow } from "@/components/delivery/trip";
import type { MapLine, MapMarker } from "@/components/map/live-map";
import { Button, ErrorNote, Modal, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { FleetTracking } from "@/lib/types";

const LiveMap = dynamic(() => import("@/components/map/live-map").then((m) => m.LiveMap), {
  ssr: false,
  loading: () => <div className="h-52 animate-pulse rounded-2xl bg-mist" />,
});

const HEADLINE: Record<string, string> = {
  accepted: "Your delivery partner is going to the store",
  at_store: "Your delivery partner is at the store",
  picked: "Picked up. Your package is on its way",
  on_the_way: "On the way to you",
  reached: "Your delivery partner has arrived",
  delivered: "Delivered",
  failed: "Delivery attempt failed",
};

const COMPLAINTS: [string, string][] = [
  ["late", "Delivered late"],
  ["rude", "Rude or unprofessional"],
  ["damaged", "Package damaged"],
  ["not_received", "Marked delivered but not received"],
  ["extra_money", "Asked for extra money"],
  ["other", "Something else"],
];

const STEPS: { key: string; label: string; at: "accepted_at" | "picked_at" | "on_the_way_at" | "reached_at" | "delivered_at" }[] = [
  { key: "accepted", label: "Partner assigned", at: "accepted_at" },
  { key: "picked", label: "Picked up", at: "picked_at" },
  { key: "on_the_way", label: "On the way", at: "on_the_way_at" },
  { key: "reached", label: "Arrived", at: "reached_at" },
  { key: "delivered", label: "Delivered", at: "delivered_at" },
];
const ORDER = ["accepted", "at_store", "picked", "on_the_way", "reached", "delivered"];

export function DeliveryTracking({ orderId, subId, f, packageStatus, onChanged }: {
  orderId: string; subId: string; f: FleetTracking; packageStatus: string; onChanged: () => void;
}) {
  const now = useNow(15_000);
  const [proof, setProof] = useState(false);
  const [complaint, setComplaint] = useState(false);
  const a = f.assignment;
  const p = f.partner;

  const { markers, lines } = useMemo(() => {
    const m: MapMarker[] = [];
    const l: MapLine[] = [];
    if (f.drop.lat !== null && f.drop.lng !== null) m.push({ id: "home", lat: f.drop.lat, lng: f.drop.lng, kind: "home", title: "Your address" });
    if (f.location) {
      m.push({ id: "partner", lat: f.location.lat, lng: f.location.lng, kind: "partner", title: p?.name ?? "Delivery partner", popup: p ? `${p.name}\n${p.vehicle} ${p.vehicle_no}` : undefined });
      if (f.drop.lat !== null && f.drop.lng !== null) l.push({ id: "route", points: [[f.location.lat, f.location.lng], [f.drop.lat, f.drop.lng]], dashed: true });
    }
    return { markers: m, lines: l };
  }, [f.drop.lat, f.drop.lng, f.location, p]);

  if (!a) {
    if (!f.ready_for_pickup_at || packageStatus !== "packed") return null;
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-peacock-light/50 p-3 text-sm ring-1 ring-peacock/15" data-testid="tracking-finding">
        <span className="relative flex h-3 w-3 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-peacock/40" /><span className="relative inline-flex h-3 w-3 rounded-full bg-peacock" /></span>
        <span><b>Packed and ready.</b> We are assigning a delivery partner near the seller.</span>
      </div>
    );
  }
  const reached = ORDER.indexOf(a.status);
  const moving = ["picked", "on_the_way", "reached"].includes(a.status);
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-gradient-to-br from-peacock-light/60 to-white p-3 ring-1 ring-peacock/15 sm:p-4" id={`delivery-${subId}`} data-testid="delivery-tracking">
      <p className={clsx("flex items-center gap-2 font-display text-lg font-semibold", a.status === "failed" ? "text-vermilion" : a.status === "delivered" ? "text-leaf" : "text-peacock-dark")}>
        {a.status === "delivered" ? <Check className="h-5 w-5" aria-hidden /> : <Bike className="h-5 w-5" aria-hidden />}
        {HEADLINE[a.status] ?? a.status_label}
        {a.status === "delivered" && a.delivered_at && <span className="text-sm font-normal text-ink-soft">at {time(a.delivered_at)}</span>}
      </p>

      {a.status !== "failed" && (
        <ol className="grid grid-cols-5 gap-1" aria-label="Delivery steps">
          {STEPS.map((s) => {
            const done = reached >= ORDER.indexOf(s.key);
            return (
              <li key={s.key} className="flex flex-col gap-1">
                <span className={clsx("h-1.5 rounded-full", done ? "bg-leaf" : "bg-line")} />
                <span className={clsx("text-[11px] leading-tight", done ? "font-semibold text-ink" : "text-ink-faint")}>{s.label}</span>
                {a[s.at] && <span className="text-[10px] text-ink-faint">{time(a[s.at])}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {a.status === "failed" && a.fail_reason && <p className="text-sm text-ink-soft">Reason: {a.fail_reason}. We will contact you to try again.</p>}

      {f.otp && (
        <div className="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-marigold/40" data-testid="delivery-otp-customer">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-marigold-light text-marigold-dark"><KeyRound className="h-5 w-5" aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Delivery OTP</p>
            <p className="font-mono text-2xl font-bold tracking-[0.35em]">{f.otp}</p>
          </div>
          <p className="max-w-[11rem] text-xs text-ink-soft">Share it with the partner only when you receive the package.</p>
        </div>
      )}

      {moving && markers.length > 0 && (
        <div>
          <LiveMap markers={markers} lines={lines} fitKey={`${subId}:${f.location ? "with" : "without"}`} className="h-52 sm:h-60" />
          <p className="mt-1 text-xs text-ink-faint">
            {f.location ? `Partner location updated ${ago(f.location.at, now)}` : "The partner's location shows here once they share it."}
          </p>
        </div>
      )}

      {p && (
        <div className="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-black/5">
          {p.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.photo} alt="" className="h-12 w-12 rounded-full object-cover" />
          ) : (
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-peacock-light font-bold text-peacock">{p.name.slice(0, 1)}</span>
          )}
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{p.name}</p>
            <p className="text-sm text-ink-soft">
              {p.vehicle}{p.vehicle_no ? ` · ${p.vehicle_no}` : ""}
              {p.rating_count > 0 && <span className="ml-2 inline-flex items-center gap-0.5"><Star className="h-3.5 w-3.5 fill-marigold text-marigold" aria-hidden />{p.rating_avg.toFixed(1)}</span>}
            </p>
          </div>
          {a.status !== "delivered" && a.status !== "failed" && (
            <a href={telUrl(p.phone)} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-peacock px-3 text-sm font-semibold text-white hover:bg-peacock-dark">
              <Phone className="h-4 w-4" aria-hidden /> Call
            </a>
          )}
        </div>
      )}

      {a.status === "delivered" && (
        <div className="flex flex-col gap-3">
          {f.can_rate ? <RateForm orderId={orderId} subId={subId} name={p?.name ?? "your delivery partner"} onDone={onChanged} /> : a.rating ? (
            <p className="flex items-center gap-1 text-sm text-ink-soft">You rated this delivery {Array.from({ length: a.rating }, (_, i) => <Star key={i} className="h-4 w-4 fill-marigold text-marigold" aria-hidden />)}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {a.has_proof && (
              <Button variant="secondary" size="sm" onClick={() => setProof(true)}><Camera className="h-4 w-4" aria-hidden /> Delivery photo</Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setComplaint(true)}><MessageSquareWarning className="h-4 w-4" aria-hidden /> Report a problem</Button>
          </div>
        </div>
      )}
      {a.status === "failed" && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setComplaint(true)}><MessageSquareWarning className="h-4 w-4" aria-hidden /> Report a problem</Button>
      )}

      <DocViewer path={proof ? `/api/orders/${orderId}/delivery-proof/${subId}` : null} title="Delivery photo" onClose={() => setProof(false)} />
      <ComplaintDialog open={complaint} orderId={orderId} subId={subId} onClose={() => setComplaint(false)} />
    </div>
  );
}

function RateForm({ orderId, subId, name, onDone }: { orderId: string; subId: string; name: string; onDone: () => void }) {
  const toast = useToast();
  const [stars, setStars] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!stars) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/orders/${orderId}/delivery-rating`, { method: "POST", body: { sub_order_id: subId, rating: stars, comment: comment.trim() } });
      toast("Thanks for rating your delivery");
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save your rating");
    } finally {
      setBusy(false);
    }
  }
  const shown = hover || stars;
  return (
    <div className="rounded-xl bg-white p-3 ring-1 ring-black/5" data-testid="rate-delivery">
      <p className="font-semibold">How was your delivery by {name}?</p>
      <div className="mt-1 flex gap-1" role="radiogroup" aria-label="Rating" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={stars === n} aria-label={`${n} star${n === 1 ? "" : "s"}`}
            onClick={() => setStars(n)} onMouseEnter={() => setHover(n)} className="rounded-lg p-1 transition hover:scale-110">
            <Star className={clsx("h-8 w-8", n <= shown ? "fill-marigold text-marigold" : "text-line")} aria-hidden />
          </button>
        ))}
      </div>
      {stars > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={500} placeholder={stars >= 4 ? "What did you like? (optional)" : "What went wrong? (optional)"} aria-label="Comment" />
          <ErrorNote message={error} />
          <Button size="sm" className="self-start" loading={busy} onClick={submit}>Submit rating</Button>
        </div>
      )}
    </div>
  );
}

function ComplaintDialog({ open, orderId, subId, onClose }: { open: boolean; orderId: string; subId: string; onClose: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/orders/${orderId}/delivery-complaint`, { method: "POST", body: { sub_order_id: subId, category, text: text.trim() } });
      toast("Thanks for telling us. Our delivery team will look into it.");
      setCategory("");
      setText("");
      onClose();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not send your complaint");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Report a delivery problem">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <ErrorNote message={error} />
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">What happened?</legend>
          {COMPLAINTS.map(([k, label]) => (
            <label key={k} className={clsx("flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition", category === k ? "bg-peacock-light ring-peacock" : "ring-line hover:bg-mist")}>
              <input type="radio" name="complaint" value={k} checked={category === k} onChange={() => setCategory(k)} className="h-4 w-4 accent-peacock" />
              <span className="font-medium">{label}</span>
            </label>
          ))}
        </fieldset>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} placeholder="Tell us what happened" aria-label="Details" />
        <Button type="submit" loading={busy} disabled={!category} className="self-start">Send</Button>
      </form>
    </Modal>
  );
}
