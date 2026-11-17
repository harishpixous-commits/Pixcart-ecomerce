import type { MetadataRoute } from "next";
import { serverGet } from "@/lib/server-api";
import type { CategoryNode, SearchResult } from "@/lib/types";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.PUBLIC_WEB_URL || "http://localhost:3000";
  const out: MetadataRoute.Sitemap = [{ url: base, changeFrequency: "daily", priority: 1 }];
  try {
    const cats = (await serverGet<CategoryNode[]>("/api/catalog/categories", 3600)) ?? [];
    const walk = (c: CategoryNode) => {
      out.push({ url: `${base}/c/${c.slug}`, changeFrequency: "daily", priority: 0.7 });
      c.children.forEach(walk);
    };
    cats.forEach(walk);
    for (let page = 1; page <= 50; page++) {
      const r = await serverGet<SearchResult>(`/api/catalog/products?sort=newest&page_size=60&page=${page}`, 3600);
      if (!r || !r.items.length) break;
      r.items.forEach((p) => out.push({ url: `${base}/p/${p.slug}`, changeFrequency: "weekly", priority: 0.6 }));
      if (page * 60 >= r.total) break;
    }
  } catch {
    /* API unreachable at build time: serve the home entry only */
  }
  return out;
}
