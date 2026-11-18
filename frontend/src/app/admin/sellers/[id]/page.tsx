"use client";

import { FileText, Pencil } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Input, Modal, PageLoader, Select, StatusPill, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, downloadBlob } from "@/lib/api";
import { dateTime, pct, STATE_OPTIONS } from "@/lib/format";
import type { SellerProfile } from "@/lib/types";
import { RiskBrief } from "@/components/ai";

export default function AdminSellerDetail() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [s, setS] = useState<SellerProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"reject" | "suspend" | null>(null);
  const [reason, setReason] = useState("");
  const [commission, setCommission] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<"business" | "pickup-address" | "bank" | "grievance-officer" | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [editErr, setEditErr] = useState<string | null>(null);

  function openEdit(kind: NonNullable<typeof edit>) {
    if (!s) return;
    setEditErr(null);
    setFieldErr({});
    setF(kind === "business" ? { display_name: s.display_name, legal_name: s.legal_name, business_type: s.business_type, gstin: s.gstin ?? "", pan: s.pan ?? "", contact_email: s.contact_email, contact_phone: s.contact_phone, description: s.description }
      : kind === "pickup-address" ? { line1: s.pickup.line1, line2: s.pickup.line2, city: s.pickup.city, state_code: s.pickup.state_code || "33", pincode: s.pickup.pincode }
      : kind === "bank" ? { holder_name: s.bank.holder_name, ifsc: s.bank.ifsc, account_number: "", confirm_account_number: "" }
      : { name: s.grievance.name, email: s.grievance.email, phone: s.grievance.phone });
    setEdit(kind);
  }
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!edit || !s) return;
    setBusy(true);
    setEditErr(null);
    setFieldErr({});
    try {
      const r = await api<SellerProfile>(`/api/admin/sellers/${id}/${edit}`, { method: "PUT", body: f });
      setS({ ...s, ...r, owner: s.owner, product_counts: s.product_counts });
      toast(edit === "bank" ? "Bank account changed. The seller has been told." : "Saved");
      setEdit(null);
    } catch (err) {
      setEditErr(err instanceof ApiError ? err.message : "Could not save");
      if (err instanceof ApiError) setFieldErr(err.fields ?? {});
    } finally {
      setBusy(false);
    }
  }
  const bind = (k: string) => ({ value: f[k] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value }), error: fieldErr[k] });

  const load = useCallback(() => api<SellerProfile>(`/api/admin/sellers/${id}`).then((x) => { setS(x); setCommission(x.commission_bps_override !== null ? String(x.commission_bps_override / 100) : ""); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  async function act(path: string, body?: object, msg = "Updated") {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SellerProfile>(`/api/admin/sellers/${id}/${path}`, { method: path === "commission" ? "PUT" : "POST", body });
      setS((cur) => (cur ? { ...cur, ...r, owner: cur.owner, product_counts: cur.product_counts } : r));
      toast(msg);
      setDialog(null);
      setReason("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function openDoc(kind: string) {
    try {
      const blob = await downloadBlob(`/api/admin/sellers/${id}/documents/${kind}`);
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch {
      toast("Could not open the document", "error");
    }
  }

  if (!s) return error ? <ErrorNote message={error} /> : <PageLoader />;
  const rows: [string, React.ReactNode][] = [
    ["Legal name", s.legal_name],
    ["Business type", s.business_type.replace(/_/g, " ")],
    ["GSTIN", <span key="g" className="font-mono">{s.gstin}</span>],
    ["PAN", <span key="p" className="font-mono">{s.pan}</span>],
    ["PAN in GSTIN matches", s.gstin && s.gstin.slice(2, 12) === s.pan ? "Yes" : "No"],
    ["Contact", `${s.contact_email}, ${s.contact_phone}`],
    ["Account owner", s.owner ? <Link key="o" href={`/admin/customers/${s.owner.id}`} className="font-semibold text-peacock hover:underline">{s.owner.name || "—"}, {s.owner.phone ?? s.owner.email}</Link> : "—"],
    ["Pickup address", `${s.pickup.line1}${s.pickup.line2 ? ", " + s.pickup.line2 : ""}, ${s.pickup.city}, ${s.pickup.state} ${s.pickup.pincode}`],
    ["Bank account", <span key="b">{s.bank.holder_name}, <span className="font-mono">{s.bank.account_number}</span>, IFSC <span className="font-mono">{s.bank.ifsc}</span></span>],
    ["Grievance officer", `${s.grievance.name}, ${s.grievance.email}, ${s.grievance.phone}`],
    ["Submitted", dateTime(s.submitted_at)],
    ["Approved", dateTime(s.approved_at)],
  ];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={s.display_name}
        sub="Check the documents against the details before approving."
        actions={
          <>
            {(s.status === "submitted" || s.status === "suspended" || s.status === "rejected") && <Button onClick={() => act("approve", undefined, "Seller approved")} loading={busy}>{s.status === "suspended" ? "Reactivate seller" : "Approve seller"}</Button>}
            {(s.status === "submitted" || s.status === "approved") && <Button variant="secondary" onClick={() => setDialog("reject")}>Send back for changes</Button>}
            {s.status === "approved" && <Button variant="danger" onClick={() => setDialog("suspend")}>Suspend</Button>}
          </>
        }
      />
      <ErrorNote message={error} />
      <div className="flex items-center gap-3"><StatusPill status={s.status} />{s.rejection_reason && <span className="text-vermilion">{s.rejection_reason}</span>}</div>
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <section className="rounded-xl bg-white p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">KYC details</h2>
            <div className="flex flex-wrap gap-1">
              {([["business", "Business"], ["pickup-address", "Pickup"], ["bank", "Bank"], ["grievance-officer", "Grievance"]] as const).map(([k, l]) => (
                <Button key={k} size="sm" variant="ghost" onClick={() => openEdit(k)}><Pencil className="h-3.5 w-3.5" />{l}</Button>
              ))}
            </div>
          </div>
          <dl className="grid grid-cols-[170px_1fr] gap-y-2 text-[15px]">
            {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-ink-faint">{k}</dt><dd>{v || "—"}</dd></div>))}
          </dl>
        </section>
        <div className="flex flex-col gap-4">
          {s.status === "approved" && <RiskBrief path={`/api/admin/ai/briefs/seller/${id}`} title="Seller health (last 90 days)" />}
          <section className="rounded-xl bg-white p-5">
            <h2 className="mb-3 text-lg font-semibold">Documents</h2>
            {s.documents.length === 0 ? <p className="text-ink-faint">None uploaded</p> : (
              <ul className="flex flex-col gap-2">
                {s.documents.map((d) => (
                  <li key={d.kind}>
                    <button onClick={() => openDoc(d.kind)} className="flex items-center gap-2 font-semibold text-peacock hover:underline">
                      <FileText className="h-4 w-4" /> {d.kind.replace(/_/g, " ")}
                    </button>
                    <p className="text-xs text-ink-faint">{d.filename}, {Math.round(d.size_bytes / 1024)} KB</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-xl bg-white p-5">
            <h2 className="mb-1 text-lg font-semibold">Commission</h2>
            <p className="mb-2 text-sm text-ink-soft">Leave empty to use each category&apos;s rate. A value here applies to all of this seller&apos;s sales.</p>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); act("commission", { commission_bps_override: commission === "" ? null : Math.round(parseFloat(commission) * 100) }, "Commission saved"); }}>
              <Input value={commission} onChange={(e) => setCommission(e.target.value)} placeholder="e.g. 8.5" inputMode="decimal" className="w-28" aria-label="Commission percent" />
              <span className="self-center">%</span>
              <Button type="submit" variant="secondary" loading={busy}>Save</Button>
            </form>
            {s.commission_bps_override !== null && <p className="mt-1 text-sm">Current: {pct(s.commission_bps_override)}</p>}
          </section>
          <section className="rounded-xl bg-white p-5">
            <h2 className="mb-2 text-lg font-semibold">This seller&apos;s</h2>
            <ul className="flex flex-col gap-1.5 font-semibold text-peacock">
              <li><Link href={`/admin/products?status=&seller_id=${s.id}`} className="hover:underline">Listings</Link></li>
              <li><Link href={`/admin/orders?seller_id=${s.id}`} className="hover:underline">Orders</Link></li>
              <li><Link href={`/admin/returns?seller_id=${s.id}`} className="hover:underline">Returns</Link></li>
              <li><Link href={`/admin/payouts?seller_id=${s.id}`} className="hover:underline">Payouts</Link></li>
            </ul>
          </section>
        </div>
      </div>
      <Modal open={edit !== null} onClose={() => setEdit(null)} title={edit === "business" ? "Business details" : edit === "pickup-address" ? "Pickup address" : edit === "bank" ? "Bank account for payouts" : "Grievance officer"} wide>
        <form onSubmit={saveEdit} className="grid gap-3 sm:grid-cols-2">
          <ErrorNote message={editErr} />
          {edit === "business" && <>
            <TextField label="Store name" {...bind("display_name")} required />
            <TextField label="Legal business name" {...bind("legal_name")} required />
            <Field label="Business type" htmlFor="ebt"><Select id="ebt" {...bind("business_type")}>
              {[["proprietorship", "Sole proprietorship"], ["individual", "Individual"], ["partnership", "Partnership firm"], ["llp", "LLP"], ["private_limited", "Private limited company"], ["public_limited", "Public limited company"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select></Field>
            <TextField label="GSTIN" {...bind("gstin")} maxLength={15} className="uppercase" required />
            <TextField label="PAN" {...bind("pan")} maxLength={10} className="uppercase" required hint="Must match characters 3 to 12 of the GSTIN" />
            <TextField label="Business email" type="email" {...bind("contact_email")} required />
            <TextField label="Business mobile" {...bind("contact_phone")} required />
            <Field label="About the store" className="sm:col-span-2"><Textarea {...bind("description")} maxLength={2000} /></Field>
          </>}
          {edit === "pickup-address" && <>
            <TextField className="sm:col-span-2" label="Building, street" {...bind("line1")} required />
            <TextField className="sm:col-span-2" label="Area (optional)" {...bind("line2")} />
            <TextField label="City" {...bind("city")} required />
            <TextField label="PIN code" {...bind("pincode")} maxLength={6} required />
            <Field label="State" htmlFor="est"><Select id="est" {...bind("state_code")}>{STATE_OPTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select></Field>
          </>}
          {edit === "bank" && <>
            <p className="rounded-lg bg-marigold-light p-3 text-sm sm:col-span-2">Payouts go to this account from the next payout. Check a cancelled cheque or bank letter first. The seller is told about the change.</p>
            <TextField label="Account holder name" {...bind("holder_name")} required />
            <TextField label="IFSC" {...bind("ifsc")} maxLength={11} className="uppercase" required />
            <TextField label="Account number" {...bind("account_number")} inputMode="numeric" autoComplete="off" required />
            <TextField label="Confirm account number" {...bind("confirm_account_number")} inputMode="numeric" autoComplete="off" required />
          </>}
          {edit === "grievance-officer" && <>
            <TextField label="Name" {...bind("name")} required />
            <TextField label="Email" type="email" {...bind("email")} required />
            <TextField label="Mobile" {...bind("phone")} required />
          </>}
          <div className="sm:col-span-2"><Button type="submit" loading={busy}>Save</Button></div>
        </form>
      </Modal>
      <Modal open={dialog !== null} onClose={() => setDialog(null)} title={dialog === "suspend" ? "Suspend seller" : "Send back for changes"}>
        <p className="mb-2 text-ink-soft">{dialog === "suspend" ? "Their listings are hidden at once. Existing orders continue." : "The seller sees this message and can fix and resubmit."}</p>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain what needs to change" aria-label="Reason" />
        <Button className="mt-3" variant={dialog === "suspend" ? "buy" : "primary"} disabled={reason.trim().length < 5} loading={busy} onClick={() => act(dialog === "suspend" ? "suspend" : "reject", { reason }, dialog === "suspend" ? "Seller suspended" : "Sent back to seller")}>
          {dialog === "suspend" ? "Suspend seller" : "Send back"}
        </Button>
      </Modal>
    </div>
  );
}
