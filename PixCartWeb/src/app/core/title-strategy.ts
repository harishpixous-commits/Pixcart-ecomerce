/*
 * Page titles like the reference's Next metadata: a route's `title` becomes "<title> | <brand>", pages without one
 * keep the site's SEO title. Pages can also call setPageTitle() (core/brand.ts) once their data has loaded.
 */

import { Injectable } from "@angular/core";
import { RouterStateSnapshot, TitleStrategy } from "@angular/router";
import { setPageTitle } from "./brand";

@Injectable()
export class PageTitleStrategy extends TitleStrategy {
  override updateTitle(snapshot: RouterStateSnapshot): void {
    setPageTitle(this.buildTitle(snapshot) ?? null);
  }
}
