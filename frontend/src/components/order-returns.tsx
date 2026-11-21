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

// The customer asks for a return themselves; staff (Admin → order) open one on the customer's behalf, by the same rules.
const REQUEST_COPY = {
  customer: {
    path: "/api/returns", title: "Return items", why: "Why are you returning?", upi: "UPI ID for your refund",
    upiHint: "You paid cash on delivery, so we send the refund to this UPI ID", submit: "Request return", done: "Return requested", failed: "Could not request the return",
  },
  staff: {
    path: "/api/admin/returns", title: "Open a return for the customer", why: "Why is the customer returning?", upi: "Customer's UPI ID for the refund",
    upiHint: "They paid cash on delivery, so the refund goes to this UPI ID", submit: "Open return", done: "Return opened", failed: "Could not open the return",
  },
};

export function ReturnRequestModal({ subId, items, needsUpi, open, onClose, onDone, staff = false }: { subId: string; items: ReturnableItem[]; needsUpi: boolean; open: boolean; onClose: () => void; onDone: () => void; staff?: boolean }) {
  const copy = REQUEST_COPY[staff ? "staff" : "customer"];
  const [reasons, setReasons] = useState<{ code: string; label: string; defect: boolean }[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [upi, setUpi] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (open) api<{ reasons: { code: string; label: string; defect: boolean }[] }>("/api/returns/reasons").then((r) => setReasons(r.reasons)).catch(quietly);
  }, [open]);
  const chosen = items.filter((i) => (qty[i.order_item_id] ?? 0) > 0);
  const refund = chosen.reduce((n, i) => n + i.unit_refund * (qty[i.order_item_id] ?? 0), 0);
  // an item past its own return window comes back only if it arrived damaged, faulty, wrong or incomplete
  const defectsOnly = chosen.some((i) => i.defects_only);
  const allowed = defectsOnly ? reasons.filter((r) => r.defect) : reasons;
  const why = allowed.some((r) => r.code === reason) ? reason : "";
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api(copy.path, { method: "POST", body: { sub_order_id: subId, items: chosen.map((i) => ({ order_item_id: i.order_item_id, qty: qty[i.order_item_id] })), reason: why, comment, refund_upi: upi } });
      toast(copy.done);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : copy.failed);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={copy.title} wide>
      <div className="flex flex-col gap-4">
        <ErrorNote message={error} />
        <div className="flex flex-col gap-3">
          {items.map((i) => (
            <div key={i.order_item_id} className="flex items-center gap-3">
              <ProductImage src={i.image} alt="" className="h-14 w-14 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">{i.title}</p>
                <p className="text-sm text-ink-faint">
                  {!i.eligible ? "Return window closed or not returnable"
                    : `${i.defects_only ? "Only if it arrived damaged, faulty, wrong or incomplete: return" : "Return"} by ${date(i.return_by)}, refund ${rupees(i.unit_refund)} each`}
                </p>
              </div>
              <Select aria-label={`Quantity to return of ${i.title}`} disabled={!i.eligible} value={qty[i.order_item_id] ?? 0} onChange={(e) => setQty({ ...qty, [i.order_item_id]: Number(e.target.value) })} className="h-9 w-20">
                {Array.from({ length: i.qty_left + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </div>
          ))}
        </div>
        <Field label={copy.why} htmlFor="rr" hint={defectsOnly ? "Some items you chose can be returned only for these reasons" : undefined}>
          <Select id="rr" value={why} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason</option>
            {allowed.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </Select>
        </Field>
        <Field label="More details (optional)" htmlFor="rc"><Textarea id="rc" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} rows={3} /></Field>
        {needsUpi && <TextField label={copy.upi} value={upi} onChange={(e) => setUpi(e.target.value.trim())} placeholder="yourname@okbank" hint={copy.upiHint} />}
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
          <p>Refund: <span className="font-display text-lg font-bold">{rupees(refund)}</span></p>
          <Button onClick={submit} loading={busy} disabled={!chosen.length || !why || (needsUpi && !upi)}>{copy.submit}</Button>
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
              {r.fleet_pickup?.requested && <FleetPickupNote f={r.fleet_pickup} />}
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

/** Our delivery partner collecting the return: the step, who is coming, and the code to give them. */
function FleetPickupNote({ f }: { f: NonNullable<ReturnView["fleet_pickup"]> }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-xl bg-peacock-light/50 p-3 text-sm ring-1 ring-peacock/15" data-testid="return-fleet-pickup">
      <p className="font-semibold text-peacock-dark">Pickup by our delivery partner{f.label ? `: ${f.label}` : ""}</p>
      {f.partner && (
        <p className="text-ink-soft">
          {f.partner.name}{f.partner.vehicle_no ? ` · ${f.partner.vehicle_no}` : ""}
          {f.partner.phone && <> · <a href={`tel:${f.partner.phone}`} className="font-semibold text-peacock">Call</a></>}
        </p>
      )}
      {f.status === "failed" && f.fail_reason && <p className="text-vermilion">Last try: {f.fail_reason}. We will arrange another pickup.</p>}
      {f.code && (
        <p className="flex items-center gap-2">
          <span className="text-ink-soft">Pickup code</span>
          <span className="rounded-lg bg-white px-2 py-0.5 font-mono text-lg font-bold tracking-[0.3em] ring-1 ring-line" data-testid="return-pickup-code">{f.code}</span>
          <span className="text-xs text-ink-faint">Give it to the partner only when you hand over the item.</span>
        </p>
      )}
    </div>
  );
}
