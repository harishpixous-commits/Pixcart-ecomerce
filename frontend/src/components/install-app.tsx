"use client";

/*
 * "Get the app" for both apps (the shop at /app, the delivery partner app at /delivery/download). Every phone can install
 * the website itself as an app, identical to the site: Android Chrome (and desktop Chrome or Edge) show their install
 * prompt from our button; iPhone and iPad get the Safari "Share → Add to Home Screen" steps. When staff have published
 * an Android APK, a Play Store or an App Store link (admin settings), those buttons appear too.
 */

import clsx from "clsx";
import { Apple, Download, MonitorSmartphone, PlusSquare, Share, Smartphone } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

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

/** The browser's install prompt, when it offers one (Android Chrome, desktop Chrome and Edge). */
export function useInstallPrompt() {
  return useSyncExternalStore(subscribe, () => deferred, () => null);
}
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  await deferred.prompt();
  const choice = await deferred.userChoice.catch(() => null);
  deferred = null;
  listeners.forEach((l) => l());
  return choice?.outcome === "accepted";
}

export type Device = "ios" | "android" | "desktop";
/** The visitor's device and whether the app is already running from the home screen (decided after hydration). */
export function useDevice(): { device: Device | null; installed: boolean } {
  const [state, setState] = useState<{ device: Device | null; installed: boolean }>({ device: null, installed: false });
  useEffect(() => {
    const t = setTimeout(() => {
      const ua = navigator.userAgent;
      const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1); // iPadOS reports a Mac
      const device: Device = ios ? "ios" : /android/i.test(ua) ? "android" : "desktop";
      const installed = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      setState({ device, installed });
    }, 0);
    return () => clearTimeout(t);
  }, []);
  return state;
}

export type AppLinks = { apkUrl?: string; playUrl?: string; appStoreUrl?: string; version?: string };

const BTN = "flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold transition-colors";

export function GetTheApp({ links, compact, appName = "the app" }: { links: AppLinks | null; compact?: boolean; appName?: string }) {
  const prompt = useInstallPrompt();
  const { device, installed } = useDevice();
  const [showIos, setShowIos] = useState(false);
  useEffect(() => { if (device === "ios" && !compact) { const t = setTimeout(() => setShowIos(true), 0); return () => clearTimeout(t); } }, [device, compact]);
  const l = links ?? {};
  return (
    <div className="flex flex-col gap-2" data-testid="get-the-app">
      <div className={compact ? "grid gap-2" : "grid gap-2 sm:grid-cols-2"}>
        {installed ? (
          <p className={clsx(BTN, "bg-leaf-light text-leaf")} data-testid="app-installed">{appName === "the app" ? "The app" : appName} is installed on this device</p>
        ) : prompt ? (
          <button type="button" className={clsx(BTN, "bg-marigold text-ink hover:bg-marigold-dark")} onClick={() => promptInstall()} data-testid="install-app">
            <MonitorSmartphone className="h-5 w-5" aria-hidden /> Install {appName} on this device
          </button>
        ) : device === "ios" ? (
          <button type="button" className={clsx(BTN, "bg-marigold text-ink hover:bg-marigold-dark")} onClick={() => setShowIos((v) => !v)} aria-expanded={showIos} data-testid="ios-install">
            <Share className="h-5 w-5" aria-hidden /> Add to iPhone home screen
          </button>
        ) : (
          <p className="rounded-xl bg-white/70 px-4 py-3 text-sm text-ink-soft ring-1 ring-line" data-testid="install-hint">
            {device === "desktop"
              ? <>On your phone, open this page and tap <b>Install</b> (Android) or <b>Add to Home Screen</b> (iPhone). Or scan the code on this page.</>
              : <>Open this page in <b>Chrome</b> and choose <b>Install app</b> (or <b>Add to Home screen</b>) from the ⋮ menu.</>}
          </p>
        )}
        {l.apkUrl && device !== "ios" && (
          <a href={l.apkUrl} download className={clsx(BTN, "bg-ink text-white hover:bg-ink/90")} data-testid="apk-download">
            <Download className="h-5 w-5" aria-hidden /> Download Android app{l.version ? ` (v${l.version})` : ""}
          </a>
        )}
        {l.playUrl && device !== "ios" && (
          <a href={l.playUrl} target="_blank" rel="noreferrer" className={clsx(BTN, "bg-ink text-white hover:bg-ink/90")} data-testid="play-store">
            <Smartphone className="h-5 w-5" aria-hidden /> Get it on Google Play
          </a>
        )}
        {l.appStoreUrl && device !== "android" && (
          <a href={l.appStoreUrl} target="_blank" rel="noreferrer" className={clsx(BTN, "bg-ink text-white hover:bg-ink/90")} data-testid="app-store">
            <Apple className="h-5 w-5" aria-hidden /> Download on the App Store
          </a>
        )}
      </div>
      {showIos && !installed && <IosSteps />}
    </div>
  );
}

/** Safari's "Add to Home Screen", step by step (the only way to install a website on iPhone and iPad). */
export function IosSteps() {
  return (
    <ol className="grid gap-2 rounded-xl bg-white p-4 text-sm text-ink ring-1 ring-line" data-testid="ios-steps">
      {[
        [<Apple key="a" className="h-4 w-4" aria-hidden />, <>Open this page in <b>Safari</b>.</>],
        [<Share key="s" className="h-4 w-4" aria-hidden />, <>Tap the <b>Share</b> button (the square with an arrow) at the bottom.</>],
        [<PlusSquare key="p" className="h-4 w-4" aria-hidden />, <>Scroll and choose <b>Add to Home Screen</b>, then tap <b>Add</b>.</>],
      ].map(([icon, text], i) => (
        <li key={i} className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-peacock text-xs font-bold text-white">{i + 1}</span>
          <span className="flex items-center gap-2 pt-1">{icon}<span>{text}</span></span>
        </li>
      ))}
      <li className="pl-10 text-xs text-ink-soft">The app opens full screen from its icon, with the same sign-in, cart and orders as the website.</li>
    </ol>
  );
}
