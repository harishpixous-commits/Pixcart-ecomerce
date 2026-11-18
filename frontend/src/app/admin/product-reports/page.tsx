"use client";

import clsx from "clsx";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, Input, Modal, PageLoader, Pagination, Select, Textarea, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Rep = {
  id: string; product_id: string; product: string; slug: string; product_status: string; seller: string; seller_id: string; customer: string; phone: string;
  reason: string; reason_label: string; note: string; url: string; status: string; admin_note: string; seller_note: string; open_for_product: number;
  at: string; resolved_at: string | null;
};
type Res = { items: Rep[]; total: number; reasons: Record<string, string>; counts: Record<string, number> };

export default function ProductReports() {
  const toast = useToast();
  const [status, setStatus] = useState("open");
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Res | null>(null);
  const [acting, setActing] = useState<Rep | null>(null);
  const [form, setForm] = useState({ status: "resolved" as "resolved" | "dismissed", note: "", takeDown: false, notify: true });
  const [busy, setBusy] = useState(false);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<Res>("/api/admin/product-reports", { query: { status, reason: reason || undefined, q, page } }), setData), [status, reason, q, page, track]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  async function resolve(e: React.FormEvent) {
    e.preventDefault();
    if (!acting) return;
    setBusy(true);
    try {
      const r = await api<{ product_status: string }>(`/api/admin/product-reports/${acting.id}`, {
        method: "POST", body: { status: form.status, admin_note: form.note, take_down: form.takeDown, notify_seller: form.notify },
      });
      toast(form.takeDown && r.product_status === "rejected" ? "Report resolved and the listing taken down" : form.status === "resolved" ? "Report resolved" : "Report dismissed");
      setActing(null);
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not update", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Product reports" sub="Customers report wrong information, fakes, unsafe or banned items and misleading prices from the product page. Sellers see each report without the customer's details and can answer." />
      <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[
        { value: "open", label: "Open", count: data?.counts.open },
        { value: "resolved", label: "Resolved", count: data?.counts.resolved },
        { value: "dismissed", label: "Dismissed", count: data?.counts.dismissed },
      ]} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="Product, seller or details" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" aria-label="Search reports" />
        <Select value={reason} onChange={(e) => { setReason(e.target.value); setPage(1); }} className="w-auto" aria-label="Reason">
          <option value="">Every reason</option>
          {Object.entries(data?.reasons ?? {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      {!data ? <PageLoader /> : data.items.length === 0 ? <EmptyState title={status === "open" ? "No open reports" : "Nothing here"} body="Reports appear here as customers send them." /> : (
        <div className="flex flex-col gap-3">
          {data.items.map((r) => (
            <section key={r.id} className="rounded-xl bg-white p-4" data-testid="product-report">
              <div className="flex flex-wrap items-center gap-2">
                <span className={clsx("rounded-full px-2 py-0.5 text-xs font-semibold", ["counterfeit", "unsafe", "prohibited"].includes(r.reason) ? "bg-vermilion-light text-vermilion" : "bg-marigold-light text-ink")}>{r.reason_label}</span>
                <Link href={`/admin/products/${r.product_id}`} className="font-semibold hover:text-peacock">{r.product}</Link>
                <a href={`/p/${r.slug}`} target="_blank" rel="noopener noreferrer" className="text-ink-faint hover:text-peacock" aria-label="Open the product page"><ExternalLink className="h-4 w-4" /></a>
                <span className="text-xs text-ink-faint">listing {r.product_status}</span>
                {r.open_for_product > 1 && <span className="rounded-full bg-vermilion px-2 py-0.5 text-xs font-semibold text-white">{r.open_for_product} open reports on this listing</span>}
              </div>
              <p className="mt-0.5 text-sm text-ink-faint">
                Seller <Link href={`/admin/sellers/${r.seller_id}`} className="text-peacock hover:underline">{r.seller}</Link> · reported by {r.customer}{r.phone ? ` (${r.phone})` : ""} · {dateTime(r.at)}
              </p>
              {r.note && <p className="mt-2 whitespace-pre-line">{r.note}</p>}
              {r.url && <p className="mt-1 text-sm">Seen at: <a href={r.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-peacock hover:underline">{r.url}</a></p>}
              {r.seller_note && <p className="mt-2 rounded-lg bg-mist p-2 text-sm"><span className="font-semibold">Seller&apos;s answer:</span> {r.seller_note}</p>}
              {r.admin_note && <p className="mt-2 rounded-lg bg-peacock-light p-2 text-sm"><span className="font-semibold">Staff note:</span> {r.admin_note}</p>}
              {r.status === "open" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => { setActing(r); setForm({ status: "resolved", note: "", takeDown: false, notify: true }); }}>Resolve</Button>
                  <Button size="sm" variant="danger" disabled={r.product_status !== "approved"} onClick={() => { setActing(r); setForm({ status: "resolved", note: "", takeDown: true, notify: true }); }}>Take listing down</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setActing(r); setForm({ status: "dismissed", note: "", takeDown: false, notify: false }); }}>Dismiss</Button>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
      {data && <Pagination page={page} pageSize={30} total={data.total} onPage={setPage} />}
      <Modal open={acting !== null} onClose={() => setActing(null)} title={form.status === "dismissed" ? "Dismiss this report" : form.takeDown ? "Take the listing down" : "Resolve this report"}>
        <form onSubmit={resolve} className="flex flex-col gap-3">
          <p className="text-sm text-ink-soft">{acting?.product} · {acting?.reason_label}</p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Note {form.takeDown ? "(the seller sees this as the reason)" : "(optional)"}</span>
            <Textarea rows={3} maxLength={2000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={form.takeDown ? "e.g. The brand confirmed these are not genuine" : "What was done"} />
          </label>
          {form.status === "resolved" && (
            <>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-peacock" checked={form.takeDown} disabled={acting?.product_status !== "approved"} onChange={(e) => setForm({ ...form, takeDown: e.target.checked })} /> Take the listing off the store</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-peacock" checked={form.notify || form.takeDown} disabled={form.takeDown} onChange={(e) => setForm({ ...form, notify: e.target.checked })} /> Tell the seller</label>
            </>
          )}
          <Button type="submit" loading={busy} variant={form.takeDown ? "danger" : "primary"} className="self-start">{form.status === "dismissed" ? "Dismiss" : form.takeDown ? "Take down and resolve" : "Resolve"}</Button>
        </form>
      </Modal>
    </div>
  );
}
