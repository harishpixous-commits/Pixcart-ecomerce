"use client";

import clsx from "clsx";
import { BadgeIndianRupee, MousePointerClick, Search, Target, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CampaignCard, fillDays, type AdDay, type AdRules, type Campaign } from "@/components/ad-campaigns";
import { DailyBars, HBar } from "@/components/charts";
import { PageHeader, Stat, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, TextField, useToast } from "@/components/ui";
import { api, ApiError, latestOnly, quietly } from "@/lib/api";
import { dateTime, paiseToInput, pct, rupees, toLocalInput, toPaise } from "@/lib/format";

type Totals = { impressions: number; clicks: number; spend: number; orders: number; sales: number; acos: number | null };
type Data = { campaigns: Campaign[]; rules: AdRules; totals_30d: Totals; billing: { amount: number; description: string; at: string }[] };
type AdProduct = { id: string; title: string; image: string; price: number; in_stock: boolean; rating_avg: number };

const LIVE = ["pending", "active", "paused", "rejected"];

export default function SellerAdvertising() {
  const toast = useToast();
  const [now] = useState(() => Date.now());
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("live");
  const [edit, setEdit] = useState<Campaign | "new" | null>(null);
  const [report, setReport] = useState<Campaign | null>(null);
  const [ending, setEnding] = useState<Campaign | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => {
    track(api<Data>("/api/seller/ads"), (x) => { setD(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load your campaigns"));
  }, [track]);
  useEffect(() => { load(); }, [load]);

  async function act(c: Campaign, action: "pause" | "resume" | "end") {
    setBusy(c.id + action);
    try {
      await api(`/api/seller/ads/${c.id}/${action}`, { method: "POST" });
      toast(action === "pause" ? "Campaign paused" : action === "resume" ? "Campaign is running again" : "Campaign ended");
      setEnding(null);
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not update the campaign", "error");
    } finally {
      setBusy(null);
    }
  }

  if (!d) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const t = d.totals_30d;
  const live = d.campaigns.filter((c) => LIVE.includes(c.status));
  const ended = d.campaigns.filter((c) => !LIVE.includes(c.status));
  const shown = tab === "live" ? live : tab === "ended" ? ended : d.campaigns;
  const ctr = t.impressions ? Math.round((10000 * t.clicks) / t.impressions) / 100 : 0;

  return (
    <div>
      <PageHeader
        title="Advertising"
        sub="Sponsored products: show your products at the top of search results, on similar product pages and on the home page. You pay only when a shopper clicks."
        actions={<Button onClick={() => setEdit("new")} disabled={!d.rules.enabled}>Create campaign</Button>}
      />
      <ErrorNote message={error} />
      {!d.rules.enabled && (
        <p className="mb-4 rounded-xl bg-marigold-light px-4 py-3 text-sm">Sponsored products are switched off on the marketplace right now. Your campaigns are not showing.</p>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="Last 30 days">
        <Stat label="Impressions (30 days)" value={t.impressions.toLocaleString("en-IN")} />
        <Stat label="Clicks" value={t.clicks.toLocaleString("en-IN")} hint={`${ctr}% of impressions`} />
        <Stat label="Spend" value={rupees(t.spend)} hint={`+ GST ${pct(d.rules.gst_bps)}`} />
        <Stat label="Ad sales" value={rupees(t.sales)} hint={`${t.orders} order${t.orders === 1 ? "" : "s"} within ${d.rules.attribution_days} days of a click`} />
        <Stat label="ACOS" value={t.acos === null ? "—" : `${t.acos}%`} hint="Spend as a share of ad sales; lower is better" />
      </div>

      {d.campaigns.length === 0 ? (
        <HowItWorks rules={d.rules} onStart={() => setEdit("new")} />
      ) : (
        <>
          <Tabs value={tab} onChange={setTab} items={[
            { value: "live", label: "Current", count: live.length }, { value: "ended", label: "Ended", count: ended.length }, { value: "all", label: "All", count: d.campaigns.length },
          ]} />
          {shown.length === 0 ? <EmptyState title="Nothing here" body="Campaigns in this list show up here." /> : (
            <div className="flex flex-col gap-3">
              {shown.map((c) => (
                <CampaignCard key={c.id} c={c} now={now} actions={
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setReport(c)}>Report</Button>
                    {c.status !== "ended" && <Button size="sm" variant="secondary" onClick={() => setEdit(c)}>{c.status === "rejected" ? "Edit and send again" : "Edit"}</Button>}
                    {c.status === "active" && <Button size="sm" variant="ghost" loading={busy === c.id + "pause"} onClick={() => act(c, "pause")}>Pause</Button>}
                    {c.status === "paused" && <Button size="sm" loading={busy === c.id + "resume"} onClick={() => act(c, "resume")}>Resume</Button>}
                    {["pending", "active", "paused"].includes(c.status) && <Button size="sm" variant="danger" onClick={() => setEnding(c)}>End</Button>}
                  </>
                } />
              ))}
            </div>
          )}
        </>
      )}

      <section className="mt-6 rounded-xl bg-white p-4" aria-labelledby="ad-charges">
        <h2 id="ad-charges" className="font-semibold">Ad charges</h2>
        <p className="text-sm text-ink-soft">Each day&apos;s clicks plus GST ({pct(d.rules.gst_bps)}) are taken from your next payout. A shopper&apos;s repeat clicks on the same day are free.</p>
        {d.billing.length === 0 ? <p className="mt-2 text-sm text-ink-faint">No charges yet.</p> : (
          <ul className="mt-2 divide-y divide-line">
            {d.billing.map((b, i) => (
              <li key={i} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span className="min-w-0">{b.description}<span className="block text-xs text-ink-faint">{dateTime(b.at)}</span></span>
                <span className="shrink-0 font-semibold text-vermilion">− {rupees(Math.abs(b.amount))}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === "new" ? "New campaign" : `Edit ${edit?.name ?? ""}`} wide>
        {edit !== null && (
          <CampaignEditor rules={d.rules} campaign={edit === "new" ? null : edit} onDone={(c) => {
            setEdit(null);
            toast(c.status === "pending" ? "Campaign sent. The marketplace team checks it before it runs." : "Campaign saved");
            setTab("live");
            load();
          }} />
        )}
      </Modal>
      <Modal open={report !== null} onClose={() => setReport(null)} title={report ? `Report: ${report.name}` : "Report"} wide>
        {report && <CampaignReport campaign={report} />}
      </Modal>
      <Modal open={ending !== null} onClose={() => setEnding(null)} title="End this campaign?">
        {ending && (
          <div className="flex flex-col gap-3">
            <p className="text-ink-soft">Ads for <b className="text-ink">{ending.name}</b> stop showing right away. You cannot restart an ended campaign, but you can create a new one.</p>
            <div className="flex gap-2">
              <Button variant="danger" loading={busy === ending.id + "end"} onClick={() => act(ending, "end")}>End campaign</Button>
              <Button variant="ghost" onClick={() => setEnding(null)}>Keep it</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function HowItWorks({ rules, onStart }: { rules: AdRules; onStart: () => void }) {
  const steps = [
    { icon: Target, title: "Choose products and places", text: "Pick the products to promote and where they show: search results, similar product pages, the home page." },
    { icon: BadgeIndianRupee, title: "Set a bid and a budget", text: `Your bid is the most you pay for a click (from ${rupees(rules.min_bid_paise)}). The daily budget caps what you spend in a day.` },
    { icon: MousePointerClick, title: "Pay only for clicks", text: `Ads are marked "Sponsored". Orders placed within ${rules.attribution_days} days of a click count as ad sales in your reports.` },
  ];
  return (
    <section className="rounded-xl bg-white p-5" data-testid="ads-how">
      <h2 className="text-lg font-semibold">How sponsored products work</h2>
      <ol className="mt-3 grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-peacock-light text-peacock"><s.icon className="h-5 w-5" aria-hidden /></span>
            <div>
              <p className="font-semibold">{i + 1}. {s.title}</p>
              <p className="text-sm text-ink-soft">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      {rules.enabled && <Button className="mt-4" onClick={onStart}>Create your first campaign</Button>}
    </section>
  );
}

/* ---------------------------------------------------------------- editor */

function CampaignEditor({ rules, campaign, onDone }: { rules: AdRules; campaign: Campaign | null; onDone: (c: Campaign) => void }) {
  const [products, setProducts] = useState<AdProduct[] | null>(null);
  const [q, setQ] = useState("");
  const [f, setF] = useState(() => ({
    name: campaign?.name ?? "",
    ids: campaign?.products.map((p) => p.id) ?? [],
    placements: campaign?.placements ?? Object.entries(rules.placements).filter(([, v]) => v.enabled).map(([k]) => k),
    keywords: campaign?.keywords ?? [],
    bid: paiseToInput(campaign?.bid_paise ?? Math.max(rules.min_bid_paise, 500)),
    daily: paiseToInput(campaign?.daily_budget_paise ?? Math.max(rules.min_daily_budget_paise, 20000)),
    total: campaign?.total_budget_paise ? paiseToInput(campaign.total_budget_paise) : "",
    starts: campaign ? toLocalInput(campaign.starts_at) : "",
    ends: campaign?.ends_at ? toLocalInput(campaign.ends_at) : "",
  }));
  const [kw, setKw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api<AdProduct[]>("/api/seller/ads/products").then(setProducts).catch(quietly); }, []);

  const bid = toPaise(f.bid) ?? 0;
  const daily = toPaise(f.daily) ?? 0;
  const total = f.total ? toPaise(f.total) ?? 0 : null;
  const clicksPerDay = bid > 0 ? Math.floor(daily / bid) : 0;
  const list = (products ?? []).filter((p) => !q.trim() || p.title.toLowerCase().includes(q.trim().toLowerCase()));
  const chosen = new Set(f.ids);

  function toggleProduct(id: string) {
    setF({ ...f, ids: chosen.has(id) ? f.ids.filter((x) => x !== id) : f.ids.length >= 50 ? f.ids : [...f.ids, id] });
  }
  function addKeywords(text: string) {
    const words = text.split(/[,\n]/).map((w) => w.trim().toLowerCase().replace(/\s+/g, " ")).filter((w) => w.length >= 2 && w.length <= 40);
    const next = [...f.keywords];
    for (const w of words) if (!next.includes(w) && next.length < 30) next.push(w);
    setF({ ...f, keywords: next });
    setKw("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (f.name.trim().length < 3) return setError("Give the campaign a name (at least 3 characters)");
    if (f.ids.length === 0) return setError("Choose at least one product to promote");
    if (f.placements.length === 0) return setError("Choose where the ads show");
    if (bid < rules.min_bid_paise) return setError(`Bid at least ${rupees(rules.min_bid_paise)} per click`);
    if (daily < rules.min_daily_budget_paise) return setError(`Set a daily budget of at least ${rupees(rules.min_daily_budget_paise)}`);
    if (daily < bid) return setError("The daily budget must cover at least one click");
    if (total !== null && (!total || total < daily)) return setError("The total budget cannot be less than the daily budget");
    if (f.starts && f.ends && new Date(f.ends) <= new Date(f.starts)) return setError("The campaign must end after it starts");
    const pending = kw.trim() ? [...f.keywords, ...kw.split(",").map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2)] : f.keywords;
    setSaving(true);
    try {
      const body = {
        name: f.name.trim(), product_ids: f.ids, placements: f.placements, keywords: pending.slice(0, 30), bid_paise: bid, daily_budget_paise: daily,
        total_budget_paise: total, starts_at: f.starts ? new Date(f.starts).toISOString() : null, ends_at: f.ends ? new Date(f.ends).toISOString() : null,
      };
      const out = campaign
        ? await api<Campaign>(`/api/seller/ads/${campaign.id}`, { method: "PUT", body })
        : await api<Campaign>("/api/seller/ads", { method: "POST", body });
      onDone(out);
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save the campaign");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4" data-testid="campaign-form">
      <ErrorNote message={error} />
      <TextField label="Campaign name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="e.g. Diwali earbuds push" required />

      <fieldset>
        <legend className="mb-1 flex w-full items-center justify-between text-sm font-medium">
          <span>Products to promote</span>
          <span className="text-xs font-normal text-ink-faint">{f.ids.length} chosen (up to 50)</span>
        </legend>
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter your live products" aria-label="Filter your live products" className="pl-9" />
        </div>
        <div className="max-h-60 overflow-y-auto rounded-xl ring-1 ring-line">
          {!products ? <div className="p-6"><PageLoader /></div> : list.length === 0 ? (
            <p className="p-4 text-sm text-ink-soft">{products.length === 0 ? "You have no live products yet." : "No product matches."}</p>
          ) : list.map((p) => (
            <label key={p.id} className={clsx("flex cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-0", chosen.has(p.id) ? "bg-peacock-light/40" : "hover:bg-mist")}>
              <input type="checkbox" className="h-4 w-4 accent-peacock" checked={chosen.has(p.id)} onChange={() => toggleProduct(p.id)} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {p.image ? <img src={p.image} alt="" className="h-10 w-10 shrink-0 rounded object-contain" /> : <span className="h-10 w-10 shrink-0 rounded bg-mist" />}
              <span className="min-w-0 flex-1">
                <span className="line-clamp-1 text-sm font-medium">{p.title}</span>
                <span className="text-xs text-ink-faint">{rupees(p.price)}{p.rating_avg ? ` · ${p.rating_avg.toFixed(1)} ★` : ""}{p.in_stock ? "" : " · out of stock (not shown until restocked)"}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Where the ads show</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {Object.entries(rules.placements).map(([k, v]) => {
            const on = f.placements.includes(k);
            return (
              <label key={k} className={clsx("flex items-start gap-2 rounded-xl border p-3", !v.enabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                on ? "border-peacock bg-peacock-light/40" : "border-line hover:bg-mist")}>
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-peacock" checked={on} disabled={!v.enabled}
                  onChange={() => setF({ ...f, placements: on ? f.placements.filter((x) => x !== k) : [...f.placements, k] })} />
                <span>
                  <span className="block text-sm font-semibold">{v.label}</span>
                  <span className="block text-xs text-ink-soft">
                    {!v.enabled ? "Off on this marketplace" : k === "search" ? "At the top of matching search results" : k === "product" ? "On pages of similar products" : "In the Sponsored row on the home page"}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {f.placements.includes("search") && (
        <Field label="Search keywords (optional)" hint="Your ad shows when a search contains one of these words. Without keywords, it shows when the search words match the product title. Press Enter or comma to add.">
          <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-white px-2 py-1.5 focus-within:border-peacock focus-within:ring-2 focus-within:ring-peacock/20">
            {f.keywords.map((w) => (
              <span key={w} className="inline-flex items-center gap-1 rounded-full bg-peacock-light px-2 py-0.5 text-sm text-peacock">
                {w}
                <button type="button" aria-label={`Remove ${w}`} onClick={() => setF({ ...f, keywords: f.keywords.filter((x) => x !== w) })} className="rounded-full hover:bg-white/60"><X className="h-3.5 w-3.5" /></button>
              </span>
            ))}
            <input value={kw} onChange={(e) => (e.target.value.includes(",") ? addKeywords(e.target.value) : setKw(e.target.value))}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (kw.trim()) addKeywords(kw); } else if (e.key === "Backspace" && !kw && f.keywords.length) setF({ ...f, keywords: f.keywords.slice(0, -1) }); }}
              onBlur={() => kw.trim() && addKeywords(kw)} placeholder={f.keywords.length ? "" : "wireless earbuds, bluetooth"} aria-label="Add a keyword"
              className="h-7 min-w-[8rem] flex-1 bg-transparent text-[15px] outline-none" />
          </div>
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Bid per click (₹)" inputMode="decimal" value={f.bid} onChange={(e) => setF({ ...f, bid: e.target.value })} hint={`At least ${rupees(rules.min_bid_paise)}. Higher bids show first.`} />
        <TextField label="Daily budget (₹)" inputMode="decimal" value={f.daily} onChange={(e) => setF({ ...f, daily: e.target.value })} hint={`At least ${rupees(rules.min_daily_budget_paise)}`} />
        <TextField label="Total budget (₹, optional)" inputMode="decimal" value={f.total} onChange={(e) => setF({ ...f, total: e.target.value })} hint="The campaign ends when it is spent" />
        <TextField label="Starts (optional)" type="datetime-local" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} hint="Empty: starts now" />
        <TextField label="Ends (optional)" type="datetime-local" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} hint="Empty: runs until you end it" />
      </div>

      <p className="rounded-xl bg-mist px-4 py-3 text-sm" data-testid="campaign-estimate">
        {bid > 0 && daily >= bid
          ? <>At most <b>{rupees(daily)}</b> a day: about <b>{clicksPerDay.toLocaleString("en-IN")}</b> clicks at your bid. You pay only for clicks, plus GST ({pct(rules.gst_bps)}).</>
          : "Enter a bid and a daily budget that covers at least one click."}
        {rules.need_approval && <> The marketplace team checks new campaigns and changes to products or keywords before they run.</>}
      </p>
      <div><Button type="submit" loading={saving}>{campaign ? "Save changes" : rules.need_approval ? "Send for approval" : "Start campaign"}</Button></div>
    </form>
  );
}

/* ---------------------------------------------------------------- report */

function CampaignReport({ campaign }: { campaign: Campaign }) {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<"clicks" | "spend" | "impressions">("clicks");
  const [r, setR] = useState<{ key: string; days: AdDay[]; products: { title: string; impressions: number; clicks: number; spend: number }[] } | null>(null);
  const key = `${campaign.id}:${days}`;
  useEffect(() => {
    let live = true;
    api<{ days: AdDay[]; products: { title: string; impressions: number; clicks: number; spend: number }[] }>(`/api/seller/ads/${campaign.id}/report`, { query: { days } })
      .then((x) => { if (live) setR({ key, ...x }); })
      .catch(quietly);
    return () => { live = false; };
  }, [campaign.id, days, key]);
  if (!r || r.key !== key) return <PageLoader />;
  const series = fillDays(r.days, days);
  const sum = series.reduce((a, x) => ({ impressions: a.impressions + x.impressions, clicks: a.clicks + x.clicks, spend: a.spend + x.spend }), { impressions: 0, clicks: 0, spend: 0 });
  return (
    <div className="flex flex-col gap-4" data-testid="campaign-report">
      <div className="flex flex-wrap items-center gap-2">
        {([7, 30, 90] as const).map((n) => (
          <button key={n} type="button" onClick={() => setDays(n)} className={clsx("rounded-full px-3 py-1 text-sm font-semibold", days === n ? "bg-peacock text-white" : "bg-mist hover:bg-line")}>{n} days</button>
        ))}
        <span className="ml-auto text-sm text-ink-soft">{sum.impressions.toLocaleString("en-IN")} impressions · {sum.clicks.toLocaleString("en-IN")} clicks · {rupees(sum.spend)}</span>
      </div>
      <div className="flex gap-1 rounded-lg bg-mist p-1 text-sm" role="tablist" aria-label="Chart">
        {(["clicks", "spend", "impressions"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={metric === m} onClick={() => setMetric(m)}
            className={clsx("flex-1 rounded-md px-3 py-1.5 font-semibold capitalize", metric === m ? "bg-white shadow-sm" : "text-ink-soft")}>{m}</button>
        ))}
      </div>
      <DailyBars series={series} valueKey={metric} money={metric === "spend"} />
      <div>
        <h3 className="mb-2 font-semibold">Clicks by product</h3>
        {r.products.length === 0 ? <p className="text-sm text-ink-faint">No clicks in this period yet.</p> : (
          <HBar items={r.products.map((p) => ({ label: p.title, value: p.clicks, display: `${p.clicks} clicks · ${rupees(p.spend)}` }))} />
        )}
      </div>
    </div>
  );
}
