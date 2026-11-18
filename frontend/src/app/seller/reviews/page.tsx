"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Stars } from "@/components/reviews";
import { Button, EmptyState, PageLoader, Pill, Textarea, useToast } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { date } from "@/lib/format";
import { AiBadge, AiDraftButton, type AiRun } from "@/components/ai";
import { useSite } from "@/lib/site";

type R = { id: string; product: string; rating: number; title: string; body: string; reply: string; status: string; at: string };

export default function SellerReviews() {
  const toast = useToast();
  const [d, setD] = useState<{ rating_avg: number; rating_count: number; items: R[] } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, AiRun>>({});
  const site = useSite();
  const load = useCallback(() => api<typeof d>("/api/seller/reviews").then(setD).catch(quietly), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Reviews" sub="Reply politely and publicly. Customers read replies before they buy." />
      <div className="mb-4 flex items-center gap-3 rounded-xl bg-white p-4">
        <p className="font-display text-4xl font-bold">{d.rating_avg.toFixed(1)}</p>
        <div><Stars value={Math.round(d.rating_avg)} /><p className="text-sm text-ink-soft">Store rating from {d.rating_count} reviews</p></div>
      </div>
      {d.items.length === 0 ? <EmptyState title="No reviews yet" body="Reviews appear after customers receive their orders." /> : (
        <div className="flex flex-col gap-3">
          {d.items.map((r) => (
            <section key={r.id} className="rounded-xl bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Stars value={r.rating} />
                <p className="font-semibold">{r.title}</p>
                {r.status !== "published" && <Pill tone="red">Hidden by moderation</Pill>}
              </div>
              <p className="text-sm text-ink-faint">{r.product}, {date(r.at)}</p>
              <p className="mt-1">{r.body}</p>
              {r.reply && open !== r.id && <p className="mt-2 rounded-lg bg-mist p-2 text-sm"><strong>Your reply:</strong> {r.reply}</p>}
              {open === r.id ? (
                <div className="mt-2 flex flex-col gap-2">
                  {site.features.ai && <AiDraftButton base="/api/seller/ai" task="review_reply" subjectId={r.id} label="Draft reply with AI" onDraft={(run) => { setRuns({ ...runs, [r.id]: run }); setDraft({ ...draft, [r.id]: run.output.text ?? "" }); }} />}
                  {runs[r.id] && <p className="flex items-center gap-2 text-xs text-ink-faint"><AiBadge mode={runs[r.id].mode} /> Check the draft before saving.</p>}
                  <Textarea value={draft[r.id] ?? r.reply} onChange={(e) => setDraft({ ...draft, [r.id]: e.target.value })} maxLength={2000} aria-label="Reply" />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={async () => { await api(`/api/seller/reviews/${r.id}/reply`, { method: "PUT", body: { reply: draft[r.id] ?? r.reply, ai_run_id: runs[r.id]?.id } }); toast("Reply saved"); setOpen(null); load(); }}>Save reply</Button>
                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setOpen(r.id)}>{r.reply ? "Edit reply" : "Reply"}</Button>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
