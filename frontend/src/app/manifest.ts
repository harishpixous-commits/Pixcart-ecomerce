import type { MetadataRoute } from "next";
import { loadSiteServer } from "@/lib/server-api";

// The shop as an installable app (Add to Home screen), in the store's own name and colours. The delivery partner app
// has its own manifest (app/delivery/manifest.webmanifest) so it installs as a separate app.
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const site = await loadSiteServer();
  return {
    name: site.brand_name,
    short_name: site.brand_name.slice(0, 12),
    description: site.seo.description || `Shop on ${site.brand_name}`,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: site.colors.page || "#EEF2F4",
    theme_color: site.colors.primary || "#0B5563",
    lang: "en-IN",
    categories: ["shopping"],
    icons: [
      { src: "/app-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app-icon/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
