/*
 * Admin → Storefront → Home page: the home page sections from top to bottom, each with its own settings (banners,
 * products, cards, countdowns, text ...), device, schedule and visibility. Port of
 * frontend/src/app/admin/storefront/sections.tsx.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from "@angular/core";
import { ArrowDown, ArrowUp, Eye, EyeOff, Monitor, Plus, Smartphone, Trash2 } from "lucide-angular";
import { api, ApiError, quietly } from "../../core/api";
import { date } from "../../core/format";
import type { CategoryNode, ProductCard } from "../../core/types";
import { Markdown } from "../../shared/chrome/markdown";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Input, Modal, Pill, Select, Textarea, TextField, Toast } from "../../shared/ui/ui";
import { ImageField, MediaField } from "../shared/media-picker";

type Section = { id: string; kind: string; kind_label: string; title: string; config: Record<string, any>; is_active: boolean; device: "all" | "mobile" | "desktop"; starts_at: string | null; ends_at: string | null };
type Cat = { slug: string; label: string };

const KIND_HELP: Record<string, string> = {
  hero: "Large sliding banners at the top of the page",
  categories: "Category circles, cards, squares or chips (the theme's style unless you pick one)",
  media: "A large picture or video with an optional heading, text and button, in the shape you choose",
  products: "A row or grid of products: deals, bestsellers, new, a category, or ones you pick",
  banner: "One wide banner with a link",
  banner_grid: "2 to 4 banners side by side",
  text: "A paragraph, heading or note, written in simple formatting",
  usp: "A strip of short promises such as cash on delivery or easy returns",
  recent: "Products the shopper looked at recently (only shown if there are any)",
  cards: "Up to 4 cards side by side, each with 4 picture tiles or products, like the top of the big stores",
  deals: "Running deals with live countdowns and claimed bars",
  sponsored: "Products sellers pay to promote, marked Sponsored",
  countdown: "A banner with a live countdown to the end of a sale",
  signin: "Asks visitors to sign in for recommendations (hidden once signed in)",
  inspired: "Popular products from the categories the shopper browsed",
  buy_again: "Products the shopper ordered before (signed-in shoppers)",
};

const STARTER: Record<string, Record<string, any>> = {
  hero: { slides: [{ image: "", heading: "", text: "", cta: "Shop now", link: "/search", image_mobile: "", offer: "", note: "", theme: "light", align: "left" }], autoplay: true, interval: 5, style: "fade" },
  categories: { slugs: [], style: "auto" },
  media: { image: "", video: "", link: "", heading: "", text: "", cta: "", align: "left", tone: "light", aspect: "16/9", width: "contained", controls: false },
  products: { source: "deals", limit: 12, layout: "row", show_add: false, ranked: false, see_all: "" },
  cards: { cards: [{ title: "Top picks for you", link: "/search", link_text: "See more", mode: "tiles", tiles: [{ image: "", label: "", link: "/search", badge: "" }] }] },
  deals: { limit: 12, kind: "" },
  sponsored: { limit: 10 },
  countdown: { heading: "The big sale ends soon", text: "", ends_at: "", link: "/deals", cta: "Shop the sale", image: "", tone: "buy" },
  signin: { heading: "See personalised recommendations", text: "" },
  inspired: { limit: 12 },
  buy_again: { limit: 12 },
  banner: { image: "", heading: "", text: "", cta: "", link: "/search" },
  banner_grid: { items: [{ image: "", link: "/search", heading: "", text: "", cta: "" }, { image: "", link: "/search", heading: "", text: "", cta: "" }] },
  text: { markdown: "## A heading\n\nWrite something for your shoppers.", align: "left" },
  usp: { items: [{ icon: "badge", text: "Verified sellers" }, { icon: "wallet", text: "Cash on delivery" }, { icon: "return", text: "Easy returns" }] },
  recent: {},
};

const ICONS = [["badge", "Verified badge"], ["wallet", "Wallet"], ["truck", "Delivery truck"], ["return", "Return arrow"], ["shield", "Shield"], ["gift", "Gift"], ["support", "Headset"], ["check", "Tick"]];
const SOURCES = [["deals", "Biggest discounts"], ["deals_live", "Running deals (with timers)"], ["bestsellers", "Bestsellers"], ["new", "Newest"], ["top_rated", "Top rated"], ["category", "From one category"], ["collection", "One of your collections"], ["manual", "Products I pick"]];
const CARD_SOURCES = SOURCES.filter(([v]) => v !== "manual" && v !== "collection");
const CARD_MODES = [["tiles", "4 picture tiles"], ["products", "4 products"], ["recent", "Recently viewed (the shopper's own)"], ["buy_again", "Buy it again (the shopper's own)"]];
const DEAL_KIND_LABEL = [["", "All kinds"], ["lightning", "Lightning deals"], ["deal_of_day", "Deal of the Day"], ["limited", "Limited time deals"]];

const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : "");
const digits = (v: string) => v.replace(/\D/g, "");
/** "How many" boxes: digits only, at least the given number when empty (the reference's `Number(...) || n`) */
const countFilter = (min: number) => (v: string) => String(Number(digits(v)) || min);
const intervalFilter = (v: string) => String(Math.max(3, Math.min(10, Number(digits(v)) || 5)));

function flatten(nodes: CategoryNode[], prefix = ""): Cat[] {
  return nodes.flatMap((n) => [{ slug: n.slug, label: prefix + n.name }, ...flatten(n.children ?? [], `${prefix}${n.name} › `)]);
}

/* ------------------------------------------------------------------ a banner or slide */

@Component({
  selector: "pc-section-slide",
  imports: [ImageField, MediaField, TextField, Field, Select, Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2" },
  template: `
    <div [class]="hero() ? '' : 'sm:col-span-2'">
      <pc-image-field [label]="hero() ? 'Image (computers and tablets)' : 'Image'" [value]="v().image" (valueChange)="patch({ image: $event })"
        [hint]="hero() ? 'Wide, about 3000 × 1000 px. Keep words out of the image.' : 'Keep words out of the image; add them below so they stay sharp on phones'" />
    </div>
    @if (hero()) {<pc-image-field label="Phone image (optional)" [value]="v().image_mobile ?? ''" (valueChange)="patch({ image_mobile: $event })" hint="Taller, about 1200 × 900 px. Empty: the wide image is used" />}
    <div class="sm:col-span-2"><pc-media-field label="Video (optional)" accept="video" [value]="v().video ?? ''" [poster]="v().image" (valueChange)="patch({ video: $event })"
      hint="Plays muted on a loop in place of the image. The image shows until it loads, and for shoppers who turn off motion. MP4 or WebM." /></div>
    <pc-text-field label="Heading" [value]="v().heading" maxlength="80" (valueChange)="patch({ heading: $event })" />
    <pc-text-field label="Short text" [value]="v().text" maxlength="160" (valueChange)="patch({ text: $event })" />
    <pc-text-field label="Button text" [value]="v().cta" maxlength="30" (valueChange)="patch({ cta: $event })" />
    <pc-text-field label="Link" [value]="v().link" placeholder="/c/fashion or /search?q=saree" (valueChange)="patch({ link: $event })" />
    @if (hero()) {
      <pc-text-field label="Offer line (optional)" [value]="v().offer ?? ''" maxlength="80" placeholder="Up to 10% off with bank cards" (valueChange)="patch({ offer: $event })" />
      <pc-text-field label="Small print (optional)" [value]="v().note ?? ''" maxlength="60" placeholder="T&C apply" (valueChange)="patch({ note: $event })" />
      <pc-field label="Text colour">
        <select pcSelect (change)="patch({ theme: $any($event.target).value })">
          <option value="light" [selected]="(v().theme ?? 'light') === 'light'">Dark text on a light image</option><option value="dark" [selected]="v().theme === 'dark'">White text on a dark image</option>
        </select>
      </pc-field>
      <pc-field label="Text position">
        <select pcSelect (change)="patch({ align: $any($event.target).value })">
          <option value="left" [selected]="(v().align ?? 'left') === 'left'">Left</option><option value="center" [selected]="v().align === 'center'">Centre</option>
        </select>
      </pc-field>
    }
    @if (removable()) {<button pcButton type="button" size="sm" variant="ghost" class="self-start" (click)="remove.emit()"><svg [pcIcon]="Trash2" class="h-4 w-4" /> Remove</button>}
  `,
})
export class SectionSlide {
  readonly v = input.required<any>();
  readonly hero = input(false);
  readonly removable = input(false);
  readonly vChange = output<any>();
  readonly remove = output<void>();
  protected readonly Trash2 = Trash2;
  protected patch(p: Record<string, any>): void {
    this.vChange.emit({ ...this.v(), ...p });
  }
}

/* ------------------------------------------------------------------ a card of the "cards" section */

@Component({
  selector: "pc-section-card",
  imports: [ImageField, MediaField, TextField, Field, Select, Input, Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-3 rounded-lg border border-line p-3" },
  template: `
    <div class="grid gap-3 sm:grid-cols-2">
      <pc-text-field label="Card title" [value]="card().title" maxlength="60" (valueChange)="patch({ title: $event })" [required]="true" />
      <pc-field label="Shows">
        <select pcSelect (change)="setMode($any($event.target).value)">
          @for (m of modes; track m[0]) {<option [value]="m[0]" [selected]="m[0] === card().mode">{{ m[1] }}</option>}
        </select>
      </pc-field>
      <pc-text-field label="Link at the bottom" [value]="card().link" placeholder="/deals" (valueChange)="patch({ link: $event })" />
      <pc-text-field label="Link text" [value]="card().link_text" maxlength="30" placeholder="See more" (valueChange)="patch({ link_text: $event })" />
      @if (card().mode === "products") {
        <pc-field label="Products from">
          <select pcSelect (change)="patch({ source: $any($event.target).value })">@for (s of cardSources; track s[0]) {<option [value]="s[0]" [selected]="s[0] === (card().source ?? 'deals')">{{ s[1] }}</option>}</select>
        </pc-field>
      }
      @if (card().mode === "products" && card().source === "category") {
        <pc-field label="Category">
          <select pcSelect (change)="patch({ category_slug: $any($event.target).value })"><option value="" [selected]="!card().category_slug">Choose</option>@for (x of cats(); track x.slug) {<option [value]="x.slug" [selected]="x.slug === card().category_slug">{{ x.label }}</option>}</select>
        </pc-field>
      }
    </div>
    @if (card().mode === "tiles") {
      <div class="grid gap-2 sm:grid-cols-2">
        @for (t of tiles(); track $index; let i = $index) {
          <div class="flex flex-col gap-2 rounded-lg bg-mist p-2">
            <pc-image-field [label]="'Tile ' + (i + 1) + ' image'" [value]="t.image" (valueChange)="setTile(i, { image: $event })" />
            <pc-media-field [label]="'Tile ' + (i + 1) + ' video (optional)'" accept="video" layout="compact" aspect="aspect-square" [value]="t.video ?? ''" [poster]="t.image"
              (valueChange)="setTile(i, { video: $event })" hint="Plays while a shopper points at the tile" />
            <div class="grid grid-cols-2 gap-2">
              <input pcInput [value]="t.label" maxlength="30" placeholder="Label" [attr.aria-label]="'Tile ' + (i + 1) + ' label'" (input)="setTile(i, { label: $any($event.target).value })" />
              <input pcInput [value]="t.badge ?? ''" maxlength="20" placeholder="Badge, e.g. 40% off" [attr.aria-label]="'Tile ' + (i + 1) + ' badge'" (input)="setTile(i, { badge: $any($event.target).value })" />
            </div>
            <input pcInput [value]="t.link" placeholder="/c/fashion" [attr.aria-label]="'Tile ' + (i + 1) + ' link'" (input)="setTile(i, { link: $any($event.target).value })" />
            @if (tiles().length > 1) {<button type="button" class="self-start text-sm text-vermilion hover:underline" (click)="removeTile(i)">Remove tile</button>}
          </div>
        }
        @if (tiles().length < 4) {<button pcButton type="button" size="sm" variant="ghost" class="self-start" (click)="addTile()"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add tile</button>}
      </div>
    }
    @if (card().mode === "recent" || card().mode === "buy_again") {<p class="text-sm text-ink-soft">Each shopper sees their own products. When they have none, the card is left out.</p>}
    @if (removable()) {<button pcButton type="button" size="sm" variant="ghost" class="self-start" (click)="remove.emit()"><svg [pcIcon]="Trash2" class="h-4 w-4" /> Remove card</button>}
  `,
})
export class SectionCard {
  readonly card = input.required<any>();
  readonly cats = input.required<Cat[]>();
  readonly removable = input(false);
  readonly cardChange = output<any>();
  readonly remove = output<void>();
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly modes = CARD_MODES;
  protected readonly cardSources = CARD_SOURCES;
  protected readonly tiles = computed<any[]>(() => this.card().tiles ?? []);
  protected patch(p: Record<string, any>): void {
    this.cardChange.emit({ ...this.card(), ...p });
  }
  protected setMode(mode: string): void {
    const tiles = this.tiles();
    this.patch({ mode, tiles: mode === "tiles" && !tiles.length ? [{ image: "", label: "", link: "/search", badge: "" }] : this.card().tiles });
  }
  protected setTile(i: number, p: Record<string, any>): void {
    this.patch({ tiles: this.tiles().map((x, j) => (j === i ? { ...x, ...p } : x)) });
  }
  protected removeTile(i: number): void {
    this.patch({ tiles: this.tiles().filter((_, j) => j !== i) });
  }
  protected addTile(): void {
    this.patch({ tiles: [...this.tiles(), { image: "", label: "", link: "/search", badge: "" }] });
  }
}

/* ------------------------------------------------------------------ products I pick */

@Component({
  selector: "pc-product-picker",
  imports: [Input, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block sm:col-span-2" },
  template: `
    <p class="mb-1 font-medium">Products ({{ ids().length }} of 24)</p>
    <ul class="mb-2 flex flex-wrap gap-2">
      @for (id of ids(); track id) {
        <li class="flex items-center gap-1 rounded-full bg-peacock-light py-1 pl-3 pr-1 text-sm">
          <span class="max-w-[220px] truncate">{{ picked()[id] ?? "Product " + id.slice(0, 8) }}</span>
          <button type="button" aria-label="Remove" class="rounded-full p-0.5 hover:bg-white" (click)="idsChange.emit(without(id))"><svg [pcIcon]="Trash2" class="h-3.5 w-3.5" /></button>
        </li>
      }
    </ul>
    <input pcInput placeholder="Search live products to add" [value]="q()" (input)="q.set($any($event.target).value)" aria-label="Search products" />
    @if (results().length > 0) {
      <ul class="mt-1 max-h-56 overflow-auto rounded-lg border border-line">
        @for (p of results(); track p.id) {
          <li>
            <button type="button" [disabled]="ids().includes(p.id) || ids().length >= 24" class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-mist disabled:opacity-40" (click)="add(p)">
              <img [src]="p.image" alt="" class="h-8 w-8 rounded object-cover" />
              <span class="flex-1 truncate">{{ p.title }}</span>
              <svg [pcIcon]="Plus" class="h-4 w-4" />
            </button>
          </li>
        }
      </ul>
    }
  `,
})
export class ProductPicker {
  readonly ids = input.required<string[]>();
  readonly idsChange = output<string[]>();
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly q = signal("");
  /** results remember the words they are for, so clearing the box shows nothing */
  private readonly found = signal<{ q: string; items: ProductCard[] }>({ q: "", items: [] });
  protected readonly picked = signal<Record<string, string>>({});
  protected readonly results = computed(() => (this.q().trim().length >= 2 && this.found().q === this.q() ? this.found().items : []));

  constructor() {
    let t: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const q = this.q();
      clearTimeout(t);
      if (q.trim().length < 2) return;
      t = setTimeout(() => api<{ items: ProductCard[] }>("/api/catalog/products", { query: { q, page_size: 8 } }).then((r) => this.found.set({ q, items: r.items })).catch(() => {}), 250);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(t));
  }

  protected without(id: string): string[] {
    return this.ids().filter((x) => x !== id);
  }
  protected add(p: ProductCard): void {
    this.picked.update((m) => ({ ...m, [p.id]: p.title }));
    this.idsChange.emit([...this.ids(), p.id]);
  }
}

/* ------------------------------------------------------------------ each kind's settings */

@Component({
  selector: "pc-collection-select",
  imports: [Field, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <pc-field label="Collection" for="pcol">
      <select pcSelect id="pcol" (change)="slugChange.emit($any($event.target).value)">
        <option value="" [selected]="!slug()">Choose</option>
        @for (x of cols(); track x.slug) {<option [value]="x.slug" [selected]="x.slug === slug()">{{ x.title }}</option>}
      </select>
    </pc-field>
  `,
})
export class CollectionSelect {
  readonly slug = input<string>("");
  readonly slugChange = output<string>();
  protected readonly cols = signal<{ slug: string; title: string }[]>([]);
  constructor() {
    api<{ items: { slug: string; title: string }[] }>("/api/catalog/collections").then((r) => this.cols.set(r.items)).catch(() => this.cols.set([]));
  }
}

@Component({
  selector: "pc-section-config",
  imports: [SectionSlide, SectionCard, ProductPicker, CollectionSelect, ImageField, MediaField, TextField, Field, Select, Input, Textarea, Button, Icon, Markdown],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @switch (kind()) {
      @case ("hero") {
        <div class="flex flex-col gap-3">
          <div class="grid gap-3 rounded-lg bg-mist p-3 sm:grid-cols-3">
            <pc-field label="Style">
              <select pcSelect (change)="patch({ style: $any($event.target).value })">
                <option value="fade" [selected]="(c().style ?? 'boxed') === 'fade'">Full width, fading into the page (the next section overlaps it)</option>
                <option value="boxed" [selected]="(c().style ?? 'boxed') === 'boxed'">Banner in a rounded box</option>
              </select>
            </pc-field>
            <pc-text-field label="Seconds per slide (3 to 10)" inputmode="numeric" [value]="str(c().interval ?? 5)" [filter]="intervalFilter" (valueChange)="patch({ interval: +$event })" [disabled]="c().autoplay === false" />
            <label class="flex items-center gap-2 self-end pb-2.5"><input type="checkbox" class="accent-peacock" [checked]="c().autoplay !== false" (change)="patch({ autoplay: $any($event.target).checked })" /> Move on automatically</label>
          </div>
          @for (s of c().slides ?? []; track $index; let i = $index) {
            <pc-section-slide [hero]="true" [v]="s" (vChange)="setItem('slides', i, $event)" [removable]="c().slides.length > 1" (remove)="removeItem('slides', i)" />
          }
          @if ((c().slides ?? []).length < 8) {<button pcButton type="button" size="sm" variant="secondary" class="self-start" (click)="patch({ slides: [...(c().slides ?? []), starterSlide()] })"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add slide</button>}
        </div>
      }
      @case ("cards") {
        <div class="flex flex-col gap-3">
          <p class="text-sm text-ink-soft">On computers the cards sit side by side; on phones they scroll sideways.</p>
          @for (card of c().cards ?? []; track $index; let i = $index) {
            <pc-section-card [card]="card" [cats]="cats()" (cardChange)="setItem('cards', i, $event)" [removable]="c().cards.length > 1" (remove)="removeItem('cards', i)" />
          }
          @if ((c().cards ?? []).length < 4) {<button pcButton type="button" size="sm" variant="secondary" class="self-start" (click)="patch({ cards: [...(c().cards ?? []), starterCard()] })"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add card</button>}
        </div>
      }
      @case ("deals") {
        <div class="grid gap-3 sm:grid-cols-2">
          <pc-field label="Deals to show"><select pcSelect (change)="patch({ kind: $any($event.target).value })">@for (d of dealKinds; track d[0]) {<option [value]="d[0]" [selected]="d[0] === (c().kind ?? '')">{{ d[1] }}</option>}</select></pc-field>
          <pc-text-field label="How many (4 to 24)" inputmode="numeric" [value]="str(c().limit ?? 12)" [filter]="count4" (valueChange)="patch({ limit: +$event })" />
          <p class="text-sm text-ink-soft sm:col-span-2">Hidden when no deal is running. Sellers create deals; approve them in Admin → Deals.</p>
        </div>
      }
      @case ("signin") {
        <div class="grid gap-3 sm:grid-cols-2">
          <pc-text-field label="Heading" [value]="c().heading ?? ''" maxlength="80" (valueChange)="patch({ heading: $event })" />
          <pc-text-field label="Short text (optional)" [value]="c().text ?? ''" maxlength="160" (valueChange)="patch({ text: $event })" />
          <p class="text-sm text-ink-soft sm:col-span-2">Only visitors who are not signed in see this.</p>
        </div>
      }
      @case ("countdown") {
        <div class="grid gap-3 sm:grid-cols-2">
          <pc-text-field label="Heading" [value]="c().heading ?? ''" maxlength="80" (valueChange)="patch({ heading: $event })" [required]="true" />
          <pc-text-field label="Short text" [value]="c().text ?? ''" maxlength="160" (valueChange)="patch({ text: $event })" />
          <pc-text-field label="Counts down to" type="datetime-local" [value]="local(c().ends_at || null)" (valueChange)="patch({ ends_at: fromLocal($event) })" [required]="true" />
          <pc-field label="Colour">
            <select pcSelect (change)="patch({ tone: $any($event.target).value })">
              @for (o of countdownTones; track o[0]) {<option [value]="o[0]" [selected]="o[0] === (c().tone ?? 'buy')">{{ o[1] }}</option>}
            </select>
          </pc-field>
          <pc-text-field label="Button text" [value]="c().cta ?? ''" maxlength="30" (valueChange)="patch({ cta: $event })" />
          <pc-text-field label="Link" [value]="c().link ?? ''" placeholder="/deals" (valueChange)="patch({ link: $event })" />
          <div class="sm:col-span-2"><pc-image-field label="Picture (optional)" [value]="c().image ?? ''" (valueChange)="patch({ image: $event })" hint="Shown beside the countdown on computers" /></div>
          <p class="text-sm text-ink-soft sm:col-span-2">The banner hides itself when the time is up.</p>
        </div>
      }
      @case ("banner") {<pc-section-slide [v]="c()" (vChange)="cChange.emit($event)" />}
      @case ("banner_grid") {
        <div class="flex flex-col gap-3">
          @for (s of c().items ?? []; track $index; let i = $index) {
            <pc-section-slide [v]="s" (vChange)="setItem('items', i, $event)" [removable]="c().items.length > 2" (remove)="removeItem('items', i)" />
          }
          @if ((c().items ?? []).length < 4) {<button pcButton type="button" size="sm" variant="secondary" class="self-start" (click)="patch({ items: [...c().items, starterBanner()] })"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add banner</button>}
        </div>
      }
      @case ("products") {
        <div class="grid gap-3 sm:grid-cols-2">
          <pc-field label="Show" for="src"><select pcSelect id="src" (change)="patch({ source: $any($event.target).value })">@for (s of sources; track s[0]) {<option [value]="s[0]" [selected]="s[0] === c().source">{{ s[1] }}</option>}</select></pc-field>
          <pc-field label="Layout" for="lay"><select pcSelect id="lay" (change)="patch({ layout: $any($event.target).value })"><option value="row" [selected]="c().layout === 'row'">Scrolling row</option><option value="grid" [selected]="c().layout === 'grid'">Grid</option></select></pc-field>
          <pc-text-field label="How many (4 to 24)" inputmode="numeric" [value]="str(c().limit ?? 12)" [filter]="count4" (valueChange)="patch({ limit: +$event })" />
          <pc-text-field label="'See all' link (optional)" [value]="c().see_all ?? ''" placeholder="/bestsellers" (valueChange)="patch({ see_all: $event })" />
          <label class="flex items-center gap-2"><input type="checkbox" class="accent-peacock" [checked]="!!c().show_add" (change)="patch({ show_add: $any($event.target).checked })" /> Add to cart buttons on the cards</label>
          <label class="flex items-center gap-2"><input type="checkbox" class="accent-peacock" [checked]="!!c().ranked" (change)="patch({ ranked: $any($event.target).checked })" /> Number the products (#1, #2, ...)</label>
          @if (c().source === "category") {
            <pc-field label="Category" for="pcat"><select pcSelect id="pcat" (change)="patch({ category_slug: $any($event.target).value })"><option value="" [selected]="!c().category_slug">Choose</option>@for (x of cats(); track x.slug) {<option [value]="x.slug" [selected]="x.slug === c().category_slug">{{ x.label }}</option>}</select></pc-field>
          }
          @if (c().source === "collection") {<pc-collection-select [slug]="c().collection_slug ?? ''" (slugChange)="patch({ collection_slug: $event })" />}
          @if (c().source === "manual") {<pc-product-picker [ids]="c().product_ids ?? []" (idsChange)="patch({ product_ids: $event })" />}
        </div>
      }
      @case ("categories") {
        <div class="flex flex-col gap-3">
          <pc-field label="Style" for="cst" class="max-w-xs" hint="The theme's own style unless you choose one">
            <select pcSelect id="cst" (change)="patch({ style: $any($event.target).value })">
              @for (o of catStyles; track o[0]) {<option [value]="o[0]" [selected]="o[0] === catStyle()">{{ o[1] }}</option>}
            </select>
          </pc-field>
          <p class="text-sm text-ink-soft">Tick the categories to show, in the order you tick them. Leave all unticked to show the main categories.</p>
          <div class="grid max-h-64 gap-1 overflow-auto rounded-lg border border-line p-2 sm:grid-cols-2">
            @for (x of cats(); track x.slug) {
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" class="accent-peacock" [checked]="slugs().includes(x.slug)" (change)="toggleSlug(x.slug)" />
                {{ x.label }}@if (slugs().includes(x.slug)) {<span class="text-xs text-ink-faint">#{{ slugs().indexOf(x.slug) + 1 }}</span>}
              </label>
            }
          </div>
        </div>
      }
      @case ("media") {
        <div class="flex flex-col gap-3">
          <div class="grid gap-3 sm:grid-cols-2">
            <pc-image-field label="Image" [value]="c().image ?? ''" (valueChange)="patch({ image: $event })" hint="Shown on its own, or as the video's cover" />
            <pc-media-field label="Video (optional)" accept="video" [value]="c().video ?? ''" [poster]="c().image" (valueChange)="patch({ video: $event, controls: $event ? c().controls : false })"
              hint="Plays muted on a loop, or with its own controls (below). MP4 or WebM." />
          </div>
          @if (!c().image && !c().video) {<p class="rounded-lg bg-marigold-light px-3 py-2 text-sm text-ink">Choose an image, a video, or both.</p>}
          <div class="grid gap-3 sm:grid-cols-2">
            <pc-text-field label="Heading (optional)" [value]="c().heading ?? ''" maxlength="80" (valueChange)="patch({ heading: $event })" />
            <pc-text-field label="Short text (optional)" [value]="c().text ?? ''" maxlength="160" (valueChange)="patch({ text: $event })" />
            <pc-text-field label="Button text (optional)" [value]="c().cta ?? ''" maxlength="30" (valueChange)="patch({ cta: $event })" />
            <pc-text-field label="Link (optional)" [value]="c().link ?? ''" placeholder="/c/fashion or /search?q=saree" (valueChange)="patch({ link: $event })" />
            <pc-field label="Shape">
              <select pcSelect (change)="patch({ aspect: $any($event.target).value })">
                @for (o of aspects; track o[0]) {<option [value]="o[0]" [selected]="o[0] === (c().aspect ?? '16/9')">{{ o[1] }}</option>}
              </select>
            </pc-field>
            <pc-field label="Width">
              <select pcSelect (change)="patch({ width: $any($event.target).value })"><option value="contained" [selected]="(c().width ?? 'contained') === 'contained'">In line with the page</option><option value="full" [selected]="c().width === 'full'">Edge to edge</option></select>
            </pc-field>
            <pc-field label="Words">
              <select pcSelect (change)="patch({ tone: $any($event.target).value })"><option value="light" [selected]="(c().tone ?? 'light') === 'light'">White, on a dark shade over the picture</option><option value="dark" [selected]="c().tone === 'dark'">Dark, straight on a light picture</option></select>
            </pc-field>
            <pc-field label="Position">
              <select pcSelect (change)="patch({ align: $any($event.target).value })"><option value="left" [selected]="(c().align ?? 'left') === 'left'">Left</option><option value="center" [selected]="c().align === 'center'">Centre</option></select>
            </pc-field>
          </div>
          @if (c().video) {
            <label class="flex items-start gap-2 text-sm">
              <input type="checkbox" class="mt-1 accent-peacock" [checked]="!!c().controls" (change)="patch({ controls: $any($event.target).checked })" />
              <span>Show the video's own controls (shoppers press play and can turn the sound on; the words go below it and there is no link)</span>
            </label>
          }
        </div>
      }
      @case ("text") {
        <div class="grid gap-3 lg:grid-cols-2">
          <div>
            <textarea pcTextarea rows="10" [value]="c().markdown" (input)="patch({ markdown: $any($event.target).value })" aria-label="Text" class="font-mono text-sm"></textarea>
            <p class="mt-1 text-xs text-ink-faint">## Heading, **bold**, *italic*, - list item, [link text](/pages/about)</p>
            <pc-field label="Alignment" for="al" class="mt-2 max-w-xs"><select pcSelect id="al" (change)="patch({ align: $any($event.target).value })"><option value="left" [selected]="c().align === 'left'">Left</option><option value="center" [selected]="c().align === 'center'">Centre</option></select></pc-field>
          </div>
          <div [class]="c().align === 'center' ? 'rounded-lg border border-line p-3 text-center' : 'rounded-lg border border-line p-3 '"><pc-markdown [source]="c().markdown ?? ''" /></div>
        </div>
      }
      @case ("usp") {
        <div class="flex flex-col gap-2">
          @for (it of c().items ?? []; track $index; let i = $index) {
            <div class="flex items-center gap-2">
              <select pcSelect (change)="setItem('items', i, { ...it, icon: $any($event.target).value })" class="w-44" aria-label="Icon">@for (o of icons; track o[0]) {<option [value]="o[0]" [selected]="o[0] === it.icon">{{ o[1] }}</option>}</select>
              <input pcInput [value]="it.text" maxlength="80" (input)="setItem('items', i, { ...it, text: $any($event.target).value })" aria-label="Text" />
              <button type="button" aria-label="Remove" class="rounded p-1.5 text-vermilion hover:bg-mist" (click)="removeItem('items', i)"><svg [pcIcon]="Trash2" class="h-4 w-4" /></button>
            </div>
          }
          @if ((c().items ?? []).length < 6) {<button pcButton type="button" size="sm" variant="ghost" class="self-start" (click)="patch({ items: [...(c().items ?? []), { icon: 'check', text: '' }] })"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add promise</button>}
        </div>
      }
      @default {
        @if (kind() === "sponsored" || kind() === "inspired" || kind() === "buy_again") {
          <div class="grid gap-3 sm:grid-cols-2">
            <pc-text-field label="How many (4 to 20)" inputmode="numeric" [value]="str(c().limit ?? 10)" [filter]="count4" (valueChange)="patch({ limit: +$event })" />
            <p class="self-end text-sm text-ink-soft">{{ limitNote() }}</p>
          </div>
        } @else {
          <p class="text-ink-soft">This section has no settings. It shows the products each shopper viewed recently.</p>
        }
      }
    }
  `,
})
export class SectionConfig {
  readonly kind = input.required<string>();
  readonly c = input.required<Record<string, any>>();
  readonly cats = input.required<Cat[]>();
  readonly cChange = output<Record<string, any>>();
  protected readonly Plus = Plus;
  protected readonly Trash2 = Trash2;
  protected readonly icons = ICONS;
  protected readonly sources = SOURCES;
  protected readonly dealKinds = DEAL_KIND_LABEL;
  protected readonly countdownTones = [["buy", "Buy button colour"], ["accent", "Highlight colour"], ["primary", "Main colour"], ["dark", "Dark"]];
  protected readonly aspects = [["21/9", "Wide strip (21:9)"], ["16/9", "Widescreen (16:9)"], ["4/3", "Classic (4:3)"], ["1/1", "Square"], ["4/5", "Tall (4:5)"]];
  protected readonly catStyles = [["auto", "The theme's style"], ["circles", "Round icons"], ["cards", "Cards"], ["squares", "Small squares"], ["chips", "Text chips"]];
  protected readonly intervalFilter = intervalFilter;
  protected readonly count4 = countFilter(4);
  protected readonly local = toLocal;
  protected readonly fromLocal = fromLocal;
  protected readonly slugs = computed<string[]>(() => this.c()["slugs"] ?? []);
  protected readonly catStyle = computed(() => (["circles", "cards", "squares", "chips"].includes(this.c()["style"]) ? this.c()["style"] : "auto"));
  protected readonly limitNote = computed(() => this.kind() === "sponsored" ? "Ads from running campaigns, marked Sponsored. Hidden when none are running or ads are off (Admin → Advertising)."
    : this.kind() === "inspired" ? "Built from the products this shopper opened. Hidden for first-time visitors."
    : "Each signed-in shopper's own past orders. Hidden for visitors and new shoppers.");

  protected str(v: unknown): string {
    return String(v);
  }
  protected patch(p: Record<string, any>): void {
    this.cChange.emit({ ...this.c(), ...p });
  }
  protected setItem(key: string, i: number, v: any): void {
    this.patch({ [key]: (this.c()[key] as any[]).map((x, j) => (j === i ? v : x)) });
  }
  protected removeItem(key: string, i: number): void {
    this.patch({ [key]: (this.c()[key] as any[]).filter((_, j) => j !== i) });
  }
  protected toggleSlug(slug: string): void {
    const on = this.slugs().includes(slug);
    this.patch({ slugs: on ? this.slugs().filter((s) => s !== slug) : [...this.slugs(), slug].slice(0, 16) });
  }
  protected starterSlide(): any {
    return { ...STARTER["hero"]["slides"][0] };
  }
  protected starterCard(): any {
    return structuredClone(STARTER["cards"]["cards"][0]);
  }
  protected starterBanner(): any {
    return { ...STARTER["banner"] };
  }
}

/* ------------------------------------------------------------------ the list */

@Component({
  selector: "pc-sections-editor",
  imports: [SectionConfig, PageLoader, Button, ErrorNote, Field, Modal, Pill, Select, TextField, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!data()) {
      <pc-page-loader />
    } @else {
      <div class="max-w-4xl">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p class="text-ink-soft">The home page shows these sections from top to bottom.</p>
          <div class="flex gap-2">
            <a href="/" target="_blank" rel="noreferrer" class="inline-flex h-10 items-center rounded-lg border border-line bg-white px-4 font-semibold">View shop</a>
            <button pcButton (click)="adding.set(true)"><svg [pcIcon]="Plus" class="h-4 w-4" /> Add section</button>
          </div>
        </div>
        <ol class="flex flex-col gap-2">
          @for (s of data()!.items; track s.id; let i = $index; let last = $last) {
            <li [class]="s.is_active ? 'flex items-center gap-3 rounded-xl bg-white p-3 ' : 'flex items-center gap-3 rounded-xl bg-white p-3 opacity-60'">
              <div class="flex flex-col">
                <button aria-label="Move up" [disabled]="i === 0" class="rounded p-1 hover:bg-mist disabled:opacity-30" (click)="move(i, -1)"><svg [pcIcon]="ArrowUp" class="h-4 w-4" /></button>
                <button aria-label="Move down" [disabled]="last" class="rounded p-1 hover:bg-mist disabled:opacity-30" (click)="move(i, 1)"><svg [pcIcon]="ArrowDown" class="h-4 w-4" /></button>
              </div>
              <button class="flex-1 text-left" (click)="open(s)">
                <p class="font-semibold">{{ s.title || s.kind_label }}</p>
                <p class="text-sm text-ink-soft">{{ s.kind_label }}{{ summary(s) }}</p>
              </button>
              @if (s.device !== "all") {
                @if (s.device === "mobile") {<svg [pcIcon]="Smartphone" class="h-4 w-4 text-ink-faint" ariaHidden="" aria-label="Phones only" />} @else {<svg [pcIcon]="Monitor" class="h-4 w-4 text-ink-faint" ariaHidden="" aria-label="Computers only" />}
              }
              @if (scheduled(s)) {<pc-pill tone="blue">From {{ fmtDate(s.starts_at) }}</pc-pill>}
              @if (ended(s)) {<pc-pill tone="red">Ended</pc-pill>}
              <button [attr.aria-label]="s.is_active ? 'Hide section' : 'Show section'" [attr.title]="s.is_active ? 'Hide' : 'Show'" class="rounded p-2 hover:bg-mist" (click)="toggle(s)">
                <svg [pcIcon]="s.is_active ? Eye : EyeOff" class="h-4 w-4" />
              </button>
              <button pcButton size="sm" variant="ghost" (click)="open(s)">Edit</button>
            </li>
          }
        </ol>
        <pc-modal [open]="adding()" (close)="adding.set(false)" title="Add a section" [wide]="true">
          <ul class="grid gap-2 sm:grid-cols-2">
            @for (k of kinds(); track k[0]) {
              <li>
                <button class="h-full w-full rounded-lg border border-line p-3 text-left hover:border-peacock hover:bg-peacock-light" (click)="start(k[0], k[1])">
                  <p class="font-semibold">{{ k[1] }}</p>
                  <p class="text-sm text-ink-soft">{{ help[k[0]] }}</p>
                </button>
              </li>
            }
          </ul>
        </pc-modal>
        <pc-modal [open]="!!edit()" (close)="edit.set(null)" [title]="editTitle()" [wide]="true">
          @if (edit(); as e) {
            <div class="flex flex-col gap-4">
              <pc-error-note [message]="error()" />
              <pc-text-field label="Heading shown above the section (optional)" [value]="e.title" maxlength="120" (valueChange)="setEdit({ title: $event })" />
              <pc-section-config [kind]="e.kind" [c]="e.config" (cChange)="setEdit({ config: $event })" [cats]="cats()" />
              <div class="grid gap-3 rounded-lg bg-mist p-3 sm:grid-cols-3">
                <pc-field label="Show on" for="dev"><select pcSelect id="dev" (change)="setEdit({ device: $any($event.target).value })"><option value="all" [selected]="e.device === 'all'">Phones and computers</option><option value="mobile" [selected]="e.device === 'mobile'">Phones only</option><option value="desktop" [selected]="e.device === 'desktop'">Computers only</option></select></pc-field>
                <pc-text-field label="Show from (optional)" type="datetime-local" [value]="local(e.starts_at)" (valueChange)="setEdit({ starts_at: $event ? fromLocal($event) : null })" />
                <pc-text-field label="Hide after (optional)" type="datetime-local" [value]="local(e.ends_at)" (valueChange)="setEdit({ ends_at: $event ? fromLocal($event) : null })" />
                <label class="flex items-center gap-2 sm:col-span-3"><input type="checkbox" class="accent-peacock" [checked]="e.is_active" (change)="setEdit({ is_active: $any($event.target).checked })" /> Section is visible</label>
              </div>
              <div class="flex flex-wrap gap-2">
                <button pcButton (click)="save(e)">Save section</button>
                @if (e.id !== "new") {
                  <button pcButton variant="danger" (click)="remove(e)"><svg [pcIcon]="Trash2" class="h-4 w-4" /> Delete section</button>
                }
              </div>
            </div>
          }
        </pc-modal>
      </div>
    }
  `,
})
export class SectionsEditor {
  private readonly toast = inject(Toast);
  protected readonly ArrowUp = ArrowUp;
  protected readonly ArrowDown = ArrowDown;
  protected readonly Eye = Eye;
  protected readonly EyeOff = EyeOff;
  protected readonly Monitor = Monitor;
  protected readonly Plus = Plus;
  protected readonly Smartphone = Smartphone;
  protected readonly Trash2 = Trash2;
  protected readonly help = KIND_HELP;
  protected readonly local = toLocal;
  protected readonly fromLocal = fromLocal;
  protected readonly fmtDate = date;
  private readonly now = Date.now();
  protected readonly data = signal<{ kinds: Record<string, string>; items: Section[] } | null>(null);
  protected readonly cats = signal<Cat[]>([]);
  protected readonly edit = signal<Section | null>(null);
  protected readonly adding = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly kinds = computed(() => Object.entries(this.data()?.kinds ?? {}));
  protected readonly editTitle = computed(() => { const e = this.edit(); return e ? `${e.id === "new" ? "New" : "Edit"}: ${e.kind_label}` : ""; });

  constructor() {
    this.load();
    api<CategoryNode[]>("/api/catalog/categories").then((t) => this.cats.set(flatten(t))).catch(() => {});
  }

  private load(): void {
    api<{ kinds: Record<string, string>; items: Section[] }>("/api/admin/storefront/sections").then((d) => this.data.set(d)).catch(quietly);
  }

  protected summary(s: Section): string {
    const c = s.config;
    if (s.kind === "products") return `: ${SOURCES.find(([v]) => v === c["source"])?.[1] ?? ""}`;
    if (s.kind === "hero") return `: ${c["slides"]?.length ?? 0} slides${c["style"] === "fade" ? ", full width" : ""}`;
    if (s.kind === "cards") return `: ${c["cards"]?.length ?? 0} cards`;
    if (s.kind === "media") return `: ${c["video"] ? "video" : "image"}${c["heading"] ? `, ${c["heading"]}` : ""}`;
    if (s.kind === "deals") return `: ${DEAL_KIND_LABEL.find(([v]) => v === (c["kind"] ?? ""))?.[1] ?? ""}`;
    if (s.kind === "countdown" && c["ends_at"]) return `: ends ${date(c["ends_at"])}`;
    return "";
  }
  protected scheduled(s: Section): boolean {
    return !!s.starts_at && new Date(s.starts_at).getTime() > this.now;
  }
  protected ended(s: Section): boolean {
    return !!s.ends_at && new Date(s.ends_at).getTime() < this.now;
  }

  protected open(s: Section): void {
    this.error.set(null);
    this.edit.set(s);
  }
  protected setEdit(p: Partial<Section>): void {
    this.edit.update((e) => (e ? { ...e, ...p } : e));
  }

  protected start(k: string, label: string): void {
    this.adding.set(false);
    this.error.set(null);
    const config = structuredClone(STARTER[k] ?? {});
    if (k === "countdown") config["ends_at"] = new Date(Date.now() + 3 * 86_400_000).toISOString(); // three days from now
    const untitled = ["usp", "hero", "text", "banner", "cards", "countdown", "signin"].includes(k);
    this.edit.set({ id: "new", kind: k, kind_label: label, title: untitled ? "" : label, config, is_active: true, device: "all", starts_at: null, ends_at: null });
  }

  private async reorder(items: Section[]): Promise<void> {
    this.data.update((d) => (d ? { ...d, items } : d));
    await api("/api/admin/storefront/sections-order", { method: "PUT", body: { ids: items.map((s) => s.id) } });
  }
  protected move(i: number, d: number): void {
    const data = this.data();
    if (!data) return;
    const n = [...data.items];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    void this.reorder(n);
  }

  protected async save(s: Section): Promise<void> {
    this.error.set(null);
    const body = { kind: s.kind, title: s.title, config: s.config, is_active: s.is_active, device: s.device, starts_at: s.starts_at, ends_at: s.ends_at };
    try {
      if (s.id === "new") await api("/api/admin/storefront/sections", { method: "POST", body });
      else await api(`/api/admin/storefront/sections/${s.id}`, { method: "PUT", body });
      this.toast.show("Section saved. The home page updates within 15 seconds.");
      this.edit.set(null);
      this.load();
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    }
  }

  protected async toggle(s: Section): Promise<void> {
    await api(`/api/admin/storefront/sections/${s.id}`, { method: "PUT", body: { ...s, is_active: !s.is_active } });
    this.load();
  }

  // Deleting is the only irreversible action here; a native confirm keeps it simple and keyboard-friendly.
  protected async remove(s: Section): Promise<void> {
    if (!window.confirm("Delete this section? You can add it again later, but its settings are lost.")) return;
    await api(`/api/admin/storefront/sections/${s.id}`, { method: "DELETE" });
    this.edit.set(null);
    this.toast.show("Section removed");
    this.load();
  }
}
