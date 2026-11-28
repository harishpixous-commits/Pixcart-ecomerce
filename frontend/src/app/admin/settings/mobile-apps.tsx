"use client";

/*
 * Admin → Marketplace settings → Mobile apps: the customer app. Every phone can already install the website as an app
 * from /app (Android one tap, iPhone "Add to Home Screen"); here staff publish the Android app (APK built by the
 * "Android shop app" GitHub workflow), add Play Store / App Store links when the apps are listed, and switch the
 * "Get the app" bar on phones.
 */

import Link from "next/link";
import { useState } from "react";
import { Button, ErrorNote, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

export type AppSettings = { shop_app_banner: boolean; shop_android_apk_url: string; shop_play_store_url: string; shop_app_store_url: string; shop_app_version: string };

export function MobileApps({ value, onChange }: { value: AppSettings; onChange: (v: AppSettings) => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState(value.shop_app_version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof AppSettings, v: string | boolean) => onChange({ ...value, [k]: v });

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await api<{ settings: AppSettings }>("/api/admin/shop-app", { method: "POST", form, query: { version: version.trim() || undefined } });
      onChange({ ...value, shop_android_apk_url: r.settings.shop_android_apk_url, shop_app_version: r.settings.shop_app_version });
      setFile(null);
      toast("The Android app is published. Shoppers can download it from /app.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not upload the app");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="mobile-apps" className="grid scroll-mt-24 gap-3 rounded-xl bg-white p-5 sm:grid-cols-2" data-testid="mobile-apps">
      <div className="sm:col-span-2">
        <h2 className="text-lg font-semibold">Mobile apps</h2>
        <p className="text-sm text-ink-soft">
          Shoppers can already install the shop as an app from <Link href="/app" className="font-semibold text-peacock" target="_blank">/app</Link>:
          one tap on Android, &ldquo;Add to Home Screen&rdquo; on iPhone. It is the website itself, so it always matches it. Add the Android app
          and store links here when you have them. The delivery partner app is in Delivery → Settings.
        </p>
      </div>
      <label className="flex items-start gap-3 rounded-lg border border-line p-3 sm:col-span-2">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={value.shop_app_banner} onChange={(e) => set("shop_app_banner", e.target.checked)} />
        <span><span className="font-semibold">Show &ldquo;Get the app&rdquo; on phones</span><br /><span className="text-sm text-ink-soft">A small bar at the top of the shop; shoppers can close it for 30 days</span></span>
      </label>
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3 sm:col-span-2">
        <p className="font-semibold">Android app (APK)</p>
        <ErrorNote message={error} />
        <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-end">
          <input type="file" aria-label="App file (.apk)" accept=".apk,application/vnd.android.package-archive" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-peacock-light file:px-3 file:py-2 file:font-semibold file:text-peacock" data-testid="shop-apk-file" />
          <TextField label="Version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
          <Button type="button" onClick={upload} loading={busy} disabled={!file}>Publish</Button>
        </div>
        <p className="text-xs text-ink-soft">Build it in GitHub: Actions → Android shop app → Run workflow (about 10 minutes), then upload the APK here.</p>
      </div>
      <TextField label="Android app download link" value={value.shop_android_apk_url} onChange={(e) => set("shop_android_apk_url", e.target.value)} hint="Filled in when you upload. Or an https:// link to the APK." />
      <TextField label="Version shown" value={value.shop_app_version} onChange={(e) => set("shop_app_version", e.target.value)} placeholder="1.0.0" />
      <TextField label="Google Play link" value={value.shop_play_store_url} onChange={(e) => set("shop_play_store_url", e.target.value)} placeholder="https://play.google.com/store/apps/details?id=…" />
      <TextField label="App Store link (iPhone)" value={value.shop_app_store_url} onChange={(e) => set("shop_app_store_url", e.target.value)} placeholder="https://apps.apple.com/…" hint="Only when the app is listed on the App Store" />
    </section>
  );
}
