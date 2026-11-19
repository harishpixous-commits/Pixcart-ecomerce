"use client";

/*
 * Product page building blocks: offers, service icons, key specifications, seller snapshot, share,
 * "report an issue", "ask a question", the phone buy bar and the browsing-history rail. Each block is
 * switched on or off in Admin → Product page.
 */

import clsx from "clsx";
import {
  Award, BadgeCheck, Ban, Banknote, Bell, BellRing, Check, ChevronDown, Clock, Copy, FileText, Flag, Link2, Mail, MessageCircleQuestion, RotateCcw,
  Share2, ShieldCheck, Star, Tag, ThumbsUp, Truck,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, Modal, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date as fmtDate, rupees } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSite } from "@/lib/site";
import { ProductRail } from "@/components/product";
import type { ProductCard, ProductOffer, ProductPage, SellerSnapshot } from "@/lib/types";
import { readViewed } from "@/lib/wishlist";

export function UnitPrice({ up, className }: { up?: { paise: number; per: string } | null; className?: string }) {
  if (!up) return null;
  return <span className={clsx("text-ink-soft", className)}>({rupees(up.paise)} / {up.per})</span>;
}

/* ---------------------------------------------------------------- offers */

export function OffersBlock({ offers }: { offers: ProductOffer[] }) {
  const toast = useToast();
  const [copied, setCopied] = useState("");
  if (!offers.length) return null;
  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* clipboard blocked: the code is on screen anyway */
    }
    setCopied(code);
    toast(`Code ${code} copied. Apply it at checkout.`);
    setTimeout(() => setCopied(""), 2500);
  }
  return (
    <section aria-labelledby="offers-h">
      <h2 id="offers-h" className="mb-2 flex items-center gap-1.5 text-base font-semibold">
        <Tag className="h-4 w-4 text-vermilion" /> Save extra with {offers.length} {offers.length === 1 ? "offer" : "offers"}
      </h2>
      <div className="scroll-x -mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
        {offers.map((o) => (
          <div key={o.code} className="flex w-[210px] shrink-0 snap-start flex-col rounded-lg border border-line p-3 shadow-sm" data-testid="offer">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{o.source === "seller" ? "Seller offer" : "Store offer"}</p>
            <p className="font-semibold leading-snug">{o.title}</p>
            <p className="line-clamp-2 min-h-[2.5em] text-[13px] text-ink-soft">{o.description || o.terms || "On this product"}</p>
            {o.ends_at && <p className="text-xs text-vermilion">Ends {fmtDate(o.ends_at)}</p>}
            <button type="button" onClick={() => copy(o.code)}
              className="mt-2 flex items-center justify-between rounded-md border border-dashed border-peacock bg-peacock-light px-2 py-1 font-mono text-sm font-semibold text-peacock hover:bg-peacock hover:text-white"
              aria-label={`Copy code ${o.code}`}>
              {o.code}
              {copied === o.code ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- service icons */

export function ServiceIcons({ p, price }: { p: ProductPage; price: number }) {
  const site = useSite();
  const free = price >= site.free_shipping_threshold_paise;
  const items: { icon: typeof Truck; label: string; detail: string; tone?: string }[] = [
    free
      ? { icon: Truck, label: "Free delivery", detail: "No delivery charge on this item" }
      : { icon: Truck, label: `Delivery ${rupees(site.shipping_fee_paise ?? 4000)}`, detail: `Free when you buy ${rupees(site.free_shipping_threshold_paise)} or more from this seller` },
  ];
  if (site.cod_enabled) items.push({ icon: Banknote, label: "Pay on delivery", detail: "Cash, UPI or card when the parcel arrives" });
  items.push(p.return_window_days > 0
    ? { icon: RotateCcw, label: `${p.return_window_days}-day returns`, detail: `Return within ${p.return_window_days} days of delivery if something is wrong` }
    : { icon: Ban, label: "Not returnable", detail: "This item cannot be returned once delivered", tone: "text-ink-faint" });
  if (p.seller_snapshot?.top_seller) items.push({ icon: Award, label: "Top seller", detail: "Highly rated seller with many recent orders" });
  items.push({ icon: BadgeCheck, label: "Verified seller", detail: "Identity, GST and bank details checked" });
  items.push({ icon: FileText, label: "GST invoice", detail: "Download a GST invoice for every order" });
  if (site.online_payments !== false) items.push({ icon: ShieldCheck, label: "Secure payment", detail: "UPI, cards and net banking through a certified gateway" });
  return (
    <ul className="scroll-x -mx-1 flex gap-1 overflow-x-auto px-1 py-1" aria-label="Services">
      {items.map(({ icon: Icon, label, detail, tone }) => (
        <li key={label} className="flex w-[84px] shrink-0 flex-col items-center gap-1 text-center" title={detail}>
          <span className={clsx("flex h-11 w-11 items-center justify-center rounded-full bg-peacock-light", tone ?? "text-peacock")}><Icon className="h-5 w-5" /></span>
          <span className="text-[12px] font-medium leading-tight text-peacock">{label}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- key specs */

export function KeySpecs({ rows, extra }: { rows: { label: string; value: string }[]; extra?: { label: string; value: string }[] }) {
  const all = [...rows, ...(extra ?? [])];
  if (!all.length) return null;
  return (
    <table className="w-full max-w-md text-[14px]">
      <tbody>
        {all.map((r) => (
          <tr key={r.label}>
            <th scope="row" className="w-40 py-1 pr-4 text-left align-top font-semibold">{r.label}</th>
            <td className="py-1 text-ink-soft">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AboutThisItem({ items }: { items: string[] }) {
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  const shown = all ? items : items.slice(0, 5);
  return (
    <section aria-labelledby="about-h">
      <h2 id="about-h" className="mb-1.5 text-lg font-semibold">About this item</h2>
      <ul className="list-disc space-y-1 pl-5 text-[15px] text-ink-soft">
        {shown.map((h) => <li key={h}>{h}</li>)}
      </ul>
      {items.length > 5 && (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 flex items-center gap-1 text-sm font-semibold text-peacock">
          {all ? "Show less" : `Show ${items.length - 5} more`} <ChevronDown className={clsx("h-4 w-4 transition", all && "rotate-180")} />
        </button>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- seller snapshot */

export function SellerSnapshotCard({ seller, snap }: { seller: ProductPage["seller"]; snap: SellerSnapshot }) {
  const site = useSite();
  const tenure = snap.years >= 1 ? `${snap.years}+ ${snap.years === 1 ? "year" : "years"}` : snap.months >= 1 ? `${snap.months} ${snap.months === 1 ? "month" : "months"}` : "New";
  const stats: { icon: typeof Star; text: string }[] = [];
  if (snap.positive_pct !== null) stats.push({ icon: ThumbsUp, text: `${snap.positive_pct}% positive ratings from ${snap.rating_count.toLocaleString("en-IN")} customers` });
  else if (snap.rating_count > 0) stats.push({ icon: Star, text: `${snap.rating_avg.toFixed(1)} out of 5 from ${snap.rating_count} ratings` });
  if (snap.orders_90d) stats.push({ icon: Truck, text: `${snap.orders_90d} orders in the last 3 months` });
  if (snap.on_time_pct !== null) stats.push({ icon: Clock, text: `${snap.on_time_pct}% of orders dispatched on time` });
  stats.push({ icon: BadgeCheck, text: `${tenure} on ${site.brand_name || "this store"}` });
  return (
    <section className="rounded-xl border border-line p-4" aria-labelledby="seller-snap-h" data-testid="seller-snapshot">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="seller-snap-h" className="text-base font-semibold">
          <Link href={`/store/${seller.slug}`} className="hover:text-peacock hover:underline">{seller.name}</Link>
        </h2>
        {snap.top_seller && <span className="flex items-center gap-1 rounded-full bg-marigold-light px-2 py-0.5 text-xs font-semibold text-ink"><Award className="h-3.5 w-3.5" /> Top seller</span>}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm text-ink-soft">
        {stats.map(({ icon: Icon, text }) => <li key={text} className="flex gap-2"><Icon className="mt-0.5 h-4 w-4 shrink-0 text-peacock" />{text}</li>)}
      </ul>
      <Link href={`/store/${seller.slug}`} className="mt-3 inline-block text-sm font-semibold text-peacock hover:underline">Visit the store</Link>
    </section>
  );
}

/* ---------------------------------------------------------------- share */

export function ShareButton({ title }: { title: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const url = typeof window !== "undefined" ? window.location.href.split("#")[0] : "";
  async function click() {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share && window.matchMedia("(pointer: coarse)").matches) {
      try {
        await nav.share({ title, url });
        return;
      } catch {
        /* cancelled: fall through to the menu */
      }
    }
    setOpen((o) => !o);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied");
    } catch {
      toast("Copy the address from the address bar", "error");
    }
    setOpen(false);
  }
  const text = encodeURIComponent(`${title} ${url}`);
  const links = [
    { label: "WhatsApp", href: `https://wa.me/?text=${text}` },
    { label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
    { label: "X (Twitter)", href: `https://twitter.com/intent/tweet?text=${text}` },
  ];
  return (
    <div className="relative" ref={box}>
      <button type="button" onClick={click} aria-expanded={open} className="flex h-10 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-ink-soft ring-1 ring-line hover:bg-mist" data-testid="share">
        <Share2 className="h-4 w-4" /> Share
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-40 w-48 overflow-hidden rounded-lg bg-white py-1 text-sm shadow-xl ring-1 ring-line" role="menu">
          {links.map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="block px-4 py-2 hover:bg-mist" role="menuitem" onClick={() => setOpen(false)}>{l.label}</a>
          ))}
          <a href={`mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`} className="flex items-center gap-2 px-4 py-2 hover:bg-mist" role="menuitem"><Mail className="h-4 w-4" /> Email</a>
          <button type="button" onClick={copy} className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-mist" role="menuitem"><Link2 className="h-4 w-4" /> Copy link</button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- report an issue */

const REPORT_REASONS: [string, string][] = [
  ["wrong_info", "Wrong or missing product information"],
  ["counterfeit", "Fake or counterfeit product"],
  ["unsafe", "Unsafe, expired or harmful"],
  ["prohibited", "Not allowed to be sold"],
  ["offensive", "Offensive images or text"],
  ["price", "Lower price elsewhere / misleading price"],
  ["other", "Something else"],
];

export function ReportProduct({ slug }: { slug: string }) {
  const { user } = useSession();
  const pathname = usePathname();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const needsNote = ["wrong_info", "other", "counterfeit", "unsafe"].includes(reason);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return setError("Choose what is wrong");
    if (needsNote && note.trim().length < 10) return setError("Tell us a little more (at least 10 characters)");
    setBusy(true);
    setError("");
    try {
      await api(`/api/catalog/products/${slug}/report`, { method: "POST", body: { reason, note, url } });
      setOpen(false);
      setReason(""); setNote(""); setUrl("");
      toast("Thank you. Our team will look into it.");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not send the report");
    } finally {
      setBusy(false);
    }
  }
  if (!user) {
    return <Link href={`/login?next=${encodeURIComponent(pathname)}`} className="flex items-center gap-1.5 text-sm text-ink-faint hover:text-peacock"><Flag className="h-4 w-4" /> Sign in to report an issue with this product</Link>;
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-sm text-ink-faint hover:text-peacock" data-testid="report-product">
        <Flag className="h-4 w-4" /> Report an issue with this product
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Report an issue with this product">
        <form onSubmit={send} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-semibold">What is wrong?</legend>
            {REPORT_REASONS.map(([k, label]) => (
              <label key={k} className={clsx("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm", reason === k ? "border-peacock bg-peacock-light" : "border-line hover:border-peacock/50")}>
                <input type="radio" name="report-reason" value={k} checked={reason === k} onChange={() => { setReason(k); setError(""); }} className="accent-peacock" />
                {label}
              </label>
            ))}
          </fieldset>
          {reason === "price" && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-semibold">Where did you see it? (optional)</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className="h-10 rounded-lg border border-line px-3" />
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-semibold">Details {needsNote ? "" : "(optional)"}</span>
            <Textarea rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you notice?" />
          </label>
          {error && <p className="text-sm text-vermilion">{error}</p>}
          <p className="text-xs text-ink-faint">Our team checks every report. The seller sees what was reported, not who reported it.</p>
          <Button type="submit" loading={busy}>Send report</Button>
        </form>
      </Modal>
    </>
  );
}

/* ---------------------------------------------------------------- ask a question */

export function AskAboutProduct({ title, className }: { title: string; className?: string }) {
  return (
    <button type="button" className={clsx("flex items-center gap-1.5 text-sm font-semibold text-peacock hover:underline", className)}
      onClick={() => window.dispatchEvent(new CustomEvent("shop-assistant:open", { detail: { text: `About "${title.slice(0, 80)}": ` } }))}>
      <MessageCircleQuestion className="h-4 w-4" /> Ask a question
    </button>
  );
}

/* ---------------------------------------------------------------- phone buy bar */

export function StickyBuyBar({ watch, price, mrp, title, image, onAdd, onBuy, disabled, busy }: {
  watch: React.RefObject<HTMLElement | null>; price: number; mrp: number; title: string; image: string;
  onAdd: () => void; onBuy: () => void; disabled: boolean; busy: "cart" | "buy" | null;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = watch.current;
    if (!el) return;
    // Shown whenever the page's own buttons are out of sight (above or below), as in shopping apps.
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [watch]);
  useEffect(() => {
    if (show) document.body.dataset.buyBar = "1";
    else delete document.body.dataset.buyBar;
    return () => { delete document.body.dataset.buyBar; };
  }, [show]);
  return (
    <div className={clsx("fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-20 border-t border-line bg-white/95 px-3 py-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur transition-transform sm:bottom-0 lg:hidden",
      show ? "translate-y-0" : "pointer-events-none translate-y-[150%]")} aria-hidden={!show} data-testid="buy-bar">
      <div className="mx-auto flex max-w-shop items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {image && <img src={image} alt="" className="hidden h-10 w-10 rounded object-contain sm:block" />}
        <div className="min-w-0 flex-1">
          <p className="hidden truncate text-sm sm:block">{title}</p>
          <p className="font-display text-lg font-bold leading-tight">{rupees(price)} {mrp > price && <span className="text-sm font-normal text-ink-faint line-through">{rupees(mrp)}</span>}</p>
        </div>
        <Button variant="cart" onClick={onAdd} disabled={disabled} loading={busy === "cart"} tabIndex={show ? 0 : -1}>Add to cart</Button>
        <Button variant="buy" onClick={onBuy} disabled={disabled} loading={busy === "buy"} tabIndex={show ? 0 : -1}>Buy now</Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- browsing history */

const noSubscribe = () => () => {};

export function RecentlyViewedRail({ currentId }: { currentId: string }) {
  // read once from this browser's storage after hydration (the server renders nothing here)
  const raw = useSyncExternalStore(noSubscribe, () => JSON.stringify(readViewed()), () => "[]");
  const items = useMemo(() => (JSON.parse(raw) as ReturnType<typeof readViewed>).filter((x) => x.id !== currentId), [raw, currentId]);
  if (items.length < 1) return null;
  return (
    <section className="rounded-xl bg-white p-4 sm:p-6" aria-labelledby="recent-h">
      <h2 id="recent-h" className="mb-3 text-xl font-semibold">Your browsing history</h2>
      <div className="scroll-x flex gap-3 overflow-x-auto">
        {items.map((x) => (
          <Link key={x.id} href={`/p/${x.slug}`} className="w-32 shrink-0 hover:text-peacock">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={x.image} alt={x.title} className="mb-1 aspect-square w-full rounded-lg bg-mist object-contain" />
            <p className="line-clamp-2 text-sm">{x.title}</p>
            <p className="font-display font-bold">{rupees(x.price)}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- sponsored rail and notify me */

export function SponsoredRail({ slug }: { slug: string }) {
  const [items, setItems] = useState<ProductCard[]>([]);
  useEffect(() => {
    let live = true;
    api<{ items: ProductCard[] }>("/api/ads/serve", { query: { placement: "product", product: slug, limit: 10 } })
      .then((r) => { if (live) setItems(r.items); }).catch(() => {});
    return () => { live = false; };
  }, [slug]);
  if (!items.length) return null;
  return <ProductRail title="Sponsored products related to this item" items={items} note="Sponsored" />;
}

/** "Notify me when available" for an out-of-stock version. */
export function NotifyMe({ variantId }: { variantId: string }) {
  const { user, ready } = useSession();
  const pathname = usePathname();
  const toast = useToast();
  const [state, setState] = useState<{ id: string; on: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ready || !user) return;
    let live = true;
    api<{ stock: { variant_id: string }[] }>("/api/alerts", { query: { variant_id: variantId } })
      .then((r) => { if (live) setState({ id: variantId, on: r.stock.length > 0 }); }).catch(() => {});
    return () => { live = false; };
  }, [ready, user, variantId]);
  const on = state?.id === variantId && state.on;
  if (!user) {
    return <Link href={`/login?next=${encodeURIComponent(pathname)}`} className="flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-peacock font-semibold text-peacock hover:bg-peacock-light" data-testid="notify-me">
      <Bell className="h-5 w-5" /> Sign in to get notified
    </Link>;
  }
  async function toggle() {
    setBusy(true);
    try {
      if (on) await api(`/api/alerts/stock/${variantId}`, { method: "DELETE" });
      else await api("/api/alerts/stock", { method: "POST", body: { variant_id: variantId } });
      setState({ id: variantId, on: !on });
      toast(on ? "Alert removed" : "We will tell you as soon as it is back");
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not update the alert", "error");
    } finally {
      setBusy(false);
    }
  }
  return on ? (
    <div className="flex flex-col gap-1 rounded-xl bg-leaf-light p-3 text-sm" data-testid="notify-me">
      <p className="flex items-center gap-1.5 font-semibold text-leaf"><BellRing className="h-4 w-4" /> We will notify you when it is back</p>
      <button type="button" onClick={toggle} disabled={busy} className="self-start text-ink-soft hover:text-vermilion">Stop this alert</button>
    </div>
  ) : (
    <Button variant="secondary" size="lg" onClick={toggle} loading={busy} className="w-full rounded-full" data-testid="notify-me"><Bell className="h-5 w-5" /> Notify me when available</Button>
  );
}
