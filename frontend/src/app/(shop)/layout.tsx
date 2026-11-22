import type { Viewport } from "next";
import { cookies } from "next/headers";
import { loadSiteServer } from "@/lib/server-api";
import { themeCssText } from "@/themes/css";
import { ThemeProvider } from "@/themes/context";
import { PREVIEW_COOKIE, decodePreview, resolveTheme, toState } from "@/themes/manifest";
import { ShopFrame } from "@/themes/shop-frame";

/**
 * Every shop page renders in the storefront theme chosen in Admin → Storefront → Theme and layout, or in the theme an
 * admin is previewing in this browser (/theme-preview sets a cookie; nobody else sees it).
 */
async function activeTheme() {
  const site = await loadSiteServer();
  const preview = decodePreview((await cookies()).get(PREVIEW_COOKIE)?.value);
  return { site, theme: resolveTheme(site, preview) };
}

export async function generateViewport(): Promise<Viewport> {
  const { theme } = await activeTheme();
  return { themeColor: theme.data.chrome === "light" ? "#FFFFFF" : theme.colors.primary, width: "device-width", initialScale: 1 };
}

export default async function ShopLayout({ children }: { children: React.ReactNode }) {
  const { site, theme } = await activeTheme();
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: themeCssText(theme, site.radius) }} />
      <ThemeProvider state={toState(theme)}>
        <ShopFrame>{children}</ShopFrame>
      </ThemeProvider>
    </>
  );
}
