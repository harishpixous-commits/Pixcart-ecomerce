/*
 * Admin → Storefront → Theme and layout: the data side of the picker. What the owner is editing for a theme (a
 * draft), how it compares with what is saved, what is sent when saving, the readable-text checks and the live
 * preview link. No components here. Port of frontend/src/app/admin/storefront/theme-model.tsx.
 */

import { contrast } from "../../core/theme";
import {
  BRAND_PRESET, THEMES, applyLayout, cleanLayout, findPreset, layoutPairs, presetColors, resolveTheme,
  type ThemeSetting, type ThemeSiteFields,
} from "../../themes/manifest";
import {
  EDITABLE_COLORS, LAYOUT_CHOICES,
  type ActiveTheme, type ColorPreset, type EditableColor, type LayoutOverrides, type ThemeColors, type ThemeData, type ThemeId, type ThemeLayout,
} from "../../themes/types";

/** The site fields the picker reads (GET /api/admin/storefront/site). */
export interface PickerSite extends ThemeSiteFields {
  brand_name: string;
  /** Classic keeps the corner style from the Brand tab */
  radius: string;
}

/** What PUT /api/admin/storefront/theme returns. */
export interface ThemeSaved {
  theme: string;
  theme_settings: NonNullable<ThemeSiteFields["theme_settings"]>;
}

/** What the owner is editing for one theme: its preset, the six final colours and the layout changes. */
export interface Draft {
  preset: string;
  colors: ThemeColors;
  layout: LayoutOverrides;
}

export type LayoutKey = keyof typeof LAYOUT_CHOICES;
export type LayoutValue = (typeof LAYOUT_CHOICES)[LayoutKey][number];
export type FlatLayout = { [K in LayoutKey]-?: NonNullable<LayoutOverrides[K]> };

export const HEX = /^#[0-9a-fA-F]{6}$/;

export function flatLayout(l: ThemeLayout): FlatLayout {
  return {
    container: l.container, productGrid: l.productGrid, gridColumns: l.gridColumns, categories: l.home.categories,
    sections: l.home.sections, filters: l.listing.filters, pdp: l.pdp.layout, cart: l.cart.summary, auth: l.auth.layout,
  };
}

/** A theme as it is saved now. */
export function savedDraft(site: PickerSite, id: ThemeId): Draft {
  const t = resolveTheme({ ...site, theme: id });
  return { preset: t.presetId, colors: t.colors, layout: t.layoutOverrides ?? {} };
}

/** The theme as the shop would render it with this draft (for the miniatures and the readable-text checks). */
export function draftTheme(site: PickerSite, id: ThemeId, d: Draft): ActiveTheme {
  return resolveTheme(site, { theme: id, preset: d.preset, colors: d.colors, layout: d.layout });
}

/** Presets offered in every theme: the brand colours first, then the theme's own. */
export function presetsFor(data: ThemeData, brand: ThemeColors): ColorPreset[] {
  return [{ id: BRAND_PRESET, name: "Brand colours", colors: brand }, ...data.presets];
}

export function presetName(data: ThemeData, presetId: string): string {
  return presetId === BRAND_PRESET ? "Brand colours" : findPreset(data, presetId)?.name ?? data.presets[0].name;
}

/**
 * What is saved for a theme: its preset, only the colours that differ from the preset and only the layout options
 * that differ from the theme's own.
 */
export function toSetting(id: ThemeId, d: Draft, brand: ThemeColors): Required<Pick<ThemeSetting, "preset" | "colors" | "layout">> {
  const data = THEMES[id];
  const base = presetColors(data, d.preset, brand);
  const colors: Partial<ThemeColors> = {};
  for (const k of EDITABLE_COLORS) {
    if (d.colors[k].toUpperCase() !== base[k].toUpperCase()) colors[k] = d.colors[k].toUpperCase();
  }
  const own = flatLayout(data.layout);
  const layout: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cleanLayout(d.layout))) {
    if (own[k as LayoutKey] !== v) layout[k] = v;
  }
  return { preset: d.preset, colors, layout: layout as LayoutOverrides };
}

/** True when a draft would save something different from what is saved. */
export function differs(id: ThemeId, a: Draft, b: Draft, brand: ThemeColors): boolean {
  return JSON.stringify(toSetting(id, a, brand)) !== JSON.stringify(toSetting(id, b, brand));
}

/** How many colours and layout options differ from the preset and the theme's own. */
export function changeCounts(id: ThemeId, d: Draft, brand: ThemeColors): { colors: number; layout: number } {
  const s = toSetting(id, d, brand);
  return { colors: Object.keys(s.colors).length, layout: Object.keys(s.layout).length };
}

/**
 * The live preview link: /theme-preview sets this browser's preview cookie and opens the page. Every colour and
 * every layout option is sent, so the preview shows exactly the draft (not what is saved).
 */
export function previewHref(id: ThemeId, d: Draft, to: string): string {
  const q = new URLSearchParams({ theme: id, preset: d.preset });
  for (const k of EDITABLE_COLORS) q.set(k, d.colors[k].replace("#", "").toUpperCase());
  q.set("layout", layoutPairs(flatLayout(applyLayout(THEMES[id].layout, d.layout))));
  q.set("to", to);
  return `/theme-preview?${q}`;
}

/* ------------------------------------------------------------------ words for the layout options */

export interface LayoutWords {
  label: string;
  help: string;
  values: Record<string, string>;
}

/** In the order the Layout panel shows them. */
export const LAYOUT_WORDS: Record<LayoutKey, LayoutWords> = {
  productGrid: { label: "Product grid", help: "How products sit in grids and rows", values: { hairline: "Hairline grid", cards: "Raised cards", airy: "Airy" } },
  gridColumns: { label: "Products per row", help: "On computers, in full-width grids", values: { 4: "4 per row", 5: "5 per row", 6: "6 per row" } },
  categories: { label: "Home categories", help: "The category block on the home page", values: { circles: "Circles", cards: "Cards", squares: "Squares", chips: "Chips" } },
  sections: { label: "Home sections", help: "Blocks on white panels, or on the page", values: { panel: "Panels", plain: "On the page" } },
  filters: { label: "Filters", help: "On category and search pages", values: { sidebar: "Left column", topbar: "Bar on top" } },
  pdp: { label: "Product page", help: "Photos, details and the buy box", values: { three: "Three columns", two: "Two columns", gallery: "Large gallery" } },
  cart: { label: "Cart", help: "Where the total and checkout button sit", values: { side: "Side summary", sticky: "Bar at the bottom" } },
  auth: { label: "Sign-in", help: "Sign-in and sign-up pages", values: { card: "Centred card", split: "Split with brand panel" } },
  container: { label: "Page width", help: "How wide pages get on large screens", values: { boxed: "Boxed", wide: "Wide" } },
};

export const LAYOUT_KEYS = Object.keys(LAYOUT_WORDS) as LayoutKey[];

export function layoutWord(k: LayoutKey, v: unknown): string {
  return LAYOUT_WORDS[k].values[String(v)] ?? String(v);
}

/* ------------------------------------------------------------------ readable text */

export interface ColorCheck {
  key: EditableColor;
  /** the text colour used on this colour */
  text: string;
  ratio: number;
  ok: boolean;
  warning: string;
}

const MIN_RATIO = 4.5;
const WHITE = "#FFFFFF";

/** Text colour on each colour and the advice when it is hard to read (white on the strong colours, ink on the others). */
const CHECKS: [EditableColor, "white" | "ink", string, string][] = [
  ["primary", "white", "White text on the main colour", "Pick a darker main colour."],
  ["primary_dark", "white", "White text on the dark main colour", "Pick a darker shade."],
  ["accent", "ink", "Text on the highlight colour", "Pick a lighter highlight colour."],
  ["buy", "white", "White text on the buy button", "Pick a darker buy button colour."],
  ["success", "white", "White text on the success colour", "Pick a darker success colour."],
  ["page", "ink", "Text on the page background", "Pick a lighter page background."],
];

export function colorChecks(colors: ThemeColors, ink: string): ColorCheck[] {
  return CHECKS.map(([key, on, what, advice]) => {
    const text = on === "white" ? WHITE : ink;
    const ratio = contrast(colors[key], text);
    const shown = (Math.floor(ratio * 10) / 10).toFixed(1);
    return { key, text, ratio, ok: ratio >= MIN_RATIO, warning: `${what} is hard to read (${shown}:1, needs at least 4.5:1). ${advice}` };
  });
}

export function ratioText(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}
