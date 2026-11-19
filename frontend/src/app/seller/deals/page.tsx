"use client";

import clsx from "clsx";
import { ArrowLeft, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEAL_KINDS, DEAL_OPEN, DealItem, KIND_ICON, kindText, maxDealMs, type DealKind, type DealRow, type DealRules } from "@/components/deal-list";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { DealBadge } from "@/components/product";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, TextField, useToast } from "@/components/ui";
import { api, ApiError, latestOnly, quietly } from "@/lib/api";
import { duration, paiseToInput, rupees, toLocalInput, toPaise } from "@/lib/format";
import type { DealInfo } from "@/lib/types";

type Data = { items: DealRow[]; counts: Record<string, number>; rules: DealRules };
type OptVariant = { id: string; label: string; price: number; mrp: number; stock: number; in_deal: boolean };
type OptProduct = { id: string; title: string; image: string; variants: OptVariant[] };

export default function SellerDeals() {
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [stop, setStop] = useState<DealRow | null>(null);
  const [busy, setBusy] = useState(false);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => {
    track(api<Data>("/api/seller/deals", { query: { status: status || undefined } }), (x) => { setD(x); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load your deals"));
  }, [status, track]);
  useEffect(() => { load(); }, [load]);

  async function cancelDeal() {
    if (!stop) return;
    setBusy(true);
    try {
      await api(`/api/seller/deals/${stop.id}/cancel`, { method: "POST" });
      toast(stop.status === "active" ? "Deal stopped. The price is back to normal." : "Deal cancelled");
      setStop(null);
      load();
    } catch (x) {
      toast(x instanceof ApiError ? x.message : "Could not cancel the deal", "error");
    } finally {
      setBusy(false);
    }
  }

  const rules = d?.rules;
  const counts = d?.counts ?? {};
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const tabs = [
    { value: "", label: "All", count: all },
    { value: "active", label: "Running", count: counts.active ?? 0 },
    { value: "approved", label: "Scheduled", count: counts.approved ?? 0 },
    ...(rules?.need_approval || counts.pending ? [{ value: "pending", label: "Waiting for approval", count: counts.pending ?? 0 }] : []),
    { value: "ended", label: "Ended", count: counts.ended ?? 0 },
    { value: "rejected", label: "Not approved", count: counts.rejected ?? 0 },
    { value: "cancelled", label: "Cancelled", count: counts.cancelled ?? 0 },
  ];

  return (
    <div>
      <PageHeader
        title="Deals"
        sub="Put a product in Today's Deals with a lower price for a limited time. While the deal runs, shoppers see the deal price, a countdown and the deal badge."
        actions={<Button onClick={() => setCreating(true)} disabled={!rules?.enabled}>New deal</Button>}
      />
      <ErrorNote message={error} />
      {!d ? (error ? null : <PageLoader />) : (
        <>
          {!d.rules.enabled ? (
            <p className="mb-4 rounded-xl bg-marigold-light px-4 py-3 text-sm">Deals are switched off on the marketplace right now. Your running deals have ended; you can still see them here.</p>
          ) : (
            <section className="mb-4 rounded-xl bg-white p-4" aria-label="Deal rules">
              <div className="grid gap-4 sm:grid-cols-3">
                {DEAL_KINDS.map((k) => {
                  const Icon = KIND_ICON[k];
                  return (
                    <div key={k} className="flex gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-vermilion-light text-vermilion"><Icon className="h-5 w-5" aria-hidden /></span>
                      <div>
                        <p className="font-semibold">{d.rules.kinds[k]}</p>
                        <p className="text-sm text-ink-soft">{kindText(k, d.rules)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 border-t border-line pt-3 text-sm text-ink-soft">
                The deal price must be at least <b className="text-ink">{d.rules.min_discount_pct}%</b> below your current selling price.{" "}
                {d.rules.need_approval ? "The marketplace team checks each deal before it starts." : "Deals start on time without a review."}{" "}
                While a deal runs you cannot change that version&apos;s price; the price goes back by itself when the deal ends.
              </p>
            </section>
          )}
          <Tabs value={status} onChange={setStatus} items={tabs} />
          {d.items.length === 0 ? (
            <EmptyState
              title={status ? "No deals here" : "No deals yet"}
              body={status ? "Deals in this state show up here." : "Create a deal to get your product into Today's Deals with a countdown and a deal badge."}
              action={!status && d.rules.enabled ? <Button onClick={() => setCreating(true)}>Create your first deal</Button> : undefined}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {d.items.map((x) => (
                <DealItem key={x.id} d={x} actions={DEAL_OPEN.includes(x.status) ? (
                  <Button size="sm" variant="danger" onClick={() => setStop(x)}>{x.status === "active" ? "Stop deal" : "Cancel deal"}</Button>
                ) : undefined} />
              ))}
            </div>
          )}
        </>
      )}

      <Modal open={creating && !!rules} onClose={() => setCreating(false)} title="New deal" wide>
        {rules && <NewDealForm rules={rules} onDone={(st) => {
          setCreating(false);
          toast(st === "pending" ? "Deal sent. The marketplace team will check it before it starts." : "Deal scheduled. It starts on time.");
          setStatus(st === "pending" ? "pending" : st === "active" ? "active" : "approved");
          load();
        }} />}
      </Modal>

      <Modal open={stop !== null} onClose={() => setStop(null)} title={stop?.status === "active" ? "Stop this deal?" : "Cancel this deal?"}>
        {stop && (
          <div className="flex flex-col gap-3">
            <p className="text-ink-soft">
              <span className="font-semibold text-ink">{stop.product}</span> ({stop.variant}).{" "}
              {stop.status === "active" ? `The price goes back to ${rupees(stop.regular_price)} right away and the deal badge is removed.` : "The deal will not start."}
            </p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={cancelDeal} loading={busy}>{stop.status === "active" ? "Stop deal" : "Cancel deal"}</Button>
              <Button variant="ghost" onClick={() => setStop(null)}>Keep it</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------------- new deal */

const WANT_MS: Record<DealKind, number> = { lightning: 6 * 3_600_000, deal_of_day: 24 * 3_600_000, limited: 3 * 86_400_000 };
const spanFor = (kind: DealKind, r: DealRules) => Math.min(WANT_MS[kind], maxDealMs(kind, r));

function firstTimes(kind: DealKind, r: DealRules) {
  const start = new Date(Date.now() + 15 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 5) * 5, 0, 0);
  return { starts: toLocalInput(start), ends: toLocalInput(new Date(start.getTime() + spanFor(kind, r))) };
}

function NewDealForm({ rules, onDone }: { rules: DealRules; onDone: (status: string) => void }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState<OptProduct[] | null>(null);
  const [product, setProduct] = useState<OptProduct | null>(null);
  const [variantId, setVariantId] = useState("");
  const [kind, setKind] = useState<DealKind>("lightning");
  const [price, setPrice] = useState("");
  const [times, setTimes] = useState(() => firstTimes("lightning", rules));
  const [qty, setQty] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const track = useMemo(() => latestOnly(), []);

  useEffect(() => {
    const t = setTimeout(() => {
      track(api<{ products: OptProduct[] }>("/api/seller/deals/options", { query: { q: q.trim() || undefined } }), (x) => setOpts(x.products)).catch(quietly);
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, track]);

  const v = product?.variants.find((x) => x.id === variantId) ?? null;
  const maxPrice = v ? Math.floor((v.price * (100 - rules.min_discount_pct)) / 100) : 0;
  const pricePaise = toPaise(price) ?? 0;
  const startMs = new Date(times.starts).getTime();
  const endMs = new Date(times.ends).getTime();
  const span = endMs - startMs;
  const maxMs = maxDealMs(kind, rules);
  const offMrp = v && v.mrp > 0 && pricePaise > 0 ? Math.round((100 * (v.mrp - pricePaise)) / v.mrp) : 0;
  const offPrice = v && pricePaise > 0 ? Math.round((100 * (v.price - pricePaise)) / v.price) : 0;
  const chips = Array.from(new Set([rules.min_discount_pct, 15, 20, 25, 30, 40, 50])).filter((p) => p >= rules.min_discount_pct && p < 95).sort((a, b) => a - b).slice(0, 5);

  function pick(p: OptProduct) {
    setProduct(p);
    const open = p.variants.filter((x) => !x.in_deal);
    setVariantId(open.length === 1 ? open[0].id : "");
    setPrice("");
    setError(null);
  }

  function changeKind(k: DealKind) {
    setKind(k);
    if (!Number.isNaN(startMs)) setTimes({ starts: times.starts, ends: toLocalInput(new Date(startMs + spanFor(k, rules))) });
  }

  function changeStart(value: string) {
    const s = new Date(value).getTime();
    // keep the same length when the start moves
    setTimes({ starts: value, ends: !Number.isNaN(s) && span > 0 ? toLocalInput(new Date(s + span)) : times.ends });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!v) return setError("Choose the product version for the deal");
    if (!pricePaise) return setError("Enter the deal price");
    if (pricePaise > maxPrice) return setError(`The deal price must be ${rupees(maxPrice)} or less (at least ${rules.min_discount_pct}% below ${rupees(v.price)})`);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return setError("Choose when the deal starts and ends");
    if (span <= 0) return setError("The deal must end after it starts");
    if (span > maxMs) return setError(`A ${rules.kinds[kind].toLowerCase()} can run for at most ${duration(maxMs)}`);
    const units = Number(qty);
    if (kind === "lightning" && (!units || units < 1)) return setError("Enter how many units you offer at the deal price");
    if (kind === "lightning" && units > v.stock) return setError(`You have ${v.stock} in stock; offer at most that many units`);
    setSaving(true);
    try {
      const out = await api<DealRow>("/api/seller/deals", { method: "POST", body: {
        variant_id: v.id, kind, deal_price_paise: pricePaise, starts_at: new Date(startMs).toISOString(), ends_at: new Date(endMs).toISOString(),
        qty_limit: units > 0 ? units : null,
      } });
      onDone(out.status);
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not create the deal");
    } finally {
      setSaving(false);
    }
  }

  const preview: DealInfo | null = v && pricePaise > 0 && !Number.isNaN(endMs) ? {
    kind, label: rules.kinds[kind], ends_at: new Date(endMs).toISOString(), deal_price: pricePaise, regular_price: v.price,
    claimed_pct: kind === "lightning" ? 0 : null, variant_id: v.id,
  } : null;

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="new-deal-form">
      <ErrorNote message={error} />
      {/* 1. product */}
      {!product ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">1. Choose a product</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your live products" aria-label="Search your live products" className="pl-9" autoFocus />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-xl ring-1 ring-line">
            {!opts ? <div className="p-6"><PageLoader /></div> : opts.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">{q ? "No live product matches." : "You have no live products yet. Deals run on approved products."}</p>
            ) : opts.map((p) => (
              <button type="button" key={p.id} onClick={() => pick(p)} className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-0 hover:bg-mist">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {p.image ? <img src={p.image} alt="" className="h-11 w-11 shrink-0 rounded object-contain" /> : <span className="h-11 w-11 shrink-0 rounded bg-mist" />}
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 font-medium">{p.title}</span>
                  <span className="text-xs text-ink-faint">{p.variants.length === 1 ? rupees(p.variants[0].price) : `${p.variants.length} versions`}{p.variants.some((x) => x.in_deal) ? " · a deal is running" : ""}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 rounded-xl bg-mist p-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {product.image ? <img src={product.image} alt="" className="h-12 w-12 shrink-0 rounded bg-white object-contain" /> : null}
            <p className="min-w-0 flex-1 font-semibold">{product.title}</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setProduct(null); setVariantId(""); }}><ArrowLeft className="h-4 w-4" /> Change</Button>
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Version</legend>
            <div className="flex flex-col gap-1.5">
              {product.variants.map((x) => (
                <label key={x.id} className={clsx("flex items-center gap-3 rounded-lg border px-3 py-2", x.in_deal ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  variantId === x.id ? "border-peacock bg-peacock-light/40" : "border-line hover:bg-mist")}>
                  <input type="radio" name="deal-variant" className="accent-peacock" checked={variantId === x.id} disabled={x.in_deal} onChange={() => { setVariantId(x.id); setPrice(""); }} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{x.label}</span>
                    <span className="block text-xs text-ink-faint">{x.stock} in stock{x.in_deal ? " · a deal is running now" : ""}</span>
                  </span>
                  <span className="text-right text-sm">
                    <span className="font-semibold">{rupees(x.price)}</span>
                    {x.mrp > x.price && <span className="block text-xs text-ink-faint line-through">{rupees(x.mrp)}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      {/* 2. kind */}
      <fieldset>
        <legend className="mb-1 text-sm font-medium">2. Kind of deal</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {DEAL_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <label key={k} className={clsx("flex cursor-pointer flex-col gap-1 rounded-xl border p-3 focus-within:ring-2 focus-within:ring-peacock/30",
                kind === k ? "border-vermilion bg-vermilion-light/40 ring-1 ring-vermilion" : "border-line hover:bg-mist")}>
                <span className="flex items-center gap-2 font-semibold">
                  <input type="radio" name="deal-kind" className="sr-only" checked={kind === k} onChange={() => changeKind(k)} />
                  <Icon className="h-4 w-4 text-vermilion" aria-hidden /> {rules.kinds[k]}
                </span>
                <span className="text-xs text-ink-soft">{kindText(k, rules)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* 3. price, time, units */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <TextField label="3. Deal price (₹)" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!v}
            hint={v ? `Now ${rupees(v.price)}. ${rupees(maxPrice)} or less (at least ${rules.min_discount_pct}% off).` : "Choose a version first"} />
          {v && (
            <div className="flex flex-wrap gap-1.5" aria-label="Quick prices">
              {chips.map((p) => (
                <button type="button" key={p} onClick={() => setPrice(paiseToInput(Math.floor((v.price * (100 - p)) / 100 / 100) * 100))}
                  className={clsx("rounded-full border px-2.5 py-1 text-xs font-semibold", offPrice === p ? "border-vermilion bg-vermilion-light text-vermilion" : "border-line hover:bg-mist")}>
                  {p}% off
                </button>
              ))}
            </div>
          )}
        </div>
        {kind === "lightning" ? (
          <TextField label="Units at the deal price" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} disabled={!v}
            hint={v ? `You have ${v.stock} in stock. The deal ends when these are claimed.` : "A lightning deal offers a set number of units"} />
        ) : (
          <Field label="Units (optional)" hint="Leave empty to sell at the deal price until the deal ends">
            <Input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} disabled={!v} />
          </Field>
        )}
        <TextField label="Starts" type="datetime-local" value={times.starts} onChange={(e) => changeStart(e.target.value)} />
        <TextField label="Ends" type="datetime-local" value={times.ends} onChange={(e) => setTimes({ ...times, ends: e.target.value })}
          error={span > maxMs ? `Too long: at most ${duration(maxMs)}` : span <= 0 && !Number.isNaN(span) ? "Must be after the start" : undefined}
          hint={span > 0 ? `Runs for ${duration(span)} (at most ${duration(maxMs)})` : undefined} />
      </div>

      {preview && v && (
        <div className="rounded-xl border border-dashed border-vermilion/40 bg-vermilion-light/20 p-3" data-testid="deal-preview">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint"><Sparkles className="h-3.5 w-3.5" aria-hidden /> How shoppers will see it</p>
          <p>
            <span className="font-display text-2xl font-bold">{rupees(pricePaise)}</span>{" "}
            {v.mrp > pricePaise && <span className="text-sm text-ink-faint">M.R.P. <span className="line-through">{rupees(v.mrp)}</span></span>}
          </p>
          <div className="mt-1 max-w-xs"><DealBadge deal={preview} discount={offMrp} /></div>
          {pricePaise > maxPrice && <p className="mt-2 text-sm text-vermilion">Lower the price to {rupees(maxPrice)} or less to meet the {rules.min_discount_pct}% rule.</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving} disabled={!v}>{rules.need_approval ? "Send for approval" : "Schedule deal"}</Button>
        <p className="text-xs text-ink-faint">{rules.need_approval ? "You get a notification when it is approved." : "It starts at the time you chose."}</p>
      </div>
    </form>
  );
}
