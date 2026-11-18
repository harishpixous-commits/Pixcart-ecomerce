"use client";

import { useEffect, useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { Button, PageLoader } from "@/components/ui";
import { api, quietly } from "@/lib/api";
import { dateTime } from "@/lib/format";

type Row = { action: string; entity_type: string; entity_id: string; detail: string; actor: string; at: string };

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    api<{ items: Row[] }>("/api/admin/audit", { query: { page } }).then((d) => setRows(d.items)).catch(quietly);
  }, [page]);
  if (!rows) return <PageLoader />;
  return (
    <div>
      <PageHeader title="Audit log" sub="Every approval, rejection, cancellation, settings change and KYC view." />
      <Table head={["When", "Who", "Action", "Record", "Detail"]}>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="whitespace-nowrap px-4 py-2 text-sm">{dateTime(r.at)}</td>
            <td className="px-4 py-2">{r.actor}</td>
            <td className="px-4 py-2 font-medium">{r.action}</td>
            <td className="px-4 py-2 text-sm text-ink-faint">{r.entity_type} {r.entity_id.slice(0, 8)}</td>
            <td className="px-4 py-2 text-sm">{r.detail}</td>
          </tr>
        ))}
      </Table>
      <div className="flex justify-center gap-2 py-4">
        <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Newer</Button>
        <Button variant="secondary" size="sm" disabled={rows.length < 50} onClick={() => setPage(page + 1)}>Older</Button>
      </div>
    </div>
  );
}
