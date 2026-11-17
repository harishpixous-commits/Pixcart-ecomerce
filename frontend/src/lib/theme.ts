/** Turns the admin's hex colours into the CSS variables Tailwind reads. */

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [11, 85, 99];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (c: [number, number, number], target: number, t: number) => c.map((x) => Math.round(x + (target - x) * t)) as [number, number, number];
const triple = (c: [number, number, number]) => c.join(" ");

export interface SiteColors {
  primary: string;
  primary_dark: string;
  accent: string;
  buy: string;
  success: string;
  page: string;
}

export function themeCss(colors: Partial<SiteColors>, radius: string): string {
  const p = rgb(colors.primary ?? "#0B5563");
  const pd = rgb(colors.primary_dark ?? "#073B45");
  const a = rgb(colors.accent ?? "#F5A524");
  const b = rgb(colors.buy ?? "#D7263D");
  const s = rgb(colors.success ?? "#1E8E3E");
  const pg = rgb(colors.page ?? "#EEF2F4");
  const r = radius === "square" ? ["0.125rem", "0.25rem", "0.375rem"] : radius === "soft" ? ["0.75rem", "1.125rem", "1.5rem"] : ["0.5rem", "0.75rem", "1rem"];
  const vars: Record<string, string> = {
    "--c-primary": triple(p),
    "--c-primary-dark": triple(pd),
    "--c-primary-light": triple(mix(p, 255, 0.88)),
    "--c-accent": triple(a),
    "--c-accent-dark": triple(mix(a, 0, 0.12)),
    "--c-accent-light": triple(mix(a, 255, 0.85)),
    "--c-buy": triple(b),
    "--c-buy-dark": triple(mix(b, 0, 0.18)),
    "--c-buy-light": triple(mix(b, 255, 0.9)),
    "--c-success": triple(s),
    "--c-success-light": triple(mix(s, 255, 0.88)),
    "--c-page": triple(pg),
    "--r-lg": r[0],
    "--r-xl": r[1],
    "--r-2xl": r[2],
  };
  return `:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}`;
}
