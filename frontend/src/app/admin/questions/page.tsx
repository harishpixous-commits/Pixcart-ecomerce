"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Input, PageLoader, Pagination, Pill, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError, latestOnly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Post = {
  kind: "question" | "answer"; id: string; text: string; product: string; slug: string; author: string; role: string; report_count: number;
  created_at: string; question: string;
};
type Data = { items: Post[]; total: number; page: number; page_size: number; counts: Record<string, number> };

const ROLE: Record<string, string> = { seller: "Seller", buyer: "Verified buyer", customer: "Customer", staff: "Store team" };

export default function AdminQuestions() {
  const toast = useToast();
  const canSettings = useCan("settings");
  const [tab, setTab] = useState<"pending" | "published" | "hidden">("pending");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => {
    track(api<Data>("/api/admin/questions", { query: { status: tab, q: query || undefined, page } }), (x) => { setD(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load questions"));
  }, [tab, query, page, track]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function act(p: Post, action: "publish" | "hide") {
    setBusy(p.id + action);
    try {
      await api(`/api/admin/questions/${p.kind}/${p.id}/${action}`, { method: "POST" });
      toast(action === "publish" ? `${p.kind === "question" ? "Question" : "Answer"} published` : `${p.kind === "question" ? "Question" : "Answer"} hidden`);
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not update", "error");
    } finally {
      setBusy(null);
    }
  }

  const c = d?.counts ?? {};
  return (
    <div>
      <PageHeader title="Questions and answers" sub="Posts waiting for a check (contact details, reports or the check-every-post switch), and every published or hidden post."
        actions={canSettings ? <Link href="/admin/product-page#qa" className="inline-flex h-10 items-center rounded-lg px-4 font-semibold text-peacock ring-1 ring-inset ring-peacock/40 hover:bg-peacock-light">Q&amp;A settings</Link> : undefined} />
      <Tabs value={tab} onChange={(v) => { setTab(v as typeof tab); setPage(1); }} items={[
        { value: "pending", label: "Waiting for a check", count: c.pending ?? 0 }, { value: "published", label: "Published", count: c.published ?? 0 }, { value: "hidden", label: "Hidden", count: c.hidden ?? 0 },
      ]} />
      <div className="relative mb-3 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the text or product" aria-label="Search questions and answers" className="pl-9" />
      </div>
      <ErrorNote message={error} />
      {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? (
        <EmptyState title={tab === "pending" ? "Nothing waiting" : "Nothing here"} body={tab === "pending" ? "Questions and answers that need a check show up here." : undefined} />
      ) : (
        <div className="flex flex-col gap-3">
          {d.items.map((p) => (
            <section key={p.kind + p.id} className="rounded-xl bg-white p-4" data-testid="qa-post">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Pill tone={p.kind === "question" ? "blue" : "gray"}>{p.kind === "question" ? "Question" : "Answer"}</Pill>
                {p.report_count > 0 && <Pill tone="red">{p.report_count} report{p.report_count === 1 ? "" : "s"}</Pill>}
                <a href={`/p/${p.slug}#questions`} target="_blank" rel="noreferrer" className="font-semibold hover:text-peacock">{p.product}</a>
                <span className="ml-auto text-xs text-ink-faint">{dateTime(p.created_at)}</span>
              </div>
              {p.kind === "answer" && p.question && <p className="mt-2 text-sm text-ink-soft">Q: {p.question}</p>}
              <p className="mt-1.5 whitespace-pre-line">{p.text}</p>
              <p className="mt-1 text-xs text-ink-faint">{p.author} · {ROLE[p.role] ?? p.role}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {tab !== "published" && <Button size="sm" loading={busy === p.id + "publish"} onClick={() => act(p, "publish")}>Publish</Button>}
                {tab !== "hidden" && <Button size="sm" variant="danger" loading={busy === p.id + "hide"} onClick={() => act(p, "hide")}>Hide</Button>}
              </div>
            </section>
          ))}
        </div>
      )}
      {d && <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />}
    </div>
  );
}
