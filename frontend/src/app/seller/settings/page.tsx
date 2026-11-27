"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, PageLoader, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { SellerProfile } from "@/lib/types";

export default function SellerSettings() {
  const toast = useToast();
  const { reloadUser } = useSession();
  const [p, setP] = useState<SellerProfile | null>(null);
  const [store, setStore] = useState({ display_name: "", description: "", contact_email: "", contact_phone: "" });
  const [g, setG] = useState({ name: "", email: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<{ dispatch_days: number; holiday_mode: boolean; invoice_prefix: string; dispatch_cutoff: string; free_shipping_threshold_paise: number | null; free_shipping_bounds: { min_paise: number; max_paise: number } | null } | null>(null);

  useEffect(() => {
    api<SellerProfile>("/api/seller/me").then((s) => {
      setP(s);
      setStore({ display_name: s.display_name, description: s.description, contact_email: s.contact_email, contact_phone: s.contact_phone });
      setG(s.grievance);
    }).catch(quietly);
    api<{ dispatch_days: number; holiday_mode: boolean; invoice_prefix: string; dispatch_cutoff: string; free_shipping_threshold_paise: number | null; free_shipping_bounds: { min_paise: number; max_paise: number } | null }>("/api/seller/preferences").then(setPrefs).catch(quietly);
  }, []);

  async function save(key: string, path: string, body: object) {
    setBusy(key);
    setError(null);
    try {
      setP(await api<SellerProfile>(path, { method: "PUT", body }));
      await reloadUser();
      toast("Saved");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setBusy(null);
    }
  }

  if (!p) return <PageLoader />;
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <PageHeader title="Store settings" />
      <ErrorNote message={error} />
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-3 text-xl font-semibold">Store details</h2>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save("store", "/api/seller/store", store); }}>
          <TextField label="Store name" value={store.display_name} onChange={(e) => setStore({ ...store, display_name: e.target.value })} required />
          <TextField label="Business email" type="email" value={store.contact_email} onChange={(e) => setStore({ ...store, contact_email: e.target.value })} required />
          <TextField label="Business mobile" value={store.contact_phone} onChange={(e) => setStore({ ...store, contact_phone: e.target.value })} required />
          <Field label="About your store" className="sm:col-span-2"><Textarea value={store.description} onChange={(e) => setStore({ ...store, description: e.target.value })} maxLength={2000} /></Field>
          <Button type="submit" loading={busy === "store"} className="self-start">Save store details</Button>
        </form>
      </section>
      {prefs && (
        <section className="rounded-xl bg-white p-5">
          <h2 className="mb-3 text-xl font-semibold">Selling preferences</h2>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
            e.preventDefault();
            setBusy("prefs");
            setError(null);
            try { setPrefs(await api("/api/seller/preferences", { method: "PUT", body: prefs })); toast("Saved"); }
            catch (err) { setError(err instanceof ApiError ? err.message : "Could not save"); }
            finally { setBusy(null); }
          }}>
            <TextField label="Days to dispatch after an order" inputMode="numeric" value={String(prefs.dispatch_days)} onChange={(e) => setPrefs({ ...prefs, dispatch_days: Math.min(10, Number(e.target.value.replace(/\D/g, "")) || 0) })} hint="Used for the delivery date customers see" />
            <div className="flex flex-col gap-1">
              <label htmlFor="cutoff" className="text-sm font-medium">Daily dispatch cut-off (optional)</label>
              <div className="flex items-center gap-2">
                <input id="cutoff" type="time" value={prefs.dispatch_cutoff} onChange={(e) => setPrefs({ ...prefs, dispatch_cutoff: e.target.value })}
                  className="h-11 rounded-lg border border-line px-3" />
                {prefs.dispatch_cutoff && <button type="button" onClick={() => setPrefs({ ...prefs, dispatch_cutoff: "" })} className="text-sm text-ink-faint hover:text-vermilion">Clear</button>}
              </div>
              <p className="text-xs text-ink-faint">Orders before this time count from today; later ones from the next working day. Shoppers see &ldquo;Order within 2 hrs 10 mins&rdquo; on your product pages.</p>
            </div>
            {prefs.free_shipping_bounds && (
              <TextField label="Free delivery from (rupees)" inputMode="numeric"
                value={prefs.free_shipping_threshold_paise == null ? "" : String(Math.round(prefs.free_shipping_threshold_paise / 100))}
                onChange={(e) => { const d = e.target.value.replace(/\D/g, ""); setPrefs({ ...prefs, free_shipping_threshold_paise: d === "" ? null : Number(d) * 100 }); }}
                hint={`Orders from you above this amount ship free. Between ${Math.round(prefs.free_shipping_bounds.min_paise / 100)} and ${Math.round(prefs.free_shipping_bounds.max_paise / 100)}. Leave empty to use the marketplace amount.`} />
            )}
            <TextField label="Invoice prefix" value={prefs.invoice_prefix} maxLength={4} onChange={(e) => setPrefs({ ...prefs, invoice_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} hint="Up to 4 letters, e.g. KOV gives KOV/26-27/000001" />
            <label className="flex items-start gap-3 rounded-lg bg-marigold-light p-3 sm:col-span-2">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={prefs.holiday_mode} onChange={(e) => setPrefs({ ...prefs, holiday_mode: e.target.checked })} />
              <span><strong>Holiday mode.</strong> Your products are hidden and no new orders come in. Orders already placed still need to be shipped.</span>
            </label>
            <Button type="submit" loading={busy === "prefs"} className="self-start">Save preferences</Button>
          </form>
        </section>
      )}
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-3 text-xl font-semibold">Grievance officer</h2>
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save("g", "/api/seller/grievance-officer", g); }}>
          <TextField label="Name" value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} required />
          <TextField label="Email" type="email" value={g.email} onChange={(e) => setG({ ...g, email: e.target.value })} required />
          <TextField label="Mobile" value={g.phone} onChange={(e) => setG({ ...g, phone: e.target.value })} required />
          <Button type="submit" loading={busy === "g"} className="self-start">Save</Button>
        </form>
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-2 text-xl font-semibold">Business and bank details</h2>
        <dl className="grid grid-cols-[160px_1fr] gap-y-1 text-[15px]">
          <dt className="text-ink-faint">Legal name</dt><dd>{p.legal_name}</dd>
          <dt className="text-ink-faint">GSTIN</dt><dd>{p.gstin}</dd>
          <dt className="text-ink-faint">PAN</dt><dd>{p.pan}</dd>
          <dt className="text-ink-faint">Pickup</dt><dd>{p.pickup.line1}, {p.pickup.city}, {p.pickup.state} {p.pickup.pincode}</dd>
          <dt className="text-ink-faint">Bank</dt><dd>{p.bank.holder_name}, {p.bank.account_number}, {p.bank.ifsc}</dd>
        </dl>
        <p className="mt-3 text-sm text-ink-soft">To protect your payouts, these verified details can be changed only through seller support.</p>
      </section>
    </div>
  );
}
