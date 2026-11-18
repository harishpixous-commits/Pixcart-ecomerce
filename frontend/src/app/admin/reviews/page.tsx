"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Stars } from "@/components/reviews";
import { Button, EmptyState, Input, PageLoader, Pagination, useToast } from "@/components/ui";
import { api, latestOnly } from "@/lib/api";
import { date } from "@/lib/format";

type R = { id: string; product: string; author: string; rating: number; title: string; body: string; status: string; at: string };

export default function AdminReviews() {
  const toast = useToast();
  const [status, setStatus] = useState("published");
  const [rating, setRating] = useState("");
  const [items, setItems] = useState<R[] | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<{ items: R[]; total: number }>("/api/admin/reviews", { query: { status, rating: rating || undefined, q, page } }), (r) => { setItems(r.items); setTotal(r.total); }), [status, rating, q, page, track]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  async function act(r: R, action: "publish" | "hide") {
    await api(`/api/admin/reviews/${r.id}/${action}`, { method: "POST" });
    toast(action === "publish" ? "Review published" : "Review hidden");
    load();
  }
  return (
    <div>
      <PageHeader title="Reviews" sub="Hide reviews that are abusive, off-topic, contain personal details or are paid for. Ratings recalculate at once." />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[{ value: "published", label: "Published" }, { value: "hidden", label: "Hidden or waiting" }]} />
        <div className="mb-3 flex gap-1">
          {["", "1", "2", "3", "4", "5"].map((r) => (
            <button key={r} onClick={() => { setRating(r); setPage(1); }} className={`rounded-full px-3 py-1 text-sm ${rating === r ? "bg-peacock text-white" : "bg-white"}`}>{r ? `${r}★` : "All"}</button>
          ))}
        </div>
      </div>
      <Input placeholder="Product or review text" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search reviews" />
      {!items ? <PageLoader /> : items.length === 0 ? <EmptyState title="No reviews here" /> : (
        <div className="flex flex-col gap-3">
          {items.map((r) => (
            <section key={r.id} className="rounded-xl bg-white p-4">
              <div className="flex flex-wrap items-center gap-2"><Stars value={r.rating} /><p className="font-semibold">{r.title}</p></div>
              <p className="text-sm text-ink-faint">{r.author || "Customer"} on {r.product}, {date(r.at)}</p>
              <p className="mt-1">{r.body}</p>
              <div className="mt-2">
                {r.status === "published" ? <Button size="sm" variant="danger" onClick={() => act(r, "hide")}>Hide</Button> : <Button size="sm" onClick={() => act(r, "publish")}>Publish</Button>}
              </div>
            </section>
          ))}
        </div>
      )}
      {items && <Pagination page={page} pageSize={30} total={total} onPage={setPage} />}
    </div>
  );
}
