/*
 * App icons for "install to home screen" (the shop and the delivery partner app), drawn in the store's own brand
 * colours and initial so they follow Admin → Storefront. Variants: 192, 512, maskable (full-bleed for Android's
 * shaped icons) and apple (180 x 180, full-bleed with no transparency, for the iPhone home screen, which rounds the
 * corners itself), each with a "partner-" form that carries a scooter badge.
 *   /app-icon/192  /app-icon/512  /app-icon/maskable  /app-icon/apple  (and partner-192, partner-512, partner-maskable, partner-apple)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { loadSiteServer } from "@/lib/server-api";

export const dynamic = "force-dynamic";

const VARIANTS = new Set(["192", "512", "maskable", "apple", "partner-192", "partner-512", "partner-maskable", "partner-apple"]);

// the brand's display face (Baloo 2, bold), read once
let font: Promise<Buffer | null> | null = null;
function brandFont() {
  if (!font) font = readFile(join(process.cwd(), "node_modules/@fontsource/baloo-2/files/baloo-2-latin-800-normal.woff")).catch(() => null);
  return font;
}

export async function GET(_req: Request, ctx: { params: Promise<{ variant: string }> }) {
  const { variant } = await ctx.params;
  if (!VARIANTS.has(variant)) return new Response("Not found", { status: 404 });
  const site = await loadSiteServer();
  const partner = variant.startsWith("partner-");
  // the iPhone icon is drawn like the maskable one (full-bleed, safe middle area), at Apple's 180 x 180
  const maskable = variant.endsWith("maskable") || variant.endsWith("apple");
  const size = variant.endsWith("192") ? 192 : variant.endsWith("apple") ? 180 : 512;
  const primary = site.colors.primary || "#0B5563";
  const accent = site.colors.accent || "#F5A524";
  const letter = (site.brand_name || "P").trim().charAt(0).toUpperCase() || "P";
  const s = size / 512; // drawn on a 512 grid
  const bold = await brandFont();
  // A maskable icon is cut to a circle or squircle by the phone: the letter and badge stay inside the middle 80%.
  const k = maskable ? 0.72 : 1;
  const badge = 150 * k * s;
  const inset = (maskable ? 107 : 40) * s;
  return new ImageResponse(
    (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: maskable ? primary : "transparent" }}>
        <div style={{ position: "relative", width: maskable ? size : size * 0.94, height: maskable ? size : size * 0.94, borderRadius: maskable ? 0 : size * 0.22,
          background: primary, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          <svg width={size} height={size * 0.3} viewBox="0 0 512 154" style={{ position: "absolute", bottom: 0, left: 0 }}>
            <path d="M0 40c32 0 32 44 64 44s32-44 64-44 32 44 64 44 32-44 64-44 32 44 64 44 32-44 64-44 32 44 64 44 32-44 64-44v114H0z" fill={accent} />
          </svg>
          <span style={{ color: "#fff", fontSize: 290 * k * s, fontWeight: 800, fontFamily: bold ? "Brand" : undefined, marginTop: -20 * k * s,
            marginLeft: partner ? -36 * k * s : 0, lineHeight: 1 }}>{letter}</span>
          {partner && (
            <div style={{ position: "absolute", right: inset, top: inset, width: badge, height: badge, borderRadius: 999,
              background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width={badge * 0.64} height={badge * 0.64} viewBox="0 0 24 24" fill="none" stroke={primary} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                <circle cx="5.5" cy="17.5" r="3.5" />
                <circle cx="18.5" cy="17.5" r="3.5" />
                <path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5V14l-3-3 4-3 2 3h2" />
              </svg>
            </div>
          )}
        </div>
      </div>
    ),
    {
      width: size,
      height: size,
      fonts: bold ? [{ name: "Brand", data: bold.buffer.slice(bold.byteOffset, bold.byteOffset + bold.byteLength) as ArrayBuffer, weight: 800, style: "normal" }] : undefined,
      headers: { "Cache-Control": "public, max-age=3600" },
    },
  );
}
