import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.PUBLIC_WEB_URL || "http://localhost:3000";
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/seller", "/admin", "/checkout", "/cart", "/orders", "/account", "/api"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
