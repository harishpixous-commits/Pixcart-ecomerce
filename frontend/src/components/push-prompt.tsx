"use client";

/*
 * "Turn on notifications" for this device. Shows only when the admin has set up Firebase and this browser (or the
 * Android app) has not been asked yet; if permission was given before, it quietly refreshes the device instead.
 * "Not now" hides it for a week. Blocked notifications get a short how-to-fix note where it matters (delivery app).
 */

import clsx from "clsx";
import { BellRing, BellOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useToast } from "@/components/ui";
import { enablePush, pushConfig, pushPermission, type PushApp } from "@/lib/push";

const WEEK = 7 * 86_400_000;

function dismissedAt(app: PushApp): number {
  try {
    return Number(localStorage.getItem(`pc_push_later_${app}`) || 0);
  } catch {
    return 0;
  }
}

export function PushPrompt({ app, title, text, showBlocked = false, className }: {
  app: PushApp; title: string; text: string; showBlocked?: boolean; className?: string;
}) {
  const toast = useToast();
  const [state, setState] = useState<"hidden" | "ask" | "blocked">("hidden");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const cfg = await pushConfig();
      if (!cfg.enabled) return;
      const perm = await pushPermission();
      if (perm === "granted") {
        enablePush(app, false); // keep this device's token fresh
        return;
      }
      if (perm === "unsupported" || Date.now() - dismissedAt(app) < WEEK) return;
      if (live) setState(perm === "denied" ? (showBlocked ? "blocked" : "hidden") : "ask");
    })().catch(() => {});
    return () => { live = false; };
  }, [app, showBlocked]);

  if (state === "hidden") return null;

  function later() {
    try {
      localStorage.setItem(`pc_push_later_${app}`, String(Date.now()));
    } catch {
      /* private mode */
    }
    setState("hidden");
  }

  async function turnOn() {
    setBusy(true);
    const r = await enablePush(app, true);
    setBusy(false);
    if (r === "on") {
      toast("Notifications are on for this device");
      setState("hidden");
    } else if (r === "denied") {
      setState(showBlocked ? "blocked" : "hidden");
    } else if (r === "unsupported") {
      toast("This browser cannot show notifications. Try Chrome, or install the app.", "error");
      setState("hidden");
    } else if (r === "error") {
      toast("Could not turn on notifications. Try again later.", "error");
    }
  }

  return (
    <div role="region" aria-label="Notifications" data-testid="push-prompt"
      className={clsx("flex items-start gap-3 rounded-2xl p-3.5 shadow-sm ring-1 sm:items-center", state === "blocked" ? "bg-vermilion-light ring-vermilion/30" : "bg-white ring-peacock/20", className)}>
      <span className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", state === "blocked" ? "bg-white text-vermilion" : "bg-peacock-light text-peacock")}>
        {state === "blocked" ? <BellOff className="h-5 w-5" aria-hidden /> : <BellRing className="h-5 w-5" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{state === "blocked" ? "Notifications are blocked" : title}</p>
        <p className="text-sm text-ink-soft">
          {state === "blocked" ? "Allow notifications for this site in your browser's site settings (the lock icon next to the address), then reload." : text}
        </p>
        {state === "ask" && (
          <div className="mt-2 flex gap-2 sm:hidden">
            <button type="button" onClick={turnOn} disabled={busy} className="h-9 rounded-full bg-peacock px-4 text-sm font-semibold text-white disabled:opacity-60">Turn on</button>
            <button type="button" onClick={later} className="h-9 rounded-full px-3 text-sm font-semibold text-ink-soft">Not now</button>
          </div>
        )}
      </div>
      {state === "ask" && (
        <div className="hidden shrink-0 gap-2 sm:flex">
          <button type="button" onClick={later} className="h-9 rounded-full px-3 text-sm font-semibold text-ink-soft hover:bg-mist">Not now</button>
          <button type="button" onClick={turnOn} disabled={busy} className="h-9 rounded-full bg-peacock px-4 text-sm font-semibold text-white hover:bg-peacock-dark disabled:opacity-60" data-testid="push-enable">Turn on</button>
        </div>
      )}
      <button type="button" onClick={later} className="shrink-0 rounded-full p-1 text-ink-faint hover:bg-white/60" aria-label="Close"><X className="h-4 w-4" aria-hidden /></button>
    </div>
  );
}
