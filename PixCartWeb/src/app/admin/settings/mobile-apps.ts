/*
 * Admin → Marketplace settings → Mobile apps: the customer app. Every phone can already install the website as an app
 * from /app (Android one tap, iPhone "Add to Home Screen"); here staff publish the Android app (APK built by the
 * "Android shop app" GitHub workflow), add Play Store / App Store links when the apps are listed, and switch the
 * "Get the app" bar on phones. Port of app/admin/settings/mobile-apps.tsx:
 *   <pc-mobile-apps [value]="apps()" (valueChange)="apps.set($event)" />
 */

import { ChangeDetectionStrategy, Component, inject, input, output, signal, type OnInit } from "@angular/core";
import { api, ApiError } from "../../core/api";
import { PcLink } from "../../shared/ui/link";
import { Button, ErrorNote, TextField, Toast } from "../../shared/ui/ui";

export type AppSettings = { shop_app_banner: boolean; shop_android_apk_url: string; shop_play_store_url: string; shop_app_store_url: string; shop_app_version: string };

@Component({
  selector: "pc-mobile-apps",
  imports: [PcLink, Button, ErrorNote, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section id="mobile-apps" class="grid scroll-mt-24 gap-3 rounded-xl bg-white p-5 sm:grid-cols-2" data-testid="mobile-apps">
      <div class="sm:col-span-2">
        <h2 class="text-lg font-semibold">Mobile apps</h2>
        <p class="text-sm text-ink-soft">
          Shoppers can already install the shop as an app from <a pcLink="/app" class="font-semibold text-peacock" target="_blank">/app</a>:
          one tap on Android, “Add to Home Screen” on iPhone. It is the website itself, so it always matches it. Add the Android app
          and store links here when you have them. The delivery partner app is in Delivery → Settings.
        </p>
      </div>
      <label class="flex items-start gap-3 rounded-lg border border-line p-3 sm:col-span-2">
        <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="value().shop_app_banner" (change)="set('shop_app_banner', $any($event.target).checked)" />
        <span><span class="font-semibold">Show “Get the app” on phones</span><br /><span class="text-sm text-ink-soft">A small bar at the top of the shop; shoppers can close it for 30 days</span></span>
      </label>
      <div class="flex flex-col gap-2 rounded-lg border border-dashed border-line p-3 sm:col-span-2">
        <p class="font-semibold">Android app (APK)</p>
        <pc-error-note [message]="error()" />
        <div class="grid gap-2 sm:grid-cols-[1fr_140px_auto] sm:items-end">
          <input #apk type="file" accept=".apk,application/vnd.android.package-archive" (change)="file.set(apk.files?.[0] ?? null)"
            class="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-peacock-light file:px-3 file:py-2 file:font-semibold file:text-peacock" data-testid="shop-apk-file" />
          <pc-text-field label="Version" [(value)]="version" placeholder="1.0.0" />
          <button pcButton type="button" (click)="upload()" [loading]="busy()" [disabled]="!file()">Publish</button>
        </div>
        <p class="text-xs text-ink-soft">Build it in GitHub: Actions → Android shop app → Run workflow (about 10 minutes), then upload the APK here.</p>
      </div>
      <pc-text-field label="Android app download link" [value]="value().shop_android_apk_url" (valueChange)="set('shop_android_apk_url', $event)" hint="Filled in when you upload. Or an https:// link to the APK." />
      <pc-text-field label="Version shown" [value]="value().shop_app_version" (valueChange)="set('shop_app_version', $event)" placeholder="1.0.0" />
      <pc-text-field label="Google Play link" [value]="value().shop_play_store_url" (valueChange)="set('shop_play_store_url', $event)" placeholder="https://play.google.com/store/apps/details?id=…" />
      <pc-text-field label="App Store link (iPhone)" [value]="value().shop_app_store_url" (valueChange)="set('shop_app_store_url', $event)" placeholder="https://apps.apple.com/…" hint="Only when the app is listed on the App Store" />
    </section>
  `,
})
export class MobileApps implements OnInit {
  readonly value = input.required<AppSettings>();
  readonly valueChange = output<AppSettings>();
  private readonly toast = inject(Toast);
  protected readonly file = signal<File | null>(null);
  protected readonly version = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.version.set(this.value().shop_app_version);
  }

  protected set(k: keyof AppSettings, v: string | boolean): void {
    this.valueChange.emit({ ...this.value(), [k]: v });
  }

  protected async upload(): Promise<void> {
    const file = this.file();
    if (!file) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await api<{ settings: AppSettings }>("/api/admin/shop-app", { method: "POST", form, query: { version: this.version().trim() || undefined } });
      this.valueChange.emit({ ...this.value(), shop_android_apk_url: r.settings.shop_android_apk_url, shop_app_version: r.settings.shop_app_version });
      this.file.set(null);
      this.toast.show("The Android app is published. Shoppers can download it from /app.");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not upload the app");
    } finally {
      this.busy.set(false);
    }
  }
}
