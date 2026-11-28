/*
 * Admin → Storefront → Brand and colours, and Navigation and footer: the store name, logo, colours, announcement bar,
 * search engine fields, the navigation bar, menus and footer columns. The page keeps the draft and saves it.
 * Port of frontend/src/app/admin/storefront/brand.tsx.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from "@angular/core";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-angular";
import { api } from "../../core/api";
import { SiteService } from "../../core/site";
import { fillTokens } from "../../core/tokens";
import type { LinkItem, Site } from "../../core/types";
import { Icon } from "../../shared/ui/icon";
import { Button, Field, Input, Select, Textarea, TextField } from "../../shared/ui/ui";
import { ImageField } from "../shared/media-picker";

type Colors = Site["colors"];

const COLOR_FIELDS: [keyof Colors, string, string][] = [
  ["primary", "Main colour", "Header, links, main buttons"],
  ["primary_dark", "Main colour, dark", "Hover states and footer"],
  ["accent", "Highlight", "Announcement bar, ratings, badges"],
  ["buy", "Buy button", "Buy now, sale prices, errors"],
  ["success", "Success", "Discounts, in-stock, confirmations"],
  ["page", "Page background", "Behind the white cards"],
];

const PRESETS: { name: string; colors: Colors }[] = [
  { name: "Peacock", colors: { primary: "#0B5563", primary_dark: "#073B45", accent: "#F5A524", buy: "#D7263D", success: "#1E8E3E", page: "#EEF2F4" } },
  { name: "Indigo", colors: { primary: "#2E3A8C", primary_dark: "#1E2763", accent: "#FFB703", buy: "#E63946", success: "#2A9D8F", page: "#F1F2F8" } },
  { name: "Kanjivaram", colors: { primary: "#7A1F3D", primary_dark: "#54142A", accent: "#D4A017", buy: "#C2410C", success: "#15803D", page: "#F7F1EE" } },
  { name: "Banana leaf", colors: { primary: "#1F6F3F", primary_dark: "#14492A", accent: "#F2C14E", buy: "#D1495B", success: "#2D9A54", page: "#EFF4EE" } },
  { name: "Charcoal", colors: { primary: "#22303C", primary_dark: "#151E26", accent: "#FF8C42", buy: "#E4572E", success: "#3A9D5D", page: "#F0F1F2" } },
];

const trim = (v: string) => v.trim();

@Component({
  selector: "pc-brand-editor",
  imports: [ImageField, TextField, Field, Input, Select, Textarea],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "grid gap-4 xl:grid-cols-[1fr_360px]" },
  template: `
    <div class="flex flex-col gap-4">
      <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 class="text-lg font-semibold sm:col-span-2">Brand</h2>
        <pc-text-field label="Store name" [value]="site().brand_name" maxlength="40" (valueChange)="set({ brand_name: $event })" />
        <pc-text-field label="Tagline" [value]="site().tagline" maxlength="120" (valueChange)="set({ tagline: $event })" />
        <pc-image-field label="Logo" [value]="site().logo_url" (valueChange)="set({ logo_url: $event })" aspect="aspect-[3/1]" hint="Wide logo on a transparent background. Without a logo the store name is shown." />
        <pc-image-field label="Browser tab icon" [value]="site().favicon_url" (valueChange)="set({ favicon_url: $event })" aspect="aspect-square" hint="Square, at least 192 × 192" />
      </section>
      <section class="rounded-xl bg-white p-5">
        <h2 class="mb-1 text-lg font-semibold">Colours</h2>
        <p class="mb-3 text-sm text-ink-soft">Start from a preset, then adjust. Keep text readable: dark main colours work best with white text.</p>
        <div class="mb-4 flex flex-wrap gap-2">
          @for (p of presets; track p.name) {
            <button type="button" (click)="set({ colors: p.colors })" class="flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-3 text-sm hover:border-peacock">
              <span class="flex overflow-hidden rounded-full">@for (x of [p.colors.primary, p.colors.accent, p.colors.buy]; track x) {<span class="h-5 w-3" [style.background]="x"></span>}</span>
              {{ p.name }}
            </button>
          }
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          @for (f of colorFields; track f[0]) {
            <div>
              <p class="font-medium">{{ f[1] }}</p>
              <div class="mt-1 flex items-center gap-2">
                <input type="color" [value]="c()[f[0]]" (input)="setColor(f[0], $any($event.target).value.toUpperCase())" class="h-10 w-12 cursor-pointer rounded border border-line bg-white p-0.5" [attr.aria-label]="f[1]" />
                <input pcInput [value]="c()[f[0]]" (input)="setColor(f[0], $any($event.target).value)" maxlength="7" class="font-mono uppercase" [attr.aria-label]="f[1] + ' hex'" />
              </div>
              <p class="mt-0.5 text-xs text-ink-faint">{{ f[2] }}</p>
            </div>
          }
        </div>
        <pc-field label="Corners" for="rad" class="mt-4 max-w-xs">
          <select pcSelect id="rad" (change)="set({ radius: $any($event.target).value })">
            <option value="rounded" [selected]="site().radius === 'rounded'">Rounded</option><option value="soft" [selected]="site().radius === 'soft'">Slightly rounded</option><option value="square" [selected]="site().radius === 'square'">Square</option>
          </select>
        </pc-field>
      </section>
      <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 class="text-lg font-semibold sm:col-span-2">Announcement bar</h2>
        <label class="flex items-center gap-2 sm:col-span-2"><input type="checkbox" class="accent-peacock" [checked]="site().announcement.enabled" (change)="setAnn({ enabled: $any($event.target).checked })" /> Show the bar above the header</label>
        <pc-text-field class="sm:col-span-2" label="Message" [value]="site().announcement.text" maxlength="160" (valueChange)="setAnn({ text: $event })" />
        <pc-text-field label="Link (optional)" [value]="site().announcement.link" placeholder="/search?sort=discount" (valueChange)="setAnn({ link: $event })" />
        <pc-field label="Style" for="tone">
          <select pcSelect id="tone" (change)="setAnn({ tone: $any($event.target).value })">
            <option value="accent" [selected]="site().announcement.tone === 'accent'">Highlight colour</option><option value="primary" [selected]="site().announcement.tone === 'primary'">Main colour</option><option value="dark" [selected]="site().announcement.tone === 'dark'">Dark</option>
          </select>
        </pc-field>
      </section>
      <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
        <h2 class="text-lg font-semibold sm:col-span-2">Search engines and tracking</h2>
        <pc-text-field class="sm:col-span-2" label="Home page title" [value]="site().seo.title" maxlength="70" [hint]="site().seo.title.length + ' of 70 characters'" (valueChange)="set({ seo: { ...site().seo, title: $event } })" />
        <pc-field label="Home page description" class="sm:col-span-2" [hint]="site().seo.description.length + ' of 170 characters. Shown under your link in Google.'">
          <textarea pcTextarea rows="2" maxlength="170" [value]="site().seo.description" (input)="set({ seo: { ...site().seo, description: $any($event.target).value } })"></textarea>
        </pc-field>
        <pc-text-field label="Google Analytics ID" placeholder="G-XXXXXXXXXX" [value]="site().analytics.google_analytics_id" [filter]="trim" (valueChange)="set({ analytics: { ...site().analytics, google_analytics_id: $event } })" />
        <pc-text-field label="Meta Pixel ID" placeholder="Numbers only" [value]="site().analytics.meta_pixel_id" [filter]="trim" (valueChange)="set({ analytics: { ...site().analytics, meta_pixel_id: $event } })" />
      </section>
    </div>
    <!-- Live preview with the chosen colours -->
    <aside class="self-start xl:sticky xl:top-20">
      <p class="mb-2 text-sm font-semibold text-ink-soft">Preview</p>
      <div class="overflow-hidden rounded-xl border border-line shadow-sm" [style.background]="c().page">
        @if (site().announcement.enabled) {
          <div class="px-3 py-1.5 text-center text-xs font-semibold" [style.background]="annBg()" [style.color]="site().announcement.tone === 'accent' ? '#1f2933' : '#fff'">{{ annText() }}</div>
        }
        <div class="flex items-center gap-2 px-3 py-3" [style.background]="c().primary">
          @if (site().logo_url) {
            <img [src]="site().logo_url" alt="" class="h-7 max-w-[120px] object-contain" />
          } @else {<span class="font-display text-xl font-bold text-white">{{ site().brand_name }}</span>}
          <span class="ml-auto h-7 flex-1 rounded bg-white/95" [style.border-radius]="radius()"></span>
        </div>
        <div class="p-3">
          <div class="bg-white p-3" [style.border-radius]="radius()">
            <div class="mb-2 aspect-square w-full" [style.background]="c().primary + '22'" [style.border-radius]="radius()"></div>
            <p class="text-sm font-medium text-ink">Cotton kurta, sky blue</p>
            <p class="text-xs" [style.color]="c().accent">★★★★☆ <span class="text-ink-faint">(128)</span></p>
            <p class="mt-1"><span class="font-bold">₹699</span>&ngsp;<span class="text-xs text-ink-faint line-through">₹1,299</span>&ngsp;<span class="text-xs font-semibold" [style.color]="c().success">46% off</span></p>
            <div class="mt-2 grid grid-cols-2 gap-2">
              <span class="py-2 text-center text-sm font-semibold text-white" [style.background]="c().primary" [style.border-radius]="radius()">Add to cart</span>
              <span class="py-2 text-center text-sm font-semibold text-white" [style.background]="c().buy" [style.border-radius]="radius()">Buy now</span>
            </div>
          </div>
        </div>
        <div class="px-3 py-3 text-xs text-white/80" [style.background]="c().primary_dark">{{ site().tagline }}</div>
      </div>
    </aside>
  `,
})
export class BrandEditor {
  readonly site = input.required<Site>();
  readonly siteChange = output<Site>();
  /** the free-delivery amount comes from Marketplace settings, not from this draft */
  private readonly live = inject(SiteService).site;
  protected readonly presets = PRESETS;
  protected readonly colorFields = COLOR_FIELDS;
  protected readonly trim = trim;
  protected readonly c = computed(() => this.site().colors);
  protected readonly radius = computed(() => (this.site().radius === "square" ? "4px" : this.site().radius === "soft" ? "10px" : "16px"));
  protected readonly annBg = computed(() => {
    const t = this.site().announcement.tone;
    return t === "accent" ? this.c().accent : t === "primary" ? this.c().primary_dark : "#1f2933";
  });
  protected readonly annText = computed(() => fillTokens(this.site().announcement.text, { brand_name: this.site().brand_name, free_shipping_threshold_paise: this.live().free_shipping_threshold_paise }));

  protected set(p: Partial<Site>): void {
    this.siteChange.emit({ ...this.site(), ...p });
  }
  protected setColor(k: keyof Colors, v: string): void {
    this.set({ colors: { ...this.c(), [k]: v } });
  }
  protected setAnn(p: Partial<Site["announcement"]>): void {
    this.set({ announcement: { ...this.site().announcement, ...p } });
  }
}

/* ------------------------------------------------------------------ menus */

@Component({
  selector: "pc-links-editor",
  imports: [Input, Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-2" },
  template: `
    @for (l of links(); track $index; let i = $index) {
      <div class="flex items-center gap-2">
        <input pcInput [value]="l.label" placeholder="Label" maxlength="40" (input)="patch(i, { label: $any($event.target).value })" aria-label="Link label" />
        <input pcInput [value]="l.href" placeholder="/pages/about or https://" (input)="patch(i, { href: $any($event.target).value })" aria-label="Link address" />
        <button type="button" aria-label="Move up" class="rounded p-1.5 hover:bg-mist" (click)="move(i, -1)"><svg [pcIcon]="ArrowUp" class="h-4 w-4" /></button>
        <button type="button" aria-label="Move down" class="rounded p-1.5 hover:bg-mist" (click)="move(i, 1)"><svg [pcIcon]="ArrowDown" class="h-4 w-4" /></button>
        <button type="button" aria-label="Remove link" class="rounded p-1.5 text-vermilion hover:bg-mist" (click)="linksChange.emit(without(i))"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>
      </div>
    }
    @if (links().length < max()) {<button pcButton type="button" size="sm" variant="ghost" class="self-start" (click)="linksChange.emit([...links(), { label: '', href: '/' }])"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add link</button>}
    @if (links().length < max() && cols().length > 0) {
      <select class="self-start rounded-md border border-line bg-white px-2 py-1.5 text-sm" aria-label="Add a collection link" (change)="addCol($any($event.target))">
        <option value="">Add a collection link...</option>
        @for (c of cols(); track c.slug) { <option [value]="c.slug">{{ c.title }}</option> }
      </select>
    }
  `,
})
export class LinksEditor {
  readonly links = input.required<LinkItem[]>();
  readonly max = input.required<number>();
  readonly linksChange = output<LinkItem[]>();
  protected readonly cols = signal<{ slug: string; title: string }[]>([]);
  constructor() {
    api<{ items: { slug: string; title: string }[] }>("/api/catalog/collections").then((r) => this.cols.set(r.items)).catch(() => this.cols.set([]));
  }
  protected addCol(el: HTMLSelectElement): void {
    const c = this.cols().find((x) => x.slug === el.value);
    el.value = "";
    if (c) this.linksChange.emit([...this.links(), { label: c.title.slice(0, 40), href: `/collections/${c.slug}` }]);
  }
  protected readonly ArrowUp = ArrowUp;
  protected readonly ArrowDown = ArrowDown;
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected patch(i: number, p: Partial<LinkItem>): void {
    this.linksChange.emit(this.links().map((x, j) => (j === i ? { ...x, ...p } : x)));
  }
  protected without(i: number): LinkItem[] {
    return this.links().filter((_, j) => j !== i);
  }
  protected move(i: number, d: number): void {
    const n = [...this.links()];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    this.linksChange.emit(n);
  }
}

@Component({
  selector: "label[pcCheck]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-start gap-3 rounded-lg border border-line p-3" },
  template: `
    <input type="checkbox" class="mt-1 h-4 w-4 accent-peacock" [checked]="checked()" (change)="checkedChange.emit($any($event.target).checked)" [attr.data-testid]="testid() || null" />
    <span><span class="font-semibold">{{ label() }}</span><br /><span class="text-sm text-ink-soft">{{ hint() }}</span></span>
  `,
})
export class Check {
  readonly checked = input.required<boolean>();
  readonly label = input.required<string>();
  readonly hint = input.required<string>();
  readonly testid = input<string>("");
  readonly checkedChange = output<boolean>();
}

@Component({
  selector: "pc-words-editor",
  imports: [Input, Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-2" },
  template: `
    <ul class="flex flex-wrap gap-2">
      @for (w of words(); track w + "-" + $index; let i = $index) {
        <li class="flex items-center gap-1 rounded-full bg-peacock-light py-1 pl-3 pr-1 text-sm">
          <input pcInput [value]="w" maxlength="40" (input)="set(i, $any($event.target).value)" aria-label="Search words"
            class="h-7 w-36 border-0 bg-transparent px-0 focus:ring-0" />
          <button type="button" [attr.aria-label]="'Remove ' + w" class="rounded-full p-0.5 hover:bg-white" (click)="wordsChange.emit(without(i))"><svg [pcIcon]="Trash2" class="h-3.5 w-3.5" /></button>
        </li>
      }
    </ul>
    @if (words().length < max()) {<button pcButton type="button" size="sm" variant="ghost" class="self-start" (click)="wordsChange.emit([...words(), ''])"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add search</button>}
  `,
})
export class WordsEditor {
  readonly words = input.required<string[]>();
  readonly max = input.required<number>();
  readonly wordsChange = output<string[]>();
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected set(i: number, v: string): void {
    this.wordsChange.emit(this.words().map((x, j) => (j === i ? v : x)));
  }
  protected without(i: number): string[] {
    return this.words().filter((_, j) => j !== i);
  }
}

@Component({
  selector: "pc-nav-editor",
  imports: [LinksEditor, Check, WordsEditor, TextField, Field, Select, Input, Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex max-w-4xl flex-col gap-4" },
  template: `
    <section class="rounded-xl bg-white p-5" data-testid="nav-editor">
      <h2 class="mb-1 text-lg font-semibold">Navigation bar</h2>
      <p class="mb-3 text-sm text-ink-soft">The bar under the search box: the All menu, the delivery PIN, your links and the main categories. On phones it scrolls sideways.</p>
      <div class="grid gap-3 sm:grid-cols-3">
        <label pcCheck [checked]="nav().all_menu" (checkedChange)="setNav({ all_menu: $event })" label="All menu" hint="A side menu with every category, the deal and bestseller lists, and help." testid="nav-all-menu"></label>
        <label pcCheck [checked]="nav().search_categories" (checkedChange)="setNav({ search_categories: $event })" label="Category in search" hint="A department picker in front of the search box (large screens)."></label>
        <label pcCheck [checked]="nav().show_categories" (checkedChange)="setNav({ show_categories: $event })" label="Categories in the bar" hint="Main categories after your links."></label>
      </div>
      <h3 class="mb-2 mt-4 font-semibold">Links in the bar (up to 12)</h3>
      <pc-links-editor [links]="nav().links" [max]="12" (linksChange)="setNav({ links: $event })" />
      <h3 class="mb-2 mt-4 font-semibold">Promotion at the end of the bar</h3>
      <div class="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-end">
        <label class="flex items-center gap-2 sm:pb-2.5"><input type="checkbox" class="h-4 w-4 accent-peacock" [checked]="nav().promo.enabled" (change)="setPromo({ enabled: $any($event.target).checked })" /> Show</label>
        <pc-text-field label="Text" [value]="nav().promo.text" maxlength="60" placeholder="Diwali sale is live" (valueChange)="setPromo({ text: $event })" />
        <pc-text-field label="Link (optional)" [value]="nav().promo.link" placeholder="/deals" (valueChange)="setPromo({ link: $event })" />
        <pc-field label="Colour">
          <select pcSelect (change)="setPromo({ tone: $any($event.target).value })">
            @for (o of promoTones; track o[0]) {<option [value]="o[0]" [selected]="o[0] === nav().promo.tone">{{ o[1] }}</option>}
          </select>
        </pc-field>
      </div>
    </section>
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">All menu: extra links</h2>
      <p class="mb-3 text-sm text-ink-soft">Shown at the end of the All menu, after the categories. {{ "{brand}" }} becomes your store name. Up to 10.</p>
      <pc-links-editor [links]="nav().drawer_links" [max]="10" (linksChange)="setNav({ drawer_links: $event })" />
    </section>
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">Trending searches</h2>
      <p class="mb-3 text-sm text-ink-soft">Suggested when a shopper taps the empty search box, after their own recent searches. Up to 10.</p>
      <pc-words-editor [words]="nav().trending" [max]="10" (wordsChange)="setNav({ trending: $event })" />
    </section>
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">Header links</h2>
      <p class="mb-3 text-sm text-ink-soft">Shown next to the account menu on large screens and in the menu on phones, e.g. Become a seller. Up to 6.</p>
      <pc-links-editor [links]="site().header_links" [max]="6" (linksChange)="set({ header_links: $event })" />
    </section>
    <section class="grid gap-3 rounded-xl bg-white p-5 sm:grid-cols-2">
      <h2 class="text-lg font-semibold sm:col-span-2">On every page</h2>
      <label pcCheck [checked]="extras().back_to_top" (checkedChange)="set({ home_extras: { ...extras(), back_to_top: $event } })" label="Back to top" hint="A button that appears after scrolling down a long page."></label>
      <label pcCheck [checked]="extras().signin_prompt" (checkedChange)="set({ home_extras: { ...extras(), signin_prompt: $event } })" label="Sign-in prompt" hint="Shows the home page's Sign-in prompt section to visitors who are not signed in. Off hides it everywhere."></label>
    </section>
    <section class="rounded-xl bg-white p-5">
      <h2 class="mb-1 text-lg font-semibold">Footer</h2>
      <p class="mb-3 text-sm text-ink-soft">Up to 5 columns of links. Link to your own pages with /pages/page-address.</p>
      <div class="flex flex-col gap-4">
        @for (col of cols(); track $index; let i = $index) {
          <div class="rounded-lg border border-line p-3">
            <div class="mb-2 flex items-center gap-2">
              <input pcInput [value]="col.title" placeholder="Column title" maxlength="40" class="max-w-xs font-semibold" (input)="setCol(i, { title: $any($event.target).value })" aria-label="Column title" />
              <button pcButton type="button" size="sm" variant="ghost" (click)="removeCol(i)"><svg [pcIcon]="Trash2" class="h-4 w-4" /> Remove column</button>
            </div>
            <pc-links-editor [links]="col.links" [max]="10" (linksChange)="setCol(i, { links: $event })" />
          </div>
        }
        @if (cols().length < 5) {<button pcButton type="button" variant="secondary" class="self-start" (click)="set({ footer_columns: [...cols(), { title: 'New column', links: [] }] })"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add column</button>}
      </div>
    </section>
  `,
})
export class NavEditor {
  readonly site = input.required<Site>();
  readonly siteChange = output<Site>();
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly promoTones = [["accent", "Highlight"], ["buy", "Buy button"], ["primary", "Main colour"], ["dark", "Dark"]];
  protected readonly cols = computed(() => this.site().footer_columns);
  protected readonly nav = computed(() => this.site().nav);
  protected readonly extras = computed(() => this.site().home_extras ?? { back_to_top: true, signin_prompt: true });

  protected set(p: Partial<Site>): void {
    this.siteChange.emit({ ...this.site(), ...p });
  }
  protected setNav(n: Partial<Site["nav"]>): void {
    this.set({ nav: { ...this.nav(), ...n } });
  }
  protected setPromo(p: Partial<Site["nav"]["promo"]>): void {
    this.setNav({ promo: { ...this.nav().promo, ...p } });
  }
  protected setCol(i: number, p: Partial<Site["footer_columns"][number]>): void {
    this.set({ footer_columns: this.cols().map((c, j) => (j === i ? { ...c, ...p } : c)) });
  }
  protected removeCol(i: number): void {
    this.set({ footer_columns: this.cols().filter((_, j) => j !== i) });
  }
}
