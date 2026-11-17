import "server-only";
import { cache } from "react";

const ORIGIN = process.env.API_ORIGIN || "http://localhost:8000";

/**
 * Server-side fetch for public data (SEO pages). Returns null on 404.
 * revalidate = seconds the response may be reused by this server; 0 = always ask the API (used for anything
 * admins edit, so a change shows at once on every web server).
 */
export async function serverGet<T>(path: string, revalidate = 60): Promise<T | null> {
  const res = await fetch(`${ORIGIN}${path}`, revalidate > 0 ? { next: { revalidate } } : { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The storefront settings (brand, theme, menus, business details) for server components, with safe defaults.
 * Read fresh on every request (a single-row read on the API) and shared by everything rendered in that request.
 */
export const loadSiteServer = cache(async () => {
  const { withDefaults } = await import("@/lib/site-defaults");
  type S = import("@/lib/types").Site;
  return withDefaults(await serverGet<Partial<S>>("/api/site", 0).catch(() => null));
});
