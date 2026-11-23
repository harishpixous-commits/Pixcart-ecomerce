import "@fontsource/mukta/400.css";
import "@fontsource/mukta/500.css";
import "@fontsource/mukta/600.css";
import "@fontsource/baloo-2/500.css";
import "@fontsource/baloo-2/600.css";
import "@fontsource/baloo-2/700.css";
// Storefront theme fonts (src/themes). Browsers download a font file only when a page uses it.
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";
import "@fontsource/playfair-display/500.css";
import "@fontsource/playfair-display/600.css";
import "@fontsource/playfair-display/700.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Suspense } from "react";
import { NavTracker } from "@/components/back-button";
import { RouteProgress } from "@/components/route-progress";
import { ToastProvider } from "@/components/ui";
import { loadSiteServer } from "@/lib/server-api";
import { SessionProvider } from "@/lib/session";
import { SiteProvider } from "@/lib/site";
import { WishlistProvider } from "@/lib/wishlist";
import { themeCss } from "@/lib/theme";
import type { Site } from "@/lib/types";

// Rendered per request so brand, colours and business details are always the saved ones, on every web
// server and right after a deploy (a build has no API to read them from).
export const dynamic = "force-dynamic";

const loadSite = loadSiteServer;

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  return {
    title: { default: site.seo.title || site.brand_name, template: `%s | ${site.brand_name}` },
    description: site.seo.description,
    metadataBase: new URL(process.env.PUBLIC_WEB_URL || "http://localhost:3000"),
    // iPhone and iPad: the home-screen icon and a full-screen app when added from Safari (the shop's app; see /app)
    icons: { ...(site.favicon_url ? { icon: site.favicon_url } : {}), apple: "/app-icon/apple" },
    appleWebApp: { capable: true, title: site.brand_name, statusBarStyle: "default" },
    openGraph: { siteName: site.brand_name, locale: "en_IN", type: "website" },
  };
}

export async function generateViewport(): Promise<Viewport> {
  const site = await loadSite();
  return { themeColor: site.colors.primary, width: "device-width", initialScale: 1 };
}

/** schema.org Organization for search engines: name, logo, contact and the enabled social profiles. */
function organizationJsonLd(site: Site): string {
  const url = process.env.PUBLIC_WEB_URL || "http://localhost:3000";
  const b = site.business;
  const phone = site.contact.enabled ? site.contact.items.find((i) => i.enabled && i.type === "phone")?.value : undefined;
  const email = site.contact.enabled ? site.contact.items.find((i) => i.enabled && i.type === "email")?.value : undefined;
  const data = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: site.brand_name,
    legalName: b.legal_name || undefined,
    url,
    logo: site.logo_url ? new URL(site.logo_url, url).toString() : undefined,
    address: b.registered_address || undefined,
    sameAs: site.social.enabled ? site.social.links.filter((l) => l.enabled && l.url).map((l) => l.url) : undefined,
    contactPoint: phone || email ? [{ "@type": "ContactPoint", contactType: "customer service", telephone: phone, email, areaServed: "IN" }] : undefined,
  };
  // Escape "<" so no value can close the script tag.
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const site = await loadSite();
  const ga = site.analytics.google_analytics_id;
  const pixel = site.analytics.meta_pixel_id;
  return (
    <html lang="en-IN">
      <head>
        <style dangerouslySetInnerHTML={{ __html: themeCss(site.colors, site.radius) }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: organizationJsonLd(site) }} />
      </head>
      <body>
        <SiteProvider site={site}>
          <NavTracker />
          <Suspense>
            <RouteProgress />
          </Suspense>
          <SessionProvider>
            <WishlistProvider>
              <ToastProvider>{children}</ToastProvider>
            </WishlistProvider>
          </SessionProvider>
        </SiteProvider>
        {/^G-[A-Z0-9]{4,12}$/.test(ga) && (
          <>
            <Script src={`https://www.googletagmanager.com/gtag/js?id=${ga}`} strategy="afterInteractive" />
            <Script id="ga" strategy="afterInteractive">{`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${ga}');`}</Script>
          </>
        )}
        {/^\d{6,20}$/.test(pixel) && (
          <Script id="meta-pixel" strategy="afterInteractive">{`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixel}');fbq('track','PageView');`}</Script>
        )}
      </body>
    </html>
  );
}
