"use client";

import { FALLBACK_SITE } from "@/lib/site-defaults";

import { createContext, useContext } from "react";
import type { ListSettings, Site } from "./types";

const SiteCtx = createContext<Site>(FALLBACK_SITE);

export function SiteProvider({ site, children }: { site: Site; children: React.ReactNode }) {
  return <SiteCtx.Provider value={site}>{children}</SiteCtx.Provider>;
}

export function useSite() {
  return useContext(SiteCtx);
}

/**
 * How many results each list shows (Admin → Marketplace settings → Lists and results). These defaults apply until the
 * API sends the owner's numbers; 0 hides lists that can be hidden.
 */
export const LIST_DEFAULTS: ListSettings = {
  search_page_size: 24, search_suggestions: 8, similar_products: 12, sponsored_on_product: 10, reviews_page_size: 10,
  questions_page_size: 10, customer_photos_shown: 6, highlights_shown: 5, compare_max: 4, bestseller_badge_top: 10,
  recently_viewed_max: 12, recent_searches_max: 8, checkout_suggestions: 10, brand_filter_max: 30,
};

export function useLists(): ListSettings {
  const site = useContext(SiteCtx);
  return { ...LIST_DEFAULTS, ...(site.lists ?? {}) };
}
