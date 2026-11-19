"use client";

import clsx from "clsx";
import { BadgeCheck, Bike, Camera, CheckCircle2, CircleAlert, FileText, HelpCircle, Landmark, LogOut, MapPin, Phone, Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useDeliveryOptions, usePartner } from "@/components/delivery/app";
import { GetTheApp } from "@/components/delivery/install";
import { UploadTile } from "@/components/delivery/upload-tile";
import { Button, ErrorNote, Modal, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Partner } from "@/lib/delivery-types";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

export default function PartnerProfile() {
  const { partner, set } = usePartner();
  const options = useDeliveryOptions();
  const { signOut } = useSession();
  const [photo, setPhoto] = useState(false);
  const [bank, setBank] = useState(false);
  const [address, setAddress] = useState(false);
  if (!partner) return null;
  const docs: [string, boolean][] = [
    ["Driving licence", partner.docs.license || partner.vehicle_type === "cycle"],
    [`${partner.id_proof_label || "ID proof"} ending ${partner.id_proof_last4}`, partner.docs.id_proof],
    ["Vehicle registration (RC)", partner.docs.vehicle_rc],
  ];
  return (
    <div className="flex flex-col gap-4" data-testid="partner-profile">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-peacock to-peacock-dark p-5 text-white shadow-sm sm:p-6">
        <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10" aria-hidden />
        <div className="relative flex items-center gap-4">
          <button type="button" onClick={() => setPhoto(true)} className="group relative shrink-0" aria-label="Change your photo">
            {partner.photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={partner.photo} alt="" className="h-20 w-20 rounded-full object-cover ring-4 ring-white/30" />
            ) : <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white/15 text-3xl font-bold">{partner.name[0]}</span>}
            <span className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full bg-marigold text-ink shadow"><Camera className="h-4 w-4" /></span>
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold">{partner.name}</h1>
            <p className="text-white/80">{partner.phone}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5"><BadgeCheck className="h-4 w-4 text-marigold" /> Verified partner</span>
              {partner.rating_count > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5"><Star className="h-4 w-4 fill-marigold text-marigold" /> {partner.rating_avg.toFixed(1)} ({partner.rating_count})</span>}
            </p>
          </div>
        </div>
        <div className="relative mt-5 grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-2xl bg-white/10 p-2.5"><Bike className="mx-auto h-5 w-5" /><p className="mt-1 font-semibold">{partner.vehicle_label}</p><p className="text-xs text-white/70">{partner.vehicle_no || "No plate"}</p></div>
          <div className="rounded-2xl bg-white/10 p-2.5"><MapPin className="mx-auto h-5 w-5" /><p className="mt-1 font-semibold">{partner.zone?.name ?? "Not set"}</p><p className="text-xs text-white/70">{partner.zone?.city ?? partner.city}</p></div>
          <div className="rounded-2xl bg-white/10 p-2.5"><CheckCircle2 className="mx-auto h-5 w-5" /><p className="mt-1 font-semibold">Since</p><p className="text-xs text-white/70">{partner.approved_at ? date(partner.approved_at) : "—"}</p></div>
        </div>
      </section>

      <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><FileText className="h-5 w-5 text-peacock" /> Documents</h2>
        <ul className="divide-y divide-line">
          {docs.map(([label, ok]) => (
            <li key={label} className="flex items-center justify-between gap-3 py-2.5">
              <span>{label}</span>
              <span className={clsx("inline-flex items-center gap-1 text-sm font-semibold", ok ? "text-leaf" : "text-ink-faint")}>{ok ? <><CheckCircle2 className="h-4 w-4" /> Verified</> : "Not added"}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-ink-faint">Verified documents can only be changed by the delivery team.</p>
      </section>

      <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold"><Landmark className="h-5 w-5 text-peacock" /> Payout account</h2>
            <p className="mt-1 text-ink-soft">{partner.bank.account_last4 ? `Bank account ending ${partner.bank.account_last4} · ${partner.bank.ifsc}` : partner.bank.upi ? `UPI ${partner.bank.upi}` : "Not added"}</p>
            <p className="text-sm text-ink-faint">{partner.bank.holder}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setBank(true)}>Change</Button>
        </div>
      </section>

      <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><MapPin className="h-5 w-5 text-peacock" /> Home address</h2>
            <p className="mt-1 whitespace-pre-line text-ink-soft">{partner.address}</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setAddress(true)}>Edit</Button>
        </div>
      </section>

      <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <h2 className="mb-1 text-lg font-semibold">Partner app</h2>
        <p className="mb-3 text-sm text-ink-soft">Install it so requests reach you even when the browser is closed.</p>
        <GetTheApp options={options} compact />
      </section>

      <div className="grid grid-cols-2 gap-3 lg:hidden">
        <Link href="/delivery/help" className="flex items-center justify-center gap-2 rounded-2xl bg-white p-4 font-semibold shadow-sm ring-1 ring-black/5"><HelpCircle className="h-5 w-5 text-peacock" /> Help</Link>
        <button type="button" onClick={() => signOut().then(() => window.location.assign(new URL("/delivery/login", window.location.origin)))} className="flex items-center justify-center gap-2 rounded-2xl bg-white p-4 font-semibold text-vermilion shadow-sm ring-1 ring-black/5"><LogOut className="h-5 w-5" /> Sign out</button>
      </div>
      {options?.support_phone && (
        <a href={`tel:${options.support_phone}`} className="flex items-center justify-center gap-2 text-sm font-semibold text-peacock"><Phone className="h-4 w-4" /> Delivery team: {options.support_phone}</a>
      )}

      <Modal open={photo} onClose={() => setPhoto(false)} title="Your photo">
        <UploadTile kind="photo" label="Take a new photo" done={!!partner.photo} preview={partner.photo} onDone={(p) => { set(p); setPhoto(false); }} />
      </Modal>
      <Modal open={bank} onClose={() => setBank(false)} title="Change payout account">
        <BankForm partner={partner} onDone={(p) => { set(p); setBank(false); }} />
      </Modal>
      <Modal open={address} onClose={() => setAddress(false)} title="Home address">
        <AddressForm partner={partner} onDone={(p) => { set(p); setAddress(false); }} />
      </Modal>
    </div>
  );
}

function BankForm({ partner, onDone }: { partner: Partner; onDone: (p: Partner) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ holder: partner.bank.holder || partner.name, account_number: "", confirm_account_number: "", ifsc: "", upi: partner.bank.upi });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = f.account_number ? { holder: f.holder, account_number: f.account_number, confirm_account_number: f.confirm_account_number, ifsc: f.ifsc, upi: f.upi } : { holder: f.holder, upi: f.upi };
      onDone(await api<Partner>("/api/delivery/me/bank", { method: "PUT", body }));
      toast("Payout account saved. The team checks changes before the next payout.");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <ErrorNote message={error} />
      <p className="flex items-center gap-2 rounded-lg bg-marigold-light px-3 py-2 text-sm"><CircleAlert className="h-4 w-4 shrink-0" /> For your safety, the team checks a changed account before paying into it.</p>
      <TextField label="Account holder name" value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} required minLength={3} />
      <TextField label="New account number" inputMode="numeric" value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value.replace(/\D/g, "") })} />
      {f.account_number && (
        <>
          <TextField label="Re-enter account number" inputMode="numeric" value={f.confirm_account_number} onChange={(e) => setF({ ...f, confirm_account_number: e.target.value.replace(/\D/g, "") })} required />
          <TextField label="IFSC" value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} required maxLength={11} />
        </>
      )}
      <TextField label="UPI ID (optional)" value={f.upi} onChange={(e) => setF({ ...f, upi: e.target.value.trim() })} placeholder="name@okaxis" />
      <Button type="submit" loading={busy}>Save</Button>
    </form>
  );
}

function AddressForm({ partner, onDone }: { partner: Partner; onDone: (p: Partner) => void }) {
  const [address, setAddress] = useState(partner.address);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try { onDone(await api<Partner>("/api/delivery/me", { method: "PUT", body: { address } })); } catch (x) { setError(x instanceof ApiError ? x.message : "Could not save"); } finally { setBusy(false); }
    }}>
      <ErrorNote message={error} />
      <Textarea rows={4} value={address} onChange={(e) => setAddress(e.target.value)} minLength={10} maxLength={500} required aria-label="Home address" />
      <Button type="submit" loading={busy}>Save address</Button>
    </form>
  );
}
