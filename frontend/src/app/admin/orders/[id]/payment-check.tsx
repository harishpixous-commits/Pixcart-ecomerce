"use client";

/*
 * Admin order page: the online payment as Razorpay recorded it, and "Check payment with Razorpay" for an order still
 * waiting for payment when the shopper says they paid (their phone lost the confirmation and no webhook arrived).
 * The server asks Razorpay; a payment it captured is recorded exactly as the webhook would record it.
 */

import { CheckCircle2, CreditCard, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button, StatusPill } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateTime, PAYMENT_STATUS_LABEL, rupeesExact } from "@/lib/format";
import type { OrderDetail } from "@/lib/types";

type Attempt = { id: string; status: string; method: string; error: string };
type Reply = { result: string; attempts?: Attempt[]; waiting?: boolean; reason?: string; payment?: { id: string; method: string } };

const RESULT: Record<string, string> = {
  already_paid: "Already paid. Nothing to change.",
  already: "Already paid. Nothing to change.",
  paid: "Razorpay has the payment. The order is now paid and sent to the seller.",
  refund: "This was a second payment for an order already paid. It is being refunded to the shopper.",
  not_paid: "Razorpay has no successful payment for this order yet.",
};

export function PaymentCheck({ order, onChecked }: { order: OrderDetail; onChecked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const paid = order.paid;

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Reply>(`/api/admin/orders/${order.id}/check-payment`, { method: "POST" });
      setReply(r);
      onChecked();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not check with Razorpay");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl bg-white p-4" data-testid="payment-check" aria-labelledby="pay-h">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="pay-h" className="flex items-center gap-2 font-semibold"><CreditCard className="h-4 w-4 text-peacock" aria-hidden /> Online payment</h2>
        <StatusPill status={order.payment_status} label={PAYMENT_STATUS_LABEL[order.payment_status]} />
        <Button size="sm" variant="secondary" className="ml-auto" loading={busy} onClick={check}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Check payment with Razorpay
        </Button>
      </div>
      {paid ? (
        <p className="mt-2 flex items-start gap-2 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-leaf" aria-hidden />
          <span className="min-w-0 break-words">
            Received {rupeesExact(paid.amount)}{paid.method ? ` by ${paid.method}` : ""}
            {paid.reference && <>, Razorpay reference <span className="font-mono font-semibold">{paid.reference}</span></>}
            {paid.at && <>, {dateTime(paid.at)}</>}
          </span>
        </p>
      ) : order.status === "pending_payment" ? (
        <p className="mt-2 text-sm text-ink-soft">
          Waiting for payment{order.payment_expires_at ? ` until ${dateTime(order.payment_expires_at)}` : ""}. If the shopper says they paid, check with Razorpay.
        </p>
      ) : null}
      {error && <p role="alert" className="mt-2 text-sm text-vermilion">{error}</p>}
      {reply && (
        <div role="status" className="mt-2 rounded-lg bg-mist p-3 text-sm">
          <p className="font-medium">{reply.waiting ? "A UPI request is still open: the shopper has not approved it yet." : RESULT[reply.result] ?? reply.result}</p>
          {reply.reason && <p className="text-ink-soft">Last attempt: {reply.reason}</p>}
          {!!reply.attempts?.length && (
            <ul className="mt-1 space-y-0.5 text-xs text-ink-soft">
              {reply.attempts.map((a) => (
                <li key={a.id} className="break-words">
                  <span className="font-mono">{a.id}</span>: {a.status}{a.method ? `, ${a.method}` : ""}{a.error ? `, ${a.error}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
