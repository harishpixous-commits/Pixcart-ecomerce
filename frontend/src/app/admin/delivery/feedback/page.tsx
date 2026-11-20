"use client";

/* Admin → Delivery → Ratings and complaints: what customers said about their delivery partners. Resolve a complaint
 * with a note for the record. */

import clsx from "clsx";
import { CheckCircle2, MessageSquareWarning, Star } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Modal, PageLoader, Pagination, Pill, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Complaint = { id: string; assignment_id: string; partner: string; order_number: string; category: string; category_label: string; text: string;
  status: "open" | "resolved"; admin_note: string; at: string };
type Rating = { assignment_id: string; partner: string; order_number: string; rating: number; comment: string; at: string | null };
type Page<T> = { items: T[]; total: number; page: number; page_size: number; open?: number };

function FeedbackPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = (["open", "resolved", "ratings"].includes(sp.get("tab") ?? "") ? sp.get("tab") : "open") as "open" | "resolved" | "ratings";
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ key: string; complaints?: Page<Complaint>; ratings?: Page<Rating> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Complaint | null>(null);
  const key = `${tab}:${page}`;

  const load = useCallback(() => {
    const k = `${tab}:${page}`;
    const req = tab === "ratings"
      ? api<Page<Rating>>("/api/admin/delivery/feedback", { query: { kind: "ratings", page } }).then((r) => setData({ key: k, ratings: r }))
      : api<Page<Complaint>>("/api/admin/delivery/feedback", { query: { kind: "complaints", status: tab, page } }).then((r) => setData({ key: k, complaints: r }));
    req.then(() => setError(null)).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load feedback"));
  }, [tab, page]);
  useEffect(() => { load(); }, [load]);

  const shown = data?.key === key ? data : null;
  return (
    <div>
      <PageHeader title="Ratings and complaints" sub="What customers said about their delivery. Complaints need a decision; ratings feed each partner's score." />
      <Tabs value={tab} onChange={(v) => { setPage(1); router.replace(`/admin/delivery/feedback?tab=${v}`); }} items={[
        { value: "open", label: "Open complaints", count: tab === "open" ? shown?.complaints?.total : undefined },
        { value: "resolved", label: "Resolved" },
        { value: "ratings", label: "Ratings" },
      ]} />
      <ErrorNote message={error} />
      {!shown ? (error ? null : <PageLoader />) : tab === "ratings" ? (
        !shown.ratings?.items.length ? <EmptyState title="No ratings yet" body="Customers rate the delivery on their order page after it arrives." /> : (
          <ul className="flex flex-col gap-2">
            {shown.ratings.items.map((r) => (
              <li key={r.assignment_id} className="flex flex-col gap-1 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="flex" aria-label={`${r.rating} of 5`}>{[1, 2, 3, 4, 5].map((n) => <Star key={n} className={clsx("h-4 w-4", n <= r.rating ? "fill-marigold text-marigold" : "text-line")} aria-hidden />)}</span>
                  <span className="font-semibold">{r.partner}</span>
                  <Link href={`/admin/delivery/trips/${r.assignment_id}`} className="text-sm font-semibold text-peacock">{r.order_number}</Link>
                  <span className="text-xs text-ink-faint">{dateTime(r.at)}</span>
                </p>
                {r.comment && <p className="text-sm text-ink-soft">“{r.comment}”</p>}
              </li>
            ))}
          </ul>
        )
      ) : !shown.complaints?.items.length ? (
        <EmptyState title={tab === "open" ? "No open complaints" : "No resolved complaints yet"} body={tab === "open" ? "Customers can report a delivery problem from their order page." : undefined} />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="complaints">
          {shown.complaints.items.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:flex-row sm:items-start">
              <span className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", c.status === "open" ? "bg-vermilion-light text-vermilion" : "bg-leaf-light text-leaf")}>
                {c.status === "open" ? <MessageSquareWarning className="h-5 w-5" aria-hidden /> : <CheckCircle2 className="h-5 w-5" aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.category_label}</span>
                  <Pill tone={c.status === "open" ? "red" : "green"}>{c.status === "open" ? "Open" : "Resolved"}</Pill>
                </p>
                <p className="text-sm text-ink-soft">
                  Partner <b>{c.partner}</b> · <Link href={`/admin/delivery/trips/${c.assignment_id}`} className="font-semibold text-peacock">{c.order_number}</Link> · {dateTime(c.at)}
                </p>
                {c.text && <p className="mt-1 text-sm">“{c.text}”</p>}
                {c.admin_note && <p className="mt-1 rounded-lg bg-mist px-2 py-1 text-sm"><b>Resolution:</b> {c.admin_note}</p>}
              </div>
              {c.status === "open" && <Button size="sm" onClick={() => setResolving(c)}>Resolve</Button>}
            </li>
          ))}
        </ul>
      )}
      {shown && (shown.complaints || shown.ratings) && (
        <Pagination page={page} pageSize={(shown.complaints ?? shown.ratings)!.page_size} total={(shown.complaints ?? shown.ratings)!.total} onPage={setPage} />
      )}
      <Resolve complaint={resolving} onClose={() => setResolving(null)} onDone={() => { setResolving(null); load(); }} />
    </div>
  );
}

function Resolve({ complaint, onClose, onDone }: { complaint: Complaint | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!complaint) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/delivery/complaints/${complaint.id}/resolve`, { method: "POST", body: { note: note.trim() } });
      toast("Complaint resolved");
      setNote("");
      onDone();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not resolve");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!complaint} onClose={onClose} title="Resolve complaint">
      <form onSubmit={submit} className="flex flex-col gap-3">
        {complaint && <p className="text-sm text-ink-soft">{complaint.category_label} about {complaint.partner}, order {complaint.order_number}.</p>}
        <ErrorNote message={error} />
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} required minLength={3} maxLength={500} placeholder="What was done (e.g. spoke to the partner, refunded the customer)" aria-label="Resolution note" />
        <Button type="submit" loading={busy} disabled={note.trim().length < 3} className="self-start">Mark resolved</Button>
      </form>
    </Modal>
  );
}

export default function PageWrap() {
  return <Suspense fallback={<PageLoader />}><FeedbackPage /></Suspense>;
}
