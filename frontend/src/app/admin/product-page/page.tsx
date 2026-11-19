"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, PageLoader, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";

/*
 * Admin → Product page: every block of the product page can be switched on or off here, with the few
 * numbers that tune them. Legal information (seller identity, grievance officer, country of origin,
 * Legal Metrology declarations) is always shown and has no switch.
 */

type S = Record<string, boolean | number>;

const GROUPS: { title: string; sub: string; items: [string, string, string][] }[] = [
  {
    title: "Price and buying",
    sub: "Beside the price and in the buy box.",
    items: [
      ["pdp_unit_price", "Unit price", "₹ per 100 g, kg, litre or piece next to the price, from the net quantity sellers enter."],
      ["pdp_offers", "Offers on the product page", "Coupons this product qualifies for (store-wide, its category or the seller's own), with a copy-code button."],
      ["pdp_service_icons", "Service icons", "Free delivery, pay on delivery, returns, top seller, verified seller, GST invoice and secure payment."],
      ["pdp_delivery_countdown", "Order-within countdown", "\"Order within 2 hrs 10 mins\" when the seller has set a daily dispatch cut-off time."],
      ["pdp_sticky_bar", "Buy bar on phones", "Price, Add to cart and Buy now stay at the bottom of the screen while the shopper scrolls."],
      ["header_pincode", "Delivery PIN in the header", "\"Deliver to 641001\" on every page; delivery dates and charges follow it. Signed-in shoppers start from their default address."],
    ],
  },
  {
    title: "Trust and social proof",
    sub: "Only real figures are shown; weak numbers are left out.",
    items: [
      ["pdp_bought_count", "Bought in the past month", "\"300+ bought in the past month\" from units sold in the last 30 days."],
      ["pdp_bestseller_badge", "Best seller badge and rank", "\"#1 Best seller in <category>\" for the top 10 in a category, and the rank in Item details."],
      ["pdp_seller_snapshot", "Seller snapshot", "Positive ratings, orders in 3 months, on-time dispatch and time on the store, with a Top seller badge."],
      ["pdp_customer_media", "Customer photos under the gallery", "Thumbnails of photos and videos from reviews, opening a viewer with the review beside each one."],
    ],
  },
  {
    title: "Information and help",
    sub: "",
    items: [
      ["pdp_key_specs", "Key specifications beside the price", "Up to 6 specifications the seller marks as key (otherwise the first few), plus the net quantity."],
      ["pdp_ask_assistant", "Ask a question", "Opens the shop assistant with the product named, so shoppers get answers without leaving the page."],
      ["pdp_share", "Share", "WhatsApp, Facebook, X, email and copy link; the phone's own share sheet on mobiles."],
      ["pdp_report", "Report an issue with this product", "Signed-in shoppers report wrong information, fakes, unsafe or banned items. Reports go to Product reports."],
    ],
  },
  {
    title: "Questions and answers",
    sub: "Shoppers ask on the product page; the seller and other shoppers answer. Posts with phone numbers, emails or links always wait for a check in Questions.",
    items: [
      ["feature_qa", "Questions and answers", "A Q&A section on every product page. Only signed-in shoppers can ask, answer or vote; guests can read."],
      ["qa_need_approval", "Check every post first", "Questions and answers wait in Admin → Questions before they appear."],
      ["qa_buyers_answer_only", "Only the seller and buyers answer", "Shoppers who have not received the product cannot answer questions."],
    ],
  },
  {
    title: "Alerts",
    sub: "Sent by email, SMS or push, following each shopper's notification choices.",
    items: [
      ["feature_stock_alerts", "Notify me when it is back", "Out-of-stock versions show a Notify me button; signed-in shoppers get a message when stock returns."],
      ["feature_price_alerts", "Wishlist price drops", "Shoppers get a message when a product in their wishlist gets cheaper."],
    ],
  },
  {
    title: "Compare and bundles",
    sub: "",
    items: [
      ["feature_compare", "Compare products", "\"Add to compare\" on product cards and product pages, a compare tray, and up to 4 products side by side."],
      ["feature_bought_together", "Frequently bought together", "Products often ordered together, worked out from real orders, with one click to add them all."],
    ],
  },
  {
    title: "More products",
    sub: "",
    items: [
      ["pdp_similar", "Customers also viewed", "Popular products from the same category."],
      ["pdp_recently_viewed", "Browsing history", "Products this shopper opened recently (kept in their browser only)."],
      ["page_loading_bar", "Page loading bar", "A thin bar at the top of the window while the next page loads, across the store, seller hub and admin."],
    ],
  },
];

function Toggle({ k, label, hint, s, set }: { k: string; label: string; hint: string; s: S; set: (k: string, v: boolean | number) => void }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-line p-3">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={Boolean(s[k])} onChange={(e) => set(k, e.target.checked)} data-testid={`toggle-${k}`} />
      <span><span className="font-semibold">{label}</span><br /><span className="text-sm text-ink-soft">{hint}</span></span>
    </label>
  );
}

export default function ProductPageSettings() {
  const toast = useToast();
  const [s, setS] = useState<S | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<S>("/api/admin/settings").then(setS).catch(quietly); }, []);
  if (!s) return <PageLoader />;
  const set = (k: string, v: boolean | number) => setS({ ...s, [k]: v });
  const num = (k: string) => ({ value: String(s[k] ?? ""), inputMode: "numeric" as const, onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value.replace(/\D/g, "")) || 0) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    const newDays = Number(s.new_release_days);
    if (!Number.isInteger(newDays) || newDays < 7 || newDays > 180) {
      setError("Hot new releases: enter 7 to 180 days");
      return;
    }
    const drop = Number(s.price_alert_min_drop_pct);
    if (!Number.isInteger(drop) || drop < 1 || drop > 90) {
      setError("Price drop alerts: enter 1 to 90 percent");
      return;
    }
    setBusy(true);
    setError(null);
    const keys = [...GROUPS.flatMap((g) => g.items.map(([k]) => k)), "pdp_bought_min", "pdp_offers_max", "top_seller_min_rating_x10", "top_seller_min_orders",
      "gallery_zoom", "gallery_zoom_level", "feature_product_videos", "max_video_mb", "max_videos_per_listing", "new_release_days", "price_alert_min_drop_pct"];
    try {
      setS(await api<S>("/api/admin/settings", { method: "PUT", body: Object.fromEntries(keys.map((k) => [k, s[k]])) }));
      toast("Product page settings saved");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex max-w-4xl flex-col gap-4">
      <PageHeader title="Product page" sub="Choose what shoppers see on every product page. Changes show at once." />
      <ErrorNote message={error} />

      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">Photos and videos</h2>
        <Toggle k="gallery_zoom" label="Zoom on hover" hint="On a computer, moving the mouse over a photo shows a magnified view beside it. Clicking always opens the full-screen viewer." s={s} set={set} />
        <label className="flex flex-col gap-1 rounded-lg border border-line p-3">
          <span className="font-semibold">Zoom strength</span>
          <Select value={Number(s.gallery_zoom_level)} onChange={(e) => set("gallery_zoom_level", Number(e.target.value))} disabled={!s.gallery_zoom} aria-label="Zoom strength">
            {[[15, "1.5×"], [20, "2×"], [25, "2.5× (recommended)"], [30, "3×"], [40, "4×"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          <span className="text-xs text-ink-faint">Upload photos at least 1000 px wide so the zoom stays sharp.</span>
        </label>
        <Toggle k="feature_product_videos" label="Product videos" hint="Sellers can add MP4 or WebM videos; customers play them from the gallery. Off hides existing videos too." s={s} set={set} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Largest video (MB)" {...num("max_video_mb")} hint="5 to 200" disabled={!s.feature_product_videos} />
          <TextField label="Videos per listing" {...num("max_videos_per_listing")} hint="0 to 10" disabled={!s.feature_product_videos} />
        </div>
      </section>

      {GROUPS.map((g) => (
        <section key={g.title} id={g.title === "Questions and answers" ? "qa" : undefined} className="grid scroll-mt-24 gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <h2 className="text-lg font-semibold">{g.title}</h2>
            {g.sub && <p className="text-sm text-ink-soft">{g.sub}</p>}
          </div>
          {g.items.map(([k, label, hint]) => <Toggle key={k} k={k} label={label} hint={hint} s={s} set={set} />)}
          {g.title === "Alerts" && (
            <TextField label="Price drop: at least (%)" {...num("price_alert_min_drop_pct")} hint="Smaller drops are not sent. 1 to 90." disabled={!s.feature_price_alerts} />
          )}
          {g.title === "Price and buying" && (
            <TextField label="Offers shown at most" {...num("pdp_offers_max")} hint="1 to 10" disabled={!s.pdp_offers} />
          )}
          {g.title === "Trust and social proof" && (
            <div className={clsx("grid gap-3 sm:col-span-2 sm:grid-cols-3")}>
              <TextField label="'Bought' line from (units in 30 days)" {...num("pdp_bought_min")} hint="Below this, the line is not shown" disabled={!s.pdp_bought_count} />
              <TextField label="Top seller: rating at least (×10)" {...num("top_seller_min_rating_x10")} hint="40 = 4.0 stars (30 to 50)" disabled={!s.pdp_seller_snapshot} />
              <TextField label="Top seller: orders in 90 days" {...num("top_seller_min_orders")} hint="And at least 5 ratings" disabled={!s.pdp_seller_snapshot} />
            </div>
          )}
        </section>
      ))}

      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <h2 className="text-lg font-semibold">Discovery pages</h2>
          <p className="text-sm text-ink-soft">Bestsellers and Hot new releases rank products by units sold in the last 30 days.</p>
        </div>
        <TextField label="Hot new releases: products launched in the last N days" {...num("new_release_days")} hint="7 to 180 days, counted from when the listing went live" />
      </section>

      <section className="rounded-xl bg-white p-5 text-sm text-ink-soft">
        <h2 className="mb-1 text-lg font-semibold text-ink">Related settings</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li><Link href="/admin/reviews" className="font-semibold text-peacock">Reviews → Settings</Link>: who can review, customer photos and videos, moderation, topics and guidelines.</li>
          <li><Link href="/admin/categories" className="font-semibold text-peacock">Categories</Link>: the product information (net quantity, manufacturer, FSSAI licence and more) each category requires before a listing can be submitted.</li>
          <li><Link href="/admin/coupons" className="font-semibold text-peacock">Coupons</Link>: coupons marked &ldquo;show in the offers list&rdquo; appear on product pages.</li>
          <li><Link href="/admin/deals" className="font-semibold text-peacock">Deals → Rules</Link> and <Link href="/admin/advertising" className="font-semibold text-peacock">Advertising → Settings</Link>: deal badges, countdowns and Sponsored rows on product pages.</li>
          <li><Link href="/admin/questions" className="font-semibold text-peacock">Questions</Link>: check, publish or hide questions and answers.</li>
          <li><Link href="/admin/settings" className="font-semibold text-peacock">Marketplace settings</Link>: delivery fee, free-delivery amount, cash on delivery and transit days used in delivery dates.</li>
          <li>Seller identity, GSTIN, grievance officer and country of origin are always shown, as the Consumer Protection (E-Commerce) Rules require.</li>
        </ul>
      </section>
      <Button type="submit" loading={busy} className="self-start">Save product page settings</Button>
    </form>
  );
}
