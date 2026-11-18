"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button, ErrorNote, Field, PageLoader, Select, Textarea, TextField } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { useSession } from "@/lib/session";

function NewTicket() {
  const { user, ready } = useSession();
  const router = useRouter();
  const sp = useSearchParams();
  const orderId = sp.get("order");
  const [cats, setCats] = useState<{ code: string; label: string }[]>([]);
  const [f, setF] = useState({ category: sp.get("category") ?? "order", subject: sp.get("subject") ?? "", message: "", is_grievance: sp.get("grievance") === "1" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (ready && !user) router.replace(`/login?next=${encodeURIComponent("/support/new" + (orderId ? `?order=${orderId}` : ""))}`);
    api<{ categories: { code: string; label: string }[] }>("/api/support/categories").then((r) => setCats(r.categories)).catch(quietly);
  }, [ready, user, router, orderId]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api<{ id: string }>("/api/support/tickets", { method: "POST", body: { ...f, order_id: orderId || undefined } });
      router.replace(`/support/${t.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send your request");
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="mx-auto flex max-w-2xl flex-col gap-4 rounded-xl bg-white p-6">
      <h1 className="text-2xl font-semibold">Contact support</h1>
      {orderId && <p className="text-sm text-ink-soft">About your order. We will see its details.</p>}
      <ErrorNote message={error} />
      <Field label="What is it about?" htmlFor="cat">
        <Select id="cat" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {cats.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </Select>
      </Field>
      <TextField label="Subject" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} minLength={5} maxLength={200} required />
      <Field label="Tell us what happened" htmlFor="msg"><Textarea id="msg" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} minLength={10} maxLength={5000} rows={6} required /></Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 accent-peacock" checked={f.is_grievance} onChange={(e) => setF({ ...f, is_grievance: e.target.checked })} />
        <span>Raise this as a formal grievance under the Consumer Protection (E-Commerce) Rules. It goes to our grievance officer, who acknowledges within 48 hours and resolves within one month.</span>
      </label>
      <Button type="submit" loading={busy} className="self-start">Send request</Button>
    </form>
  );
}

export default function NewTicketPage() {
  return <Suspense fallback={<PageLoader />}><NewTicket /></Suspense>;
}
