/*
 * What the reference root layout (app/layout.tsx) puts in <head>: the brand colours and corner style as CSS variables
 * (themeCss), the page title, description, favicon, theme colour, the schema.org Organization, and the analytics tags
 * the owner set (Google Analytics, Meta pixel).
 */

import { themeCss } from "./theme";
import type { Site } from "./types";

function headTag<K extends keyof HTMLElementTagNameMap>(tag: K, id: string): HTMLElementTagNameMap[K] {
  let el = document.getElementById(id) as HTMLElementTagNameMap[K] | null;
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    document.head.appendChild(el);
  }
  return el;
}

function meta(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

/** schema.org Organization for search engines: name, logo, contact and the enabled social profiles. */
function organizationJsonLd(site: Site): string {
  const url = window.location.origin;
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
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

let brandName = "";
let defaultTitle = "";

export function applyBrand(site: Site): void {
  headTag("style", "pc-brand").textContent = themeCss(site.colors, site.radius);
  const ld = headTag("script", "pc-org");
  ld.type = "application/ld+json";
  ld.textContent = organizationJsonLd(site);
  brandName = site.brand_name;
  defaultTitle = site.seo.title || site.brand_name;
  document.title = defaultTitle;
  meta("description", site.seo.description);
  meta("theme-color", site.colors.primary);
  meta("apple-mobile-web-app-title", site.brand_name);
  if (site.favicon_url) {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.appendChild(icon);
    }
    icon.href = site.favicon_url;
  }
  const ga = site.analytics.google_analytics_id;
  if (/^G-[A-Z0-9]{4,12}$/.test(ga)) {
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${ga}`;
    document.body.appendChild(s);
    const init = document.createElement("script");
    init.textContent = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${ga}');`;
    document.body.appendChild(init);
  }
  const pixel = site.analytics.meta_pixel_id;
  if (/^\d{6,20}$/.test(pixel)) {
    const s = document.createElement("script");
    s.textContent = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixel}');fbq('track','PageView');`;
    document.body.appendChild(s);
  }
}

/**
 * A page's title, like Next's metadata title template "%s | Brand" (null: the site's default title).
 * Routes can also set `title` in app.routes.ts; core/title-strategy.ts applies the same template.
 */
export function setPageTitle(title: string | null): void {
  document.title = title ? `${title} | ${brandName}` : defaultTitle;
}
