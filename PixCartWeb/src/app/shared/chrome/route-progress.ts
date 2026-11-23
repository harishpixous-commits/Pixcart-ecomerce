/*
 * A thin bar at the top of the window while the next page loads (Admin → Product page → "Page loading bar").
 * It starts when a link to another page is clicked (or "route-progress:start" is dispatched) and finishes when the
 * new address is shown. Port of components/route-progress.tsx.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal } from "@angular/core";
import { NavigationCancel, NavigationEnd, NavigationError, Router } from "@angular/router";
import { SiteService } from "../../core/site";

@Component({
  selector: "pc-route-progress",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (enabled() && visible()) {
      <div class="pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px]" role="progressbar" aria-label="Loading page" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="round(width())">
        <div class="h-full bg-marigold shadow-[0_0_8px_rgba(245,165,36,0.8)] transition-[width] duration-200 ease-out" [style.width.%]="width()"></div>
      </div>
    }
  `,
})
export class RouteProgress {
  private readonly site = inject(SiteService).site;
  protected readonly enabled = () => this.site().pdp?.page_loading_bar !== false;
  protected readonly width = signal(0);
  protected readonly visible = signal(false);
  protected readonly round = Math.round;
  private timer: ReturnType<typeof setInterval> | undefined;
  private safety: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const router = inject(Router);
    const destroy = inject(DestroyRef);
    const onClick = (e: MouseEvent) => {
      if (!this.enabled()) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      this.start();
    };
    const onStart = () => { if (this.enabled()) this.start(); };
    document.addEventListener("click", onClick, true);
    window.addEventListener("route-progress:start", onStart);
    const sub = router.events.subscribe((e) => {
      // The new page is on screen.
      if ((e instanceof NavigationEnd || e instanceof NavigationCancel || e instanceof NavigationError) && this.visible()) this.finish();
    });
    destroy.onDestroy(() => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("route-progress:start", onStart);
      sub.unsubscribe();
    });
    effect(() => { if (!this.enabled()) this.visible.set(false); });
  }

  private start(): void {
    clearInterval(this.timer);
    clearTimeout(this.safety);
    this.visible.set(true);
    this.width.set(12);
    this.timer = setInterval(() => this.width.update((w) => (w < 90 ? w + (90 - w) * 0.12 : w)), 200);
    this.safety = setTimeout(() => this.finish(), 12000);
  }

  private finish(): void {
    clearInterval(this.timer);
    clearTimeout(this.safety);
    this.width.set(100);
    setTimeout(() => {
      this.visible.set(false);
      this.width.set(0);
    }, 250);
  }
}
