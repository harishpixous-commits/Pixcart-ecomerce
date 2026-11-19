"use client";

import clsx from "clsx";
import { ArrowLeft, Check, CircleAlert, Eye, MapPin, Phone, Power, ShieldCheck, Upload } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DocViewer, KycPill, OnlineDot, PartnerAvatar, Stars } from "@/components/delivery/admin";
import { Button, ErrorNote, Field, Modal, PageLoader, Select, Textarea, TextField, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError, quietly } from "@/lib/api";
import type { IdProof, Partner } from "@/lib/delivery-types";
import { date, dateTime } from "@/lib/format";

type Detail = Partner & { id_proof_no: string; account: { name: string; last_login_at: string | null } };
type Zone = { id: string; name: string; city: string; is_active: boolean };

export default function PartnerDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const canPayouts = useCan("payouts");
  const [p, setP] = useState<Detail | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [modal, setModal] = useState<"approve" | "reject" | "off" | "edit" | null>(null);
  const [doc, setDoc] = useState<{ path: string; title: string } | null>(null);
  const [bank, setBank] = useState<{ account_number: string } | null>(null);
  const load = useCallback(() => api<Detail>(`/api/admin/delivery/partners/${id}`).then(setP).catch(quietly), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api<Zone[]>("/api/admin/delivery/zones").then(setZones).catch(quietly); }, []);
  if (!p) return <PageLoader />;
  const done = p.checklist.filter((i) => i.done).length;

  async function switchOn() {
    try {
      await api(`/api/admin/delivery/partners/${id}/active`, { method: "POST", body: { active: true } });
      toast("Partner switched on");
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not switch on", "error");
    }
  }
  async function revealBank() {
    try {
      setBank(await api<{ account_number: string }>(`/api/admin/delivery/partners/${id}/bank`));
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not show the account number", "error");
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="partner-detail">
      <Link href="/admin/delivery/partners" className="flex items-center gap-1.5 self-start text-sm font-semibold text-ink-soft hover:text-peacock"><ArrowLeft className="h-4 w-4" /> All partners</Link>
      <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-wrap items-center gap-4">
          <PartnerAvatar p={p} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold">{p.name}</h1>
              <KycPill status={p.kyc_status} active={p.is_active} />
              {p.kyc_status === "approved" && p.is_active && <OnlineDot online={p.is_online} />}
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-3 text-sm text-ink-soft">
              <a href={`tel:${p.phone}`} className="inline-flex items-center gap-1 font-semibold text-peacock"><Phone className="h-4 w-4" /> {p.phone}</a>
              <span>{p.vehicle_label}{p.vehicle_no ? ` · ${p.vehicle_no}` : ""}</span>
              <span>{p.zone ? `${p.zone.name}, ${p.zone.city}` : "No zone"}</span>
              <Stars value={p.rating_avg} count={p.rating_count} />
            </p>
            <p className="text-xs text-ink-faint">Registered {p.created_at ? date(p.created_at) : ""}{p.approved_at ? ` · approved ${date(p.approved_at)}` : ""}{p.account.last_login_at ? ` · last signed in ${dateTime(p.account.last_login_at)}` : ""}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {p.kyc_status !== "approved" && <Button onClick={() => setModal("approve")} disabled={!p.checklist.every((i) => i.done)}><Check className="h-4 w-4" /> Approve</Button>}
            {p.kyc_status !== "approved" && p.kyc_status !== "rejected" && <Button variant="danger" onClick={() => setModal("reject")}>Ask for changes</Button>}
            <Button variant="secondary" onClick={() => setModal("edit")}>Edit details</Button>
            {p.is_active ? <Button variant="ghost" onClick={() => setModal("off")}><Power className="h-4 w-4" /> Switch off</Button>
              : <Button onClick={switchOn}><Power className="h-4 w-4" /> Switch on</Button>}
          </div>
        </div>
        {p.kyc_note && <p className={clsx("mt-3 rounded-lg px-3 py-2 text-sm", p.kyc_status === "rejected" ? "bg-vermilion-light text-vermilion" : "bg-mist")}><b>Note:</b> {p.kyc_note}</p>}
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5 text-peacock" /> Documents</h2>
            <div className="divide-y divide-line">
              <DocRow label="Photo" value={p.photo ? "Added" : "Missing"} ok={!!p.photo} onView={p.photo ? () => window.open(p.photo, "_blank", "noopener") : undefined}
                upload={{ id, kind: "photo", onDone: (x) => setP({ ...p, ...x }) }} />
              <DocRow label="Driving licence" value={p.vehicle_type === "cycle" ? "Not needed for bicycles" : p.license_no || "Number missing"} ok={p.vehicle_type === "cycle" || (p.docs.license && !!p.license_no)}
                onView={p.docs.license ? () => setDoc({ path: `/api/admin/delivery/partners/${id}/docs/license`, title: `Driving licence ${p.license_no}` }) : undefined}
                upload={{ id, kind: "license", onDone: (x) => setP({ ...p, ...x }) }} />
              <DocRow label={p.id_proof_label || "ID proof"} value={p.id_proof_no || (p.id_proof_last4 ? `ending ${p.id_proof_last4}${p.id_proof_type === "aadhaar" ? " (Aadhaar numbers are not stored)" : ""}` : "Number missing")}
                ok={p.docs.id_proof && !!p.id_proof_last4} onView={p.docs.id_proof ? () => setDoc({ path: `/api/admin/delivery/partners/${id}/docs/id_proof`, title: p.id_proof_label || "ID proof" }) : undefined}
                upload={{ id, kind: "id_proof", onDone: (x) => setP({ ...p, ...x }) }} />
              <DocRow label="Vehicle registration (RC)" value={p.docs.vehicle_rc ? "Added" : "Not added"} ok={p.docs.vehicle_rc} optional
                onView={p.docs.vehicle_rc ? () => setDoc({ path: `/api/admin/delivery/partners/${id}/docs/vehicle_rc`, title: "Vehicle registration" }) : undefined}
                upload={{ id, kind: "vehicle_rc", onDone: (x) => setP({ ...p, ...x }) }} />
            </div>
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
            <h2 className="mb-3 text-lg font-semibold">Details</h2>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {[["Name", p.name], ["City", p.city || "—"], ["Home address", p.address || "—"], ["Zone", p.zone ? `${p.zone.name}, ${p.zone.city}` : "Not set"],
                ["Vehicle", `${p.vehicle_label}${p.vehicle_no ? ` · ${p.vehicle_no}` : ""}`], ["Account name", p.account.name || "—"]].map(([k, v]) => (
                <div key={k}><dt className="text-xs uppercase tracking-wide text-ink-faint">{k}</dt><dd className="whitespace-pre-line">{v}</dd></div>
              ))}
            </dl>
          </section>
        </div>

        <aside className="flex flex-col gap-4">
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
            <h2 className="text-lg font-semibold">Registration</h2>
            <p className="mb-2 text-sm text-ink-soft">{done} of {p.checklist.length} done</p>
            <ul className="flex flex-col gap-2">
              {p.checklist.map((i) => (
                <li key={i.key} className="flex items-center gap-2 text-sm">
                  <span className={clsx("flex h-5 w-5 items-center justify-center rounded-full", i.done ? "bg-leaf text-white" : "bg-vermilion-light text-vermilion")}>{i.done ? <Check className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}</span>
                  {i.label}
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
            <h2 className="text-lg font-semibold">Payouts</h2>
            {p.bank.set ? (
              <div className="mt-1 text-sm">
                <p>{p.bank.holder}</p>
                {p.bank.account_last4 && <p>Account {bank ? <b className="font-mono">{bank.account_number}</b> : `ending ${p.bank.account_last4}`} · {p.bank.ifsc}</p>}
                {p.bank.upi && <p>UPI {p.bank.upi}</p>}
                {canPayouts && p.bank.account_last4 && !bank && <button type="button" onClick={revealBank} className="mt-2 inline-flex items-center gap-1 font-semibold text-peacock"><Eye className="h-4 w-4" /> Show account number</button>}
              </div>
            ) : <p className="text-sm text-ink-soft">Not added yet</p>}
          </section>
          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
            <h2 className="text-lg font-semibold">Last location</h2>
            {p.location.lat !== null && p.location.lng !== null ? (
              <div className="mt-1 text-sm">
                <p>{p.location.at ? dateTime(p.location.at) : ""}</p>
                <a href={`https://www.google.com/maps?q=${p.location.lat},${p.location.lng}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-semibold text-peacock"><MapPin className="h-4 w-4" /> Open in Google Maps</a>
              </div>
            ) : <p className="text-sm text-ink-soft">Shared only while the partner is online.</p>}
          </section>
        </aside>
      </div>

      <DocViewer path={doc?.path ?? null} title={doc?.title ?? ""} onClose={() => setDoc(null)} />
      <Modal open={modal === "approve"} onClose={() => setModal(null)} title={`Approve ${p.name}`}>
        <Review partner={p} zones={zones} action="approve" onDone={(x) => { setP({ ...p, ...x }); setModal(null); toast("Approved. The partner was told by SMS and in the app."); }} />
      </Modal>
      <Modal open={modal === "reject"} onClose={() => setModal(null)} title="Ask for changes">
        <Review partner={p} zones={zones} action="reject" onDone={(x) => { setP({ ...p, ...x }); setModal(null); toast("The partner was told what to fix."); }} />
      </Modal>
      <Modal open={modal === "off"} onClose={() => setModal(null)} title={`Switch off ${p.name}`}>
        <SwitchOff id={id} onDone={(x) => { setP({ ...p, ...x }); setModal(null); toast("Switched off. They cannot take deliveries."); }} />
      </Modal>
      <Modal open={modal === "edit"} onClose={() => setModal(null)} title="Edit details" wide>
        <EditDetails partner={p} zones={zones} onDone={(x) => { setP({ ...p, ...x }); setModal(null); toast("Saved"); }} />
      </Modal>
    </div>
  );
}

function DocRow({ label, value, ok, optional, onView, upload }: {
  label: string; value: string; ok: boolean; optional?: boolean; onView?: () => void;
  upload: { id: string; kind: string; onDone: (p: Partner) => void };
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function send(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      upload.onDone(await api<Partner>(`/api/admin/delivery/partners/${upload.id}/docs/${upload.kind}`, { method: "POST", form }));
      toast(`${label} uploaded`);
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not upload", "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <span className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", ok ? "bg-leaf-light text-leaf" : optional ? "bg-mist text-ink-faint" : "bg-vermilion-light text-vermilion")}>
        {ok ? <Check className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{label}</p>
        <p className="break-words text-sm text-ink-soft">{value}</p>
      </div>
      {onView && <Button size="sm" variant="secondary" onClick={onView}><Eye className="h-4 w-4" /> View</Button>}
      <Button size="sm" variant="ghost" loading={busy} onClick={() => input.current?.click()}><Upload className="h-4 w-4" /> Upload</Button>
      <input ref={input} type="file" className="sr-only" accept="image/*,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); }} aria-label={`Upload ${label}`} />
    </div>
  );
}

function Review({ partner, zones, action, onDone }: { partner: Partner; zones: Zone[]; action: "approve" | "reject"; onDone: (p: Partner) => void }) {
  const [zone, setZone] = useState(partner.zone?.id ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = zones.filter((z) => z.is_active);
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        onDone(await api<Partner>(`/api/admin/delivery/partners/${partner.id}/kyc`, { method: "POST", body: { action, note, zone_id: zone || undefined } }));
      } catch (x) {
        setError(x instanceof ApiError ? x.message : "Could not save");
      } finally {
        setBusy(false);
      }
    }}>
      <ErrorNote message={error} />
      {action === "approve" ? (
        <>
          <p className="text-sm text-ink-soft">Check the documents match the name and photo. The partner can go online as soon as you approve.</p>
          <Field label="Delivers in zone">
            <Select value={zone} onChange={(e) => setZone(e.target.value)} required>
              <option value="">Choose a zone</option>
              {active.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.city})</option>)}
            </Select>
          </Field>
          {active.length === 0 && <p className="text-sm text-vermilion">Create a zone first in Delivery zones.</p>}
          <TextField label="Note to the partner (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          <Button type="submit" loading={busy} disabled={!zone}>Approve partner</Button>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-soft">The partner sees this message and can fix their registration and send it again.</p>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} minLength={5} maxLength={500} required aria-label="What to fix"
            placeholder="e.g. The licence photo is blurred. Upload a clear photo of the front." />
          <Button type="submit" variant="danger" loading={busy} disabled={note.trim().length < 5}>Send to the partner</Button>
        </>
      )}
    </form>
  );
}

function SwitchOff({ id, onDone }: { id: string; onDone: (p: Partner) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try { onDone(await api<Partner>(`/api/admin/delivery/partners/${id}/active`, { method: "POST", body: { active: false, reason } })); }
      catch (x) { setError(x instanceof ApiError ? x.message : "Could not switch off"); } finally { setBusy(false); }
    }}>
      <ErrorNote message={error} />
      <p className="text-sm text-ink-soft">They go offline at once and cannot take deliveries until you switch them on again. They see your reason.</p>
      <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={300} aria-label="Reason" placeholder="e.g. Documents expired" />
      <Button type="submit" variant="danger" loading={busy} disabled={reason.trim().length < 5}>Switch off</Button>
    </form>
  );
}

function EditDetails({ partner, zones, onDone }: { partner: Detail; zones: Zone[]; onDone: (p: Partner) => void }) {
  const [f, setF] = useState({
    name: partner.name, city: partner.city, address: partner.address, zone_id: partner.zone?.id ?? "", vehicle_type: partner.vehicle_type,
    vehicle_no: partner.vehicle_no, license_no: partner.license_no, id_proof_type: partner.id_proof_type || "aadhaar", id_proof_no: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        onDone(await api<Partner>(`/api/admin/delivery/partners/${partner.id}`, { method: "PUT", body: {
          name: f.name, city: f.city, address: f.address, zone_id: f.zone_id || undefined, vehicle_type: f.vehicle_type,
          vehicle_no: f.vehicle_type === "cycle" ? "" : f.vehicle_no, license_no: f.license_no, id_proof_type: f.id_proof_type, id_proof_no: f.id_proof_no || undefined,
        } }));
      } catch (x) {
        setError(x instanceof ApiError ? x.message : "Could not save");
      } finally {
        setBusy(false);
      }
    }}>
      <div className="sm:col-span-2"><ErrorNote message={error} /></div>
      <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <TextField label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
      <Field label="Home address" className="sm:col-span-2"><Textarea rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <Field label="Zone">
        <Select value={f.zone_id} onChange={(e) => setF({ ...f, zone_id: e.target.value })}>
          <option value="">No zone</option>
          {zones.map((z) => <option key={z.id} value={z.id}>{z.name} ({z.city}){z.is_active ? "" : " (off)"}</option>)}
        </Select>
      </Field>
      <Field label="Vehicle">
        <Select value={f.vehicle_type} onChange={(e) => setF({ ...f, vehicle_type: e.target.value as Partner["vehicle_type"] })}>
          <option value="bike">Motorbike</option><option value="scooter">Scooter</option><option value="ev">Electric bike or scooter</option>
          <option value="cycle">Bicycle</option><option value="auto">Auto</option><option value="van">Van</option>
        </Select>
      </Field>
      {f.vehicle_type !== "cycle" && <TextField label="Vehicle number" value={f.vehicle_no} onChange={(e) => setF({ ...f, vehicle_no: e.target.value.toUpperCase() })} />}
      <TextField label="Licence number" value={f.license_no} onChange={(e) => setF({ ...f, license_no: e.target.value.toUpperCase() })} />
      <Field label="ID proof">
        <Select value={f.id_proof_type} onChange={(e) => setF({ ...f, id_proof_type: e.target.value as IdProof })}>
          <option value="aadhaar">Aadhaar</option><option value="pan">PAN card</option><option value="voter">Voter ID</option><option value="passport">Passport</option>
        </Select>
      </Field>
      <TextField label="New ID number (optional)" value={f.id_proof_no} onChange={(e) => setF({ ...f, id_proof_no: e.target.value })} placeholder={partner.id_proof_last4 ? `Now ending ${partner.id_proof_last4}` : ""} />
      <Button type="submit" loading={busy} className="sm:col-span-2 sm:justify-self-start">Save details</Button>
    </form>
  );
}
