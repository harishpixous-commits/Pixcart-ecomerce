"use client";

import { AlertTriangle, Check, ChevronRight, ExternalLink, LifeBuoy, LogIn, Package, Star, Truck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Markdown } from "@/components/markdown";
import { api, ApiError } from "@/lib/api";
import { rupees } from "@/lib/format";

/* Cards the shop assistant shows to customers. Every field comes from the server's customer-safe views. */

type ProductCard = { id: string; slug: string; title: string; brand: string; image: string; price: number; mrp: number; discount_pct: number; rating_avg: number; rating_count: number; in_stock: boolean; seller_name: string };
type Step = { key: string; label: string; done: boolean };
type Pkg = {
  id: string; number: string; status: string; status_label: string; seller: string; steps: Step[];
  items: { title: string; variant: string; image: string; qty: number; amount: string }[];
  expected_delivery_at: string | null; delivered_at: string | null; cancel_reason: string; courier: string; tracking_number: string; tracking_url: string;
  can_cancel: boolean; can_return: boolean; return_by: string | null;
};
export type OrderView = {
  id: string; number: string; placed_at: string; status: string; payment: string; payment_status: string; total: string; refunded: string; link: string;
  packages: Pkg[]; refunds: { amount: string; status: string; at: string }[]; returns: { number: string; status: string; reason: string; refund_amount: string }[];
};
type OrderRow = { id: string; number: string; placed_at: string; status: string; total_text: string; item_count: number; items: { title: string; image: string; qty: number }[]; link: string };
type TicketRow = { id: string; number: string; subject: string; status_label: string; updated_at: string; link: string; last_team_reply?: { text: string; at: string } | null };

export type Card =
  | { type: "text"; text: string }
  | { type: "chips"; items: string[] }
  | { type: "products"; title: string; items: ProductCard[]; link: string }
  | { type: "order"; order: OrderView }
  | { type: "orders"; title: string; items: OrderRow[]; link: string }
  | { type: "tickets"; title: string; items: TicketRow[]; link: string }
  | { type: "returns"; title: string; returns: { number: string; status: string; reason: string; refund_amount: string; package: string; link: string }[]; refunds: { order: string; amount: string; status: string }[] }
  | { type: "article"; title: string; text: string; link: string }
  | { type: "signin"; text: string; link: string }
  | { type: "link"; text: string; link: string }
  | { type: "confirm"; action_id: string; title: string; summary: string; items: string[]; note: string; confirm_label: string; status: string; error?: string }
  | { type: "ticket_form"; category: string; categories: { code: string; label: string }[]; subject: string; message: string; order_id: string; orders: { id: string; number: string }[]; grievance: boolean; status?: string; ticket_number?: string }
  | { type: "error"; text: string };

export type Msg = { id: string; role: "user" | "assistant"; text: string; blocks: Card[]; streaming?: boolean; working?: string; status?: string };

const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "");

function Products({ c }: { c: Extract<Card, { type: "products" }> }) {
  return (
    <div>
      {c.title && <p className="mb-1.5 text-xs font-semibold text-ink-soft">{c.title}</p>}
      <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
        {c.items.map((p) => (
          <Link key={p.id} href={`/p/${p.slug}`} className="w-36 shrink-0 snap-start rounded-xl border border-line bg-white p-2 hover:border-peacock">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.image || "/icon.svg"} alt="" className="mb-1.5 h-24 w-full rounded-lg object-contain" loading="lazy" />
            <p className="line-clamp-2 text-xs font-medium leading-snug">{p.title}</p>
            <p className="mt-1 text-sm font-bold">{rupees(p.price)} {p.mrp > p.price && <span className="text-xs font-normal text-ink-faint line-through">{rupees(p.mrp)}</span>}</p>
            <p className="flex items-center gap-1 text-[11px] text-ink-faint">
              {p.discount_pct > 0 && <span className="font-semibold text-leaf">{p.discount_pct}% off</span>}
              {p.rating_count > 0 && <span className="inline-flex items-center gap-0.5"><Star className="h-3 w-3 fill-current text-marigold" />{p.rating_avg.toFixed(1)}</span>}
              {!p.in_stock && <span className="text-vermilion">Out of stock</span>}
            </p>
          </Link>
        ))}
      </div>
      {c.link && c.items.length > 1 && <Link href={c.link} className="mt-1 inline-flex items-center text-xs font-semibold text-peacock">See all results <ChevronRight className="h-3 w-3" /></Link>}
    </div>
  );
}

function Order({ o, onSend }: { o: OrderView; onSend: (t: string) => void }) {
  return (
    <div className="rounded-xl border border-line bg-white p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">Order {o.number}</p>
          <p className="text-xs text-ink-faint">Placed {date(o.placed_at)} · {o.payment} · {o.total}</p>
        </div>
        <span className="rounded-full bg-peacock-light px-2 py-0.5 text-xs font-semibold text-peacock">{o.status}</span>
      </div>
      {o.packages.map((p) => (
        <div key={p.id} className="mt-3 border-t border-line pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium"><Package className="mr-1 inline h-3.5 w-3.5" />Package {p.number.split("-").pop()} · {p.seller}</span>
            <span className={p.status === "cancelled" ? "text-vermilion" : "text-ink-soft"}>{p.status_label}</span>
          </div>
          {p.status !== "cancelled" && (
            <ol className="mt-2 flex items-center" aria-label="Progress">
              {p.steps.map((s, i) => (
                <li key={s.key} className="flex flex-1 items-center last:flex-none" title={s.label}>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full ${s.done ? "bg-leaf text-white" : "border border-line bg-white"}`}>{s.done && <Check className="h-3 w-3" />}</span>
                  {i < p.steps.length - 1 && <span className={`h-0.5 flex-1 ${p.steps[i + 1].done ? "bg-leaf" : "bg-line"}`} />}
                </li>
              ))}
            </ol>
          )}
          <div className="mt-2 flex gap-1.5">
            {p.items.slice(0, 4).map((it, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={it.image || "/icon.svg"} alt={it.title} title={`${it.title} × ${it.qty}`} className="h-10 w-10 rounded border border-line object-contain" />
            ))}
          </div>
          {p.courier && (
            <p className="mt-1.5 text-xs"><Truck className="mr-1 inline h-3.5 w-3.5" />{p.courier}{p.tracking_number && ` · ${p.tracking_number}`}
              {p.tracking_url && <a href={p.tracking_url} target="_blank" rel="noopener noreferrer" className="ml-1 font-semibold text-peacock">Track <ExternalLink className="inline h-3 w-3" /></a>}
            </p>
          )}
          {p.expected_delivery_at && !["delivered", "cancelled"].includes(p.status) && <p className="text-xs text-ink-soft">Expected by {date(p.expected_delivery_at)}</p>}
          {p.delivered_at && <p className="text-xs text-ink-soft">Delivered {date(p.delivered_at)}{p.return_by && ` · return by ${date(p.return_by)}`}</p>}
          {p.cancel_reason && <p className="text-xs text-ink-faint">{p.cancel_reason}</p>}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {p.can_cancel && <button type="button" onClick={() => onSend(`Cancel ${p.number}`)} className="rounded-full border border-line px-2.5 py-1 text-xs font-semibold hover:border-vermilion hover:text-vermilion">Cancel package</button>}
            {p.can_return && <Link href={o.link} className="rounded-full border border-line px-2.5 py-1 text-xs font-semibold hover:border-peacock">Return items</Link>}
          </div>
        </div>
      ))}
      {(o.refunds.length > 0 || o.returns.length > 0) && (
        <div className="mt-2 border-t border-line pt-2 text-xs">
          {o.refunds.map((r, i) => <p key={i}>Refund {r.amount}: <b>{r.status}</b> ({date(r.at)})</p>)}
          {o.returns.map((r) => <p key={r.number}>Return {r.number}: <b>{r.status}</b>{r.refund_amount && ` · ${r.refund_amount}`}</p>)}
        </div>
      )}
      <Link href={o.link} className="mt-2 inline-flex items-center text-xs font-semibold text-peacock">Open order <ChevronRight className="h-3 w-3" /></Link>
    </div>
  );
}

function Confirm({ c, onDone }: { c: Extract<Card, { type: "confirm" }>; onDone: (m: Msg | null) => void }) {
  const [status, setStatus] = useState(c.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(c.error ?? "");
  async function go(kind: "confirm" | "dismiss") {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ status: string; message?: Msg }>(`/api/shop-assistant/actions/${c.action_id}/${kind}`, { method: "POST" });
      setStatus(r.status);
      onDone(r.message ?? null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not do that. Try again.");
      if (e instanceof ApiError && e.status === 409) setStatus("failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-xl border border-vermilion/40 bg-vermilion-light/40 p-3 text-sm">
      <p className="font-semibold">{c.title}</p>
      <p className="mt-0.5 text-ink-soft">{c.summary}</p>
      {c.note && <p className="mt-1 text-xs text-ink-faint">{c.note}</p>}
      {status === "pending" ? (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => go("confirm")} className="rounded-lg bg-vermilion px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Working…" : c.confirm_label}</button>
          <button type="button" disabled={busy} onClick={() => go("dismiss")} className="rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold">Keep it</button>
        </div>
      ) : (
        <p className={`mt-2 text-xs font-semibold ${status === "done" ? "text-leaf" : "text-ink-faint"}`}>
          {status === "done" ? "Done" : status === "cancelled" ? "Kept as it is" : status === "expired" ? "Expired" : "Not done"}
        </p>
      )}
      {err && <p className="mt-1 text-xs text-vermilion">{err}</p>}
    </div>
  );
}

function TicketForm({ c, chatId, chatHeaders, onDone }: { c: Extract<Card, { type: "ticket_form" }>; chatId: string; chatHeaders: Record<string, string>; onDone: (m: Msg | null) => void }) {
  const [f, setF] = useState({ category: c.category, subject: c.subject, message: c.message, order_id: c.order_id, grievance: c.grievance });
  const [sent, setSent] = useState(c.status === "sent" ? c.ticket_number ?? "sent" : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (sent) return <p className="rounded-xl border border-leaf/40 bg-leaf-light p-3 text-sm"><Check className="mr-1 inline h-4 w-4 text-leaf" />Request {sent !== "sent" ? sent : ""} sent to our team.</p>;
  async function send() {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ ticket: { number: string }; message: Msg }>(`/api/shop-assistant/sessions/${chatId}/ticket`, {
        method: "POST", headers: chatHeaders, body: { ...f, order_id: f.order_id || null },
      });
      setSent(r.ticket.number);
      onDone(r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not send. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const field = "w-full rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm focus:border-peacock focus:outline-none";
  return (
    <div className="space-y-2 rounded-xl border border-line bg-white p-3 text-sm">
      <p className="flex items-center gap-1.5 font-semibold"><LifeBuoy className="h-4 w-4 text-peacock" />Request to our support team</p>
      <label className="block text-xs text-ink-soft">About
        <select className={field} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {c.categories.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}
        </select>
      </label>
      {c.orders.length > 0 && (
        <label className="block text-xs text-ink-soft">Order (optional)
          <select className={field} value={f.order_id} onChange={(e) => setF({ ...f, order_id: e.target.value })}>
            <option value="">No order</option>
            {c.orders.map((o) => <option key={o.id} value={o.id}>{o.number}</option>)}
          </select>
        </label>
      )}
      <label className="block text-xs text-ink-soft">Subject
        <input className={field} value={f.subject} maxLength={200} onChange={(e) => setF({ ...f, subject: e.target.value })} />
      </label>
      <label className="block text-xs text-ink-soft">What happened
        <textarea className={`${field} min-h-[88px]`} value={f.message} maxLength={5000} onChange={(e) => setF({ ...f, message: e.target.value })} />
      </label>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.grievance} onChange={(e) => setF({ ...f, grievance: e.target.checked })} />This is a formal grievance</label>
      {err && <p className="text-xs text-vermilion">{err}</p>}
      <button type="button" onClick={send} disabled={busy || f.subject.trim().length < 5 || f.message.trim().length < 10} className="w-full rounded-lg bg-peacock py-2 text-sm font-semibold text-white disabled:opacity-50">
        {busy ? "Sending…" : "Send"}
      </button>
      <p className="text-[11px] text-ink-faint">Our team replies within 48 hours. This chat is attached so you need not repeat yourself.</p>
    </div>
  );
}

export function CardView({ c, onSend, onMessage, chatId, chatHeaders }: {
  c: Card; onSend: (t: string) => void; onMessage: (m: Msg | null) => void; chatId: string; chatHeaders: Record<string, string>;
}) {
  switch (c.type) {
    case "text":
      return <Markdown source={c.text} className="text-[15px] leading-relaxed" />;
    case "chips":
      return (
        <div className="flex flex-wrap gap-1.5">
          {c.items.map((t) => <button key={t} type="button" onClick={() => onSend(t)} className="rounded-full border border-peacock/40 bg-white px-3 py-1 text-xs font-semibold text-peacock hover:bg-peacock-light">{t}</button>)}
        </div>
      );
    case "products":
      return <Products c={c} />;
    case "order":
      return <Order o={c.order} onSend={onSend} />;
    case "orders":
      return (
        <div className="divide-y divide-line rounded-xl border border-line bg-white text-sm">
          {c.title && <p className="px-3 py-2 text-xs font-semibold text-ink-soft">{c.title}</p>}
          {c.items.map((o) => (
            <button key={o.id} type="button" onClick={() => onSend(`Track ${o.number}`)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-mist/60">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={o.items[0]?.image || "/icon.svg"} alt="" className="h-9 w-9 rounded border border-line object-contain" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.items[0]?.title ?? o.number}{o.item_count > 1 && ` +${o.item_count - 1}`}</span>
                <span className="block text-xs text-ink-faint">{o.number} · {date(o.placed_at)} · {o.total_text}</span>
              </span>
              <span className="text-xs font-semibold text-peacock">{o.status}</span>
            </button>
          ))}
          {c.link && <Link href={c.link} className="block px-3 py-2 text-xs font-semibold text-peacock">All orders</Link>}
        </div>
      );
    case "tickets":
      return (
        <div className="divide-y divide-line rounded-xl border border-line bg-white text-sm">
          {c.items.map((t) => (
            <Link key={t.id} href={t.link} className="block px-3 py-2 hover:bg-mist/60">
              <span className="flex justify-between gap-2"><span className="truncate font-medium">{t.subject}</span><span className="shrink-0 text-xs text-peacock">{t.status_label}</span></span>
              <span className="block text-xs text-ink-faint">{t.number} · updated {date(t.updated_at)}</span>
              {t.last_team_reply && <span className="mt-1 block rounded bg-mist px-2 py-1 text-xs">“{t.last_team_reply.text}”</span>}
            </Link>
          ))}
        </div>
      );
    case "returns":
      return (
        <div className="rounded-xl border border-line bg-white p-3 text-sm">
          {c.returns.map((r) => <p key={r.number} className="text-xs">Return {r.number} ({r.reason}): <b>{r.status}</b>{r.refund_amount && ` · ${r.refund_amount}`}</p>)}
          {c.refunds.map((r, i) => <p key={i} className="text-xs">Refund {r.amount} for {r.order}: <b>{r.status}</b></p>)}
        </div>
      );
    case "article":
      return (
        <div className="rounded-xl border border-line bg-white p-3 text-sm">
          <p className="font-semibold">{c.title}</p>
          {c.text && <Markdown source={c.text} className="mt-1 text-sm text-ink-soft" />}
          {c.link && <Link href={c.link} className="mt-1 inline-flex items-center text-xs font-semibold text-peacock">Read more <ChevronRight className="h-3 w-3" /></Link>}
        </div>
      );
    case "signin":
      return (
        <Link href={c.link} className="inline-flex items-center gap-1.5 rounded-lg bg-peacock px-3 py-2 text-sm font-semibold text-white"><LogIn className="h-4 w-4" />Sign in</Link>
      );
    case "link":
      return <Link href={c.link} className="inline-flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-1.5 text-sm font-semibold text-peacock">{c.text}<ChevronRight className="h-4 w-4" /></Link>;
    case "confirm":
      return <Confirm c={c} onDone={onMessage} />;
    case "ticket_form":
      return <TicketForm c={c} chatId={chatId} chatHeaders={chatHeaders} onDone={onMessage} />;
    case "error":
      return <p className="flex items-center gap-1.5 text-sm text-vermilion"><AlertTriangle className="h-4 w-4" />{c.text}</p>;
    default:
      return null;
  }
}
