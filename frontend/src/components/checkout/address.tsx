"use client";

/* Delivery address at checkout: the chosen address, a list to switch to another one, and the form to add one. */

import clsx from "clsx";
import { Briefcase, Check, Crosshair, Home, LocateFixed, MapPin, Plus } from "lucide-react";
import { useState } from "react";
import { AddressForm } from "@/components/address-form";
import { LocationPicker, useCurrentPosition } from "@/components/map/location-picker";
import { Button, Modal, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Address } from "@/lib/types";
import { Card, CardHeading } from "./card";

const KIND_LABEL: Record<Address["kind"], string> = { home: "Home", work: "Work", other: "Other" };

export function addressName(a: Address): string {
  return a.label?.trim() || KIND_LABEL[a.kind] || "Address";
}

function addressLine(a: Address): string {
  return `${[a.line1, a.line2, a.landmark, a.city].filter(Boolean).join(", ")}, ${a.state} ${a.pincode}`;
}

function KindIcon({ kind, className }: { kind: Address["kind"]; className?: string }) {
  if (kind === "home") return <Home className={className} aria-hidden />;
  if (kind === "work") return <Briefcase className={className} aria-hidden />;
  return <MapPin className={className} aria-hidden />;
}

function AddressText({ a }: { a: Address }) {
  return (
    <span className="block min-w-0">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-md bg-peacock-light px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-peacock">
          <KindIcon kind={a.kind} className="h-3.5 w-3.5" />
          {addressName(a)}
        </span>
        {a.is_default && <span className="text-xs font-semibold text-ink-faint">Default</span>}
      </span>
      <span className="mt-1.5 block font-semibold text-ink">
        {a.full_name} <span className="font-normal text-ink-soft">· {a.phone}</span>
      </span>
      <span className="block text-sm leading-snug text-ink-soft" translate="no">{addressLine(a)}</span>
    </span>
  );
}

export function AddressSection({ addresses, selectedId, onSelect, adding, onAdd, onCancelAdd, onSaved }: {
  addresses: Address[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  adding: boolean;
  onAdd: () => void;
  onCancelAdd?: () => void;
  onSaved: (a: Address) => void;
}) {
  const [picking, setPicking] = useState(false);
  const selected = addresses.find((a) => a.id === selectedId) ?? null;
  const showList = !adding && (picking || !selected);

  return (
    <Card labelledBy="co-address-h" testId="checkout-address">
      <CardHeading
        id="co-address-h"
        icon={MapPin}
        title="Delivery address"
        sub={adding ? "Where should we deliver this order?" : undefined}
        action={
          !adding && selected ? (
            <button
              type="button"
              onClick={() => setPicking((p) => !p)}
              aria-expanded={picking}
              aria-controls="co-address-list"
              className="rounded-lg px-2.5 py-1.5 text-sm font-bold uppercase tracking-wide text-peacock hover:bg-peacock-light"
            >
              {picking ? "Done" : "Change"}
            </button>
          ) : null
        }
      />

      {adding ? (
        <AddressForm onSaved={onSaved} onCancel={onCancelAdd} />
      ) : showList ? (
        <fieldset id="co-address-list">
          <legend className="sr-only">Choose a delivery address</legend>
          <div className="flex flex-col gap-2">
            {addresses.map((a) => {
              const on = a.id === selectedId;
              return (
                <label
                  key={a.id}
                  className={clsx(
                    "flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-peacock has-[:focus-visible]:ring-offset-1",
                    on ? "border-peacock bg-peacock-light/40" : "border-line hover:border-peacock/40",
                  )}
                >
                  <input type="radio" name="address" className="sr-only" checked={on} onChange={() => onSelect(a.id)} />
                  <span
                    aria-hidden
                    className={clsx(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                      on ? "border-peacock bg-peacock text-white" : "border-line bg-white",
                    )}
                  >
                    {on && <Check className="h-3 w-3" strokeWidth={3.5} />}
                  </span>
                  <AddressText a={a} />
                </label>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              setPicking(false);
              onAdd();
            }}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-peacock/40 py-2.5 font-semibold text-peacock hover:bg-peacock-light/50"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add a new address
          </button>
        </fieldset>
      ) : selected ? (
        <div className="flex flex-col gap-2">
          <div className="rounded-xl bg-mist/70 p-3 ring-1 ring-inset ring-line/70" data-testid="checkout-address-chosen">
            <AddressText a={selected} />
          </div>
          <PinPrompt key={selected.id} address={selected} onSaved={onSaved} />
        </div>
      ) : null}
    </Card>
  );
}

/**
 * "Pin your exact location" for the chosen address: one tap asks the browser for the location (the person's own
 * tap, so the permission prompt is expected) and saves it, or pick the spot on the map. Pinned addresses show a
 * short confirmation with "Adjust".
 */
function PinPrompt({ address, onSaved }: { address: Address; onSaved: (a: Address) => void }) {
  const toast = useToast();
  const here = useCurrentPosition();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(address.lat != null && address.lng != null ? { lat: address.lat, lng: address.lng } : null);
  const [busy, setBusy] = useState(false);
  const pinned = address.lat != null && address.lng != null;

  async function save(p: { lat: number; lng: number }) {
    setBusy(true);
    try {
      const a = await api<Address>(`/api/addresses/${address.id}/location`, { method: "PATCH", body: p });
      toast("Location pinned. Your delivery partner will navigate straight to it.");
      setOpen(false);
      onSaved(a);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save the location", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {pinned ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-ink-soft" data-testid="checkout-pinned">
          <LocateFixed className="h-4 w-4 text-leaf" aria-hidden />
          <span>Location pinned on the map</span>
          <button type="button" onClick={() => setOpen(true)} className="font-semibold text-peacock hover:underline">Adjust</button>
        </p>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-peacock/40 bg-peacock-light/30 p-3 sm:flex-row sm:items-center" data-testid="checkout-pin-prompt">
          <span className="flex min-w-0 flex-1 items-start gap-2.5">
            <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-peacock" aria-hidden />
            <span className="text-sm">
              <span className="block font-semibold text-ink">Pin your exact location</span>
              <span className="text-ink-soft">
                {here.status === "denied" ? "Location is blocked for this site. Allow it in your browser settings, or pick the spot on the map." : "Helps the delivery partner reach your door without calling you."}
              </span>
            </span>
          </span>
          <span className="flex shrink-0 gap-2">
            {here.status !== "denied" && here.status !== "unsupported" && (
              <Button size="sm" loading={here.status === "asking" || busy} onClick={() => here.locate((lat, lng) => save({ lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }))}>
                <Crosshair className="h-4 w-4" aria-hidden /> Use my location
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Pick on map</Button>
          </span>
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Pin your delivery location" wide>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-soft" translate="no">{addressLine(address)}</p>
          <LocationPicker value={pin} onChange={(lat, lng) => setPin({ lat, lng })} />
          <Button className="self-start" disabled={!pin} loading={busy} onClick={() => pin && save(pin)}>Save this location</Button>
        </div>
      </Modal>
    </>
  );
}
