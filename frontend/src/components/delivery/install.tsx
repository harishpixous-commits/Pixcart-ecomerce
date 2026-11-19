"use client";

/*
 * "Get the app": installs the partner web app to the home screen (Android Chrome, desktop Chrome and Edge show their
 * install prompt; iPhone users get the Share → Add to Home Screen steps), plus the Android app download or Play Store
 * link when staff have added one in Admin → Delivery → Settings.
 */

import { Download, MonitorSmartphone, Share, Smartphone } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DeliveryOptions } from "@/lib/delivery-types";

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: PromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for our own button
    deferred = e as PromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => { deferred = null; listeners.forEach((l) => l()); });
}
const subscribe = (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); };

function useInstallPrompt() {
  return useSyncExternalStore(subscribe, () => deferred, () => null);
}

const isIos = () => typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = () => typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export function GetTheApp({ options, compact }: { options: Pick<DeliveryOptions, "android_apk_url" | "play_store_url" | "app_version"> | null; compact?: boolean }) {
  const prompt = useInstallPrompt();
  const [ios, setIos] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [showIos, setShowIos] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { setIos(isIos()); setInstalled(standalone()); }, 0); // after hydration, so server and browser match
    return () => clearTimeout(t);
  }, []);
  const btn = "flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold transition-colors";
  return (
    <div className="flex flex-col gap-2" data-testid="get-the-app">
      <div className={compact ? "grid gap-2" : "grid gap-2 sm:grid-cols-2"}>
        {options?.android_apk_url && (
          <a href={options.android_apk_url} download className={`${btn} bg-ink text-white hover:bg-ink/90`} data-testid="apk-download">
            <Download className="h-5 w-5" aria-hidden /> Download Android app{options.app_version ? ` (v${options.app_version})` : ""}
          </a>
        )}
        {options?.play_store_url && (
          <a href={options.play_store_url} target="_blank" rel="noreferrer" className={`${btn} bg-ink text-white hover:bg-ink/90`}>
            <Smartphone className="h-5 w-5" aria-hidden /> Get it on Google Play
          </a>
        )}
        {installed ? (
          <p className={`${btn} bg-leaf-light text-leaf`}>The app is installed on this device</p>
        ) : prompt ? (
          <button type="button" className={`${btn} bg-marigold text-ink hover:bg-marigold-dark`} onClick={async () => { await prompt.prompt(); await prompt.userChoice.catch(() => null); deferred = null; listeners.forEach((l) => l()); }}>
            <MonitorSmartphone className="h-5 w-5" aria-hidden /> Install the app on this device
          </button>
        ) : ios ? (
          <button type="button" className={`${btn} bg-marigold text-ink hover:bg-marigold-dark`} onClick={() => setShowIos((v) => !v)}>
            <Share className="h-5 w-5" aria-hidden /> Add to iPhone home screen
          </button>
        ) : (
          <p className="rounded-xl bg-white/70 px-4 py-3 text-sm text-ink-soft ring-1 ring-line">
            Open this page in Chrome on your phone and choose <b>Install app</b> (or <b>Add to Home screen</b>) from the menu.
          </p>
        )}
      </div>
      {showIos && (
        <ol className="list-decimal rounded-xl bg-white p-4 pl-8 text-sm text-ink-soft ring-1 ring-line">
          <li>Open this page in Safari.</li>
          <li>Tap the <b>Share</b> button at the bottom.</li>
          <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        </ol>
      )}
    </div>
  );
}
