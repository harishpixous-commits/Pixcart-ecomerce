"use client";

import { CheckCircle2, FlaskConical, ShieldCheck, Store } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorNote, TextField } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { User } from "@/lib/types";

/*
 * Sign in and Create account are separate, as on most Indian shopping sites:
 * - Sign in: mobile → one-time code. A number without an account is sent to Create account.
 * - Create account: name, mobile, email (per Admin → Sign-in and accounts), terms → one-time code.
 * Both work for customers and sellers; "next" decides where the person lands (e.g. /seller/onboarding).
 */

type Options = { customer_signup: boolean; seller_signup: boolean; signup_email: "optional" | "required" | "hidden"; otp_length: number; dev_otp: boolean };
type Sent = { resend_in: number; expires_in: number; length: number; dev_otp?: string };
type Verified = { access_token: string; user: User; is_new: boolean };

export function safeNext(raw: string | null) {
  // Only same-site paths; never an absolute or protocol-relative URL (open-redirect guard).
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

const digits = (v: string) => v.replace(/\D/g, "").slice(-10);
const pretty = (v: string) => { const d = digits(v); return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : v; };

function useOptions() {
  const [o, setO] = useState<Options | null>(null);
  useEffect(() => { api<Options>("/api/auth/options").then(setO).catch(quietly); }, []);
  return o;
}

function useCountdown() {
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  return [wait, setWait] as const;
}

/** Sends a signed-in person on; not after signing in here, so the name step for old accounts still shows. */
function useLeaveIfSignedIn(next: string) {
  const { user, ready } = useSession();
  const router = useRouter();
  const checked = useRef(false);
  useEffect(() => {
    if (!ready || checked.current) return;
    checked.current = true;
    if (user) router.replace(next);
  }, [ready, user, next, router]);
}

export function AuthCard({ title, subtitle, seller, children }: { title: string; subtitle: string; seller?: boolean; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm">
      <div className="bg-peacock px-6 pb-5 pt-6 text-white">
        {seller && <p className="mb-1 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold"><Store className="h-3.5 w-3.5" />Seller hub</p>}
        <h1 className="text-2xl font-bold">{title}</h1>
        <p className="mt-1 text-white/85">{subtitle}</p>
      </div>
      <div className="awning" aria-hidden />
      <div className="flex flex-col gap-4 p-6 pt-3">{children}</div>
    </div>
  );
}

function DevOtp({ code, onUse }: { code: string; onUse: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-marigold bg-marigold-light px-3 py-2 text-sm" role="status">
      <span className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 shrink-0 text-marigold-dark" aria-hidden />
        <span>Test mode, no SMS sent. Your code is <b className="font-mono text-base tracking-widest" data-testid="dev-otp">{code}</b></span>
      </span>
      <button type="button" onClick={onUse} className="shrink-0 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-peacock ring-1 ring-peacock/30">Fill in</button>
    </div>
  );
}

function CodeStep({ phone, length, devOtp, wait, busy, onVerify, onResend, onChange, verifyLabel }: {
  phone: string; length: number; devOtp?: string; wait: number; busy: boolean; verifyLabel: string;
  onVerify: (code: string) => void; onResend: () => void; onChange: () => void;
}) {
  const [code, setCode] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); onVerify(code); }} className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft">Enter the {length}-digit code sent to <b className="text-ink">{pretty(phone)}</b>.</p>
      <TextField label="One-time code" inputMode="numeric" autoComplete="one-time-code" maxLength={length} value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required autoFocus className="[&_input]:text-lg [&_input]:tracking-[0.4em]" />
      {devOtp && <DevOtp code={devOtp} onUse={() => setCode(devOtp)} />}
      <Button type="submit" size="lg" loading={busy} disabled={code.length < length}>{verifyLabel}</Button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" className="font-semibold text-peacock" onClick={onChange}>Change number</button>
        <button type="button" className="font-semibold text-peacock disabled:text-ink-faint" disabled={wait > 0 || busy} onClick={onResend}>
          {wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
        </button>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-ink-faint"><ShieldCheck className="h-3.5 w-3.5" />We never ask for this code on a call. Do not share it.</p>
    </form>
  );
}

/* ---------------------------------------------------------------- sign in */

export function SignInForm() {
  const site = useSite();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const seller = next.startsWith("/seller");
  const options = useOptions();
  const { signIn } = useSession();
  useLeaveIfSignedIn(next);
  const [step, setStep] = useState<"phone" | "code" | "name">("phone");
  const [phone, setPhone] = useState(params.get("phone") ?? "");
  const [sent, setSent] = useState<Sent | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [wait, setWait] = useCountdown();
  const signupHref = `/signup?next=${encodeURIComponent(next)}${seller ? "&seller=1" : ""}${digits(phone).length === 10 ? `&phone=${digits(phone)}` : ""}`;
  const canSignup = options ? (seller ? options.seller_signup : options.customer_signup) : true;

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setNoAccount(false);
    try {
      const r = await api<Sent>("/api/auth/otp/request", { method: "POST", body: { phone, purpose: "signin" } });
      setSent(r);
      setStep("code");
      setWait(r.resend_in);
    } catch (err) {
      if (err instanceof ApiError && err.code === "no_account") setNoAccount(true);
      else setError(err instanceof ApiError ? err.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Verified>("/api/auth/otp/verify", { method: "POST", body: { phone, code, purpose: "signin" } });
      await signIn(r.access_token, r.user);
      if (!r.user.name) setStep("name");
      else router.replace(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not verify the code");
    } finally {
      setBusy(false);
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/auth/me", { method: "PATCH", body: { name } });
      router.replace(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your name");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard seller={seller} title={step === "name" ? `Welcome to ${site.brand_name}` : seller ? "Seller sign in" : "Sign in"}
      subtitle={step === "phone" ? (seller ? "Use the mobile number of your seller account." : "Sign in with your mobile number. We will send you a one-time code.")
        : step === "code" ? "Check your messages." : "What should we call you?"}>
      <ErrorNote message={error} />
      {step === "phone" && (
        <form onSubmit={send} className="flex flex-col gap-4">
          <TextField label="Mobile number" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210" value={phone}
            onChange={(e) => { setPhone(e.target.value); setNoAccount(false); }} required autoFocus hint="10-digit Indian mobile number" />
          {noAccount && (
            <div className="rounded-lg border border-peacock/30 bg-peacock-light p-3 text-sm" role="alert">
              <p className="font-semibold">No account uses {pretty(phone)} yet.</p>
              {canSignup ? <p className="mt-0.5">New here? <Link href={signupHref} className="font-semibold text-peacock underline">Create {seller ? "your seller account" : "an account"}</Link> with this number.</p>
                : <p className="mt-0.5">New accounts are paused right now. Please try again later.</p>}
            </div>
          )}
          <Button type="submit" size="lg" loading={busy}>Send code</Button>
        </form>
      )}
      {step === "code" && sent && (
        <CodeStep phone={phone} length={sent.length || 6} devOtp={sent.dev_otp} wait={wait} busy={busy} verifyLabel="Verify and continue" onVerify={verify}
          onResend={() => send()} onChange={() => { setStep("phone"); setSent(null); }} />
      )}
      {step === "name" && (
        <form onSubmit={saveName} className="flex flex-col gap-4">
          <TextField label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} autoFocus />
          <Button type="submit" size="lg" loading={busy}>Continue</Button>
        </form>
      )}
      {step === "phone" && canSignup && (
        <div className="border-t border-line pt-4 text-center text-sm">
          {seller ? "New seller?" : `New to ${site.brand_name}?`}{" "}
          <Link href={signupHref} className="font-semibold text-peacock">{seller ? "Create your seller account" : "Create an account"}</Link>
        </div>
      )}
    </AuthCard>
  );
}

/* ---------------------------------------------------------------- create account */

export function SignUpForm() {
  const site = useSite();
  const router = useRouter();
  const params = useSearchParams();
  const seller = params.get("seller") === "1" || safeNext(params.get("next")).startsWith("/seller");
  const next = safeNext(params.get("next") ?? (seller ? "/seller/onboarding" : "/"));
  const options = useOptions();
  const { signIn } = useSession();
  useLeaveIfSignedIn(next);
  const [step, setStep] = useState<"details" | "code">("details");
  const [f, setF] = useState({ name: "", phone: params.get("phone") ?? "", email: "", terms: false, offers: false });
  const [sent, setSent] = useState<Sent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [exists, setExists] = useState(false);
  const [wait, setWait] = useCountdown();
  const emailMode = options?.signup_email ?? "optional";
  const open = options ? (seller ? options.seller_signup : options.customer_signup) : true;
  const signinHref = `/login?next=${encodeURIComponent(next)}${digits(f.phone).length === 10 ? `&phone=${digits(f.phone)}` : ""}`;

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    setExists(false);
    const problems: Record<string, string> = {};
    if (f.name.trim().length < 2) problems.name = "Enter your full name";
    if (digits(f.phone).length !== 10) problems.phone = "Enter a 10-digit mobile number";
    if (emailMode === "required" && !f.email.trim()) problems.email = "Enter your email";
    if (!f.terms) problems.terms = "Please accept to continue";
    setFields(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    try {
      const r = await api<Sent>("/api/auth/otp/request", { method: "POST", body: { phone: f.phone, purpose: "signup", for_seller: seller } });
      setSent(r);
      setStep("code");
      setWait(r.resend_in);
    } catch (err) {
      if (err instanceof ApiError && err.code === "account_exists") setExists(true);
      else setError(err instanceof ApiError ? err.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Verified>("/api/auth/otp/verify", {
        method: "POST",
        body: { phone: f.phone, code, purpose: "signup", for_seller: seller, name: f.name, email: emailMode === "hidden" ? null : f.email.trim() || null,
          accept_terms: f.terms, marketing_opt_in: f.offers },
      });
      await signIn(r.access_token, r.user);
      router.replace(next);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields ?? {}).length) { setStep("details"); setFields(err.fields ?? {}); }
      setError(err instanceof ApiError ? err.message : "Could not verify the code");
    } finally {
      setBusy(false);
    }
  }

  if (options && !open) {
    return (
      <AuthCard seller={seller} title={seller ? "Seller registration" : "Create account"} subtitle="New accounts are paused right now.">
        <p className="text-sm text-ink-soft">Please try again later. If you already have an account, you can <Link href={signinHref} className="font-semibold text-peacock">sign in</Link>.</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard seller={seller} title={seller ? "Create your seller account" : `Create your ${site.brand_name} account`}
      subtitle={step === "code" ? "Almost done. Check your messages." : seller ? "Step 1 of 3: your login. Next, your business details, then our team verifies them." : "It takes less than a minute."}>
      {seller && step === "details" && (
        <ol className="grid grid-cols-3 gap-2 text-center text-xs">
          {["Your login", "Business details", "Verification"].map((s, i) => (
            <li key={s} className={`rounded-lg px-2 py-1.5 ${i === 0 ? "bg-peacock text-white" : "bg-mist text-ink-soft"}`}>{i + 1}. {s}</li>
          ))}
        </ol>
      )}
      <ErrorNote message={error} />
      {step === "details" && (
        <form onSubmit={send} className="flex flex-col gap-4" noValidate>
          <TextField label={seller ? "Your full name (owner)" : "Full name"} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={fields.name} autoFocus />
          <TextField label="Mobile number" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210" value={f.phone}
            onChange={(e) => { setF({ ...f, phone: e.target.value }); setExists(false); }} error={fields.phone} hint="You will sign in with this number" />
          {exists && (
            <div className="rounded-lg border border-peacock/30 bg-peacock-light p-3 text-sm" role="alert">
              <p className="font-semibold">{pretty(f.phone)} already has an account.</p>
              <p className="mt-0.5"><Link href={signinHref} className="font-semibold text-peacock underline">Sign in instead</Link>{seller ? " and continue to your seller registration." : "."}</p>
            </div>
          )}
          {emailMode !== "hidden" && (
            <TextField label={`Email${emailMode === "optional" ? " (optional)" : ""}`} type="email" autoComplete="email" value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })} error={fields.email} hint="For invoices and order updates" />
          )}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-peacock" checked={f.terms} onChange={(e) => setF({ ...f, terms: e.target.checked })} />
            <span>I agree to the <Link href="/pages/terms" target="_blank" className="font-semibold text-peacock">terms of use</Link> and <Link href="/pages/privacy" target="_blank" className="font-semibold text-peacock">privacy policy</Link>.
              {fields.terms && <span className="block text-vermilion">{fields.terms}</span>}</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink-soft">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-peacock" checked={f.offers} onChange={(e) => setF({ ...f, offers: e.target.checked })} />
            <span>Send me offers and new arrivals (you can turn this off any time)</span>
          </label>
          <Button type="submit" size="lg" loading={busy}>Continue</Button>
        </form>
      )}
      {step === "code" && sent && (
        <CodeStep phone={f.phone} length={sent.length || 6} devOtp={sent.dev_otp} wait={wait} busy={busy} verifyLabel="Verify and create account" onVerify={verify}
          onResend={() => send()} onChange={() => { setStep("details"); setSent(null); }} />
      )}
      {step === "details" && (
        <div className="border-t border-line pt-4 text-center text-sm">
          Already have an account? <Link href={signinHref} className="font-semibold text-peacock">Sign in</Link>
        </div>
      )}
      {step === "details" && !seller && (
        <p className="flex items-center justify-center gap-1.5 text-xs text-ink-faint"><CheckCircle2 className="h-3.5 w-3.5" />Want to sell on {site.brand_name}? <Link href="/sell" className="font-semibold text-peacock">Become a seller</Link></p>
      )}
    </AuthCard>
  );
}
