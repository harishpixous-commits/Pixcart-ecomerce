"use client";

import { api } from "./api";
import type { CheckoutPayload, OrderDetail } from "./types";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (ev: string, cb: (r: unknown) => void) => void };
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loading = null;
        reject(new Error("Could not load the payment window. Check your connection."));
      };
      document.body.appendChild(s);
    });
  }
  return loading;
}

/**
 * Opens Razorpay Checkout. Resolves with the confirmed order when the payment is verified by our
 * server (which re-checks it with Razorpay), or null if the customer closed the window.
 */
export async function payWithRazorpay(payment: CheckoutPayload): Promise<OrderDetail | null> {
  await loadScript();
  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay!({
      key: payment.key_id,
      amount: payment.amount,
      currency: payment.currency,
      name: payment.name,
      description: payment.description,
      order_id: payment.razorpay_order_id,
      prefill: payment.prefill,
      theme: { color: "#0B5563" },
      modal: { ondismiss: () => resolve(null), confirm_close: true },
      handler: async (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        try {
          const r = await api<{ order: OrderDetail }>("/api/payments/razorpay/verify", { method: "POST", body: resp });
          resolve(r.order);
        } catch (e) {
          reject(e);
        }
      },
    });
    rzp.on("payment.failed", () => {
      /* Razorpay shows the failure and lets the customer retry inside the same window. */
    });
    rzp.open();
  });
}
