/* The delivery partner app as its own installable app (Add to Home screen), opening at /delivery. */

import { loadSiteServer } from "@/lib/server-api";

export const dynamic = "force-dynamic";

export async function GET() {
  const site = await loadSiteServer();
  const body = {
    name: `${site.brand_name} Partner`,
    short_name: "Partner",
    description: "Deliver orders near you and get paid every week.",
    id: "/delivery",
    start_url: "/delivery",
    scope: "/delivery",
    display: "standalone",
    orientation: "portrait",
    background_color: site.colors.page || "#EEF2F4",
    theme_color: site.colors.primary || "#0B5563",
    lang: "en-IN",
    categories: ["business", "productivity"],
    icons: [
      { src: "/app-icon/partner-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/partner-512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/partner-maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
