/** Colour helpers shared by the brand colours (every portal) and the storefront themes (src/themes). */

export type RGB = [number, number, number];

export function rgb(hex: string, fallback: RGB = [11, 85, 99]): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const mix = (c: RGB, target: number, t: number) => c.map((x) => Math.round(x + (target - x) * t)) as RGB;
export const triple = (c: RGB) => c.join(" ");

/** WCAG relative luminance (0 black to 1 white). */
export function luminance(hex: string): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface SiteColors {
  primary: string;
  primary_dark: string;
  accent: string;
  buy: string;
  success: string;
  page: string;
}

export const DEFAULT_COLORS: SiteColors = { primary: "#0B5563", primary_dark: "#073B45", accent: "#F5A524", buy: "#D7263D", success: "#1E8E3E", page: "#EEF2F4" };

/** The six admin colours and their light and dark steps, as the "R G B" CSS variables Tailwind reads. */
export function colorVars(colors: Partial<SiteColors>): Record<string, string> {
  const c = { ...DEFAULT_COLORS, ...colors };
  const p = rgb(c.primary);
  const a = rgb(c.accent, [245, 165, 36]);
  const b = rgb(c.buy, [215, 38, 61]);
  const s = rgb(c.success, [30, 142, 62]);
  return {
    "--c-primary": triple(p),
    "--c-primary-dark": triple(rgb(c.primary_dark, [7, 59, 69])),
    "--c-primary-light": triple(mix(p, 255, 0.88)),
    "--c-accent": triple(a),
    "--c-accent-dark": triple(mix(a, 0, 0.12)),
    "--c-accent-light": triple(mix(a, 255, 0.85)),
    "--c-buy": triple(b),
    "--c-buy-dark": triple(mix(b, 0, 0.18)),
    "--c-buy-light": triple(mix(b, 255, 0.9)),
    "--c-success": triple(s),
    "--c-success-light": triple(mix(s, 255, 0.88)),
    "--c-page": triple(rgb(c.page, [238, 242, 244])),
  };
}

export type Radius = "square" | "rounded" | "soft";

export function radiusVars(radius: string): Record<string, string> {
  const r = radius === "square" ? ["0.125rem", "0.25rem", "0.375rem"] : radius === "soft" ? ["0.75rem", "1.125rem", "1.5rem"] : ["0.5rem", "0.75rem", "1rem"];
  return { "--r-lg": r[0], "--r-xl": r[1], "--r-2xl": r[2] };
}

export function cssBlock(selector: string, vars: Record<string, string>): string {
  // Values come from validated hex colours and fixed font/size tables; strip anything that could end the block.
  const body = Object.entries(vars).map(([k, v]) => `${k}:${String(v).replace(/[{}<>]/g, "")}`).join(";");
  return `${selector}{${body}}`;
}

/** Brand colours and corner style for the whole site (admin, seller hub, delivery app; the shop's themes override them). */
export function themeCss(colors: Partial<SiteColors>, radius: string): string {
  return cssBlock(":root", { ...colorVars(colors), ...radiusVars(radius) });
}
