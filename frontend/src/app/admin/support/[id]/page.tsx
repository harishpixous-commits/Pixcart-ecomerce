"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, PageLoader, Pill, Select, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { AiBadge, AiDraftButton, type AiRun } from "@/components/ai";

const STATUS: Record<string, string> = { open: "Open", awaiting_customer: "Waiting for customer", resolved: "Resolved", closed: "Closed" };

type T = {
  id: string; number: string; subject: string; category_label: string; status: string; priority: string; is_grievance: boolean; order_id: string | null; order_number: string | null;
  created_at: string; ack_due_at: string; resolve_due_at: string; ack_overdue: boolean; resolve_overdue: boolean; acknowledged_at: string | null;
  customer: { name: string; phone: string; email: string }; messages: { id: string; author_role: string; body: string; internal: boolean; at: string }[];
};

const CANNED = [
  "Thank you for writing to us. We are looking into this and will update you within 24 hours.",
  "We have asked the seller to check this and will get back to you shortly.",
  "Your refund has been processed. It reaches your account in 5 to 7 working days, depending on your bank.",
  "We are sorry for the trouble. Could you share a photo of the item and the packaging so we can raise this with the seller?",
];

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [t, setT] = useState<T | null>(null);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [status, setStatus] = useState("awaiting_customer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiRun, setAiRun] = useState<AiRun | null>(null);
  const load = useCallback(() => api<T>(`/api/admin/tickets/${id}`).then(setT), [id]);
  useEffect(() => { load(); }, [load]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      setT(await api<T>(`/api/admin/tickets/${id}/reply`, { method: "POST", body: { body, internal, status: internal ? undefined : status, ai_run_id: aiRun && !internal ? aiRun.id : undefined } }));
      setBody("");
      setAiRun(null);
      toast(internal ? "Note added" : "Reply sent to the customer");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }
  async function setField(patch: { status?: string; priority?: string }) {
    setT(await api<T>(`/api/admin/tickets/${id}/reply`, { method: "POST", body: { body: `Changed ${Object.entries(patch).map(([k, v]) => `${k} to ${v}`).join(", ")}`, internal: true, ...patch } }));
  }

  if (!t) return <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={`${t.number}: ${t.subject}`} sub={`${t.category_label}, opened ${dateTime(t.created_at)}`} actions={<Link href="/admin/support" className="text-peacock">Back to desk</Link>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-3">
          {t.messages.map((m) => (
            <div key={m.id} className={`max-w-[85%] rounded-xl p-3 ${m.internal ? "self-center border border-dashed border-marigold bg-marigold-light" : m.author_role === "staff" ? "self-end bg-peacock-light" : "self-start bg-white"}`}>
              <p className="mb-1 text-xs text-ink-faint">{m.internal ? "Internal note" : m.author_role === "staff" ? "Support" : t.customer.name || "Customer"}, {dateTime(m.at)}</p>
              <p className="whitespace-pre-line">{m.body}</p>
            </div>
          ))}
          <section className="rounded-xl bg-white p-4">
            <ErrorNote message={error} />
            <div className="mb-2"><AiDraftButton base="/api/admin/ai" task="support_reply" subjectId={t.id} withIntent onDraft={(r) => { setAiRun(r); setBody(r.output.text ?? ""); setInternal(false); }} /></div>
            {aiRun && <p className="mb-1 flex items-center gap-2 text-xs text-ink-faint"><AiBadge mode={aiRun.mode} /> Edit the draft as needed; it is sent only when you press Send reply.</p>}
            <div className="mb-2 flex flex-wrap gap-1">
              {CANNED.map((c) => <button key={c} type="button" onClick={() => setBody(c)} className="rounded-full bg-mist px-3 py-1 text-left text-xs hover:bg-peacock-light">{c.slice(0, 48)}…</button>)}
            </div>
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder={internal ? "Note for the team; the customer does not see it" : "Reply to the customer"} aria-label="Message" />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-peacock" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note</label>
              {!internal && (
                <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto" aria-label="Status after reply">
                  <option value="awaiting_customer">Then wait for customer</option><option value="open">Keep open</option><option value="resolved">Mark resolved</option>
                </Select>
              )}
              <Button onClick={send} loading={busy} disabled={!body.trim()} className="ml-auto">{internal ? "Add note" : "Send reply"}</Button>
            </div>
          </section>
        </div>
        <aside className="flex flex-col gap-3 self-start">
          <section className="rounded-xl bg-white p-4 text-sm">
            <h2 className="mb-2 font-semibold">Customer</h2>
            <p>{t.customer.name || "No name"}</p>
            <p>{t.customer.phone}</p>
            <p>{t.customer.email}</p>
            {t.order_id && <Link className="mt-2 inline-block font-semibold text-peacock" href={`/admin/orders?q=${t.order_number}`}>Order {t.order_number}</Link>}
          </section>
          <section className="flex flex-col gap-2 rounded-xl bg-white p-4 text-sm">
            <h2 className="font-semibold">Ticket</h2>
            {t.is_grievance && <Pill tone="red">Grievance</Pill>}
            <Field label="Status" htmlFor="ts"><Select id="ts" value={t.status} onChange={(e) => setField({ status: e.target.value })}>{Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Priority" htmlFor="tp"><Select id="tp" value={t.priority} onChange={(e) => setField({ priority: e.target.value })}>{["low", "normal", "high", "urgent"].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</Select></Field>
            <p>Reply by: <span className={t.ack_overdue ? "font-semibold text-vermilion" : ""}>{t.acknowledged_at ? "done" : dateTime(t.ack_due_at)}</span></p>
            <p>Resolve by: <span className={t.resolve_overdue ? "font-semibold text-vermilion" : ""}>{dateTime(t.resolve_due_at)}</span></p>
          </section>
        </aside>
      </div>
    </div>
  );
}
