"use client";

import clsx from "clsx";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, PageLoader, Pagination, Textarea, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Rep = {
  id: string; product_id: string; product: string; slug: string; reason: string; reason_label: string; note: string; url: string; status: string;
  admin_note: string; seller_note: string; at: string;
};

export default function SellerProductReports() {
  const toast = useToast();
  const [status, setStatus] = useState("open");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ items: Rep[]; total: number; open: number } | null>(null);
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<{ items: Rep[]; total: number; open: number }>("/api/seller/product-reports", { query: { status: status || undefined, page } }), setD), [status, page, track]);
  useEffect(() => { load(); }, [load]);

  async function respond(r: Rep) {
    try {
      await api(`/api/seller/product-reports/${r.id}/respond`, { method: "POST", body: { note: answer[r.id] ?? "" } });
      toast("Your answer was sent to the marketplace team");
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not send", "error");
    }
  }

  return (
    <div>
      <PageHeader title="Customer reports" sub="Shoppers can report a problem with a listing from the product page. You see what was reported (not who). Fix the listing and tell the team what you changed." />
      <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[
        { value: "open", label: "Open", count: d?.open }, { value: "resolved", label: "Resolved" }, { value: "dismissed", label: "Dismissed" }, { value: "", label: "All" },
      ]} />
      {!d ? <PageLoader /> : d.items.length === 0 ? <EmptyState title="No reports" body="Good news: no customer has reported a problem here." /> : (
        <div className="flex flex-col gap-3">
          {d.items.map((r) => (
            <section key={r.id} className="rounded-xl bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={clsx("rounded-full px-2 py-0.5 text-xs font-semibold", ["counterfeit", "unsafe", "prohibited"].includes(r.reason) ? "bg-vermilion-light text-vermilion" : "bg-marigold-light text-ink")}>{r.reason_label}</span>
                <Link href={`/seller/products/${r.product_id}`} className="font-semibold hover:text-peacock">{r.product}</Link>
                <span className="ml-auto text-xs text-ink-faint">{dateTime(r.at)} · {r.status}</span>
              </div>
              {r.note && <p className="mt-2 whitespace-pre-line">{r.note}</p>}
              {r.url && <p className="mt-1 text-sm">Seen at: <span className="break-all">{r.url}</span></p>}
              {r.admin_note && <p className="mt-2 rounded-lg bg-peacock-light p-2 text-sm"><span className="font-semibold">Marketplace team:</span> {r.admin_note}</p>}
              {r.seller_note && <p className="mt-2 rounded-lg bg-mist p-2 text-sm"><span className="font-semibold">Your answer:</span> {r.seller_note}</p>}
              {r.status === "open" && (
                <div className="mt-3 flex flex-col gap-2">
                  <Textarea rows={2} maxLength={2000} placeholder="What did you check or change? e.g. Corrected the net quantity on the listing" aria-label="Your answer"
                    value={answer[r.id] ?? ""} onChange={(e) => setAnswer({ ...answer, [r.id]: e.target.value })} />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => respond(r)} disabled={(answer[r.id] ?? "").trim().length < 2}>{r.seller_note ? "Update answer" : "Send answer"}</Button>
                    <Link href={`/seller/products/${r.product_id}`} className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-semibold text-peacock hover:bg-peacock-light">Edit the listing</Link>
                  </div>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
      {d && <Pagination page={page} pageSize={20} total={d.total} onPage={setPage} />}
    </div>
  );
}
