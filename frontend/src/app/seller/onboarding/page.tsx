"use client";

import clsx from "clsx";
import { CheckCircle2, Circle, FileText, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ButtonLink, ErrorNote, Field, PageLoader, Select, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date, STATE_OPTIONS } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { SellerProfile } from "@/lib/types";

const BUSINESS_TYPES = [
  ["proprietorship", "Sole proprietorship"],
  ["individual", "Individual"],
  ["partnership", "Partnership firm"],
  ["llp", "LLP"],
  ["private_limited", "Private limited company"],
  ["public_limited", "Public limited company"],
];

const DOCS = [
  ["pan_card", "PAN card", true],
  ["gst_certificate", "GST registration certificate", true],
  ["cancelled_cheque", "Cancelled cheque or bank statement", true],
  ["address_proof", "Address proof of pickup location", false],
] as const;

function useForm<T extends Record<string, string>>(initial: T) {
  const [v, setV] = useState(initial);
  const bind = (k: keyof T) => ({ value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value }) });
  return { v, setV, bind };
}

function Section({ title, done, children, locked }: { title: string; done: boolean; children: React.ReactNode; locked: boolean }) {
  return (
    <section className={clsx("rounded-xl bg-white p-5", locked && "opacity-90")}>
      <h2 className="mb-3 flex items-center gap-2 text-xl font-semibold">
        {done ? <CheckCircle2 className="h-5 w-5 text-leaf" aria-label="Done" /> : <Circle className="h-5 w-5 text-ink-faint" aria-label="To do" />}
        {title}
      </h2>
      {children}
    </section>
  );
}

function SaveRow({ busy, locked, error }: { busy: boolean; locked: boolean; error: string | null }) {
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      <ErrorNote message={error} />
      {!locked && <Button type="submit" loading={busy} className="self-start">Save</Button>}
    </div>
  );
}

function Forms({ s, onSaved }: { s: SellerProfile; onSaved: (p: SellerProfile) => void }) {
  const toast = useToast();
  const locked = s.status === "submitted" || s.status === "approved" || s.status === "suspended";
  const done = (k: string) => s.checklist.find((c) => c.key === k)?.done ?? false;
  const biz = useForm({ display_name: s.display_name, description: s.description, legal_name: s.legal_name, business_type: s.business_type, gstin: s.gstin ?? "", pan: "", contact_email: s.contact_email, contact_phone: s.contact_phone });
  const pickup = useForm({ line1: s.pickup.line1, line2: s.pickup.line2, city: s.pickup.city, state_code: s.pickup.state_code || "33", pincode: s.pickup.pincode });
  const bank = useForm({ holder_name: s.bank.holder_name, account_number: "", confirm_account_number: "", ifsc: s.bank.ifsc });
  const griev = useForm({ name: s.grievance.name, email: s.grievance.email, phone: s.grievance.phone });
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});

  async function save(key: string, path: string, body: object) {
    setBusy(key);
    setErrors({ ...errors, [key]: null });
    setFieldErr({});
    try {
      onSaved(await api<SellerProfile>(path, { method: "PUT", body }));
      toast("Saved");
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors({ ...errors, [key]: e.message });
        setFieldErr(e.fields);
      }
    } finally {
      setBusy(null);
    }
  }

  async function upload(kind: string, file: File) {
    setBusy(kind);
    setErrors({ ...errors, docs: null });
    const form = new FormData();
    form.append("file", file);
    try {
      onSaved(await api<SellerProfile>(`/api/seller/documents/${kind}`, { method: "POST", form }));
      toast("Document uploaded");
    } catch (e) {
      setErrors({ ...errors, docs: e instanceof ApiError ? e.message : "Upload failed" });
    } finally {
      setBusy(null);
    }
  }

  const uploaded = new Map(s.documents.map((d) => [d.kind, d]));

  return (
    <div className="flex flex-col gap-4">
      <Section title="Business details" done={done("business")} locked={locked}>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save("biz", "/api/seller/profile", biz.v); }}>
          <TextField label="Store name shown to customers" {...biz.bind("display_name")} required disabled={locked} />
          <TextField label="Legal business name (as on GST certificate)" {...biz.bind("legal_name")} required disabled={locked} />
          <Field label="Business type" htmlFor="btype">
            <Select id="btype" {...biz.bind("business_type")} disabled={locked}>
              {BUSINESS_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <TextField label="GSTIN" {...biz.bind("gstin")} required maxLength={15} placeholder="33ABCDE1234F1Z5" className="uppercase" disabled={locked} error={fieldErr.gstin} />
          <TextField label="PAN" {...biz.bind("pan")} required maxLength={10} placeholder="ABCDE1234F" hint={s.pan ? `Saved as ${s.pan}. Enter it again when you save this section.` : "Must match characters 3 to 12 of your GSTIN"} disabled={locked} error={fieldErr.pan} />
          <TextField label="Business email" type="email" {...biz.bind("contact_email")} required disabled={locked} error={fieldErr.contact_email} />
          <TextField label="Business mobile" type="tel" {...biz.bind("contact_phone")} required disabled={locked} error={fieldErr.contact_phone} />
          <Field label="About your store (optional)" className="sm:col-span-2">
            <Textarea {...biz.bind("description")} maxLength={2000} disabled={locked} />
          </Field>
          <SaveRow busy={busy === "biz"} locked={locked} error={errors.biz ?? null} />
        </form>
      </Section>

      <Section title="Pickup address" done={done("pickup")} locked={locked}>
        <p className="mb-3 text-sm text-ink-soft">Where couriers collect your orders. It must be in the state of your GST registration.</p>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save("pickup", "/api/seller/pickup-address", pickup.v); }}>
          <TextField className="sm:col-span-2" label="Building, street" {...pickup.bind("line1")} required disabled={locked} />
          <TextField className="sm:col-span-2" label="Area (optional)" {...pickup.bind("line2")} disabled={locked} />
          <TextField label="City" {...pickup.bind("city")} required disabled={locked} />
          <TextField label="PIN code" {...pickup.bind("pincode")} required maxLength={6} inputMode="numeric" disabled={locked} error={fieldErr.pincode} />
          <Field label="State" htmlFor="pstate">
            <Select id="pstate" {...pickup.bind("state_code")} disabled={locked}>
              {STATE_OPTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </Select>
          </Field>
          <SaveRow busy={busy === "pickup"} locked={locked} error={errors.pickup ?? null} />
        </form>
      </Section>

      <Section title="Bank account for payouts" done={done("bank")} locked={locked}>
        {s.bank.account_number && <p className="mb-3 text-sm text-ink-soft">Saved: {s.bank.holder_name}, account {s.bank.account_number}, IFSC {s.bank.ifsc}</p>}
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save("bank", "/api/seller/bank", bank.v); }}>
          <TextField label="Account holder name" {...bank.bind("holder_name")} required disabled={locked} />
          <TextField label="IFSC" {...bank.bind("ifsc")} required maxLength={11} className="uppercase" disabled={locked} error={fieldErr.ifsc} />
          <TextField label="Account number" {...bank.bind("account_number")} required inputMode="numeric" autoComplete="off" disabled={locked} error={fieldErr.account_number} />
          <TextField label="Confirm account number" {...bank.bind("confirm_account_number")} required inputMode="numeric" autoComplete="off" disabled={locked} error={fieldErr.confirm_account_number} />
          <SaveRow busy={busy === "bank"} locked={locked} error={errors.bank ?? null} />
        </form>
      </Section>

      <Section title="Grievance officer" done={done("grievance")} locked={false}>
        <p className="mb-3 text-sm text-ink-soft">The E-Commerce Rules require every seller to name a person who handles customer complaints. Their name and email are shown on your product pages.</p>
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save("griev", "/api/seller/grievance-officer", griev.v); }}>
          <TextField label="Name" {...griev.bind("name")} required />
          <TextField label="Email" type="email" {...griev.bind("email")} required error={fieldErr.email} />
          <TextField label="Mobile" type="tel" {...griev.bind("phone")} required error={fieldErr.phone} />
          <div className="flex flex-col gap-2 sm:col-span-3">
            <ErrorNote message={errors.griev ?? null} />
            <Button type="submit" loading={busy === "griev"} className="self-start">Save</Button>
          </div>
        </form>
      </Section>

      <Section title="Documents" done={["pan_card", "gst_certificate", "cancelled_cheque"].every((k) => uploaded.has(k))} locked={locked}>
        <p className="mb-3 text-sm text-ink-soft">PDF, JPG or PNG, up to 5 MB each. Documents are stored privately and seen only by our verification team.</p>
        <ErrorNote message={errors.docs ?? null} />
        <ul className="divide-y divide-line">
          {DOCS.map(([kind, label, required]) => {
            const d = uploaded.get(kind);
            return (
              <li key={kind} className="flex flex-wrap items-center gap-3 py-3">
                <FileText className="h-5 w-5 text-ink-faint" />
                <div className="flex-1">
                  <p className="font-medium">{label}{required ? "" : " (optional)"}</p>
                  {d ? <p className="text-sm text-leaf">Uploaded {d.filename} on {date(d.uploaded_at)}</p> : <p className="text-sm text-ink-faint">Not uploaded</p>}
                </div>
                {!locked && (
                  <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light">
                    <Upload className="h-4 w-4" />
                    {busy === kind ? "Uploading" : d ? "Replace" : "Upload"}
                    <input type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(kind, e.target.files[0])} />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

export default function OnboardingPage() {
  const { user, reloadUser } = useSession();
  const toast = useToast();
  const [profile, setProfile] = useState<SellerProfile | null | undefined>(undefined);
  const [storeName, setStoreName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<SellerProfile>("/api/seller/me").then(setProfile).catch((e) => {
    if (e instanceof ApiError && e.status === 403) setProfile(null);
    else setError(e instanceof Error ? e.message : "Could not load");
  }), []);
  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function register(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setProfile(await api<SellerProfile>("/api/seller/register", { method: "POST", body: { display_name: storeName } }));
      await reloadUser();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      setProfile(await api<SellerProfile>("/api/seller/submit", { method: "POST" }));
      await reloadUser();
      toast("Submitted for verification");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit");
    } finally {
      setBusy(false);
    }
  }

  if (profile === undefined) return error ? <ErrorNote message={error} /> : <PageLoader />;

  if (profile === null) {
    return (
      <div className="mx-auto max-w-lg rounded-xl bg-white p-6">
        <h1 className="mb-1 text-2xl font-semibold">Register as a seller</h1>
        <p className="mb-4 text-ink-soft">Choose the store name customers will see. You can add your business documents next.</p>
        <form onSubmit={register} className="flex flex-col gap-3">
          <ErrorNote message={error} />
          <TextField label="Store name" value={storeName} onChange={(e) => setStoreName(e.target.value)} minLength={3} maxLength={80} required autoFocus />
          <Button type="submit" loading={busy} className="self-start">Create seller account</Button>
        </form>
      </div>
    );
  }

  const missing = profile.checklist.filter((c) => !c.done);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Seller registration" sub={profile.display_name} />
      {profile.status === "submitted" && (
        <div className="rounded-xl bg-marigold-light p-4">
          <p className="font-semibold">Your application is being reviewed</p>
          <p className="text-ink-soft">Submitted on {date(profile.submitted_at)}. We usually finish within two working days and will show the result here.</p>
        </div>
      )}
      {profile.status === "rejected" && (
        <div className="rounded-xl bg-vermilion-light p-4">
          <p className="font-semibold text-vermilion">Changes needed before we can approve your store</p>
          <p className="text-ink">{profile.rejection_reason}</p>
          <p className="text-sm text-ink-soft">Fix the details below and submit again.</p>
        </div>
      )}
      {profile.status === "suspended" && (
        <div className="rounded-xl bg-vermilion-light p-4">
          <p className="font-semibold text-vermilion">Your store is suspended</p>
          <p>{profile.rejection_reason}</p>
        </div>
      )}
      {profile.status === "approved" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-leaf-light p-4">
          <p className="font-semibold text-leaf">Your store is approved. You can list products and receive orders.</p>
          <ButtonLink href="/seller">Go to dashboard</ButtonLink>
        </div>
      )}
      <Forms s={profile} onSaved={setProfile} />
      {(profile.status === "draft" || profile.status === "rejected") && (
        <section className="sticky bottom-3 flex flex-col gap-3 rounded-xl bg-white p-4 shadow-lg ring-1 ring-line sm:flex-row sm:items-center">
          <div className="flex-1">
            {missing.length ? (
              <p className="text-ink-soft">Still to do: {missing.map((m) => m.label.replace(/ \(.*\)$/, "")).join(", ")}</p>
            ) : (
              <p className="font-semibold text-leaf">Everything is filled in. Submit for verification.</p>
            )}
            <ErrorNote message={error} />
          </div>
          <Button variant="buy" size="lg" onClick={submit} loading={busy} disabled={missing.length > 0}>Submit for verification</Button>
        </section>
      )}
    </div>
  );
}
