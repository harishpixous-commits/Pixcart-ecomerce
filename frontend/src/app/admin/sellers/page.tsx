"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { EmptyState, Input, PageLoader, Pagination, StatusPill } from "@/components/ui";
import { api } from "@/lib/api";
import { date } from "@/lib/format";
import type { Paged } from "@/lib/types";
import { ExportButton } from "@/components/export-button";

type Row = { id: string; display_name: string; legal_name: string; gstin: string | null; status: string; city: string; state: string; submitted_at: string | null; created_at: string };

function List() {
  const sp = useSearchParams();
  const router = useRouter();
  const status = sp.get("status") ?? "submitted";
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Paged<Row> | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api<Paged<Row>>("/api/admin/sellers", { query: { status: status || undefined, q, page } }).then(setD), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [status, q, page]);
  const c = d?.status_counts ?? {};
  return (
    <div>
      <PageHeader title="Sellers" actions={<ExportButton scope="admin" name="sellers" status={status || undefined} dated={false} />} />
      <Tabs
        value={status}
        onChange={(v) => { setPage(1); router.push(`/admin/sellers?status=${v}`); }}
        items={[["submitted", "To verify"], ["approved", "Approved"], ["rejected", "Sent back"], ["suspended", "Suspended"], ["draft", "Not submitted"], ["", "All"]].map(([v, l]) => ({ value: v, label: l, count: v ? c[v] ?? 0 : undefined }))}
      />
      <Input placeholder="Search name, GSTIN or phone" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search sellers" />
      {!d ? <PageLoader /> : d.items.length === 0 ? <EmptyState title="No sellers here" /> : (
        <>
          <Table head={["Store", "Legal name", "GSTIN", "Location", "Submitted", "Status"]}>
            {d.items.map((s) => (
              <tr key={s.id} className="hover:bg-mist/60">
                <td className="px-4 py-3"><Link href={`/admin/sellers/${s.id}`} className="font-semibold text-peacock hover:underline">{s.display_name}</Link></td>
                <td className="px-4 py-3">{s.legal_name}</td>
                <td className="px-4 py-3 font-mono text-sm">{s.gstin}</td>
                <td className="px-4 py-3 text-sm">{s.city}{s.state ? `, ${s.state}` : ""}</td>
                <td className="px-4 py-3 text-sm">{date(s.submitted_at)}</td>
                <td className="px-4 py-3"><StatusPill status={s.status} /></td>
              </tr>
            ))}
          </Table>
          <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

export default function AdminSellers() {
  return <Suspense fallback={<PageLoader />}><List /></Suspense>;
}
