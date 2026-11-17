"use client";

import { FileText } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Input, Modal, PageLoader, StatusPill, Textarea, useToast } from "@/components/ui";
import { api, ApiError, downloadBlob } from "@/lib/api";
import { dateTime, pct } from "@/lib/format";
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

  const load = useCallback(() => api<SellerProfile>(`/api/admin/sellers/${id}`).then((x) => { setS(x); setCommission(x.commission_bps_override !== null ? String(x.commission_bps_override / 100) : ""); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  async function act(path: string, body?: object, msg = "Updated") {
    setBusy(true);
    setError(null);
    try {
      setS(await api<SellerProfile>(`/api/admin/sellers/${id}/${path}`, { method: path === "commission" ? "PUT" : "POST", body }));
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
    ["Account owner", s.owner ? `${s.owner.name || "—"}, ${s.owner.phone ?? s.owner.email}` : "—"],
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
            {(s.status === "submitted" || s.status === "suspended") && <Button onClick={() => act("approve", undefined, "Seller approved")} loading={busy}>Approve seller</Button>}
            {(s.status === "submitted" || s.status === "approved") && <Button variant="secondary" onClick={() => setDialog("reject")}>Send back for changes</Button>}
            {s.status === "approved" && <Button variant="danger" onClick={() => setDialog("suspend")}>Suspend</Button>}
          </>
        }
      />
      <ErrorNote message={error} />
      <div className="flex items-center gap-3"><StatusPill status={s.status} />{s.rejection_reason && <span className="text-vermilion">{s.rejection_reason}</span>}</div>
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <section className="rounded-xl bg-white p-5">
          <h2 className="mb-3 text-lg font-semibold">KYC details</h2>
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
          <Link href={`/admin/products?status=&seller_id=${s.id}`} className="font-semibold text-peacock hover:underline">See this seller&apos;s listings</Link>
        </div>
      </div>
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
