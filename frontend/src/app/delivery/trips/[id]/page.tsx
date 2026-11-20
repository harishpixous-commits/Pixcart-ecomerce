"use client";

/*
 * One trip, step by step, built for one hand on a phone: the map with the store, the customer and you; the next thing
 * to do in a big card (reached the store, the seller's pickup code, start the trip, arrived, the customer's OTP, the
 * cash collected and a photo of the delivered package); navigation and call buttons; the address, instructions and
 * items. "Could not deliver" records why. A return trip brings a package back to the store with the seller's code; a
 * return pickup collects a customer's return (their pickup code) and hands it to the store (the seller's code).
 */

import clsx from "clsx";
import {
  ArrowLeft, Banknote, Camera, Check, CheckCircle2, ChevronDown, CircleAlert, Home, KeyRound, LifeBuoy, MapPin, MessageCircle, Navigation, Package, Phone, ShoppingBag, Store,
  Undo2, X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FullLoader, useDeliveryOptions } from "@/components/delivery/app";
import { useFeed } from "@/components/delivery/feed";
import { navigateUrl, telUrl, time, TripPill, TripProgress, usePolling } from "@/components/delivery/trip";
import type { MapLine, MapMarker } from "@/components/map/live-map";
import { Button, ErrorNote, Input, Modal, Textarea, useToast } from "@/components/ui";
import { api, ApiError, downloadBlob } from "@/lib/api";
import type { TripView } from "@/lib/delivery-types";
import { rupees, toPaise } from "@/lib/format";
import { shrinkImage } from "@/lib/image";

const LiveMap = dynamic(() => import("@/components/map/live-map").then((m) => m.LiveMap), {
  ssr: false,
  loading: () => <div className="h-56 animate-pulse rounded-2xl bg-mist sm:h-72" />,
});

type Step = "at_store" | "picked" | "on_the_way" | "reached";
type Pos = { lat: number; lng: number } | null;

/** Where the partner is now: the last shared position if it is recent, else one quick reading. */
function here(last: GeolocationPosition | null): Promise<Pos> {
  if (last && Date.now() - last.timestamp < 60_000) return Promise.resolve({ lat: last.coords.latitude, lng: last.coords.longitude });
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 30_000 },
    );
  });
}

export default function TripPage() {
  const { id } = useParams<{ id: string }>();
  const { refresh: refreshFeed, location } = useFeed();
  const toast = useToast();
  const [trip, setTrip] = useState<TripView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [otp, setOtp] = useState("");
  const [cod, setCod] = useState("");
  const [codMethod, setCodMethod] = useState<"cash" | "upi" | "">("");
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [failing, setFailing] = useState(false);

  const load = useCallback(() => {
    api<TripView>(`/api/delivery/trips/${id}`)
      .then((t) => { setTrip(t); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not open this trip"));
  }, [id]);
  usePolling(load, 15_000);

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  const me: Pos = location.last
    ? { lat: location.last.coords.latitude, lng: location.last.coords.longitude }
    : trip?.partner.lat != null && trip.partner.lng != null ? { lat: trip.partner.lat, lng: trip.partner.lng } : null;
  const back = trip?.kind === "return";
  const collecting = trip?.kind === "pickup"; // a customer's return: first to the customer, then to the store
  const isDelivery = trip?.kind === "delivery";
  const toStore = !!trip && (collecting ? ["picked", "on_the_way", "delivered"].includes(trip.status) : back || ["offered", "accepted", "at_store"].includes(trip.status));
  const meKey = me ? `${me.lat.toFixed(5)},${me.lng.toFixed(5)}` : "";

  const { markers, lines } = useMemo(() => {
    const m: MapMarker[] = [];
    const l: MapLine[] = [];
    if (!trip) return { markers: m, lines: l };
    const [la, ln] = meKey ? meKey.split(",").map(Number) : [NaN, NaN];
    const mine = meKey ? ([la, ln] as [number, number]) : null;
    const store = trip.pickup.lat !== null && trip.pickup.lng !== null ? ([trip.pickup.lat, trip.pickup.lng] as [number, number]) : null;
    const home = trip.drop.lat !== null && trip.drop.lng !== null ? ([trip.drop.lat, trip.drop.lng] as [number, number]) : null;
    if (store) m.push({ id: "store", lat: store[0], lng: store[1], kind: "store", title: trip.pickup.name, popup: `${trip.pickup.name}\n${trip.pickup.address}` });
    if (home && !back) m.push({ id: "home", lat: home[0], lng: home[1], kind: "home", title: "Customer", popup: [trip.drop.name, trip.drop.address].filter(Boolean).join("\n") || "Customer" });
    if (mine) m.push({ id: "me", lat: mine[0], lng: mine[1], kind: "partner", title: "You" });
    const target = toStore ? store : home;
    if (mine && target) l.push({ id: "go", points: [mine, target], color: toStore ? "#F5A524" : "#0B5563", dashed: true });
    return { markers: m, lines: l };
  }, [trip, meKey, toStore, back]);

  if (!trip) {
    if (!error) return <FullLoader label="Opening the trip" />;
    return (
      <div className="mx-auto mt-8 max-w-sm rounded-2xl bg-white p-6 text-center shadow-sm">
        <ErrorNote message={error} />
        <Link href="/delivery" className="mt-4 inline-block font-semibold text-peacock">Back to home</Link>
      </div>
    );
  }
  const t = trip;
  const collect = isDelivery && t.cod_amount > 0;

  async function step(to: Step, label: string) {
    setBusy(to);
    setActionError(null);
    try {
      const pos = await here(location.last);
      const next = await api<TripView>(`/api/delivery/trips/${t.id}/status`, {
        method: "POST",
        body: { to, code: to === "picked" ? code.trim() : "", ...(pos ?? {}) },
      });
      setTrip({ ...t, ...next });
      setCode("");
      toast(label);
      refreshFeed();
      load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not update. Check your internet and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function deliver() {
    setActionError(null);
    if (t.needs.otp && !/^\d{4,6}$/.test(otp.trim())) return setActionError("Enter the 4-digit OTP from the customer.");
    const paise = collect ? toPaise(cod) : 0;
    if (collect && paise === null) return setActionError(`Enter the cash you collected: ${rupees(t.cod_amount)}.`);
    if (collect && !codMethod) return setActionError("Choose how the customer paid: cash or UPI.");
    if (t.needs.photo && !photo) return setActionError("Take a photo of the package at the door.");
    setBusy("deliver");
    try {
      const pos = await here(location.last);
      const form = new FormData();
      form.append("otp", otp.trim());
      if (collect) {
        form.append("cod_collected", String(paise));
        form.append("cod_method", codMethod);
      }
      if (pos) {
        form.append("lat", String(pos.lat));
        form.append("lng", String(pos.lng));
      }
      if (photo) form.append("photo", photo.file);
      const next = await api<TripView>(`/api/delivery/trips/${t.id}/deliver`, { method: "POST", form });
      setTrip({ ...t, ...next });
      navigator.vibrate?.([60, 40, 120]);
      toast("Delivered. Great job!");
      refreshFeed();
      load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not mark delivered. Check your internet and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function handBack() {
    setBusy("returned");
    setActionError(null);
    try {
      const pos = await here(location.last);
      const next = await api<TripView>(`/api/delivery/trips/${t.id}/returned`, { method: "POST", body: { code: code.trim(), ...(pos ?? {}) } });
      setTrip({ ...t, ...next });
      toast("Returned to the store");
      refreshFeed();
      load();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Could not update. Try again.");
    } finally {
      setBusy(null);
    }
  }

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    const small = await shrinkImage(file);
    setPhoto({ file: small, url: URL.createObjectURL(small) });
  }

  const target = toStore ? t.pickup : t.drop;
  const ended = ["delivered", "failed", "cancelled", "rejected", "expired"].includes(t.status);
  const lastNote = [...(t.log ?? [])].reverse().find((x) => x.note)?.note ?? "";

  return (
    <div className="flex flex-col gap-4" data-testid="trip-page">
      <header className="flex flex-wrap items-center gap-2">
        <Link href="/delivery" className="flex h-10 w-10 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-black/5" aria-label="Back to home">
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-faint">{collecting ? `Return pickup${t.return_number ? ` · ${t.return_number}` : ""}` : back ? "Return to store" : "Delivery"}</p>
          <h1 className="font-display text-xl font-bold leading-tight">{t.order_number}</h1>
        </div>
        <TripPill trip={t} />
      </header>

      {!ended && (
        <div className="relative isolate">
          <LiveMap markers={markers} lines={lines} fitKey={`${t.id}:${toStore ? "store" : "home"}:${markers.length}`} className="h-56 sm:h-72" />
          <a href={navigateUrl(target)} target="_blank" rel="noopener noreferrer" data-testid="navigate"
            className="absolute bottom-3 right-3 z-10 inline-flex h-11 items-center gap-2 rounded-full bg-peacock px-4 font-semibold text-white shadow-lg hover:bg-peacock-dark">
            <Navigation className="h-4 w-4" aria-hidden /> Navigate to {toStore ? "store" : "customer"}
          </a>
        </div>
      )}

      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <TripProgress trip={t} />
      </section>

      {/* the next thing to do */}
      <section className="rounded-2xl bg-white p-4 shadow-sm ring-2 ring-peacock/20 sm:p-5" aria-live="polite" data-testid="trip-action">
        <ErrorNote message={actionError} />
        {t.status === "offered" && (
          <Action icon={Package} title="New request" text="Accept or reject it in the request window." />
        )}

        {isDelivery && t.status === "accepted" && (
          <Action icon={Store} title="Go to the store" text={`Pick up ${t.order_number} from ${t.pickup.name}.`}>
            <Button size="lg" className="w-full" loading={busy === "at_store"} onClick={() => step("at_store", "Marked as at the store")} data-testid="step-at-store">
              <Store className="h-5 w-5" aria-hidden /> I have reached the store
            </Button>
          </Action>
        )}

        {isDelivery && t.status === "at_store" && (
          <Action icon={KeyRound} title="Collect the package" text={t.needs.pickup_code ? "Check the items, then ask the seller for the 4-digit pickup code shown on their order screen." : "Check the items and take the package."}>
            {t.needs.pickup_code && (
              <CodeInput label="Seller's pickup code" value={code} onChange={setCode} testId="pickup-code" />
            )}
            <Button size="lg" className="w-full" loading={busy === "picked"} disabled={t.needs.pickup_code && code.trim().length < 4}
              onClick={() => step("picked", "Picked up. Now head to the customer.")} data-testid="step-picked">
              <Package className="h-5 w-5" aria-hidden /> Picked up
            </Button>
          </Action>
        )}

        {isDelivery && t.status === "picked" && (
          <Action icon={Navigation} title="Package with you" text="Start the trip and head to the customer. They can see you on the map.">
            <Button size="lg" className="w-full" loading={busy === "on_the_way"} onClick={() => step("on_the_way", "Trip started")} data-testid="step-on-the-way">
              <Navigation className="h-5 w-5" aria-hidden /> Start the trip
            </Button>
          </Action>
        )}

        {isDelivery && t.status === "on_the_way" && (
          <Action icon={MapPin} title="On the way to the customer" text={t.drop.instructions ? `Note from the customer: ${t.drop.instructions}` : "Call the customer if you can't find the address."}>
            <Button size="lg" className="w-full" loading={busy === "reached"} onClick={() => step("reached", "Marked as arrived. The customer was told.")} data-testid="step-reached">
              <Home className="h-5 w-5" aria-hidden /> I have arrived
            </Button>
          </Action>
        )}

        {isDelivery && t.status === "reached" && (
          <Action icon={CheckCircle2} title="Hand over the package" text="Give the package to the customer, then fill in the details below.">
            <div className="flex flex-col gap-4">
              {t.needs.otp && <CodeInput label="Delivery OTP from the customer" hint="The customer sees it in their SMS and on their order page." value={otp} onChange={setOtp} testId="delivery-otp" />}
              {collect && (
                <div className="rounded-2xl bg-marigold-light/70 p-4">
                  <p className="flex items-center gap-2 font-semibold text-[#8A5A00]"><Banknote className="h-5 w-5" aria-hidden /> Collect {rupees(t.cod_amount)}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {(["cash", "upi"] as const).map((m) => (
                      <button key={m} type="button" onClick={() => setCodMethod(m)} aria-pressed={codMethod === m} data-testid={`cod-${m}`}
                        className={clsx("h-11 rounded-xl font-semibold ring-1 transition", codMethod === m ? "bg-peacock text-white ring-peacock" : "bg-white text-ink ring-line")}>
                        {m === "cash" ? "Cash" : "UPI"}
                      </button>
                    ))}
                  </div>
                  <label className="mt-3 block">
                    <span className="text-sm font-semibold">Amount collected (₹)</span>
                    <Input value={cod} onChange={(e) => setCod(e.target.value)} inputMode="decimal" placeholder={String(t.cod_amount / 100)} className="mt-1 text-lg font-bold" data-testid="cod-amount" />
                  </label>
                </div>
              )}
              {t.needs.photo && (
                <div>
                  <p className="text-sm font-semibold">Photo of the delivered package</p>
                  <p className="text-xs text-ink-faint">At the door or in the customer&apos;s hands. Avoid faces.</p>
                  <label className={clsx("mt-2 flex cursor-pointer items-center gap-3 rounded-2xl border-2 border-dashed p-3 transition", photo ? "border-leaf bg-leaf-light/40" : "border-line hover:border-peacock")}>
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={photo.url} alt="Delivered package" className="h-20 w-20 rounded-xl object-cover" />
                    ) : (
                      <span className="flex h-20 w-20 items-center justify-center rounded-xl bg-mist text-peacock"><Camera className="h-8 w-8" aria-hidden /></span>
                    )}
                    <span className="font-semibold text-peacock">{photo ? "Retake photo" : "Take photo"}</span>
                    <input type="file" accept="image/*" capture="environment" className="sr-only" data-testid="proof-photo"
                      onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ""; }} />
                  </label>
                </div>
              )}
              <Button size="lg" className="w-full !bg-leaf hover:!bg-leaf/90" loading={busy === "deliver"} onClick={deliver} data-testid="mark-delivered">
                <Check className="h-5 w-5" aria-hidden /> Mark as delivered
              </Button>
            </div>
          </Action>
        )}

        {collecting && t.status === "accepted" && (
          <Action icon={MapPin} title="Go to the customer" text={`Collect return ${t.return_number ?? ""} from ${t.drop.name || "the customer"}.`}>
            <Button size="lg" className="w-full" loading={busy === "reached"} onClick={() => step("reached", "Marked as at the customer")} data-testid="step-at-customer">
              <Home className="h-5 w-5" aria-hidden /> I have reached the customer
            </Button>
          </Action>
        )}

        {collecting && t.status === "reached" && (
          <Action icon={KeyRound} title="Collect the return" text={t.needs.otp ? "Check the items below, then ask the customer for their pickup code (on their order page and SMS)." : "Check the items below and collect them."}>
            {t.needs.otp && <CodeInput label="Customer's pickup code" value={code} onChange={setCode} testId="customer-pickup-code" />}
            <Button size="lg" className="w-full" loading={busy === "picked"} disabled={t.needs.otp && code.trim().length < 4}
              onClick={() => step("picked", "Collected. Now bring it to the store.")} data-testid="step-collected">
              <Package className="h-5 w-5" aria-hidden /> Collected
            </Button>
          </Action>
        )}

        {collecting && t.status === "picked" && (
          <Action icon={Store} title="Bring it to the store" text={`Take return ${t.return_number ?? ""} to ${t.pickup.name}.`}>
            <Button size="lg" className="w-full" loading={busy === "on_the_way"} onClick={() => step("on_the_way", "On the way to the store")} data-testid="step-to-store">
              <Navigation className="h-5 w-5" aria-hidden /> Start going to the store
            </Button>
          </Action>
        )}

        {collecting && t.status === "on_the_way" && (
          <Action icon={KeyRound} title="Hand it to the store" text={t.needs.pickup_code ? "Give the return to the seller and enter the pickup code they show you." : "Give the return to the seller."}>
            {t.needs.pickup_code && <CodeInput label="Seller's pickup code" value={code} onChange={setCode} testId="return-code" />}
            <Button size="lg" className="w-full" loading={busy === "returned"} disabled={t.needs.pickup_code && code.trim().length < 4} onClick={handBack} data-testid="handed-to-store">
              <Undo2 className="h-5 w-5" aria-hidden /> Handed to the store
            </Button>
          </Action>
        )}

        {back && ["picked", "on_the_way"].includes(t.status) && (
          <Action icon={Undo2} title="Bring the package back" text={`Take ${t.order_number} back to ${t.pickup.name}.`}>
            {t.status === "picked" ? (
              <Button size="lg" className="w-full" loading={busy === "on_the_way"} onClick={() => step("on_the_way", "On the way back to the store")}>
                <Navigation className="h-5 w-5" aria-hidden /> Start going back
              </Button>
            ) : (
              <Button size="lg" className="w-full" loading={busy === "reached"} onClick={() => step("reached", "Marked as at the store")}>
                <Store className="h-5 w-5" aria-hidden /> I have reached the store
              </Button>
            )}
          </Action>
        )}

        {back && t.status === "reached" && (
          <Action icon={KeyRound} title="Hand the package back" text={t.needs.pickup_code ? "Give the package to the seller and enter their pickup code." : "Give the package to the seller."}>
            {t.needs.pickup_code && <CodeInput label="Seller's pickup code" value={code} onChange={setCode} testId="return-code" />}
            <Button size="lg" className="w-full" loading={busy === "returned"} disabled={t.needs.pickup_code && code.trim().length < 4} onClick={handBack}>
              <Undo2 className="h-5 w-5" aria-hidden /> Handed back to the store
            </Button>
          </Action>
        )}

        {t.status === "delivered" && (
          <div className="flex flex-col items-center gap-2 py-2 text-center" data-testid="trip-done">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-leaf text-white"><Check className="h-9 w-9" strokeWidth={3} aria-hidden /></span>
            <p className="font-display text-2xl font-bold">{back || collecting ? "Returned to the store" : "Delivered"}</p>
            <p className="text-ink-soft">{time(t.delivered_at)}{t.distance_km ? ` · ${t.distance_km} km` : ""}</p>
            <p className="rounded-full bg-leaf-light px-4 py-1.5 font-semibold text-leaf">You earned {rupees(t.fee + t.tip)}{t.tip ? ` (incl. ${rupees(t.tip)} tip)` : ""}</p>
            {t.cod_collected > 0 && <p className="text-sm text-ink-soft">Cash collected {rupees(t.cod_collected)} by {t.cod_method === "upi" ? "UPI" : "cash"}. Deposit cash with the team.</p>}
            {t.has_proof && <ProofThumb id={t.id} />}
            <Link href="/delivery" className="mt-2 inline-flex h-11 items-center rounded-full bg-peacock px-6 font-semibold text-white">Back to home</Link>
          </div>
        )}

        {t.status === "failed" && (
          <Action icon={CircleAlert} title={collecting ? "Return not collected" : "Delivery not completed"}
            text={collecting ? `${t.fail_reason || "Reason recorded"}. The delivery team will arrange another pickup.` : `${t.fail_reason || "Reason recorded"}. Keep the package safe; the delivery team will tell you whether to try again or bring it back to the store.`}>
            <Link href="/delivery" className="inline-flex h-11 items-center rounded-full bg-peacock px-6 font-semibold text-white">Back to home</Link>
          </Action>
        )}

        {["cancelled", "rejected", "expired"].includes(t.status) && (
          <Action icon={X} title={t.status === "cancelled" ? "Trip cancelled" : t.status === "rejected" ? "You rejected this request" : "Request timed out"} text={lastNote || t.status_label}>
            <Link href="/delivery" className="inline-flex h-11 items-center rounded-full bg-peacock px-6 font-semibold text-white">Back to home</Link>
          </Action>
        )}

        {isDelivery && ["picked", "on_the_way", "reached"].includes(t.status) && (
          <button type="button" onClick={() => setFailing(true)} className="mt-3 w-full rounded-xl py-2 text-sm font-semibold text-vermilion hover:bg-vermilion-light" data-testid="cannot-deliver">
            Could not deliver?
          </button>
        )}
        {collecting && ["accepted", "reached"].includes(t.status) && (
          <button type="button" onClick={() => setFailing(true)} className="mt-3 w-full rounded-xl py-2 text-sm font-semibold text-vermilion hover:bg-vermilion-light" data-testid="cannot-collect">
            Could not collect?
          </button>
        )}
      </section>

      {!ended && <TeamHelp orderNumber={t.order_number} />}

      <div className={clsx("grid gap-3 md:grid-cols-2", collecting && "[&>*:first-child]:order-2")}>
        <PlaceCard icon={Store} tone="store" title={back || collecting ? "Bring to" : "Pick up from"} name={t.pickup.name} address={[t.pickup.address, t.pickup.city, t.pickup.pincode].filter(Boolean).join(", ")}
          phone={t.pickup.phone} nav={navigateUrl(t.pickup)} />
        {!back && (
          t.status === "offered" ? (
            <PlaceCard icon={MapPin} tone="home" title={collecting ? "Collect from" : "Deliver to"} name={[t.drop.city, t.drop.pincode].filter(Boolean).join(" ")} address="The full address shows after you accept." />
          ) : ended && !t.drop.phone ? (
            <PlaceCard icon={MapPin} tone="home" title={collecting ? "Collected from" : "Delivered to"} name={[t.drop.city, t.drop.pincode].filter(Boolean).join(" ")}
              address="The customer's name, phone and address are hidden once the trip ends, to protect their privacy." />
          ) : (
            <PlaceCard icon={MapPin} tone="home" title={collecting ? "Collect from" : "Deliver to"} name={t.drop.name} address={[t.drop.address, t.drop.city, t.drop.pincode].filter(Boolean).join(", ")}
              phone={t.drop.phone} nav={navigateUrl(t.drop)} instructions={t.drop.instructions} noBag={t.drop.no_bag} />
          )
        )}
      </div>

      <section className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-2 flex items-center gap-2 font-semibold"><ShoppingBag className="h-4 w-4 text-peacock" aria-hidden /> {collecting ? "Items to collect" : "Items"} ({t.items.reduce((n, i) => n + i.qty, 0)})</h2>
        <ul className="divide-y divide-line">
          {t.items.map((i, k) => (
            <li key={k} className="flex items-center gap-3 py-2">
              {i.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={i.image} alt="" className="h-12 w-12 rounded-lg object-cover ring-1 ring-line" />
              ) : <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-mist"><Package className="h-5 w-5 text-ink-faint" aria-hidden /></span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{i.title}</span>
                {i.variant && <span className="text-sm text-ink-soft">{i.variant}</span>}
              </span>
              <span className="font-semibold">× {i.qty}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3 text-sm">
          {collect ? (
            <span className="rounded-full bg-marigold-light px-3 py-1 font-semibold text-[#8A5A00]">Cash on delivery: collect {rupees(t.cod_amount)}</span>
          ) : (
            <span className="rounded-full bg-leaf-light px-3 py-1 font-semibold text-leaf">{collecting ? "Return pickup: collect no money" : back ? "Return trip" : "Prepaid: collect nothing"}</span>
          )}
          {!ended && (
            <span className="rounded-full bg-mist px-3 py-1 font-semibold">
              You earn about {rupees(t.fee_estimate)}{(t.bonus_now ?? 0) > 0 ? ` (incl. ${rupees(t.bonus_now ?? 0)} bad weather bonus)` : ""}
            </span>
          )}
          {t.status === "delivered" && (
            <span className="rounded-full bg-leaf-light px-3 py-1 font-semibold text-leaf" data-testid="trip-earned">
              You earned {rupees(t.fee + t.tip + (t.bonus ?? 0))}
              {t.tip || t.bonus ? <span className="font-normal"> ({[`fee ${rupees(t.fee)}`, t.tip ? `tip ${rupees(t.tip)}` : "", t.bonus ? `bonus ${rupees(t.bonus)}` : ""].filter(Boolean).join(", ")})</span> : null}
            </span>
          )}
        </div>
      </section>

      {t.log && t.log.length > 0 && (
        <details className="group rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <summary className="flex cursor-pointer list-none items-center justify-between font-semibold">
            Trip history <ChevronDown className="h-4 w-4 transition group-open:rotate-180" aria-hidden />
          </summary>
          <ol className="mt-3 flex flex-col gap-2 border-l-2 border-line pl-4">
            {t.log.map((x, i) => (
              <li key={i} className="text-sm">
                <span className="font-semibold">{x.status.replace(/_/g, " ")}</span> <span className="text-ink-faint">{time(x.at)}</span>
                {x.note && <p className="text-ink-soft">{x.note}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}

      <FailDialog open={failing} tripId={t.id} collecting={collecting} onClose={() => setFailing(false)} onDone={(next) => { setFailing(false); setTrip({ ...t, ...next }); refreshFeed(); load(); }}
        last={location.last} />
    </div>
  );
}

/** A problem on the road (accident, wrong item, unsafe place, app trouble): call or message the delivery team. */
function TeamHelp({ orderNumber }: { orderNumber: string }) {
  const options = useDeliveryOptions();
  const phone = options?.support_phone ?? "";
  const whatsapp = (options?.support_whatsapp ?? "").replace(/\D/g, "");
  if (!phone && !whatsapp) return null;
  const wa = whatsapp ? `https://wa.me/${whatsapp.length === 10 ? `91${whatsapp}` : whatsapp}?text=${encodeURIComponent(`Help with delivery ${orderNumber}`)}` : "";
  return (
    <section className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5" aria-label="Help from the delivery team" data-testid="trip-help">
      <LifeBuoy className="h-5 w-5 shrink-0 text-vermilion" aria-hidden />
      <p className="min-w-0 flex-1 text-sm"><span className="font-semibold">Problem on the way?</span> <span className="text-ink-soft">Talk to the delivery team.</span></p>
      {phone && <a href={telUrl(phone)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-vermilion-light px-3 text-sm font-semibold text-vermilion"><Phone className="h-4 w-4" aria-hidden />Call</a>}
      {wa && <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-leaf-light px-3 text-sm font-semibold text-leaf"><MessageCircle className="h-4 w-4" aria-hidden />WhatsApp</a>}
    </section>
  );
}

function Action({ icon: Icon, title, text, children }: { icon: typeof Store; title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-peacock-light text-peacock"><Icon className="h-6 w-6" aria-hidden /></span>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-bold leading-tight">{title}</h2>
          <p className="text-ink-soft">{text}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function CodeInput({ label, hint, value, onChange, testId }: { label: string; hint?: string; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold">{label}</span>
      {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
      <Input value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••"
        className="mt-1 h-14 text-center font-mono text-2xl font-bold tracking-[0.5em]" data-testid={testId} />
    </label>
  );
}

function PlaceCard({ icon: Icon, tone, title, name, address, phone, nav, instructions, noBag }: {
  icon: typeof Store; tone: "store" | "home"; title: string; name: string; address: string; phone?: string; nav?: string; instructions?: string; noBag?: boolean;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-ink-faint">
        <span className={clsx("flex h-6 w-6 items-center justify-center rounded-full text-white", tone === "store" ? "bg-marigold" : "bg-vermilion")}><Icon className="h-3.5 w-3.5" aria-hidden /></span>
        {title}
      </p>
      <p className="font-semibold">{name}</p>
      <p className="text-sm text-ink-soft">{address}</p>
      {instructions && <p className="rounded-xl bg-marigold-light/70 px-3 py-2 text-sm"><b>Instructions:</b> {instructions}</p>}
      {noBag && <p className="text-sm font-semibold text-leaf">Customer asked for no carry bag</p>}
      {(phone || nav) && (
        <div className="mt-1 flex gap-2">
          {phone && (
            <a href={telUrl(phone)} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-peacock-light font-semibold text-peacock hover:bg-peacock hover:text-white">
              <Phone className="h-4 w-4" aria-hidden /> Call
            </a>
          )}
          {nav && (
            <a href={nav} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-peacock-light font-semibold text-peacock hover:bg-peacock hover:text-white">
              <Navigation className="h-4 w-4" aria-hidden /> Directions
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function ProofThumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made = "";
    downloadBlob(`/api/delivery/trips/${id}/proof`).then((b) => {
      made = URL.createObjectURL(b);
      if (live) setUrl(made);
    }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  if (!url) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="Delivery photo" className="mt-1 h-28 w-28 rounded-2xl object-cover ring-1 ring-line" />;
}

function FailDialog({ open, tripId, collecting, onClose, onDone, last }: {
  open: boolean; tripId: string; collecting: boolean; onClose: () => void; onDone: (t: TripView) => void; last: GeolocationPosition | null;
}) {
  const options = useDeliveryOptions();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      const pos = await here(last);
      const next = await api<TripView>(`/api/delivery/trips/${tripId}/fail`, { method: "POST", body: { reason, note: note.trim(), ...(pos ?? {}) } });
      setReason("");
      setNote("");
      onDone(next);
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={collecting ? "Why could you not collect the return?" : "Why could you not deliver?"}>
      <form onSubmit={submit} className="flex flex-col gap-3" data-testid="fail-dialog">
        <p className="text-sm text-ink-soft">{collecting ? "Call the customer first. If you still cannot collect it, choose why." : "Call the customer first. If you still cannot deliver, choose why. Keep the package safe with you."}</p>
        <ErrorNote message={error} />
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Reason</legend>
          {Object.entries(options?.fail_reasons ?? {}).filter(([k]) => !(collecting && k === "no_cash")).map(([k, label]) => (
            <label key={k} className={clsx("flex cursor-pointer items-center gap-3 rounded-xl p-3 ring-1 transition", reason === k ? "bg-vermilion-light ring-vermilion" : "ring-line hover:bg-mist")}>
              <input type="radio" name="fail" value={k} checked={reason === k} onChange={() => setReason(k)} className="h-4 w-4 accent-vermilion" />
              <span className="font-medium">{label}</span>
            </label>
          ))}
        </fieldset>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add details (optional)" rows={2} maxLength={200} aria-label="Details" />
        <Button type="submit" variant="danger" loading={busy} disabled={!reason} className="self-start">{collecting ? "Report not collected" : "Report not delivered"}</Button>
      </form>
    </Modal>
  );
}
