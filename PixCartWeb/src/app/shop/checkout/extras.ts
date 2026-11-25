/*
 * The optional parts of checkout that Admin → Checkout and fees switches on: delivery instructions, a tip for the
 * delivery partner, a GSTIN for a business purchase and "I don't need a bag". Port of components/checkout/extras.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from "@angular/core";
import { BellOff, Building2, Check, ChevronDown, CircleCheck, DoorOpen, HandHeart, Leaf, NotebookPen, PawPrint, PhoneCall, ShieldCheck } from "lucide-angular";
import { currencySymbol, paiseToShown, rupees, shownToPaise } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { Autofocus, Button, Input, TextField, Textarea, uid } from "../../shared/ui/ui";
import { CARD, CardHeading, IconBadge } from "./card";

/* ---------------------------------------------------------------- delivery instructions */

export const MAX_INSTRUCTIONS = 300;

const QUICK_NOTES = [
  { text: "Leave at the door", icon: DoorOpen },
  { text: "Call when you arrive", icon: PhoneCall },
  { text: "Do not ring the bell", icon: BellOff },
  { text: "Hand over to security", icon: ShieldCheck },
  { text: "Pet at home", icon: PawPrint },
];

/** The sentences of an instruction ("Leave at the door. Pet at home" has two). */
function sentences(text: string): string[] {
  return text.split(/\.(?:\s+|$)/).map((s) => s.trim()).filter(Boolean);
}

function hasSentence(text: string, phrase: string): boolean {
  const p = phrase.toLowerCase();
  return sentences(text).some((s) => s.toLowerCase() === p);
}

/** Adds the phrase as its own sentence, or takes it out when it is already there. */
function toggleSentence(text: string, phrase: string): string {
  const all = sentences(text);
  const p = phrase.toLowerCase();
  const kept = all.filter((s) => s.toLowerCase() !== p);
  return (kept.length === all.length ? [...all, phrase] : kept).join(". ");
}

@Component({
  selector: "pc-instructions-section",
  imports: [Icon, CardHeading, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section aria-labelledby="co-notes-h" data-testid="checkout-instructions" [class]="CARD">
      <div pcCardHeading headingId="co-notes-h" [icon]="NotebookPen" title="Delivery instructions" sub="Help the delivery partner reach you."></div>
      <div class="flex flex-wrap gap-2" role="group" aria-label="Quick instructions">
        @for (q of chips(); track q.text) {
          <button type="button" [attr.aria-pressed]="q.on" [disabled]="!q.on && q.next.length > max" (click)="textChange.emit(q.next)"
            [class]="q.on ? 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 border-peacock bg-peacock-light text-peacock' : 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 border-line bg-white text-ink-soft hover:border-peacock/50 hover:text-ink'">
            @if (q.on) {<svg [pcIcon]="Check" class="h-4 w-4" [strokeWidth]="3" />} @else {<svg [pcIcon]="q.icon" class="h-4 w-4" />}{{ q.text }}
          </button>
        }
      </div>
      <label [attr.for]="id" class="sr-only">Instructions for the delivery partner</label>
      <textarea pcTextarea [id]="id" [value]="text()" [attr.maxlength]="max" rows="3" (input)="textChange.emit($any($event.target).value)"
        placeholder="E.g. Ring the bell twice. The gate code is 1234." class="mt-3 resize-none"></textarea>
      <div class="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <label class="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="save()" (change)="saveChange.emit($any($event.target).checked)" />
          Save these instructions for next time
        </label>
        <span class="text-xs tabular-nums text-ink-faint">{{ text().length }}/{{ max }}</span>
      </div>
    </section>
  `,
})
export class InstructionsSection {
  readonly text = input.required<string>();
  readonly save = input(false);
  readonly textChange = output<string>();
  readonly saveChange = output<boolean>();
  protected readonly id = uid("co-notes");
  protected readonly max = MAX_INSTRUCTIONS;
  protected readonly CARD = CARD;
  protected readonly NotebookPen = NotebookPen;
  protected readonly Check = Check;
  protected readonly chips = computed(() => QUICK_NOTES.map((q) => ({ ...q, on: hasSentence(this.text(), q.text), next: toggleSentence(this.text(), q.text) })));
}

/* ---------------------------------------------------------------- tip */

const CHIP = "inline-flex h-10 min-w-[4.5rem] items-center justify-center gap-1.5 rounded-xl border-2 px-3.5 text-[15px] font-semibold transition-colors";
const CHIP_ON = `${CHIP} border-peacock bg-peacock text-white`;
const CHIP_OFF = `${CHIP} border-line bg-white text-ink hover:border-peacock/50`;

@Component({
  selector: "pc-tip-section",
  imports: [Icon, CardHeading, Input, Autofocus, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section aria-labelledby="co-tip-h" data-testid="checkout-tip" [class]="CARD">
      <div pcCardHeading headingId="co-tip-h" [icon]="HandHeart" tone="marigold" title="Tip your delivery partner" sub="100% of your tip goes to the delivery partner."></div>
      <div class="flex flex-wrap gap-2" role="group" aria-labelledby="co-tip-h">
        @for (p of presets(); track p) {
          <button type="button" [attr.aria-pressed]="!other() && tip() === p" (click)="choose(p)" [class]="!other() && tip() === p ? CHIP_ON : CHIP_OFF">{{ fmt(p) }}</button>
        }
        <button type="button" [attr.aria-pressed]="other() || custom()" (click)="openOther()" [class]="other() || custom() ? CHIP_ON : CHIP_OFF">{{ custom() && !other() ? fmt(tip()) : "Other" }}</button>
        <button type="button" [attr.aria-pressed]="!other() && tip() === 0" (click)="choose(0)" [class]="!other() && tip() === 0 ? CHIP_ON : CHIP_OFF">No tip</button>
      </div>
      @if (other()) {
        <form (submit)="addOther($event)" class="mt-3 flex flex-wrap items-start gap-2" novalidate>
          <div class="relative w-36">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-semibold text-ink-soft" aria-hidden="true">{{ symbol() }}</span>
            <input pcInput pcAutofocus [id]="inputId" inputmode="decimal" autocomplete="off" [value]="text()" [invalid]="!!error()" [attr.aria-invalid]="!!error()"
              [attr.aria-describedby]="inputId + '-help'" aria-label="Tip amount in rupees" (input)="text.set($any($event.target).value); error.set(null)" class="pl-7" />
          </div>
          <button pcButton type="submit" variant="secondary">Add tip</button>
          <button pcButton type="button" variant="ghost" (click)="other.set(false); error.set(null)">Cancel</button>
          <p [id]="inputId + '-help'" [class]="error() ? 'basis-full text-sm text-vermilion' : 'basis-full text-sm text-xs text-ink-faint'">{{ error() ?? "Up to " + fmt(max()) }}</p>
        </form>
      }
      @if (tip() > 0 && !other()) {
        <p class="mt-3 flex items-center gap-1.5 text-sm font-semibold text-leaf"><svg [pcIcon]="HandHeart" class="h-4 w-4" /> Thank you! Your {{ fmt(tip()) }} tip is added to the bill.</p>
      }
    </section>
  `,
})
export class TipSection {
  readonly presets = input.required<number[]>();
  readonly max = input.required<number>();
  readonly tip = input.required<number>();
  readonly tipChange = output<number>();
  protected readonly other = signal(false);
  protected readonly text = signal("");
  protected readonly error = signal<string | null>(null);
  protected readonly custom = computed(() => this.tip() > 0 && !this.presets().includes(this.tip()));
  protected readonly inputId = uid("co-tip");
  protected readonly fmt = rupees;
  protected readonly symbol = currencySymbol;
  protected readonly CARD = CARD;
  protected readonly CHIP_ON = CHIP_ON;
  protected readonly CHIP_OFF = CHIP_OFF;
  protected readonly HandHeart = HandHeart;

  protected choose(paise: number): void {
    this.other.set(false);
    this.error.set(null);
    this.tipChange.emit(paise);
  }

  protected openOther(): void {
    this.text.set(this.custom() ? paiseToShown(this.tip()) : "");
    this.error.set(null);
    this.other.set(true);
  }

  protected addOther(e: Event): void {
    e.preventDefault();
    const paise = shownToPaise(this.text());
    if (paise === null || paise < 100) return this.error.set(`Enter an amount of at least ${rupees(100)}`);
    if (paise > this.max()) return this.error.set(`A tip can be at most ${rupees(this.max())}`);
    this.choose(paise);
  }
}

/* ---------------------------------------------------------------- GSTIN for a business purchase */

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export type BusinessErrors = { gstin?: string; business?: string };

/** Problems with the GSTIN and business name. Nothing is checked while the GSTIN is empty (not a business purchase). */
export function businessErrors(gstin: string, business: string): BusinessErrors {
  const g = gstin.trim();
  if (!g) return {};
  const out: BusinessErrors = {};
  if (g.length !== 15) out.gstin = "A GSTIN has 15 characters";
  else if (!GSTIN_RE.test(g)) out.gstin = "This GSTIN does not look right. Check it against your GST certificate";
  const b = business.trim();
  if (!b) out.business = "Enter the business name registered for this GSTIN";
  else if (b.length < 2) out.business = "Enter the full business name";
  return out;
}

@Component({
  selector: "pc-business-section",
  imports: [Icon, IconBadge, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <section id="checkout-business" aria-labelledby="co-gst-h" data-testid="checkout-gstin" class="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
      <h2 id="co-gst-h" class="m-0">
        <button type="button" [attr.aria-expanded]="open()" aria-controls="co-gst-panel" (click)="openChange.emit(!open())" class="flex w-full items-center gap-3 rounded-xl text-left">
          <span pcIconBadge [icon]="Building2"></span>
          <span class="min-w-0 flex-1">
            <span class="block font-display text-lg font-semibold leading-tight text-ink">Add GSTIN for a business purchase</span>
            <span class="mt-0.5 block font-sans text-sm font-normal leading-snug text-ink-soft">Claim GST credit on the tax invoice.</span>
          </span>
          <svg [pcIcon]="ChevronDown" [class]="open() ? 'h-5 w-5 shrink-0 text-ink-soft transition-transform rotate-180' : 'h-5 w-5 shrink-0 text-ink-soft transition-transform'" />
        </button>
      </h2>
      @if (!open() && filled()) {
        <p [class]="valid() ? 'mt-3 flex items-center gap-1.5 text-sm font-semibold text-leaf' : 'mt-3 flex items-center gap-1.5 text-sm font-semibold text-vermilion'">
          @if (valid()) {<svg [pcIcon]="CircleCheck" class="h-4 w-4 shrink-0" />}{{ valid() ? "GSTIN " + gstin() + " · " + business().trim() : "Check the GSTIN details before you pay" }}
        </p>
      }
      @if (open()) {
        <div id="co-gst-panel" class="mt-4 grid gap-3 sm:grid-cols-2">
          <pc-text-field label="GSTIN" [value]="gstin()" [filter]="gstinFilter" (valueChange)="gstinChange.emit($event)" (blurred)="touchedGstin.set(true)"
            [maxlength]="15" autocomplete="off" placeholder="22AAAAA0000A1Z5" [error]="gstinError()" />
          <pc-text-field label="Business name" [value]="business()" (valueChange)="businessChange.emit($event)" (blurred)="touchedBusiness.set(true)"
            [maxlength]="160" autocomplete="organization" placeholder="As registered for GST" [error]="businessError()" />
          <div class="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
            <p class="text-xs text-ink-faint">Each seller prints these on their tax invoice. Check they match your GST registration.</p>
            @if (filled()) {
              <button type="button" (click)="clear()" class="text-sm font-semibold text-vermilion hover:underline">Remove GSTIN</button>
            }
          </div>
        </div>
      }
    </section>
  `,
})
export class BusinessSection {
  readonly gstin = input.required<string>();
  readonly business = input.required<string>();
  readonly open = input(false);
  readonly showErrors = input(false);
  readonly serverError = input<string | null>(null);
  readonly gstinChange = output<string>();
  readonly businessChange = output<string>();
  readonly openChange = output<boolean>();
  protected readonly touchedGstin = signal(false);
  protected readonly touchedBusiness = signal(false);
  protected readonly errors = computed(() => businessErrors(this.gstin(), this.business()));
  protected readonly filled = computed(() => this.gstin().trim() !== "");
  protected readonly valid = computed(() => this.filled() && !this.errors().gstin && !this.errors().business);
  protected readonly gstinError = computed(() => this.serverError() ?? (this.touchedGstin() || this.showErrors() ? this.errors().gstin : undefined));
  protected readonly businessError = computed(() => (this.touchedBusiness() || this.showErrors() ? this.errors().business : undefined));
  protected readonly gstinFilter = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 15);
  protected readonly Building2 = Building2;
  protected readonly ChevronDown = ChevronDown;
  protected readonly CircleCheck = CircleCheck;

  protected clear(): void {
    this.gstinChange.emit("");
    this.businessChange.emit("");
    this.touchedGstin.set(false);
    this.touchedBusiness.set(false);
  }
}

/* ---------------------------------------------------------------- no bag */

@Component({
  selector: "pc-no-bag-section",
  imports: [IconBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <label data-testid="checkout-no-bag" class="flex cursor-pointer items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
      <span pcIconBadge [icon]="Leaf" tone="leaf"></span>
      <span class="min-w-0 flex-1">
        <span class="block font-semibold text-ink">I don&apos;t need a bag</span>
        <span class="block text-sm text-ink-soft">Take the pledge for a greener future</span>
      </span>
      <input type="checkbox" role="switch" class="peer sr-only" [checked]="on()" (change)="onChange.emit($any($event.target).checked)" />
      <span aria-hidden="true" class="relative h-7 w-12 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-leaf peer-focus-visible:ring-2 peer-focus-visible:ring-peacock peer-focus-visible:ring-offset-2 after:absolute after:left-1 after:top-1 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5"></span>
    </label>
  `,
})
export class NoBagSection {
  readonly on = input(false);
  readonly onChange = output<boolean>();
  protected readonly Leaf = Leaf;
}
