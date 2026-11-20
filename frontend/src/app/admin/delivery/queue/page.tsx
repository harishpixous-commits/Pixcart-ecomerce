"use client";

/*
 * Admin → Delivery → Assign: packages the sellers marked "Ready for pickup" that no partner has yet, requests waiting
 * for a partner to accept, and failed attempts that need a decision (try again or bring the package back).
 * Assign by hand (with or without asking the partner), let auto-assign ask the nearest free partner, or hand the
 * package to a courier instead. "Return pickups" lists customers' returns our partners should collect.
 */

import clsx from "clsx";
import { Banknote, Bike, Loader2, MapPin, Phone, RotateCcw, Send, Sparkles, Store, Truck, Undo2, UserCheck, Zap } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { PartnerAvatar } from "@/components/delivery/admin";
import { ago, telUrl, useNow, usePolling } from "@/components/delivery/trip";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Modal, PageLoader, Pill, Textarea, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import type { Candidate, QueuePackage } from "@/lib/delivery-types";
import { rupees } from "@/lib/format";

type Tab = "waiting" | "offered" | "failed" | "returns";
type Data = { items: QueuePackage[]; counts: Record<Tab, number> };

const TRY_LABEL: Record<string, string> = { rejected: "declined", expired: "did not answer", cancelled: "taken back", failed: "could not deliver", delivered: "delivered" };

function QueuePage() {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = (["waiting", "offered", "failed", "returns"].includes(sp.get("tab") ?? "") ? sp.get("tab") : "waiting") as Tab;
  const [data, setData] = useState<{ tab: Tab; d: Data } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<QueuePackage | null>(null);
  const [cancelling, setCancelling] = useState<QueuePackage | null>(null);
  const now = useNow(1000);

  const load = useCallback(() => {
    api<Data>("/api/admin/delivery/queue", { query: { tab } })
      .then((d) => { setData({ tab, d }); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the queue"));
  }, [tab]);
  usePolling(load, 10_000);

  const d = data?.tab === tab ? data.d : null;
  const counts = d?.counts ?? data?.d.counts;
  return (
    <div className="flex flex-col gap-1">
      <PageHeader title="Assign deliveries" sub="Packages ready for pickup. Assign a partner yourself, or let auto-assign ask the nearest free partner." />
      <Tabs value={tab} onChange={(v) => router.replace(`/admin/delivery/queue?tab=${v}`)} items={[
        { value: "waiting", label: "Waiting for a partner", count: counts?.waiting },
        { value: "offered", label: "Request sent", count: counts?.offered },
        { value: "failed", label: "Not delivered", count: counts?.failed },
        { value: "returns", label: "Return pickups", count: counts?.returns },
      ]} />
      <ErrorNote message={error} />
      {!d ? (error ? null : <PageLoader />) : d.items.length === 0 ? (
        <EmptyState
          title={tab === "waiting" ? "Every package has a partner" : tab === "offered" ? "No requests waiting for an answer" : tab === "returns" ? "No returns waiting to be collected" : "No failed deliveries to sort out"}
          body={tab === "waiting" ? "Packages show up here when a seller taps Ready for pickup and no partner has taken them yet."
            : tab === "returns" ? "Approved returns of packages our partners delivered wait here when no partner has taken the pickup." : undefined}
        />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="queue-list">
          {d.items.map((p) => (
            <li key={p.return_id ?? p.sub_order_id}>
              <PackageCard p={p} tab={tab} now={now} onAssign={() => setAssigning(p)} onCancel={() => setCancelling(p)} onChanged={load} />
            </li>
          ))}
        </ul>
      )}
      <AssignDialog pkg={assigning} onClose={() => setAssigning(null)} onDone={() => { setAssigning(null); load(); }} />
      <CancelDialog pkg={cancelling} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); load(); }} />
    </div>
  );
}

function PackageCard({ p, tab, now, onAssign, onCancel, onChanged }: {
  p: QueuePackage; tab: Tab; now: number; onAssign: () => void; onCancel: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function run(key: string, path: string, body: unknown, ok: string) {
    setBusy(key);
    try {
      await api(path, { method: "POST", body });
      toast(ok);
      onChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Something went wrong", "error");
    } finally {
      setBusy(null);
    }
  }
  const a = p.assignment;
  const left = a?.expires_at ? Math.max(0, Math.round((new Date(a.expires_at).getTime() - now) / 1000)) : null;
  return (
    <article className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5" data-testid="queue-item">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-lg font-semibold">{p.return_number ? `Return ${p.return_number}` : p.order_number}</h2>
        {p.return_number && <span className="text-sm text-ink-soft">order {p.order_number}</span>}
        {p.return_number || a?.kind === "pickup" ? <Pill tone="blue">Return pickup</Pill>
          : p.payment === "cod" ? <Pill tone="amber">Cash on delivery {rupees(p.cod_amount)}</Pill> : <Pill tone="green">Prepaid</Pill>}
        {p.zone ? <Pill tone="blue">{p.zone.name}</Pill> : <Pill tone="red">No zone</Pill>}
        {p.ready_since && <span className="text-sm text-ink-faint">Ready {ago(p.ready_since, now)}</span>}
        {p.pickup_code && <span className="ml-auto rounded-lg bg-mist px-2 py-1 font-mono text-sm font-bold tracking-widest" title="The seller gives this code to the partner at pickup">Code {p.pickup_code}</span>}
      </header>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="flex gap-3 rounded-xl bg-mist p-3">
          <Store className="mt-0.5 h-5 w-5 shrink-0 text-marigold-dark" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">{p.pickup.name}</p>
            <p className="text-ink-soft">{[p.pickup.address, p.pickup.city, p.pickup.pincode].filter(Boolean).join(", ")}</p>
            {p.pickup.phone && <a href={telUrl(p.pickup.phone)} className="mt-1 inline-flex items-center gap-1 font-semibold text-peacock"><Phone className="h-3.5 w-3.5" aria-hidden />{p.pickup.phone}</a>}
            {(p.pickup.lat === null) && <p className="mt-1 text-xs text-marigold-dark">Store location not pinned yet; distance can&apos;t be measured.</p>}
          </div>
        </div>
        <div className="flex gap-3 rounded-xl bg-mist p-3">
          <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-vermilion" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-semibold">{p.drop.name || "Customer"}</p>
            <p className="text-ink-soft">{[p.drop.city, p.drop.pincode].filter(Boolean).join(" ")}</p>
            {p.drop.lat === null && <p className="mt-1 text-xs text-ink-faint">No map pin on this address</p>}
          </div>
        </div>
      </div>

      {p.return_items && p.return_items.length > 0 && (
        <p className="mt-3 text-sm"><span className="font-semibold">Collect: </span>{p.return_items.join(", ")}</p>
      )}

      {p.tries.length > 0 && (
        <p className="mt-3 text-sm text-ink-soft">
          <span className="font-semibold text-ink">Tried: </span>
          {p.tries.map((t, i) => (
            <span key={i}>{i ? ", " : ""}{t.partner} {TRY_LABEL[t.status] ?? t.status}{t.reason ? ` (${t.reason})` : ""}</span>
          ))}
        </p>
      )}

      {tab === "offered" && a && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-marigold-light/60 p-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-marigold-dark" aria-hidden />
          <span>Asked <b>{a.partner}</b>{a.mode === "auto" ? " (auto-assign)" : ""}. {left !== null ? <b>{left} s left</b> : null} to accept.</span>
          <a href={telUrl(a.partner_phone)} className="inline-flex items-center gap-1 font-semibold text-peacock"><Phone className="h-3.5 w-3.5" aria-hidden />Call</a>
        </div>
      )}
      {tab === "failed" && a && (
        <div className="mt-3 rounded-xl bg-vermilion-light p-3 text-sm text-ink">
          <p><b>{a.partner}</b> could not deliver: {a.fail_reason || "no reason given"}.</p>
          <p className="text-ink-soft">The partner still has the package. Try again later, or have it brought back to the seller (the order part is then cancelled and refunded).</p>
        </div>
      )}

      <footer className="mt-4 flex flex-wrap gap-2">
        {tab === "waiting" && (
          <>
            <Button onClick={onAssign} data-testid="assign-open"><UserCheck className="h-4 w-4" aria-hidden /> Assign partner</Button>
            <Button variant="secondary" loading={busy === "auto"} onClick={() => run("auto", `/api/admin/delivery/packages/${p.sub_order_id}/auto-assign`, {}, "Asked the nearest free partner")}>
              <Zap className="h-4 w-4" aria-hidden /> Auto-assign
            </Button>
            <Button variant="ghost" loading={busy === "courier"} onClick={() => {
              if (window.confirm("Send this package by courier instead? The seller books the courier from their order page.")) run("courier", `/api/admin/delivery/packages/${p.sub_order_id}/courier`, {}, "Switched to courier");
            }}>
              <Truck className="h-4 w-4" aria-hidden /> Use courier instead
            </Button>
          </>
        )}
        {tab === "returns" && p.return_id && (
          <>
            <Button onClick={onAssign}><UserCheck className="h-4 w-4" aria-hidden /> Assign partner</Button>
            <Button variant="secondary" loading={busy === "auto"} onClick={() => run("auto", `/api/admin/delivery/returns/${p.return_id}/auto-assign`, {}, "Asked the nearest free partner")}>
              <Zap className="h-4 w-4" aria-hidden /> Auto-assign
            </Button>
            <Button variant="ghost" loading={busy === "courier"} onClick={() => {
              if (window.confirm("Let the seller arrange this pickup with their courier instead? Our partners stop trying.")) run("courier", `/api/admin/delivery/returns/${p.return_id}/courier`, {}, "The seller will arrange the pickup");
            }}>
              <Truck className="h-4 w-4" aria-hidden /> Seller&apos;s courier instead
            </Button>
          </>
        )}
        {tab === "offered" && (
          <>
            <Button variant="secondary" onClick={onCancel}><Undo2 className="h-4 w-4" aria-hidden /> Take back the request</Button>
          </>
        )}
        {tab === "failed" && a && (
          <>
            <Button loading={busy === "retry"} onClick={() => run("retry", `/api/admin/delivery/assignments/${a.id}/resolve`, { action: "retry" }, "The partner will try the delivery again")}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Try delivery again
            </Button>
            <Button variant="danger" loading={busy === "return"} onClick={() => {
              if (window.confirm("Bring the package back to the seller? The order part is cancelled and a prepaid amount refunded when it reaches the store.")) run("return", `/api/admin/delivery/assignments/${a.id}/resolve`, { action: "return" }, "The partner will bring the package back to the store");
            }}>
              <Undo2 className="h-4 w-4" aria-hidden /> Bring back to store
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}

function AssignDialog({ pkg, onClose, onDone }: { pkg: QueuePackage | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<{ id: string; items: Candidate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [direct, setDirect] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ id: string; message: string } | null>(null);
  const id = pkg ? pkg.return_id ?? pkg.sub_order_id : null;
  const forReturn = !!pkg?.return_id;

  useEffect(() => {
    if (!id) return;
    let live = true;
    api<Candidate[]>(forReturn ? `/api/admin/delivery/returns/${id}/candidates` : `/api/admin/delivery/packages/${id}/candidates`)
      .then((c) => { if (live) { setList({ id, items: c }); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof ApiError ? e.message : "Could not load partners"); });
    return () => { live = false; };
  }, [id, forReturn]);

  async function assign(c: Candidate, force: boolean) {
    if (!pkg) return;
    setBusy(c.id);
    try {
      if (pkg.return_id) await api(`/api/admin/delivery/returns/${pkg.return_id}/assign`, { method: "POST", body: { partner_id: c.id, direct, force } });
      else await api("/api/admin/delivery/assign", { method: "POST", body: { sub_order_id: pkg.sub_order_id, partner_id: c.id, direct, force } });
      toast(direct ? `Assigned to ${c.name}` : `Request sent to ${c.name}`);
      setBlocked(null);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "partner_not_free") setBlocked({ id: c.id, message: e.message });
      else toast(e instanceof ApiError ? e.message : "Could not assign", "error");
    } finally {
      setBusy(null);
    }
  }

  const items = list && list.id === id ? list.items : null;
  return (
    <Modal open={!!pkg} onClose={() => { setBlocked(null); onClose(); }} title={pkg ? (pkg.return_number ? `Collect return ${pkg.return_number}` : `Assign ${pkg.order_number}`) : "Assign"} wide>
      <div className="flex flex-col gap-3" data-testid="assign-dialog">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-mist p-3">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={direct} onChange={(e) => setDirect(e.target.checked)} />
          <span className="text-sm">
            <span className="block font-semibold">Assign without asking</span>
            <span className="text-ink-soft">Use when the partner already agreed on the phone. Otherwise they get a request to accept within the time limit.</span>
          </span>
        </label>
        <ErrorNote message={error} />
        {!items ? (!error && <div className="flex h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-peacock" /></div>) : items.length === 0 ? (
          <p className="rounded-xl bg-white p-6 text-center text-ink-soft ring-1 ring-line">No approved partners yet. Approve partners in Delivery partners first.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((c, i) => (
              <li key={c.id} className={clsx("rounded-xl p-3 ring-1", c.ok ? "ring-leaf/40" : "ring-line")}>
                <div className="flex items-center gap-3">
                  <PartnerAvatar p={c} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      {i === 0 && c.ok && <Pill tone="green"><Sparkles className="mr-1 h-3 w-3" aria-hidden />Best match</Pill>}
                      <span className={clsx("inline-flex items-center gap-1 text-xs font-semibold", c.online ? "text-leaf" : "text-ink-faint")}>
                        <span className={clsx("h-2 w-2 rounded-full", c.online ? "bg-leaf" : "bg-line")} />{c.online ? "Online" : "Offline"}
                      </span>
                    </p>
                    <p className="text-xs text-ink-soft">
                      <Bike className="mr-1 inline h-3.5 w-3.5" aria-hidden />{c.vehicle}{c.zone ? ` · ${c.zone}` : ""}
                      {c.distance_km !== null ? ` · ${c.distance_km} km away${c.location_fresh ? "" : " (old location)"}` : " · distance unknown"}
                      {` · ${c.load} trip${c.load === 1 ? "" : "s"} now`}
                      {c.cash ? <> · <Banknote className="mr-0.5 inline h-3.5 w-3.5" aria-hidden />{rupees(c.cash)} cash</> : null}
                      {c.rating_avg ? ` · ★ ${c.rating_avg.toFixed(1)}` : ""}
                    </p>
                    {c.reasons.length > 0 && (
                      <p className="mt-1 flex flex-wrap gap-1">
                        {c.reasons.map((r) => <span key={r} className="rounded-full bg-vermilion-light px-2 py-0.5 text-[11px] font-semibold text-vermilion">{r}</span>)}
                      </p>
                    )}
                  </div>
                  <Button size="sm" variant={c.ok ? "primary" : "secondary"} loading={busy === c.id} onClick={() => assign(c, false)} data-testid="assign-partner">
                    <Send className="h-3.5 w-3.5" aria-hidden /> {direct ? "Assign" : "Ask"}
                  </Button>
                </div>
                {blocked?.id === c.id && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-marigold-light p-2 text-sm">
                    <span className="min-w-0 flex-1">{blocked.message}</span>
                    <Button size="sm" variant="danger" loading={busy === c.id} onClick={() => assign(c, true)}>Assign anyway</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function CancelDialog({ pkg, onClose, onDone }: { pkg: QueuePackage | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pkg?.assignment) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/delivery/assignments/${pkg.assignment.id}/cancel`, { method: "POST", body: { reason: reason.trim() } });
      toast("Request taken back. The package is waiting for a partner again.");
      setReason("");
      onDone();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not take it back");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!pkg} onClose={onClose} title="Take back the request">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft">{pkg?.assignment?.partner} is told the request was withdrawn. You can then assign someone else.</p>
        <ErrorNote message={error} />
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, for the partner and the log (e.g. assigning a closer partner)" rows={3} required minLength={3} maxLength={300} aria-label="Reason" />
        <Button type="submit" loading={busy} disabled={reason.trim().length < 3} className="self-start">Take back</Button>
      </form>
    </Modal>
  );
}

export default function Page() {
  return <Suspense fallback={<PageLoader />}><QueuePage /></Suspense>;
}
