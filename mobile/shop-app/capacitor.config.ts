import type { CapacitorConfig } from "@capacitor/cli";

/*
 * The customer app opens the live shop, so every update to the website reaches shoppers without a new APK, and the
 * app always looks and works exactly like the website (sign-in, cart, checkout, orders). PIXCART_WEB_URL is your live
 * site (the build workflow asks for it). www/ holds only the page shown when the phone is offline.
 */
const web = (process.env.PIXCART_WEB_URL || "https://pixcart.in").replace(/\/+$/, "");
const host = new URL(web).host;

const config: CapacitorConfig = {
  appId: process.env.PIXCART_APP_ID || "in.pixcart.shop",
  appName: process.env.PIXCART_APP_NAME || "PixCart",
  webDir: "www",
  server: {
    url: web,
    cleartext: false,
    allowNavigation: [host],
    errorPath: "index.html",
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
    appendUserAgent: "PixCartShopApp",
  },
  plugins: {
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};

export default config;
