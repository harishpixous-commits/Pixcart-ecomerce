"use client";

import { Gift, Heart, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui";
import { ApiError, api, quietly } from "@/lib/api";
import { date, rupees } from "@/lib/format";

type Loyalty = { enabled: boolean; balance: number; lifetime: number; tier: string; value_paise: number; history: { kind: string; points: number; note: string; at: string }[] };
type Referral = { enabled: boolean; code: string; referrer_reward_paise: number; friend_reward_paise: number; min_order_paise: number; joined: number; rewarded: number; earned_paise: number; used_code: boolean };
type Made = { code: string; discount_paise: number; min_order_paise: number; valid_days: number };

type Options = { can_buy: boolean; min_paise: number; max_paise: number };
type Purchase = { id: string; status: string; amount_paise: number; error: string; code?: string; expires_at?: string; payment?: { mode: string; url?: string } };
const PENDING_KEY = "pixcart.giftPurchase";

const say = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

/** Rewards: loyalty points (turn into a coupon), your referral code, and gift card redeem. Each part shows only when staff switched it on. */
export default function RewardsPage() {
  const toast = useToast();
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [referral, setReferral] = useState<Referral | null>(null);
  const [points, setPoints] = useState("");
  const [friendCode, setFriendCode] = useState("");
  const [card, setCard] = useState("");
  const [cardInfo, setCardInfo] = useState<{ balance_paise: number; status: string; expires_at: string } | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [amount, setAmount] = useState("");
  const [purchase, setPurchase] = useState<Purchase | null>(null);

  const load = () => {
    api<Loyalty>("/api/loyalty").then(setLoyalty).catch(quietly);
    api<Referral>("/api/referral").then(setReferral).catch(quietly);
    api<Options>("/api/gift-cards/options").then(setOptions).catch(quietly);
  };
  useEffect(load, []);
  // a payment started earlier (the shopper left to pay and came back): offer to check it
  useEffect(() => {
    const id = typeof window !== "undefined" ? window.localStorage.getItem(PENDING_KEY) : null;
    if (id) setPurchase({ id, status: "created", amount_paise: 0, error: "" });
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { toast(say(e)); } finally { setBusy(false); }
  }
  const redeemPoints = () => run(async () => {
    setMade(await api<Made>("/api/loyalty/redeem", { method: "POST", body: { points: Number(points) } }));
    setPoints(""); load();
  });
  const applyFriend = () => run(async () => {
    await api("/api/referral/apply", { method: "POST", body: { code: friendCode.trim() } });
    toast("Referral code added. You both earn after your first delivered order."); setFriendCode(""); load();
  });
  const checkCard = () => run(async () => { setCardInfo(await api("/api/gift-cards/balance", { method: "POST", body: { code: card.trim() } })); });
  const redeemCard = () => run(async () => { setMade(await api<Made>("/api/gift-cards/redeem", { method: "POST", body: { code: card.trim() } })); setCardInfo(null); setCard(""); });
  const buyCard = () => run(async () => {
    const p = await api<Purchase>("/api/gift-cards/purchase", { method: "POST", body: { amount_paise: Math.round(Number(amount) * 100) } });
    if (p.payment?.mode !== "redirect" || !p.payment.url) { toast("This payment method is not supported for gift cards yet. Please try again later."); return; }
    window.localStorage.setItem(PENDING_KEY, p.id);
    setPurchase(p);
    window.open(p.payment.url, "_blank", "noopener");
  });
  const checkBuy = () => run(async () => {
    if (!purchase) return;
    const p = await api<Purchase>(`/api/gift-cards/purchase/${purchase.id}/check`, { method: "POST", body: {} });
    setPurchase(p);
    if (p.status !== "created") window.localStorage.removeItem(PENDING_KEY);
    if (p.status === "created") toast("We have not received the payment yet. Finish paying, then check again.");
  });
  const copy = (t: string) => { navigator.clipboard?.writeText(t).catch(() => {}); toast(`Code ${t} copied. Apply it at checkout.`); };

  return (
    <div className="flex flex-col gap-4">
      <header className="rounded-xl bg-white p-4 sm:p-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold sm:text-3xl"><Gift className="h-7 w-7 text-vermilion" /> Rewards</h1>
        <p className="text-ink-soft">Points, referrals and gift cards turn into a coupon you apply at checkout.</p>
      </header>
      {made && (
        <div className="rounded-xl border-2 border-dashed border-peacock bg-peacock-light p-4" data-testid="made-coupon">
          <p className="font-semibold">Your coupon: {rupees(made.discount_paise)} off, valid {made.valid_days} days</p>
          <button type="button" onClick={() => copy(made.code)} className="mt-2 rounded-lg border border-dashed border-peacock px-3 py-2 font-mono font-semibold text-peacock">{made.code}</button>
          <p className="mt-1 text-sm text-ink-soft">Needs an order of at least {rupees(made.min_order_paise)}. One use only.</p>
        </div>
      )}
      {loyalty?.enabled && (
        <section className="rounded-xl bg-white p-4 sm:p-6">
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Heart className="h-5 w-5 text-vermilion" /> Loyalty points</h2>
          <p className="mt-1">{loyalty.balance} points ({rupees(loyalty.value_paise)}) · {loyalty.tier} tier</p>
          <div className="mt-3 flex gap-2">
            <input value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Points to use" aria-label="Points to use" className="w-40 rounded-lg border border-line px-3 py-2" />
            <button type="button" disabled={busy || !points} onClick={redeemPoints} className="rounded-full bg-peacock px-5 py-2 font-semibold text-white disabled:opacity-50">Get coupon</button>
          </div>
          <ul className="mt-3 divide-y divide-line text-sm">
            {loyalty.history.slice(0, 10).map((h, i) => (<li key={i} className="flex justify-between py-1.5"><span>{h.note || h.kind} <span className="text-ink-soft">{date(h.at)}</span></span><span className={h.points < 0 ? "text-vermilion" : "text-peacock"}>{h.points > 0 ? "+" : ""}{h.points}</span></li>))}
          </ul>
        </section>
      )}
      {referral?.enabled && (
        <section className="rounded-xl bg-white p-4 sm:p-6">
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Users className="h-5 w-5 text-vermilion" /> Refer a friend</h2>
          <p className="mt-1 text-ink-soft">Share your code. After their first delivered order of {rupees(referral.min_order_paise)} or more, you get {rupees(referral.referrer_reward_paise)} and they get {rupees(referral.friend_reward_paise)}, as loyalty points.</p>
          <button type="button" onClick={() => copy(referral.code)} className="mt-2 rounded-lg border border-dashed border-peacock bg-peacock-light px-3 py-2 font-mono font-semibold text-peacock">{referral.code}</button>
          <p className="mt-2 text-sm text-ink-soft">{referral.joined} joined, {referral.rewarded} rewarded.</p>
          {!referral.used_code && (
            <div className="mt-3 flex gap-2">
              <input value={friendCode} onChange={(e) => setFriendCode(e.target.value)} placeholder="Friend's code" aria-label="Friend's referral code" className="w-48 rounded-lg border border-line px-3 py-2" />
              <button type="button" disabled={busy || !friendCode.trim()} onClick={applyFriend} className="rounded-full border border-peacock px-5 py-2 font-semibold text-peacock disabled:opacity-50">Add code</button>
            </div>
          )}
        </section>
      )}
      {options?.can_buy && (
        <section className="rounded-xl bg-white p-4 sm:p-6" data-testid="buy-gift-card">
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Gift className="h-5 w-5 text-vermilion" /> Buy a gift card</h2>
          <p className="mt-1 text-sm text-ink-soft">From {rupees(options.min_paise)} to {rupees(options.max_paise)}. The card code appears here after your payment is confirmed.</p>
          {purchase?.status === "issued" && purchase.code ? (
            <p className="mt-3 font-semibold">Your gift card: <span className="font-mono text-peacock">{purchase.code}</span> ({rupees(purchase.amount_paise)}, expires {date(purchase.expires_at ?? "")}). Save this code.</p>
          ) : purchase?.status === "failed" ? (
            <p className="mt-3 text-vermilion">{purchase.error || "The payment did not go through."}</p>
          ) : purchase ? (
            <button type="button" disabled={busy} onClick={checkBuy} className="mt-3 rounded-full bg-peacock px-5 py-2 font-semibold text-white disabled:opacity-50">I have paid, check now</button>
          ) : null}
          {(!purchase || purchase.status === "failed" || purchase.status === "issued") && (
            <div className="mt-3 flex gap-2">
              <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Amount in rupees" aria-label="Gift card amount in rupees" className="w-44 rounded-lg border border-line px-3 py-2" />
              <button type="button" disabled={busy || !amount} onClick={buyCard} className="rounded-full bg-peacock px-5 py-2 font-semibold text-white disabled:opacity-50">Buy</button>
            </div>
          )}
        </section>
      )}
      <section className="rounded-xl bg-white p-4 sm:p-6">
        <h2 className="flex items-center gap-2 text-xl font-semibold"><Gift className="h-5 w-5 text-vermilion" /> Gift card</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          <input value={card} onChange={(e) => { setCard(e.target.value); setCardInfo(null); }} placeholder="Gift card code" aria-label="Gift card code" className="w-56 rounded-lg border border-line px-3 py-2 font-mono" />
          <button type="button" disabled={busy || card.trim().length < 4} onClick={checkCard} className="rounded-full border border-peacock px-5 py-2 font-semibold text-peacock disabled:opacity-50">Check balance</button>
          {cardInfo && cardInfo.status === "active" && <button type="button" disabled={busy} onClick={redeemCard} className="rounded-full bg-peacock px-5 py-2 font-semibold text-white">Turn {rupees(cardInfo.balance_paise)} into a coupon</button>}
        </div>
        {cardInfo && <p className="mt-2 text-sm">Balance {rupees(cardInfo.balance_paise)}, {cardInfo.status}, expires {date(cardInfo.expires_at)}.</p>}
      </section>
    </div>
  );
}
