/*
 * The service worker for push notifications (served at /push-sw.js, registered by lib/push.ts).
 *
 * Firebase Cloud Messaging delivers each push here. When a PixCart tab is open and visible the message goes to that
 * tab instead (the partner app refreshes its requests right away); otherwise a notification is shown, with sound and
 * vibration for urgent ones like a new delivery request. Tapping it opens the link inside the message.
 */

export const dynamic = "force-static";

const SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = { notification: { body: event.data ? event.data.text() : "" } }; }
  const n = msg.notification || {};
  const data = msg.data || {};
  const link = data.link || (msg.fcmOptions && msg.fcmOptions.link) || "/";
  const urgent = data.urgent === "1";
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = tabs.filter((c) => c.visibilityState === "visible");
    if (visible.length) {
      visible.forEach((c) => c.postMessage({ type: "pixcart-push", title: n.title || "", body: n.body || "", data }));
      return;
    }
    await self.registration.showNotification(n.title || data.title || "PixCart", {
      body: n.body || data.body || "",
      icon: n.icon || "/icon.svg",
      badge: "/icon.svg",
      tag: data.tag || data.event || undefined,
      renotify: urgent,
      requireInteraction: urgent,
      vibrate: urgent ? [400, 150, 400, 150, 400] : [120],
      data: { link },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";
  const target = new URL(link, self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of tabs) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ("navigate" in c) return c.navigate(target);
        return;
      }
    }
    return self.clients.openWindow(target);
  })());
});
`;

export function GET() {
  return new Response(SW, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
