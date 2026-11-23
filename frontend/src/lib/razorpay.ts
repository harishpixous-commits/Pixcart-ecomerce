"use client";

import { api } from "./api";
import type { CheckoutPayload, OrderDetail } from "./types";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (ev: string, cb: (r: unknown) => void) => void };
  }
}

let loading: Promise<void> | null = null;
const DEFAULT_CHECKOUT = "https://checkout.razorpay.com/v1/checkout.js";

/** The server says which checkout script to load: Razorpay's own, or the local simulator in development. */
function loadScript(url = DEFAULT_CHECKOUT): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = /^https?:\/\//.test(url) ? url : DEFAULT_CHECKOUT;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loading = null;
        reject(new Error("Could not load the payment window. Check your connection and try again."));
      };
      document.body.appendChild(s);
    });
  }
  return loading;
}

/** Inside our Android app (the app adds this to the browser's user agent). */
export function inShopApp(): boolean {
  return typeof navigator !== "undefined" && /PixCart(Shop|Partner)App/.test(navigator.userAgent);
}

/** A phone or tablet, where paying by UPI means leaving for Google Pay, PhonePe or another UPI app and coming back. */
export function isPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** The shop's own colour, so the payment window matches the theme. */
function themeColour(): string {
  try {
    const el = document.querySelector("main") ?? document.body;
    const rgb = getComputedStyle(el).getPropertyValue("--c-primary").trim().split(/\s+/).map(Number);
    if (rgb.length === 3 && rgb.every((n) => Number.isFinite(n))) return `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    /* fall through */
  }
  return "#0B5563";
}

const PAYING = (orderId: string) => `pc_paying_${orderId}`;

/** Remembers (for this tab, surviving a reload) that the shopper started paying for this order, and when. */
export function markPaying(orderId: string) {
  try { sessionStorage.setItem(PAYING(orderId), String(Date.now())); } catch { /* storage blocked */ }
}
export function payingSince(orderId: string): number {
  try { return Number(sessionStorage.getItem(PAYING(orderId)) || 0); } catch { return 0; }
}
export function clearPaying(orderId: string) {
  try { sessionStorage.removeItem(PAYING(orderId)); } catch { /* storage blocked */ }
}

export type PayOptions = {
  orderId: string;
  /** Admin → Marketplace settings: "return" sends phones back to the order through Razorpay's callback URL. */
  returnMode?: "return" | "window";
  /** A failed attempt (the window stays open so the shopper can try again or pick another way to pay). */
  onFailed?: (reason: string) => void;
};

/**
 * Opens Razorpay Checkout. On computers (and when the admin picks "window") it resolves with the confirmed order once
 * our server has checked the payment with Razorpay, or null if the shopper closed the window.
 *
 * On phones and in the app, Razorpay shows every UPI app (Google Pay, PhonePe, Paytm, BHIM and others); after paying
 * there, the shopper comes back to the browser or the app, and Razorpay sends them to /api/payments/razorpay/callback,
 * which confirms the payment with Razorpay and opens their order with the result. If the phone reloaded the page on the
 * way back, the order page asks Razorpay by itself (see markPaying).
 */
export async function payWithRazorpay(payment: CheckoutPayload, opts: PayOptions): Promise<OrderDetail | null> {
  await loadScript(payment.checkout_url);
  const app = inShopApp();
  const viaReturn = (opts.returnMode ?? "return") === "return" && (app || isPhone());
  markPaying(opts.orderId);
  return new Promise((resolve, reject) => {
    const options: Record<string, unknown> = {
      key: payment.key_id,
      amount: payment.amount,
      currency: payment.currency,
      name: payment.name,
      description: payment.description,
      order_id: payment.razorpay_order_id,
      prefill: payment.prefill,
      theme: { color: themeColour() },
      retry: { enabled: true },
      modal: { ondismiss: () => resolve(null), confirm_close: true, escape: true, backdropclose: false },
      handler: async (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        try {
          const r = await api<{ order: OrderDetail }>("/api/payments/razorpay/verify", { method: "POST", body: resp });
          resolve(r.order);
        } catch (e) {
          reject(e);
        }
      },
    };
    if (viaReturn) {
      // Razorpay posts the result to this address and the shopper lands on their order (the site proxies /api).
      options.callback_url = `${window.location.origin}/api/payments/razorpay/callback`;
      options.redirect = false; // a failed attempt stays in the window, to try again or pick another app
    }
    if (app) options.webview_intent = true; // lets the app open the UPI apps (Razorpay: UPI intent in WebView)
    // the ways to pay the admin switched on (Admin → Languages and currencies → Payments)
    if (payment.methods) options.method = payment.methods;
    // saved cards: Razorpay shows the shopper's saved cards and asks before saving a new one (RBI card tokenisation)
    if (payment.customer_id) {
      options.customer_id = payment.customer_id;
      options.remember_customer = true;
    }
    const rzp = new window.Razorpay!(options);
    rzp.on("payment.failed", (r: unknown) => {
      const err = (r as { error?: { description?: string } } | null)?.error;
      opts.onFailed?.(err?.description || "The payment did not go through");
    });
    rzp.open();
  });
}
