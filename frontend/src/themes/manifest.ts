/*
 * Every storefront theme's data (tokens, layout options, colour presets) and how the active theme is worked out
 * from the saved settings. Data only: safe for server components and the admin picker. Components live in slots.tsx.
 *
 * Adding a theme: create src/themes/<id>/theme.ts, add it to THEMES below and to slots.tsx, and add its id to
 * THEME_IDS in types.ts and THEMES in backend/app/services/themes.py.
 */

import { bazaar } from "@/themes/bazaar/theme";
import { classic } from "@/themes/classic/theme";
import { fresh } from "@/themes/fresh/theme";
import { luxe } from "@/themes/luxe/theme";
import {
  DEFAULT_THEME, EDITABLE_COLORS, LAYOUT_CHOICES, THEME_IDS, isThemeId,
  type ActiveTheme, type ColorPreset, type InkColors, type LayoutOverrides, type ThemeColors, type ThemeData, type ThemeId, type ThemeLayout,
} from "@/themes/types";

export const THEMES: Record<ThemeId, ThemeData> = { classic, bazaar, fresh, luxe };
export const THEME_LIST: ThemeData[] = THEME_IDS.map((id) => THEMES[id]);

/** The preset that uses the brand colours from Admin → Storefront → Brand (available in every theme). */
export const BRAND_PRESET = "brand";

const HEX = /^#[0-9a-fA-F]{6}$/;
const PRESET_ID = /^[a-z0-9_-]{1,24}$/;

/** What the site settings hold for themes (Admin → Storefront → Theme and layout). */
export interface ThemeSetting {
  preset?: string;
  /** the owner's own changes on top of the preset */
  colors?: Partial<ThemeColors>;
  /** the owner's changes to the theme's layout */
  layout?: LayoutOverrides;
}
export interface ThemeSiteFields {
  theme?: string;
  theme_settings?: Partial<Record<string, ThemeSetting>>;
  colors: ThemeColors;
}

/** A preview that is not saved: an admin trying a theme, a preset or colours in their own browser. */
export interface ThemePreview {
  theme: ThemeId;
  preset?: string;
  colors?: Partial<ThemeColors>;
  layout?: LayoutOverrides;
}

/** Keeps only known layout options with allowed values. */
export function cleanLayout(raw: unknown): LayoutOverrides {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, allowed] of Object.entries(LAYOUT_CHOICES)) {
    let v = (raw as Record<string, unknown>)[k];
    if (k === "gridColumns" && typeof v === "string") v = Number(v);
    if ((allowed as readonly unknown[]).includes(v)) out[k] = v;
  }
  return out as LayoutOverrides;
}

/** A theme's layout with the owner's changes applied. */
export function applyLayout(base: ThemeLayout, o: LayoutOverrides | undefined): ThemeLayout {
  if (!o) return base;
  return {
    container: o.container ?? base.container,
    productGrid: o.productGrid ?? base.productGrid,
    gridColumns: o.gridColumns ?? base.gridColumns,
    home: { categories: o.categories ?? base.home.categories, sections: o.sections ?? base.home.sections },
    listing: { filters: o.filters ?? base.listing.filters },
    pdp: { layout: o.pdp ?? base.pdp.layout },
    cart: { summary: o.cart ?? base.cart.summary },
    auth: { layout: o.auth ?? base.auth.layout },
  };
}

export function cleanColors(raw: unknown): Partial<ThemeColors> {
  const out: Partial<ThemeColors> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of EDITABLE_COLORS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && HEX.test(v)) out[k] = v.toUpperCase();
  }
  return out;
}

/** The default preset of a theme: the brand colours for Classic (as before themes existed), the first preset otherwise. */
export function defaultPreset(id: ThemeId): string {
  return id === "classic" ? BRAND_PRESET : THEMES[id].presets[0].id;
}

export function findPreset(data: ThemeData, presetId: string | undefined): ColorPreset | null {
  return data.presets.find((p) => p.id === presetId) ?? null;
}

/** The colours of a preset; "brand" uses the site's brand colours. */
export function presetColors(data: ThemeData, presetId: string, brand: ThemeColors): ThemeColors {
  if (presetId === BRAND_PRESET) return { ...brand };
  return { ...(findPreset(data, presetId) ?? data.presets[0]).colors };
}

/**
 * The theme the shop renders: the live one, or a preview; its preset; the final colours; and its layout with the
 * owner's changes (the returned data.layout already includes them).
 */
export function resolveTheme(site: ThemeSiteFields, preview?: ThemePreview | null): ActiveTheme {
  const live: ThemeId = isThemeId(site.theme) ? site.theme : DEFAULT_THEME;
  const id: ThemeId = preview?.theme ?? live;
  const base = THEMES[id];
  const saved = site.theme_settings?.[id] ?? {};
  let presetId = preview?.preset ?? saved.preset ?? defaultPreset(id);
  if (presetId !== BRAND_PRESET && !findPreset(base, presetId)) presetId = defaultPreset(id);
  // A previewed preset starts from that preset; the saved preset keeps the owner's colour changes.
  const own = preview?.colors ?? (preview?.preset && preview.preset !== saved.preset ? {} : cleanColors(saved.colors));
  const colors = { ...presetColors(base, presetId, site.colors), ...cleanColors(own) };
  const ink: InkColors = { ...base.tokens.ink, ...(findPreset(base, presetId)?.ink ?? {}) };
  const layoutOwn = cleanLayout(preview?.layout ?? saved.layout);
  const data = Object.keys(layoutOwn).length ? { ...base, layout: applyLayout(base.layout, layoutOwn) } : base;
  return { data, presetId, colors, ink, preview: Boolean(preview), layoutOverrides: layoutOwn };
}

/** What the shop layout passes to the client (the theme's data is looked up there, not sent with every page). */
export interface ThemeState {
  id: ThemeId;
  presetId: string;
  colors: ThemeColors;
  ink: InkColors;
  preview: boolean;
  /** the owner's layout changes (the client applies them to the theme's layout) */
  layout?: LayoutOverrides;
}

export function toState(t: ActiveTheme): ThemeState {
  return { id: t.data.id, presetId: t.presetId, colors: t.colors, ink: t.ink, preview: t.preview, layout: t.layoutOverrides };
}

/* ------------------------------------------------------------------ preview cookie */

export const PREVIEW_COOKIE = "pc_theme_preview";

/** "k:v,k:v" pairs, used for colours and layout options in the preview cookie and the /theme-preview link. */
export function parsePairs(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const [k, v] = pair.split(":");
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

export function layoutPairs(o: LayoutOverrides | undefined): string {
  const clean = cleanLayout(o);
  return Object.entries(clean).map(([k, v]) => `${k}:${v}`).join(",");
}

/** Cookie value: theme|preset|colours|layout ("primary:0B5563,..." and "productGrid:cards,..."). */
export function encodePreview(p: ThemePreview): string {
  const c = cleanColors(p.colors);
  const colors = EDITABLE_COLORS.filter((k) => c[k]).map((k) => `${k}:${c[k]!.slice(1)}`).join(",");
  return [p.theme, p.preset && PRESET_ID.test(p.preset) ? p.preset : "", colors, layoutPairs(p.layout)].join("|").replace(/\|+$/, "");
}

export function decodePreview(raw: string | undefined | null): ThemePreview | null {
  if (!raw || raw.length > 600) return null;
  const [theme, preset, colors, layout] = raw.split("|");
  if (!isThemeId(theme)) return null;
  const out: ThemePreview = { theme };
  if (preset && PRESET_ID.test(preset)) out.preset = preset;
  if (colors) {
    const c = Object.fromEntries(Object.entries(parsePairs(colors)).map(([k, v]) => [k, `#${v}`]));
    const clean = cleanColors(c);
    if (Object.keys(clean).length) out.colors = clean;
  }
  if (layout) {
    const l = cleanLayout(parsePairs(layout));
    if (Object.keys(l).length) out.layout = l;
  }
  return out;
}
