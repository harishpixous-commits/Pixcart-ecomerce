"use client";

import clsx from "clsx";
import { ArrowLeft, ArrowRight, BadgeCheck, Bike, Car, Check, CircleAlert, FileText, Hourglass, Landmark, PartyPopper, Truck, UserRound, Zap } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { FullLoader, useDeliveryOptions, usePartner } from "@/components/delivery/app";
import { GetTheApp } from "@/components/delivery/install";
import { UploadTile } from "@/components/delivery/upload-tile";
import { Button, ErrorNote, Field, Input, Select, Textarea, TextField } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { DeliveryOptions, IdProof, Partner, VehicleType } from "@/lib/delivery-types";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

/*
 * Delivery partner registration: start (name and city) → about you and photo → vehicle → documents → payouts →
 * review and submit. Each step saves as the partner goes, so they can stop and continue later on any device.
 */

const STEPS = [
  { key: "about", title: "About you", icon: UserRound },
  { key: "vehicle", title: "Vehicle", icon: Bike },
  { key: "documents", title: "Documents", icon: FileText },
  { key: "payouts", title: "Payouts", icon: Landmark },
  { key: "review", title: "Submit", icon: BadgeCheck },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

const VEHICLE_ICON: Record<VehicleType, typeof Bike> = { bike: Bike, scooter: Bike, ev: Zap, cycle: Bike, auto: Car, van: Truck };

function firstOpenStep(p: Partner): StepKey {
  const open = new Set(p.checklist.filter((i) => !i.done).map((i) => i.key));
  if (open.has("profile") || open.has("photo")) return "about";
  if (open.has("vehicle") || open.has("vehicle_rc")) return "vehicle";
  if (open.has("license") || open.has("id_proof")) return "documents";
  if (open.has("bank")) return "payouts";
  return "review";
}

export default function RegisterPage() {
  const { partner, status } = usePartner();
  const options = useDeliveryOptions();
  if (status === "loading" || !options) return <FullLoader />;
  if (!partner) return <Start options={options} />;
  if (partner.kyc_status === "submitted") return <UnderReview partner={partner} options={options} />;
  return <Wizard key={partner.id} partner={partner} options={options} />;
}

/* ---------------------------------------------------------------- start */

function Start({ options }: { options: DeliveryOptions }) {
  const { user } = useSession();
  const { set } = usePartner();
  const [name, setName] = useState(user?.name ?? "");
  const [city, setCity] = useState(options.zones[0]?.city ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cities = Array.from(new Set(options.zones.map((z) => z.city)));
  if (!options.registration_open || !options.enabled) {
    return (
      <div className="mx-auto mt-8 max-w-md rounded-2xl bg-white p-6 text-center shadow-sm">
        <p className="font-display text-xl font-semibold">Registrations are closed</p>
        <p className="mt-1 text-ink-soft">We are not adding new delivery partners right now. Please check again soon.</p>
      </div>
    );
  }
  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      set(await api<Partner>("/api/delivery/register", { method: "POST", body: { name, city } }));
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not start your registration");
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto mt-4 max-w-md">
      <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-black/5">
        <div className="bg-gradient-to-br from-peacock to-peacock-dark p-6 text-white">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15"><Bike className="h-7 w-7" aria-hidden /></span>
          <h1 className="mt-3 text-2xl font-bold">Become a delivery partner</h1>
          <p className="text-white/80">5 short steps. You can stop and continue later.</p>
        </div>
        <form onSubmit={start} className="flex flex-col gap-4 p-6" data-testid="register-start">
          <ErrorNote message={error} />
          <TextField label="Your full name (as on your ID)" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
          <Field label="City you want to deliver in">
            {cities.length ? (
              <Select value={city} onChange={(e) => setCity(e.target.value)}>{cities.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
            ) : (
              <Input value={city} onChange={(e) => setCity(e.target.value)} required minLength={2} />
            )}
          </Field>
          <Button type="submit" size="lg" loading={busy} className="rounded-xl">Start registration <ArrowRight className="h-5 w-5" /></Button>
        </form>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- wizard */

function Wizard({ partner, options }: { partner: Partner; options: DeliveryOptions }) {
  const { set } = usePartner();
  const [step, setStep] = useState<StepKey>(() => firstOpenStep(partner));
  const index = STEPS.findIndex((s) => s.key === step);
  const done = (key: string) => partner.checklist.filter((i) => key.split(",").includes(i.key)).every((i) => i.done);
  const stepDone: Record<StepKey, boolean> = {
    about: done("profile,photo"), vehicle: done("vehicle,vehicle_rc"), documents: done("license,id_proof"), payouts: done("bank"), review: false,
  };
  const go = (k: StepKey) => { setStep(k); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const nextStep = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)].key);

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div>
        <p className="text-sm font-semibold text-peacock">Delivery partner registration</p>
        <h1 className="text-2xl font-bold sm:text-3xl">Hi {partner.name.split(" ")[0]}, let&apos;s get you on the road</h1>
      </div>
      {partner.kyc_status === "rejected" && (
        <div className="flex gap-3 rounded-2xl bg-vermilion-light p-4 text-vermilion" role="alert">
          <CircleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <div><p className="font-semibold">Please fix your registration</p><p className="text-ink">{partner.kyc_note || "Some details could not be verified."}</p></div>
        </div>
      )}
      {/* progress */}
      <ol className="grid grid-cols-5 gap-1.5" aria-label="Registration steps">
        {STEPS.map((s, i) => {
          const current = s.key === step;
          const complete = stepDone[s.key];
          return (
            <li key={s.key}>
              <button type="button" onClick={() => go(s.key)} aria-current={current ? "step" : undefined} className="flex w-full flex-col items-center gap-1.5 text-center">
                <span className={clsx("h-1.5 w-full rounded-full transition-colors", complete ? "bg-leaf" : current ? "bg-peacock" : i < index ? "bg-peacock/40" : "bg-line")} />
                <span className={clsx("flex h-9 w-9 items-center justify-center rounded-full transition-colors", current ? "bg-peacock text-white shadow-md" : complete ? "bg-leaf-light text-leaf" : "bg-white text-ink-faint ring-1 ring-line")}>
                  {complete && !current ? <Check className="h-4 w-4" /> : <s.icon className="h-4 w-4" />}
                </span>
                <span className={clsx("hidden text-xs font-semibold sm:block", current ? "text-peacock" : "text-ink-soft")}>{s.title}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-7" data-testid={`step-${step}`}>
        {step === "about" && <About partner={partner} options={options} onSaved={(p) => { set(p); nextStep(); }} />}
        {step === "vehicle" && <Vehicle partner={partner} options={options} onSaved={(p) => { set(p); nextStep(); }} />}
        {step === "documents" && <Documents partner={partner} options={options} onSaved={(p) => { set(p); nextStep(); }} />}
        {step === "payouts" && <Payouts partner={partner} onSaved={(p) => { set(p); nextStep(); }} />}
        {step === "review" && <Review partner={partner} go={go} />}
      </section>
      {index > 0 && step !== "review" && (
        <button type="button" onClick={() => go(STEPS[index - 1].key)} className="flex items-center gap-1.5 self-start text-sm font-semibold text-ink-soft hover:text-peacock">
          <ArrowLeft className="h-4 w-4" /> Back to {STEPS[index - 1].title.toLowerCase()}
        </button>
      )}
    </div>
  );
}

function StepTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-ink-soft">{sub}</p>
    </div>
  );
}

function useSave(onSaved: (p: Partner) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<Partner>(path, { method: "PUT", body }));
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, save };
}

function About({ partner, options, onSaved }: { partner: Partner; options: DeliveryOptions; onSaved: (p: Partner) => void }) {
  const { set } = usePartner();
  const [f, setF] = useState({ name: partner.name, city: partner.city, address: partner.address, zone_id: partner.zone?.id ?? "" });
  const { busy, error, setError, save } = useSave(onSaved);
  const zones = options.zones.filter((z) => !f.city || z.city.toLowerCase() === f.city.toLowerCase());
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!partner.photo) return setError("Add your photo. Customers see it when you deliver.");
      save("/api/delivery/me", { name: f.name, city: f.city, address: f.address, ...(f.zone_id ? { zone_id: f.zone_id } : {}) });
    }} className="flex flex-col gap-4">
      <StepTitle title="About you" sub="Your photo and name are shown to customers when you deliver to them." />
      <ErrorNote message={error} />
      <UploadTile kind="photo" label="Your photo" hint="A clear selfie, face visible, no sunglasses" done={!!partner.photo} preview={partner.photo} onDone={set} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Full name (as on your ID)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />
        <TextField label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value, zone_id: "" })} required minLength={2} list="partner-cities" />
        <datalist id="partner-cities">{Array.from(new Set(options.zones.map((z) => z.city))).map((c) => <option key={c} value={c} />)}</datalist>
      </div>
      {zones.length > 0 && (
        <Field label="Area you prefer (the team confirms it)">
          <Select value={f.zone_id} onChange={(e) => setF({ ...f, zone_id: e.target.value })}>
            <option value="">Any area in {f.city || "my city"}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </Select>
        </Field>
      )}
      <Field label="Home address">
        <Textarea rows={3} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} required minLength={10} maxLength={500} placeholder="House number, street, area, PIN code" />
      </Field>
      <Button type="submit" size="lg" loading={busy} className="rounded-xl sm:self-end">Save and continue <ArrowRight className="h-5 w-5" /></Button>
    </form>
  );
}

function Vehicle({ partner, options, onSaved }: { partner: Partner; options: DeliveryOptions; onSaved: (p: Partner) => void }) {
  const { set } = usePartner();
  const [type, setType] = useState<VehicleType>(partner.vehicle_type);
  const [no, setNo] = useState(partner.vehicle_no);
  const { busy, error, setError, save } = useSave(onSaved);
  const cycle = type === "cycle";
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (options.require_vehicle_doc && !cycle && !partner.docs.vehicle_rc) return setError("Upload your vehicle registration (RC)");
      save("/api/delivery/me", { vehicle_type: type, vehicle_no: cycle ? "" : no });
    }} className="flex flex-col gap-4">
      <StepTitle title="Your vehicle" sub="Requests are matched to what you ride." />
      <ErrorNote message={error} />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3" role="radiogroup" aria-label="Vehicle type">
        {(Object.entries(options.vehicles) as [VehicleType, string][]).map(([k, label]) => {
          const Icon = VEHICLE_ICON[k];
          return (
            <button key={k} type="button" role="radio" aria-checked={type === k} onClick={() => setType(k)}
              className={clsx("flex flex-col items-center gap-2 rounded-2xl border-2 p-4 text-center font-semibold transition-all",
                type === k ? "border-peacock bg-peacock-light/50 text-peacock shadow-sm" : "border-line hover:border-peacock/40")}>
              <Icon className="h-7 w-7" aria-hidden />
              <span className="text-sm">{label}</span>
            </button>
          );
        })}
      </div>
      {!cycle && (
        <TextField label="Vehicle number" value={no} onChange={(e) => setNo(e.target.value.toUpperCase())} required placeholder="TN 38 AB 1234" hint="As on the number plate" className="[&_input]:uppercase" />
      )}
      {!cycle && (
        <UploadTile kind="vehicle_rc" label={`Registration certificate (RC)${options.require_vehicle_doc ? "" : " (optional)"}`} done={partner.docs.vehicle_rc} onDone={set} />
      )}
      <Button type="submit" size="lg" loading={busy} className="rounded-xl sm:self-end">Save and continue <ArrowRight className="h-5 w-5" /></Button>
    </form>
  );
}

function Documents({ partner, options, onSaved }: { partner: Partner; options: DeliveryOptions; onSaved: (p: Partner) => void }) {
  const { set } = usePartner();
  const cycle = partner.vehicle_type === "cycle";
  const [license, setLicense] = useState(partner.license_no);
  const [idType, setIdType] = useState<IdProof>(partner.id_proof_type || "aadhaar");
  const [idNo, setIdNo] = useState("");
  const { busy, error, setError, save } = useSave(onSaved);
  const haveId = partner.id_proof_last4 && partner.id_proof_type === idType;
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!cycle && !partner.docs.license) return setError("Upload a photo of your driving licence");
      if (!partner.docs.id_proof) return setError("Upload a photo of your ID proof");
      if (!idNo && !haveId) return setError("Enter your ID number");
      save("/api/delivery/me", { ...(cycle ? {} : { license_no: license }), id_proof_type: idType, ...(idNo ? { id_proof_no: idNo } : {}) });
    }} className="flex flex-col gap-5">
      <StepTitle title="Documents" sub="Only the verification team sees these. Keep the photos sharp and readable." />
      <ErrorNote message={error} />
      {cycle ? (
        <p className="rounded-xl bg-mist px-4 py-3 text-sm text-ink-soft">You ride a bicycle, so no driving licence is needed.</p>
      ) : (
        <div className="flex flex-col gap-3 rounded-2xl bg-mist/60 p-4">
          <p className="font-semibold">Driving licence</p>
          <TextField label="Licence number" value={license} onChange={(e) => setLicense(e.target.value.toUpperCase())} required placeholder="TN38 20190012345" />
          <UploadTile kind="license" label="Licence photo (front)" done={partner.docs.license} onDone={set} />
        </div>
      )}
      <div className="flex flex-col gap-3 rounded-2xl bg-mist/60 p-4">
        <p className="font-semibold">ID proof</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="ID type">
          {(Object.entries(options.id_proofs) as [IdProof, string][]).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={idType === k} onClick={() => { setIdType(k); setIdNo(""); }}
              className={clsx("rounded-full px-4 py-1.5 text-sm font-semibold ring-1", idType === k ? "bg-peacock text-white ring-peacock" : "bg-white ring-line hover:ring-peacock/50")}>
              {label}
            </button>
          ))}
        </div>
        <TextField label={`${options.id_proofs[idType]} number`} value={idNo} onChange={(e) => setIdNo(e.target.value)} placeholder={haveId ? `Saved: ending ${partner.id_proof_last4}` : ""}
          hint={idType === "aadhaar" ? "We keep only the last 4 digits of your Aadhaar." : "Stored encrypted."} inputMode={idType === "aadhaar" ? "numeric" : "text"} />
        <UploadTile kind="id_proof" label={`${options.id_proofs[idType]} photo`} done={partner.docs.id_proof} onDone={set} />
      </div>
      <Button type="submit" size="lg" loading={busy} className="rounded-xl sm:self-end">Save and continue <ArrowRight className="h-5 w-5" /></Button>
    </form>
  );
}

function Payouts({ partner, onSaved }: { partner: Partner; onSaved: (p: Partner) => void }) {
  const [mode, setMode] = useState<"bank" | "upi">(partner.bank.upi && !partner.bank.account_last4 ? "upi" : "bank");
  const [f, setF] = useState({ holder: partner.bank.holder || partner.name, account_number: "", confirm_account_number: "", ifsc: partner.bank.ifsc, upi: partner.bank.upi });
  const { busy, error, save } = useSave(onSaved);
  const saved = partner.bank.set;
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      if (saved && !f.account_number && mode === "bank" && f.upi === partner.bank.upi) return onSaved(partner); // nothing changed
      save("/api/delivery/me/bank", mode === "bank" ? { holder: f.holder, account_number: f.account_number, confirm_account_number: f.confirm_account_number, ifsc: f.ifsc } : { holder: f.holder, upi: f.upi });
    }} className="flex flex-col gap-4">
      <StepTitle title="Where should we pay you?" sub="Your earnings are paid every week to this account." />
      <ErrorNote message={error} />
      {saved && (
        <p className="flex items-center gap-2 rounded-xl bg-leaf-light px-4 py-3 text-sm text-leaf">
          <Check className="h-4 w-4" aria-hidden /> Saved: {partner.bank.account_last4 ? `account ending ${partner.bank.account_last4} (${partner.bank.ifsc})` : partner.bank.upi}
        </p>
      )}
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-mist p-1" role="tablist">
        {(["bank", "upi"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={clsx("rounded-lg py-2 font-semibold", mode === m ? "bg-white shadow-sm" : "text-ink-soft")}>
            {m === "bank" ? "Bank account" : "UPI ID"}
          </button>
        ))}
      </div>
      <TextField label="Account holder name" value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} required minLength={3} />
      {mode === "bank" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Account number" inputMode="numeric" value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value.replace(/\D/g, "") })} required={!saved} placeholder={saved ? "Leave empty to keep" : ""} />
          <TextField label="Re-enter account number" inputMode="numeric" value={f.confirm_account_number} onChange={(e) => setF({ ...f, confirm_account_number: e.target.value.replace(/\D/g, "") })} required={!!f.account_number} />
          <TextField label="IFSC" value={f.ifsc} onChange={(e) => setF({ ...f, ifsc: e.target.value.toUpperCase() })} required={!!f.account_number} placeholder="SBIN0001234" maxLength={11} />
        </div>
      ) : (
        <TextField label="UPI ID" value={f.upi} onChange={(e) => setF({ ...f, upi: e.target.value.trim() })} required placeholder="name@okaxis" />
      )}
      <Button type="submit" size="lg" loading={busy} className="rounded-xl sm:self-end">Save and continue <ArrowRight className="h-5 w-5" /></Button>
    </form>
  );
}

function Review({ partner, go }: { partner: Partner; go: (k: StepKey) => void }) {
  const { set } = usePartner();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stepFor: Record<string, StepKey> = { profile: "about", photo: "about", vehicle: "vehicle", vehicle_rc: "vehicle", license: "documents", id_proof: "documents", bank: "payouts" };
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      set(await api<Partner>("/api/delivery/me/submit", { method: "POST" }));
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not submit");
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <StepTitle title="Check and submit" sub="Make sure everything is right. The team reviews your registration, usually within a day." />
      <ErrorNote message={error} />
      <ul className="flex flex-col divide-y divide-line rounded-2xl ring-1 ring-line" data-testid="register-checklist">
        {partner.checklist.map((i) => (
          <li key={i.key} className="flex items-center gap-3 px-4 py-3">
            <span className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", i.done ? "bg-leaf text-white" : "bg-vermilion-light text-vermilion")}>
              {i.done ? <Check className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
            </span>
            <span className="flex-1">{i.label}</span>
            {!i.done && <button type="button" onClick={() => go(stepFor[i.key] ?? "about")} className="text-sm font-semibold text-peacock">Add</button>}
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-3 rounded-xl bg-mist p-3 text-sm">
        <input type="checkbox" className="mt-0.5 h-5 w-5 accent-peacock" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I confirm these details and documents are mine and correct. I agree to the delivery partner terms, including handing over cash collected on delivery.</span>
      </label>
      <Button size="lg" className="rounded-xl" onClick={submit} loading={busy} disabled={!partner.can_submit || !agree} data-testid="register-submit">
        Submit for review
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- after submitting */

function UnderReview({ partner, options }: { partner: Partner; options: DeliveryOptions }) {
  const { reload } = usePartner();
  const [checking, setChecking] = useState(false);
  const steps = [
    { label: "Registered", done: true, note: partner.created_at ? date(partner.created_at) : "" },
    { label: "Documents sent", done: true, note: "" },
    { label: "Verification by our team", done: false, note: "Usually within a day" },
    { label: "Start delivering", done: false, note: "" },
  ];
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 pt-4" data-testid="under-review">
      <div className="rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-marigold-light text-marigold-dark"><Hourglass className="h-8 w-8" aria-hidden /></span>
        <h1 className="mt-4 text-2xl font-bold">Thanks, {partner.name.split(" ")[0]}! You are under review</h1>
        <p className="mt-1 text-ink-soft">We are checking your documents. We will send a message to <b className="text-ink">{partner.phone}</b> as soon as you are approved.</p>
        <ol className="mt-6 flex flex-col gap-0 text-left">
          {steps.map((s, i) => (
            <li key={s.label} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span className={clsx("flex h-7 w-7 items-center justify-center rounded-full", s.done ? "bg-leaf text-white" : i === 2 ? "bg-marigold text-ink" : "bg-mist text-ink-faint")}>
                  {s.done ? <Check className="h-4 w-4" /> : i === 2 ? <Hourglass className="h-3.5 w-3.5" /> : <PartyPopper className="h-3.5 w-3.5" />}
                </span>
                {i < steps.length - 1 && <span className={clsx("w-0.5 flex-1", s.done ? "bg-leaf" : "bg-line")} />}
              </div>
              <div className="pb-5">
                <p className="font-semibold">{s.label}</p>
                {s.note && <p className="text-sm text-ink-soft">{s.note}</p>}
              </div>
            </li>
          ))}
        </ol>
        <Button variant="secondary" loading={checking} onClick={() => { setChecking(true); reload().finally(() => setChecking(false)); }}>Check my status</Button>
      </div>
      <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5">
        <p className="font-semibold">Meanwhile, install the partner app</p>
        <p className="mb-3 text-sm text-ink-soft">So delivery requests reach you instantly once you are approved.</p>
        <GetTheApp options={options} compact />
      </div>
      <p className="text-center text-sm text-ink-soft">Questions? <Link href="/delivery/help" className="font-semibold text-peacock">Contact the delivery team</Link></p>
    </div>
  );
}
