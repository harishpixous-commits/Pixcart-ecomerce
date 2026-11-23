/* Languages and currencies: what both the server (root layout) and the browser need. No React here. */

export type RegionalPublic = {
  base: string;
  currencies: { code: string; rate: number; digits: number }[];
  languages: { code: string; rtl: boolean }[];
  default_currency: string;
  default_language: string;
  charge_in: "base" | "shopper";
  show_switcher: boolean;
  country: string;
  suggest: { currency: string; language: string };
  card_networks: string[];
  pay_methods: Record<string, boolean>;
  rates_updated_at: string | null;
};

export const REGIONAL_FALLBACK: RegionalPublic = {
  base: "INR", currencies: [{ code: "INR", rate: 1, digits: 2 }], languages: [{ code: "en", rtl: false }], default_currency: "INR",
  default_language: "en", charge_in: "base", show_switcher: true, country: "", suggest: { currency: "INR", language: "en" },
  card_networks: ["visa", "mastercard", "rupay", "amex", "diners"], pay_methods: { upi: true, card: true, netbanking: true, wallet: true, emi: true, paylater: true },
  rates_updated_at: null,
};

export const LANG_COOKIE = "pc_lang";
export const CUR_COOKIE = "pc_cur";

/** The choice to use: the visitor's (when still offered), else the suggestion for their country, else the default. */
export function resolveChoice(data: RegionalPublic, cookieCurrency?: string, cookieLanguage?: string) {
  const cur = data.currencies.some((c) => c.code === cookieCurrency) ? cookieCurrency! : data.suggest.currency;
  const lang = data.languages.some((l) => l.code === cookieLanguage) ? cookieLanguage! : data.suggest.language;
  return { currency: cur, language: lang };
}
