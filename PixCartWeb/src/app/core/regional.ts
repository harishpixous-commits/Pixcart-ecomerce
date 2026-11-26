/*
 * The visitor's language and currency (Admin → Languages and currencies). Port of frontend/src/lib/regional.tsx.
 *
 * Loaded before the app renders (app.config.ts) with the visitor's choice (cookies pc_lang and pc_cur) or the
 * suggestion for their country, so amounts show in the right currency from the first paint. Shop pages show amounts in
 * that currency; the admin, seller and delivery panels always show rupees (the books). Every area is shown in the
 * chosen language (core/i18n.ts). Changing either reloads the page. useRegional() → inject(RegionalService).
 */

import { Injectable, computed, inject, signal } from "@angular/core";
import { GuardsCheckEnd, Router } from "@angular/router";
import { setDisplayCurrency } from "./format";
import { PageTranslator } from "./i18n";
import { CUR_COOKIE, LANG_COOKIE, REGIONAL_FALLBACK, resolveChoice, type RegionalPublic } from "./regional-shared";

export { CUR_COOKIE, LANG_COOKIE, REGIONAL_FALLBACK, type RegionalPublic };

const PANELS = /^\/(admin|seller|delivery)(\/|$)/;

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export function readCookie(name: string): string | undefined {
  const m = new RegExp(`(?:^|; )${name.replace(/[.$?*|{}()[\]\\/+^]/g, "\\$&")}=([^;]*)`).exec(document.cookie);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

@Injectable({ providedIn: "root" })
export class RegionalService {
  private readonly router = inject(Router);
  readonly data = signal<RegionalPublic>(REGIONAL_FALLBACK);
  readonly currency = signal("INR");
  readonly language = signal("en");
  private readonly path = signal(typeof location !== "undefined" ? location.pathname : "/");
  /** true on shop pages: amounts in the shopper's currency */
  readonly shop = computed(() => !PANELS.test(this.path()));
  private translator: PageTranslator | null = null;

  constructor() {
    // Before the next page's components render: rupees() everywhere uses this.
    this.router.events.subscribe((e) => {
      if (e instanceof GuardsCheckEnd) {
        this.path.set(new URL(e.urlAfterRedirects, "http://x").pathname);
        this.applyCurrency();
      }
    });
  }

  /** Reads /api/regional (the API takes the visitor's country from the hosting edge's header) and the visitor's cookies. */
  async load(): Promise<void> {
    let data: RegionalPublic | null = null;
    try {
      const res = await fetch("/api/regional?country=", { credentials: "same-origin" });
      if (res.ok) data = (await res.json()) as RegionalPublic;
    } catch {
      data = null;
    }
    const d = data ?? REGIONAL_FALLBACK;
    const choice = resolveChoice(d, readCookie(CUR_COOKIE), readCookie(LANG_COOKIE));
    this.data.set(d);
    this.currency.set(choice.currency);
    this.language.set(choice.language);
    const rtl = d.languages.find((l) => l.code === choice.language)?.rtl;
    document.documentElement.lang = choice.language === "en" ? "en-IN" : choice.language;
    document.documentElement.dir = rtl ? "rtl" : "ltr";
    this.applyCurrency();
  }

  private applyCurrency(): void {
    const info = this.data().currencies.find((c) => c.code === this.currency());
    setDisplayCurrency(this.shop() && info ? info : null);
  }

  /** Starts translating the page when a language other than English is chosen (after the first render). */
  startTranslator(): void {
    const language = this.language();
    if (this.translator || language === "en" || !this.data().languages.some((l) => l.code === language)) return;
    this.translator = new PageTranslator(language);
    this.translator.start();
  }

  setCurrency(code: string): void {
    setCookie(CUR_COOKIE, code);
    window.location.reload();
  }

  setLanguage(code: string): void {
    setCookie(LANG_COOKIE, code);
    window.location.reload();
  }
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
