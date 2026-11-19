"use client";

import clsx from "clsx";
import { MessageCircleQuestion, Store } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, PageLoader, Pagination, Pill, Textarea, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Answer = { id: string; text: string; role: string; role_label: string; status: string; created_at: string };
type Question = { id: string; text: string; product: string; slug: string; created_at: string; answers: Answer[]; answered_by_you: boolean };
type Data = { items: Question[]; total: number; page: number; unanswered: number };

export default function SellerQuestions() {
  const toast = useToast();
  const [tab, setTab] = useState("waiting");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => {
    track(api<Data>("/api/seller/questions", { query: { unanswered: tab === "waiting" ? "true" : undefined, page } }), (x) => { setD(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load questions"));
  }, [tab, page, track]);
  useEffect(() => { load(); }, [load]);

  async function send(q: Question) {
    const text = (draft[q.id] ?? "").trim();
    if (text.length < 2) return;
    setBusy(q.id);
    try {
      const out = await api<{ status: string }>(`/api/seller/questions/${q.id}/answer`, { method: "POST", body: { text } });
      toast(out.status === "pending" ? "Answer sent. It appears after a quick check." : "Answer posted on the product page");
      setDraft({ ...draft, [q.id]: "" });
      setOpen({ ...open, [q.id]: false });
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not post the answer", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="Customer questions" sub="Questions shoppers ask on your product pages. Your answer shows first, marked as the seller's. Answer quickly: unanswered questions cost sales." />
      <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} items={[
        { value: "waiting", label: "Waiting for your answer", count: d?.unanswered }, { value: "all", label: "All questions" },
      ]} />
      <ErrorNote message={error} />
      {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? (
        <EmptyState title={tab === "waiting" ? "All caught up" : "No questions yet"} body={tab === "waiting" ? "Every question on your products has your answer." : "When shoppers ask about your products, the questions show up here."} />
      ) : (
        <div className="flex flex-col gap-3">
          {d.items.map((q) => {
            const writing = !q.answered_by_you || open[q.id];
            return (
              <section key={q.id} className="rounded-xl bg-white p-4" data-testid="seller-question">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <a href={`/p/${q.slug}#questions`} target="_blank" rel="noreferrer" className="font-semibold text-peacock hover:underline">{q.product}</a>
                  <span className="ml-auto text-xs text-ink-faint">{dateTime(q.created_at)}</span>
                </div>
                <p className="mt-2 flex gap-2 font-medium"><MessageCircleQuestion className="mt-0.5 h-5 w-5 shrink-0 text-peacock" aria-hidden /> {q.text}</p>
                {q.answers.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-4">
                    {q.answers.map((a) => (
                      <li key={a.id} className="text-sm">
                        <p className="whitespace-pre-line">{a.text}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
                          {a.role === "seller" ? <span className="inline-flex items-center gap-1 font-semibold text-peacock"><Store className="h-3.5 w-3.5" aria-hidden /> You</span> : a.role_label}
                          · {dateTime(a.created_at)}
                          {a.status === "pending" && <Pill tone="amber">Being checked</Pill>}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {writing ? (
                  <div className="mt-3 flex flex-col gap-2">
                    <Textarea rows={2} maxLength={1000} value={draft[q.id] ?? ""} onChange={(e) => setDraft({ ...draft, [q.id]: e.target.value })}
                      placeholder="Write a clear, helpful answer. Do not share phone numbers, emails or links." aria-label={`Answer: ${q.text}`} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => send(q)} loading={busy === q.id} disabled={(draft[q.id] ?? "").trim().length < 2}>Post answer</Button>
                      {q.answered_by_you && <Button size="sm" variant="ghost" onClick={() => setOpen({ ...open, [q.id]: false })}>Cancel</Button>}
                      <span className={clsx("ml-auto text-xs", (draft[q.id] ?? "").length > 900 ? "text-vermilion" : "text-ink-faint")}>{(draft[q.id] ?? "").length}/1000</span>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" className="mt-2" onClick={() => setOpen({ ...open, [q.id]: true })}>Add another answer</Button>
                )}
              </section>
            );
          })}
        </div>
      )}
      {d && <Pagination page={page} pageSize={20} total={d.total} onPage={setPage} />}
    </div>
  );
}
