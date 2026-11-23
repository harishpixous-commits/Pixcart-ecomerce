"use client";

/*
 * Ratings and reviews on the product page.
 * Anyone can read. Writing, "helpful" votes and reports need a signed-in customer; by default only customers
 * whose order was delivered can write (Admin → Reviews → Settings). Reviews can carry photos and a video;
 * every customer photo and video also appears in a gallery with the review it belongs to.
 */

import clsx from "clsx";
import { BadgeCheck, Camera, ChevronLeft, ChevronRight, Flag, ImagePlus, Pencil, Play, Star, ThumbsDown, ThumbsUp, Trash2, Video, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { frameAndLength } from "@/components/video-editor";
import { Button, ErrorNote, Modal, Select, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly, uploadWithProgress } from "@/lib/api";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useLists, useSite } from "@/lib/site";
import type { CustomerMediaItem, ReviewMedia, ReviewSettingsPublic } from "@/lib/types";

type Topic = { name: string; count: number; positive: number; negative: number; positive_pct: number; tone: "positive" | "negative" | "mixed" };
type Item = {
  id: string; rating: number; title: string; body: string; author: string; verified: boolean; seller_reply: string; helpful_count: number;
  created_at: string; media: ReviewMedia[]; voted: boolean; reported: boolean; mine: boolean;
};
type Mine = { rating: number; title: string; body: string; media: ReviewMedia[]; status: string; media_status: string };
type R = {
  rating_avg: number; rating_count: number; distribution: Record<string, number>; summary: string; topics: Topic[];
  with_media_count: number; verified_count: number; media: CustomerMediaItem[]; media_total: number; media_hidden: boolean;
  can_review: boolean; cannot_review_reason: "off" | "sign_in" | "own_product" | "not_purchased" | null; mine: Mine | null;
  settings: ReviewSettingsPublic; items: Item[]; total: number; page: number; has_more: boolean;
};

const STAR_WORDS = ["", "Hate it", "Didn't like it", "It's OK", "Liked it", "Love it"];

export function Stars({ value, size = "h-4 w-4" }: { value: number; size?: string }) {
  return (
    <span className="inline-flex" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} className={`${size} ${n <= Math.round(value) ? "fill-marigold text-marigold" : "text-line"}`} />
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------- media viewer (customer photos and videos) */

function MediaThumb({ m, onClick, label, className }: { m: ReviewMedia; onClick: () => void; label: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label}
      className={clsx("relative shrink-0 overflow-hidden rounded-lg bg-mist ring-1 ring-line hover:ring-2 hover:ring-peacock", className ?? "h-20 w-20")}>
      {m.kind === "video" ? (
        <>
          {m.poster_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={m.poster_url} alt="" className="h-full w-full object-cover" />
            : <video src={`${m.url}#t=0.5`} preload="metadata" muted className="h-full w-full object-cover" />}
          <Play className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.url} alt="" className="h-full w-full object-cover" loading="lazy" />
      )}
    </button>
  );
}

export function CustomerMediaViewer({ items, start, total, loadMore, onClose }: {
  items: CustomerMediaItem[]; start: number; total: number; loadMore?: () => void; onClose: () => void;
}) {
  const [i, setI] = useState(start);
  const cur = items[Math.min(i, items.length - 1)];
  const go = useCallback((d: number) => setI((x) => Math.max(0, Math.min(items.length - 1, x + d))), [items.length]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = prev; };
  }, [go, onClose]);
  useEffect(() => { if (loadMore && i >= items.length - 3 && items.length < total) loadMore(); }, [i, items.length, total, loadMore]);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => { strip.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest", inline: "center" }); }, [i]);
  if (!cur) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-stretch justify-center bg-ink/70 sm:p-6" onMouseDown={onClose} role="dialog" aria-modal="true" aria-label="Customer photos and videos">
      <div className="flex w-full max-w-6xl flex-col overflow-hidden bg-white sm:rounded-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <p className="font-semibold">Customer photos and videos <span className="font-normal text-ink-faint">({i + 1} of {total})</span></p>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-2 hover:bg-mist"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid min-h-0 flex-1 md:grid-cols-[1fr_320px]">
          <div className="relative flex min-h-[45vh] items-center justify-center bg-ink/[0.03]">
            {cur.kind === "video"
              ? <video key={cur.url} src={cur.url} poster={cur.poster_url || undefined} controls autoPlay playsInline className="max-h-[70vh] w-full" />
              // eslint-disable-next-line @next/next/no-img-element
              : <img key={cur.url} src={cur.url} alt={`Photo from ${cur.author}'s review`} className="max-h-[70vh] w-full object-contain" />}
            {i > 0 && <button type="button" onClick={() => go(-1)} aria-label="Previous" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow hover:bg-white"><ChevronLeft className="h-6 w-6" /></button>}
            {i < items.length - 1 && <button type="button" onClick={() => go(1)} aria-label="Next" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-2 shadow hover:bg-white"><ChevronRight className="h-6 w-6" /></button>}
          </div>
          <aside className="overflow-y-auto border-t border-line p-4 md:border-l md:border-t-0">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-peacock-light font-semibold text-peacock">{cur.author.slice(0, 1).toUpperCase()}</span>
              <p className="font-semibold">{cur.author}</p>
            </div>
            <div className="mt-2 flex items-center gap-2"><Stars value={cur.rating} /> {cur.title && <p className="font-semibold">{cur.title}</p>}</div>
            <p className="mt-1 text-xs text-ink-faint">Reviewed on {date(cur.created_at)}</p>
            {cur.verified && <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-leaf"><BadgeCheck className="h-3.5 w-3.5" /> Verified purchase</p>}
            {cur.body && <p className="mt-2 whitespace-pre-line text-sm text-ink-soft">{cur.body}</p>}
          </aside>
        </div>
        <div ref={strip} className="scroll-x flex gap-2 overflow-x-auto border-t border-line p-3">
          {items.map((m, k) => (
            <span key={`${m.url}-${k}`} data-i={k}>
              <MediaThumb m={m} onClick={() => setI(k)} label={`Show item ${k + 1}`} className={clsx("h-16 w-16", k === i && "ring-2 ring-peacock")} />
            </span>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Customer photos under the product photos: a row of thumbnails that opens the viewer. */
export function CustomerMediaStrip({ slug }: { slug: string }) {
  const pathname = usePathname();
  const photosShown = useLists().customer_photos_shown;
  const [items, setItems] = useState<CustomerMediaItem[]>([]);
  const [total, setTotal] = useState(0);
  const [signIn, setSignIn] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const { user } = useSession();
  useEffect(() => {
    api<{ items: CustomerMediaItem[]; total: number; sign_in_to_see?: boolean }>(`/api/catalog/products/${slug}/media`)
      .then((r) => { setItems(r.items); setTotal(r.total); setSignIn(Boolean(r.sign_in_to_see)); setPage(1); })
      .catch(quietly);
  }, [slug, user]);
  const loading = useRef(false);
  const loadMore = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    api<{ items: CustomerMediaItem[] }>(`/api/catalog/products/${slug}/media`, { query: { page: page + 1 } })
      .then((r) => { setItems((x) => [...x, ...r.items]); setPage((p) => p + 1); })
      .catch(quietly)
      .finally(() => { loading.current = false; });
  }, [slug, page]);
  if (signIn) {
    return <p className="mt-3 text-sm text-ink-soft"><Camera className="mr-1 inline h-4 w-4" /> Customers shared photos of this product. <Link href={`/login?next=${encodeURIComponent(pathname)}`} className="font-semibold text-peacock">Sign in to see them</Link></p>;
  }
  if (!items.length || photosShown <= 0) return null;
  const shown = items.slice(0, photosShown);
  return (
    <section className="mt-4" aria-labelledby="cust-media-h" data-testid="customer-media">
      <h2 id="cust-media-h" className="mb-2 text-sm font-semibold">Customer photos and videos ({total})</h2>
      <div className="flex flex-wrap gap-2">
        {shown.map((m, k) => <MediaThumb key={`${m.url}-${k}`} m={m} onClick={() => setOpen(k)} label={`Customer ${m.kind} ${k + 1} from ${m.author}`} className="h-16 w-16" />)}
        {total > shown.length && (
          <button type="button" onClick={() => setOpen(shown.length)} className="flex h-16 w-16 items-center justify-center rounded-lg bg-ink/80 text-sm font-semibold text-white hover:bg-ink">+{total - shown.length}</button>
        )}
      </div>
      {open !== null && <CustomerMediaViewer items={items} start={open} total={total} loadMore={loadMore} onClose={() => setOpen(null)} />}
    </section>
  );
}

/* ---------------------------------------------------------------- write a review */

type Upload = ReviewMedia & { key: string; progress?: number };

export function ReviewForm({ slug, initial, settings, onDone }: { slug: string; initial?: Mine | null; settings: ReviewSettingsPublic; onDone: () => void }) {
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [media, setMedia] = useState<Upload[]>((initial?.media ?? []).map((m, i) => ({ ...m, key: `${i}-${m.url}` })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const photos = media.filter((m) => m.kind === "image").length;
  const videos = media.filter((m) => m.kind === "video").length;
  const uploading = media.some((m) => m.progress !== undefined);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files)) {
      const isVideo = file.type.startsWith("video/");
      if (isVideo && (!settings.videos || videos >= 1)) { setError(settings.videos ? "Add at most one video" : "Videos are not accepted"); continue; }
      if (!isVideo && photos >= settings.max_photos) { setError(`Add at most ${settings.max_photos} photos`); continue; }
      if (isVideo && file.size > settings.max_video_mb * 1048576) { setError(`Videos can be up to ${settings.max_video_mb} MB`); continue; }
      const key = `${Date.now()}-${file.name}`;
      const local = URL.createObjectURL(file);
      setMedia((m) => [...m, { key, kind: isVideo ? "video" : "image", url: local, poster_url: "", progress: 0 }]);
      try {
        let poster_url = "";
        if (isVideo) {
          const { poster } = await frameAndLength(file);
          if (poster) poster_url = (await uploadWithProgress<{ url: string }>("/api/reviews/media", poster, () => {})).url;
        }
        const up = await uploadWithProgress<{ url: string; kind: "image" | "video" }>("/api/reviews/media", file, (f) =>
          setMedia((m) => m.map((x) => (x.key === key ? { ...x, progress: f } : x))));
        setMedia((m) => m.map((x) => (x.key === key ? { key, kind: up.kind, url: up.url, poster_url } : x)));
      } catch (x) {
        setMedia((m) => m.filter((y) => y.key !== key));
        setError(x instanceof ApiError ? x.message : "That file could not be uploaded");
      } finally {
        URL.revokeObjectURL(local);
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rating) return setError("Choose a star rating");
    if (settings.min_body_chars && body.trim().length < settings.min_body_chars) return setError(`Write at least ${settings.min_body_chars} characters`);
    if (uploading) return setError("Wait for the uploads to finish");
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ status: string; media_status: string; held_for_check: boolean }>(`/api/catalog/products/${slug}/reviews`, {
        method: "PUT", body: { rating, title, body, media: media.map(({ kind, url, poster_url }) => ({ kind, url, poster_url })) },
      });
      toast(r.held_for_check ? "Thanks! Reviews with phone numbers, emails or links are checked before they appear."
        : r.status === "pending" ? "Thanks! Your review will appear after a quick check."
          : r.media_status === "pending" ? "Thanks! Your photos will appear after a quick check." : "Thanks for your review");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your review");
    } finally {
      setBusy(false);
    }
  }
  const accept = [settings.photos && "image/jpeg,image/png,image/webp", settings.videos && "video/mp4,video/webm"].filter(Boolean).join(",");
  const shownStars = hover || rating;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ErrorNote message={error} />
      <fieldset>
        <legend className="mb-1 text-sm font-semibold">Overall rating</legend>
        <div className="flex items-center gap-3">
          <div className="flex gap-1" onMouseLeave={() => setHover(0)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" onClick={() => setRating(n)} onMouseEnter={() => setHover(n)} aria-label={`${n} star${n > 1 ? "s" : ""}: ${STAR_WORDS[n]}`} aria-pressed={rating === n}>
                <Star className={`h-9 w-9 transition ${n <= shownStars ? "fill-marigold text-marigold" : "text-line"}`} />
              </button>
            ))}
          </div>
          <span className="text-sm font-semibold text-ink-soft">{STAR_WORDS[shownStars]}</span>
        </div>
      </fieldset>
      {(settings.photos || settings.videos) && (
        <div>
          <p className="mb-1 text-sm font-semibold">Add photos or a video <span className="font-normal text-ink-faint">(optional)</span></p>
          <p className="mb-2 text-xs text-ink-faint">
            {settings.photos ? `Up to ${settings.max_photos} photos` : ""}{settings.photos && settings.videos ? " and " : ""}{settings.videos ? `one video (${settings.max_video_mb} MB)` : ""}. Shoppers find photos of the real product the most helpful.
          </p>
          <div className="flex flex-wrap gap-2">
            {media.map((m) => (
              <div key={m.key} className="relative h-20 w-20 overflow-hidden rounded-lg bg-mist ring-1 ring-line">
                {m.kind === "video"
                  ? <span className="flex h-full w-full items-center justify-center bg-ink/80 text-white">{m.poster_url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={m.poster_url} alt="" className="h-full w-full object-cover" /> : <Video className="h-7 w-7" />}</span>
                  // eslint-disable-next-line @next/next/no-img-element
                  : <img src={m.url} alt="" className="h-full w-full object-cover" />}
                {m.progress !== undefined && (
                  <span className="absolute inset-x-1 bottom-1 h-1.5 overflow-hidden rounded-full bg-white/70"><span className="block h-full bg-peacock" style={{ width: `${m.progress * 100}%` }} /></span>
                )}
                {m.progress === undefined && (
                  <button type="button" onClick={() => setMedia((x) => x.filter((y) => y.key !== m.key))} aria-label="Remove" className="absolute right-0.5 top-0.5 rounded-full bg-white/90 p-0.5 shadow"><X className="h-3.5 w-3.5" /></button>
                )}
              </div>
            ))}
            {(photos < settings.max_photos || (settings.videos && videos < 1)) && (
              <label className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-xs font-semibold text-peacock hover:border-peacock">
                <ImagePlus className="h-6 w-6" /> Add
                <input type="file" accept={accept} multiple className="sr-only" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} data-testid="review-media-input" />
              </label>
            )}
          </div>
        </div>
      )}
      <TextField label="Headline" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="What's most important to know?" />
      <div>
        <label className="mb-1 block text-sm font-semibold" htmlFor="rv-body">Your review{settings.min_body_chars ? "" : " (optional)"}</label>
        <Textarea id="rv-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={5} placeholder="What did you like or dislike? How did you use it?" />
        <p className="mt-0.5 text-right text-xs text-ink-faint">{body.length}/4000</p>
      </div>
      {settings.guidelines && <p className="rounded-lg bg-mist p-3 text-xs text-ink-soft">{settings.guidelines}</p>}
      <Button type="submit" loading={busy} disabled={uploading} className="self-start">{initial ? "Update review" : "Submit review"}</Button>
    </form>
  );
}

/* ---------------------------------------------------------------- report a review */

function ReportReview({ id, reasons, onDone }: { id: string; reasons: Record<string, string>; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return setError("Choose a reason");
    setBusy(true);
    try {
      await api(`/api/reviews/${id}/report`, { method: "POST", body: { reason, note } });
      toast("Thanks. Our team will check this review.");
      onDone();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not send the report");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send} className="flex flex-col gap-2">
      {Object.entries(reasons).map(([k, label]) => (
        <label key={k} className={clsx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", reason === k ? "border-peacock bg-peacock-light" : "border-line")}>
          <input type="radio" name="rr" checked={reason === k} onChange={() => setReason(k)} className="accent-peacock" /> {label}
        </label>
      ))}
      <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything else? (optional)" />
      {error && <p className="text-sm text-vermilion">{error}</p>}
      <Button type="submit" loading={busy} className="self-start">Report review</Button>
    </form>
  );
}

/* ---------------------------------------------------------------- the reviews section */

function ReviewCard({ r, signedIn, loginHref, onVote, onReport, onEdit, onDelete, onMedia }: {
  r: Item; signedIn: boolean; loginHref: string; onVote: () => void; onReport: () => void; onEdit: () => void; onDelete: () => void; onMedia: (i: number) => void;
}) {
  const [more, setMore] = useState(false);
  const long = r.body.length > 420;
  return (
    <article className="border-b border-line pb-5 last:border-0" data-testid="review">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-peacock-light text-sm font-semibold text-peacock">{r.author.slice(0, 1).toUpperCase()}</span>
        <span className="font-semibold">{r.author}</span>
        {r.mine && <span className="rounded bg-marigold-light px-1.5 text-xs font-semibold">Your review</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Stars value={r.rating} />
        {r.title && <p className="font-semibold">{r.title}</p>}
      </div>
      <p className="mt-0.5 text-xs text-ink-faint">
        Reviewed on {date(r.created_at)}
        {r.verified && <span className="ml-2 inline-flex items-center gap-0.5 font-semibold text-leaf"><BadgeCheck className="h-3.5 w-3.5" /> Verified purchase</span>}
      </p>
      {r.body && (
        <p className="mt-2 whitespace-pre-line text-ink-soft">
          {long && !more ? `${r.body.slice(0, 400)}…` : r.body}
          {long && <button type="button" onClick={() => setMore((m) => !m)} className="ml-1 text-sm font-semibold text-peacock">{more ? "Show less" : "Read more"}</button>}
        </p>
      )}
      {r.media.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {r.media.map((m, i) => <MediaThumb key={m.url} m={m} onClick={() => onMedia(i)} label={`Open ${m.kind} ${i + 1} of this review`} />)}
        </div>
      )}
      {r.seller_reply && <p className="mt-2 rounded-lg bg-mist p-3 text-sm"><span className="font-semibold">Response from the seller:</span> {r.seller_reply}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
        {r.helpful_count > 0 && <span className="text-ink-faint">{r.helpful_count === 1 ? "One person" : `${r.helpful_count} people`} found this helpful</span>}
        {r.mine ? (
          <>
            <button type="button" onClick={onEdit} className="flex items-center gap-1 font-semibold text-peacock"><Pencil className="h-3.5 w-3.5" /> Edit</button>
            <button type="button" onClick={onDelete} className="flex items-center gap-1 text-ink-faint hover:text-vermilion"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
          </>
        ) : signedIn ? (
          <>
            <button type="button" onClick={onVote} aria-pressed={r.voted}
              className={clsx("flex items-center gap-1 rounded-full px-3 py-1 ring-1", r.voted ? "bg-peacock text-white ring-peacock" : "ring-line hover:bg-mist")}>
              <ThumbsUp className="h-3.5 w-3.5" /> Helpful
            </button>
            {r.reported
              ? <span className="text-xs text-ink-faint">Reported</span>
              : <button type="button" onClick={onReport} className="flex items-center gap-1 text-ink-faint hover:text-vermilion"><Flag className="h-3.5 w-3.5" /> Report</button>}
          </>
        ) : (
          <Link href={loginHref} className="text-ink-faint hover:text-peacock">Sign in to mark this helpful</Link>
        )}
      </div>
    </article>
  );
}

export function ProductReviews({ slug }: { slug: string }) {
  const site = useSite();
  const { user } = useSession();
  const pathname = usePathname();
  const toast = useToast();
  const [data, setData] = useState<R | null>(null);
  const [sort, setSort] = useState("helpful");
  const [star, setStar] = useState<number | null>(null);
  const [onlyMedia, setOnlyMedia] = useState(false);
  const [onlyVerified, setOnlyVerified] = useState(false);
  const [topic, setTopic] = useState("");
  const [page, setPage] = useState(1);
  const [writing, setWriting] = useState(false);
  const [reporting, setReporting] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ items: CustomerMediaItem[]; start: number } | null>(null);
  const loginHref = `/login?next=${encodeURIComponent(`${pathname}#reviews`)}`;

  const load = useCallback(() => api<R>(`/api/catalog/products/${slug}/reviews`, {
    query: { sort, page, star: star ?? undefined, media: onlyMedia || undefined, verified: onlyVerified || undefined, topic: topic || undefined },
  }).then((d) => setData((prev) => (page > 1 && prev ? { ...d, items: [...prev.items, ...d.items] } : d))).catch(quietly), [slug, sort, page, star, onlyMedia, onlyVerified, topic]);
  useEffect(() => { load(); }, [load, user]);
  const resetTo = (fn: () => void) => { setPage(1); fn(); };

  const max = useMemo(() => Math.max(1, ...Object.values(data?.distribution ?? { 0: 1 })), [data]);
  if (!site.features.reviews || !data) return null;
  const filtered = star !== null || onlyMedia || onlyVerified || topic;

  async function vote(r: Item) {
    try {
      const res = await api<{ voted: boolean; helpful_count: number }>(`/api/reviews/${r.id}/helpful`, { method: "POST" });
      setData((d) => d && { ...d, items: d.items.map((x) => (x.id === r.id ? { ...x, voted: res.voted, helpful_count: res.helpful_count } : x)) });
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not record your vote", "error");
    }
  }
  async function remove() {
    if (!confirm("Delete your review? This cannot be undone.")) return;
    try {
      await api(`/api/catalog/products/${slug}/reviews`, { method: "DELETE" });
      toast("Your review was deleted");
      setPage(1);
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not delete", "error");
    }
  }
  const openReviewMedia = (r: Item, i: number) => setViewer({
    items: r.media.map((m) => ({ ...m, review_id: r.id, rating: r.rating, title: r.title, body: r.body, author: r.author, verified: r.verified, created_at: r.created_at })),
    start: i,
  });

  const writeBox = (() => {
    if (data.mine) return null;
    if (data.can_review) return <Button variant="secondary" onClick={() => setWriting(true)} className="w-full">Write a review</Button>;
    const why = data.cannot_review_reason;
    if (why === "sign_in") return <Link href={loginHref} className="block rounded-lg border border-line px-4 py-2 text-center font-semibold text-peacock hover:bg-mist">Sign in to write a review</Link>;
    if (why === "not_purchased") return <p className="text-sm text-ink-faint">{data.settings.buyers_only ? "Only customers who bought this product can review it, after it is delivered." : "You can review this product after you buy it."}</p>;
    return null;
  })();

  return (
    <section className="rounded-xl bg-white p-4 sm:p-6" id="reviews" aria-labelledby="reviews-h">
      <h2 id="reviews-h" className="mb-4 text-2xl font-semibold">Customer reviews</h2>
      <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
        {/* left: score, bars, write */}
        <div className="flex flex-col gap-4">
          {data.rating_count > 0 ? (
            <div>
              <div className="flex items-center gap-2"><Stars value={data.rating_avg} size="h-5 w-5" /><span className="text-lg font-semibold">{data.rating_avg.toFixed(1)} out of 5</span></div>
              <p className="mt-1 text-sm text-ink-faint">{data.rating_count.toLocaleString("en-IN")} {data.rating_count === 1 ? "rating" : "ratings"}</p>
              <div className="mt-3 flex flex-col gap-1.5">
                {Object.entries(data.distribution).sort((a, b) => Number(b[0]) - Number(a[0])).map(([s, n]) => {
                  const pctOf = data.rating_count ? Math.round((n / data.rating_count) * 100) : 0;
                  const active = star === Number(s);
                  return (
                    <button key={s} type="button" disabled={!n} onClick={() => resetTo(() => setStar(active ? null : Number(s)))} aria-pressed={active}
                      className={clsx("group flex items-center gap-2 rounded px-1 text-sm", n ? "hover:bg-mist" : "cursor-default opacity-60", active && "bg-peacock-light")}>
                      <span className="w-12 text-left text-peacock group-hover:underline">{s} star</span>
                      <span className="h-4 flex-1 overflow-hidden rounded bg-mist ring-1 ring-line"><span className="block h-full bg-marigold" style={{ width: `${(n / max) * 100}%` }} /></span>
                      <span className="w-10 text-right text-ink-faint">{pctOf}%</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-ink-soft">No reviews yet. {data.settings.buyers_only ? "Customers who buy this can review it after delivery." : "Be the first to review it."}</p>
          )}
          <div className="border-t border-line pt-4">
            <p className="font-semibold">Review this product</p>
            <p className="mb-3 text-sm text-ink-soft">Share your thoughts with other customers</p>
            {writeBox}
            {data.mine && (
              <div className="rounded-lg bg-mist p-3 text-sm">
                <p className="font-semibold">You reviewed this product</p>
                {data.mine.status === "pending" && <p className="text-ink-soft">Your review is waiting for a quick check.</p>}
                {data.mine.status === "hidden" && <p className="text-vermilion">Your review was removed because it did not follow the review guidelines.</p>}
                {data.mine.media_status === "pending" && data.mine.media.length > 0 && <p className="text-ink-soft">Your photos will appear after a check.</p>}
                <div className="mt-2 flex gap-3">
                  <button type="button" onClick={() => setWriting(true)} className="font-semibold text-peacock">Edit</button>
                  <button type="button" onClick={remove} className="text-ink-faint hover:text-vermilion">Delete</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* right: what customers say, photos, filters, list */}
        <div className="flex min-w-0 flex-col gap-5">
          {(data.summary || data.topics.length > 0) && (
            <div>
              <h3 className="mb-1 text-lg font-semibold">Customers say</h3>
              {data.summary && <p className="text-ink-soft">{data.summary}</p>}
              {data.summary && <p className="mt-1 text-xs text-ink-faint">Written by AI from the text of customer reviews</p>}
              {data.topics.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2" aria-label="Topics customers mention">
                  {data.topics.map((t) => {
                    const active = topic === t.name;
                    const Icon = t.tone === "negative" ? ThumbsDown : ThumbsUp;
                    return (
                      <button key={t.name} type="button" onClick={() => resetTo(() => setTopic(active ? "" : t.name))} aria-pressed={active}
                        title={`${t.positive} positive, ${t.negative} negative mentions`}
                        className={clsx("flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm",
                          active ? "border-peacock bg-peacock text-white" : t.tone === "positive" ? "border-leaf/40 bg-leaf-light text-ink" : t.tone === "negative" ? "border-vermilion/30 bg-vermilion-light text-ink" : "border-line bg-white")}>
                        {t.tone !== "mixed" && <Icon className={clsx("h-3.5 w-3.5", active ? "text-white" : t.tone === "negative" ? "text-vermilion" : "text-leaf")} />}
                        {t.name} <span className={active ? "text-white/80" : "text-ink-faint"}>({t.count})</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {data.media.length > 0 && (
            <div>
              <h3 className="mb-2 text-lg font-semibold">Reviews with photos and videos</h3>
              <div className="scroll-x flex gap-2 overflow-x-auto">
                {data.media.map((m, i) => <MediaThumb key={`${m.url}-${i}`} m={m} onClick={() => setViewer({ items: data.media, start: i })} label={`Customer ${m.kind} ${i + 1}`} className="h-24 w-24" />)}
              </div>
              {data.media_total > data.media.length && <p className="mt-1 text-sm text-ink-faint">{data.media_total} in all; open one to browse them.</p>}
            </div>
          )}
          {data.media_hidden && <p className="text-sm text-ink-soft"><Camera className="mr-1 inline h-4 w-4" /> <Link href={loginHref} className="font-semibold text-peacock">Sign in</Link> to see customer photos and videos.</p>}

          {data.rating_count > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
              <span className="text-sm font-semibold">Filter:</span>
              <button type="button" onClick={() => resetTo(() => setOnlyMedia((v) => !v))} aria-pressed={onlyMedia} disabled={!data.with_media_count}
                className={clsx("rounded-full border px-3 py-1 text-sm disabled:opacity-50", onlyMedia ? "border-peacock bg-peacock text-white" : "border-line hover:bg-mist")}>
                With photos ({data.with_media_count})
              </button>
              <button type="button" onClick={() => resetTo(() => setOnlyVerified((v) => !v))} aria-pressed={onlyVerified}
                className={clsx("rounded-full border px-3 py-1 text-sm", onlyVerified ? "border-peacock bg-peacock text-white" : "border-line hover:bg-mist")}>
                Verified purchase ({data.verified_count})
              </button>
              <label className="sr-only" htmlFor="rv-star">Star rating</label>
              <Select id="rv-star" value={star ?? ""} onChange={(e) => resetTo(() => setStar(e.target.value ? Number(e.target.value) : null))} className="h-9 w-auto text-sm">
                <option value="">All stars</option>
                {[5, 4, 3, 2, 1].map((s) => <option key={s} value={s}>{s} star only</option>)}
              </Select>
              <label className="sr-only" htmlFor="rv-sort">Sort reviews</label>
              <Select id="rv-sort" value={sort} onChange={(e) => resetTo(() => setSort(e.target.value))} className="ml-auto h-9 w-auto text-sm">
                <option value="helpful">Most helpful</option>
                <option value="recent">Most recent</option>
                <option value="high">Highest rating</option>
                <option value="low">Lowest rating</option>
              </Select>
            </div>
          )}
          {filtered && (
            <p className="-mt-2 text-sm text-ink-soft">
              {data.total} {data.total === 1 ? "review" : "reviews"}{star ? ` with ${star} star${star > 1 ? "s" : ""}` : ""}{topic ? ` mentioning "${topic}"` : ""}
              <button type="button" onClick={() => resetTo(() => { setStar(null); setOnlyMedia(false); setOnlyVerified(false); setTopic(""); })} className="ml-2 font-semibold text-peacock">Clear filters</button>
            </p>
          )}

          <div className="flex flex-col gap-5">
            {data.items.map((r) => (
              <ReviewCard key={r.id} r={r} signedIn={Boolean(user)} loginHref={loginHref} onVote={() => vote(r)} onReport={() => setReporting(r.id)}
                onEdit={() => setWriting(true)} onDelete={remove} onMedia={(i) => openReviewMedia(r, i)} />
            ))}
            {data.items.length === 0 && data.rating_count > 0 && <p className="text-ink-soft">{filtered ? "No reviews match these filters." : "Customers have rated this product but not written a review yet."}</p>}
          </div>
          {data.has_more && <Button variant="secondary" onClick={() => setPage((p) => p + 1)} className="self-start">Show more reviews</Button>}
        </div>
      </div>
      <Modal open={writing} onClose={() => setWriting(false)} title={data.mine ? "Edit your review" : "Write a review"} wide>
        <ReviewForm slug={slug} initial={data.mine} settings={data.settings} onDone={() => { setWriting(false); setPage(1); load(); }} />
      </Modal>
      <Modal open={reporting !== null} onClose={() => setReporting(null)} title="Report this review">
        {reporting && <ReportReview id={reporting} reasons={data.settings.report_reasons} onDone={() => { setReporting(null); load(); }} />}
      </Modal>
      {viewer && <CustomerMediaViewer items={viewer.items} start={viewer.start} total={viewer.items.length} onClose={() => setViewer(null)} />}
    </section>
  );
}
