"use client";

import { useEffect, useRef, useState } from "react";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, ErrorNote, PageLoader, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { date, rupees } from "@/lib/format";

// Admin -> Growth. Same endpoints, defaults and wording as the .NET/Angular version (/api/admin/growth/*).
// Every module ships switched off.
type Val = boolean | number | string | string[];
type Settings = Record<string, Record<string, Val>>;
type Score = { seller_id: string; seller: string; orders: number; late: number; cancelled_by_seller: number; returned: number; late_percent: number; cancel_percent: number; return_percent: number; level: string };

const TITLES: Record<string, { title: string; hint: string }> = {
  loyalty: { title: "Loyalty points", hint: "Customers earn points on delivered orders and spend them at checkout." },
  referral: { title: "Referral rewards", hint: "A customer shares a code; both sides get store credit after the friend's first order." },
  return_reasons: { title: "Return reasons", hint: "Rename a reason shown to customers (label_...) or switch it off (off_...). Leave a label empty to keep the built-in text. Damaged, faulty, wrong or incomplete items keep their special rule." },
  shipping_zones: { title: "Shipping zones", hint: "Add a delivery fee per seller package for remote pincodes. List pincode prefixes separated by commas (for example 744, 19). By default the fee is not added to a package that already ships free." },
  saved_searches: { title: "Saved searches", hint: "Shoppers follow a search and get an in-app note when new matching products are approved. At most one note per search in the hours set here." },
  campaigns: { title: "Segment campaigns", hint: "Send an in-app message to a customer segment. Only customers who opted in to marketing get it. Needs Segments switched on." },
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

type Card = { id: string; code: string; note: string; balance_paise: number; initial_paise: number; expires_at: string; status: string };
type Seg = { key: string; label: string; count: number };
type Member = { id: string; name: string; phone: string | null; email: string | null; marketing_opt_in: boolean; orders: number; spent_paise: number; last_order_at: string | null };

type Purchase = { id: string; user: string; phone: string | null; amount_paise: number; gateway: string; status: string; error: string; created_at: string };

function GiftCardsTab() {
  const toast = useToast();
  const [cards, setCards] = useState<Card[]>([]);
  const [amount, setAmount] = useState("500");
  const [qty, setQty] = useState("1");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const checkPurchase = async (p: Purchase) => {
    try { const r = await api<{ status: string }>(`/api/admin/growth/gift-card-purchases/${p.id}/check`, { method: "POST", body: {} }); toast(r.status === "issued" ? "Paid. The card was issued." : r.status === "failed" ? "The payment failed." : "Not paid yet."); load(); }
    catch (x) { setError(x instanceof ApiError ? x.message : "Could not check"); }
  };
  const load = () => {
    api<{ items: Card[] }>("/api/admin/growth/gift-cards").then((x) => setCards(x.items)).catch(quietly);
    api<{ items: Purchase[] }>("/api/admin/growth/gift-card-purchases").then((x) => setPurchases(x.items)).catch(quietly);
  };
  useEffect(load, []);
  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const quantity = Number(qty) || 1;
      await api("/api/admin/growth/gift-cards", { method: "POST", body: { amount_paise: Math.round((Number(amount.replace(/[^\d.]/g, "")) || 0) * 100), quantity, note: note.trim() } });
      toast(quantity > 1 ? "Gift cards issued" : "Gift card issued");
      load();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not issue");
    } finally {
      setBusy(false);
    }
  }
  async function voidCard(c: Card) {
    try { await api(`/api/admin/growth/gift-cards/${c.id}/void`, { method: "POST", body: {} }); load(); } catch (x) { setError(x instanceof ApiError ? x.message : "Could not void"); }
  }
  return (
    <div className="flex flex-col gap-4">
      <ErrorNote message={error} />
      <form onSubmit={issue} className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-4" data-testid="gift-issue">
        <label className="flex flex-col gap-1 text-sm"><span className="font-semibold">Amount (₹)</span><input className="rounded-lg border border-line px-3 py-2" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Gift card amount" /></label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-semibold">How many (1 to 50)</span><input className="rounded-lg border border-line px-3 py-2" value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Gift card quantity" /></label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="font-semibold">Note</span><input className="rounded-lg border border-line px-3 py-2" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Gift card note" /></label>
        <Button type="submit" loading={busy} className="self-start sm:col-span-4">Issue gift cards</Button>
        <p className="text-sm text-ink-soft sm:col-span-4">Gift cards must be switched on in Settings first. Codes are shown here and in the list below.</p>
      </form>
      <div className="overflow-x-auto rounded-xl bg-white">
        <table className="w-full text-left text-sm" data-testid="gift-cards">
          <thead><tr className="border-b border-line"><th className="p-3">Code</th><th className="p-3">Balance</th><th className="p-3">Issued</th><th className="p-3">Expires</th><th className="p-3">Status</th><th className="p-3">Note</th><th className="p-3" /></tr></thead>
          <tbody>
            {cards.length === 0 && <tr><td className="p-4 text-ink-soft" colSpan={7}>No gift cards yet.</td></tr>}
            {cards.map((c) => (
              <tr key={c.id} className="border-b border-line/50"><td className="p-3 font-mono font-semibold">{c.code}</td><td className="p-3">{rupees(c.balance_paise)}</td><td className="p-3">{rupees(c.initial_paise)}</td><td className="p-3">{date(c.expires_at)}</td><td className="p-3">{c.status}</td><td className="p-3">{c.note}</td>
                <td className="p-3">{c.status === "active" && <button type="button" className="font-semibold text-vermilion" onClick={() => voidCard(c)}>Void</button>}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {purchases.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white">
          <h3 className="p-3 font-semibold">Bought online</h3>
          <table className="w-full text-left text-sm" data-testid="gift-purchases">
            <thead><tr className="border-b border-line"><th className="p-3">Buyer</th><th className="p-3">Amount</th><th className="p-3">Gateway</th><th className="p-3">Status</th><th className="p-3">Started</th><th className="p-3">Note</th><th className="p-3" /></tr></thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.id} className="border-b border-line/50"><td className="p-3">{p.user} {p.phone}</td><td className="p-3">{rupees(p.amount_paise)}</td><td className="p-3">{p.gateway}</td><td className="p-3">{p.status}</td><td className="p-3">{date(p.created_at)}</td><td className="p-3 text-ink-soft">{p.status === "created" ? "Waiting for payment, or paid and not yet checked" : p.error}</td>
                  <td className="p-3">{p.status === "created" && <button type="button" className="font-semibold text-peacock" onClick={() => checkPurchase(p)}>Check payment</button>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type Reminder = { id: string; customer: string; contact: string | null; stage: number; cart_paise: number; sent_at: string; ordered_after: boolean };

function CartRemindersTab() {
  const [rl, setRl] = useState<{ enabled: boolean; sent_30d: number; ordered_after: number; items: Reminder[] } | null>(null);
  useEffect(() => { api<{ enabled: boolean; sent_30d: number; ordered_after: number; items: Reminder[] }>("/api/admin/growth/cart-reminders").then(setRl).catch(quietly); }, []);
  if (!rl) return <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-lg bg-white p-4 text-sm" data-testid="reminder-summary">{rl.sent_30d} reminders in the last 30 days. {rl.ordered_after} of the latest {rl.items.length} customers ordered afterwards.{!rl.enabled && " Reminders are switched off in Settings."}</p>
      <div className="overflow-x-auto rounded-xl bg-white">
        <table className="w-full text-left text-sm" data-testid="reminders">
          <thead><tr className="border-b border-line"><th className="p-3">Customer</th><th className="p-3">Contact</th><th className="p-3">Reminder</th><th className="p-3">Cart</th><th className="p-3">Sent</th><th className="p-3">Ordered after</th></tr></thead>
          <tbody>
            {rl.items.length === 0 && <tr><td className="p-4 text-ink-soft" colSpan={6}>No reminders sent yet.</td></tr>}
            {rl.items.map((r) => (
              <tr key={r.id} className="border-b border-line/50"><td className="p-3 font-semibold">{r.customer}</td><td className="p-3">{r.contact}</td><td className="p-3">#{r.stage}</td><td className="p-3">{rupees(r.cart_paise)}</td><td className="p-3">{date(r.sent_at)}</td><td className="p-3">{r.ordered_after ? "Yes" : "No"}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SegmentsTab() {
  const [segs, setSegs] = useState<Seg[]>([]);
  const [key, setKey] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<{ segments: Seg[] }>("/api/admin/growth/segments").then((x) => setSegs(x.segments)).catch((e) => setErr(e instanceof ApiError ? e.message : null)); }, []);
  async function open(k: string) {
    setKey(k);
    try { setMembers((await api<{ items: Member[] }>("/api/admin/growth/segments", { query: { segment: k } })).items); } catch (e) { setErr(e instanceof ApiError ? e.message : null); }
  }
  return (
    <div className="flex flex-col gap-4">
      {err && <p className="rounded-lg bg-white p-4 text-sm text-ink-soft" data-testid="segments-off">{err}</p>}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {segs.map((g) => (
          <button key={g.key} type="button" onClick={() => open(g.key)} aria-pressed={key === g.key} className="rounded-xl bg-white p-4 text-left hover:ring-2 hover:ring-peacock">
            <p className="text-2xl font-bold">{g.count}</p><p className="text-sm text-ink-soft">{g.label}</p></button>
        ))}
      </div>
      {members.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white">
          <table className="w-full text-left text-sm" data-testid="segment-members">
            <thead><tr className="border-b border-line"><th className="p-3">Customer</th><th className="p-3">Contact</th><th className="p-3">Orders</th><th className="p-3">Spent</th><th className="p-3">Last order</th><th className="p-3">Marketing</th></tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-line/50"><td className="p-3 font-semibold">{m.name}</td><td className="p-3">{m.phone || m.email}</td><td className="p-3">{m.orders}</td><td className="p-3">{rupees(m.spent_paise)}</td><td className="p-3">{m.last_order_at ? date(m.last_order_at) : "None"}</td><td className="p-3">{m.marketing_opt_in ? "Opted in" : "No"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type CampaignPreview = { dry_run: boolean; opted_in: number; recipients: number; capped: boolean };
type CampaignRow = { id: string; segment: string; title: string; message: string; link: string; recipients: number; at: string };

function CampaignsTab() {
  const toast = useToast();
  const [segs, setSegs] = useState<Seg[]>([]);
  const [segment, setSegment] = useState("never_ordered");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [log, setLog] = useState<CampaignRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadLog = () => api<{ items: CampaignRow[] }>("/api/admin/growth/campaigns").then((x) => setLog(x.items)).catch(quietly);
  useEffect(() => { api<{ segments: Seg[] }>("/api/admin/growth/segments").then((x) => setSegs(x.segments)).catch(quietly); void loadLog(); }, []);
  async function go(dry: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<CampaignPreview>("/api/admin/growth/campaigns", { method: "POST", body: { segment, title, message, link, dry_run: dry } });
      if (dry) setPreview(r);
      else { setPreview(null); setTitle(""); setMessage(""); setLink(""); toast(`Sent to ${r.recipients} customers`); void loadLog(); }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPreview(null); };
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-xl bg-white p-5">
        <p className="text-sm text-ink-soft">Preview first: it counts who would get the message and sends nothing. In-app only, and only to customers who opted in to marketing.</p>
        <select className="rounded-lg border px-3 py-2 text-sm" value={segment} onChange={(e) => edit(setSegment)(e.target.value)} aria-label="Segment">
          {(segs.length ? segs : [{ key: "never_ordered", label: "Never placed an order", count: 0 }]).map((g) => <option key={g.key} value={g.key}>{g.label} ({g.count})</option>)}
        </select>
        <input className="rounded-lg border px-3 py-2 text-sm" maxLength={80} placeholder="Title" value={title} onChange={(e) => edit(setTitle)(e.target.value)} />
        <textarea className="rounded-lg border px-3 py-2 text-sm" maxLength={300} rows={3} placeholder="Message" value={message} onChange={(e) => edit(setMessage)(e.target.value)} />
        <input className="rounded-lg border px-3 py-2 text-sm" maxLength={200} placeholder="Page to open, like /offers (optional)" value={link} onChange={(e) => edit(setLink)(e.target.value)} />
        <ErrorNote message={err} />
        <div className="flex items-center gap-2">
          <Button onClick={() => go(true)} loading={busy && !preview} disabled={!title.trim() || !message.trim()}>Preview</Button>
          {preview && preview.recipients > 0 && <Button variant="buy" onClick={() => go(false)} loading={busy}>Send to {preview.recipients}</Button>}
          {preview && <span className="text-sm text-ink-soft" data-testid="campaign-preview">{preview.opted_in} opted in{preview.capped ? `, capped at ${preview.recipients}` : ""}</span>}
        </div>
      </section>
      {log.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-white">
          <table className="w-full text-left text-sm" data-testid="campaigns">
            <thead><tr className="border-b border-line"><th className="p-3">Sent</th><th className="p-3">Segment</th><th className="p-3">Title</th><th className="p-3">People</th></tr></thead>
            <tbody>{log.map((c) => <tr key={c.id} className="border-b border-line/50"><td className="p-3">{date(c.at)}</td><td className="p-3">{c.segment.replaceAll("_", " ")}</td><td className="p-3 font-semibold">{c.title}</td><td className="p-3">{c.recipients}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
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
      <Tabs value={tab} onChange={setTab} items={[{ value: "settings", label: "Settings" }, { value: "scorecard-view", label: "Seller scorecard" }, { value: "gift-cards", label: "Gift cards" }, { value: "segments", label: "Segments" }, { value: "campaigns", label: "Campaigns" }, { value: "cart-reminders", label: "Cart reminders" }]} />
      {tab === "gift-cards" ? <GiftCardsTab /> : tab === "cart-reminders" ? <CartRemindersTab /> : tab === "segments" ? <SegmentsTab /> : tab === "campaigns" ? <CampaignsTab /> : tab === "scorecard-view" ? (
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
