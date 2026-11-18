"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { ErrorNote, PageLoader, Pill, Select, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";

type D = {
  settings: { show_dev_otp: boolean; customer_signup: boolean; seller_signup: boolean; signup_email: "optional" | "required" | "hidden" };
  dev_otp: { active: boolean; reason: string };
  environment: string;
  sms_provider: string;
  otp: { length: number; valid_seconds: number; resend_seconds: number; max_attempts: number; max_per_hour: number };
};

function Toggle({ checked, onChange, label, help, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; help: string; disabled?: boolean }) {
  return (
    <label className={`flex items-start gap-3 rounded-lg border border-line p-4 ${disabled ? "opacity-60" : "cursor-pointer hover:border-peacock/40"}`}>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-6 w-11 rounded-full bg-line transition peer-checked:bg-leaf peer-focus-visible:ring-2 peer-focus-visible:ring-peacock/40" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
      </span>
      <span><span className="block font-semibold">{label}</span><span className="block text-sm text-ink-soft">{help}</span></span>
    </label>
  );
}

export default function SignInSettings() {
  const toast = useToast();
  const [d, setD] = useState<D | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<D>("/api/admin/auth-settings").then(setD).catch(quietly); }, []);

  async function save(patch: Partial<D["settings"]>) {
    setError(null);
    try {
      setD(await api<D>("/api/admin/auth-settings", { method: "PUT", body: patch }));
      toast("Saved");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    }
  }

  if (!d) return <PageLoader />;
  const s = d.settings;
  const blocked = d.environment === "production" || d.sms_provider !== "console";
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <PageHeader title="Sign-in and accounts" sub="How customers and sellers sign in and create accounts. Staff sign in with email and password at /admin/login." />
      <ErrorNote message={error} />

      <section className="rounded-xl bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">One-time code on screen (testing)</h2>
          {d.dev_otp.active ? <Pill tone="blue">Showing codes on screen</Pill> : <Pill tone="gray">Off</Pill>}
        </div>
        <Toggle checked={s.show_dev_otp} disabled={blocked} onChange={(v) => save({ show_dev_otp: v })} label="Show the code under the code box"
          help="For testing before SMS is connected: the 6-digit code appears on the sign-in and create-account screens, with a Fill in button." />
        <p className="mt-2 text-sm text-ink-soft">{d.dev_otp.reason}</p>
        <ul className="mt-2 list-disc pl-5 text-sm text-ink-faint">
          <li>Never shown in production, whatever this switch says.</li>
          <li>Switches off by itself when real SMS is connected in <Link href="/admin/integrations" className="font-semibold text-peacock">Integrations</Link> (MSG91). Now: <b>{d.sms_provider === "console" ? "no SMS provider (test)" : d.sms_provider}</b>.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">New accounts</h2>
        <Toggle checked={s.customer_signup} onChange={(v) => save({ customer_signup: v })} label="Customers can create accounts"
          help="Off: the Create account page says sign-ups are paused. Existing customers still sign in." />
        <Toggle checked={s.seller_signup} onChange={(v) => save({ seller_signup: v })} label="New sellers can register"
          help="Off: Become a seller and seller registration are paused. You can still add sellers yourself in Sellers." />
        <label className="flex flex-col gap-1 rounded-lg border border-line p-4">
          <span className="font-semibold">Email when creating an account</span>
          <span className="text-sm text-ink-soft">Mobile number and name are always asked.</span>
          <Select value={s.signup_email} onChange={(e) => save({ signup_email: e.target.value as D["settings"]["signup_email"] })} className="mt-1 w-auto self-start" aria-label="Email field">
            <option value="optional">Ask, optional</option>
            <option value="required">Ask, required</option>
            <option value="hidden">Do not ask</option>
          </Select>
        </label>
      </section>

      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-2 text-lg font-semibold">One-time code rules</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
          <dt className="text-ink-faint">Code length</dt><dd className="sm:col-span-2">{d.otp.length} digits</dd>
          <dt className="text-ink-faint">Valid for</dt><dd className="sm:col-span-2">{Math.round(d.otp.valid_seconds / 60)} minutes; only the newest code works</dd>
          <dt className="text-ink-faint">Resend after</dt><dd className="sm:col-span-2">{d.otp.resend_seconds} seconds</dd>
          <dt className="text-ink-faint">Wrong tries</dt><dd className="sm:col-span-2">{d.otp.max_attempts} per code, then a new code is needed</dd>
          <dt className="text-ink-faint">Codes per hour</dt><dd className="sm:col-span-2">{d.otp.max_per_hour} per number, 30 per network</dd>
        </dl>
        <p className="mt-2 text-xs text-ink-faint">These come from the server configuration (OTP_* settings) and are the same in every environment.</p>
      </section>
    </div>
  );
}
