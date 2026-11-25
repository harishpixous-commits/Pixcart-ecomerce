/*
 * /app: get the shop's app. On a phone: install it (Android one tap, iPhone "Add to Home Screen"), or download the
 * Android app / open the store when staff have published one. On a computer: a QR code to open this page on a phone.
 * The app is the website itself, so sign-in, cart, orders and everything else are identical.
 * Port of frontend/src/app/(shop)/app/page.tsx + app-page.tsx (the title "Get the app" is set on the route).
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { Bell, Bike, Gauge, Lock, ShoppingBag, Smartphone } from "lucide-angular";
import QRCode from "qrcode";
import { SiteService } from "../../core/site";
import { GetTheApp, detectDevice, type AppLinks } from "../../shared/chrome/install-app";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";

const FEATURES = [
  [Gauge, "Fast and full screen", "Opens straight from your home screen, without the browser's bars."],
  [Lock, "The same account", "Sign in with your mobile number, as on the website. Your cart, orders and wishlist come along."],
  [Bell, "Order updates", "Know when your order is confirmed, on its way and delivered."],
  [Smartphone, "Android and iPhone", "Works on every phone, and updates itself: no app updates to download."],
] as const;

@Component({
  selector: "pc-shop-app-page",
  imports: [Icon, PcLink, GetTheApp],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4" data-testid="app-page">
      <section class="shop-panel overflow-hidden rounded-2xl bg-gradient-to-br from-peacock to-peacock-dark text-white">
        <div class="grid items-center gap-6 p-6 sm:p-10 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <p class="mb-2 inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold"><svg [pcIcon]="ShoppingBag" class="h-4 w-4" /> The {{ site().brand_name }} app</p>
            <h1 class="font-display text-3xl font-bold leading-tight sm:text-4xl">Shop faster with the {{ site().brand_name }} app</h1>
            <p class="mt-3 max-w-xl text-white/85">Everything on the website, in an app on your phone: deals, your cart, checkout and order tracking, with the same sign-in.</p>
            <div class="mt-6 max-w-xl rounded-2xl bg-white p-4 text-ink shadow-lg">
              <pc-get-the-app [appName]="'the ' + site().brand_name + ' app'" [links]="links()" />
            </div>
          </div>
          @if (device === "desktop" && qr()) {
            <div class="mx-auto flex flex-col items-center gap-3 rounded-2xl bg-white p-5 text-center text-ink shadow-lg" data-testid="app-qr">
              <img [src]="qr()" alt="QR code that opens this page on your phone" width="200" height="200" />
              <p class="max-w-[220px] text-sm text-ink-soft">Scan with your phone's camera to install the app</p>
            </div>
          } @else {
            <div class="mx-auto hidden h-[360px] w-[190px] rounded-[2rem] border-[6px] border-ink/80 bg-white shadow-2xl lg:block" aria-hidden="true">
              <div class="mx-auto mt-2 h-4 w-16 rounded-full bg-ink/80"></div>
              <div class="flex flex-col gap-2 p-3">
                <div class="h-6 rounded bg-peacock"></div>
                <div class="h-24 rounded bg-marigold/60"></div>
                <div class="grid grid-cols-2 gap-2">@for (i of [0, 1, 2, 3]; track i) {<div class="h-16 rounded bg-mist"></div>}</div>
              </div>
            </div>
          }
        </div>
      </section>

      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Why use the app">
        @for (f of FEATURES; track f[1]) {
          <div class="shop-panel rounded-xl bg-white p-5">
            <svg [pcIcon]="f[0]" class="mb-3 h-6 w-6 text-peacock" />
            <h2 class="font-semibold text-ink">{{ f[1] }}</h2>
            <p class="mt-1 text-sm text-ink-soft">{{ f[2] }}</p>
          </div>
        }
      </section>

      <section class="shop-panel flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-5">
        <div class="flex items-center gap-3">
          <svg [pcIcon]="Bike" class="h-6 w-6 text-peacock" />
          <div>
            <h2 class="font-semibold text-ink">Deliver with {{ site().brand_name }}?</h2>
            <p class="text-sm text-ink-soft">The delivery partner app has its own download, for Android and iPhone.</p>
          </div>
        </div>
        <a pcLink="/delivery/download" class="rounded-lg border border-line px-4 py-2 font-semibold text-peacock hover:bg-mist">Get the partner app</a>
      </section>
    </div>
  `,
})
export class ShopAppPage {
  protected readonly site = inject(SiteService).site;
  protected readonly FEATURES = FEATURES;
  protected readonly ShoppingBag = ShoppingBag;
  protected readonly Bike = Bike;
  protected readonly device = detectDevice().device;
  protected readonly qr = signal("");
  protected readonly links = computed<AppLinks | null>(() => {
    const app = this.site().app;
    return app ? { apkUrl: app.android_apk_url, playUrl: app.play_store_url, appStoreUrl: app.app_store_url, version: app.version } : null;
  });

  constructor() {
    QRCode.toDataURL(`${window.location.origin}/app`, { margin: 1, width: 240, color: { dark: "#0B1F2A", light: "#FFFFFF" } }).then((u) => this.qr.set(u)).catch(() => {});
  }
}
