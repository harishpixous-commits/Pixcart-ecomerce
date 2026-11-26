/*
 * Next's <Link href>: a plain <a href> that navigates inside the app without a page load. The href keeps its query
 * string and hash exactly ("/search?q=tea"), outside links ("https://...", "mailto:") behave as normal links, and
 * modified clicks (new tab, Ctrl, middle button) are left to the browser. Usage: <a pcLink="/orders">.
 */

import { Location } from "@angular/common";
import { Directive, inject, input } from "@angular/core";
import { Router } from "@angular/router";

@Directive({
  selector: "a[pcLink]",
  host: { "[attr.href]": "pcLink()", "(click)": "onClick($event)" },
})
export class PcLink {
  readonly pcLink = input.required<string>();
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  onClick(e: MouseEvent): void {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.currentTarget as HTMLAnchorElement;
    if ((a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    const href = this.pcLink();
    if (!href || !href.startsWith("/") || href.startsWith("//")) return;
    e.preventDefault();
    void this.router.navigateByUrl(href).then((ok) => {
      // Next shows the address exactly as the href wrote it ("?next=/delivery/register"); the router writes its own
      // encoding of the same address ("?next=%2Fdelivery%2Fregister"). Put the written form back when only that differs.
      if (ok && href.includes("?") && this.location.path(true) !== href && this.router.url === this.router.parseUrl(href).toString())
        this.location.replaceState(href, "", this.location.getState());
    });
  }
}

/** Navigates like a Link (for router.push in event handlers). */
export function isInternal(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}
