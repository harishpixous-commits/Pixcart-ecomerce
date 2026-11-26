/*
 * Admin → Languages and currencies. Port of frontend/src/app/admin/regional/page.tsx.
 *
 *  Currencies    which currencies shoppers can pick, their rates (typed, or updated daily), a conversion charge, and
 *                whether Razorpay charges the shopper's currency or always rupees. The books always stay in rupees.
 *  Languages     which languages the site (shop, seller hub, delivery app, admin panel) can be shown in.
 *  Regions       a visitor's country → their first currency and language.
 *  Payments      the ways to pay Razorpay offers, the card logos shown, and saved cards.
 *  Translations  every translated line, to check and correct.
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from "@angular/core";
import { Globe, Plus, RefreshCw, Trash2 } from "lucide-angular";
import { api, ApiError } from "../../core/api";
import { dateTime } from "../../core/format";
import { currencyName, languageName } from "../../core/regional";
import { AcceptedPayments, NETWORK_NAMES, PayLogo } from "../../shared/chrome/pay-logos";
import { PageHeader } from "../../shared/portal-shell";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Input, Pill, Select, TextField, Toast } from "../../shared/ui/ui";

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
type Change = (p: Partial<Cfg>) => void;

const TABS = ["Currencies", "Languages", "Regions", "Payments", "Translations"] as const;
type Tab = (typeof TABS)[number];
const PAY_LABEL: Record<string, string> = { upi: "UPI (Google Pay, PhonePe, Paytm, BHIM and all UPI apps)", card: "Credit and debit cards", netbanking: "Net banking", wallet: "Wallets", emi: "EMI", paylater: "Pay later" };

function countryName(code: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code; } catch { return code; }
}

/** A checkbox row; project the label (text or logo and text). */
@Component({
  selector: "pc-regional-check",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <label class="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-mist">
      <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="checked()" (change)="changed.emit($any($event.target).checked)" [attr.data-testid]="testId() || null" />
      <span><span class="font-medium"><ng-content /></span>@if (hint()) {<span class="block text-sm text-ink-soft">{{ hint() }}</span>}</span>
    </label>
  `,
})
export class RegionalCheck {
  readonly checked = input.required<boolean>();
  readonly hint = input<string | undefined>(undefined);
  readonly testId = input<string | undefined>(undefined);
  readonly changed = output<boolean>();
}

@Component({
  selector: "pc-regional-currencies",
  imports: [RegionalCheck, Icon, Button, Field, Input, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @let cfg = this.cfg();
    <section class="rounded-xl bg-white p-5">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <h2 class="text-lg font-semibold">Currencies shoppers can pick</h2>
        <button pcButton size="sm" variant="secondary" class="ml-auto" (click)="refreshRates.emit()" [loading]="busy()"><svg [pcIcon]="RefreshCw" class="h-4 w-4" /> Update rates now</button>
      </div>
      <p class="mb-3 text-sm text-ink-soft">
        Rate = how much of the currency one rupee buys (₹1 = $0.012 means a ₹499 item shows as about $5.99). "Daily" rates update by themselves{{ updated() }}.
        Prices, GST, commissions and payouts always stay in rupees.
      </p>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[640px] text-sm">
          <thead><tr class="text-left text-ink-soft"><th class="py-2">Currency</th><th>On</th><th>Rate per ₹1</th><th>Daily</th><th>₹499 shows as</th><th></th></tr></thead>
          <tbody>
            @for (c of cfg.currencies; track c.code) {
              @let base = c.code === "INR";
              <tr class="border-t border-line" [attr.data-testid]="'cur-' + c.code">
                <td class="py-2 pr-2 font-medium" translate="no">{{ currencyName(c.code) }}</td>
                <td><input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="c.enabled" [disabled]="base" (change)="set(c.code, { enabled: $any($event.target).checked })" [attr.aria-label]="'Offer ' + c.code" /></td>
                <td class="pr-2"><input pcInput [value]="base ? '1' : c.rate" [disabled]="base || c.auto" inputmode="decimal" class="w-32" [attr.aria-label]="c.code + ' rate'"
                  (input)="rate(c.code, $any($event.target))" /></td>
                <td><input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="c.auto" [disabled]="base" (change)="set(c.code, { auto: $any($event.target).checked })" [attr.aria-label]="'Update ' + c.code + ' daily'" /></td>
                <td class="tabular-nums" translate="no">{{ base ? "₹499" : preview(c) || "—" }}</td>
                <td>@if (!base) {<button type="button" (click)="remove(c.code)" [attr.aria-label]="'Remove ' + c.code" class="rounded p-1 text-ink-soft hover:bg-mist"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="mt-3 flex flex-wrap items-end gap-2">
        <pc-field label="Add a currency" for="add-cur" class="min-w-[16rem]">
          <select pcSelect id="add-cur" (change)="pick($any($event.target))">
            <option value="" selected>Choose…</option>
            @for (c of popular(); track c) {<option [value]="c">{{ currencyName(c) }}</option>}
          </select>
        </pc-field>
        <pc-text-field label="or any code" [value]="adding()" [filter]="code3" (valueChange)="adding.set($event)" placeholder="e.g. NPR" class="w-28" />
        <button pcButton variant="secondary" (click)="add(adding())" [disabled]="!valid(adding())"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add</button>
      </div>
    </section>
    <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
      <h2 class="text-lg font-semibold sm:col-span-2">How shoppers pay</h2>
      <pc-field label="Charge online payments in" for="charge-in" class="sm:col-span-2"
        [hint]="cfg.charge_in === 'shopper' ? 'Razorpay charges the shopper\\'s currency. Switch on International payments in your Razorpay account first (Razorpay Dashboard → Account and settings). Cash on delivery is always in rupees.' : 'Other currencies are shown as a guide; Razorpay charges rupees and the shopper\\'s bank converts.'">
        <select pcSelect id="charge-in" (change)="change()({ charge_in: $any($event.target).value })">
          <option value="base" [selected]="cfg.charge_in === 'base'">Always Indian rupees (₹)</option>
          <option value="shopper" [selected]="cfg.charge_in === 'shopper'">The shopper's currency (Razorpay international payments)</option>
        </select>
      </pc-field>
      <pc-field label="Default currency" for="def-cur" hint="For visitors whose country has no rule (Regions)">
        <select pcSelect id="def-cur" (change)="change()({ default_currency: $any($event.target).value })">
          @for (c of enabled(); track c.code) {<option [value]="c.code" [selected]="c.code === cfg.default_currency">{{ currencyName(c.code) }}</option>}
        </select>
      </pc-field>
      <pc-text-field label="Conversion charge (%)" inputmode="decimal" [value]="'' + cfg.markup_bps / 100" hint="Added to converted prices, 0 to 10. Covers bank conversion costs."
        [filter]="markupText" (valueChange)="markup($event)" />
      <pc-regional-check [checked]="cfg.auto_rates" (changed)="change()({ auto_rates: $event })" hint="From a free exchange-rate service, once a day">Update "Daily" rates automatically</pc-regional-check>
      <pc-regional-check [checked]="cfg.show_switcher" (changed)="change()({ show_switcher: $event })" hint="In the account menu and above the footer">Show the language and currency picker in the shop</pc-regional-check>
    </section>
  `,
})
export class RegionalCurrencies {
  readonly cfg = input.required<Cfg>();
  readonly change = input.required<Change>();
  readonly busy = input(false);
  readonly refreshRates = output<void>();
  protected readonly Plus = Plus;
  protected readonly RefreshCw = RefreshCw;
  protected readonly Trash2 = Trash2;
  protected readonly currencyName = currencyName;
  protected readonly adding = signal("");
  protected readonly code3 = (v: string) => v.toUpperCase().slice(0, 3);
  // the reference shows the saved value again at once (a controlled input), so "1." reads "1"
  protected readonly markupText = (v: string) => String(Math.round(Math.min(10, Math.max(0, Number(v) || 0)) * 100) / 100);
  private readonly have = computed(() => new Set(this.cfg().currencies.map((c) => c.code)));
  protected readonly popular = computed(() => this.cfg().popular_currencies.filter((c) => !this.have().has(c)));
  protected readonly enabled = computed(() => this.cfg().currencies.filter((c) => c.enabled));
  protected readonly updated = computed(() => {
    const c = this.cfg();
    return c.rates_updated_at ? `; last updated ${dateTime(c.rates_updated_at)}${c.rates_source ? ` from ${c.rates_source}` : ""}` : "";
  });

  protected valid(code: string): boolean {
    return /^[A-Z]{3}$/.test(code);
  }

  protected set(code: string, patch: Partial<Cur>): void {
    this.change()({ currencies: this.cfg().currencies.map((c) => (c.code === code ? { ...c, ...patch } : c)) });
  }

  protected rate(code: string, el: HTMLInputElement): void {
    const v = el.value.replace(/[^0-9.]/g, "");
    if (v !== el.value) el.value = v;
    this.set(code, { rate: v });
  }

  protected remove(code: string): void {
    const cfg = this.cfg();
    this.change()({ currencies: cfg.currencies.filter((x) => x.code !== code), regions: cfg.regions.filter((r) => r.currency !== code) });
  }

  protected pick(el: HTMLSelectElement): void {
    this.add(el.value);
    el.value = "";
  }

  protected add(code: string): void {
    const c = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c) || this.have().has(c)) return;
    this.change()({ currencies: [...this.cfg().currencies, { code: c, rate: "", enabled: true, auto: true }] });
    this.adding.set("");
  }

  protected markup(v: string): void {
    this.change()({ markup_bps: Math.round(Math.min(10, Math.max(0, Number(v) || 0)) * 100) });
  }

  protected preview(c: Cur): string {
    const sample = 49900; // ₹499
    const rate = Number(c.rate);
    if (!(rate > 0)) return "";
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: c.code, currencyDisplay: "narrowSymbol" }).format((sample / 100) * rate * (1 + this.cfg().markup_bps / 10000));
    } catch {
      return `${c.code} ${((sample / 100) * rate).toFixed(2)}`;
    }
  }
}

@Component({
  selector: "pc-regional-languages",
  imports: [RegionalCheck, Icon, Button, Field, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @let cfg = this.cfg();
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">Languages</h2>
      <p class="mb-3 text-sm text-ink-soft">
        Shoppers, sellers, delivery partners and staff each pick their language (globe button). Every page is translated: the first time a line is
        seen it is translated by the AI and kept, and you can correct any line under Translations.
      </p>
      @if (!cfg.ai_ready) {
        <p class="mb-3 rounded-lg bg-marigold-light px-3 py-2 text-sm">
          No AI model is connected, so new lines stay in English until you translate them under Translations. Connect one in Admin → AI providers
          (route "Translating the site") to translate automatically.
        </p>
      }
      <ul class="grid gap-1 sm:grid-cols-2" translate="no">
        @for (l of cfg.languages; track l.code) {
          <li class="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-mist">
            <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="l.enabled" [disabled]="l.code === 'en'" [attr.aria-label]="'Offer ' + l.code"
              (change)="toggle(l.code, $any($event.target).checked)" />
            <span class="flex-1">{{ languageName(l.code) }}</span>
            <span class="text-xs text-ink-faint">{{ l.code === "en" ? "the site's own text" : (cfg.translation_counts[l.code] ?? 0) + " lines" }}</span>
            @if (l.code !== "en") {<button type="button" (click)="remove(l.code)" [attr.aria-label]="'Remove ' + l.code" class="rounded p-1 text-ink-soft hover:bg-white"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>}
          </li>
        }
      </ul>
      <div class="mt-3 flex flex-wrap items-end gap-2">
        <pc-field label="Add a language" for="add-lang" class="min-w-[16rem]">
          <select pcSelect id="add-lang" (change)="pick($any($event.target))" translate="no">
            <option value="" selected>Choose…</option>
            @for (c of popular(); track c) {<option [value]="c">{{ languageName(c) }}</option>}
          </select>
        </pc-field>
        <pc-text-field label="or any code" [value]="code()" [filter]="code12" (valueChange)="code.set($event)" placeholder="e.g. pt-BR" class="w-32" />
        <button pcButton variant="secondary" (click)="add(code())"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add</button>
      </div>
    </section>
    <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
      <pc-field label="Default language" for="def-lang" hint="For visitors whose country has no rule">
        <select pcSelect id="def-lang" (change)="change()({ default_language: $any($event.target).value })" translate="no">
          @for (l of enabled(); track l.code) {<option [value]="l.code" [selected]="l.code === cfg.default_language">{{ languageName(l.code) }}</option>}
        </select>
      </pc-field>
      <pc-text-field label="AI translations per day (most)" inputmode="numeric" [value]="'' + cfg.ai_translate_daily_max" hint="New lines only; known lines are free"
        [filter]="daily" (valueChange)="change()({ ai_translate_daily_max: +$event })" />
      <pc-regional-check [checked]="cfg.ai_translate" (changed)="change()({ ai_translate: $event })" hint="Off: only lines you translated are shown in other languages">Translate new lines with the AI</pc-regional-check>
    </section>
  `,
})
export class RegionalLanguages {
  readonly cfg = input.required<Cfg>();
  readonly change = input.required<Change>();
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly languageName = languageName;
  protected readonly code = signal("");
  protected readonly code12 = (v: string) => v.slice(0, 12);
  protected readonly daily = (v: string) => String(Math.max(0, Math.min(100000, Number(v.replace(/\D/g, "")) || 0)));
  private readonly have = computed(() => new Set(this.cfg().languages.map((l) => l.code)));
  protected readonly popular = computed(() => this.cfg().popular_languages.filter((c) => !this.have().has(c)));
  protected readonly enabled = computed(() => this.cfg().languages.filter((l) => l.enabled));

  protected toggle(code: string, on: boolean): void {
    this.change()({ languages: this.cfg().languages.map((x) => (x.code === code ? { ...x, enabled: on } : x)) });
  }

  protected remove(code: string): void {
    const cfg = this.cfg();
    this.change()({ languages: cfg.languages.filter((x) => x.code !== code), regions: cfg.regions.filter((r) => r.language !== code) });
  }

  protected pick(el: HTMLSelectElement): void {
    this.add(el.value);
    el.value = "";
  }

  protected add(c: string): void {
    const v = c.trim();
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v) || this.have().has(v)) return;
    this.change()({ languages: [...this.cfg().languages, { code: v, enabled: true }] });
    this.code.set("");
  }
}

@Component({
  selector: "pc-regional-regions",
  imports: [RegionalCheck, Icon, Button, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @let cfg = this.cfg();
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">Regions</h2>
      <p class="mb-3 text-sm text-ink-soft">On their first visit, a shopper from a country below sees its currency and language. They can always change it.</p>
      <pc-regional-check [checked]="cfg.detect_region" (changed)="change()({ detect_region: $event })" hint="The country comes from the hosting service (for example Cloudflare); nothing is asked or stored">Pick currency and language from the visitor's country</pc-regional-check>
      <div class="mt-2 overflow-x-auto">
        <table class="w-full min-w-[560px] text-sm">
          <thead><tr class="text-left text-ink-soft"><th class="py-2">Country</th><th>Currency</th><th>Language</th><th></th></tr></thead>
          <tbody>
            @for (r of cfg.regions; track r.country; let i = $index) {
              <tr class="border-t border-line">
                <td class="py-2 font-medium">{{ countryName(r.country) }} <span class="text-ink-faint" translate="no">({{ r.country }})</span></td>
                <td class="pr-2"><select pcSelect (change)="set(i, { currency: $any($event.target).value })" [attr.aria-label]="r.country + ' currency'">@for (c of cfg.currencies; track c.code) {<option [value]="c.code" [selected]="c.code === r.currency">{{ c.code }}</option>}</select></td>
                <td class="pr-2"><select pcSelect (change)="set(i, { language: $any($event.target).value })" [attr.aria-label]="r.country + ' language'" translate="no">@for (l of cfg.languages; track l.code) {<option [value]="l.code" [selected]="l.code === r.language">{{ languageName(l.code, false) }}</option>}</select></td>
                <td><button type="button" (click)="removeAt(i)" [attr.aria-label]="'Remove ' + r.country" class="rounded p-1 text-ink-soft hover:bg-mist"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="mt-3 flex flex-wrap items-end gap-2">
        <pc-text-field label="Country code" [value]="country()" [filter]="cc" (valueChange)="country.set($event)" placeholder="e.g. SG" class="w-32"
          [hint]="country().length === 2 ? countryName(country()) : '2 letters'" />
        <button pcButton variant="secondary" [disabled]="country().length !== 2 || exists(country())" (click)="addRegion()">
          <svg [pcIcon]="Plus" class="h-4 w-4" /> Add region
        </button>
      </div>
    </section>
  `,
})
export class RegionalRegions {
  readonly cfg = input.required<Cfg>();
  readonly change = input.required<Change>();
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly countryName = countryName;
  protected readonly languageName = languageName;
  protected readonly country = signal("");
  protected readonly cc = (v: string) => v.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);

  protected exists(c: string): boolean {
    return this.cfg().regions.some((r) => r.country === c);
  }

  protected set(i: number, patch: Partial<Region>): void {
    this.change()({ regions: this.cfg().regions.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  }

  protected removeAt(i: number): void {
    this.change()({ regions: this.cfg().regions.filter((_, j) => j !== i) });
  }

  protected addRegion(): void {
    const cfg = this.cfg();
    this.change()({ regions: [...cfg.regions, { country: this.country(), currency: cfg.default_currency, language: cfg.default_language }] });
    this.country.set("");
  }
}

@Component({
  selector: "pc-regional-payments",
  imports: [RegionalCheck, PayLogo, AcceptedPayments],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @let cfg = this.cfg();
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">Ways to pay online</h2>
      <p class="mb-2 text-sm text-ink-soft">What Razorpay's payment window offers. Methods must also be active in your Razorpay account.</p>
      <div class="grid gap-1 sm:grid-cols-2">
        @for (m of cfg.pay_method_keys; track m) {
          <pc-regional-check [checked]="cfg.pay_methods[m] !== false" [testId]="'pay-' + m" (changed)="method(m, $event)">
            <span class="inline-flex items-center gap-2"><pc-pay-logo [name]="m === 'card' ? 'visa' : m" /> {{ payLabel[m] ?? m }}</span>
          </pc-regional-check>
        }
      </div>
    </section>
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">Card logos shown</h2>
      <p class="mb-2 text-sm text-ink-soft">Shown at checkout as "We accept". Show only the networks your Razorpay account accepts.</p>
      <div class="grid gap-1 sm:grid-cols-2">
        @for (n of cfg.card_network_keys; track n) {
          <pc-regional-check [checked]="cfg.card_networks.includes(n)" (changed)="network(n, $event)">
            <span class="inline-flex items-center gap-2"><pc-pay-logo [name]="n" /> {{ networkNames[n] ?? n }}</span>
          </pc-regional-check>
        }
      </div>
      <div class="mt-3 rounded-lg bg-mist p-3"><p class="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">Preview</p><pc-accepted-payments [networks]="cfg.card_networks" [methods]="cfg.pay_methods" /></div>
    </section>
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">Saved cards</h2>
      <pc-regional-check [checked]="cfg.save_cards" (changed)="change()({ save_cards: $event })"
        hint="Razorpay asks the shopper in its payment window and saves the card as an RBI-approved token; no card number is stored on this site. Shoppers see and remove saved cards under Account. Each payment is still confirmed with the CVV and the bank's OTP, as RBI requires.">Let shoppers save cards for faster checkout</pc-regional-check>
      <p class="mt-2 rounded-lg bg-mist px-3 py-2 text-sm text-ink-soft">
        Scanning a card with the camera: on phones, Chrome (Android) and Safari (iPhone) offer "Scan card" on the card number box in the
        payment window, which fills the number and expiry. Card details are typed only inside Razorpay's secure window, never on this site.
      </p>
    </section>
  `,
})
export class RegionalPayments {
  readonly cfg = input.required<Cfg>();
  readonly change = input.required<Change>();
  protected readonly payLabel = PAY_LABEL;
  protected readonly networkNames = NETWORK_NAMES;

  protected method(m: string, on: boolean): void {
    this.change()({ pay_methods: { ...this.cfg().pay_methods, [m]: on } });
  }

  protected network(n: string, on: boolean): void {
    const nets = this.cfg().card_networks;
    this.change()({ card_networks: on ? [...nets, n] : nets.filter((x) => x !== n) });
  }
}

type TrRow = { id: string; source: string; text: string; origin: "ai" | "manual"; updated_at: string };

@Component({
  selector: "pc-regional-translations",
  imports: [Icon, PageLoader, Button, Field, Input, Pill, Select, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!langs().length) {
      <p class="rounded-xl bg-white p-5 text-ink-soft">Add a language under Languages first.</p>
    } @else {
      <section class="rounded-xl bg-white p-5" translate="no" data-testid="translations">
        <div class="mb-3 flex flex-wrap items-end gap-2">
          <pc-field label="Language" for="tr-lang"><select pcSelect id="tr-lang" (change)="lang.set($any($event.target).value); page.set(1)">@for (l of langs(); track l.code) {<option [value]="l.code" [selected]="l.code === lang()">{{ languageName(l.code) }}</option>}</select></pc-field>
          <pc-text-field label="Search" [value]="q()" (valueChange)="q.set($event); page.set(1)" placeholder="English or translated text" />
          <pc-field label="Show" for="tr-origin"><select pcSelect id="tr-origin" (change)="origin.set($any($event.target).value); page.set(1)"><option value="">All lines</option><option value="ai">By the AI</option><option value="manual">Corrected by staff</option></select></pc-field>
          <button pcButton variant="ghost" class="ml-auto" (click)="clearAi()"><svg [pcIcon]="Trash2" class="h-4 w-4" /> Clear AI lines</button>
        </div>
        <details class="mb-3 rounded-lg bg-mist p-3">
          <summary class="cursor-pointer font-semibold"><svg [pcIcon]="Globe" class="mr-1 inline h-4 w-4" /> Add a translation by hand</summary>
          <div class="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <pc-text-field label="English (exactly as on the page)" [(value)]="newSrc" [hint]="'Numbers become {0}, {1}…'" />
            <pc-text-field label="Translation" [(value)]="newText" />
            <button pcButton (click)="addLine()">Add</button>
          </div>
        </details>
        @if (!rows()) {
          <pc-page-loader />
        } @else if (rows()!.items.length === 0) {
          <p class="text-sm text-ink-soft">No lines yet. Open the shop in this language and lines appear here as pages are visited.</p>
        } @else {
          <ul class="divide-y divide-line">
            @for (r of rows()!.items; track r.id) {
              <li class="grid gap-2 py-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
                <p class="break-words text-sm">{{ r.source }}</p>
                <input pcInput [value]="edits()[r.id] ?? r.text" (input)="edit(r.id, $any($event.target).value)" [attr.aria-label]="'Translation of ' + r.source" />
                <div class="flex items-center gap-2">
                  <pc-pill [tone]="r.origin === 'manual' ? 'green' : 'gray'">{{ r.origin === "manual" ? "Corrected" : "AI" }}</pc-pill>
                  @if (edits()[r.id] !== undefined && edits()[r.id] !== r.text) {<button pcButton size="sm" (click)="saveLine(r.source, edits()[r.id])">Save</button>}
                </div>
              </li>
            }
          </ul>
        }
        @if (rows() && rows()!.total > 50) {
          <div class="mt-3 flex items-center justify-between text-sm">
            <button pcButton size="sm" variant="ghost" [disabled]="page() === 1" (click)="page.set(page() - 1)">Previous</button>
            <span>{{ (page() - 1) * 50 + 1 }}–{{ min(page() * 50, rows()!.total) }} of {{ rows()!.total }}</span>
            <button pcButton size="sm" variant="ghost" [disabled]="page() * 50 >= rows()!.total" (click)="page.set(page() + 1)">Next</button>
          </div>
        }
      </section>
    }
  `,
})
export class RegionalTranslations {
  readonly cfg = input.required<Cfg>();
  private readonly toast = inject(Toast);
  protected readonly Globe = Globe;
  protected readonly Trash2 = Trash2;
  protected readonly languageName = languageName;
  protected readonly min = Math.min;
  protected readonly langs = computed(() => this.cfg().languages.filter((l) => l.code !== "en"));
  protected readonly lang = signal("");
  protected readonly q = signal("");
  protected readonly origin = signal("");
  protected readonly page = signal(1);
  protected readonly rows = signal<{ total: number; items: TrRow[] } | null>(null);
  protected readonly edits = signal<Record<string, string>>({});
  protected readonly newSrc = signal("");
  protected readonly newText = signal("");

  constructor() {
    let first = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      if (first) {
        first = false;
        this.lang.set(this.langs()[0]?.code ?? "");
      }
      const lang = this.lang(), q = this.q(), origin = this.origin(), page = this.page();
      clearTimeout(t);
      t = setTimeout(() => this.load(lang, q, origin, page), 250);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  private load(lang = this.lang(), q = this.q(), origin = this.origin(), page = this.page()): void {
    if (!lang) return;
    const qs = new URLSearchParams({ lang, q, origin, page: String(page) });
    api<{ total: number; items: TrRow[] }>(`/api/admin/translations?${qs}`).then((r) => this.rows.set(r)).catch(() => this.rows.set({ total: 0, items: [] }));
  }

  protected edit(id: string, v: string): void {
    this.edits.update((e) => ({ ...e, [id]: v }));
  }

  protected async saveLine(source: string, text: string): Promise<void> {
    try {
      await api("/api/admin/translations", { method: "PUT", body: { lang: this.lang(), source, text } });
      this.toast.show("Saved");
      this.load();
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not save", "error");
    }
  }

  protected addLine(): void {
    const src = this.newSrc().trim(), text = this.newText().trim();
    if (src && text) {
      void this.saveLine(src, text);
      this.newSrc.set("");
      this.newText.set("");
    }
  }

  protected async clearAi(): Promise<void> {
    if (!window.confirm("Remove every AI translation for this language? Pages translate them again as they are visited. Your corrections stay.")) return;
    const r = await api<{ removed: number }>(`/api/admin/translations?lang=${encodeURIComponent(this.lang())}`, { method: "DELETE" });
    this.toast.show(`${r.removed} lines removed`);
    this.load();
  }
}

@Component({
  selector: "pc-admin-regional-page",
  imports: [PageHeader, PageLoader, Button, ErrorNote, RegionalCurrencies, RegionalLanguages, RegionalRegions, RegionalPayments, RegionalTranslations],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (!cfg()) {
      @if (error()) {<pc-error-note [message]="error()" />} @else {<pc-page-loader />}
    } @else {
      <div class="flex flex-col gap-4 pb-24">
        <pc-page-header title="Languages and currencies" sub="What shoppers can switch to, how they pay, and the site in other languages" />
        <div role="tablist" class="flex gap-1 overflow-x-auto rounded-xl bg-white p-1" aria-label="Sections">
          @for (t of tabs; track t) {
            <button role="tab" [attr.aria-selected]="tab() === t" (click)="tab.set(t)"
              [class]="tab() === t ? 'shrink-0 rounded-lg px-3 py-2 text-sm font-semibold bg-peacock text-white' : 'shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-ink-soft hover:bg-mist'">{{ t }}</button>
          }
        </div>
        <pc-error-note [message]="error()" />
        @switch (tab()) {
          @case ("Currencies") {<pc-regional-currencies [cfg]="cfg()!" [change]="change" [busy]="busy()" (refreshRates)="refreshRates()" />}
          @case ("Languages") {<pc-regional-languages [cfg]="cfg()!" [change]="change" />}
          @case ("Regions") {<pc-regional-regions [cfg]="cfg()!" [change]="change" />}
          @case ("Payments") {<pc-regional-payments [cfg]="cfg()!" [change]="change" />}
          @case ("Translations") {<pc-regional-translations [cfg]="cfg()!" />}
        }
        @if (tab() !== "Translations") {
          <div class="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 px-4 py-3 backdrop-blur">
            <div class="mx-auto flex max-w-5xl items-center justify-end gap-3">
              @if (dirty()) {<span class="text-sm text-ink-soft">Unsaved changes</span>}
              <button pcButton (click)="save()" [loading]="busy()" [disabled]="!dirty()" data-testid="regional-save">Save changes</button>
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class AdminRegionalPage {
  private readonly toast = inject(Toast);
  protected readonly tabs = TABS;
  protected readonly cfg = signal<Cfg | null>(null);
  protected readonly tab = signal<Tab>("Currencies");
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly dirty = signal(false);
  protected readonly change: Change = (patch) => {
    this.cfg.update((c) => (c ? { ...c, ...patch } : c));
    this.dirty.set(true);
  };

  constructor() {
    api<Cfg>("/api/admin/regional").then((c) => this.cfg.set(c)).catch((e) => this.error.set(e.message));
  }

  protected async save(): Promise<void> {
    const cfg = this.cfg();
    if (!cfg) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const body = {
        currencies: cfg.currencies, default_currency: cfg.default_currency, markup_bps: cfg.markup_bps, charge_in: cfg.charge_in, auto_rates: cfg.auto_rates,
        languages: cfg.languages, default_language: cfg.default_language, ai_translate: cfg.ai_translate, ai_translate_daily_max: cfg.ai_translate_daily_max,
        show_switcher: cfg.show_switcher, detect_region: cfg.detect_region, regions: cfg.regions,
        pay_methods: cfg.pay_methods, card_networks: cfg.card_networks, save_cards: cfg.save_cards,
      };
      this.cfg.set(await api<Cfg>("/api/admin/regional", { method: "PUT", body }));
      this.dirty.set(false);
      this.toast.show("Saved. Shoppers see the change on their next page.");
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }

  protected async refreshRates(): Promise<void> {
    this.busy.set(true);
    try {
      const r = await api<Cfg & { message: string; changed: boolean }>("/api/admin/regional/rates", { method: "POST" });
      this.cfg.set(r);
      this.toast.show(r.message, r.changed ? "ok" : "error");
    } catch (e) {
      this.toast.show(e instanceof ApiError ? e.message : "Could not update the rates", "error");
    } finally {
      this.busy.set(false);
    }
  }
}
