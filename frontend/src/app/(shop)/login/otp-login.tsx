"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorNote, TextField } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import type { User } from "@/lib/types";

function safeNext(raw: string | null) {
  // Only same-site paths; never an absolute or protocol-relative URL (open-redirect guard).
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export function OtpLogin() {
  const site = useSite();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { signIn, user, ready } = useSession();
  const [step, setStep] = useState<"phone" | "code" | "name">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  // Already signed in when the page opened: go straight on. (Not after signing in here, so the
  // name step for new accounts is not skipped.)
  const checked = useRef(false);
  useEffect(() => {
    if (!ready || checked.current) return;
    checked.current = true;
    if (user) router.replace(next);
  }, [ready, user, next, router]);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ resend_in: number }>("/api/auth/otp/request", { method: "POST", body: { phone } });
      setStep("code");
      setWait(r.resend_in);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ access_token: string; user: User; is_new: boolean }>("/api/auth/otp/verify", { method: "POST", body: { phone, code } });
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
    <div className="overflow-hidden rounded-2xl bg-white">
      <div className="bg-peacock px-6 pb-5 pt-6 text-white">
        <h1 className="text-2xl font-bold">{step === "name" ? `Welcome to ${site.brand_name}` : "Sign in or create an account"}</h1>
        <p className="mt-1 text-white/80">
          {step === "phone" && "We will send a one-time code to your mobile."}
          {step === "code" && `Enter the ${6}-digit code sent to +91 ${phone.replace(/\D/g, "").slice(-10)}.`}
          {step === "name" && "What should we call you?"}
        </p>
      </div>
      <div className="awning" aria-hidden />
      <div className="flex flex-col gap-4 p-6 pt-3">
        <ErrorNote message={error} />
        {step === "phone" && (
          <form onSubmit={sendCode} className="flex flex-col gap-4">
            <TextField label="Mobile number" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} required autoFocus />
            <Button type="submit" size="lg" loading={busy}>Send code</Button>
            <p className="text-xs text-ink-faint">By continuing you agree to {site.brand_name}&apos;s terms of use and privacy policy.</p>
          </form>
        )}
        {step === "code" && (
          <form onSubmit={verify} className="flex flex-col gap-4">
            <TextField label="One-time code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required autoFocus />
            <Button type="submit" size="lg" loading={busy} disabled={code.length < 6}>Verify and continue</Button>
            <div className="flex items-center justify-between text-sm">
              <button type="button" className="font-semibold text-peacock" onClick={() => { setStep("phone"); setCode(""); }}>Change number</button>
              <button type="button" className="font-semibold text-peacock disabled:text-ink-faint" disabled={wait > 0 || busy} onClick={() => sendCode()}>
                {wait > 0 ? `Resend code in ${wait}s` : "Resend code"}
              </button>
            </div>
          </form>
        )}
        {step === "name" && (
          <form onSubmit={saveName} className="flex flex-col gap-4">
            <TextField label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={1} autoFocus />
            <Button type="submit" size="lg" loading={busy}>Continue</Button>
          </form>
        )}
      </div>
    </div>
  );
}
