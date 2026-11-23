/*
 * "Language and currency": the picker in the shop's account menu and footer, and (language only) in the seller hub,
 * delivery app and admin panel. Offered choices come from Admin → Languages and currencies. Port of
 * components/region-picker.tsx: hasRegionChoice(), <pc-region-dialog>, <pc-region-button>, <pc-region-strip>.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { Globe } from "lucide-angular";
import { RegionalService, currencyName, languageName } from "../../core/regional";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { Button, Field, Modal, Select } from "../ui/ui";
import { AcceptedPayments } from "./pay-logos";

function symbolOf(code: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0)
      .find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}

/** Whether there is anything to pick (more than one language, or more than one currency on shop pages). */
export function hasRegionChoice(r: RegionalService, languageOnly = false): boolean {
  const data = r.data();
  const shop = r.shop();
  if (!data.show_switcher && shop) return false;
  return data.languages.length > 1 || (!languageOnly && shop && data.currencies.length > 1);
}

@Component({
  selector: "pc-region-dialog",
  imports: [Modal, Field, Select, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-modal [open]="open()" (close)="close.emit()" [title]="showCurrency() ? 'Language and currency' : 'Language'">
      <div class="flex flex-col gap-4" data-testid="region-dialog">
        @if (r.data().languages.length > 1) {
          <pc-field label="Language" for="pick-lang">
            <select pcSelect id="pick-lang" [value]="lang()" (change)="lang.set($any($event.target).value)" translate="no">
              @for (l of r.data().languages; track l.code) {<option [value]="l.code" [selected]="l.code === lang()">{{ languageName(l.code) }}</option>}
            </select>
          </pc-field>
        }
        @if (showCurrency()) {
          <pc-field label="Currency" for="pick-cur"
            [hint]="r.data().charge_in === 'base' ? 'Prices are converted at today\\'s rate as a guide. You pay in Indian rupees (₹); your bank converts it.' : 'Prices are converted at today\\'s rate, and you pay in this currency.'">
            <select pcSelect id="pick-cur" [value]="cur()" (change)="cur.set($any($event.target).value)">
              @for (c of r.data().currencies; track c.code) {<option [value]="c.code" [selected]="c.code === cur()">{{ currencyName(c.code) }}</option>}
            </select>
          </pc-field>
        }
        <div class="flex justify-end gap-2">
          <button pcButton variant="ghost" (click)="close.emit()">Cancel</button>
          <button pcButton (click)="save()" data-testid="region-save">Save</button>
        </div>
      </div>
    </pc-modal>
  `,
})
export class RegionDialog {
  protected readonly r = inject(RegionalService);
  readonly open = input(true);
  readonly languageOnly = input(false);
  readonly close = output<void>();
  protected readonly lang = signal(this.r.language());
  protected readonly cur = signal(this.r.currency());
  protected readonly languageName = languageName;
  protected readonly currencyName = currencyName;
  protected readonly showCurrency = computed(() => !this.languageOnly() && this.r.shop() && this.r.data().currencies.length > 1);

  protected save(): void {
    const cur = this.cur();
    const lang = this.lang();
    if (cur !== this.r.currency()) document.cookie = `pc_cur=${cur}; path=/; max-age=31536000; samesite=lax`;
    if (lang !== this.r.language()) this.r.setLanguage(lang);
    else if (cur !== this.r.currency()) this.r.setCurrency(cur);
    else this.close.emit();
  }
}

/** A small button: globe, language code and (on shop pages) the currency. */
@Component({
  selector: "pc-region-button",
  imports: [Icon, RegionDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (has()) {
      <button type="button" (click)="open.set(true)" data-testid="region-button" aria-label="Language and currency" [class]="cls()">
        <svg [pcIcon]="Globe" class="h-4 w-4" />
        <span translate="no">{{ r.language().split("-")[0].toUpperCase() }}</span>
        @if (showCur()) {<span translate="no" class="opacity-80">· {{ symbol() }} {{ r.currency() }}</span>}
      </button>
      @if (open()) {<pc-region-dialog [languageOnly]="languageOnly()" (close)="open.set(false)" />}
    }
  `,
})
export class RegionButton {
  protected readonly r = inject(RegionalService);
  readonly languageOnly = input(false);
  readonly tone = input<"light" | "dark">("light");
  readonly extra = input<string>("", { alias: "buttonClass" });
  protected readonly Globe = Globe;
  protected readonly open = signal(false);
  protected readonly has = computed(() => hasRegionChoice(this.r, this.languageOnly()));
  protected readonly showCur = computed(() => !this.languageOnly() && this.r.shop() && this.r.data().currencies.length > 1);
  protected readonly symbol = computed(() => symbolOf(this.r.currency()));
  protected readonly cls = computed(() => cx("inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold", this.tone() === "dark" ? "text-white hover:bg-white/10" : "text-ink hover:bg-mist", this.extra()));
}

/** The shop's strip above the footer: the ways to pay, and the language and currency in use with a way to change them. */
@Component({
  selector: "pc-region-strip",
  imports: [Icon, RegionDialog, AcceptedPayments],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block border-t border-line bg-white", "data-testid": "region-strip" },
  template: `
    <div class="mx-auto flex max-w-shop flex-col items-center justify-between gap-3 px-3 py-3 text-sm text-ink-soft sm:flex-row sm:px-4">
      <pc-accepted-payments [networks]="r.data().card_networks" [methods]="r.data().pay_methods" [cod]="true" label="Pay with" rowClass="justify-center" />
      @if (has()) {
        <div class="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <svg [pcIcon]="Globe" class="h-4 w-4 text-peacock" />
          <span translate="no">{{ languageName(r.language(), false) }}</span>
          @if (r.data().currencies.length > 1) {<span translate="no">· {{ currencyName(r.currency()) }}</span>}
          <button type="button" (click)="open.set(true)" class="font-semibold text-peacock hover:underline" data-testid="region-change">Change</button>
        </div>
      }
    </div>
    @if (open()) {<pc-region-dialog (close)="open.set(false)" />}
  `,
})
export class RegionStrip {
  protected readonly r = inject(RegionalService);
  protected readonly Globe = Globe;
  protected readonly open = signal(false);
  protected readonly has = computed(() => hasRegionChoice(this.r));
  protected readonly languageName = languageName;
  protected readonly currencyName = currencyName;
}
