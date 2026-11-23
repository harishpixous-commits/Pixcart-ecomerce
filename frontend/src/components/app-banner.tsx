"use client";

/*
 * A small "Get the app" bar at the top of the shop on phones (Admin → Marketplace settings → Mobile apps can switch it
 * off). Not shown inside the installed app, inside the admin's preview window, on checkout or sign-in pages, or for
 * 30 days after the shopper closes it.
 */

import { X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { promptInstall, useDevice, useInstallPrompt } from "@/components/install-app";
import { useSite } from "@/lib/site";

const KEY = "pc_app_banner_hidden_until";
const QUIET = ["/app", "/checkout", "/login", "/signup", "/cart"];

export function AppBanner() {
  const site = useSite();
  const pathname = usePathname();
  const { device, installed } = useDevice();
  const prompt = useInstallPrompt();
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    let until = 0;
    try { until = Number(localStorage.getItem(KEY) || 0); } catch { /* storage blocked */ }
    const t = setTimeout(() => setHidden(until > Date.now() || window.top !== window), 0);
    return () => clearTimeout(t);
  }, []);
  if (hidden || installed || site.app?.banner === false || (device !== "android" && device !== "ios")) return null;
  if (QUIET.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  const close = () => {
    try { localStorage.setItem(KEY, String(Date.now() + 30 * 86400_000)); } catch { /* */ }
    setHidden(true);
  };
  return (
    <div className="flex items-center gap-3 border-b border-line bg-white px-3 py-2 text-ink" role="region" aria-label="Get the app" data-testid="app-banner">
      <button type="button" onClick={close} aria-label="Close" className="-ml-1 rounded p-1 text-ink-faint hover:bg-mist"><X className="h-4 w-4" /></button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/app-icon/192" alt="" width={36} height={36} className="h-9 w-9 rounded-lg" />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold">{site.brand_name} app</p>
        <p className="truncate text-xs text-ink-soft">Faster shopping, full screen</p>
      </div>
      {prompt ? (
        <button type="button" onClick={() => promptInstall()} className="rounded-full bg-peacock px-4 py-1.5 text-sm font-bold text-white">Install</button>
      ) : (
        <Link href="/app" className="rounded-full bg-peacock px-4 py-1.5 text-sm font-bold text-white">{device === "ios" ? "Get" : "Install"}</Link>
      )}
    </div>
  );
}
