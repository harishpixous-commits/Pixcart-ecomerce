"use client";

/*
 * Signed-in devices: where this account is signed in, and one button to sign every other device out (a lost phone,
 * a shared computer). Used on the shopper's Account page and on Admin → My account. This device stays signed in.
 */

import { Laptop, LogOut, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, ErrorNote, Modal, useToast } from "@/components/ui";
import { api, ApiError, quietly, refreshSession } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Device = { id: string; device: string; last_active: string; expires_at: string; current: boolean };

const PHONE = /Android|iPhone|iPad|Partner app/;

export function SignedInDevices() {
  const toast = useToast();
  const [rows, setRows] = useState<Device[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ sessions: Device[] }>("/api/auth/sessions").then((r) => setRows(r.sessions)).catch(quietly), []);
  useEffect(() => { load(); }, [load]);
  const others = (rows ?? []).filter((r) => !r.current).length;

  async function signOutOthers() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ signed_out: number }>("/api/auth/sessions/sign-out-others", { method: "POST" });
      await refreshSession(); // this device renews its access with its own session, which was kept
      setConfirm(false);
      toast(r.signed_out === 1 ? "1 other device was signed out" : `${r.signed_out} other devices were signed out`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not sign the other devices out. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl bg-white p-5" aria-labelledby="devices-h" data-testid="signed-in-devices">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="devices-h" className="text-lg font-semibold">Signed-in devices</h2>
          <p className="text-sm text-ink-soft">Where your account is signed in now. Sign the others out if you lost a phone or used a shared computer.</p>
        </div>
        <Button variant="secondary" size="sm" disabled={others === 0} onClick={() => setConfirm(true)} data-testid="sign-out-others">
          <LogOut className="h-4 w-4" aria-hidden /> Sign out other devices
        </Button>
      </div>
      {rows === null ? (
        <ul className="space-y-2" aria-hidden>{[0, 1].map((i) => <li key={i} className="h-12 animate-pulse rounded-lg bg-mist" />)}</ul>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const Icon = PHONE.test(r.device) ? Smartphone : Laptop;
            return (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <Icon className="h-5 w-5 shrink-0 text-ink-soft" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{r.device} {r.current && <span className="ml-1 rounded-full bg-leaf-light px-2 text-xs font-bold leading-5 text-leaf">This device</span>}</p>
                  <p className="text-xs text-ink-faint">Last active {dateTime(r.last_active)}</p>
                </div>
              </li>
            );
          })}
          {rows.length === 0 && <li className="py-2 text-sm text-ink-soft">No other devices.</li>}
        </ul>
      )}
      <Modal open={confirm} onClose={() => setConfirm(false)} title="Sign out other devices?">
        <p className="text-ink-soft">
          {others === 1 ? "1 other device" : `${others} other devices`} will be signed out straight away and must sign in again. This device stays signed in.
        </p>
        <ErrorNote message={error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button loading={busy} onClick={signOutOthers} data-testid="sign-out-others-confirm">Sign them out</Button>
        </div>
      </Modal>
    </section>
  );
}
