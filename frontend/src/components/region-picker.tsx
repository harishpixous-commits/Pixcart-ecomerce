"use client";

/*
 * "Language and currency": the picker in the shop's account menu and footer, and (language only) in the seller hub,
 * delivery app and admin panel. Offered choices come from Admin → Languages and currencies.
 */

import clsx from "clsx";
import { Globe } from "lucide-react";
import { useState } from "react";
import { AcceptedPayments } from "@/components/pay-logos";
import { Button, Field, Modal, Select } from "@/components/ui";
import { currencyName, languageName, useRegional } from "@/lib/regional";

function symbolOf(code: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

/** Whether there is anything to pick (more than one language, or more than one currency on shop pages). */
export function useHasRegionChoice(languageOnly = false): boolean {
  const { data, shop } = useRegional();
  if (!data.show_switcher && shop) return false;
  return data.languages.length > 1 || (!languageOnly && shop && data.currencies.length > 1);
}

export function RegionDialog({ open, onClose, languageOnly = false }: { open: boolean; onClose: () => void; languageOnly?: boolean }) {
  const { data, currency, language, shop, setCurrency, setLanguage } = useRegional();
  const [lang, setLang] = useState(language);
  const [cur, setCur] = useState(currency);
  const showCurrency = !languageOnly && shop && data.currencies.length > 1;
  const save = () => {
    if (cur !== currency) document.cookie = `pc_cur=${cur}; path=/; max-age=31536000; samesite=lax`;
    if (lang !== language) setLanguage(lang);
    else if (cur !== currency) setCurrency(cur);
    else onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title={showCurrency ? "Language and currency" : "Language"}>
      <div className="flex flex-col gap-4" data-testid="region-dialog">
        {data.languages.length > 1 && (
          <Field label="Language" htmlFor="pick-lang">
            <Select id="pick-lang" value={lang} onChange={(e) => setLang(e.target.value)} translate="no">
              {data.languages.map((l) => <option key={l.code} value={l.code}>{languageName(l.code)}</option>)}
            </Select>
          </Field>
        )}
        {showCurrency && (
          <Field label="Currency" htmlFor="pick-cur"
            hint={data.charge_in === "base" ? "Prices are converted at today's rate as a guide. You pay in Indian rupees (₹); your bank converts it." : "Prices are converted at today's rate, and you pay in this currency."}>
            <Select id="pick-cur" value={cur} onChange={(e) => setCur(e.target.value)}>
              {data.currencies.map((c) => <option key={c.code} value={c.code}>{currencyName(c.code)}</option>)}
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} data-testid="region-save">Save</Button>
        </div>
      </div>
    </Modal>
  );
}

/** A small button: globe, language code and (on shop pages) the currency. */
export function RegionButton({ className, languageOnly = false, tone = "light" }: { className?: string; languageOnly?: boolean; tone?: "light" | "dark" }) {
  const { data, currency, language, shop } = useRegional();
  const [open, setOpen] = useState(false);
  const has = useHasRegionChoice(languageOnly);
  if (!has) return null;
  const showCur = !languageOnly && shop && data.currencies.length > 1;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="region-button" aria-label="Language and currency"
        className={clsx("inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold", tone === "dark" ? "text-white hover:bg-white/10" : "text-ink hover:bg-mist", className)}>
        <Globe className="h-4 w-4" aria-hidden />
        <span translate="no">{language.split("-")[0].toUpperCase()}</span>
        {showCur && <span translate="no" className="opacity-80">· {symbolOf(currency)} {currency}</span>}
      </button>
      {open && <RegionDialog open onClose={() => setOpen(false)} languageOnly={languageOnly} />}
    </>
  );
}

/** The shop's strip above the footer: the ways to pay, and the language and currency in use with a way to change them. */
export function RegionStrip() {
  const { data, currency, language } = useRegional();
  const [open, setOpen] = useState(false);
  const has = useHasRegionChoice();
  return (
    <div className="border-t border-line bg-white" data-testid="region-strip">
      <div className="mx-auto flex max-w-shop flex-col items-center justify-between gap-3 px-3 py-3 text-sm text-ink-soft sm:flex-row sm:px-4">
        <AcceptedPayments networks={data.card_networks} methods={data.pay_methods} cod label="Pay with" className="justify-center" />
        {has && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            <Globe className="h-4 w-4 text-peacock" aria-hidden />
            <span translate="no">{languageName(language, false)}</span>
            {data.currencies.length > 1 && <span translate="no">· {currencyName(currency)}</span>}
            <button type="button" onClick={() => setOpen(true)} className="font-semibold text-peacock hover:underline" data-testid="region-change">Change</button>
          </div>
        )}
      </div>
      {open && <RegionDialog open onClose={() => setOpen(false)} />}
    </div>
  );
}
