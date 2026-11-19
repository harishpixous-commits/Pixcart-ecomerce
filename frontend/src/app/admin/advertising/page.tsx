"use client";

import clsx from "clsx";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CampaignCard, fillDays, type AdDay, type AdRules, type Campaign } from "@/components/ad-campaigns";
import { DailyBars } from "@/components/charts";
import { PageHeader, Stat, Tabs } from "@/components/portal-shell";
import { SettingsBlock, type SettingField } from "@/components/settings-block";
import { Button, EmptyState, ErrorNote, Input, Modal, PageLoader, Pagination, Textarea, useToast } from "@/components/ui";
import { useCan } from "@/lib/admin";
import { api, ApiError, latestOnly } from "@/lib/api";
import { rupees } from "@/lib/format";

type Data = {
  items: Campaign[]; total: number; page: number; page_size: number; counts: Record<string, number>; rules: AdRules;
  revenue_30d: { impressions: number; clicks: number; spend: number; days: AdDay[] };
};
type Action = "approve" | "reject" | "pause" | "resume" | "end";

const SETTINGS: SettingField[] = [
  { k: "feature_ads", kind: "bool", label: "Sponsored products are on", hint: "Sellers can run campaigns and shoppers see products marked \"Sponsored\". Off stops all ads at once." },
  { k: "ads_need_approval", kind: "bool", label: "Check campaigns before they run", hint: "New campaigns, and changes to their products or keywords, wait here for approval." },
  { k: "ads_search", kind: "bool", label: "Show ads in search results", hint: "At the top of matching results and in a Sponsored row below them." },
  { k: "ads_product", kind: "bool", label: "Show ads on product pages", hint: "A Sponsored row of similar products from the same category." },
  { k: "ads_home", kind: "bool", label: "Show ads on the home page", hint: "In Sponsored sections you add in Storefront." },
  { k: "ads_min_bid_paise", kind: "rupees", label: "Lowest bid per click (₹)", hint: "₹1 to ₹1,000", min: 100, max: 100_000, needs: "feature_ads" },
  { k: "ads_min_daily_budget_paise", kind: "rupees", label: "Lowest daily budget (₹)", hint: "₹10 to ₹1,00,000", min: 1000, max: 10_000_000, needs: "feature_ads" },
  { k: "ads_per_search", kind: "int", label: "Sponsored results at the top of search", hint: "0 to 6 (0 = only the Sponsored row below the results)", min: 0, max: 6, needs: "feature_ads" },
  { k: "ads_per_rail", kind: "int", label: "Products in a Sponsored row", hint: "4 to 20", min: 4, max: 20, needs: "feature_ads" },
];

export default function AdminAdvertising() {
  const toast = useToast();
  const canSettings = useCan("settings");
  const [now] = useState(() => Date.now());
  const [tab, setTab] = useState("pending");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [metric, setMetric] = useState<"spend" | "clicks" | "impressions">("spend");
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [act, setAct] = useState<{ c: Campaign; action: Action } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => {
    if (tab === "settings") return;
    track(api<Data>("/api/admin/ads", { query: { status: tab, q: query || undefined, page } }), (x) => { setD(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load campaigns"));
  }, [tab, query, page, track]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function run(c: Campaign, action: Action, why = "") {
    setBusy(c.id + action);
    try {
      await api(`/api/admin/ads/${c.id}/${action}`, { method: "POST", body: { reason: why } });
      toast({ approve: "Campaign approved", reject: "Campaign rejected", pause: "Campaign paused", resume: "Campaign running again", end: "Campaign ended" }[action] + ". The seller was told.");
      setAct(null);
      setReason("");
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not update the campaign", "error");
    } finally {
      setBusy(null);
    }
  }

  async function billNow() {
    setBusy("bill");
    try {
      const r = await api<{ posted: number }>("/api/admin/ads/bill", { method: "POST" });
      toast(r.posted ? `${r.posted} charge${r.posted === 1 ? "" : "s"} posted to seller accounts` : "Nothing to bill: finished days are already billed");
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not bill", "error");
    } finally {
      setBusy(null);
    }
  }

  const counts = d?.counts ?? {};
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const rev = d?.revenue_30d;
  const series = rev ? fillDays(rev.days, 30) : [];

  return (
    <div>
      <PageHeader title="Advertising" sub="Sponsored products: sellers pay per click to show products in search, on product pages and on the home page. Ad spend plus GST is taken from their payouts."
        actions={<Button variant="secondary" onClick={billNow} loading={busy === "bill"}>Bill finished days now</Button>} />
      {rev && tab !== "settings" && (
        <section className="mb-4 grid gap-3 lg:grid-cols-[1fr_2fr]">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Ad revenue (30 days)" value={rupees(rev.spend)} hint="Before GST" />
            <Stat label="Clicks" value={rev.clicks.toLocaleString("en-IN")} hint={rev.clicks ? `${rupees(Math.round(rev.spend / rev.clicks))} per click on average` : undefined} />
            <Stat label="Impressions" value={rev.impressions.toLocaleString("en-IN")} />
            <Stat label="Click-through rate" value={rev.impressions ? `${Math.round((10000 * rev.clicks) / rev.impressions) / 100}%` : "—"} />
          </div>
          <div className="rounded-xl bg-white p-4">
            <div className="mb-2 flex gap-1 rounded-lg bg-mist p-1 text-sm" role="tablist" aria-label="Chart">
              {(["spend", "clicks", "impressions"] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={metric === m} onClick={() => setMetric(m)}
                  className={clsx("flex-1 rounded-md px-3 py-1.5 font-semibold", metric === m ? "bg-white shadow-sm" : "text-ink-soft")}>{m === "spend" ? "Revenue" : m === "clicks" ? "Clicks" : "Impressions"}</button>
              ))}
            </div>
            <DailyBars series={series} valueKey={metric} money={metric === "spend"} height={140} />
          </div>
        </section>
      )}
      <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} items={[
        { value: "pending", label: "Waiting for approval", count: counts.pending ?? 0 },
        { value: "active", label: "Running", count: counts.active ?? 0 },
        { value: "paused", label: "Paused", count: counts.paused ?? 0 },
        { value: "rejected", label: "Rejected", count: counts.rejected ?? 0 },
        { value: "ended", label: "Ended", count: counts.ended ?? 0 },
        { value: "all", label: "All", count: all },
        ...(canSettings ? [{ value: "settings", label: "Settings" }] : []),
      ]} />
      {tab === "settings" ? (
        <SettingsBlock title="Sponsored products settings" sub="Where ads may show, the lowest bid and budget, and how many sponsored products appear." fields={SETTINGS} saveLabel="Save ad settings" />
      ) : (
        <>
          <div className="relative mb-3 max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by campaign or seller" aria-label="Search campaigns" className="pl-9" />
          </div>
          <ErrorNote message={error} />
          {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? (
            <EmptyState title={tab === "pending" ? "Nothing waiting" : "No campaigns here"} body={tab === "pending" ? "New campaigns and changed keywords or products show up here for approval." : undefined} />
          ) : (
            <div className="flex flex-col gap-3">
              {d.items.map((c) => (
                <CampaignCard key={c.id} c={c} now={now} showSeller actions={
                  <>
                    {c.status === "pending" && <Button size="sm" loading={busy === c.id + "approve"} onClick={() => run(c, "approve")}>Approve</Button>}
                    {["pending", "active", "paused"].includes(c.status) && <Button size="sm" variant="danger" onClick={() => { setReason(""); setAct({ c, action: "reject" }); }}>Reject</Button>}
                    {c.status === "active" && <Button size="sm" variant="secondary" loading={busy === c.id + "pause"} onClick={() => run(c, "pause")}>Pause</Button>}
                    {c.status === "paused" && <Button size="sm" loading={busy === c.id + "resume"} onClick={() => run(c, "resume")}>Resume</Button>}
                    {["pending", "active", "paused"].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => { setReason(""); setAct({ c, action: "end" }); }}>End</Button>}
                  </>
                } />
              ))}
            </div>
          )}
          {d && <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />}
        </>
      )}

      <Modal open={act !== null} onClose={() => setAct(null)} title={act?.action === "reject" ? "Reject this campaign" : "End this campaign"}>
        {act && (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); run(act.c, act.action, reason.trim()); }}>
            <p className="text-sm text-ink-soft"><b className="text-ink">{act.c.name}</b>{act.c.seller ? ` from ${act.c.seller}` : ""}. The seller sees your reason. {act.action === "end" ? "An ended campaign cannot run again." : "The seller can edit it and send it again."}</p>
            <Textarea rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" autoFocus
              placeholder={act.action === "reject" ? "e.g. Keywords use another brand's name" : "e.g. Product listing under review"} />
            <div className="flex gap-2">
              <Button type="submit" variant="danger" loading={busy === act.c.id + act.action} disabled={reason.trim().length < 5}>{act.action === "reject" ? "Reject campaign" : "End campaign"}</Button>
              <Button type="button" variant="ghost" onClick={() => setAct(null)}>Back</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
