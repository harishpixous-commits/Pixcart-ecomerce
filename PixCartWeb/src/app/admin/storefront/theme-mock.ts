/*
 * A miniature of the shop's home page in a theme: its header, a category block in its category style and products
 * in its grid style, in the theme's own colours, fonts, corners and shadows (the theme's CSS variables are set on
 * the wrapper). Static markup, so a gallery of them is instant. Everything is sized in em and the font size follows
 * the box's width (container units), so the miniature scales like a picture at any size.
 * Port of frontend/src/app/admin/storefront/theme-mock.tsx:  <div pcThemeMock [theme] [brand] [classicRadius] size class>
 */

import { NgTemplateOutlet } from "@angular/common";
import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { Heart, MapPin, Menu, Search, ShoppingBag, ShoppingCart, User } from "lucide-angular";
import { themeVars } from "../../themes/css";
import type { ActiveTheme, ThemeLayout } from "../../themes/types";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";

type Variant = "classic" | "bazaar" | "fresh" | "luxe";

const TINTS = ["bg-peacock-light", "bg-marigold-light", "bg-vermilion-light", "bg-leaf-light"];
const PRICES = ["499", "1,299", "249", "899", "2,199", "349"];
const OFF = [20, 35, 15, 40, 25, 10];

/** The theme's variables with corner sizes in em, so corners shrink with the miniature. */
function mockVars(theme: ActiveTheme, classicRadius?: string): Record<string, string> {
  const vars = themeVars(theme, classicRadius);
  for (const k of ["--r-lg", "--r-xl", "--r-2xl"]) vars[k] = vars[k].replace(/rem$/, "em");
  return vars;
}

/** A grey line standing for text. */
@Component({
  selector: "span[pcBar]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "cls()", "[style.width]": "w()" },
  template: ``,
})
export class MockBar {
  readonly w = input.required<string>();
  readonly tone = input<string | undefined>(undefined);
  protected readonly cls = computed(() => cx("block h-[0.5em] shrink-0 rounded-full", this.tone() ?? "bg-ink/25"));
}

const ICON = "h-[1.25em] w-[1.25em] shrink-0";

@Component({
  selector: "div[pcThemeMock]",
  imports: [Icon, MockBar, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "aria-hidden": "true", "[class]": "outer()", style: "container-type: inline-size" },
  template: `
    <div class="h-full bg-mist font-sans leading-tight text-ink" [style]="vars()">
      <!-- header -->
      @switch (variant()) {
        @case ("bazaar") {
          <div class="bg-peacock text-white">
            <div [class]="'flex h-[4.2em] items-center gap-[1em] ' + pad()">
              <span class="shrink-0 truncate font-display font-bold leading-none max-w-[9em] text-[1.5em]">{{ brand() }}</span>
              <div class="mx-auto flex h-[2.3em] w-[52%] overflow-hidden rounded-full bg-white">
                <span class="flex flex-1 items-center px-[1em]"><span pcBar w="10em" tone="bg-ink/15"></span></span>
                <span class="flex w-[3.4em] items-center justify-center bg-marigold text-ink"><svg [pcIcon]="Search" [class]="ICON" /></span>
              </div>
              <span class="flex items-center gap-[0.9em]"><svg [pcIcon]="User" [class]="ICON" /><svg [pcIcon]="Heart" [class]="ICON" /><svg [pcIcon]="ShoppingCart" [class]="ICON" /></span>
            </div>
            <div [class]="'flex h-[2.3em] items-center gap-[1.3em] bg-peacock-dark ' + pad()">
              <span class="flex h-[1.6em] items-center gap-[0.4em] rounded-lg bg-marigold px-[0.6em] text-ink"><svg [pcIcon]="Menu" class="h-[1em] w-[1em]" /><span pcBar w="4.5em" tone="bg-ink/45"></span></span>
              @for (w of bazaarNav; track $index) {<span pcBar [w]="w" tone="bg-white/45"></span>}
            </div>
          </div>
        }
        @case ("fresh") {
          <div class="border-b border-line bg-white">
            <div [class]="'flex h-[4.6em] items-center gap-[1em] ' + pad()">
              <span class="shrink-0 truncate font-display font-bold leading-none max-w-[8em] text-[1.5em] text-peacock">{{ brand() }}</span>
              <span class="flex shrink-0 items-center gap-[0.4em] rounded-full bg-mist px-[0.7em] py-[0.45em]">
                <svg [pcIcon]="MapPin" class="h-[1em] w-[1em] text-peacock" />
                <span class="flex flex-col gap-[0.3em]"><span pcBar w="3.6em" tone="bg-ink/70"></span><span pcBar w="5em" tone="bg-ink/25"></span></span>
              </span>
              <span class="flex h-[2.5em] min-w-0 flex-1 items-center gap-[0.6em] rounded-xl bg-mist px-[0.9em] text-ink-faint">
                <svg [pcIcon]="Search" [class]="ICON" /><span pcBar w="9em" tone="bg-ink/20"></span>
              </span>
              <svg [pcIcon]="User" [class]="ICON + ' text-ink-soft'" />
              <span class="flex h-[2.5em] shrink-0 items-center gap-[0.4em] rounded-lg bg-peacock px-[0.9em] text-white">
                <svg [pcIcon]="ShoppingCart" [class]="ICON" /><span pcBar w="2.4em" tone="bg-white/80"></span>
              </span>
            </div>
          </div>
        }
        @case ("luxe") {
          <div class="flex h-[1.6em] items-center justify-center bg-ink"><span pcBar w="14em" tone="bg-white/50"></span></div>
          <div class="border-b border-line bg-white text-ink">
            <div [class]="'grid h-[4.6em] grid-cols-[1fr_auto_1fr] items-center ' + pad()">
              <span class="flex items-center gap-[0.7em]"><svg [pcIcon]="Menu" [class]="ICON" /><span pcBar w="3em" tone="bg-ink/40"></span></span>
              <span class="max-w-[16em] truncate font-display text-[1.75em] uppercase leading-none tracking-[0.12em]">{{ brand() }}</span>
              <span class="flex justify-end gap-[0.9em]"><svg [pcIcon]="Search" [class]="ICON" /><svg [pcIcon]="Heart" [class]="ICON" /><svg [pcIcon]="ShoppingBag" [class]="ICON" /></span>
            </div>
            <div class="flex h-[2.2em] items-center justify-center gap-[1.8em] border-t border-line">
              @for (w of luxeNav; track $index) {<span pcBar [w]="w" tone="bg-ink/35"></span>}
            </div>
          </div>
        }
        @default {
          <div class="flex h-[1.6em] items-center justify-center bg-marigold"><span pcBar w="16em" tone="bg-ink/35"></span></div>
          <div class="bg-peacock text-white">
            <div [class]="'flex h-[4.2em] items-center gap-[1em] ' + pad()">
              <span class="shrink-0 truncate font-display font-bold leading-none max-w-[9em] text-[1.5em]">{{ brand() }}</span>
              <div class="flex h-[2.3em] min-w-0 flex-1 overflow-hidden rounded-lg bg-white">
                <span class="flex w-[4.2em] items-center justify-center border-r border-line bg-mist"><span pcBar w="2.2em"></span></span>
                <span class="flex flex-1 items-center px-[0.8em]"><span pcBar w="9em" tone="bg-ink/15"></span></span>
                <span class="flex w-[3em] items-center justify-center bg-marigold text-ink"><svg [pcIcon]="Search" [class]="ICON" /></span>
              </div>
              <span class="flex items-center gap-[0.9em]"><svg [pcIcon]="User" [class]="ICON" /><svg [pcIcon]="ShoppingCart" [class]="ICON" /></span>
            </div>
          </div>
          <div class="relative bg-white shadow-sm">
            <!-- Classic's awning edge, scaled down -->
            <span class="absolute inset-x-0 top-0 block h-[0.6em]"
              style="background-image: radial-gradient(circle at 0.6em 0, rgb(var(--c-primary)) 0.575em, transparent 0.6em); background-size: 1.2em 0.6em; background-repeat: repeat-x"></span>
            <div [class]="'flex h-[2.6em] items-end gap-[1.5em] pb-[0.6em] ' + pad()">
              <svg [pcIcon]="MapPin" class="h-[1em] w-[1em] text-ink-soft" />
              @for (w of classicNav; track $index) {<span pcBar [w]="w"></span>}
            </div>
          </div>
        }
      }
      <!-- body -->
      <div [class]="'flex flex-col ' + pad() + (plain() ? ' gap-[1.6em] py-[1.6em]' : ' gap-[1em] py-[1.2em]')">
        @if (large()) {
          <div [class]="'relative flex h-[9em] items-center overflow-hidden rounded-xl px-[2em] ' + (light() ? 'bg-peacock-light' : 'bg-gradient-to-r from-peacock-dark to-peacock')">
            <span class="relative z-10 flex flex-col items-start gap-[0.6em]">
              <span [class]="'font-display text-[1.8em] font-bold leading-none ' + (light() ? 'text-ink' : 'text-white')">New arrivals</span>
              <span pcBar w="12em" [tone]="light() ? 'bg-ink/30' : 'bg-white/60'"></span>
              <span [class]="'mt-[0.2em] rounded-lg px-[1em] text-[0.85em] font-semibold leading-[2] ' + (light() ? 'bg-peacock text-white' : variant() === 'luxe' ? 'border border-white text-white' : 'bg-marigold text-ink')">
                Shop now
              </span>
            </span>
            <span [class]="'absolute -right-[2em] -top-[3em] h-[13em] w-[13em] rounded-full ' + (light() ? 'bg-white/50' : 'bg-white/10')"></span>
            <span [class]="'absolute right-[5em] top-[2.2em] h-[4.6em] w-[4.6em] rotate-12 rounded-xl ' + (light() ? 'bg-marigold' : 'bg-marigold/90')"></span>
          </div>
        }
        <div [class]="plain() ? '' : 'rounded-xl bg-white p-[1em] shadow-panel'">
          <p [class]="'mb-[0.7em] truncate font-display font-semibold leading-none text-ink ' + (plain() ? 'text-[1.45em]' : 'text-[1.15em]')">Shop by category</p>
          @switch (layout().home.categories) {
            @case ("chips") {
              <div class="flex flex-wrap justify-center gap-[0.6em]">
                @for (w of chipWidths; track $index) {
                  <span class="flex h-[2.1em] items-center rounded-full border border-line bg-white px-[1em]"><span pcBar [w]="w" tone="bg-ink/45"></span></span>
                }
              </div>
            }
            @case ("squares") {
              <div class="grid grid-cols-8 gap-[0.55em]">
                @for (i of eight; track i) {
                  <span class="flex flex-col items-center gap-[0.45em]">
                    <span [class]="'relative block aspect-square w-full rounded-lg ' + tint(i)"><span class="absolute inset-[26%] rounded-full bg-white/60"></span></span>
                    <span pcBar w="80%"></span>
                  </span>
                }
              </div>
            }
            @case ("cards") {
              <div class="grid grid-cols-6 gap-[0.7em]">
                @for (i of six; track i) {
                  <span class="flex flex-col items-center gap-[0.5em] rounded-lg bg-white p-[0.45em] shadow-card">
                    <span [class]="'relative block aspect-square w-full rounded-lg ' + tint(i)"><span class="absolute inset-[24%] rounded-[30%] bg-white/60"></span></span>
                    <span pcBar w="70%" tone="bg-ink/35"></span>
                  </span>
                }
              </div>
            }
            @default {
              <div class="flex justify-between gap-[0.6em]">
                @for (i of six; track i) {
                  <span class="flex flex-col items-center gap-[0.5em]">
                    <span [class]="'relative block h-[3.8em] w-[3.8em] rounded-full ' + tint(i)"><span class="absolute inset-[28%] rounded-full bg-white/60"></span></span>
                    <span pcBar w="3.2em"></span>
                  </span>
                }
              </div>
            }
          }
        </div>
        <div [class]="plain() ? '' : 'rounded-xl bg-white p-[1em] shadow-panel'">
          <p [class]="'mb-[0.7em] truncate font-display font-semibold leading-none text-ink ' + (plain() ? 'text-[1.45em]' : 'text-[1.15em]')">Top picks for you</p>
          <ng-template #tileT let-i>
            <span class="flex min-w-0 flex-col gap-[0.45em]">
              <span [class]="'relative block w-full overflow-hidden rounded-lg ' + (airy() ? 'aspect-[3/4] ' : 'aspect-square ') + tint(i)">
                <span class="absolute inset-[24%] rounded-[30%] bg-white/55"></span>
                @if (variant() === "bazaar" && i % 2 === 0) {
                  <span class="absolute left-0 top-[0.6em] rounded-r-lg bg-vermilion px-[0.45em] text-[0.7em] font-bold leading-[1.6] text-white">-{{ off[i % 6] }}%</span>
                }
                @if (variant() === "classic" && i === 1) {
                  <span class="absolute left-[0.4em] top-[0.4em] rounded-lg bg-vermilion px-[0.4em] text-[0.65em] font-bold leading-[1.6] text-white">Deal</span>
                }
              </span>
              <span pcBar w="92%" tone="bg-ink/55"></span>
              <span pcBar w="58%" tone="bg-ink/25"></span>
              @if (variant() === "classic" || variant() === "bazaar") {
                <span class="flex items-center gap-[0.35em]">
                  <span class="rounded-lg bg-leaf px-[0.4em] text-[0.65em] font-semibold leading-[1.5] text-white">4.{{ 3 + (i % 5) }}★</span>
                  <span pcBar w="2em" tone="bg-ink/15"></span>
                </span>
              }
              <span class="flex items-center justify-between gap-[0.3em]">
                <span [class]="'truncate font-display text-[1.05em] leading-none text-ink ' + (variant() === 'luxe' ? 'font-medium' : 'font-bold')">₹{{ prices[i % 6] }}</span>
                @if (variant() === "fresh") {<span class="shrink-0 rounded-lg border border-peacock bg-white px-[0.5em] text-[0.7em] font-bold leading-[1.6] text-peacock">ADD</span>}
              </span>
              @if (variant() === "bazaar") {<span class="block h-[1.7em] rounded-lg bg-marigold"></span>}
            </span>
          </ng-template>
          @switch (layout().productGrid) {
            @case ("hairline") {
              <div class="grid gap-px overflow-hidden rounded-lg border border-line bg-line" [style.grid-template-columns]="cols()">
                @for (i of tiles(); track i) {<span class="block bg-white p-[0.6em]"><ng-container *ngTemplateOutlet="tileT; context: { $implicit: i }" /></span>}
              </div>
            }
            @case ("cards") {
              <div class="grid gap-[0.7em]" [style.grid-template-columns]="cols()">
                @for (i of tiles(); track i) {<span class="block rounded-xl bg-white p-[0.5em] shadow-card"><ng-container *ngTemplateOutlet="tileT; context: { $implicit: i }" /></span>}
              </div>
            }
            @default {
              <div class="grid gap-[1.1em]" [style.grid-template-columns]="cols()">
                @for (i of tiles(); track i) {<ng-container *ngTemplateOutlet="tileT; context: { $implicit: i }" />}
              </div>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class ThemeMock {
  readonly theme = input.required<ActiveTheme>();
  readonly brand = input.required<string>();
  readonly classicRadius = input<string | undefined>(undefined);
  /** "card": the gallery and the live card (4:3, four products); "large": the editor (natural height, a banner, as many products as the theme shows per row) */
  readonly size = input<"card" | "large">("card");

  protected readonly ICON = ICON;
  protected readonly Heart = Heart;
  protected readonly MapPin = MapPin;
  protected readonly Menu = Menu;
  protected readonly Search = Search;
  protected readonly ShoppingBag = ShoppingBag;
  protected readonly ShoppingCart = ShoppingCart;
  protected readonly User = User;
  protected readonly bazaarNav = ["3em", "4em", "3.4em", "4.6em", "3em"];
  protected readonly luxeNav = ["3em", "3.6em", "2.6em", "4em", "3em"];
  protected readonly classicNav = ["3.4em", "4em", "3em", "4.4em", "3.2em", "3.8em"];
  protected readonly chipWidths = ["3em", "4.2em", "2.6em", "3.6em", "4.6em", "3em"];
  protected readonly six = [0, 1, 2, 3, 4, 5];
  protected readonly eight = [0, 1, 2, 3, 4, 5, 6, 7];
  protected readonly prices = PRICES;
  protected readonly off = OFF;

  protected readonly large = computed(() => this.size() === "large");
  protected readonly layout = computed<ThemeLayout>(() => this.theme().data.layout);
  protected readonly variant = computed<Variant>(() => {
    const d = this.theme().data;
    return (["classic", "bazaar", "fresh", "luxe"] as const).find((v) => v === d.id) ?? (d.chrome === "light" ? "fresh" : "classic");
  });
  protected readonly plain = computed(() => this.layout().home.sections === "plain");
  protected readonly pad = computed(() => (this.layout().container === "wide" ? "px-[1.4em]" : "px-[3.6em]"));
  protected readonly light = computed(() => this.variant() === "fresh");
  protected readonly airy = computed(() => this.layout().productGrid !== "hairline" && this.layout().productGrid !== "cards");
  protected readonly n = computed(() => (this.large() ? this.layout().gridColumns : 4));
  protected readonly tiles = computed(() => Array.from({ length: this.n() }, (_, i) => i));
  protected readonly cols = computed(() => `repeat(${this.n()}, minmax(0, 1fr))`);
  protected readonly outer = computed(() => cx("pointer-events-none select-none overflow-hidden", !this.large() && "aspect-[4/3]"));
  protected readonly vars = computed(() => ({ ...mockVars(this.theme(), this.classicRadius()), "font-size": "2cqw" }));
  protected tint(i: number): string {
    return TINTS[i % 4];
  }
}
