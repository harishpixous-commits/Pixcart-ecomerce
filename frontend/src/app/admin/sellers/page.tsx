"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { Plus } from "lucide-react";
import { Button, EmptyState, ErrorNote, Input, Modal, PageLoader, Pagination, StatusPill, TextField, useToast } from "@/components/ui";
import { api, ApiError, quietly } from "@/lib/api";
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
    const t = setTimeout(() => api<Paged<Row>>("/api/admin/sellers", { query: { status: status || undefined, q, page } }).then(setD).catch(quietly), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [status, q, page]);
  const c = d?.status_counts ?? {};
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ phone: "", name: "", store: "", email: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string }>("/api/admin/sellers", { method: "POST", body: { phone: f.phone, name: f.name, store_name: f.store, email: f.email.trim() || null } });
      toast("Seller account opened. They sign in with this mobile to finish their details.");
      router.push(`/admin/sellers/${r.id}`);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Could not create the seller");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <PageHeader title="Sellers" actions={<><Button onClick={() => { setAdding(true); setErr(null); setF({ phone: "", name: "", store: "", email: "" }); }}><Plus className="h-4 w-4" />Add seller</Button><ExportButton scope="admin" name="sellers" status={status || undefined} dated={false} /></>} />
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
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a seller">
        <form onSubmit={add} className="flex flex-col gap-3">
          <p className="text-sm text-ink-soft">Opens a seller account in draft. The seller signs in with a one-time code on this mobile, fills in business, PAN, GST, pickup and bank details and submits them; you then verify as usual.</p>
          <ErrorNote message={err} />
          <TextField label="Owner's mobile number" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required autoFocus />
          <TextField label="Owner's name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <TextField label="Store name (shown to customers)" value={f.store} onChange={(e) => setF({ ...f, store: e.target.value })} required />
          <TextField label="Email (optional)" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <Button type="submit" loading={busy} disabled={f.phone.replace(/\D/g, "").length < 10 || f.name.trim().length < 2 || f.store.trim().length < 2}>Open seller account</Button>
        </form>
      </Modal>
    </div>
  );
}

export default function AdminSellers() {
  return <Suspense fallback={<PageLoader />}><List /></Suspense>;
}
