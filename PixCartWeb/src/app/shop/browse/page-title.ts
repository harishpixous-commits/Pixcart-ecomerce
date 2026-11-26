/*
 * A page title that stays put while the page's query string changes (filters, sort, pages). The router applies the
 * route's title (or the site's default) on every navigation, so pages whose title comes from their data set it again
 * after each one, so the page keeps its own title. Call in a constructor:
 *   keepPageTitle(() => this.product()?.title ?? null)   (null: leave the title as it is)
 */

import { DestroyRef, effect, inject } from "@angular/core";
import { NavigationEnd, Router } from "@angular/router";
import { setPageTitle } from "../../core/brand";

export function keepPageTitle(title: () => string | null): void {
  const apply = () => {
    const t = title();
    if (t !== null) setPageTitle(t);
  };
  effect(apply);
  const sub = inject(Router).events.subscribe((e) => {
    if (e instanceof NavigationEnd) setTimeout(apply, 0);
  });
  inject(DestroyRef).onDestroy(() => sub.unsubscribe());
}
