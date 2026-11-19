"use client";

import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DealItem, type DealRow, type DealRules } from "@/components/deal-list";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { SettingsBlock } from "@/components/settings-block";
import { Button, EmptyState, ErrorNote, Input, Modal, PageLoader, Pagination, Textarea, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError, latestOnly } from "@/lib/api";

type Data = { items: DealRow[]; total: number; page: number; page_size: number; counts: Record<string, number>; rules: DealRules };
type Act = { d: DealRow; action: "approve" | "reject" | "cancel" };

const RULE_FIELDS = [
  { k: "feature_deals", kind: "bool" as const, label: "Deals are on", hint: "Sellers can create deals and shoppers see Today's Deals, deal badges and countdowns. Off ends running deals at their next check." },
  { k: "deals_need_approval", kind: "bool" as const, label: "Check every deal before it starts", hint: "New deals wait here for approval. Off: deals start on time without a check." },
  { k: "deal_min_discount_pct", kind: "int" as const, label: "Minimum discount (%)", hint: "Below the seller's current selling price. 1 to 90.", min: 1, max: 90 },
  { k: "deal_max_hours_lightning", kind: "int" as const, label: "Lightning deal: longest (hours)", hint: "1 to 24", min: 1, max: 24 },
  { k: "deal_max_hours_day", kind: "int" as const, label: "Deal of the Day: longest (hours)", hint: "1 to 48", min: 1, max: 48 },
  { k: "deal_max_days_limited", kind: "int" as const, label: "Limited time deal: longest (days)", hint: "1 to 60", min: 1, max: 60 },
];

export default function AdminDeals() {
  const toast = useToast();
  const canSettings = useCan("settings");
  const [tab, setTab] = useState("pending");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [act, setAct] = useState<Act | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => {
    if (tab === "rules") return;
    track(api<Data>("/api/admin/deals", { query: { status: tab, q: query || undefined, page } }), (x) => { setD(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load deals"));
  }, [tab, query, page, track]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function run(a: Act, why: string) {
    setBusy(a.d.id + a.action);
    try {
      await api(`/api/admin/deals/${a.d.id}/${a.action}`, { method: "POST", body: { reason: why } });
      toast(a.action === "approve" ? "Deal approved. The seller was told." : a.action === "reject" ? "Deal rejected. The seller was told why." : "Deal stopped. The price is back to normal.");
      setAct(null);
      setReason("");
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not update the deal", "error");
    } finally {
      setBusy(null);
    }
  }

  const counts = d?.counts ?? {};
  const all = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader title="Deals" sub="Lightning deals, Deal of the Day and Limited time deals proposed by sellers. Approve them before they start, or stop a running deal." />
      <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} items={[
        { value: "pending", label: "Waiting for approval", count: counts.pending ?? 0 },
        { value: "active", label: "Running", count: counts.active ?? 0 },
        { value: "approved", label: "Scheduled", count: counts.approved ?? 0 },
        { value: "ended", label: "Ended", count: counts.ended ?? 0 },
        { value: "rejected", label: "Rejected", count: counts.rejected ?? 0 },
        { value: "cancelled", label: "Cancelled", count: counts.cancelled ?? 0 },
        { value: "all", label: "All", count: all },
        ...(canSettings ? [{ value: "rules", label: "Rules" }] : []),
      ]} />
      {tab === "rules" ? (
        <SettingsBlock title="Deal rules" sub="What sellers may offer. Shoppers see deals in Today's Deals, on product cards and on product pages." fields={RULE_FIELDS} saveLabel="Save deal rules" />
      ) : (
        <>
          <div className="relative mb-3 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by product or seller" aria-label="Search deals" className="pl-9" />
          </div>
          <ErrorNote message={error} />
          {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? (
            <EmptyState title={tab === "pending" ? "Nothing waiting" : "No deals here"} body={tab === "pending" ? "New deals from sellers show up here for approval." : undefined} />
          ) : (
            <div className="flex flex-col gap-3">
              {d.items.map((x) => (
                <DealItem key={x.id} d={x} showSeller actions={
                  x.status === "pending" ? (
                    <>
                      <Button size="sm" loading={busy === x.id + "approve"} onClick={() => run({ d: x, action: "approve" }, "")}>Approve</Button>
                      <Button size="sm" variant="danger" onClick={() => { setReason(""); setAct({ d: x, action: "reject" }); }}>Reject</Button>
                    </>
                  ) : x.status === "approved" || x.status === "active" ? (
                    <Button size="sm" variant="danger" onClick={() => { setReason(""); setAct({ d: x, action: "cancel" }); }}>{x.status === "active" ? "Stop deal" : "Cancel deal"}</Button>
                  ) : undefined
                } />
              ))}
            </div>
          )}
          {d && <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />}
        </>
      )}

      <Modal open={act !== null} onClose={() => setAct(null)} title={act?.action === "reject" ? "Reject this deal" : "Stop this deal"}>
        {act && (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); run(act, reason.trim()); }}>
            <p className="text-sm text-ink-soft"><b className="text-ink">{act.d.product}</b> from {act.d.seller}. The seller sees your reason.</p>
            <Textarea rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason"
              placeholder={act.action === "reject" ? "e.g. The M.R.P. was raised just before the deal" : "e.g. Pricing complaint from customers"} autoFocus />
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={busy === act.d.id + act.action} disabled={reason.trim().length < 5}>{act.action === "reject" ? "Reject deal" : "Stop deal"}</Button>
              <Button type="button" variant="ghost" onClick={() => setAct(null)}>Back</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
