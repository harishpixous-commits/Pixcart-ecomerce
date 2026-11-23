/*
 * Installing the website as an app (the browser's install prompt) and which device the visitor uses. The framework-free
 * part of components/install-app.tsx; the "Get the app" page itself (<GetTheApp>, <IosSteps>) is ported with the /app page.
 */

import { signal } from "@angular/core";

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

/** The browser's install prompt, when it offers one (Android Chrome, desktop Chrome and Edge). */
export const installPrompt = signal<PromptEvent | null>(null);
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for our own button
    installPrompt.set(e as PromptEvent);
  });
  window.addEventListener("appinstalled", () => installPrompt.set(null));
}

export async function promptInstall(): Promise<boolean> {
  const deferred = installPrompt();
  if (!deferred) return false;
  await deferred.prompt();
  const choice = await deferred.userChoice.catch(() => null);
  installPrompt.set(null);
  return choice?.outcome === "accepted";
}

export type Device = "ios" | "android" | "desktop";

/** The visitor's device and whether the app is already running from the home screen. */
export function detectDevice(): { device: Device; installed: boolean } {
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1); // iPadOS reports a Mac
  const device: Device = ios ? "ios" : /android/i.test(ua) ? "android" : "desktop";
  const installed = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return { device, installed };
}

export type AppLinks = { apkUrl?: string; playUrl?: string; appStoreUrl?: string; version?: string };
