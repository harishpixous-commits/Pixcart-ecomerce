"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/shop-chrome";
import { Button, ErrorNote, TextField } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { User } from "@/lib/types";

export default function AdminLogin() {
  const router = useRouter();
  const { signIn, user, ready } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ready && user?.is_admin) router.replace("/admin");
  }, [ready, user, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ access_token: string; user: User }>("/api/auth/login", { method: "POST", body: { email, password, totp: code } });
      if (!r.user.is_admin) {
        setError("This account does not have admin access");
        return;
      }
      await signIn(r.access_token, r.user);
      router.replace("/admin");
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") {
        setNeedCode(true);
        setError(null);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-peacock px-4">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white">
        <div className="bg-peacock-dark px-6 py-5">
          <Logo />
          <p className="text-white/80">Admin sign in</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4 p-6">
          <ErrorNote message={error} />
          <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          {needCode && (
            <TextField label="6-digit code from your authenticator app" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required autoFocus />
          )}
          <Button type="submit" size="lg" loading={busy}>{needCode ? "Verify and sign in" : "Sign in"}</Button>
        </form>
      </div>
    </div>
  );
}
