/*
 * The CSS variables a theme sets (tokens): colours, text and line colours, fonts, heading spacing, corner radius,
 * card shadows and page width. Tailwind's colours, fonts, radii, shadows and max-w-shop read these, so every shop
 * screen follows the theme without code changes.
 */

import { colorVars, cssBlock, radiusVars, rgb, triple } from "@/lib/theme";
import type { ActiveTheme } from "@/themes/types";

const SHADOWS = {
  none: { card: "0 0 0 1px rgb(var(--c-line))", hover: "0 0 0 1px rgb(var(--c-ink) / 0.22)", panel: "none" },
  soft: {
    card: "0 1px 2px rgb(16 24 40 / 0.05), 0 1px 3px rgb(16 24 40 / 0.07)",
    hover: "0 6px 16px -4px rgb(16 24 40 / 0.16)",
    panel: "0 1px 2px rgb(16 24 40 / 0.04)",
  },
  lifted: {
    card: "0 1px 3px rgb(16 24 40 / 0.07), 0 4px 12px -4px rgb(16 24 40 / 0.10)",
    hover: "0 14px 30px -10px rgb(16 24 40 / 0.28)",
    panel: "0 1px 3px rgb(16 24 40 / 0.06)",
  },
} as const;

/**
 * @param classicRadius Classic keeps the corner style chosen in Admin → Storefront → Brand (as before themes).
 */
export function themeVars(t: ActiveTheme, classicRadius?: string): Record<string, string> {
  const { tokens, layout, id } = t.data;
  const radius = id === "classic" && classicRadius ? classicRadius : tokens.radius;
  const shadow = SHADOWS[tokens.shadow];
  return {
    ...colorVars(t.colors),
    ...radiusVars(radius),
    "--c-ink": triple(rgb(t.ink.ink, [27, 36, 48])),
    "--c-ink-soft": triple(rgb(t.ink.ink_soft, [74, 85, 101])),
    "--c-ink-faint": triple(rgb(t.ink.ink_faint, [122, 133, 148])),
    "--c-line": triple(rgb(t.ink.line, [220, 227, 232])),
    "--f-display": tokens.fonts.display,
    "--f-sans": tokens.fonts.sans,
    "--h-tracking": tokens.headingTracking,
    // "wide" fills large screens with only a thin margin (about 20 px a side on a 1920 px screen, like the big
    // marketplaces); "boxed" keeps a centred 1280 px column.
    "--w-shop": layout.container === "wide" ? "1880px" : "1280px",
    "--shadow-card": shadow.card,
    "--shadow-card-hover": shadow.hover,
    "--shadow-panel": shadow.panel,
  };
}

/**
 * The style tag for shop pages. ":root:root" outranks the brand colours on ":root" (app/layout.tsx), so pop-ups
 * rendered at the end of the page follow the theme too. The tag lives in the shop layout: leaving the shop for the
 * admin panel or seller hub removes it and the brand colours apply again.
 */
export function themeCssText(t: ActiveTheme, classicRadius?: string): string {
  return cssBlock(":root:root", themeVars(t, classicRadius));
}
