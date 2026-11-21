"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, PageLoader, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
import { paiseToInput, toPaise, WEEKDAYS } from "@/lib/format";

type S = {
  shipping_fee_paise: number; free_shipping_threshold_paise: number; cod_enabled: boolean; cod_fee_paise: number; cod_max_order_paise: number; tcs_bps: number; tds_bps: number; commission_gst_bps: number; max_qty_per_item: number;
  feature_wishlist: boolean; feature_reviews: boolean; feature_returns: boolean; feature_coupons: boolean; feature_support: boolean;
  reviews_need_approval: boolean; auto_approve_returns: boolean; transit_days_same_city: number; transit_days_same_state: number; transit_days_national: number;
  auto_cancel_unconfirmed_hours: number; auto_payouts: boolean; payout_min_paise: number; payout_weekday: number; payout_every_weeks: number;
  gallery_zoom: boolean; gallery_zoom_level: number; feature_product_videos: boolean; max_video_mb: number; max_videos_per_listing: number;
};

const FLAGS: [keyof S, string, string][] = [
  ["feature_wishlist", "Wishlist", "Customers can save products for later"],
  ["feature_reviews", "Ratings and reviews", "Customers can rate and review products (more options in Reviews → Settings)"],
  ["feature_returns", "Returns", "Customers can request returns inside the return window"],
  ["auto_approve_returns", "Approve returns automatically", "Skip the seller's approval step; the seller still confirms receipt"],
  ["feature_coupons", "Coupons", "Coupon box and offers list at checkout"],
  ["feature_support", "Help centre", "Customers can raise support tickets"],
  ["auto_payouts", "Automatic payouts", "Create payouts on the payout day (Orders and payouts) for balances above the minimum"],
];

export default function AdminSettings() {
  const toast = useToast();
  const [s, setS] = useState<S | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [cod, setCod] = useState(true);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<S>("/api/admin/settings").then((x) => {
      setS(x);
      setCod(x.cod_enabled);
      setFlags(Object.fromEntries(FLAGS.map(([k]) => [k, Boolean(x[k])])));
      setF({
        shipping: paiseToInput(x.shipping_fee_paise), free: paiseToInput(x.free_shipping_threshold_paise), codFee: paiseToInput(x.cod_fee_paise),
        codMax: paiseToInput(x.cod_max_order_paise), tcs: String(x.tcs_bps / 100), tds: String(x.tds_bps / 100), cgst: String(x.commission_gst_bps / 100), qty: String(x.max_qty_per_item),
        city: String(x.transit_days_same_city), state: String(x.transit_days_same_state), national: String(x.transit_days_national),
        autoCancel: String(x.auto_cancel_unconfirmed_hours), payoutMin: paiseToInput(x.payout_min_paise),
        payDay: String(x.payout_weekday), payEvery: String(x.payout_every_weeks),
      });
    }).catch(quietly);
  }, []);
  const bind = (k: string) => ({ value: f[k] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const bps = (v: string) => Math.round(parseFloat(v) * 100);
    try {
      const body = {
        shipping_fee_paise: toPaise(f.shipping), free_shipping_threshold_paise: toPaise(f.free), cod_enabled: cod, cod_fee_paise: toPaise(f.codFee),
        cod_max_order_paise: toPaise(f.codMax), tcs_bps: bps(f.tcs), tds_bps: bps(f.tds), commission_gst_bps: bps(f.cgst), max_qty_per_item: Number(f.qty),
        transit_days_same_city: Number(f.city), transit_days_same_state: Number(f.state), transit_days_national: Number(f.national),
        auto_cancel_unconfirmed_hours: Number(f.autoCancel), payout_min_paise: toPaise(f.payoutMin), ...flags,
        payout_weekday: Number(f.payDay), payout_every_weeks: Number(f.payEvery),
      };
      if (Object.values(body).some((v) => v === null || (typeof v === "number" && Number.isNaN(v)))) throw new Error("Check that every amount is a number");
      setS(await api<S>("/api/admin/settings", { method: "PUT", body }));
      toast("Settings saved");
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!s) return <PageLoader />;
  return (
    <form onSubmit={save} className="flex max-w-3xl flex-col gap-4">
      <PageHeader title="Marketplace settings" />
      <ErrorNote message={error} />
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Delivery</h2>
        <p className="text-sm text-ink-soft sm:col-span-2">
          Delivery, cash on delivery and all other fees on the customer&apos;s bill can also be set in{" "}
          <Link href="/admin/checkout" className="font-semibold text-peacock">Checkout and fees</Link>, with a live preview.
        </p>
        <TextField label="Delivery fee per seller package (₹)" {...bind("shipping")} />
        <TextField label="Free delivery from (₹, per seller)" {...bind("free")} />
        <TextField label="Maximum quantity per item" {...bind("qty")} />
      </section>
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Cash on delivery</h2>
        <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" className="accent-peacock" checked={cod} onChange={(e) => setCod(e.target.checked)} /> Offer cash on delivery</label>
        <TextField label="COD fee (₹)" {...bind("codFee")} />
        <TextField label="COD available up to (₹ order value)" {...bind("codMax")} />
      </section>
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-3">
        <h2 className="text-lg font-semibold sm:col-span-3">Taxes deducted from seller payouts</h2>
        <TextField label="GST TCS (%)" {...bind("tcs")} hint="Section 52 CGST Act: 0.5% since 10 July 2024" />
        <TextField label="Income-tax TDS (%)" {...bind("tds")} hint="E-commerce TDS: 0.1% since 1 October 2024" />
        <TextField label="GST on commission (%)" {...bind("cgst")} hint="Usually 18%" />
        <p className="text-sm text-ink-soft sm:col-span-3">Changes apply to new orders only. Confirm rates with your chartered accountant.</p>
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-3 text-lg font-semibold">Features</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {FLAGS.map(([k, label, hint]) => (
            <label key={k} className="flex items-start gap-3 rounded-lg border border-line p-3">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={flags[k] ?? false} onChange={(e) => setFlags({ ...flags, [k]: e.target.checked })} />
              <span><span className="font-semibold">{label}</span><br /><span className="text-sm text-ink-soft">{hint}</span></span>
            </label>
          ))}
        </div>
      </section>
      <section className="rounded-xl bg-white p-5 text-sm text-ink-soft">
        <h2 className="mb-1 text-lg font-semibold text-ink">Product page</h2>
        Photo zoom, product videos, unit price, offers, seller snapshot and every other product page block are in{" "}
        <Link href="/admin/product-page" className="font-semibold text-peacock">Product page</Link>; review options in{" "}
        <Link href="/admin/reviews" className="font-semibold text-peacock">Reviews → Settings</Link>.
      </section>
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-3">
        <h2 className="text-lg font-semibold sm:col-span-3">Delivery estimates</h2>
        <p className="text-sm text-ink-soft sm:col-span-3">Days in transit, added to each seller&apos;s dispatch days to show the expected delivery date.</p>
        <TextField label="Same city" {...bind("city")} />
        <TextField label="Same state" {...bind("state")} />
        <TextField label="Rest of India" {...bind("national")} />
      </section>
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Orders and payouts</h2>
        <TextField label="Cancel orders sellers don't confirm within (hours)" {...bind("autoCancel")} hint="0 turns this off. Customers are refunded in full." />
        <TextField label="Minimum payout (₹)" {...bind("payoutMin")} hint="Smaller balances wait for the next run" />
        <Field label="Payout day" htmlFor="payDay" hint="Automatic payouts start at 10:00 IST on this day">
          <Select id="payDay" value={f.payDay} onChange={(e) => setF({ ...f, payDay: e.target.value })}>
            {WEEKDAYS.map((name, i) => <option key={name} value={i}>{name}</option>)}
          </Select>
        </Field>
        <Field label="How often" htmlFor="payEvery" hint="Sellers see the next payout date on their Payouts page">
          <Select id="payEvery" value={f.payEvery} onChange={(e) => setF({ ...f, payEvery: e.target.value })}>
            <option value="1">Every week</option>
            <option value="2">Every two weeks</option>
          </Select>
        </Field>
      </section>
      <Button type="submit" loading={busy} className="self-start">Save settings</Button>
    </form>
  );
}
