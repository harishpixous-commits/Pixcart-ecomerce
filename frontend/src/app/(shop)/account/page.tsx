"use client";

import { MapPin } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AddressForm } from "@/components/address-form";
import { SavedCards } from "@/components/saved-cards";
import { SignedInDevices } from "@/components/signed-in-devices";
import { Button, ErrorNote, Modal, PageLoader, Pill, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Address } from "@/lib/types";

function PrivacySection({ marketing, onChanged, onDeleted }: { marketing: boolean; onChanged: () => Promise<void>; onDeleted: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function download() {
    const data = await api("/api/account/export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    a.download = "my-pixcart-data.json";
    a.click();
  }
  async function remove() {
    setError(null);
    try {
      await api("/api/account", { method: "DELETE" });
      toast("Your account has been deleted");
      onDeleted();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete the account");
    }
  }
  return (
    <section className="rounded-xl bg-white p-5">
      <h2 className="mb-3 text-xl font-semibold">Privacy and data</h2>
      <label className="flex items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={marketing} onChange={async (e) => { await api("/api/account/consent", { method: "PUT", body: { marketing_opt_in: e.target.checked } }); await onChanged(); toast("Saved"); }} />
        <span>Send me offers and deals by SMS, WhatsApp and email. Order updates are always sent.</span>
      </label>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={download}>Download my data</Button>
        <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>Delete my account</Button>
      </div>
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Delete your account?">
        <p className="mb-3 text-ink-soft">Your profile, addresses and wishlist are erased and you are signed out everywhere. Invoices and order records are kept for the period the GST law requires, without your name or contact details on your account.</p>
        <ErrorNote message={error} />
        <TextField label='Type "DELETE" to confirm' value={typed} onChange={(e) => setTyped(e.target.value)} />
        <Button className="mt-3" variant="buy" disabled={typed !== "DELETE"} onClick={remove}>Delete my account</Button>
      </Modal>
    </section>
  );
}

export default function AccountPage() {
  const { user, ready, reloadUser, signOut } = useSession();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [editing, setEditing] = useState<Address | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // fill the form from the signed-in account once (and again only if another account signs in)
  const [seeded, setSeeded] = useState<string | null>(null);
  if (user && seeded !== user.id) {
    setSeeded(user.id);
    setName(user.name);
    setEmail(user.email ?? "");
  }

  const load = useCallback(() => api<Address[]>("/api/addresses").then(setAddresses).catch(quietly), []);
  useEffect(() => {
    if (ready && !user) router.replace("/login?next=/account");
    if (user) load();
  }, [ready, user, router, load]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api("/api/auth/me", { method: "PATCH", body: { name, ...(email ? { email } : {}) } });
      await reloadUser();
      toast("Profile saved");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function remove(a: Address) {
    await api(`/api/addresses/${a.id}`, { method: "DELETE" });
    toast("Address removed");
    load();
  }

  if (!user || !addresses) return <PageLoader />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <section className="rounded-xl bg-white p-5">
        <h1 className="mb-4 text-2xl font-semibold">Your profile</h1>
        <form onSubmit={saveProfile} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><ErrorNote message={error} /></div>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <TextField label="Email (for invoices)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <p className="text-sm text-ink-soft sm:col-span-2">Signed in with mobile +91 {user.phone}</p>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" loading={saving}>Save profile</Button>
            <Button type="button" variant="ghost" onClick={() => signOut().then(() => router.push("/"))}>Sign out</Button>
          </div>
        </form>
      </section>
      <SignedInDevices />
      <PrivacySection marketing={user.marketing_opt_in ?? false} onChanged={reloadUser} onDeleted={() => signOut().then(() => router.push("/"))} />
      <section className="rounded-xl bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Saved addresses</h2>
          {editing === null && <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>Add address</Button>}
        </div>
        {editing !== null ? (
          <AddressForm initial={editing === "new" ? undefined : editing} onSaved={() => { setEditing(null); load(); toast("Address saved"); }} onCancel={() => setEditing(null)} />
        ) : addresses.length === 0 ? (
          <p className="text-ink-soft">No saved addresses yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {addresses.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 font-semibold">
                    {a.full_name} <Pill>{a.label?.trim() || ({ home: "Home", work: "Work", other: "Other" } as const)[a.kind]}</Pill>
                    {a.is_default && <Pill tone="blue">Default</Pill>}
                    {a.lat != null && <Pill tone="green"><MapPin className="mr-0.5 h-3 w-3" aria-hidden />Pinned</Pill>}
                  </p>
                  <p className="text-ink-soft" translate="no">{[a.line1, a.line2, a.landmark, a.city].filter(Boolean).join(", ")}, {a.state} {a.pincode}</p>
                  <p className="text-sm text-ink-faint">{a.phone}</p>
                  {a.instructions && <p className="mt-1 text-sm text-ink-soft"><span className="font-semibold text-ink">Instructions:</span> {a.instructions}</p>}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(a)}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => remove(a)}>Remove</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <SavedCards />
    </div>
  );
}
