"use client";

import clsx from "clsx";
import { BadgeCheck, ExternalLink, Flag, Play, ThumbsDown, ThumbsUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Stars } from "@/components/reviews";
import { Button, EmptyState, Input, Modal, PageLoader, Pagination, Pill, Textarea, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { date } from "@/lib/format";
import { AiBadge, AiDraftButton, type AiRun } from "@/components/ai";
import { useSite } from "@/lib/site";
import type { ReviewMedia } from "@/lib/types";

type R = {
  id: string; product: string; slug: string; rating: number; title: string; body: string; reply: string; status: string; verified: boolean;
  media: ReviewMedia[]; media_status: string; helpful_count: number; reported: boolean; at: string;
};
type Topic = { name: string; count: number; positive: number; negative: number; positive_pct: number; tone: string };
type D = {
  rating_avg: number; rating_count: number; distribution: Record<string, number>; topics: Topic[]; can_report: boolean;
  report_reasons: Record<string, string>; items: R[]; total: number; has_more: boolean;
};

export default function SellerReviews() {
  const toast = useToast();
  const site = useSite();
  const [d, setD] = useState<D | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [unanswered, setUnanswered] = useState(false);
  const [media, setMedia] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, AiRun>>({});
  const [reporting, setReporting] = useState<R | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<D>("/api/seller/reviews", { query: { page, rating: rating ?? undefined, unanswered: unanswered || undefined, media: media || undefined, q } }), setD),
    [page, rating, unanswered, media, q, track]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  if (!d) return <PageLoader />;
  const max = Math.max(1, ...Object.values(d.distribution));

  async function report(e: React.FormEvent) {
    e.preventDefault();
    if (!reporting || !reason) return;
    try {
      await api(`/api/seller/reviews/${reporting.id}/report`, { method: "POST", body: { reason, note } });
      toast("Sent to the marketplace team");
      setReporting(null);
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not send", "error");
    }
  }

  return (
    <div>
      <PageHeader title="Reviews" sub="Reply politely and publicly: customers read replies before they buy. You cannot remove reviews, but you can ask the marketplace to check one." />
      <div className="mb-4 grid gap-4 lg:grid-cols-[320px_1fr]">
        <section className="rounded-xl bg-white p-4">
          <div className="flex items-center gap-3">
            <p className="font-display text-4xl font-bold">{d.rating_avg.toFixed(1)}</p>
            <div><Stars value={d.rating_avg} /><p className="text-sm text-ink-soft">Store rating from {d.rating_count} reviews</p></div>
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {Object.entries(d.distribution).sort((a, b) => Number(b[0]) - Number(a[0])).map(([s, n]) => (
              <button key={s} type="button" onClick={() => { setRating(rating === Number(s) ? null : Number(s)); setPage(1); }}
                className={clsx("flex items-center gap-2 rounded px-1 text-sm hover:bg-mist", rating === Number(s) && "bg-peacock-light")}>
                <span className="w-10 text-left">{s} star</span>
                <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-mist"><span className="block h-full bg-marigold" style={{ width: `${(n / max) * 100}%` }} /></span>
                <span className="w-8 text-right text-ink-faint">{n}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="rounded-xl bg-white p-4">
          <h2 className="mb-1 font-semibold">What customers talk about</h2>
          <p className="mb-3 text-sm text-ink-soft">Across all your products. Fix what customers complain about most; it is the fastest way to raise your rating.</p>
          {d.topics.length === 0 ? <p className="text-sm text-ink-faint">Topics appear once a few reviews mention the same thing.</p> : (
            <div className="flex flex-wrap gap-2">
              {d.topics.map((t) => (
                <span key={t.name} className={clsx("flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm", t.tone === "positive" ? "border-leaf/40 bg-leaf-light" : t.tone === "negative" ? "border-vermilion/30 bg-vermilion-light" : "border-line")}>
                  {t.tone === "negative" ? <ThumbsDown className="h-3.5 w-3.5 text-vermilion" /> : <ThumbsUp className="h-3.5 w-3.5 text-leaf" />}
                  {t.name} · {t.count} mentions · {t.positive_pct}% positive
                </span>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input placeholder="Product or review text" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" aria-label="Search reviews" />
        <button type="button" onClick={() => { setUnanswered((v) => !v); setPage(1); }} aria-pressed={unanswered} className={clsx("rounded-full px-3 py-1 text-sm", unanswered ? "bg-peacock text-white" : "bg-white ring-1 ring-line")}>Not replied yet</button>
        <button type="button" onClick={() => { setMedia((v) => !v); setPage(1); }} aria-pressed={media} className={clsx("rounded-full px-3 py-1 text-sm", media ? "bg-peacock text-white" : "bg-white ring-1 ring-line")}>With photos</button>
        {rating && <button type="button" onClick={() => setRating(null)} className="rounded-full bg-peacock px-3 py-1 text-sm text-white">{rating} star ✕</button>}
      </div>

      {d.items.length === 0 ? <EmptyState title="No reviews here" body="Reviews appear after customers receive their orders." /> : (
        <div className="flex flex-col gap-3">
          {d.items.map((r) => (
            <section key={r.id} className="rounded-xl bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Stars value={r.rating} />
                <p className="font-semibold">{r.title}</p>
                {r.verified && <span className="flex items-center gap-0.5 text-xs font-semibold text-leaf"><BadgeCheck className="h-3.5 w-3.5" /> Verified purchase</span>}
                {r.status === "pending" && <Pill tone="amber">Waiting for a check</Pill>}
                {r.status === "hidden" && <Pill tone="red">Removed by the marketplace</Pill>}
                {r.reported && <Pill>Reported by you</Pill>}
              </div>
              <p className="text-sm text-ink-faint">
                <a href={`/p/${r.slug}#reviews`} target="_blank" rel="noopener noreferrer" className="hover:text-peacock">{r.product} <ExternalLink className="inline h-3 w-3" /></a>, {date(r.at)} · {r.helpful_count} found it helpful
              </p>
              {r.body && <p className="mt-1 whitespace-pre-line">{r.body}</p>}
              {r.media.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.media.map((m) => (
                    <a key={m.url} href={m.url} target="_blank" rel="noopener noreferrer" className="relative block h-16 w-16 overflow-hidden rounded-lg bg-mist ring-1 ring-line">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.kind === "video" ? m.poster_url || "" : m.url} alt="" className="h-full w-full object-cover" />
                      {m.kind === "video" && <Play className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 fill-white text-white" />}
                    </a>
                  ))}
                  {r.media_status === "pending" && <span className="self-center text-xs text-ink-faint">Photos waiting for a check</span>}
                </div>
              )}
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
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>{r.reply ? "Edit reply" : "Reply"}</Button>
                  {d.can_report && !r.reported && r.status === "published" && (
                    <Button size="sm" variant="ghost" onClick={() => { setReporting(r); setReason(""); setNote(""); }}><Flag className="h-4 w-4" /> Ask the marketplace to check</Button>
                  )}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
      <Pagination page={page} pageSize={20} total={d.total} onPage={setPage} />
      <Modal open={reporting !== null} onClose={() => setReporting(null)} title="Ask the marketplace to check this review">
        <form onSubmit={report} className="flex flex-col gap-2">
          <p className="text-sm text-ink-soft">Use this for abuse, personal details, reviews of a different product or fake reviews. Low ratings alone are not a reason; reply to them instead.</p>
          {Object.entries(d.report_reasons).map(([k, label]) => (
            <label key={k} className={clsx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", reason === k ? "border-peacock bg-peacock-light" : "border-line")}>
              <input type="radio" name="sr" checked={reason === k} onChange={() => setReason(k)} className="accent-peacock" /> {label}
            </label>
          ))}
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should the team look at?" aria-label="Note" />
          <Button type="submit" disabled={!reason} className="self-start">Send</Button>
        </form>
      </Modal>
    </div>
  );
}
