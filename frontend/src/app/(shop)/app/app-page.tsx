"use client";

/*
 * /app: get the shop's app. On a phone: install it (Android one tap, iPhone "Add to Home Screen"), or download the
 * Android app / open the store when staff have published one. On a computer: a QR code to open this page on a phone.
 * The app is the website itself, so sign-in, cart, orders and everything else are identical.
 */

import { Bell, Bike, Gauge, Lock, ShoppingBag, Smartphone } from "lucide-react";
import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { GetTheApp, useDevice } from "@/components/install-app";
import { useSite } from "@/lib/site";

const FEATURES = [
  [Gauge, "Fast and full screen", "Opens straight from your home screen, without the browser's bars."],
  [Lock, "The same account", "Sign in with your mobile number, as on the website. Your cart, orders and wishlist come along."],
  [Bell, "Order updates", "Know when your order is confirmed, on its way and delivered."],
  [Smartphone, "Android and iPhone", "Works on every phone, and updates itself: no app updates to download."],
] as const;

export function AppPage() {
  const site = useSite();
  const app = site.app;
  const { device } = useDevice();
  const [qr, setQr] = useState("");
  useEffect(() => {
    QRCode.toDataURL(`${window.location.origin}/app`, { margin: 1, width: 240, color: { dark: "#0B1F2A", light: "#FFFFFF" } }).then(setQr).catch(() => {});
  }, []);
  return (
    <div className="flex flex-col gap-4" data-testid="app-page">
      <section className="shop-panel overflow-hidden rounded-2xl bg-gradient-to-br from-peacock to-peacock-dark text-white">
        <div className="grid items-center gap-6 p-6 sm:p-10 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <p className="mb-2 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold"><ShoppingBag className="h-4 w-4" aria-hidden /> The {site.brand_name} app</p>
            <h1 className="font-display text-3xl font-bold leading-tight sm:text-4xl">Shop faster with the {site.brand_name} app</h1>
            <p className="mt-3 max-w-xl text-white/85">Everything on the website, in an app on your phone: deals, your cart, checkout and order tracking, with the same sign-in.</p>
            <div className="mt-6 max-w-xl rounded-2xl bg-white p-4 text-ink shadow-lg">
              <GetTheApp appName={`the ${site.brand_name} app`}
                links={app ? { apkUrl: app.android_apk_url, playUrl: app.play_store_url, appStoreUrl: app.app_store_url, version: app.version } : null} />
            </div>
          </div>
          {device === "desktop" && qr ? (
            <div className="mx-auto flex flex-col items-center gap-3 rounded-2xl bg-white p-5 text-center text-ink shadow-lg" data-testid="app-qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="QR code that opens this page on your phone" width={200} height={200} />
              <p className="max-w-[220px] text-sm text-ink-soft">Scan with your phone&apos;s camera to install the app</p>
            </div>
          ) : (
            <div className="mx-auto hidden h-[360px] w-[190px] rounded-[2rem] border-[6px] border-ink/80 bg-white shadow-2xl lg:block" aria-hidden>
              <div className="mx-auto mt-2 h-4 w-16 rounded-full bg-ink/80" />
              <div className="flex flex-col gap-2 p-3">
                <div className="h-6 rounded bg-peacock" />
                <div className="h-24 rounded bg-marigold/60" />
                <div className="grid grid-cols-2 gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded bg-mist" />)}</div>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Why use the app">
        {FEATURES.map(([Icon, title, text]) => (
          <div key={title} className="shop-panel rounded-xl bg-white p-5">
            <Icon className="mb-3 h-6 w-6 text-peacock" aria-hidden />
            <h2 className="font-semibold text-ink">{title}</h2>
            <p className="mt-1 text-sm text-ink-soft">{text}</p>
          </div>
        ))}
      </section>

      <section className="shop-panel flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-5">
        <div className="flex items-center gap-3">
          <Bike className="h-6 w-6 text-peacock" aria-hidden />
          <div>
            <h2 className="font-semibold text-ink">Deliver with {site.brand_name}?</h2>
            <p className="text-sm text-ink-soft">The delivery partner app has its own download, for Android and iPhone.</p>
          </div>
        </div>
        <Link href="/delivery/download" className="rounded-lg border border-line px-4 py-2 font-semibold text-peacock hover:bg-mist">Get the partner app</Link>
      </section>
    </div>
  );
}
