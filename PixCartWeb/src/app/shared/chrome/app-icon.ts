/*
 * The install icons of the reference's /app-icon/[variant] route (frontend/src/app/app-icon/[variant]/route.tsx), drawn
 * in the browser (the Angular app has no image route): the store's primary colour with the accent wave, the brand's
 * initial in Baloo 2 ExtraBold and, for the partner app, a scooter badge. Same variants and the same geometry (drawn on
 * a 512 grid). appIcon("partner-192", site) resolves to a PNG data: URL for an <img>, or null for an unknown variant.
 */

import type { Site } from "../../core/types";

const VARIANTS = new Set(["192", "512", "maskable", "apple", "partner-192", "partner-512", "partner-maskable", "partner-apple"]);

/** the brand's display face (Baloo 2, weight 800), loaded once; the family to draw with */
let font: Promise<string> | null = null;
function brandFont(): Promise<string> {
  if (!font) {
    font = new FontFace("PcAppIconBrand", "url(/fonts/baloo-2-latin-800-normal.woff2)", { weight: "800", style: "normal" })
      .load()
      .then((f) => {
        document.fonts.add(f);
        return "PcAppIconBrand";
      })
      .catch(() => "sans-serif");
  }
  return font;
}

export async function appIcon(variant: string, site: Pick<Site, "brand_name" | "colors">): Promise<string | null> {
  if (!VARIANTS.has(variant)) return null;
  const family = await brandFont();
  const partner = variant.startsWith("partner-");
  // the iPhone icon is drawn like the maskable one (full-bleed, safe middle area), at Apple's 180 x 180
  const maskable = variant.endsWith("maskable") || variant.endsWith("apple");
  const size = variant.endsWith("192") ? 192 : variant.endsWith("apple") ? 180 : 512;
  const primary = site.colors?.primary || "#0B5563";
  const accent = site.colors?.accent || "#F5A524";
  const letter = (site.brand_name || "P").trim().charAt(0).toUpperCase() || "P";
  const s = size / 512; // drawn on a 512 grid
  // A maskable icon is cut to a circle or squircle by the phone: the letter and badge stay inside the middle 80%.
  const k = maskable ? 0.72 : 1;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  if (!g) return null;
  if (maskable) {
    g.fillStyle = primary;
    g.fillRect(0, 0, size, size);
  }
  const box = maskable ? size : size * 0.94;
  const off = (size - box) / 2;
  g.save();
  g.beginPath();
  g.roundRect(off, off, box, box, maskable ? 0 : size * 0.22);
  g.clip();
  g.fillStyle = primary;
  g.fillRect(off, off, box, box);

  // the wave: an svg as wide as the icon and 0.3 of its height (viewBox 512 x 154), at the box's bottom left
  const waveH = size * 0.3;
  const ws = Math.min(size / 512, waveH / 154);
  g.save();
  g.translate(off + (size - 512 * ws) / 2, off + box - waveH + (waveH - 154 * ws) / 2);
  g.scale(ws, ws);
  g.fillStyle = accent;
  g.fill(new Path2D("M0 40c32 0 32 44 64 44s32-44 64-44 32 44 64 44 32-44 64-44 32 44 64 44 32-44 64-44 32 44 64 44 32-44 64-44v114H0z"));
  g.restore();

  // the initial: a line box of 1em, centred in the box together with its margins
  const fontSize = 290 * k * s;
  const marginTop = -20 * k * s;
  const marginLeft = partner ? -36 * k * s : 0;
  g.font = `800 ${fontSize}px ${family}`;
  const m = g.measureText(letter);
  const left = off + (box - (m.width + marginLeft)) / 2 + marginLeft;
  const top = off + (box - (fontSize + marginTop)) / 2 + marginTop;
  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  g.fillStyle = "#fff";
  g.textBaseline = "alphabetic";
  g.fillText(letter, left, top + (fontSize - (ascent + descent)) / 2 + ascent);

  if (partner) {
    const badge = 150 * k * s;
    const inset = (maskable ? 107 : 40) * s;
    const bx = off + box - inset - badge;
    const by = off + inset;
    g.beginPath();
    g.arc(bx + badge / 2, by + badge / 2, badge / 2, 0, Math.PI * 2);
    g.fillStyle = "#fff";
    g.fill();
    // the scooter (a 24 x 24 icon at 64% of the badge)
    const icon = badge * 0.64;
    g.save();
    g.translate(bx + (badge - icon) / 2, by + (badge - icon) / 2);
    g.scale(icon / 24, icon / 24);
    g.strokeStyle = primary;
    g.lineWidth = 2.2;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.arc(5.5, 17.5, 3.5, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(18.5, 17.5, 3.5, 0, Math.PI * 2);
    g.stroke();
    g.stroke(new Path2D("M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5V14l-3-3 4-3 2 3h2"));
    g.restore();
  }
  g.restore();
  return canvas.toDataURL("image/png");
}
