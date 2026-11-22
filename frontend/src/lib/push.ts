"use client";

/*
 * Push notifications on this device. In a browser: Firebase Cloud Messaging web push through the /push-sw.js service
 * worker. Inside the PixCart Android app (Capacitor): the phone's native push. Either way the device's token is sent to
 * POST /api/push/tokens for the signed-in account, and removed again at sign-out.
 *
 * Firebase is set up by the admin in Admin → Integrations → Firebase; until then everything here quietly does nothing.
 */

import { api } from "@/lib/api";

export type PushApp = "shop" | "delivery" | "seller" | "admin";
export type PushResult = "on" | "denied" | "unsupported" | "off" | "error" | "later";
type PushConfig =
  | { enabled: false }
  | { enabled: true; apiKey: string; projectId: string; messagingSenderId: string; appId: string; vapidKey: string };

type NativePush = {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: string, cb: (x: { value?: string; notification?: { data?: Record<string, string> } }) => void): Promise<{ remove(): void }>;
  createChannel?(c: { id: string; name: string; importance: number; sound?: string; vibration?: boolean }): Promise<void>;
};
type CapacitorGlobal = { isNativePlatform?: () => boolean; Plugins?: { PushNotifications?: NativePush } };

const TOKEN_KEY = "pc_push_token";
let configCache: Promise<PushConfig> | null = null;

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return c?.isNativePlatform?.() ? c : null;
}

/** True inside the PixCart Android app. */
export function inNativeApp(): boolean {
  return !!capacitor();
}

export function pushConfig(): Promise<PushConfig> {
  if (!configCache) configCache = api<PushConfig>("/api/push/config").catch(() => ({ enabled: false }) as const);
  return configCache;
}

export function webPushSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

/** "granted", "denied", "default" (not asked yet) or "unsupported". */
export async function pushPermission(): Promise<NotificationPermission | "unsupported"> {
  const native = capacitor()?.Plugins?.PushNotifications;
  if (native) {
    const p = await native.checkPermissions().catch(() => ({ receive: "prompt" }));
    return p.receive === "granted" ? "granted" : p.receive === "denied" ? "denied" : "default";
  }
  return webPushSupported() ? Notification.permission : "unsupported";
}

function remember(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode */
  }
}

async function register(token: string, platform: "web" | "android", app: PushApp) {
  await api("/api/push/tokens", { method: "POST", body: { token, platform, app } });
  remember(token);
}

let nativeListening = false;

async function enableNative(native: NativePush, app: PushApp, ask: boolean): Promise<PushResult> {
  let perm = (await native.checkPermissions()).receive;
  if (perm !== "granted" && ask) perm = (await native.requestPermissions()).receive;
  if (perm !== "granted") return perm === "denied" ? "denied" : "later";
  // loud channel for delivery requests, a quiet one for everything else (the server picks the channel per message)
  await native.createChannel?.({ id: "deliveries", name: "Delivery requests", importance: 5, vibration: true }).catch(() => {});
  await native.createChannel?.({ id: "updates", name: "Order updates", importance: 3 }).catch(() => {});
  return new Promise<PushResult>((resolve) => {
    let done = false;
    const finish = (r: PushResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    native.addListener("registration", (t) => {
      if (t.value) register(t.value, "android", app).then(() => finish("on"), () => finish("error"));
    });
    native.addListener("registrationError", () => finish("error"));
    if (!nativeListening) {
      nativeListening = true;
      native.addListener("pushNotificationActionPerformed", (a) => {
        const link = a.notification?.data?.link;
        if (link) window.location.assign(new URL(link, window.location.origin));
      });
      native.addListener("pushNotificationReceived", (n) => {
        window.dispatchEvent(new CustomEvent("pixcart-push", { detail: n.notification?.data ?? {} }));
      });
    }
    native.register().catch(() => finish("error"));
    setTimeout(() => finish("error"), 15_000);
  });
}

/**
 * Turns push on for this device and account. With `ask` false it only refreshes the token when permission was given
 * before (call it on app start), never showing the browser's permission prompt.
 */
export async function enablePush(app: PushApp, ask = true): Promise<PushResult> {
  try {
    const cfg = await pushConfig();
    if (!cfg.enabled) return "off";
    const native = capacitor()?.Plugins?.PushNotifications;
    if (native) return await enableNative(native, app, ask);
    if (!webPushSupported()) return "unsupported";
    let perm = Notification.permission;
    if (perm === "default" && ask) perm = await Notification.requestPermission();
    if (perm !== "granted") return perm === "denied" ? "denied" : "later";
    const reg = await navigator.serviceWorker.register("/push-sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const [{ getApps, initializeApp }, { getMessaging, getToken, isSupported }] = await Promise.all([import("@firebase/app"), import("@firebase/messaging")]);
    if (!(await isSupported())) return "unsupported";
    const fb = getApps().find((a) => a.name === "pixcart")
      ?? initializeApp({ apiKey: cfg.apiKey, projectId: cfg.projectId, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId }, "pixcart");
    const token = await getToken(getMessaging(fb), { vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
    if (!token) return "error";
    await register(token, "web", app);
    return "on";
  } catch {
    return "error";
  }
}

/** Forgets this device for the signed-in account (called just before signing out). */
export async function removePushToken(): Promise<void> {
  let token: string | null = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    return;
  }
  if (token) await api("/api/push/tokens/remove", { method: "POST", body: { token } }).catch(() => {});
}

/** Runs `cb` when a push arrives while a PixCart page is open (the service worker hands it to the page). */
export function onForegroundPush(cb: (data: Record<string, string>) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const fromWorker = (e: MessageEvent) => {
    if (e.data?.type === "pixcart-push") cb(e.data.data ?? {});
  };
  const fromNative = (e: Event) => cb((e as CustomEvent).detail ?? {});
  navigator.serviceWorker?.addEventListener("message", fromWorker);
  window.addEventListener("pixcart-push", fromNative);
  return () => {
    navigator.serviceWorker?.removeEventListener("message", fromWorker);
    window.removeEventListener("pixcart-push", fromNative);
  };
}
