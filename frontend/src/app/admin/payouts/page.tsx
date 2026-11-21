"use client";

import { Download, Send } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Stat, Table, Tabs } from "@/components/portal-shell";
import { Button, EmptyState, ErrorNote, Modal, PageLoader, Pagination, Pill, StatusPill, TextField, useToast } from "@/components/ui";
import { api, ApiError, downloadFile, latestOnly } from "@/lib/api";
import { date, rupeesExact } from "@/lib/format";
import { ExportButton } from "@/components/export-button";

type P = {
  id: string; number: string; seller_name: string; amount: number; status: string; mode: string; utr: string; failure_reason: string;
  bank: { holder?: string; account_last4?: string; ifsc?: string }; created_at: string; paid_at: string | null;
  /** the seller's bank details changed after this payout was made: confirm the new account (or cancel) before paying */
  bank_changed?: boolean;
};
type D = { mode: string; razorpayx_ready: boolean; due: { seller: string; amount: number }[]; items: P[]; total: number };

function AdminPayoutsInner() {
  const sellerId = useSearchParams().get("seller_id") ?? undefined;
  const toast = useToast();
  const [status, setStatus] = useState("pending");
  const [d, setD] = useState<D | null>(null);
  const [paid, setPaid] = useState<P | null>(null);
  const [utr, setUtr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const track = useMemo(() => latestOnly(), []);
  const [page, setPage] = useState(1);
  const load = useCallback(() => track(api<D>("/api/admin/payouts", { query: { status: status || undefined, page, seller_id: sellerId } }), setD), [status, page, sellerId, track]);
  useEffect(() => { load(); }, [load]);

  async function call(fn: () => Promise<unknown>, msg: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(msg);
      setPaid(null);
      setUtr("");
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }
  async function bankFile() {
    setError(null);
    try {
      await downloadFile("/api/admin/payouts/bank-file.csv", undefined, "bank-file.csv");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the bank file");
    }
  }

  if (!d) return <PageLoader />;
  const dueTotal = d.due.reduce((s, x) => s + x.amount, 0);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Seller payouts"
        sub={d.mode === "razorpayx" ? "Payouts are sent through RazorpayX and confirmed automatically." : "Manual mode: download the bank file, upload it in your bank's bulk-transfer screen, then record each UTR here. Payouts whose seller changed bank details are left out of the file until you confirm the new account."}
        actions={
          <>
            {d.mode !== "razorpayx" && <Button variant="secondary" onClick={bankFile}><Download className="h-4 w-4" /> Bank file</Button>}
            <ExportButton scope="admin" name="payouts" status={status || undefined} />
            <Button onClick={() => call(() => api("/api/admin/payouts/run", { method: "POST" }), "Payouts created")} loading={busy}>Create payouts now</Button>
          </>
        }
      />
      <ErrorNote message={error} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Ready to pay" value={rupeesExact(dueTotal)} hint={`${d.due.length} sellers with balances past the return window`} />
        <Stat label="Payout method" value={d.mode === "razorpayx" ? "RazorpayX" : "Bank file"} hint={d.mode === "razorpayx" && !d.razorpayx_ready ? "RazorpayX keys missing" : undefined} />
        <Stat label="Pending payouts" value={d.items.filter((p) => p.status === "pending").length} />
      </div>
      <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} items={[{ value: "pending", label: "To pay" }, { value: "processing", label: "Processing" }, { value: "paid", label: "Paid" }, { value: "failed", label: "Failed" }, { value: "cancelled", label: "Cancelled" }, { value: "", label: "All" }]} />
      {d.items.length === 0 ? <EmptyState title="No payouts here" /> : (
        <Table head={["Payout", "Seller", "Amount", "Bank", "Created", "Status", ""]}>
          {d.items.map((p) => (
            <tr key={p.id}>
              <td className="px-4 py-2.5 font-medium">{p.number}</td>
              <td className="px-4 py-2.5">{p.seller_name}</td>
              <td className="px-4 py-2.5 font-semibold">{rupeesExact(p.amount)}</td>
              <td className="px-4 py-2.5 text-sm">
                {p.bank.holder}<br /><span className="text-ink-faint">XXXX{p.bank.account_last4}, {p.bank.ifsc}</span>
                {p.bank_changed && (
                  <span className="mt-1 block max-w-[220px] rounded bg-marigold-light px-2 py-1 text-xs font-semibold text-ink" data-testid="bank-changed">
                    The seller&apos;s bank account changed after this payout was made. Check with the seller before paying.
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-sm">{date(p.created_at)}</td>
              <td className="px-4 py-2.5">
                <StatusPill status={p.status === "paid" ? "approved" : p.status === "failed" || p.status === "cancelled" ? "failed" : "pending"} label={p.status} />
                {p.utr && <p className="font-mono text-xs">{p.utr}</p>}
                {p.failure_reason && <p className="text-xs text-vermilion">{p.failure_reason}</p>}
              </td>
              <td className="px-4 py-2.5">
                {p.status === "pending" && (
                  <div className="flex flex-wrap gap-1">
                    {p.bank_changed && (
                      <Button size="sm" variant="secondary" onClick={() => window.confirm("Pay this payout to the seller's new bank account? Do this only after checking the change with the seller.")
                        && call(() => api(`/api/admin/payouts/${p.id}/use-current-bank`, { method: "POST" }), "The payout now goes to the new account")}>
                        Use the new account
                      </Button>
                    )}
                    {d.mode === "razorpayx" ? (!p.bank_changed && (
                      <Button size="sm" onClick={() => call(() => api(`/api/admin/payouts/${p.id}/send`, { method: "POST" }), "Sent to RazorpayX")}><Send className="h-4 w-4" /> Send</Button>
                    )) : (
                      <Button size="sm" onClick={() => setPaid(p)}>Record UTR</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => window.confirm("Cancel this payout? The balance returns to the seller's available amount.") && call(() => api(`/api/admin/payouts/${p.id}/cancel`, { method: "POST" }), "Payout cancelled")}>Cancel</Button>
                  </div>
                )}
                {p.mode === "razorpayx" && p.status === "processing" && <Pill tone="blue">Waiting for bank</Pill>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Pagination page={page} pageSize={50} total={d.total} onPage={setPage} />
      <Modal open={!!paid} onClose={() => setPaid(null)} title={`Record payment ${paid?.number ?? ""}`}>
        {paid && (
          <div className="flex flex-col gap-3">
            <p className="text-ink-soft">{rupeesExact(paid.amount)} to {paid.bank.holder}, account ending {paid.bank.account_last4}.</p>
            <TextField label="UTR / bank reference" value={utr} onChange={(e) => setUtr(e.target.value.replace(/[^A-Za-z0-9]/g, ""))} maxLength={40} />
            <Button disabled={utr.length < 6} loading={busy} onClick={() => call(() => api(`/api/admin/payouts/${paid.id}/paid`, { method: "POST", body: { utr } }), "Marked as paid")}>Mark as paid</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function AdminPayouts() {
  return <Suspense fallback={<PageLoader />}><AdminPayoutsInner /></Suspense>;
}
