"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExportButton } from "@/components/export-button";
import { PageHeader, Table, Tabs } from "@/components/portal-shell";
import { Button, ErrorNote, Input, Modal, PageLoader, Pagination, Pill, TextField, useToast } from "@/components/ui";
import { api, ApiError, latestOnly } from "@/lib/api";
import { date } from "@/lib/format";
import type { Paged } from "@/lib/types";

type Row = { id: string; name: string; phone: string | null; email: string | null; is_admin: boolean; is_active: boolean; orders: number;
  seller: { id: string; status: string } | null; last_login_at: string | null; created_at: string };
const KINDS = [
  { value: "all", label: "Everyone" }, { value: "customers", label: "Customers" }, { value: "sellers", label: "Sellers" },
  { value: "staff", label: "Staff" }, { value: "blocked", label: "Blocked" },
];

export default function AdminCustomers() {
  const toast = useToast();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Paged<Row> | null>(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", phone: "", email: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const track = useMemo(() => latestOnly(), []);
  const load = useCallback(() => track(api<Paged<Row>>("/api/admin/customers", { query: { q, page, kind } }), setD), [q, page, kind, track]);
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const r = await api<{ id: string }>("/api/admin/customers", { method: "POST", body: { name: f.name, phone: f.phone, email: f.email.trim() || null } });
      toast("Customer account created. They sign in with an OTP on this mobile.");
      router.push(`/admin/customers/${r.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the account");
      if (err instanceof ApiError) setFieldErrors(err.fields ?? {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title="Customers and accounts" sub="Every account: customers, sellers' logins and staff. Open one to see and manage its details."
        actions={<>
          <Button onClick={() => { setAdding(true); setF({ name: "", phone: "", email: "" }); setError(null); }}><Plus className="h-4 w-4" />Add customer</Button>
          <ExportButton scope="admin" name="customers" dated={false} />
        </>} />
      <Tabs value={kind} onChange={(v) => { setKind(v); setPage(1); }} items={KINDS} />
      <Input placeholder="Name, mobile or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="mb-3 max-w-sm" aria-label="Search accounts" />
      {!d ? <PageLoader /> : (
        <>
          <Table head={["Name", "Mobile", "Email", "Orders", "Joined", "Last sign-in", "Status"]}>
            {d.items.map((u) => (
              <tr key={u.id} className="cursor-pointer hover:bg-mist/60" onClick={() => router.push(`/admin/customers/${u.id}`)}>
                <td className="px-4 py-2.5">
                  <Link href={`/admin/customers/${u.id}`} className="font-semibold text-peacock" onClick={(e) => e.stopPropagation()}>{u.name || "—"}</Link>{" "}
                  {u.is_admin && <Pill tone="blue">Staff</Pill>} {u.seller && <Pill tone="gray">Seller</Pill>}
                </td>
                <td className="px-4 py-2.5">{u.phone}</td>
                <td className="px-4 py-2.5 text-sm">{u.email}</td>
                <td className="px-4 py-2.5">{u.orders}</td>
                <td className="px-4 py-2.5 text-sm">{date(u.created_at)}</td>
                <td className="px-4 py-2.5 text-sm">{u.last_login_at ? date(u.last_login_at) : "Never"}</td>
                <td className="px-4 py-2.5">{u.is_active ? <Pill tone="green">Active</Pill> : <Pill tone="red">Blocked</Pill>}</td>
              </tr>
            ))}
          </Table>
          {!d.items.length && <p className="py-6 text-center text-ink-faint">No accounts match.</p>}
          <Pagination page={d.page} pageSize={d.page_size} total={d.total} onPage={setPage} />
        </>
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a customer">
        <form onSubmit={add} className="flex flex-col gap-3">
          <p className="text-sm text-ink-soft">For orders taken on the phone or in a shop. The customer signs in with a one-time code on this mobile; no password is needed.</p>
          <ErrorNote message={error} />
          <TextField label="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={fieldErrors.name} required autoFocus />
          <TextField label="Mobile number" type="tel" inputMode="numeric" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} error={fieldErrors.phone} required />
          <TextField label="Email (optional)" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={fieldErrors.email} />
          <Button type="submit" loading={busy} disabled={f.name.trim().length < 2 || f.phone.replace(/\D/g, "").length < 10}>Create account</Button>
        </form>
      </Modal>
    </div>
  );
}
