"use client";

import { useEffect, useRef, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, ErrorNote, PageLoader, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";

// Admin -> Growth. Same endpoints, defaults and wording as the .NET/Angular version (/api/admin/growth/*).
// Every module ships switched off.
type Val = boolean | number | string | string[];
type Settings = Record<string, Record<string, Val>>;
type Score = { seller_id: string; seller: string; orders: number; late: number; cancelled_by_seller: number; returned: number; late_percent: number; cancel_percent: number; return_percent: number; level: string };

const TITLES: Record<string, { title: string; hint: string }> = {
  loyalty: { title: "Loyalty points", hint: "Customers earn points on delivered orders and spend them at checkout." },
  referral: { title: "Referral rewards", hint: "A customer shares a code; both sides get store credit after the friend's first order." },
  abandoned_cart: { title: "Abandoned cart reminders", hint: "Remind shoppers who left items in the cart. Optional coupon in the reminder." },
  flash_sales: { title: "Flash sales", hint: "Time-limited discounts. Sellers pick a window within these limits." },
  gift_cards: { title: "Gift cards", hint: "Prepaid codes customers can buy and send." },
  scorecard: { title: "Seller scorecard", hint: "Late shipping, seller cancellations and returns, with warning and critical levels." },
  cod_risk: { title: "Cash on delivery risk", hint: "Limits and blocked pincodes for cash orders." },
  seo: { title: "Search engines", hint: "Sitemap for Google and other search engines." },
  bulk_edit: { title: "Bulk product edit", hint: "Change price, stock or status of many listings at once." },
  segments: { title: "Customer segments", hint: "VIP, new and lapsed customers for targeted offers." },
};
const LEVEL: Record<string, string> = { ok: "Good", warning: "Warning", critical: "Critical", not_enough_orders: "Not enough orders" };

function label(k: string): string {
  const base = k.replace(/_paise$/, "").replace(/_percent$/, "").replace(/_/g, " ");
  const unit = k.endsWith("_paise") ? " (₹)" : k.endsWith("_percent") ? " (%)" : "";
  return base.charAt(0).toUpperCase() + base.slice(1) + unit;
}

export default function AdminGrowthPage() {
  const toast = useToast();
  const [tab, setTab] = useState("settings");
  const [s, setS] = useState<Settings | null>(null);
  const [score, setScore] = useState<Score[] | null>(null);
  const [scoreOn, setScoreOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const text = useRef(new Map<string, string>());
  useEffect(() => {
    api<{ settings: Settings }>("/api/admin/growth/settings").then((x) => setS(x.settings)).catch(quietly);
    api<{ enabled: boolean; items: Score[] }>("/api/admin/growth/scorecard").then((x) => { setScore(x.items); setScoreOn(x.enabled); }).catch(quietly);
  }, []);
  const set = (sec: string, k: string, v: Val) => setS((cur) => (cur ? { ...cur, [sec]: { ...cur[sec], [k]: v } } : cur));
  const show = (sec: string, k: string): string => {
    const t = text.current.get(sec + "." + k);
    if (t !== undefined) return t;
    const v = s![sec][k];
    return Array.isArray(v) ? v.join(", ") : typeof v === "number" && k.endsWith("_paise") ? String(v / 100) : String(v);
  };
  const edit = (sec: string, k: string, raw: string) => {
    text.current.set(sec + "." + k, raw);
    const v = s![sec][k];
    if (Array.isArray(v)) set(sec, k, raw.split(",").map((x) => x.trim()).filter(Boolean));
    else if (typeof v === "number") set(sec, k, Math.round((Number(raw.replace(/[^\d.]/g, "")) || 0) * (k.endsWith("_paise") ? 100 : 1)));
    else set(sec, k, raw);
  };
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const body: Settings = {};
      for (const sec of Object.keys(s)) if (TITLES[sec]) body[sec] = s[sec];
      const x = await api<{ settings: Settings }>("/api/admin/growth/settings", { method: "PUT", body });
      text.current.clear();
      setS(x.settings);
      toast("Growth settings saved");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageHeader title="Growth" sub="Loyalty, referrals, reminders, flash sales, gift cards, seller quality and risk. Every module starts switched off." />
      <Tabs value={tab} onChange={setTab} items={[{ value: "settings", label: "Settings" }, { value: "scorecard-view", label: "Seller scorecard" }]} />
      {tab === "scorecard-view" ? (
        !score ? <PageLoader /> : (
          <>
            {!scoreOn && <p className="mb-3 rounded-lg bg-white p-3 text-sm text-ink-soft">The scorecard is switched off in Settings. Figures below are for information.</p>}
            <div className="overflow-x-auto rounded-xl bg-white">
              <table className="w-full text-left text-sm" data-testid="scorecard">
                <thead><tr className="border-b border-line"><th className="p-3">Seller</th><th className="p-3">Orders</th><th className="p-3">Late</th><th className="p-3">Seller cancels</th><th className="p-3">Returns</th><th className="p-3">Status</th></tr></thead>
                <tbody>
                  {score.length === 0 && <tr><td className="p-4 text-ink-soft" colSpan={6}>No orders in the window yet.</td></tr>}
                  {score.map((r) => (
                    <tr key={r.seller_id} className="border-b border-line/50">
                      <td className="p-3 font-semibold">{r.seller}</td><td className="p-3">{r.orders}</td>
                      <td className="p-3">{r.late} ({r.late_percent}%)</td><td className="p-3">{r.cancelled_by_seller} ({r.cancel_percent}%)</td><td className="p-3">{r.returned} ({r.return_percent}%)</td>
                      <td className="p-3">{LEVEL[r.level] ?? r.level}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : !s ? <PageLoader /> : (
        <form onSubmit={save} className="flex max-w-3xl flex-col gap-4">
          <ErrorNote message={error} />
          {Object.keys(s).filter((sec) => TITLES[sec]).map((sec) => (
            <section key={sec} className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2" data-testid={"growth-" + sec}>
              <div className="sm:col-span-2"><h2 className="text-lg font-semibold">{TITLES[sec].title}</h2><p className="text-sm text-ink-soft">{TITLES[sec].hint}</p></div>
              {Object.keys(s[sec]).sort((a, b) => (a === "enabled" ? -1 : b === "enabled" ? 1 : 0)).map((k) => {
                const v = s[sec][k];
                return typeof v === "boolean" ? (
                  <label key={k} className="flex items-center gap-3 rounded-lg border border-line p-3"><input type="checkbox" className="h-4 w-4 accent-peacock" checked={v} onChange={(e) => set(sec, k, e.target.checked)} /> <span className="font-semibold">{label(k === "enabled" ? "Switched on" : k)}</span></label>
                ) : (
                  <label key={k} className="flex flex-col gap-1 text-sm"><span className="font-semibold">{label(k)}</span>
                    <input className="rounded-lg border border-line px-3 py-2" value={show(sec, k)} onChange={(e) => edit(sec, k, e.target.value)} aria-label={TITLES[sec].title + " " + label(k)} /></label>
                );
              })}
            </section>
          ))}
          <Button type="submit" loading={busy} className="self-start">Save growth settings</Button>
        </form>
      )}
    </div>
  );
}
