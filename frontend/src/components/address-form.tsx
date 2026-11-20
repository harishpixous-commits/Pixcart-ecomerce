"use client";

/*
 * Add or edit a delivery address: an optional map pin for the exact door ("use my current location" or tap the map),
 * the address itself (the state fills in from the PIN code), a name for it (Home, Work or your own, like "Mom's
 * house"), and standing delivery instructions with quick choices. The pin and instructions reach the delivery partner.
 */

import clsx from "clsx";
import { Briefcase, ChevronDown, Home, MapPin, Tag } from "lucide-react";
import { useState } from "react";
import { LocationPicker } from "@/components/map/location-picker";
import { Button, ErrorNote, Field, Select, Textarea, TextField } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { STATE_OPTIONS } from "@/lib/format";
import { stateForPin } from "@/lib/pin-state";
import type { Address } from "@/lib/types";

type FormState = {
  full_name: string; phone: string; line1: string; line2: string; landmark: string; city: string;
  state_code: string; pincode: string; kind: "home" | "work" | "other"; is_default: boolean;
  label: string; instructions: string; lat: number | null; lng: number | null;
};
const EMPTY: FormState = {
  full_name: "", phone: "", line1: "", line2: "", landmark: "", city: "", state_code: "33", pincode: "", kind: "home", is_default: false,
  label: "", instructions: "", lat: null, lng: null,
};

const QUICK_NOTES = ["Leave at the door", "Call when you arrive", "Ring the bell", "Hand it to security", "Do not ring the bell"];

const KINDS = [
  { key: "home", label: "Home", icon: Home },
  { key: "work", label: "Work", icon: Briefcase },
  { key: "other", label: "Other", icon: Tag },
] as const;

export function AddressForm({ initial, onSaved, onCancel }: { initial?: Address; onSaved: (a: Address) => void; onCancel?: () => void }) {
  const [f, setF] = useState<FormState>(() => {
    if (!initial) return EMPTY;
    const { full_name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default } = initial;
    return { full_name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default, label: initial.label ?? "", instructions: initial.instructions ?? "",
      lat: initial.lat ?? null, lng: initial.lng ?? null };
  });
  // the state follows the PIN code until the person picks one themselves
  const [stateTouched, setStateTouched] = useState(!!initial);
  const [mapOpen, setMapOpen] = useState(!initial || initial.lat == null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  function setPin(value: string) {
    const pin = value.replace(/\D/g, "").slice(0, 6);
    const st = stateForPin(pin);
    setF((cur) => ({ ...cur, pincode: pin, state_code: !stateTouched && st ? st : cur.state_code }));
  }

  function addNote(text: string) {
    setF((cur) => {
      const has = cur.instructions.toLowerCase().includes(text.toLowerCase());
      if (has) return cur;
      const joined = cur.instructions.trim() ? `${cur.instructions.trim().replace(/[.,;]$/, "")}. ${text}` : text;
      return { ...cur, instructions: joined.slice(0, 300) };
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const body = {
        full_name: f.full_name, phone: f.phone, line1: f.line1, line2: f.line2, landmark: f.landmark, city: f.city, state_code: f.state_code, pincode: f.pincode,
        kind: f.kind, is_default: f.is_default, label: f.kind === "other" ? f.label.trim() : "", instructions: f.instructions.trim(),
        lat: f.lat, lng: f.lng,
      };
      const saved = initial
        ? await api<Address>(`/api/addresses/${initial.id}`, { method: "PUT", body })
        : await api<Address>("/api/addresses", { method: "POST", body });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError("Could not save the address. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const pinned = f.lat !== null && f.lng !== null;
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" data-testid="address-form">
      <div className="sm:col-span-2"><ErrorNote message={error} /></div>

      <div className="rounded-2xl bg-mist/70 p-3 ring-1 ring-line sm:col-span-2">
        <button type="button" onClick={() => setMapOpen((o) => !o)} aria-expanded={mapOpen}
          className="flex w-full items-center gap-3 text-left">
          <span className={clsx("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", pinned ? "bg-leaf text-white" : "bg-peacock-light text-peacock")}><MapPin className="h-5 w-5" aria-hidden /></span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{pinned ? "Location pinned on the map" : "Pin your location (recommended)"}</span>
            <span className="block text-sm text-ink-soft">{pinned ? "The delivery partner navigates straight to this spot." : "Helps the delivery partner reach your door without calls."}</span>
          </span>
          <ChevronDown className={clsx("h-5 w-5 shrink-0 text-ink-faint transition-transform", mapOpen && "rotate-180")} aria-hidden />
        </button>
        {mapOpen && (
          <div className="mt-3">
            <LocationPicker compact value={pinned ? { lat: f.lat as number, lng: f.lng as number } : null} onChange={(lat, lng) => setF((cur) => ({ ...cur, lat, lng }))} />
            {pinned && (
              <button type="button" onClick={() => setF((cur) => ({ ...cur, lat: null, lng: null }))} className="mt-1 text-xs font-semibold text-vermilion">Remove pin</button>
            )}
          </div>
        )}
      </div>

      <TextField label="Full name" value={f.full_name} onChange={set("full_name")} required autoComplete="name" error={fields.full_name} />
      <TextField label="Mobile number" type="tel" value={f.phone} onChange={set("phone")} required autoComplete="tel-national" error={fields.phone} />
      <TextField className="sm:col-span-2" label="House no., building, street" value={f.line1} onChange={set("line1")} required autoComplete="address-line1" error={fields.line1} />
      <TextField className="sm:col-span-2" label="Area, locality (optional)" value={f.line2} onChange={set("line2")} autoComplete="address-line2" />
      <TextField label="Landmark (optional)" value={f.landmark} onChange={set("landmark")} placeholder="Near the temple, opposite the park" />
      <TextField label="PIN code" inputMode="numeric" maxLength={6} value={f.pincode} onChange={(e) => setPin(e.target.value)} required autoComplete="postal-code" error={fields.pincode} />
      <TextField label="Town or city" value={f.city} onChange={set("city")} required autoComplete="address-level2" error={fields.city} />
      <Field label="State" htmlFor="addr-state">
        <Select id="addr-state" value={f.state_code} onChange={(e) => { setStateTouched(true); setF({ ...f, state_code: e.target.value }); }} autoComplete="address-level1">
          {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </Select>
      </Field>

      <fieldset className="flex flex-col gap-2 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium text-ink">Save as</legend>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <label key={k.key} className={clsx("inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-peacock",
              f.kind === k.key ? "bg-peacock text-white ring-peacock" : "bg-white text-ink ring-line hover:ring-peacock/40")}>
              <input type="radio" name="kind" className="sr-only" checked={f.kind === k.key} onChange={() => setF({ ...f, kind: k.key })} />
              <k.icon className="h-4 w-4" aria-hidden /> {k.label}
            </label>
          ))}
        </div>
        {f.kind === "other" && (
          <TextField label="Name this address" value={f.label} onChange={set("label")} maxLength={40} placeholder="e.g. Mom's house, Hostel" error={fields.label} />
        )}
      </fieldset>

      <div className="flex flex-col gap-2 sm:col-span-2">
        <Field label="Delivery instructions (optional)" htmlFor="addr-notes" hint="Saved with this address and shown to the delivery partner.">
          <Textarea id="addr-notes" value={f.instructions} onChange={set("instructions")} maxLength={300} rows={2} className="min-h-[64px]" placeholder="e.g. Second floor, blue gate" />
        </Field>
        <div className="flex flex-wrap gap-1.5" aria-label="Quick instructions">
          {QUICK_NOTES.map((n) => (
            <button key={n} type="button" onClick={() => addNote(n)} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink-soft ring-1 ring-line hover:text-peacock hover:ring-peacock/40">
              + {n}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" className="h-4 w-4 accent-peacock" checked={f.is_default} onChange={(e) => setF({ ...f, is_default: e.target.checked })} /> Make this my default address
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" loading={busy}>Save address</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
