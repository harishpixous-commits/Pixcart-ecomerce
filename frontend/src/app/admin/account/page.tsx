"use client";

import QRCode from "qrcode";
import { useState } from "react";
import { LayoutPicker } from "@/components/admin-shell";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Pill, TextField, useToast } from "@/components/ui";
import { useAdmin } from "@/lib/admin";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function AdminAccount() {
  const toast = useToast();
  const me = useAdmin();
  const { user, signOut } = useSession();
  const [pw, setPw] = useState({ current_password: "", new_password: "" });
  const [pwError, setPwError] = useState<string | null>(null);
  const [totpOn, setTotpOn] = useState(me?.totp_enabled ?? false);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [offPassword, setOffPassword] = useState("");
  const [tError, setTError] = useState<string | null>(null);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    try {
      await api("/api/auth/password", { method: "POST", body: pw });
      toast("Password changed. Please sign in again.");
      await signOut();
      window.location.assign(new URL("/admin/login", window.location.origin));
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : "Could not change the password");
    }
  }
  async function startTotp() {
    setTError(null);
    try {
      const r = await api<{ secret: string; uri: string }>("/api/auth/totp/setup", { method: "POST" });
      setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }) });
    } catch (err) {
      setTError(err instanceof ApiError ? err.message : "Could not start");
    }
  }
  async function confirmTotp(enable: boolean) {
    setTError(null);
    try {
      await api(`/api/auth/totp/${enable ? "enable" : "disable"}`, { method: "POST", body: enable ? { code } : { code, password: offPassword } });
      setTotpOn(enable);
      setSetup(null);
      setCode("");
      setOffPassword("");
      toast(enable ? "Two-step sign-in is on" : "Two-step sign-in is off");
    } catch (err) {
      setTError(err instanceof ApiError ? err.message : "That code did not work");
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <PageHeader title="My account" sub={`${user?.name ?? ""}, ${user?.email ?? ""}, ${me?.role_label ?? ""}`} />
      <section className="rounded-xl bg-white p-5" aria-labelledby="appearance-h" data-testid="appearance">
        <h2 id="appearance-h" className="text-lg font-semibold">Appearance</h2>
        <p className="mb-3 text-sm text-ink-soft">How the admin panel is laid out for you. Other staff keep their own choice.</p>
        <LayoutPicker />
      </section>
      <section className="rounded-xl bg-white p-5">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-lg font-semibold">Two-step sign-in</h2>
          {totpOn ? <Pill tone="green">On</Pill> : <Pill tone="red">Off</Pill>}
        </div>
        <p className="mb-3 text-ink-soft">Ask for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password) every time you sign in. Strongly recommended for everyone with admin access.</p>
        <ErrorNote message={tError} />
        {!totpOn && !setup && <Button onClick={startTotp}>Turn on two-step sign-in</Button>}
        {setup && (
          <div className="flex flex-col gap-3 sm:flex-row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR code for your authenticator app" className="h-[220px] w-[220px] rounded-lg border border-line" />
            <div className="flex flex-col gap-2">
              <p>1. Scan this code in your authenticator app.</p>
              <p className="text-sm text-ink-soft">Can&apos;t scan? Enter this key: <code className="break-all rounded bg-mist px-1">{setup.secret}</code></p>
              <p>2. Enter the 6-digit code it shows.</p>
              <TextField label="Code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <Button disabled={code.length !== 6} onClick={() => confirmTotp(true)}>Turn on</Button>
            </div>
          </div>
        )}
        {totpOn && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <TextField label="Your password" type="password" autoComplete="current-password" value={offPassword} onChange={(e) => setOffPassword(e.target.value)} />
            <TextField label="Current code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            <Button variant="danger" disabled={code.length !== 6 || !offPassword} onClick={() => confirmTotp(false)}>Turn off</Button>
          </div>
        )}
        {totpOn && <p className="mt-2 text-xs text-ink-faint">Turning it off needs your password and a current code. You get an email when it is turned off.</p>}
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-3 text-lg font-semibold">Change password</h2>
        <form onSubmit={changePassword} className="flex flex-col gap-3">
          <ErrorNote message={pwError} />
          <TextField label="Current password" type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} required />
          <TextField label="New password" type="password" autoComplete="new-password" minLength={12} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} required hint="At least 12 characters with upper and lower case letters and a number. You are signed out of every device." />
          <Button type="submit" className="self-start">Change password</Button>
        </form>
      </section>
    </div>
  );
}
