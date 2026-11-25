/*
 * /delivery/download: get the partner app. The Android app (APK uploaded in Admin → Delivery → Settings, or the
 * Google Play listing), step-by-step install help, a QR code to open this page on a phone from a computer, and the
 * web app ("Add to Home screen") for iPhone and anyone who prefers it. Public: no sign-in needed.
 * Port of frontend/src/app/delivery/download/page.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from "@angular/core";
import { CheckCircle2, Download, ShieldCheck, Smartphone } from "lucide-angular";
import type { DeliveryOptions } from "../../core/delivery-types";
import { Logo } from "../../shared/shop/shop-chrome";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { PartnerGetTheApp } from "../components/install";
import { loadDeliveryOptions } from "../components/partner";
import { FullLoader } from "../shell/delivery-app";

const STEPS = [
  "Tap Download the app. The file (about 5 to 10 MB) saves to your phone.",
  "Open the downloaded file from the notification or your Files app.",
  "If Android asks, allow \"Install unknown apps\" for your browser. This is normal for apps outside Google Play.",
  "Open the app and sign in with your mobile number. Allow location and notifications so you get delivery requests.",
];

const PERKS = ["New delivery requests ring your phone, even with the screen off", "Navigation, pickup code, OTP and photo proof in one place", "Your earnings, cash in hand and weekly payouts"];

@Component({
  selector: "pc-delivery-download-page",
  imports: [Icon, PcLink, Logo, PartnerGetTheApp, FullLoader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!o() && !failed()) {
      <pc-full-loader label="Loading" />
    } @else {
      <div class="min-h-screen bg-mist" data-testid="download-page">
        <header class="bg-peacock text-white">
          <div class="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
            <a pcLogo></a>
            <span class="rounded-full bg-white/15 px-2 py-0.5 text-xs font-semibold">Partner</span>
            <a pcLink="/delivery/join" class="ml-auto text-sm font-semibold text-white/90 hover:text-white">Become a partner</a>
          </div>
        </header>
        <main class="mx-auto grid max-w-5xl gap-6 px-4 py-8 lg:grid-cols-[1.2fr_1fr] lg:items-start lg:py-12">
          <section class="flex flex-col gap-5">
            <div class="flex items-center gap-4">
              <img src="/app-icon/partner-192" alt="" width="72" height="72" class="h-[72px] w-[72px] rounded-2xl shadow-md" />
              <div>
                <h1 class="font-display text-3xl font-bold text-ink">Get the partner app</h1>
                <p class="text-ink-soft">{{ o()?.app_version ? "Version " + o()!.app_version + " · " : "" }}Android 8 and above</p>
              </div>
            </div>
            <ul class="flex flex-col gap-2 text-ink-soft">
              @for (t of perks; track t) {
                <li class="flex items-start gap-2"><svg [pcIcon]="CheckCircle2" class="mt-0.5 h-5 w-5 shrink-0 text-leaf" />{{ t }}</li>
              }
            </ul>
            <div class="flex flex-wrap gap-3">
              @if (apk()) {
                <a [href]="apk()" download class="inline-flex h-14 items-center gap-3 rounded-2xl bg-peacock px-6 text-lg font-bold text-white shadow-md hover:bg-peacock-dark" data-testid="download-apk">
                  <svg [pcIcon]="Download" class="h-6 w-6" /> Download the app
                </a>
              }
              @if (play()) {
                <a [href]="play()" target="_blank" rel="noopener noreferrer" class="inline-flex h-14 items-center gap-3 rounded-2xl bg-ink px-6 text-lg font-bold text-white shadow-md hover:bg-ink/90">
                  <svg [pcIcon]="Smartphone" class="h-6 w-6" /> Get it on Google Play
                </a>
              }
            </div>
            @if (!apk() && !play()) {
              <p class="rounded-2xl bg-white p-4 text-ink-soft shadow-sm ring-1 ring-black/5">
                The Android app is on its way. Meanwhile the partner web app does everything: open it in Chrome and add it to your home screen below.
              </p>
            }
            @if (apk()) {
              <section class="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
                <h2 class="mb-3 font-semibold">How to install</h2>
                <ol class="flex flex-col gap-3">
                  @for (s of steps; track $index) {
                    <li class="flex gap-3 text-sm">
                      <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-peacock-light font-bold text-peacock">{{ $index + 1 }}</span>
                      <span class="pt-1 text-ink-soft">{{ s }}</span>
                    </li>
                  }
                </ol>
                <p class="mt-3 flex items-start gap-2 rounded-xl bg-mist px-3 py-2 text-xs text-ink-soft">
                  <svg [pcIcon]="ShieldCheck" class="mt-0.5 h-4 w-4 shrink-0 text-leaf" /> Only download the app from this page. We never ask for your bank PIN, OTP or passwords on calls.
                </p>
              </section>
            }
            <div>
              <h2 class="mb-2 font-semibold">iPhone, or prefer no download?</h2>
              <pc-partner-get-the-app [options]="o()" [compact]="true" />
            </div>
          </section>

          <aside class="hidden flex-col items-center gap-3 rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-black/5 lg:flex">
            <p class="font-semibold">On a computer? Scan with your phone</p>
            @if (qr()) {
              <img [src]="qr()" alt="QR code that opens this page on your phone" width="220" height="220" class="rounded-xl" />
            } @else {
              <div class="h-[220px] w-[220px] animate-pulse rounded-xl bg-mist"></div>
            }
            <p class="text-sm text-ink-soft">Point your phone camera at the code to open this page and download the app.</p>
          </aside>
        </main>
      </div>
    }
  `,
})
export class DeliveryDownloadPage {
  protected readonly o = signal<DeliveryOptions | null>(null);
  protected readonly failed = signal(false);
  protected readonly qr = signal<string | null>(null);
  protected readonly steps = STEPS;
  protected readonly perks = PERKS;
  protected readonly CheckCircle2 = CheckCircle2;
  protected readonly Download = Download;
  protected readonly ShieldCheck = ShieldCheck;
  protected readonly Smartphone = Smartphone;
  protected apk(): string {
    return this.o()?.android_apk_url ?? "";
  }
  protected play(): string {
    return this.o()?.play_store_url ?? "";
  }

  constructor() {
    let live = true;
    inject(DestroyRef).onDestroy(() => (live = false));
    loadDeliveryOptions().then((x) => { if (live) this.o.set(x); }).catch(() => { if (live) this.failed.set(true); });
    import("qrcode")
      .then((m) => ((m as unknown as { default?: typeof m }).default ?? m).toDataURL(`${window.location.origin}/delivery/download`, { margin: 1, width: 220, color: { dark: "#1B2430", light: "#FFFFFF" } }))
      .then((u) => { if (live) this.qr.set(u); })
      .catch(() => {});
  }
}
