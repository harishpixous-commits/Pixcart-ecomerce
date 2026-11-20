"use client";

/*
 * /delivery/download: get the partner app. The Android app (APK uploaded in Admin → Delivery → Settings, or the
 * Google Play listing), step-by-step install help, a QR code to open this page on a phone from a computer, and the
 * web app ("Add to Home screen") for iPhone and anyone who prefers it. Public: no sign-in needed.
 */

import { CheckCircle2, Download, ShieldCheck, Smartphone } from "lucide-react";
import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { FullLoader, loadDeliveryOptions } from "@/components/delivery/app";
import { GetTheApp } from "@/components/delivery/install";
import { Logo } from "@/components/shop-chrome";
import type { DeliveryOptions } from "@/lib/delivery-types";

const STEPS = [
  "Tap Download the app. The file (about 5 to 10 MB) saves to your phone.",
  "Open the downloaded file from the notification or your Files app.",
  "If Android asks, allow \"Install unknown apps\" for your browser. This is normal for apps outside Google Play.",
  "Open the app and sign in with your mobile number. Allow location and notifications so you get delivery requests.",
];

export default function DownloadPage() {
  const [o, setO] = useState<DeliveryOptions | null>(null);
  const [failed, setFailed] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadDeliveryOptions().then((x) => { if (live) setO(x); }).catch(() => { if (live) setFailed(true); });
    QRCode.toDataURL(`${window.location.origin}/delivery/download`, { margin: 1, width: 220, color: { dark: "#1B2430", light: "#FFFFFF" } })
      .then((u) => { if (live) setQr(u); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!o && !failed) return <FullLoader label="Loading" />;
  const apk = o?.android_apk_url ?? "";
  const play = o?.play_store_url ?? "";
  return (
    <div className="min-h-screen bg-mist" data-testid="download-page">
      <header className="bg-peacock text-white">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Logo />
          <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">Partner</span>
          <Link href="/delivery/join" className="ml-auto text-sm font-semibold text-white/90 hover:text-white">Become a partner</Link>
        </div>
      </header>
      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-8 lg:grid-cols-[1.2fr_1fr] lg:items-start lg:py-12">
        <section className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/app-icon/partner-192" alt="" width={72} height={72} className="h-[72px] w-[72px] rounded-2xl shadow-md" />
            <div>
              <h1 className="font-display text-3xl font-bold text-ink">Get the partner app</h1>
              <p className="text-ink-soft">{o?.app_version ? `Version ${o.app_version} · ` : ""}Android 8 and above</p>
            </div>
          </div>
          <ul className="flex flex-col gap-2 text-ink-soft">
            {["New delivery requests ring your phone, even with the screen off", "Navigation, pickup code, OTP and photo proof in one place", "Your earnings, cash in hand and weekly payouts"].map((t) => (
              <li key={t} className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-leaf" aria-hidden />{t}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3">
            {apk && (
              <a href={apk} download className="inline-flex h-14 items-center gap-3 rounded-2xl bg-peacock px-6 text-lg font-bold text-white shadow-md hover:bg-peacock-dark" data-testid="download-apk">
                <Download className="h-6 w-6" aria-hidden /> Download the app
              </a>
            )}
            {play && (
              <a href={play} target="_blank" rel="noopener noreferrer" className="inline-flex h-14 items-center gap-3 rounded-2xl bg-ink px-6 text-lg font-bold text-white shadow-md hover:bg-ink/90">
                <Smartphone className="h-6 w-6" aria-hidden /> Get it on Google Play
              </a>
            )}
          </div>
          {!apk && !play && (
            <p className="rounded-2xl bg-white p-4 text-ink-soft shadow-sm ring-1 ring-black/5">
              The Android app is on its way. Meanwhile the partner web app does everything: open it in Chrome and add it to your home screen below.
            </p>
          )}
          {apk && (
            <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <h2 className="mb-3 font-semibold">How to install</h2>
              <ol className="flex flex-col gap-3">
                {STEPS.map((s, i) => (
                  <li key={i} className="flex gap-3 text-sm">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-peacock-light font-bold text-peacock">{i + 1}</span>
                    <span className="pt-1 text-ink-soft">{s}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 flex items-start gap-2 rounded-xl bg-mist px-3 py-2 text-xs text-ink-soft">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-leaf" aria-hidden /> Only download the app from this page. We never ask for your bank PIN, OTP or passwords on calls.
              </p>
            </section>
          )}
          <div>
            <h2 className="mb-2 font-semibold">iPhone, or prefer no download?</h2>
            <GetTheApp options={o} compact />
          </div>
        </section>

        <aside className="hidden flex-col items-center gap-3 rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5 lg:flex">
          <p className="font-semibold">On a computer? Scan with your phone</p>
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt="QR code that opens this page on your phone" width={220} height={220} className="rounded-xl" />
          ) : (
            <div className="h-[220px] w-[220px] animate-pulse rounded-xl bg-mist" />
          )}
          <p className="text-sm text-ink-soft">Point your phone camera at the code to open this page and download the app.</p>
        </aside>
      </main>
    </div>
  );
}
