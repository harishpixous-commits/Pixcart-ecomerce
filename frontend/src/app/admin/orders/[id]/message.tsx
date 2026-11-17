"use client";

import { useState } from "react";
import { AiBadge, AiDraftButton, type AiRun } from "@/components/ai";
import { Button, ErrorNote, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAdmin } from "@/lib/admin";

/** Message the customer about this order: AI writes a draft, staff edit and send it (in-app and email). */
export function CustomerMessage({ orderId }: { orderId: string }) {
  const toast = useToast();
  const me = useAdmin();
  const [run, setRun] = useState<AiRun | null>(null);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me?.permissions.includes("orders")) return null;

  async function send() {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/ai/runs/${run.id}/send`, { method: "POST", body: { subject, text } });
      toast("Message sent to the customer");
      setRun(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    if (run) await api(`/api/admin/ai/runs/${run.id}/discard`, { method: "POST", body: {} }).catch(() => {});
    setRun(null);
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-white p-4">
      <h2 className="font-semibold">Message the customer</h2>
      {!run ? (
        <>
          <p className="text-sm text-ink-soft">Write an update about this order. It is sent in the app and by email.</p>
          <AiDraftButton base="/api/admin/ai" task="customer_message" subjectId={orderId} withIntent requireIntent intentLabel="What should the message tell them?" label="Write message with AI"
            onDraft={(r) => { setRun(r); setSubject(r.output.subject ?? "About your order"); setText(r.output.text ?? ""); }} />
        </>
      ) : (
        <>
          <div className="flex items-center gap-2"><AiBadge mode={run.mode} /><span className="text-xs text-ink-faint">Check every detail before sending.</span></div>
          <TextField label="Subject" value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} />
          <Textarea rows={6} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
          <ErrorNote message={error} />
          <div className="flex gap-2">
            <Button onClick={send} loading={busy} disabled={subject.trim().length < 3 || text.trim().length < 10}>Send to customer</Button>
            <Button variant="ghost" onClick={discard}>Discard</Button>
          </div>
        </>
      )}
    </section>
  );
}
