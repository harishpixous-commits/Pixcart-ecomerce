"use client";

/*
 * The payment part of a shopper's order page: opens the Razorpay window, and shows the real result, as Razorpay records
 * it, when the shopper comes back from Google Pay, PhonePe or another UPI app (on a phone, in the app or on a computer):
 *
 *   paid      → "Payment received" with the amount, the way it was paid and Razorpay's reference
 *   failed    → "Payment not received", Razorpay's reason, and Try again
 *   waiting   → "Checking your payment…", asking Razorpay every few seconds and whenever the page comes back into view
 *
 * Nothing is decided in the browser: every answer comes from /api/orders/{id}/payment-status, which asks Razorpay.
 */

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateTime, rupees } from "@/lib/format";
import { clearPaying, payingSince, payWithRazorpay } from "@/lib/razorpay";
import { useSite } from "@/lib/site";
import type { OrderDetail } from "@/lib/types";

type Phase = "idle" | "open" | "checking" | "waiting" | "failed";
type StatusReply = { status: "paid" | "waiting" | "failed" | "not_paid" | "unknown"; reason: string; order: OrderDetail };

const POLL_MS = 5000;
const POLL_FOR_MS = 3 * 60 * 1000; // keep asking for 3 minutes after the shopper comes back
const RECENT_MS = 30 * 60 * 1000; // a payment started in this tab within 30 minutes may still arrive

const METHOD: Record<string, string> = { upi: "UPI", card: "card", netbanking: "net banking", wallet: "wallet", emi: "EMI", paylater: "pay later" };

export type PaymentArrival = { outcome: string; reason: string; open: boolean };

export function OrderPayment({ order, onOrder, arrival, placed }: {
  order: OrderDetail;
  onOrder: (o: OrderDetail) => void;
  /** what the address said on arrival: ?pay=1 (open the window), ?payment=success|failed|checking&reason= */
  arrival: PaymentArrival;
  /** came straight from checkout (?placed=1) */
  placed: boolean;
}) {
  const site = useSite();
  const pending = order.status === "pending_payment" && !!order.payment;
  const [phase, setPhase] = useState<Phase>(() => (arrival.outcome === "failed" ? "failed" : arrival.outcome === "checking" ? "checking" : "idle"));
  const [reason, setReason] = useState(arrival.reason);
  const [justPaid, setJustPaid] = useState(arrival.outcome === "success" || placed);
  const [checkingNow, setCheckingNow] = useState(false);
  const pollUntil = useRef(0);
  const lastFail = useRef("");
  const opened = useRef(false);
  const id = order.id;

  const check = useCallback(async (show: boolean) => {
    if (show) setCheckingNow(true);
    try {
      const r = await api<StatusReply>(`/api/orders/${id}/payment-status`, { method: "POST" });
      onOrder(r.order);
      if (r.status === "paid") {
        clearPaying(id);
        pollUntil.current = 0;
        setJustPaid(true);
        setPhase("idle");
      } else if (r.status === "waiting") {
        setPhase((p) => (p === "open" ? p : "waiting"));
      } else if (r.status === "failed") {
        setReason(r.reason);
        // while polling, a failed attempt ends the wait; the shopper decides to try again
        setPhase((p) => (p === "open" ? p : "failed"));
        pollUntil.current = 0;
      } else if (r.status === "not_paid") {
        setPhase((p) => (p === "open" ? p : Date.now() < pollUntil.current ? "checking" : p === "failed" ? "failed" : "idle"));
      }
      // "unknown": Razorpay could not be reached; keep the current state and try again on the next round
      return r.status;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) pollUntil.current = 0;
      return "unknown";
    } finally {
      if (show) setCheckingNow(false);
    }
  }, [id, onOrder]);

  const startPolling = useCallback(() => {
    pollUntil.current = Date.now() + POLL_FOR_MS;
    setPhase((p) => (p === "failed" ? p : "checking"));
    void check(false);
  }, [check]);

  const pay = useCallback(async () => {
    if (!order.payment) return;
    setPhase("open");
    setReason("");
    lastFail.current = "";
    try {
      const done = await payWithRazorpay(order.payment, {
        orderId: id,
        returnMode: site.payment_return,
        onFailed: (why) => { lastFail.current = why; },
      });
      if (done) {
        clearPaying(id);
        onOrder(done);
        setJustPaid(true);
        setPhase("idle");
        return;
      }
      // the window was closed: the money may still have gone through (approved in the UPI app, then closed)
      setPhase(lastFail.current ? "failed" : "checking");
      setReason(lastFail.current);
      const status = await check(false);
      if (status !== "paid" && !lastFail.current) startPolling();
    } catch (e) {
      setReason(e instanceof Error ? e.message : "The payment could not be started");
      setPhase("failed");
      void check(false);
    }
  }, [order.payment, id, site.payment_return, onOrder, check, startPolling]);

  // On arrival: open the window (from checkout), or find out what happened (back from a UPI app, the page reloaded,
  // or the shopper simply opened an unpaid order).
  useEffect(() => {
    if (!pending || opened.current) return;
    const t = window.setTimeout(() => {
      opened.current = true;
      if (arrival.open) {
        void pay();
        return;
      }
      const recent = Date.now() - payingSince(id) < RECENT_MS;
      if (arrival.outcome === "checking" || arrival.outcome === "success" || recent) startPolling();
      else void check(false);
    }, 0);
    return () => window.clearTimeout(t);
  }, [pending, arrival, id, pay, startPolling, check]);

  // Ask again every few seconds while a payment may be on its way, and whenever the page comes back into view
  // (the shopper switches back from the UPI app).
  useEffect(() => {
    if (!pending) return;
    const tick = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (phase === "open") return;
      if (Date.now() < pollUntil.current) void check(false);
      else if (phase === "checking" || phase === "waiting") setPhase("idle");
    }, POLL_MS);
    const back = () => {
      if (document.visibilityState === "visible" && Date.now() - payingSince(id) < RECENT_MS) {
        pollUntil.current = Math.max(pollUntil.current, Date.now() + POLL_FOR_MS);
        void check(false);
      }
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("pageshow", back);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("pageshow", back);
    };
  }, [pending, phase, id, check]);

  // ---------------------------------------------------------------- paid
  if (!pending) {
    if (order.status === "cancelled" || !justPaid) return null;
    const paid = order.paid;
    return (
      <div className="flex items-start gap-3 rounded-2xl bg-leaf-light p-4 text-leaf ring-1 ring-leaf/15" role="status" data-testid="payment-success">
        <CheckCircle2 className="h-7 w-7 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="font-display text-xl font-semibold">{paid ? "Payment received. Order placed" : "Order placed"}</p>
          {paid && (
            <p className="break-words text-ink-soft">
              {rupees(paid.amount)} paid{METHOD[paid.method] ? ` by ${METHOD[paid.method]}` : ""}
              {paid.reference && <>. Reference <span className="font-semibold text-ink">{paid.reference}</span></>}
            </p>
          )}
          <p className="text-ink-soft">We have sent your order to the seller{order.sub_orders.length > 1 ? "s" : ""}. You can track each package below.</p>
        </div>
      </div>
    );
  }

  const total = rupees(order.grand_total);
  const held = order.payment_expires_at ? ` Your items are held until ${dateTime(order.payment_expires_at)}.` : "";

  // ---------------------------------------------------------------- failed
  if (phase === "failed") {
    return (
      <div className="flex flex-col gap-3 rounded-2xl bg-vermilion-light p-4 ring-1 ring-vermilion/25" role="alert" data-testid="payment-failed">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-6 w-6 shrink-0 text-vermilion" aria-hidden />
          <div className="min-w-0">
            <p className="text-lg font-semibold text-vermilion">Payment not received</p>
            {reason && <p className="break-words text-ink">{reason}</p>}
            <p className="text-sm text-ink-soft">
              If money left your account, your bank returns it by itself, usually within 5 to 7 working days.{held}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="buy" onClick={pay}>Try again · Pay {total}</Button>
          <Button variant="ghost" onClick={() => startPolling()} loading={checkingNow}>
            <RefreshCw className="h-4 w-4" aria-hidden /> I have paid, check again
          </Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- checking / waiting
  if (phase === "checking" || phase === "waiting" || phase === "open") {
    return (
      <div className="flex flex-col gap-3 rounded-2xl bg-marigold-light p-4 ring-1 ring-marigold/30" role="status" aria-live="polite" data-testid="payment-checking">
        <div className="flex items-start gap-3">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[#8A5A00]" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold">
              {phase === "open" ? "Complete the payment in the payment window" : phase === "waiting" ? "Waiting for you to approve the payment in your UPI app" : "Checking your payment…"}
            </p>
            <p className="text-sm text-ink-soft">
              {phase === "open"
                ? "Pick Google Pay, PhonePe, Paytm or any UPI app, a card or net banking. You come back here after paying."
                : "This page updates by itself as soon as the payment reaches us. Please don't pay again."}
              {held}
            </p>
          </div>
        </div>
        {phase !== "open" && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => startPolling()} loading={checkingNow}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Check now
            </Button>
            <Button variant="ghost" size="sm" onClick={pay}>Pay {total} again</Button>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- not paid yet
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-marigold-light p-4 ring-1 ring-marigold/30 sm:flex-row sm:items-center" data-testid="payment-pending">
      <p className="flex-1">Your payment is not complete.{held}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onClick={() => startPolling()} loading={checkingNow}>Already paid? Check</Button>
        <Button variant="buy" onClick={pay}>Pay {total}</Button>
      </div>
    </div>
  );
}
