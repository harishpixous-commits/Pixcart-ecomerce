"use client";

/*
 * Admin → Delivery → Payouts and cash. Weekly payouts are created every Monday for the week before (or here, for any
 * week); pay each partner from your bank and mark it paid with the bank reference, and the partner is told. "Cash with
 * partners" lists the cash-on-delivery money partners still hold; record a deposit when they hand it in.
 */

import clsx from "clsx";
import { AlertTriangle, Banknote, CalendarPlus, CheckCircle2, Download, IndianRupee, Wallet } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Kpi, PartnerAvatar } from "@/components/delivery/admin";
import { PageHeader, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Field, Input, Modal, PageLoader, Pagination, Pill, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { date, dateTime, rupees, toPaise } from "@/lib/format";

type Bank = { holder?: string; ifsc?: string; account_last4?: string; upi?: string };
type Payout = {
  id: string; partner: { id: string; name: string; phone: string; bank: Bank }; period_start: string; period_end: string; deliveries: number;
  amount: number; cod_deducted: number; net_amount: number; status: "pending" | "paid"; paid_at: string | null; reference: string;
};
type Payouts = { items: Payout[]; total: number; page: number; page_size: number; pending_total: number; not_in_payout: number };
type Cash = {
  partners: { id: string; name: string; phone: string; photo: string; cash_in_hand: number; over_limit: boolean }[];
  total: number; limit: number; recent: { partner: string; amount: number; method: string; reference: string; note: string; at: string }[];
};

const METHOD: Record<string, string> = { cash: "Cash", upi: "UPI", bank: "Bank transfer", payout: "From payout" };

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function PayoutsPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const tab = (["pending", "paid", "cash"].includes(sp.get("tab") ?? "") ? sp.get("tab") : "pending") as "pending" | "paid" | "cash";
  return (
    <div>
      <PageHeader title="Partner payouts and cash" sub="Pay partners every week, and keep track of the cash-on-delivery money they hold." />
      <Tabs value={tab} onChange={(v) => router.replace(`/admin/delivery/payouts?tab=${v}`)} items={[
        { value: "pending", label: "To pay" },
        { value: "paid", label: "Paid" },
        { value: "cash", label: "Cash with partners" },
      ]} />
      {tab === "cash" ? <CashTab /> : <PayoutsTab status={tab} />}
    </div>
  );
}

function PayoutsTab({ status }: { status: "pending" | "paid" }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ key: string; data: Payouts } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState<Payout | null>(null);
  const [week, setWeek] = useState("");
  const [busy, setBusy] = useState(false);
  const key = `${status}:${page}`;
  const load = useCallback(() => {
    api<Payouts>("/api/admin/delivery/payouts", { query: { status, page } }).then((x) => { setD({ key: `${status}:${page}`, data: x }); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load payouts"));
  }, [status, page]);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    setBusy(true);
    try {
      const r = await api<{ created: number; week_start: string }>("/api/admin/delivery/payouts/generate", { method: "POST", body: week ? { week_start: week } : {} });
      toast(r.created ? `${r.created} payout${r.created === 1 ? "" : "s"} created for the week of ${date(r.week_start)}` : `Nothing new to pay for the week of ${date(r.week_start)}`);
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not create payouts", "error");
    } finally {
      setBusy(false);
    }
  }

  function download(items: Payout[]) {
    const head = ["Partner", "Mobile", "Account holder", "IFSC", "Account (last 4)", "UPI", "From", "To", "Deliveries", "Earned (₹)", "Cash held (₹)", "To pay (₹)", "Status", "Reference"];
    const rows = items.map((p) => [p.partner.name, p.partner.phone, p.partner.bank.holder ?? "", p.partner.bank.ifsc ?? "", p.partner.bank.account_last4 ?? "", p.partner.bank.upi ?? "",
      p.period_start, p.period_end, p.deliveries, (p.amount / 100).toFixed(2), (p.cod_deducted / 100).toFixed(2), (p.net_amount / 100).toFixed(2), p.status, p.reference]);
    const blob = new Blob(["﻿" + [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `partner-payouts-${status}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const data = d?.key === key ? d.data : null;
  return (
    <div className="flex flex-col gap-4">
      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Kpi icon={Wallet} label="To pay now" value={rupees(data.pending_total)} hint="Pending payouts" tone={data.pending_total ? "amber" : "gray"} />
          <Kpi icon={IndianRupee} label="Earned, not in a payout yet" value={rupees(data.not_in_payout)} hint="Goes into next week's payout" tone="blue" />
          <div className="flex flex-col gap-2 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
            <p className="text-sm font-medium text-ink-soft">Create payouts now</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Any day in the week (empty = last week)" className="min-w-0 flex-1">
                <Input type="date" value={week} onChange={(e) => setWeek(e.target.value)} aria-label="Week" />
              </Field>
              <Button onClick={generate} loading={busy}><CalendarPlus className="h-4 w-4" aria-hidden /> Create</Button>
            </div>
            <p className="text-xs text-ink-faint">They are also created automatically every Monday morning.</p>
          </div>
        </div>
      )}
      <ErrorNote message={error} />
      {!data ? (error ? null : <PageLoader />) : data.items.length === 0 ? (
        <EmptyState title={status === "pending" ? "Nothing to pay right now" : "No payouts paid yet"} body={status === "pending" ? "Payouts appear here after a week with deliveries." : undefined} />
      ) : (
        <>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={() => download(data.items)}><Download className="h-4 w-4" aria-hidden /> Download CSV</Button>
          </div>
          <ul className="flex flex-col gap-2" data-testid="payout-rows">
            {data.items.map((p) => (
              <li key={p.id} className="flex flex-col gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{p.partner.name}</span>
                    <span className="text-sm text-ink-soft">{p.partner.phone}</span>
                    <Pill tone={p.status === "paid" ? "green" : "amber"}>{p.status === "paid" ? "Paid" : "To pay"}</Pill>
                  </p>
                  <p className="text-sm text-ink-soft">
                    {date(p.period_start)} to {date(p.period_end)} · {p.deliveries} deliver{p.deliveries === 1 ? "y" : "ies"} · earned {rupees(p.amount)}
                    {p.cod_deducted ? ` · cash held ${rupees(p.cod_deducted)} taken off` : ""}
                  </p>
                  <p className="text-xs text-ink-faint">
                    {p.partner.bank.ifsc ? `${p.partner.bank.holder ?? ""} · ${p.partner.bank.ifsc} · ••••${p.partner.bank.account_last4 ?? ""}` : "No bank account added"}
                    {p.partner.bank.upi ? ` · UPI ${p.partner.bank.upi}` : ""}
                    {p.status === "paid" ? ` · paid ${dateTime(p.paid_at)}, ref ${p.reference}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
                  <span className="font-display text-xl font-bold">{rupees(p.net_amount)}</span>
                  {p.status === "pending" && <Button size="sm" onClick={() => setPaying(p)} data-testid="mark-paid"><CheckCircle2 className="h-4 w-4" aria-hidden /> Mark paid</Button>}
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={data.page_size} total={data.total} onPage={setPage} />
        </>
      )}
      <MarkPaid payout={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load(); }} />
    </div>
  );
}

function MarkPaid({ payout, onClose, onDone }: { payout: Payout | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!payout) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/admin/delivery/payouts/${payout.id}/paid`, { method: "POST", body: { reference: reference.trim() } });
      toast(`Marked paid. ${payout.partner.name} has been told.`);
      setReference("");
      onDone();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not mark it paid");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!payout} onClose={onClose} title={payout ? `Pay ${payout.partner.name} ${rupees(payout.net_amount)}` : "Mark paid"}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-ink-soft">Send the money from your bank or UPI first, then enter the transaction reference (UTR).</p>
        <ErrorNote message={error} />
        <TextField label="Bank or UPI reference" value={reference} onChange={(e) => setReference(e.target.value)} required minLength={3} maxLength={60} placeholder="e.g. UTR 4012 8899 1234" />
        <Button type="submit" loading={busy} disabled={reference.trim().length < 3} className="self-start">Mark as paid</Button>
      </form>
    </Modal>
  );
}

function CashTab() {
  const [d, setD] = useState<Cash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [depositing, setDepositing] = useState<Cash["partners"][number] | null>(null);
  const load = useCallback(() => {
    api<Cash>("/api/admin/delivery/cash").then((x) => { setD(x); setError(null); }).catch((e) => setError(e instanceof ApiError ? e.message : "Could not load cash"));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!d) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const over = d.partners.filter((p) => p.over_limit).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi icon={Banknote} label="Cash with partners" value={rupees(d.total)} hint={`${d.partners.length} partner${d.partners.length === 1 ? "" : "s"} holding cash`} tone="amber" />
        <Kpi icon={AlertTriangle} label="Over the limit" value={over} hint={`Limit ${rupees(d.limit)} per partner`} alert={over > 0} tone="gray" />
        <Kpi icon={IndianRupee} label="Recent deposits" value={d.recent.length} hint="Last 30 shown below" tone="blue" />
      </div>
      {d.partners.length === 0 ? (
        <EmptyState title="No partner holds cash" body="Cash collected on delivery shows here until the partner deposits it." />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="cash-rows">
          {d.partners.map((p) => (
            <li key={p.id} className={clsx("flex items-center gap-3 rounded-xl bg-white p-3 shadow-sm ring-1 sm:p-4", p.over_limit ? "ring-vermilion/40" : "ring-black/5")}>
              <PartnerAvatar p={p} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{p.name}</p>
                <p className="text-sm text-ink-soft">{p.phone}{p.over_limit ? " · over the limit, gets no new cash orders" : ""}</p>
              </div>
              <span className={clsx("font-display text-lg font-bold", p.over_limit && "text-vermilion")}>{rupees(p.cash_in_hand)}</span>
              <Button size="sm" variant="secondary" onClick={() => setDepositing(p)}>Record deposit</Button>
            </li>
          ))}
        </ul>
      )}
      {d.recent.length > 0 && (
        <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5">
          <h2 className="mb-2 font-semibold">Recent deposits</h2>
          <ul className="divide-y divide-line text-sm">
            {d.recent.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><b>{r.partner}</b> · {METHOD[r.method] ?? r.method}{r.reference ? ` · ${r.reference}` : ""}{r.note ? ` · ${r.note}` : ""}</span>
                <span className="text-ink-soft">{rupees(r.amount)} · {dateTime(r.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Deposit partner={depositing} onClose={() => setDepositing(null)} onDone={() => { setDepositing(null); load(); }} />
    </div>
  );
}

function Deposit({ partner, onClose, onDone }: { partner: Cash["partners"][number] | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!partner) return;
    const paise = toPaise(amount);
    if (!paise) return setError("Enter the amount in rupees, like 1500");
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ cash_in_hand: number }>(`/api/admin/delivery/partners/${partner.id}/deposits`, { method: "POST", body: { amount_paise: paise, method, reference: reference.trim() } });
      toast(`Deposit saved. ${partner.name} now holds ${rupees(r.cash_in_hand)}.`);
      setAmount("");
      setReference("");
      onDone();
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Could not save the deposit");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={!!partner} onClose={onClose} title={partner ? `Cash from ${partner.name}` : "Record deposit"}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        {partner && <p className="text-sm text-ink-soft">{partner.name} holds {rupees(partner.cash_in_hand)}.</p>}
        <ErrorNote message={error} />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Amount (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required placeholder={partner ? String(partner.cash_in_hand / 100) : ""} />
          <Field label="How">
            <Select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank transfer</option>
            </Select>
          </Field>
        </div>
        <TextField label="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} placeholder="Receipt or UPI reference" />
        <Button type="submit" loading={busy} className="self-start">Save deposit</Button>
      </form>
    </Modal>
  );
}

export default function Page() {
  return <Suspense fallback={<PageLoader />}><PayoutsPage /></Suspense>;
}
