/*
 * The active storefront theme. Port of frontend/src/themes/context.tsx: useTheme() → inject(ThemeService).active(),
 * useLayout() → inject(ThemeService).layout(). The shop frame switches it on (inShop) while a shop page is shown; outside
 * the shop (admin, seller hub, delivery app) the default theme is reported, so shared components still render.
 *
 * The theme comes from the saved settings (Admin → Storefront → Theme and layout) or from the preview cookie an admin
 * sets with /theme-preview (this browser only). The shop's theme CSS variables are added to <head> while in the shop
 * (":root:root", above the brand colours) and removed when leaving it, as the reference shop layout does.
 */

import { Injectable, computed, effect, inject, signal } from "@angular/core";
import { readCookie } from "../core/regional";
import { SiteService } from "../core/site";
import { themeCssText } from "./css";
import { PREVIEW_COOKIE, THEMES, decodePreview, resolveTheme } from "./manifest";
import { DEFAULT_THEME, type ActiveTheme, type ThemeLayout } from "./types";

const fallback: ActiveTheme = {
  data: THEMES[DEFAULT_THEME],
  presetId: THEMES[DEFAULT_THEME].presets[0].id,
  colors: THEMES[DEFAULT_THEME].presets[0].colors,
  ink: THEMES[DEFAULT_THEME].tokens.ink,
  preview: false,
};

@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly site = inject(SiteService).site;
  /** true while a shop page is shown (set by the shop frame) */
  readonly inShop = signal(false);
  /** bumped when the preview cookie changes */
  private readonly cookieTick = signal(0);
  /** the theme the shop renders (live or previewed), with the owner's layout changes applied */
  readonly shopTheme = computed<ActiveTheme>(() => {
    this.cookieTick();
    return resolveTheme(this.site(), decodePreview(readCookie(PREVIEW_COOKIE)));
  });
  readonly active = computed<ActiveTheme>(() => (this.inShop() ? this.shopTheme() : fallback));
  readonly layout = computed<ThemeLayout>(() => this.active().data.layout);

  constructor() {
    effect(() => {
      const on = this.inShop();
      const css = on ? themeCssText(this.shopTheme(), this.site().radius) : "";
      let tag = document.getElementById("pc-shop-theme") as HTMLStyleElement | null;
      if (!on) {
        tag?.remove();
      } else {
        if (!tag) {
          tag = document.createElement("style");
          tag.id = "pc-shop-theme";
          document.head.appendChild(tag);
        }
        tag.textContent = css;
      }
      const t = this.shopTheme();
      const meta = document.querySelector('meta[name="theme-color"]');
      meta?.setAttribute("content", on ? (t.data.chrome === "light" ? "#FFFFFF" : t.colors.primary) : this.site().colors.primary);
    });
  }

  /** Re-reads the preview cookie (after /theme-preview changed it). */
  refreshPreview(): void {
    this.cookieTick.update((n) => n + 1);
  }
}
