"use client";

/*
 * The visitor's language and currency (Admin → Languages and currencies).
 *
 * The root layout reads the visitor's choice (cookies pc_lang and pc_cur) or, on a first visit, the suggestion for their
 * country, so the page is rendered on the server in the right currency (no flash of rupees). Shop pages show amounts
 * in that currency; the admin, seller and delivery panels always show rupees (the books). Every area is shown in the
 * chosen language (lib/i18n.ts). Changing either reloads the page.
 */

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo } from "react";
import { setDisplayCurrency } from "./format";
import { PageTranslator } from "./i18n";
import { CUR_COOKIE, LANG_COOKIE, REGIONAL_FALLBACK, type RegionalPublic } from "./regional-shared";

export { CUR_COOKIE, LANG_COOKIE, REGIONAL_FALLBACK, type RegionalPublic };

type Ctx = {
  data: RegionalPublic;
  currency: string;
  language: string;
  /** true on shop pages: amounts in the shopper's currency */
  shop: boolean;
  setCurrency: (code: string) => void;
  setLanguage: (code: string) => void;
};

const RegionalCtx = createContext<Ctx>({
  data: REGIONAL_FALLBACK, currency: "INR", language: "en", shop: true, setCurrency: () => {}, setLanguage: () => {},
});

const PANELS = /^\/(admin|seller|delivery)(\/|$)/;

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export function RegionalProvider({ data, currency, language, children }: { data: RegionalPublic; currency: string; language: string; children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const shop = !PANELS.test(pathname);
  const info = data.currencies.find((c) => c.code === currency);
  // Before anything below renders: rupees() everywhere uses this.
  setDisplayCurrency(shop && info ? info : null);

  useEffect(() => {
    if (language === "en" || !data.languages.some((l) => l.code === language)) return;
    const t = new PageTranslator(language);
    t.start();
    return () => t.stop();
  }, [language, data.languages]);

  const value = useMemo<Ctx>(() => ({
    data, currency, language, shop,
    setCurrency: (code) => { setCookie(CUR_COOKIE, code); window.location.reload(); },
    setLanguage: (code) => { setCookie(LANG_COOKIE, code); window.location.reload(); },
  }), [data, currency, language, shop]);
  return <RegionalCtx.Provider value={value}>{children}</RegionalCtx.Provider>;
}

export function useRegional() {
  return useContext(RegionalCtx);
}

/** "English", "தமிழ் (Tamil)": a language in its own words, with the English name for others. */
export function languageName(code: string, withEnglish = true): string {
  try {
    const own = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    const en = new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
    const cap = own.charAt(0).toLocaleUpperCase(code) + own.slice(1);
    return withEnglish && en !== own ? `${cap} (${en})` : cap;
  } catch {
    return code;
  }
}

/** "US Dollar (USD $)". */
export function currencyName(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
    const sym = new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0)
      .find((p) => p.type === "currency")?.value;
    return `${name} (${code}${sym && sym !== code ? ` ${sym}` : ""})`;
  } catch {
    return code;
  }
}
