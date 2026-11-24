/*
 * "Get the app" for delivery partners: the shared installer (shared/chrome/install-app) with the partner app's Android
 * APK and Play Store link from Admin → Delivery → Settings. iPhone partners add the app to the home screen.
 * Port of components/delivery/install.tsx: <pc-partner-get-the-app [options]="o" [compact]="true" />
 */

import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import type { DeliveryOptions } from "../../core/delivery-types";
import { GetTheApp } from "../../shared/chrome/install-app";

@Component({
  selector: "pc-partner-get-the-app",
  imports: [GetTheApp],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-get-the-app [compact]="compact()" appName="the partner app" [links]="links()" />`,
})
export class PartnerGetTheApp {
  readonly options = input<Pick<DeliveryOptions, "android_apk_url" | "play_store_url" | "app_version"> | null>(null);
  readonly compact = input(false);
  protected readonly links = computed(() => {
    const o = this.options();
    return o ? { apkUrl: o.android_apk_url, playUrl: o.play_store_url, version: o.app_version } : null;
  });
}
