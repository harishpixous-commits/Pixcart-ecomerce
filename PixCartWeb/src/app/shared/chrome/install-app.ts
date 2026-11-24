/*
 * Installing the website as an app (the browser's install prompt) and which device the visitor uses, and "Get the app"
 * for both apps (the shop at /app, the delivery partner app at /delivery/download). Port of components/install-app.tsx:
 *   <pc-get-the-app [links]="{ apkUrl, playUrl, appStoreUrl, version } | null" [compact]="true" appName="the partner app" />
 *   <pc-ios-steps />
 * Every phone can install the website itself as an app: Android Chrome (and desktop Chrome or Edge) show their install
 * prompt from our button; iPhone and iPad get the Safari "Share → Add to Home Screen" steps. When staff have published
 * an Android APK, a Play Store or an App Store link (admin settings), those buttons appear too.
 */

import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";
import { Apple, Download, MonitorSmartphone, SquarePlus, Share, Smartphone } from "lucide-angular";
import { Icon } from "../ui/icon";

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

/** The browser's install prompt, when it offers one (Android Chrome, desktop Chrome and Edge). */
export const installPrompt = signal<PromptEvent | null>(null);
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for our own button
    installPrompt.set(e as PromptEvent);
  });
  window.addEventListener("appinstalled", () => installPrompt.set(null));
}

export async function promptInstall(): Promise<boolean> {
  const deferred = installPrompt();
  if (!deferred) return false;
  await deferred.prompt();
  const choice = await deferred.userChoice.catch(() => null);
  installPrompt.set(null);
  return choice?.outcome === "accepted";
}

export type Device = "ios" | "android" | "desktop";

/** The visitor's device and whether the app is already running from the home screen. */
export function detectDevice(): { device: Device; installed: boolean } {
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1); // iPadOS reports a Mac
  const device: Device = ios ? "ios" : /android/i.test(ua) ? "android" : "desktop";
  const installed = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return { device, installed };
}

export type AppLinks = { apkUrl?: string; playUrl?: string; appStoreUrl?: string; version?: string };

const BTN = "flex items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold transition-colors";

/** Safari's "Add to Home Screen", step by step (the only way to install a website on iPhone and iPad). */
@Component({
  selector: "pc-ios-steps",
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ol class="grid gap-2 rounded-xl bg-white p-4 text-sm text-ink ring-1 ring-line" data-testid="ios-steps">
      <li class="flex items-start gap-3">
        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-peacock text-xs font-bold text-white">1</span>
        <span class="flex items-center gap-2 pt-1"><svg [pcIcon]="Apple" class="h-4 w-4" /><span>Open this page in <b>Safari</b>.</span></span>
      </li>
      <li class="flex items-start gap-3">
        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-peacock text-xs font-bold text-white">2</span>
        <span class="flex items-center gap-2 pt-1"><svg [pcIcon]="Share" class="h-4 w-4" /><span>Tap the <b>Share</b> button (the square with an arrow) at the bottom.</span></span>
      </li>
      <li class="flex items-start gap-3">
        <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-peacock text-xs font-bold text-white">3</span>
        <span class="flex items-center gap-2 pt-1"><svg [pcIcon]="SquarePlus" class="h-4 w-4" /><span>Scroll and choose <b>Add to Home Screen</b>, then tap <b>Add</b>.</span></span>
      </li>
      <li class="pl-10 text-xs text-ink-soft">The app opens full screen from its icon, with the same sign-in, cart and orders as the website.</li>
    </ol>
  `,
})
export class IosSteps {
  protected readonly Apple = Apple;
  protected readonly Share = Share;
  protected readonly SquarePlus = SquarePlus;
}

@Component({
  selector: "pc-get-the-app",
  imports: [Icon, IosSteps],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-2", "data-testid": "get-the-app" },
  template: `
    <div [class]="compact() ? 'grid gap-2' : 'grid gap-2 sm:grid-cols-2'">
      @if (installed) {
        <p [class]="BTN + ' bg-leaf-light text-leaf'" data-testid="app-installed">{{ appName() === "the app" ? "The app" : appName() }} is installed on this device</p>
      } @else if (prompt()) {
        <button type="button" [class]="BTN + ' bg-marigold text-ink hover:bg-marigold-dark'" (click)="install()" data-testid="install-app">
          <svg [pcIcon]="MonitorSmartphone" class="h-5 w-5" /> Install {{ appName() }} on this device
        </button>
      } @else if (device === "ios") {
        <button type="button" [class]="BTN + ' bg-marigold text-ink hover:bg-marigold-dark'" (click)="showIos.set(!showIos())" [attr.aria-expanded]="showIos()" data-testid="ios-install">
          <svg [pcIcon]="Share" class="h-5 w-5" /> Add to iPhone home screen
        </button>
      } @else {
        <p class="rounded-xl bg-white/70 px-4 py-3 text-sm text-ink-soft ring-1 ring-line" data-testid="install-hint">
          @if (device === "desktop") {On your phone, open this page and tap <b>Install</b> (Android) or <b>Add to Home Screen</b> (iPhone). Or scan the code on this page.} @else {Open this page in <b>Chrome</b> and choose <b>Install app</b> (or <b>Add to Home screen</b>) from the ⋮ menu.}
        </p>
      }
      @if (links()?.apkUrl && device !== "ios") {
        <a [href]="links()!.apkUrl" download [class]="BTN + ' bg-ink text-white hover:bg-ink/90'" data-testid="apk-download">
          <svg [pcIcon]="Download" class="h-5 w-5" /> Download Android app{{ links()!.version ? " (v" + links()!.version + ")" : "" }}
        </a>
      }
      @if (links()?.playUrl && device !== "ios") {
        <a [href]="links()!.playUrl" target="_blank" rel="noreferrer" [class]="BTN + ' bg-ink text-white hover:bg-ink/90'" data-testid="play-store">
          <svg [pcIcon]="Smartphone" class="h-5 w-5" /> Get it on Google Play
        </a>
      }
      @if (links()?.appStoreUrl && device !== "android") {
        <a [href]="links()!.appStoreUrl" target="_blank" rel="noreferrer" [class]="BTN + ' bg-ink text-white hover:bg-ink/90'" data-testid="app-store">
          <svg [pcIcon]="Apple" class="h-5 w-5" /> Download on the App Store
        </a>
      }
    </div>
    @if (showIos() && !installed) {<pc-ios-steps />}
  `,
})
export class GetTheApp {
  readonly links = input<AppLinks | null>(null);
  readonly compact = input(false);
  readonly appName = input("the app");
  protected readonly prompt = installPrompt;
  protected readonly device: Device;
  protected readonly installed: boolean;
  protected readonly showIos = signal(false);
  protected readonly BTN = BTN;
  protected readonly MonitorSmartphone = MonitorSmartphone;
  protected readonly Share = Share;
  protected readonly Download = Download;
  protected readonly Smartphone = Smartphone;
  protected readonly Apple = Apple;

  constructor() {
    const d = detectDevice();
    this.device = d.device;
    this.installed = d.installed;
  }

  ngOnInit(): void {
    if (this.device === "ios" && !this.compact()) this.showIos.set(true);
  }

  protected install(): void {
    void promptInstall();
  }
}
