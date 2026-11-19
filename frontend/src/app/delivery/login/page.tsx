"use client";

import { Bike, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { CodeStep, safeNext, useCountdown } from "@/components/auth/auth-forms";
import { FullLoader } from "@/components/delivery/app";
import { Logo } from "@/components/shop-chrome";
import { Button, ErrorNote, TextField } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { User } from "@/lib/types";

type Sent = { resend_in: number; expires_in: number; length: number; dev_otp?: string };

/** Where a partner goes after signing in: the app when approved, otherwise registration (which shows the review status). */
function landing(user: User, next: string) {
  if (user.delivery?.kyc_status === "approved") return next.startsWith("/delivery") && !next.startsWith("/delivery/login") ? next : "/delivery";
  return "/delivery/register";
}

function PartnerLogin() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next") ?? "/delivery");
  const { user, ready, signIn } = useSession();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useCountdown();
  const left = useRef(false);

  // already signed in: go straight on
  useEffect(() => {
    if (ready && user && !left.current) {
      left.current = true;
      router.replace(landing(user, next));
    }
  }, [ready, user, next, router]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<Sent>("/api/auth/otp/request", { method: "POST", body: { phone, purpose: "any" } });
      setSent(r);
      setStep("code");
      setWait(r.resend_in);
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ access_token: string; user: User }>("/api/auth/otp/verify", { method: "POST", body: { phone, code, purpose: "any", accept_terms: true } });
      left.current = true;
      await signIn(r.access_token, r.user);
      router.replace(landing(r.user, next));
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not verify the code");
      setBusy(false);
    }
  }

  if (!ready || user) return <FullLoader label="Signing you in" />;
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-peacock via-peacock to-peacock-dark">
      <header className="mx-auto flex w-full max-w-md items-center gap-3 px-4 py-3 text-white">
        <Logo />
        <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">Delivery partner</span>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-10">
        <div className="mb-6 text-white">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15"><Bike className="h-8 w-8" aria-hidden /></span>
          <h1 className="text-3xl font-bold">{step === "phone" ? "Partner sign in" : "Enter the code"}</h1>
          <p className="mt-1 text-white/80">{step === "phone" ? "New or registered, just use your mobile number." : "We sent a one-time code by SMS."}</p>
        </div>
        <div className="flex flex-col gap-4 rounded-3xl bg-white p-6 shadow-2xl shadow-black/30">
          <ErrorNote message={error} />
          {step === "phone" ? (
            <form onSubmit={send} className="flex flex-col gap-4">
              <TextField label="Mobile number" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210" value={phone}
                onChange={(e) => setPhone(e.target.value)} required autoFocus hint="10-digit Indian mobile number" className="[&_input]:h-12 [&_input]:text-lg" />
              <Button type="submit" size="lg" loading={busy} className="rounded-xl">Send code</Button>
              <p className="text-center text-xs text-ink-faint">
                By continuing you agree to the <Link href="/pages/terms" className="font-semibold text-peacock">terms of use</Link> and <Link href="/pages/privacy" className="font-semibold text-peacock">privacy policy</Link>.
              </p>
            </form>
          ) : sent && (
            <CodeStep phone={phone} length={sent.length || 6} devOtp={sent.dev_otp} wait={wait} busy={busy} verifyLabel="Verify and continue"
              onVerify={verify} onResend={() => send()} onChange={() => { setStep("phone"); setSent(null); }} />
          )}
        </div>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-sm text-white/75"><ShieldCheck className="h-4 w-4" aria-hidden /> Your number is only used to sign you in and contact you about deliveries.</p>
        <p className="mt-2 text-center text-sm text-white/75">Not a partner yet? <Link href="/delivery/join" className="font-semibold text-marigold">See how it works</Link></p>
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<FullLoader />}><PartnerLogin /></Suspense>;
}
