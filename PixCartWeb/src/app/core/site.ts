/*
 * The storefront settings (brand, theme, menus, business details) from /api/site, loaded once before the app renders
 * (provideAppInitializer in app.config.ts), like the reference root layout loads them per request. Port of
 * frontend/src/lib/site.tsx: useSite() → inject(SiteService).site(), useLists() → inject(SiteService).lists().
 */

import { Injectable, computed, signal } from "@angular/core";
import { FALLBACK_SITE, withDefaults } from "./site-defaults";
import type { ListSettings, Site } from "./types";

/**
 * How many results each list shows (Admin → Marketplace settings → Lists and results). These defaults apply until the
 * API sends the owner's numbers; 0 hides lists that can be hidden.
 */
export const LIST_DEFAULTS: ListSettings = {
  search_page_size: 24, search_suggestions: 8, similar_products: 12, sponsored_on_product: 10, reviews_page_size: 10,
  questions_page_size: 10, customer_photos_shown: 6, highlights_shown: 5, compare_max: 4, bestseller_badge_top: 10,
  recently_viewed_max: 12, recent_searches_max: 8, checkout_suggestions: 10, brand_filter_max: 30,
};

@Injectable({ providedIn: "root" })
export class SiteService {
  /** the saved storefront settings, with safe defaults for anything missing */
  readonly site = signal<Site>(FALLBACK_SITE);
  readonly lists = computed<ListSettings>(() => ({ ...LIST_DEFAULTS, ...(this.site().lists ?? {}) }));

  /** Reads /api/site (always fresh: admins edit it). Falls back to the defaults when the API cannot be reached. */
  async load(): Promise<Site> {
    let raw: Partial<Site> | null = null;
    try {
      const res = await fetch("/api/site", { headers: { "X-Requested-With": "pixcart" }, credentials: "same-origin" });
      if (res.ok) raw = (await res.json()) as Partial<Site>;
    } catch {
      raw = null;
    }
    const site = withDefaults(raw);
    this.site.set(site);
    return site;
  }
}
