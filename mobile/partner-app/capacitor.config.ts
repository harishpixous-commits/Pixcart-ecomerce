import type { CapacitorConfig } from "@capacitor/cli";

/*
 * The app opens the live partner web app, so every update to the website reaches partners without a new APK.
 * PIXCART_WEB_URL is your live site (the build workflow asks for it); the app id and name can be changed too.
 * www/ holds only the page shown when the phone is offline.
 */
const web = (process.env.PIXCART_WEB_URL || "https://pixcart.in").replace(/\/+$/, "");
const host = new URL(web).host;

const config: CapacitorConfig = {
  appId: process.env.PIXCART_APP_ID || "in.pixcart.partner",
  appName: process.env.PIXCART_APP_NAME || "PixCart Partner",
  webDir: "www",
  server: {
    url: `${web}/delivery`,
    cleartext: false,
    allowNavigation: [host],
    errorPath: "index.html",
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    appendUserAgent: "PixCartPartnerApp",
  },
  plugins: {
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};

export default config;
