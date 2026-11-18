"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { PageHeader, Stat, Table, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, PageLoader, Pill, StatusPill } from "@/components/ui";
import { api, ApiError, downloadFile, quietly } from "@/lib/api";
import { date, rupeesExact } from "@/lib/format";

type P = { id: string; number: string; amount: number; status: string; mode: string; utr: string; failure_reason: string; bank: { holder?: string; account_last4?: string; ifsc?: string }; created_at: string; paid_at: string | null };
type L = { at: string; kind: string; amount: number; description: string; order: string | null; available_at: string; available: boolean; payout: string | null };

const KIND: Record<string, string> = {
  sale: "Sale", commission: "Commission", commission_gst: "GST on commission", tcs: "GST TCS", tds: "Income-tax TDS",
  return: "Return", commission_reversal: "Commission returned", commission_gst_reversal: "GST on commission returned",
  tcs_reversal: "TCS returned", tds_reversal: "TDS returned", adjustment: "Adjustment", payout_reversal: "Payout reversed",
};

export default function PayoutsPage() {
  const [tab, setTab] = useState("payouts");
  const [d, setD] = useState<{ balances: { available: number; upcoming: number; paid_out: number }; payouts: P[] } | null>(null);
  const [ledger, setLedger] = useState<L[] | null>(null);
  useEffect(() => {
    api<typeof d>("/api/seller/payouts").then(setD).catch(quietly);
  }, []);
  useEffect(() => {
    if (tab === "statement" && !ledger) api<{ items: L[] }>("/api/seller/ledger").then((r) => setLedger(r.items)).catch(quietly);
  }, [tab, ledger]);
  const [exportError, setExportError] = useState<string | null>(null);
  async function exportCsv() {
    // The last 12 months; other periods are on the Reports and exports page.
    setExportError(null);
    const from = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    try {
      await downloadFile("/api/seller/exports/ledger.csv", { from }, "statement.csv");
    } catch (e) {
      setExportError(e instanceof ApiError ? e.message : "Could not download the statement");
    }
  }
  if (!d) return <PageLoader />;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Payouts" sub="Money from delivered orders becomes available when the return window closes, and is paid to your bank every week." actions={<Button variant="secondary" onClick={exportCsv}><Download className="h-4 w-4" /> Statement, last 12 months</Button>} />
      <ErrorNote message={exportError} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Available for the next payout" value={rupeesExact(d.balances.available)} />
        <Stat label="In the return window" value={rupeesExact(d.balances.upcoming)} hint="Moves to available when the window closes" />
        <Stat label="Paid out so far" value={rupeesExact(d.balances.paid_out)} />
      </div>
      <Tabs value={tab} onChange={setTab} items={[{ value: "payouts", label: "Payouts" }, { value: "statement", label: "Statement" }]} />
      {tab === "payouts" ? (
        d.payouts.length === 0 ? <EmptyState title="No payouts yet" body="Your first payout is made after the return window of your first delivered order closes." /> : (
          <Table head={["Payout", "Created", "Amount", "Bank", "Status", "UTR"]}>
            {d.payouts.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-2.5 font-medium">{p.number}</td>
                <td className="px-4 py-2.5 text-sm">{date(p.created_at)}</td>
                <td className="px-4 py-2.5 font-semibold">{rupeesExact(p.amount)}</td>
                <td className="px-4 py-2.5 text-sm">{p.bank.holder}, XXXX{p.bank.account_last4}</td>
                <td className="px-4 py-2.5"><StatusPill status={p.status === "paid" ? "approved" : p.status === "failed" ? "failed" : "pending"} label={p.status} /></td>
                <td className="px-4 py-2.5 font-mono text-sm">{p.utr || (p.failure_reason && <span className="text-vermilion">{p.failure_reason}</span>)}</td>
              </tr>
            ))}
          </Table>
        )
      ) : !ledger ? <PageLoader /> : (
        <Table head={["Date", "Type", "Order", "Amount", "Available", "Payout"]}>
          {ledger.map((e, i) => (
            <tr key={i}>
              <td className="px-4 py-2 text-sm">{date(e.at)}</td>
              <td className="px-4 py-2">{KIND[e.kind] ?? e.kind}</td>
              <td className="px-4 py-2 text-sm">{e.order}</td>
              <td className={e.amount < 0 ? "px-4 py-2 text-vermilion" : "px-4 py-2 text-leaf"}>{rupeesExact(e.amount)}</td>
              <td className="px-4 py-2 text-sm">{e.available ? "Yes" : `From ${date(e.available_at)}`}</td>
              <td className="px-4 py-2 text-sm">{e.payout ? <Pill tone="green">{e.payout}</Pill> : ""}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
