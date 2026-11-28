"use client";

/** The footer newsletter box. Shows only when Admin → Growth → Newsletter is switched on. */

import { useEffect, useState } from "react";
import { Button, Input, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";

export function NewsletterBox() {
  const toast = useToast();
  const [box, setBox] = useState<{ enabled: boolean; title: string } | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { api<{ enabled: boolean; title: string }>("/api/newsletter").then(setBox).catch(quietly); }, []);
  if (!box?.enabled) return null;
  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/newsletter", { method: "POST", body: { email } });
      setDone(true);
      setEmail("");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not sign you up. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Newsletter" data-testid="newsletter-box" className="border-t border-line bg-mist">
      <form onSubmit={join} className="mx-auto flex w-full max-w-shop flex-col items-start gap-3 px-3 py-5 sm:flex-row sm:items-center sm:px-4">
        <p className="font-semibold text-ink sm:flex-1">{box.title}</p>
        {done ? (
          <p className="text-sm font-semibold text-leaf" role="status">Thanks. You are on the list.</p>
        ) : (
          <div className="flex w-full gap-2 sm:w-auto">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your email" aria-label="Email address" className="sm:w-72" />
            <Button type="submit" loading={busy}>Sign up</Button>
          </div>
        )}
      </form>
    </section>
  );
}
