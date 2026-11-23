"use client";

/*
 * "Get the app" for delivery partners: the shared installer (components/install-app) with the partner app's Android
 * APK and Play Store link from Admin → Delivery → Settings. iPhone partners add the app to the home screen.
 */

import { GetTheApp as Installer } from "@/components/install-app";
import type { DeliveryOptions } from "@/lib/delivery-types";

export function GetTheApp({ options, compact }: { options: Pick<DeliveryOptions, "android_apk_url" | "play_store_url" | "app_version"> | null; compact?: boolean }) {
  return (
    <Installer compact={compact} appName="the partner app"
      links={options ? { apkUrl: options.android_apk_url, playUrl: options.play_store_url, version: options.app_version } : null} />
  );
}
