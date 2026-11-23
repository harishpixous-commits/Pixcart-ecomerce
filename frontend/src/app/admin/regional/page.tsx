"use client";

/*
 * Admin → Languages and currencies.
 *
 *  Currencies    which currencies shoppers can pick, their rates (typed, or updated daily), a conversion charge, and
 *                whether Razorpay charges the shopper's currency or always rupees. The books always stay in rupees.
 *  Languages     which languages the site (shop, seller hub, delivery app, admin panel) can be shown in.
 *  Regions       a visitor's country → their first currency and language.
 *  Payments      the ways to pay Razorpay offers, the card logos shown, and saved cards.
 *  Translations  every translated line, to check and correct.
 */

import clsx from "clsx";
import { Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AcceptedPayments, NETWORK_NAMES, PayLogo } from "@/components/pay-logos";
import { PageHeader } from "@/components/portal-shell";
import { Button, ErrorNote, Field, Input, PageLoader, Pill, Select, TextField, useToast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { currencyName, languageName } from "@/lib/regional";

type Cur = { code: string; rate: string; enabled: boolean; auto: boolean };
type Lang = { code: string; enabled: boolean };
type Region = { country: string; currency: string; language: string };
type Cfg = {
  currencies: Cur[]; default_currency: string; markup_bps: number; charge_in: "base" | "shopper"; auto_rates: boolean;
  rates_updated_at: string | null; rates_source: string;
  languages: Lang[]; default_language: string; ai_translate: boolean; ai_translate_daily_max: number; show_switcher: boolean; detect_region: boolean;
  regions: Region[]; pay_methods: Record<string, boolean>; card_networks: string[]; save_cards: boolean;
  popular_currencies: string[]; popular_languages: string[]; pay_method_keys: string[]; card_network_keys: string[];
  translation_counts: Record<string, number>; ai_ready: boolean;
};

const TABS = ["Currencies", "Languages", "Regions", "Payments", "Translations"] as const;
type Tab = (typeof TABS)[number];
const PAY_LABEL: Record<string, string> = { upi: "UPI (Google Pay, PhonePe, Paytm, BHIM and all UPI apps)", card: "Credit and debit cards", netbanking: "Net banking", wallet: "Wallets", emi: "EMI", paylater: "Pay later" };

function countryName(code: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code; } catch { return code; }
}

function Check({ checked, onChange, label, hint, testId }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: string; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-mist">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-peacock" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span><span className="font-medium">{label}</span>{hint && <span className="block text-sm text-ink-soft">{hint}</span>}</span>
    </label>
  );
}

export default function RegionalSettings() {
  const toast = useToast();
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [tab, setTab] = useState<Tab>("Currencies");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { api<Cfg>("/api/admin/regional").then(setCfg).catch((e) => setError(e.message)); }, []);
  const change = (patch: Partial<Cfg>) => { setCfg((c) => (c ? { ...c, ...patch } : c)); setDirty(true); };

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        currencies: cfg.currencies, default_currency: cfg.default_currency, markup_bps: cfg.markup_bps, charge_in: cfg.charge_in, auto_rates: cfg.auto_rates,
        languages: cfg.languages, default_language: cfg.default_language, ai_translate: cfg.ai_translate, ai_translate_daily_max: cfg.ai_translate_daily_max,
        show_switcher: cfg.show_switcher, detect_region: cfg.detect_region, regions: cfg.regions,
        pay_methods: cfg.pay_methods, card_networks: cfg.card_networks, save_cards: cfg.save_cards,
      };
      setCfg(await api<Cfg>("/api/admin/regional", { method: "PUT", body }));
      setDirty(false);
      toast("Saved. Shoppers see the change on their next page.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function refreshRates() {
    setBusy(true);
    try {
      const r = await api<Cfg & { message: string; changed: boolean }>("/api/admin/regional/rates", { method: "POST" });
      setCfg(r);
      toast(r.message, r.changed ? "ok" : "error");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not update the rates", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!cfg) return error ? <ErrorNote message={error} /> : <PageLoader />;
  return (
    <div className="flex flex-col gap-4 pb-24">
      <PageHeader title="Languages and currencies" sub="What shoppers can switch to, how they pay, and the site in other languages" />
      <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl bg-white p-1" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={clsx("shrink-0 rounded-lg px-3 py-2 text-sm font-semibold", tab === t ? "bg-peacock text-white" : "text-ink-soft hover:bg-mist")}>{t}</button>
        ))}
      </div>
      <ErrorNote message={error} />
      {tab === "Currencies" && <Currencies cfg={cfg} change={change} refreshRates={refreshRates} busy={busy} />}
      {tab === "Languages" && <Languages cfg={cfg} change={change} />}
      {tab === "Regions" && <Regions cfg={cfg} change={change} />}
      {tab === "Payments" && <Payments cfg={cfg} change={change} />}
      {tab === "Translations" && <Translations cfg={cfg} />}
      {tab !== "Translations" && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-end gap-3">
            {dirty && <span className="text-sm text-ink-soft">Unsaved changes</span>}
            <Button onClick={save} loading={busy} disabled={!dirty} data-testid="regional-save">Save changes</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Currencies({ cfg, change, refreshRates, busy }: { cfg: Cfg; change: (p: Partial<Cfg>) => void; refreshRates: () => void; busy: boolean }) {
  const [adding, setAdding] = useState("");
  const have = new Set(cfg.currencies.map((c) => c.code));
  const set = (code: string, patch: Partial<Cur>) => change({ currencies: cfg.currencies.map((c) => (c.code === code ? { ...c, ...patch } : c)) });
  const add = (code: string) => {
    const c = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c) || have.has(c)) return;
    change({ currencies: [...cfg.currencies, { code: c, rate: "", enabled: true, auto: true }] });
    setAdding("");
  };
  const sample = 49900; // ₹499
  return (
    <>
      <section className="rounded-xl bg-white p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">Currencies shoppers can pick</h2>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={refreshRates} loading={busy}><RefreshCw className="h-4 w-4" /> Update rates now</Button>
        </div>
        <p className="mb-3 text-sm text-ink-soft">
          Rate = how much of the currency one rupee buys (₹1 = $0.012 means a ₹499 item shows as about $5.99). &quot;Daily&quot; rates update by themselves
          {cfg.rates_updated_at ? `; last updated ${dateTime(cfg.rates_updated_at)}${cfg.rates_source ? ` from ${cfg.rates_source}` : ""}` : ""}.
          Prices, GST, commissions and payouts always stay in rupees.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-ink-soft"><th className="py-2">Currency</th><th>On</th><th>Rate per ₹1</th><th>Daily</th><th>₹499 shows as</th><th /></tr></thead>
            <tbody>
              {cfg.currencies.map((c) => {
                let preview = "";
                const rate = Number(c.rate);
                if (rate > 0) {
                  try {
                    preview = new Intl.NumberFormat("en-US", { style: "currency", currency: c.code, currencyDisplay: "narrowSymbol" }).format((sample / 100) * rate * (1 + cfg.markup_bps / 10000));
                  } catch { preview = `${c.code} ${((sample / 100) * rate).toFixed(2)}`; }
                }
                const base = c.code === "INR";
                return (
                  <tr key={c.code} className="border-t border-line" data-testid={`cur-${c.code}`}>
                    <td className="py-2 pr-2 font-medium" translate="no">{currencyName(c.code)}</td>
                    <td><input type="checkbox" className="h-4 w-4 accent-peacock" checked={c.enabled} disabled={base} onChange={(e) => set(c.code, { enabled: e.target.checked })} aria-label={`Offer ${c.code}`} /></td>
                    <td className="pr-2"><Input value={base ? "1" : c.rate} disabled={base || c.auto} inputMode="decimal" className="w-32" aria-label={`${c.code} rate`}
                      onChange={(e) => set(c.code, { rate: e.target.value.replace(/[^0-9.]/g, "") })} /></td>
                    <td><input type="checkbox" className="h-4 w-4 accent-peacock" checked={c.auto} disabled={base} onChange={(e) => set(c.code, { auto: e.target.checked })} aria-label={`Update ${c.code} daily`} /></td>
                    <td className="tabular-nums" translate="no">{base ? "₹499" : preview || "—"}</td>
                    <td>{!base && <button type="button" onClick={() => change({ currencies: cfg.currencies.filter((x) => x.code !== c.code), regions: cfg.regions.filter((r) => r.currency !== c.code) })} aria-label={`Remove ${c.code}`} className="rounded p-1 text-ink-soft hover:bg-mist"><Trash2 className="h-4 w-4" /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Add a currency" htmlFor="add-cur" className="min-w-[16rem]">
            <Select id="add-cur" value="" onChange={(e) => add(e.target.value)}>
              <option value="">Choose…</option>
              {cfg.popular_currencies.filter((c) => !have.has(c)).map((c) => <option key={c} value={c}>{currencyName(c)}</option>)}
            </Select>
          </Field>
          <TextField label="or any code" value={adding} onChange={(e) => setAdding(e.target.value.toUpperCase().slice(0, 3))} placeholder="e.g. NPR" className="w-28" />
          <Button variant="secondary" onClick={() => add(adding)} disabled={!/^[A-Z]{3}$/.test(adding)}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </section>
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 className="text-lg font-semibold sm:col-span-2">How shoppers pay</h2>
        <Field label="Charge online payments in" htmlFor="charge-in" className="sm:col-span-2"
          hint={cfg.charge_in === "shopper" ? "Razorpay charges the shopper's currency. Switch on International payments in your Razorpay account first (Razorpay Dashboard → Account and settings). Cash on delivery is always in rupees." : "Other currencies are shown as a guide; Razorpay charges rupees and the shopper's bank converts."}>
          <Select id="charge-in" value={cfg.charge_in} onChange={(e) => change({ charge_in: e.target.value as Cfg["charge_in"] })}>
            <option value="base">Always Indian rupees (₹)</option>
            <option value="shopper">The shopper&apos;s currency (Razorpay international payments)</option>
          </Select>
        </Field>
        <Field label="Default currency" htmlFor="def-cur" hint="For visitors whose country has no rule (Regions)">
          <Select id="def-cur" value={cfg.default_currency} onChange={(e) => change({ default_currency: e.target.value })}>
            {cfg.currencies.filter((c) => c.enabled).map((c) => <option key={c.code} value={c.code}>{currencyName(c.code)}</option>)}
          </Select>
        </Field>
        <TextField label="Conversion charge (%)" inputMode="decimal" value={String(cfg.markup_bps / 100)} hint="Added to converted prices, 0 to 10. Covers bank conversion costs."
          onChange={(e) => change({ markup_bps: Math.round(Math.min(10, Math.max(0, Number(e.target.value) || 0)) * 100) })} />
        <Check checked={cfg.auto_rates} onChange={(v) => change({ auto_rates: v })} label="Update &quot;Daily&quot; rates automatically" hint="From a free exchange-rate service, once a day" />
        <Check checked={cfg.show_switcher} onChange={(v) => change({ show_switcher: v })} label="Show the language and currency picker in the shop" hint="In the account menu and above the footer" />
      </section>
    </>
  );
}

function Languages({ cfg, change }: { cfg: Cfg; change: (p: Partial<Cfg>) => void }) {
  const have = new Set(cfg.languages.map((l) => l.code));
  const [code, setCode] = useState("");
  const add = (c: string) => {
    const v = c.trim();
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v) || have.has(v)) return;
    change({ languages: [...cfg.languages, { code: v, enabled: true }] });
    setCode("");
  };
  return (
    <>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Languages</h2>
        <p className="mb-3 text-sm text-ink-soft">
          Shoppers, sellers, delivery partners and staff each pick their language (globe button). Every page is translated: the first time a line is
          seen it is translated by the AI and kept, and you can correct any line under Translations.
        </p>
        {!cfg.ai_ready && (
          <p className="mb-3 rounded-lg bg-marigold-light px-3 py-2 text-sm">
            No AI model is connected, so new lines stay in English until you translate them under Translations. Connect one in Admin → AI providers
            (route &quot;Translating the site&quot;) to translate automatically.
          </p>
        )}
        <ul className="grid gap-1 sm:grid-cols-2" translate="no">
          {cfg.languages.map((l) => (
            <li key={l.code} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-mist">
              <input type="checkbox" className="h-4 w-4 accent-peacock" checked={l.enabled} disabled={l.code === "en"} aria-label={`Offer ${l.code}`}
                onChange={(e) => change({ languages: cfg.languages.map((x) => (x.code === l.code ? { ...x, enabled: e.target.checked } : x)) })} />
              <span className="flex-1">{languageName(l.code)}</span>
              <span className="text-xs text-ink-faint">{l.code === "en" ? "the site's own text" : `${cfg.translation_counts[l.code] ?? 0} lines`}</span>
              {l.code !== "en" && <button type="button" onClick={() => change({ languages: cfg.languages.filter((x) => x.code !== l.code), regions: cfg.regions.filter((r) => r.language !== l.code) })} aria-label={`Remove ${l.code}`} className="rounded p-1 text-ink-soft hover:bg-white"><Trash2 className="h-4 w-4" /></button>}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Add a language" htmlFor="add-lang" className="min-w-[16rem]">
            <Select id="add-lang" value="" onChange={(e) => add(e.target.value)} translate="no">
              <option value="">Choose…</option>
              {cfg.popular_languages.filter((c) => !have.has(c)).map((c) => <option key={c} value={c}>{languageName(c)}</option>)}
            </Select>
          </Field>
          <TextField label="or any code" value={code} onChange={(e) => setCode(e.target.value.slice(0, 12))} placeholder="e.g. pt-BR" className="w-32" />
          <Button variant="secondary" onClick={() => add(code)}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </section>
      <section className="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <Field label="Default language" htmlFor="def-lang" hint="For visitors whose country has no rule">
          <Select id="def-lang" value={cfg.default_language} onChange={(e) => change({ default_language: e.target.value })} translate="no">
            {cfg.languages.filter((l) => l.enabled).map((l) => <option key={l.code} value={l.code}>{languageName(l.code)}</option>)}
          </Select>
        </Field>
        <TextField label="AI translations per day (most)" inputMode="numeric" value={String(cfg.ai_translate_daily_max)} hint="New lines only; known lines are free"
          onChange={(e) => change({ ai_translate_daily_max: Math.max(0, Math.min(100000, Number(e.target.value.replace(/\D/g, "")) || 0)) })} />
        <Check checked={cfg.ai_translate} onChange={(v) => change({ ai_translate: v })} label="Translate new lines with the AI" hint="Off: only lines you translated are shown in other languages" />
      </section>
    </>
  );
}

function Regions({ cfg, change }: { cfg: Cfg; change: (p: Partial<Cfg>) => void }) {
  const [country, setCountry] = useState("");
  const set = (i: number, patch: Partial<Region>) => change({ regions: cfg.regions.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <section className="rounded-xl bg-white p-5">
      <h2 className="mb-1 text-lg font-semibold">Regions</h2>
      <p className="mb-3 text-sm text-ink-soft">On their first visit, a shopper from a country below sees its currency and language. They can always change it.</p>
      <Check checked={cfg.detect_region} onChange={(v) => change({ detect_region: v })} label="Pick currency and language from the visitor's country" hint="The country comes from the hosting service (Vercel); nothing is asked or stored" />
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead><tr className="text-left text-ink-soft"><th className="py-2">Country</th><th>Currency</th><th>Language</th><th /></tr></thead>
          <tbody>
            {cfg.regions.map((r, i) => (
              <tr key={r.country} className="border-t border-line">
                <td className="py-2 font-medium">{countryName(r.country)} <span className="text-ink-faint" translate="no">({r.country})</span></td>
                <td className="pr-2"><Select value={r.currency} onChange={(e) => set(i, { currency: e.target.value })} aria-label={`${r.country} currency`}>{cfg.currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</Select></td>
                <td className="pr-2"><Select value={r.language} onChange={(e) => set(i, { language: e.target.value })} aria-label={`${r.country} language`} translate="no">{cfg.languages.map((l) => <option key={l.code} value={l.code}>{languageName(l.code, false)}</option>)}</Select></td>
                <td><button type="button" onClick={() => change({ regions: cfg.regions.filter((_, j) => j !== i) })} aria-label={`Remove ${r.country}`} className="rounded p-1 text-ink-soft hover:bg-mist"><Trash2 className="h-4 w-4" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <TextField label="Country code" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2))} placeholder="e.g. SG" className="w-32"
          hint={country.length === 2 ? countryName(country) : "2 letters"} />
        <Button variant="secondary" disabled={country.length !== 2 || cfg.regions.some((r) => r.country === country)}
          onClick={() => { change({ regions: [...cfg.regions, { country, currency: cfg.default_currency, language: cfg.default_language }] }); setCountry(""); }}>
          <Plus className="h-4 w-4" /> Add region
        </Button>
      </div>
    </section>
  );
}

function Payments({ cfg, change }: { cfg: Cfg; change: (p: Partial<Cfg>) => void }) {
  return (
    <>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Ways to pay online</h2>
        <p className="mb-2 text-sm text-ink-soft">What Razorpay&apos;s payment window offers. Methods must also be active in your Razorpay account.</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {cfg.pay_method_keys.map((m) => (
            <Check key={m} checked={cfg.pay_methods[m] !== false} testId={`pay-${m}`} label={<span className="inline-flex items-center gap-2"><PayLogo name={m === "card" ? "visa" : m} /> {PAY_LABEL[m] ?? m}</span>}
              onChange={(v) => change({ pay_methods: { ...cfg.pay_methods, [m]: v } })} />
          ))}
        </div>
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Card logos shown</h2>
        <p className="mb-2 text-sm text-ink-soft">Shown at checkout as &quot;We accept&quot;. Show only the networks your Razorpay account accepts.</p>
        <div className="grid gap-1 sm:grid-cols-2">
          {cfg.card_network_keys.map((n) => (
            <Check key={n} checked={cfg.card_networks.includes(n)} label={<span className="inline-flex items-center gap-2"><PayLogo name={n} /> {NETWORK_NAMES[n] ?? n}</span>}
              onChange={(v) => change({ card_networks: v ? [...cfg.card_networks, n] : cfg.card_networks.filter((x) => x !== n) })} />
          ))}
        </div>
        <div className="mt-3 rounded-lg bg-mist p-3"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Preview</p><AcceptedPayments networks={cfg.card_networks} methods={cfg.pay_methods} /></div>
      </section>
      <section className="rounded-xl bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">Saved cards</h2>
        <Check checked={cfg.save_cards} onChange={(v) => change({ save_cards: v })} label="Let shoppers save cards for faster checkout"
          hint="Razorpay asks the shopper in its payment window and saves the card as an RBI-approved token; no card number is stored on this site. Shoppers see and remove saved cards under Account. Each payment is still confirmed with the CVV and the bank's OTP, as RBI requires." />
        <p className="mt-2 rounded-lg bg-mist px-3 py-2 text-sm text-ink-soft">
          Scanning a card with the camera: on phones, Chrome (Android) and Safari (iPhone) offer &quot;Scan card&quot; on the card number box in the
          payment window, which fills the number and expiry. Card details are typed only inside Razorpay&apos;s secure window, never on this site.
        </p>
      </section>
    </>
  );
}

type TrRow = { id: string; source: string; text: string; origin: "ai" | "manual"; updated_at: string };

function Translations({ cfg }: { cfg: Cfg }) {
  const toast = useToast();
  const langs = cfg.languages.filter((l) => l.code !== "en");
  const [lang, setLang] = useState(langs[0]?.code ?? "");
  const [q, setQ] = useState("");
  const [origin, setOrigin] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<{ total: number; items: TrRow[] } | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newSrc, setNewSrc] = useState("");
  const [newText, setNewText] = useState("");

  const load = useCallback(() => {
    if (!lang) return;
    const qs = new URLSearchParams({ lang, q, origin, page: String(page) });
    api<{ total: number; items: TrRow[] }>(`/api/admin/translations?${qs}`).then(setRows).catch(() => setRows({ total: 0, items: [] }));
  }, [lang, q, origin, page]);
  useEffect(() => { const t = window.setTimeout(load, 250); return () => window.clearTimeout(t); }, [load]);

  async function saveLine(source: string, text: string) {
    try {
      await api("/api/admin/translations", { method: "PUT", body: { lang, source, text } });
      toast("Saved");
      load();
    } catch (e) { toast(e instanceof ApiError ? e.message : "Could not save", "error"); }
  }
  async function clearAi() {
    if (!window.confirm("Remove every AI translation for this language? Pages translate them again as they are visited. Your corrections stay.")) return;
    const r = await api<{ removed: number }>(`/api/admin/translations?lang=${encodeURIComponent(lang)}`, { method: "DELETE" });
    toast(`${r.removed} lines removed`);
    load();
  }
  if (!langs.length) return <p className="rounded-xl bg-white p-5 text-ink-soft">Add a language under Languages first.</p>;
  return (
    <section className="rounded-xl bg-white p-5" translate="no" data-testid="translations">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Language" htmlFor="tr-lang"><Select id="tr-lang" value={lang} onChange={(e) => { setLang(e.target.value); setPage(1); }}>{langs.map((l) => <option key={l.code} value={l.code}>{languageName(l.code)}</option>)}</Select></Field>
        <TextField label="Search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="English or translated text" />
        <Field label="Show" htmlFor="tr-origin"><Select id="tr-origin" value={origin} onChange={(e) => { setOrigin(e.target.value); setPage(1); }}><option value="">All lines</option><option value="ai">By the AI</option><option value="manual">Corrected by staff</option></Select></Field>
        <Button variant="ghost" className="ml-auto" onClick={clearAi}><Trash2 className="h-4 w-4" /> Clear AI lines</Button>
      </div>
      <details className="mb-3 rounded-lg bg-mist p-3">
        <summary className="cursor-pointer font-semibold"><Globe className="mr-1 inline h-4 w-4" /> Add a translation by hand</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <TextField label="English (exactly as on the page)" value={newSrc} onChange={(e) => setNewSrc(e.target.value)} hint="Numbers become {0}, {1}…" />
          <TextField label="Translation" value={newText} onChange={(e) => setNewText(e.target.value)} />
          <Button onClick={() => { if (newSrc.trim() && newText.trim()) { void saveLine(newSrc.trim(), newText.trim()); setNewSrc(""); setNewText(""); } }}>Add</Button>
        </div>
      </details>
      {!rows ? <PageLoader /> : rows.items.length === 0 ? (
        <p className="text-sm text-ink-soft">No lines yet. Open the shop in this language and lines appear here as pages are visited.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.items.map((r) => (
            <li key={r.id} className="grid gap-2 py-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
              <p className="break-words text-sm">{r.source}</p>
              <Input value={edits[r.id] ?? r.text} onChange={(e) => setEdits({ ...edits, [r.id]: e.target.value })} aria-label={`Translation of ${r.source}`} />
              <div className="flex items-center gap-2">
                <Pill tone={r.origin === "manual" ? "green" : "gray"}>{r.origin === "manual" ? "Corrected" : "AI"}</Pill>
                {edits[r.id] !== undefined && edits[r.id] !== r.text && <Button size="sm" onClick={() => saveLine(r.source, edits[r.id])}>Save</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows && rows.total > 50 && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <Button size="sm" variant="ghost" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous</Button>
          <span>{(page - 1) * 50 + 1}–{Math.min(page * 50, rows.total)} of {rows.total}</span>
          <Button size="sm" variant="ghost" disabled={page * 50 >= rows.total} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
    </section>
  );
}
