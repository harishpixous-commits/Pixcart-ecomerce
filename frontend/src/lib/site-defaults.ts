import type { Site } from "@/lib/types";

export const FALLBACK_SITE: Site = {
  // Shown only if the API cannot be reached; the real name comes from Admin → Storefront.
  brand_name: process.env.NEXT_PUBLIC_BRAND_NAME ?? "",
  tagline: "Shop from verified sellers across India",
  logo_url: "",
  favicon_url: "",
  colors: { primary: "#0B5563", primary_dark: "#073B45", accent: "#F5A524", buy: "#D7263D", success: "#1E8E3E", page: "#EEF2F4" },
  radius: "rounded",
  announcement: { enabled: false, text: "", link: "", tone: "accent" },
  header_links: [{ label: "Become a seller", href: "/sell" }],
  footer_columns: [],
  business: { legal_name: "", registered_address: "", gstin: "", cin: "", grievance: { name: "", designation: "", email: "", phone: "", hours: "" } },
  contact: { enabled: true, title: "Contact us", items: [] },
  social: { enabled: true, title: "Follow us", links: [] },
  footer: { show_business: true, show_contact: true, show_social: true, show_grievance: true, show_gstin: true, copyright: "© {year} {legal_name}" },
  seo: { title: process.env.NEXT_PUBLIC_BRAND_NAME ?? "", description: "" },
  analytics: { google_analytics_id: "", meta_pixel_id: "" },
  features: { wishlist: true, reviews: true, returns: true, coupons: true, support: true, ai: false },
  cod_enabled: true,
  free_shipping_threshold_paise: 49900,
  gallery: { zoom: true, zoom_level: 2.5, max_video_mb: 50, max_videos: 3 },
};

/** Fill any missing keys from the fallback, so an older or partial API answer never breaks rendering. */
export function withDefaults(raw: Partial<Site> | null | undefined): Site {
  if (!raw || typeof raw !== "object") return FALLBACK_SITE;
  const out = { ...FALLBACK_SITE } as Record<string, unknown>;
  for (const [k, v] of Object.entries(raw)) {
    const base = (FALLBACK_SITE as unknown as Record<string, unknown>)[k];
    if (v === undefined || v === null) continue;
    out[k] = base && typeof base === "object" && !Array.isArray(base) && typeof v === "object" && !Array.isArray(v) ? { ...base, ...v } : v;
  }
  return out as unknown as Site;
}

