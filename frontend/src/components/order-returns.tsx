"use client";

import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, ErrorNote, Field, Modal, ProductImage, Select, StatusPill, Textarea, TextField, useToast } from "@/components/ui";
import { api, ApiError, downloadBlob, quietly } from "@/lib/api";
import { date, rupees } from "@/lib/format";
import type { ReturnableItem, ReturnView } from "@/lib/types";

export const RETURN_STATUS: Record<string, string> = {
  requested: "Waiting for the seller",
  approved: "Approved, pickup pending",
  picked_up: "Picked up",
  received: "Received, refund pending",
  refunded: "Refunded",
  rejected: "Not accepted",
  cancelled: "Cancelled",
};

export async function openPdf(path: string, onError: (m: string) => void) {
  try {
    const blob = await downloadBlob(path);
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  } catch (e) {
    onError(e instanceof Error ? e.message : "Could not open the document");
  }
}

export function ReturnRequestModal({ subId, items, needsUpi, open, onClose, onDone }: { subId: string; items: ReturnableItem[]; needsUpi: boolean; open: boolean; onClose: () => void; onDone: () => void }) {
  const [reasons, setReasons] = useState<{ code: string; label: string }[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [upi, setUpi] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (open) api<{ reasons: { code: string; label: string }[] }>("/api/returns/reasons").then((r) => setReasons(r.reasons)).catch(quietly);
  }, [open]);
  const chosen = items.filter((i) => (qty[i.order_item_id] ?? 0) > 0);
  const refund = chosen.reduce((n, i) => n + i.unit_refund * (qty[i.order_item_id] ?? 0), 0);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/returns", { method: "POST", body: { sub_order_id: subId, items: chosen.map((i) => ({ order_item_id: i.order_item_id, qty: qty[i.order_item_id] })), reason, comment, refund_upi: upi } });
      toast("Return requested");
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not request the return");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Return items" wide>
      <div className="flex flex-col gap-4">
        <ErrorNote message={error} />
        <div className="flex flex-col gap-3">
          {items.map((i) => (
            <div key={i.order_item_id} className="flex items-center gap-3">
              <ProductImage src={i.image} alt="" className="h-14 w-14 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">{i.title}</p>
                <p className="text-sm text-ink-faint">{i.eligible ? `Return by ${date(i.return_by)}, refund ${rupees(i.unit_refund)} each` : "Return window closed or not returnable"}</p>
              </div>
              <Select aria-label={`Quantity to return of ${i.title}`} disabled={!i.eligible} value={qty[i.order_item_id] ?? 0} onChange={(e) => setQty({ ...qty, [i.order_item_id]: Number(e.target.value) })} className="h-9 w-20">
                {Array.from({ length: i.qty_left + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </div>
          ))}
        </div>
        <Field label="Why are you returning?" htmlFor="rr">
          <Select id="rr" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason</option>
            {reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="More details (optional)" htmlFor="rc"><Textarea id="rc" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} rows={3} /></Field>
        {needsUpi && <TextField label="UPI ID for your refund" value={upi} onChange={(e) => setUpi(e.target.value.trim())} placeholder="yourname@okbank" hint="You paid cash on delivery, so we send the refund to this UPI ID" />}
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <p>Refund: <span className="font-display text-lg font-bold">{rupees(refund)}</span></p>
          <Button onClick={submit} loading={busy} disabled={!chosen.length || !reason || (needsUpi && !upi)}>Request return</Button>
        </div>
      </div>
    </Modal>
  );
}

export function ReturnsList({ returns, onCancel }: { returns: ReturnView[]; onCancel: (id: string) => void }) {
  const toast = useToast();
  if (!returns.length) return null;
  return (
    <section className="rounded-xl bg-white p-4">
      <h2 className="mb-2 text-lg font-semibold">Returns</h2>
      <ul className="divide-y divide-line">
        {returns.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div>
              <p className="font-semibold">{r.number}: {r.items.map((i) => `${i.title} × ${i.qty}`).join(", ")}</p>
              <p className="text-sm text-ink-soft">{r.reason_label}. Refund {rupees(r.refund_amount)}{r.refund_upi ? ` to ${r.refund_upi}` : ""}.</p>
              {r.seller_note && <p className="text-sm text-ink-soft">Seller: {r.seller_note}</p>}
              {r.pickup_tracking && <p className="text-sm text-ink-soft">Pickup: {r.pickup_courier} {r.pickup_tracking}</p>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <StatusPill status={r.status === "refunded" ? "approved" : r.status === "rejected" ? "rejected" : r.status === "cancelled" ? "cancelled" : "pending"} label={RETURN_STATUS[r.status]} />
              {r.credit_note_number && (
                <button className="inline-flex items-center gap-1 text-sm font-semibold text-peacock" onClick={() => openPdf(`/api/credit-notes/${r.id}.pdf`, (m) => toast(m, "error"))}>
                  <FileText className="h-4 w-4" /> Credit note
                </button>
              )}
              {(r.status === "requested" || r.status === "approved") && <Button size="sm" variant="ghost" onClick={() => onCancel(r.id)}>Cancel return</Button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
