/*
 * A small "Get the app" bar at the top of the shop on phones (Admin → Marketplace settings → Mobile apps can switch it
 * off). Not shown inside the installed app, inside the admin's preview window, on checkout or sign-in pages, or for
 * 30 days after the shopper closes it. Port of components/app-banner.tsx.
 */

import { ChangeDetectionStrategy, Component, afterNextRender, computed, inject, signal } from "@angular/core";
import { X } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SiteService } from "../../core/site";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";
import { detectDevice, installPrompt, promptInstall, type Device } from "./install-app";

const KEY = "pc_app_banner_hidden_until";
const QUIET = ["/app", "/checkout", "/login", "/signup", "/cart"];

@Component({
  selector: "pc-app-banner",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (show()) {
      <div class="flex items-center gap-3 border-b border-line bg-white px-3 py-2 text-ink" role="region" aria-label="Get the app" data-testid="app-banner">
        <button type="button" (click)="close()" aria-label="Close" class="-ml-1 rounded p-1 text-ink-faint hover:bg-mist"><svg [pcIcon]="X" class="h-4 w-4" /></button>
        <img src="/app-icon/192" alt="" width="36" height="36" class="h-9 w-9 rounded-lg" />
        <div class="min-w-0 flex-1 leading-tight">
          <p class="truncate text-sm font-semibold">{{ site().brand_name }} app</p>
          <p class="truncate text-xs text-ink-soft">Faster shopping, full screen</p>
        </div>
        @if (prompt()) {
          <button type="button" (click)="install()" class="rounded-full bg-peacock px-4 py-1.5 text-sm font-bold text-white">Install</button>
        } @else {
          <a pcLink="/app" class="rounded-full bg-peacock px-4 py-1.5 text-sm font-bold text-white">{{ device() === "ios" ? "Get" : "Install" }}</a>
        }
      </div>
    }
  `,
})
export class AppBanner {
  protected readonly site = inject(SiteService).site;
  private readonly path = inject(RouteState).pathname;
  protected readonly X = X;
  protected readonly prompt = installPrompt;
  protected readonly device = signal<Device | null>(null);
  private readonly installed = signal(false);
  private readonly hidden = signal(true);
  protected readonly show = computed(() => {
    if (this.hidden() || this.installed() || this.site().app?.banner === false) return false;
    const d = this.device();
    if (d !== "android" && d !== "ios") return false;
    const p = this.path();
    return !QUIET.some((q) => p === q || p.startsWith(`${q}/`));
  });

  constructor() {
    afterNextRender(() => {
      let until = 0;
      try { until = Number(localStorage.getItem(KEY) || 0); } catch { /* storage blocked */ }
      const d = detectDevice();
      this.device.set(d.device);
      this.installed.set(d.installed);
      this.hidden.set(until > Date.now() || window.top !== window);
    });
  }

  protected close(): void {
    try { localStorage.setItem(KEY, String(Date.now() + 30 * 86400_000)); } catch { /* */ }
    this.hidden.set(true);
  }

  protected install(): void {
    void promptInstall();
  }
}
