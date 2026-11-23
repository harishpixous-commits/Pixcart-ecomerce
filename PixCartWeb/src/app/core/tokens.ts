import { rupees } from "./format";
import type { Site } from "./types";

/**
 * Placeholders admins can use in storefront text, so copy never goes stale when a setting changes:
 * {brand}, {free_delivery_amount}. Plain string replacement; the result is rendered as text, never HTML.
 */
export function fillTokens(text: string, site: Pick<Site, "brand_name" | "free_shipping_threshold_paise">): string {
  return text
    .replaceAll("{brand}", site.brand_name)
    .replaceAll("{free_delivery_amount}", rupees(site.free_shipping_threshold_paise));
}

/** Two-tone wordmark: a CamelCase name is split at its last capital ("PixCart" → "Pix" + "Cart"). */
export function splitBrand(name: string): [string, string] {
  const i = name.search(/[A-Z][^A-Z]*$/);
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}
