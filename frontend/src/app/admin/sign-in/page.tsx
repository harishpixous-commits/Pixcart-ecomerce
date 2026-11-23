"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, PageLoader, Pill, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";

type NumberKey = (typeof CODE_RULES)[number][0] | (typeof PASSWORD_RULES)[number][0] | (typeof SESSION_RULES)[number][0];
type D = {
  settings: {
    show_dev_otp: boolean; customer_signup: boolean; seller_signup: boolean; signup_email: "optional" | "required" | "hidden";
    password_require_mixed: boolean; staff_require_two_step: boolean; login_alerts: "off" | "staff" | "everyone";
  } & Record<NumberKey, number>;
  dev_otp: { active: boolean; reason: string };
  environment: string;
  sms_provider: string;
  limits: Record<NumberKey, [number, number]>;
};

/** [setting, label, help]. The allowed range comes from the API. */
const CODE_RULES = [
  ["otp_length", "Code length (digits)", "Your SMS template (DLT) must allow this length"],
  ["otp_ttl_seconds", "Code valid for (seconds)", "Only the newest code works"],
  ["otp_resend_cooldown_seconds", "Wait before a new code (seconds)", "Stops repeated taps from sending many SMS"],
  ["otp_max_attempts", "Wrong tries per code", "Then a new code is needed"],
  ["otp_max_per_hour", "Codes per mobile number per hour", "Protects your SMS budget"],
  ["otp_max_per_ip_hour", "Codes per network per hour", "Stops someone checking many numbers"],
] as const;
const PASSWORD_RULES = [
  ["password_min_length", "Shortest password (characters)", "For staff passwords, new and changed"],
  ["login_max_attempts", "Sign-in tries before a wait", "Counts every try for one email"],
  ["login_lockout_minutes", "Wait (minutes)", "Also the period the tries are counted over"],
] as const;
const SESSION_RULES = [
  ["customer_session_days", "Customers and sellers stay signed in for (days)", "Renewed while they use the shop"],
  ["staff_session_days", "Staff stay signed in for (days)", "Shorter is safer for the admin panel"],
] as const;

function NumberRules({ d, rules, onSave }: { d: D; rules: readonly (readonly [NumberKey, string, string])[]; onSave: (p: Partial<D["settings"]>) => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(rules.map(([k]) => [k, String(d.settings[k])])));
  const [busy, setBusy] = useState(false);
  const changed = rules.some(([k]) => draft[k] !== String(d.settings[k]));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await onSave(Object.fromEntries(rules.map(([k]) => [k, Number(draft[k])])) as Partial<D["settings"]>);
    setBusy(false);
  }
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
      {rules.map(([k, label, help]) => (
        <TextField key={k} label={label} inputMode="numeric" value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
          hint={`${help}. ${d.limits[k][0]} to ${d.limits[k][1]}.`} />
      ))}
      <div className="sm:col-span-2"><Button type="submit" loading={busy} disabled={!changed} size="sm">Save</Button></div>
    </form>
  );
}

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
          help={`For testing before SMS is connected: the ${s.otp_length}-digit code appears on the sign-in and create-account screens, with a Fill in button.`} />
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

      <section className="rounded-xl bg-white p-5" data-testid="code-rules">
        <h2 className="text-lg font-semibold">One-time code rules</h2>
        <p className="mb-3 text-sm text-ink-soft">For customers, sellers and delivery partners, who sign in with a code sent by SMS.</p>
        <NumberRules d={d} rules={CODE_RULES} onSave={save} />
      </section>

      <section className="flex flex-col gap-3 rounded-xl bg-white p-5" data-testid="staff-security">
        <div>
          <h2 className="text-lg font-semibold">Staff passwords and two-step sign-in</h2>
          <p className="text-sm text-ink-soft">Staff sign in to the admin panel with email and password.</p>
        </div>
        <Toggle checked={s.staff_require_two_step} onChange={(v) => save({ staff_require_two_step: v })} label="Staff must use two-step sign-in"
          help="Staff without an authenticator app are asked to set it up in My account before they can use the admin panel. Turn it on for your own account first." />
        <Toggle checked={s.password_require_mixed} onChange={(v) => save({ password_require_mixed: v })} label="Passwords need upper and lower case letters and a number"
          help="Off: only the length is checked. A long passphrase is just as strong." />
        <NumberRules d={d} rules={PASSWORD_RULES} onSave={save} />
      </section>

      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">Staying signed in and sign-in alerts</h2>
        <NumberRules d={d} rules={SESSION_RULES} onSave={save} />
        <label className="flex flex-col gap-1 rounded-lg border border-line p-4">
          <span className="font-semibold">Alert when an account signs in on a new device</span>
          <span className="text-sm text-ink-soft">A message in the app and by email, naming the browser and system. Everyone can also see and sign out their devices in their account.</span>
          <Select value={s.login_alerts} onChange={(e) => save({ login_alerts: e.target.value as D["settings"]["login_alerts"] })} className="mt-1 w-auto self-start" aria-label="Sign-in alerts">
            <option value="staff">Staff only</option>
            <option value="everyone">Everyone</option>
            <option value="off">Off</option>
          </Select>
        </label>
      </section>

    </div>
  );
}
