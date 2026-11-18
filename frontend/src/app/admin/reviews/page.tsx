"use client";

import clsx from "clsx";
import { BadgeCheck, ExternalLink, Flag, ImageOff, Play, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Stars } from "@/components/reviews";
import { Button, EmptyState, ErrorNote, Input, PageLoader, Pagination, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, latestOnly, quietly } from "@/lib/api";
import { date } from "@/lib/format";
import type { ReviewMedia } from "@/lib/types";

type R = {
  id: string; product: string; slug: string; author: string; phone: string | null; rating: number; title: string; body: string; status: string;
  verified: boolean; media: ReviewMedia[]; media_status: string; seller_reply: string; helpful_count: number; report_count: number;
  reports: { reason: string; note: string }[]; at: string;
};
type Counts = { published: number; pending: number; hidden: number; reported: number; media_pending: number };
type Topic = { name: string; words: string[] };
type Settings = {
  feature_reviews: boolean; reviews_need_approval: boolean; buyers_only: boolean; media_need_approval: boolean; photos: boolean; max_photos: number;
  videos: boolean; max_video_mb: number; media_public: boolean; report_hide_at: number; seller_can_report: boolean; min_body_chars: number;
  topics_enabled: boolean; topics: Topic[]; guidelines: string; default_topics: Topic[]; default_guidelines: string;
};

const QUEUES: Record<string, { label: string; query: Record<string, string | boolean>; hint: string }> = {
  pending: { label: "Waiting for a check", query: { status: "pending" }, hint: "Held for moderation, contained contact details or links, or were hidden after customer reports." },
  reported: { label: "Reported", query: { reported: true }, hint: "Customers or sellers flagged these. Publish to dismiss the reports, hide to uphold them." },
  media: { label: "Photos to check", query: { media_pending: true }, hint: "Photos and videos waiting for approval (Settings → photos need approval)." },
  published: { label: "Published", query: { status: "published" }, hint: "Live on product pages and counted in ratings." },
  hidden: { label: "Hidden", query: { status: "hidden" }, hint: "Removed by staff. Not shown and not counted." },
};

function Moderation({ queue, onCounts }: { queue: string; onCounts: (c: Counts) => void }) {
  const toast = useToast();
  const [rating, setRating] = useState("");
  const [onlyMedia, setOnlyMedia] = useState(false);
  const [items, setItems] = useState<R[] | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(
    api<{ items: R[]; total: number; counts: Counts }>("/api/admin/reviews", { query: { ...QUEUES[queue].query, rating: rating || undefined, media: onlyMedia || undefined, q, page } }),
    (r) => { setItems(r.items); setTotal(r.total); onCounts(r.counts); },
  ), [queue, rating, onlyMedia, q, page, track, onCounts]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  async function act(r: R, action: string, done: string) {
    try {
      await api(`/api/admin/reviews/${r.id}/${action}`, { method: "POST" });
      toast(done);
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not update", "error");
    }
  }
  return (
    <div>
      <p className="mb-3 text-sm text-ink-soft">{QUEUES[queue].hint}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input placeholder="Product, customer or review text" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" aria-label="Search reviews" />
        {["", "1", "2", "3", "4", "5"].map((x) => (
          <button key={x} onClick={() => { setRating(x); setPage(1); }} className={clsx("rounded-full px-3 py-1 text-sm", rating === x ? "bg-peacock text-white" : "bg-white ring-1 ring-line")}>{x ? `${x}★` : "All stars"}</button>
        ))}
        <label className="ml-1 flex items-center gap-1.5 text-sm"><input type="checkbox" className="accent-peacock" checked={onlyMedia} onChange={(e) => { setOnlyMedia(e.target.checked); setPage(1); }} /> With photos or video</label>
      </div>
      {!items ? <PageLoader /> : items.length === 0 ? <EmptyState title="Nothing here" body="New items appear here as customers write and report reviews." /> : (
        <div className="flex flex-col gap-3">
          {items.map((r) => (
            <section key={r.id} className={clsx("rounded-xl bg-white p-4", r.report_count > 0 && "ring-2 ring-vermilion/40")} data-testid="admin-review">
              <div className="flex flex-wrap items-center gap-2">
                <Stars value={r.rating} />
                <p className="font-semibold">{r.title || "(no headline)"}</p>
                {r.verified ? <span className="flex items-center gap-0.5 text-xs font-semibold text-leaf"><BadgeCheck className="h-3.5 w-3.5" /> Verified purchase</span> : <span className="text-xs text-ink-faint">Not a verified purchase</span>}
                <span className={clsx("ml-auto rounded-full px-2 py-0.5 text-xs font-semibold", r.status === "published" ? "bg-leaf-light text-leaf" : r.status === "pending" ? "bg-marigold-light text-ink" : "bg-mist text-ink-faint")}>{r.status}</span>
              </div>
              <p className="mt-0.5 text-sm text-ink-faint">
                {r.author || "Customer"}{r.phone ? ` (${r.phone})` : ""} on{" "}
                <a href={`/p/${r.slug}#reviews`} target="_blank" rel="noopener noreferrer" className="text-peacock hover:underline">{r.product} <ExternalLink className="inline h-3 w-3" /></a>, {date(r.at)} · {r.helpful_count} helpful
              </p>
              {r.body && <p className="mt-2 whitespace-pre-line">{r.body}</p>}
              {r.media.length > 0 && (
                <div className="mt-2">
                  <div className="flex flex-wrap gap-2">
                    {r.media.map((m) => (
                      <a key={m.url} href={m.url} target="_blank" rel="noopener noreferrer" className="relative block h-20 w-20 overflow-hidden rounded-lg bg-mist ring-1 ring-line">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {m.kind === "video" ? (m.poster_url ? <img src={m.poster_url} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-xs">Video</span>) : <img src={m.url} alt="" className="h-full w-full object-cover" />}
                        {m.kind === "video" && <Play className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 fill-white text-white drop-shadow" />}
                      </a>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-ink-faint">Photos and videos: <span className="font-semibold">{r.media_status === "pending" ? "waiting for approval" : r.media_status}</span></p>
                </div>
              )}
              {r.reports.length > 0 && (
                <ul className="mt-2 rounded-lg bg-vermilion-light p-2 text-sm">
                  {r.reports.map((x, i) => <li key={i} className="flex gap-1.5"><Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vermilion" /> <span><span className="font-semibold">{x.reason}</span>{x.note ? `: ${x.note}` : ""}</span></li>)}
                </ul>
              )}
              {r.seller_reply && <p className="mt-2 rounded-lg bg-mist p-2 text-sm"><span className="font-semibold">Seller replied:</span> {r.seller_reply}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {r.status !== "published" && <Button size="sm" onClick={() => act(r, "publish", "Review published")}>Publish</Button>}
                {r.status !== "hidden" && <Button size="sm" variant="danger" onClick={() => act(r, "hide", "Review hidden")}><Trash2 className="h-4 w-4" /> Hide</Button>}
                {r.media.length > 0 && r.media_status !== "published" && <Button size="sm" variant="secondary" onClick={() => act(r, "publish-media", "Photos approved")}>Approve photos</Button>}
                {r.media.length > 0 && r.media_status !== "hidden" && <Button size="sm" variant="secondary" onClick={() => act(r, "hide-media", "Photos removed")}><ImageOff className="h-4 w-4" /> Remove photos</Button>}
                {r.report_count > 0 && r.status === "published" && <Button size="sm" variant="ghost" onClick={() => act(r, "dismiss-reports", "Reports dismissed")}>Dismiss reports</Button>}
              </div>
            </section>
          ))}
        </div>
      )}
      {items && <Pagination page={page} pageSize={30} total={total} onPage={setPage} />}
    </div>
  );
}

function Toggle({ checked, onChange, title, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint: string; disabled?: boolean }) {
  return (
    <label className={clsx("flex items-start gap-3 rounded-lg border border-line p-3", disabled && "opacity-50")}>
      <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-semibold">{title}</span><br /><span className="text-sm text-ink-soft">{hint}</span></span>
    </label>
  );
}

function SettingsForm() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Settings>("/api/admin/review-settings").then((x) => { setS(x); setWords(x.topics.map((t) => t.words.join(", "))); }).catch(quietly);
  }, []);
  if (!s) return <PageLoader />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const topics = s.topics.map((t, i) => ({ name: t.name.trim(), words: (words[i] ?? "").split(",").map((w) => w.trim()).filter(Boolean) })).filter((t) => t.name);
      const body = {
        feature_reviews: s.feature_reviews, reviews_need_approval: s.reviews_need_approval, buyers_only: s.buyers_only, media_need_approval: s.media_need_approval,
        photos: s.photos, max_photos: s.max_photos, videos: s.videos, max_video_mb: s.max_video_mb, media_public: s.media_public, report_hide_at: s.report_hide_at,
        seller_can_report: s.seller_can_report, min_body_chars: s.min_body_chars, topics_enabled: s.topics_enabled, topics, guidelines: s.guidelines,
      };
      const x = await api<Settings>("/api/admin/review-settings", { method: "PUT", body });
      setS(x);
      setWords(x.topics.map((t) => t.words.join(", ")));
      toast("Review settings saved");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  const num = (k: keyof Settings) => ({
    value: String(s[k] as number), inputMode: "numeric" as const,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, (Number(e.target.value.replace(/\D/g, "")) || 0) as never),
  });
  return (
    <form onSubmit={save} className="flex max-w-3xl flex-col gap-4">
      <ErrorNote message={error} />
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Who can review</h2>
        <Toggle checked={s.feature_reviews} onChange={(v) => set("feature_reviews", v)} title="Ratings and reviews" hint="Off hides reviews everywhere and stops new ones." />
        <Toggle checked={s.buyers_only} onChange={(v) => set("buyers_only", v)} title="Verified buyers only (recommended)" hint="Only customers whose order was delivered can write. Off: any signed-in customer, shown without the 'Verified purchase' badge." />
        <p className="rounded-lg bg-mist p-3 text-sm text-ink-soft sm:col-span-2">Visitors who are not signed in can always read reviews and see ratings. Writing, voting &ldquo;helpful&rdquo; and reporting need a signed-in account; sellers can never review their own products.</p>
        <TextField label="Shortest review text (characters)" {...num("min_body_chars")} hint="0 lets customers leave just a star rating. Up to 500." />
      </section>

      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Photos and videos in reviews</h2>
        <Toggle checked={s.photos} onChange={(v) => set("photos", v)} title="Customers can add photos" hint="JPG, PNG or WebP. Shown in the review and in the customer photo gallery on the product page." />
        <TextField label="Photos per review" {...num("max_photos")} hint="0 to 10" disabled={!s.photos} />
        <Toggle checked={s.videos} onChange={(v) => set("videos", v)} title="Customers can add a video" hint="One MP4 or WebM video per review." />
        <TextField label="Largest review video (MB)" {...num("max_video_mb")} hint="5 to 100" disabled={!s.videos} />
        <Toggle checked={s.media_need_approval} onChange={(v) => set("media_need_approval", v)} title="Check photos and videos before they appear" hint="New photos wait in 'Photos to check'. The review text is published as usual." />
        <Toggle checked={s.media_public} onChange={(v) => set("media_public", v)} title="Show customer photos to visitors who are not signed in" hint="Off: only signed-in shoppers see customer photos and videos." />
      </section>

      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Moderation</h2>
        <Toggle checked={s.reviews_need_approval} onChange={(v) => set("reviews_need_approval", v)} title="Hold every new review for a check" hint="Reviews appear only after staff publish them. Reviews with phone numbers, emails or links are always held." />
        <Toggle checked={s.seller_can_report} onChange={(v) => set("seller_can_report", v)} title="Sellers can report reviews" hint="Sellers cannot delete reviews; they can ask staff to check one." />
        <TextField label="Hide a review after this many reports" {...num("report_hide_at")} hint="It waits for staff in 'Waiting for a check'. 0 = never hide automatically." />
      </section>

      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">What customers talk about</h2>
        <Toggle checked={s.topics_enabled} onChange={(v) => set("topics_enabled", v)} title="Show topic chips on product pages" hint="Counts reviews that mention each topic, with how many were positive (4-5 stars) or negative (1-2 stars). Shoppers click a topic to read those reviews. No AI needed." />
        <div className="flex flex-col gap-2">
          {s.topics.map((t, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[180px_1fr_auto]">
              <Input value={t.name} maxLength={30} aria-label={`Topic ${i + 1} name`} onChange={(e) => set("topics", s.topics.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
              <Input value={words[i] ?? ""} aria-label={`Topic ${i + 1} words`} placeholder="words, separated, by commas" onChange={(e) => setWords(words.map((w, k) => (k === i ? e.target.value : w)))} />
              <Button type="button" variant="ghost" size="sm" onClick={() => { set("topics", s.topics.filter((_, k) => k !== i)); setWords(words.filter((_, k) => k !== i)); }}>Remove</Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={s.topics.length >= 20} onClick={() => { set("topics", [...s.topics, { name: "", words: [] }]); setWords([...words, ""]); }}>Add topic</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => { set("topics", s.default_topics); setWords(s.default_topics.map((t) => t.words.join(", "))); }}><RotateCcw className="h-4 w-4" /> Restore the standard topics</Button>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-xl bg-white p-5">
        <h2 className="text-lg font-semibold">Review guidelines</h2>
        <p className="text-sm text-ink-soft">Shown to customers above the review form.</p>
        <Textarea rows={5} maxLength={2000} value={s.guidelines} onChange={(e) => set("guidelines", e.target.value)} aria-label="Review guidelines" />
        <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => set("guidelines", s.default_guidelines)}><RotateCcw className="h-4 w-4" /> Use the standard text</Button>
      </section>
      <Button type="submit" loading={busy} className="self-start">Save review settings</Button>
    </form>
  );
}

export default function AdminReviews() {
  const [tab, setTab] = useState("pending");
  const [counts, setCounts] = useState<Counts | null>(null);
  const onCounts = useCallback((c: Counts) => setCounts(c), []);
  return (
    <div>
      <PageHeader title="Reviews" sub="Check new and reported reviews, customer photos and videos, and set who can review. Ratings recalculate at once." />
      <Tabs value={tab} onChange={setTab} items={[
        { value: "pending", label: QUEUES.pending.label, count: counts?.pending },
        { value: "reported", label: QUEUES.reported.label, count: counts?.reported },
        { value: "media", label: QUEUES.media.label, count: counts?.media_pending },
        { value: "published", label: QUEUES.published.label, count: counts?.published },
        { value: "hidden", label: QUEUES.hidden.label, count: counts?.hidden },
        { value: "settings", label: "Settings" },
      ]} />
      {tab === "settings" ? <SettingsForm /> : <Moderation key={tab} queue={tab} onCounts={onCounts} />}
    </div>
  );
}
