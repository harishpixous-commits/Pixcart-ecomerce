"use client";

/*
 * Questions and answers on the product page. Anyone can read; signed-in shoppers ask, answer, vote "helpful" and report.
 * The seller's answer comes first; verified buyers are marked. Switched on or off in Admin → Product page.
 */

import clsx from "clsx";
import { BadgeCheck, Flag, MessageCircleQuestion, Search, Store, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button, Select, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date } from "@/lib/format";
import { useSession } from "@/lib/session";

type Answer = { id: string; text: string; author: string; role: "seller" | "buyer" | "customer" | "staff"; role_label: string; helpful_count: number; voted: boolean; created_at: string };
type Question = { id: string; text: string; author: string; created_at: string; answer_count: number; answers: Answer[] };
type QA = { enabled: boolean; items: Question[]; total: number; page: number; has_more: boolean; can_ask?: boolean; buyers_answer_only?: boolean };

function AnswerForm({ qid, onDone }: { qid: string; onDone: (pending: boolean) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (text.trim().length < 2) return setError("Write a short answer");
    setBusy(true);
    setError("");
    try {
      const r = await api<{ status: string }>(`/api/questions/${qid}/answers`, { method: "POST", body: { text } });
      setText("");
      onDone(r.status === "pending");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not post your answer");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send} className="mt-2 flex flex-col gap-2">
      <Textarea rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Share what you know about this product" aria-label="Your answer" />
      {error && <p className="text-sm text-vermilion">{error}</p>}
      <Button type="submit" size="sm" loading={busy} className="self-start">Post answer</Button>
    </form>
  );
}

export function ProductQuestions({ slug, title }: { slug: string; title: string }) {
  const { user } = useSession();
  const pathname = usePathname();
  const toast = useToast();
  const [data, setData] = useState<QA | null>(null);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"helpful" | "recent">("helpful");
  const [page, setPage] = useState(1);
  const [asking, setAsking] = useState("");
  const [askError, setAskError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);

  const load = useCallback(() => api<QA>(`/api/catalog/products/${slug}/questions`, { query: { q: query || undefined, sort, page } })
    .then((d) => setData((prev) => (page > 1 && prev ? { ...d, items: [...prev.items, ...d.items] } : d))).catch(() => {}), [slug, query, sort, page]);
  useEffect(() => { load(); }, [load, user]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (asking.trim().length < 10) return setAskError("Questions are at least 10 characters");
    setBusy(true);
    setAskError("");
    try {
      const r = await api<{ status: string }>(`/api/catalog/products/${slug}/questions`, { method: "POST", body: { text: asking } });
      setAsking("");
      toast(r.status === "pending" ? "Thanks! Your question will appear after a quick check." : "Your question is posted. We will tell you when someone answers.");
      setPage(1);
      load();
    } catch (x) {
      setAskError(x instanceof ApiError ? x.message : "Could not post your question");
    } finally {
      setBusy(false);
    }
  }
  async function vote(a: Answer) {
    try {
      const r = await api<{ voted: boolean; helpful_count: number }>(`/api/answers/${a.id}/helpful`, { method: "POST" });
      setData((d) => d && { ...d, items: d.items.map((x) => ({ ...x, answers: x.answers.map((y) => (y.id === a.id ? { ...y, voted: r.voted, helpful_count: r.helpful_count } : y)) })) });
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not record your vote", "error");
    }
  }
  async function report(kind: "question" | "answer", id: string) {
    try {
      await api("/api/qa/report", { method: "POST", body: { kind, id } });
      toast("Thanks. Our team will check it.");
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not report", "error");
    }
  }

  if (!data || !data.enabled) return null;
  const login = `/login?next=${encodeURIComponent(`${pathname}#questions`)}`;
  return (
    <section id="questions" className="scroll-mt-40 rounded-xl bg-white p-4 sm:p-6" aria-labelledby="qa-h" data-testid="questions">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="qa-h" className="text-2xl font-semibold">Questions and answers</h2>
          <p className="text-sm text-ink-soft">{data.total ? `${data.total} question${data.total === 1 ? "" : "s"} about this product` : "Have a question? Ask the seller and buyers."}</p>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q.trim()); }} className="flex w-full max-w-sm items-center gap-2 sm:w-auto">
          <label htmlFor="qa-search" className="sr-only">Search questions</label>
          <span className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-ink-faint" />
            <input id="qa-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions and answers" className="h-9 w-full rounded-lg border border-line pl-8 pr-2 text-sm" />
          </span>
          <Select value={sort} onChange={(e) => { setPage(1); setSort(e.target.value as "helpful" | "recent"); }} className="h-9 w-auto text-sm" aria-label="Sort questions">
            <option value="helpful">Most answered</option>
            <option value="recent">Newest</option>
          </Select>
        </form>
      </div>

      <div className="mb-4 rounded-lg bg-mist p-3">
        {user ? (
          <form onSubmit={ask} className="flex flex-col gap-2">
            <label htmlFor="qa-ask" className="flex items-center gap-1.5 font-semibold"><MessageCircleQuestion className="h-4 w-4 text-peacock" /> Ask a question about {title.length > 60 ? "this product" : title}</label>
            <Textarea id="qa-ask" rows={2} maxLength={500} value={asking} onChange={(e) => setAsking(e.target.value)} placeholder="e.g. Is it suitable for daily use? What is the warranty?" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-ink-faint">The seller and customers who bought it can answer. Please do not share phone numbers or links.</p>
              <Button type="submit" size="sm" loading={busy}>Post question</Button>
            </div>
            {askError && <p className="text-sm text-vermilion">{askError}</p>}
          </form>
        ) : (
          <p className="text-sm"><Link href={login} className="font-semibold text-peacock">Sign in</Link> to ask a question or answer one.</p>
        )}
      </div>

      {data.items.length === 0 ? (
        <p className="text-ink-soft">{query ? `No questions mention "${query}".` : "No questions yet. Be the first to ask."}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {data.items.map((qn) => (
            <li key={qn.id} className="py-4 first:pt-0" data-testid="question">
              <p className="flex gap-2"><span className="font-semibold text-peacock">Q:</span><span className="font-semibold">{qn.text}</span></p>
              <p className="ml-6 text-xs text-ink-faint">Asked by {qn.author} on {date(qn.created_at)}</p>
              <div className="ml-6 mt-2 flex flex-col gap-3">
                {qn.answers.map((a) => (
                  <div key={a.id} className="flex gap-2">
                    <span className="font-semibold text-leaf">A:</span>
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-line text-ink-soft">{a.text}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                        <span className={clsx("inline-flex items-center gap-1 font-semibold", a.role === "seller" ? "text-peacock" : a.role === "buyer" ? "text-leaf" : "")}>
                          {a.role === "seller" ? <Store className="h-3.5 w-3.5" /> : a.role === "buyer" ? <BadgeCheck className="h-3.5 w-3.5" /> : null}
                          {a.author} · {a.role_label}
                        </span>
                        <span>{date(a.created_at)}</span>
                        {user ? (
                          <button type="button" onClick={() => vote(a)} aria-pressed={a.voted} className={clsx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 ring-1", a.voted ? "bg-peacock text-white ring-peacock" : "ring-line hover:bg-mist")}>
                            <ThumbsUp className="h-3 w-3" /> Helpful{a.helpful_count ? ` (${a.helpful_count})` : ""}
                          </button>
                        ) : a.helpful_count > 0 ? <span>{a.helpful_count} found this helpful</span> : null}
                        {user && <button type="button" onClick={() => report("answer", a.id)} className="inline-flex items-center gap-1 hover:text-vermilion"><Flag className="h-3 w-3" /> Report</button>}
                      </p>
                    </div>
                  </div>
                ))}
                {qn.answers.length === 0 && <p className="text-sm text-ink-faint">No answers yet.</p>}
                <div className="flex flex-wrap gap-3 text-sm">
                  {user ? (
                    answering === qn.id ? null : <button type="button" onClick={() => setAnswering(qn.id)} className="font-semibold text-peacock hover:underline">Answer this question</button>
                  ) : <Link href={login} className="font-semibold text-peacock hover:underline">Sign in to answer</Link>}
                  {user && <button type="button" onClick={() => report("question", qn.id)} className="inline-flex items-center gap-1 text-ink-faint hover:text-vermilion"><Flag className="h-3.5 w-3.5" /> Report question</button>}
                </div>
                {answering === qn.id && (
                  <AnswerForm qid={qn.id} onDone={(pending) => { setAnswering(null); toast(pending ? "Thanks! Your answer will appear after a quick check." : "Your answer is posted."); load(); }} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.has_more && <Button variant="secondary" onClick={() => setPage((p) => p + 1)} className="mt-3">See more questions</Button>}
      {data.buyers_answer_only && <p className="mt-3 text-xs text-ink-faint">Only the seller and customers who bought this product can answer.</p>}
    </section>
  );
}
