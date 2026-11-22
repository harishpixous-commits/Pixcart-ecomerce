import { type NextRequest, NextResponse } from "next/server";
import { PREVIEW_COOKIE, cleanLayout, encodePreview, parsePairs } from "@/themes/manifest";
import { EDITABLE_COLORS, isThemeId } from "@/themes/types";

/**
 * Theme preview for this browser only:
 *   /theme-preview?theme=bazaar&preset=crimson[&primary=%23123456...][&layout=productGrid:cards,pdp:two][&to=/path]
 * sets a cookie that makes the shop render in that theme (with a bar to exit); ?theme=off clears it. Nothing is
 * saved and other visitors keep seeing the live theme. The cookie lasts two hours.
 */
export function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const to = q.get("to") ?? "/";
  // only paths on this site (no "//host" or "/\\host" redirects)
  const target = /^\/(?![/\\])[^\s]*$/.test(to) && !to.startsWith("/theme-preview") ? to : "/";
  const url = req.nextUrl.clone();
  const [path, search = ""] = target.split("?");
  url.pathname = path;
  url.search = search ? `?${search}` : "";
  const res = NextResponse.redirect(url);
  res.headers.set("Cache-Control", "no-store");
  const theme = q.get("theme");
  if (theme === "off" || !isThemeId(theme)) {
    res.cookies.delete(PREVIEW_COOKIE);
    return res;
  }
  const colors: Record<string, string> = {};
  for (const k of EDITABLE_COLORS) {
    const v = q.get(k);
    if (v) colors[k] = v.startsWith("#") ? v : `#${v}`;
  }
  const layout = cleanLayout(parsePairs(q.get("layout")));
  res.cookies.set(PREVIEW_COOKIE, encodePreview({ theme, preset: q.get("preset") ?? undefined, colors, layout }), {
    path: "/", maxAge: 2 * 60 * 60, sameSite: "lax", httpOnly: true, secure: req.nextUrl.protocol === "https:",
  });
  return res;
}
