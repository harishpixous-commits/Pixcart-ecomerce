/*
 * Theme preview for this browser only (port of app/theme-preview/route.ts):
 *   /theme-preview?theme=bazaar&preset=crimson[&primary=%23123456...][&layout=productGrid:cards,pdp:two][&to=/path]
 * sets a cookie that makes the shop render in that theme (with a bar to exit); ?theme=off clears it. Nothing is saved
 * and other visitors keep seeing the live theme. The cookie lasts two hours.
 *
 * Difference from the reference: a single-page app sets the cookie from the page, so it cannot be HttpOnly. It only
 * holds a theme name, a preset and colours (validated on read), never anything secret.
 */

import { inject } from "@angular/core";
import { Router, type CanActivateFn } from "@angular/router";
import { ThemeService } from "./context";
import { PREVIEW_COOKIE, cleanLayout, encodePreview, parsePairs } from "./manifest";
import { EDITABLE_COLORS, isThemeId } from "./types";

export const themePreviewGuard: CanActivateFn = (route) => {
  const router = inject(Router);
  const q = route.queryParamMap;
  const to = q.get("to") ?? "/";
  // only paths on this site (no "//host" or "/\\host" redirects)
  const target = /^\/(?![/\\])[^\s]*$/.test(to) && !to.startsWith("/theme-preview") ? to : "/";
  const secure = location.protocol === "https:" ? "; secure" : "";
  const theme = q.get("theme");
  if (theme === "off" || !isThemeId(theme)) {
    document.cookie = `${PREVIEW_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
  } else {
    const colors: Record<string, string> = {};
    for (const k of EDITABLE_COLORS) {
      const v = q.get(k);
      if (v) colors[k] = v.startsWith("#") ? v : `#${v}`;
    }
    const layout = cleanLayout(parsePairs(q.get("layout")));
    const value = encodePreview({ theme, preset: q.get("preset") ?? undefined, colors, layout });
    document.cookie = `${PREVIEW_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${2 * 60 * 60}; samesite=lax${secure}`;
  }
  inject(ThemeService).refreshPreview();
  return router.parseUrl(target);
};
