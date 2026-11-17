"use client";

import clsx from "clsx";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSite } from "@/lib/site";
import { useCallback, useEffect, useState } from "react";
import { Button, ErrorNote, PageLoader, Pill, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";

type T = { id: string; number: string; subject: string; status: string; category_label: string; order_id: string | null; is_grievance: boolean; created_at: string; acknowledged_at: string | null; messages: { id: string; author_role: string; body: string; at: string }[] };

export default function TicketPage() {
  const site = useSite();
  const { id } = useParams<{ id: string }>();
  const [t, setT] = useState<T | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<T>(`/api/support/tickets/${id}`).then(setT).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      setT(await api<T>(`/api/support/tickets/${id}/messages`, { method: "POST", body: { body } }));
      setBody("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }
  if (!t) return error ? <ErrorNote message={error} /> : <PageLoader />;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <div className="rounded-xl bg-white p-5">
        <p className="text-sm text-ink-faint">{t.number}, {t.category_label}</p>
        <h1 className="text-2xl font-semibold">{t.subject}</h1>
        <div className="mt-2 flex flex-wrap gap-2">
          {t.is_grievance && <Pill tone="amber">Grievance</Pill>}
          <Pill tone={t.status === "awaiting_customer" ? "amber" : t.status === "open" ? "blue" : "green"}>{t.status === "awaiting_customer" ? "Waiting for your reply" : t.status === "open" ? "Waiting for us" : t.status}</Pill>
          {t.order_id && <Link href={`/orders/${t.order_id}`} className="text-sm font-semibold text-peacock">View order</Link>}
        </div>
      </div>
      <ol className="flex flex-col gap-3">
        {t.messages.map((m) => (
          <li key={m.id} className={clsx("max-w-[85%] rounded-xl p-4", m.author_role === "customer" ? "self-end bg-peacock-light" : "self-start bg-white")}>
            <p className="mb-1 text-xs font-semibold text-ink-faint">{m.author_role === "customer" ? "You" : `${site.brand_name} support`}, {dateTime(m.at)}</p>
            <p className="whitespace-pre-line">{m.body}</p>
          </li>
        ))}
      </ol>
      {t.status !== "closed" && (
        <form onSubmit={send} className="flex flex-col gap-2 rounded-xl bg-white p-4">
          <ErrorNote message={error} />
          <label htmlFor="reply" className="text-sm font-medium">Reply</label>
          <Textarea id="reply" value={body} onChange={(e) => setBody(e.target.value)} required maxLength={5000} />
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>Send</Button>
            <Button type="button" variant="ghost" onClick={() => api<T>(`/api/support/tickets/${id}/close`, { method: "POST" }).then(setT)}>My issue is solved</Button>
          </div>
        </form>
      )}
    </div>
  );
}
