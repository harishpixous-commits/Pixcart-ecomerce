// Shopper side of the gateways other than Razorpay (docs/PAYMENT_GATEWAYS.md section 4). The server decides the mode:
//   redirect  → send the browser to fields.url (PhonePe, Stripe)
//   form      → POST fields to fields.action from a hidden form (PayU)
//   modal     → Cashfree JS SDK v3 with the payment session
// The result is never decided here: after the shopper returns, the order page asks the server (/payment-status).
import { markPaying } from "./razorpay";
import type { CheckoutPayload } from "./types";

declare global {
  interface Window { Cashfree?: (o: { mode: string }) => { checkout: (o: Record<string, unknown>) => Promise<unknown> } }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("The payment window could not load. Check your connection and try again."));
    document.head.appendChild(s);
  });
}

/** Starts the payment. Resolves when a window closes (modal); a redirect or form leaves the page. */
export async function payWithGateway(p: CheckoutPayload, orderId: string): Promise<void> {
  markPaying(orderId);
  if (p.mode === "redirect" && p.url) {
    window.location.assign(p.url);
    return new Promise(() => undefined); // the page is leaving
  }
  if (p.mode === "form" && p.action && p.fields) {
    const f = document.createElement("form");
    f.method = "POST";
    f.action = p.action;
    for (const [k, v] of Object.entries(p.fields)) {
      const i = document.createElement("input");
      i.type = "hidden"; i.name = k; i.value = String(v);
      f.appendChild(i);
    }
    document.body.appendChild(f);
    f.submit();
    return new Promise(() => undefined);
  }
  if (p.mode === "modal" && p.provider === "cashfree" && p.sdk_url && p.payment_session_id) {
    await loadScript(p.sdk_url);
    if (!window.Cashfree) throw new Error("The payment window could not load");
    await window.Cashfree({ mode: p.env === "production" ? "production" : "sandbox" }).checkout({ paymentSessionId: p.payment_session_id, redirectTarget: "_modal" });
    return;
  }
  throw new Error("This payment method is not available right now. Pick another way to pay.");
}
