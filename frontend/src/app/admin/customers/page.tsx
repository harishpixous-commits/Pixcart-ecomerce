"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, Table } from "@/components/portal-shell";
import { Button, Input, Modal, PageLoader, Pagination, Pill, Textarea, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { date } from "@/lib/format";
import type { Paged } from "@/lib/types";
import { ExportButton } from "@/components/export-button";

type Row = { id: string; name: string; phone: string | null; email: string | null; is_admin: boolean; is_active: boolean; orders: number; created_at: string };

export default function AdminCustomers() {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Paged<Row> | null>(null);
  const [blocking, setBlocking] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<Paged<Row>>("/api/admin/customers", { query: { q, page } }), setD), [q, page, track]);
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function block() {
    if (!blocking) return;
    try {
      await api(`/api/admin/customers/${blocking.id}/block`, { method: "POST", body: { reason } });
      toast("Account blocked and signed out everywhere");
      setBlocking(null);
      setReason("");
      load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed", "error");
    }
  }
  async function unblock(r: Row) {
    await api(`/api/admin/customers/${r.id}/unblock`, { method: "POST" });
    toast("Account unblocked");
    load();
  }

  return (
    <div>
      <PageHeader title="Customers" actions={<ExportButton scope="admin" name="customers" dated={false} />} />
      <Input placeholder="Name, mobile or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search customers" />
      {!d ? <PageLoader /> : (
        <>
          <Table head={["Name", "Mobile", "Email", "Orders", "Joined", "Status", ""]}>
            {d.items.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2.5">{u.name || "—"} {u.is_admin && <Pill tone="blue">Admin</Pill>}</td>
                <td className="px-4 py-2.5">{u.phone}</td>
                <td className="px-4 py-2.5 text-sm">{u.email}</td>
                <td className="px-4 py-2.5">{u.orders}</td>
                <td className="px-4 py-2.5 text-sm">{date(u.created_at)}</td>
                <td className="px-4 py-2.5">{u.is_active ? <Pill tone="green">Active</Pill> : <Pill tone="red">Blocked</Pill>}</td>
                <td className="px-4 py-2.5">
                  {!u.is_admin && (u.is_active ? <Button size="sm" variant="ghost" onClick={() => setBlocking(u)}>Block</Button> : <Button size="sm" variant="ghost" onClick={() => unblock(u)}>Unblock</Button>)}
                </td>
              </tr>
            ))}
          </Table>
          <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </>
      )}
      <Modal open={!!blocking} onClose={() => setBlocking(null)} title={`Block ${blocking?.name || blocking?.phone}?`}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (kept in the audit log)" aria-label="Reason" />
        <Button className="mt-3" variant="buy" disabled={reason.trim().length < 5} onClick={block}>Block account</Button>
      </Modal>
    </div>
  );
}
