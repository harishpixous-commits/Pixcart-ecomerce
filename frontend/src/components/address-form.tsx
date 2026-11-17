"use client";

import { useState } from "react";
import { Button, ErrorNote, Field, Select, TextField } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { STATE_OPTIONS } from "@/lib/format";
import type { Address } from "@/lib/types";

type FormState = {
  full_name: string; phone: string; line1: string; line2: string; landmark: string; city: string;
  state_code: string; pincode: string; kind: "home" | "work" | "other"; is_default: boolean;
};
const EMPTY: FormState = { full_name: "", phone: "", line1: "", line2: "", landmark: "", city: "", state_code: "33", pincode: "", kind: "home", is_default: false };

export function AddressForm({ initial, onSaved, onCancel }: { initial?: Address; onSaved: (a: Address) => void; onCancel?: () => void }) {
  const [f, setF] = useState<FormState>(() => {
    if (!initial) return EMPTY;
    const { full_name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default } = initial;
    return { full_name, phone, line1, line2, landmark, city, state_code, pincode, kind, is_default };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const body = { ...f };
      const saved = initial
        ? await api<Address>(`/api/addresses/${initial.id}`, { method: "PUT", body })
        : await api<Address>("/api/addresses", { method: "POST", body });
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><ErrorNote message={error} /></div>
      <TextField label="Full name" value={f.full_name} onChange={set("full_name")} required autoComplete="name" error={fields.full_name} />
      <TextField label="Mobile number" type="tel" value={f.phone} onChange={set("phone")} required autoComplete="tel-national" error={fields.phone} />
      <TextField className="sm:col-span-2" label="House no., building, street" value={f.line1} onChange={set("line1")} required autoComplete="address-line1" error={fields.line1} />
      <TextField className="sm:col-span-2" label="Area, locality (optional)" value={f.line2} onChange={set("line2")} autoComplete="address-line2" />
      <TextField label="Landmark (optional)" value={f.landmark} onChange={set("landmark")} />
      <TextField label="PIN code" inputMode="numeric" maxLength={6} value={f.pincode} onChange={set("pincode")} required autoComplete="postal-code" error={fields.pincode} />
      <TextField label="Town or city" value={f.city} onChange={set("city")} required autoComplete="address-level2" error={fields.city} />
      <Field label="State" htmlFor="addr-state">
        <Select id="addr-state" value={f.state_code} onChange={set("state_code")}>
          {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </Select>
      </Field>
      <fieldset className="flex items-center gap-4 sm:col-span-2">
        <legend className="sr-only">Address type</legend>
        {(["home", "work", "other"] as const).map((k) => (
          <label key={k} className="flex items-center gap-1.5 capitalize">
            <input type="radio" name="kind" className="accent-peacock" checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} /> {k}
          </label>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-sm">
          <input type="checkbox" className="accent-peacock" checked={f.is_default} onChange={(e) => setF({ ...f, is_default: e.target.checked })} /> Make default
        </label>
      </fieldset>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" loading={busy}>Save address</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
