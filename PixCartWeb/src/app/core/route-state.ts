/*
 * The current address as signals: Next's usePathname() and useSearchParams() for Angular components.
 * pathname() and search() change when a navigation ends (the new page is on screen), like in the reference.
 */

import { Injectable, computed, inject, signal } from "@angular/core";
import { NavigationEnd, Router } from "@angular/router";

@Injectable({ providedIn: "root" })
export class RouteState {
  private readonly router = inject(Router);
  /** "/orders/123" */
  readonly pathname = signal<string>(typeof location !== "undefined" ? location.pathname : "/");
  /** "?q=x&page=2" ("" when none) */
  readonly search = signal<string>(typeof location !== "undefined" ? location.search : "");
  readonly params = computed(() => new URLSearchParams(this.search()));

  constructor() {
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) {
        const u = new URL(e.urlAfterRedirects, "http://x");
        if (u.pathname !== this.pathname()) this.pathname.set(u.pathname);
        if (u.search !== this.search()) this.search.set(u.search);
      }
    });
  }

  /** One query parameter (useSearchParams().get(name)). */
  param(name: string): string | null {
    return this.params().get(name);
  }
}
