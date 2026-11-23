/*
 * The contract every storefront theme fulfils (see docs/THEMES.md).
 *
 * A theme = tokens (CSS variables: colours, fonts, shapes, shadows) + layout options (how shared screens are
 * arranged) + slot components (the parts whose structure differs: header, footer, phone tab bar, product tile)
 * + colour presets (ready-made palettes the owner can switch between).
 * Data (tokens, layout, presets) is kept apart from components so server code and the admin picker can read it
 * cheaply.
 */

import type { Type } from "@angular/core";
type ComponentType<_P = unknown> = Type<unknown>;
import type { ProductCard } from "../core/types";

export const THEME_IDS = ["classic", "bazaar", "fresh", "luxe"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = "classic";

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

/** The colours admins pick (Admin → Storefront → Theme and layout). Hex values. */
export interface ThemeColors {
  primary: string;
  primary_dark: string;
  accent: string;
  buy: string;
  success: string;
  page: string;
}
export const EDITABLE_COLORS = ["primary", "primary_dark", "accent", "buy", "success", "page"] as const;
export type EditableColor = (typeof EDITABLE_COLORS)[number];

/** A ready-made palette for a theme. The first preset of every theme is its default. */
export interface ColorPreset {
  id: string;
  name: string;
  colors: ThemeColors;
  /** text and line colours that suit this palette (optional; otherwise the theme's) */
  ink?: Partial<InkColors>;
}

export interface InkColors {
  ink: string;
  ink_soft: string;
  ink_faint: string;
  line: string;
}

export interface ThemeTokens {
  ink: InkColors;
  /** CSS font-family stacks (the fonts are loaded in app/layout.tsx) */
  fonts: { display: string; sans: string };
  /** letter-spacing for headings */
  headingTracking: string;
  radius: "square" | "rounded" | "soft";
  /** card elevation: hairlines only, a soft shadow, or a lifted shadow */
  shadow: "none" | "soft" | "lifted";
}

export interface ThemeLayout {
  /** shop page width: a centred 1280 px column ("boxed") or the full screen with a thin margin, up to 1880 px ("wide") */
  container: "boxed" | "wide";
  /** product grids and rails: hairline grid, raised cards, or airy borderless */
  productGrid: "hairline" | "cards" | "airy";
  /** product tiles per row on large screens in full-width grids */
  gridColumns: 4 | 5 | 6;
  home: {
    /** category blocks: round icons, raised cards, dense tinted squares, or text chips (a home section can override it) */
    categories: "circles" | "cards" | "squares" | "chips";
    /** home sections on white panels, or straight on the page */
    sections: "panel" | "plain";
  };
  /** category and search pages: filters in a left column, or a bar on top with a filter drawer */
  listing: { filters: "sidebar" | "topbar" };
  /** product page: gallery + details + buy box in three columns, two columns, or a large gallery */
  pdp: { layout: "three" | "two" | "gallery" };
  /** cart: summary in a side column, or one column with a bar that stays at the bottom */
  cart: { summary: "side" | "sticky" };
  /** sign-in and sign-up: a centred card, or split with a brand panel */
  auth: { layout: "card" | "split" };
}

/**
 * The owner's changes to a theme's layout (Admin → Storefront → Theme and layout → Layout), as flat keys.
 * Anything left out keeps the theme's own choice.
 */
export interface LayoutOverrides {
  container?: ThemeLayout["container"];
  productGrid?: ThemeLayout["productGrid"];
  gridColumns?: ThemeLayout["gridColumns"];
  categories?: ThemeLayout["home"]["categories"];
  sections?: ThemeLayout["home"]["sections"];
  filters?: ThemeLayout["listing"]["filters"];
  pdp?: ThemeLayout["pdp"]["layout"];
  cart?: ThemeLayout["cart"]["summary"];
  auth?: ThemeLayout["auth"]["layout"];
}

/** Every layout option and its allowed values (also validated in backend/app/services/themes.py). */
export const LAYOUT_CHOICES = {
  container: ["boxed", "wide"],
  productGrid: ["hairline", "cards", "airy"],
  gridColumns: [4, 5, 6],
  categories: ["circles", "cards", "squares", "chips"],
  sections: ["panel", "plain"],
  filters: ["sidebar", "topbar"],
  pdp: ["three", "two", "gallery"],
  cart: ["side", "sticky"],
  auth: ["card", "split"],
} as const satisfies { [K in keyof LayoutOverrides]-?: readonly NonNullable<LayoutOverrides[K]>[] };

export interface ThemeData {
  id: ThemeId;
  name: string;
  /** one line for the picker */
  tagline: string;
  description: string;
  /** what the theme suits, shown as tags in the picker */
  bestFor: string[];
  /** the header's background: the brand colour, or light (sets the phone browser's toolbar colour too) */
  chrome: "brand" | "light";
  tokens: ThemeTokens;
  layout: ThemeLayout;
  /** at least one; the first is the default */
  presets: ColorPreset[];
}

export interface ProductTileProps {
  p: ProductCard;
  showAdd?: boolean;
  rank?: number;
  /** a round "+" add button over the image (single-version products) */
  quickPlus?: boolean;
}

export interface ThemeSlots {
  /** everything above the page content: announcement, header, navigation */
  Header: ComponentType;
  Footer: ComponentType;
  /** the phone tab bar (null: none) */
  MobileNav: ComponentType | null;
  ProductTile: ComponentType<ProductTileProps>;
}

/** What the shop renders with: the theme, the chosen preset and the final colours (preset + owner's changes). */
export interface ActiveTheme {
  data: ThemeData;
  presetId: string;
  colors: ThemeColors;
  ink: InkColors;
  /** true while an admin previews a theme that is not live */
  preview: boolean;
  /** the owner's layout changes (already applied to data.layout) */
  layoutOverrides?: LayoutOverrides;
}
