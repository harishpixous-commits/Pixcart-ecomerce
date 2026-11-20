"use client";

import { useEffect, useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { Button, ErrorNote, Input, PageLoader } from "@/components/ui";
import Link from "next/link";
import { api, downloadFile, quietly } from "@/lib/api";
import { pct, rupeesExact } from "@/lib/format";

type Row = { seller_id: string; legal_name: string; gstin: string; net_taxable_value: number; igst_tcs: number; cgst_tcs: number; sgst_tcs: number; sub_orders: number; returned_value?: number };
type R = { month: string; tcs_rate_bps: number; note: string; items: Row[]; totals: Record<string, number> };



export default function TcsReport() {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [rv, setRv] = useState<{ month: string; data: R } | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);
  useEffect(() => {
    api<R>("/api/admin/reports/tcs", { query: { month } }).then((data) => setRv({ month, data })).catch(quietly);
  }, [month]);
  const r = rv && rv.month === month ? rv.data : null; // a new month shows the loader, not last month's numbers
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Reports" sub="GST TCS for GSTR-8 (due by the 10th of the next month) and data exports for your accountant." actions={r && r.items.length > 0 ? <Button variant="secondary" onClick={() => { setDlError(null); downloadFile("/api/admin/exports/tcs.csv", { month }, `tcs-${month}.csv`).catch((e) => setDlError(e.message)); }}>Download CSV</Button> : undefined} />
      <p className="rounded-xl bg-white p-4 text-sm">All other data (orders, GST line items, returns, payouts, catalogue, customers) is on the <Link href="/admin/exports" className="font-semibold text-peacock">Exports</Link> page.</p>
      <ErrorNote message={dlError} />
      <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-48" aria-label="Month" />
      {!r ? <PageLoader /> : (
        <>
          <p className="text-sm text-ink-soft">Rate {pct(r.tcs_rate_bps)}. {r.note}</p>
          <Table head={["Seller", "GSTIN", "Packages", "Returns", "Net taxable value", "IGST", "CGST", "SGST"]}>
            {r.items.map((i) => (
              <tr key={i.seller_id}>
                <td className="px-4 py-2.5">{i.legal_name}</td>
                <td className="px-4 py-2.5 font-mono text-sm">{i.gstin}</td>
                <td className="px-4 py-2.5">{i.sub_orders}</td>
                <td className="px-4 py-2.5 text-vermilion">{i.returned_value ? `−${rupeesExact(i.returned_value)}` : "—"}</td>
                <td className="px-4 py-2.5">{rupeesExact(i.net_taxable_value)}</td>
                <td className="px-4 py-2.5">{rupeesExact(i.igst_tcs)}</td>
                <td className="px-4 py-2.5">{rupeesExact(i.cgst_tcs)}</td>
                <td className="px-4 py-2.5">{rupeesExact(i.sgst_tcs)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="px-4 py-2.5" colSpan={4}>Total</td>
              <td className="px-4 py-2.5">{rupeesExact(r.totals.net_taxable_value ?? 0)}</td>
              <td className="px-4 py-2.5">{rupeesExact(r.totals.igst_tcs ?? 0)}</td>
              <td className="px-4 py-2.5">{rupeesExact(r.totals.cgst_tcs ?? 0)}</td>
              <td className="px-4 py-2.5">{rupeesExact(r.totals.sgst_tcs ?? 0)}</td>
            </tr>
          </Table>
        </>
      )}
    </div>
  );
}
