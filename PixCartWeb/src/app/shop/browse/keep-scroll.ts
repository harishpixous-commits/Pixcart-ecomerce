/*
 * router.push(url, { scroll: false }) for Angular: the app scrolls to the top on every navigation
 * (withInMemoryScrolling), so filter and sort changes put the shopper back where they were once the router has scrolled.
 */

import type { Router } from "@angular/router";

export function navigateKeepScroll(router: Router, url: string): void {
  const x = window.scrollX, y = window.scrollY;
  void router.navigateByUrl(url).then(() => {
    // the router's scroller runs on the next frame or task; restore after it
    const restore = () => window.scrollTo(x, y);
    requestAnimationFrame(() => setTimeout(restore, 0));
    setTimeout(restore, 30);
  });
}
