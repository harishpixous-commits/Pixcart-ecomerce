"use client";

import { Star, ThumbsUp } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, ErrorNote, Modal, Select, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";

type R = {
  rating_avg: number;
  rating_count: number;
  distribution: Record<string, number>;
  summary: string;
  can_review: boolean;
  mine: { rating: number; title: string; body: string } | null;
  items: { id: string; rating: number; title: string; body: string; author: string; verified: boolean; seller_reply: string; helpful_count: number; created_at: string }[];
  has_more: boolean;
};

export function Stars({ value, size = "h-4 w-4" }: { value: number; size?: string }) {
  return (
    <span className="inline-flex" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={`${size} ${n <= Math.round(value) ? "fill-marigold text-marigold" : "text-line"}`} />
      ))}
    </span>
  );
}

export function ReviewForm({ slug, initial, onDone }: { slug: string; initial?: { rating: number; title: string; body: string } | null; onDone: () => void }) {
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rating) return setError("Choose a star rating");
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: string }>(`/api/catalog/products/${slug}/reviews`, { method: "PUT", body: { rating, title, body } });
      toast(r.status === "hidden" ? "Thanks! Your review will appear after a quick check." : "Thanks for your review");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your review");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <ErrorNote message={error} />
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Your rating</legend>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} star${n > 1 ? "s" : ""}`} aria-pressed={rating === n}>
              <Star className={`h-8 w-8 ${n <= rating ? "fill-marigold text-marigold" : "text-line"}`} />
            </button>
          ))}
        </div>
      </fieldset>
      <TextField label="Headline (optional)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      <label className="text-sm font-medium" htmlFor="rv-body">What did you like or dislike?</label>
      <Textarea id="rv-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={4} />
      <Button type="submit" loading={busy} className="self-start">Submit review</Button>
    </form>
  );
}

export function ProductReviews({ slug }: { slug: string }) {
  const site = useSite();
  const { user } = useSession();
  const [data, setData] = useState<R | null>(null);
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);
  const [writing, setWriting] = useState(false);
  const load = useCallback(() => api<R>(`/api/catalog/products/${slug}/reviews`, { query: { sort, page } }).then((d) => setData((prev) => (page > 1 && prev ? { ...d, items: [...prev.items, ...d.items] } : d))).catch(quietly), [slug, sort, page]);
  useEffect(() => {
    load().catch(() => {});
  }, [load, user]);
  if (!site.features.reviews || !data) return null;
  const max = Math.max(1, ...Object.values(data.distribution));
  return (
    <section className="rounded-xl bg-white p-4 sm:p-6" id="reviews">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Ratings and reviews</h2>
        {data.can_review && <Button variant="secondary" size="sm" onClick={() => setWriting(true)}>{data.mine ? "Edit your review" : "Write a review"}</Button>}
      </div>
      {data.rating_count === 0 ? (
        <p className="text-ink-soft">No reviews yet. Customers who buy this can review it after delivery.</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[260px_1fr]">
          <div>
            <p className="font-display text-4xl font-bold">{data.rating_avg.toFixed(1)}<span className="text-xl text-ink-faint">/5</span></p>
            <Stars value={data.rating_avg} />
            <p className="mb-3 text-sm text-ink-faint">{data.rating_count.toLocaleString("en-IN")} verified ratings</p>
            {Object.entries(data.distribution).map(([star, n]) => (
              <div key={star} className="flex items-center gap-2 text-sm">
                <span className="w-6">{star}★</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-mist"><span className="block h-full bg-leaf" style={{ width: `${(n / max) * 100}%` }} /></span>
                <span className="w-8 text-right text-ink-faint">{n}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            {data.summary && (
              <div className="rounded-lg bg-peacock-light p-3 text-sm">
                <p className="font-semibold text-peacock">What buyers say</p>
                <p className="text-ink">{data.summary}</p>
                <p className="mt-1 text-xs text-ink-faint">Summary written by AI from verified reviews.</p>
              </div>
            )}
            <div className="flex justify-end">
              <label className="sr-only" htmlFor="rv-sort">Sort reviews</label>
              <Select id="rv-sort" value={sort} onChange={(e) => { setPage(1); setSort(e.target.value); }} className="h-9 w-auto text-sm">
                <option value="recent">Most recent</option>
                <option value="helpful">Most helpful</option>
                <option value="high">Highest rating</option>
                <option value="low">Lowest rating</option>
              </Select>
            </div>
            {data.items.map((r) => (
              <article key={r.id} className="border-b border-line pb-4 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-leaf px-1.5 text-xs font-semibold leading-5 text-white">{r.rating} ★</span>
                  {r.title && <p className="font-semibold">{r.title}</p>}
                </div>
                {r.body && <p className="mt-1 whitespace-pre-line text-ink-soft">{r.body}</p>}
                <p className="mt-1 text-xs text-ink-faint">{r.author}, verified buyer, {date(r.created_at)}</p>
                {r.seller_reply && <p className="mt-2 rounded-lg bg-mist p-2 text-sm"><span className="font-semibold">Seller replied:</span> {r.seller_reply}</p>}
                {user && (
                  <button className="mt-1 inline-flex items-center gap-1 text-xs text-ink-faint hover:text-peacock" onClick={() => api(`/api/reviews/${r.id}/helpful`, { method: "POST" }).then(() => setData((d) => d && { ...d, items: d.items.map((x) => (x.id === r.id ? { ...x, helpful_count: x.helpful_count + 1 } : x)) })).catch(quietly)}>
                    <ThumbsUp className="h-3.5 w-3.5" /> Helpful ({r.helpful_count})
                  </button>
                )}
              </article>
            ))}
            {data.has_more && <Button variant="ghost" onClick={() => setPage((p) => p + 1)}>Show more reviews</Button>}
          </div>
        </div>
      )}
      <Modal open={writing} onClose={() => setWriting(false)} title="Rate this product">
        <ReviewForm slug={slug} initial={data.mine} onDone={() => { setWriting(false); setPage(1); load(); }} />
      </Modal>
    </section>
  );
}
