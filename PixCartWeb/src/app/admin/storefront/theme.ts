/*
 * Admin → Storefront → Theme and layout. The owner picks a theme from a gallery of miniatures, picks a colour preset
 * or changes any colour (with readable-text checks), changes any layout option, sees the real shop in a live preview
 * on a phone, tablet or computer, and applies it. Every theme keeps its own preset, colours and layout, so switching
 * back and forth never loses a choice. Saving uses PUT /api/admin/storefront/theme (theme fields only).
 * Port of frontend/src/app/admin/storefront/theme.tsx.
 */

import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, linkedSignal, output, signal, viewChild,
} from "@angular/core";
import { DomSanitizer } from "@angular/platform-browser";
import { AlertTriangle, Check, ExternalLink, Eye, Laptop, RotateCcw, Smartphone, Tablet, X, type LucideIconData } from "lucide-angular";
import { api, ApiError, quietly } from "../../core/api";
import { ThemeService } from "../../themes/context";
import { PREVIEW_COOKIE, THEME_LIST, THEMES } from "../../themes/manifest";
import { EDITABLE_COLORS, LAYOUT_CHOICES, type EditableColor, type ThemeColors, type ThemeId } from "../../themes/types";
import { cx } from "../../shared/ui/cx";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Toast } from "../../shared/ui/ui";
import { ThemeMock } from "./theme-mock";
import {
  HEX, LAYOUT_KEYS, LAYOUT_WORDS, changeCounts, colorChecks, differs, draftTheme, flatLayout, layoutWord, presetName, presetsFor, previewHref,
  ratioText, savedDraft, toSetting, type Draft, type LayoutKey, type PickerSite, type ThemeSaved,
} from "./theme-model";

const COLOR_LABELS: Record<EditableColor, { label: string; help: string }> = {
  primary: { label: "Main colour", help: "Header, links and selected states" },
  primary_dark: { label: "Dark main colour", help: "Footer and pressed states" },
  accent: { label: "Highlight", help: "Search button, badges and add-to-cart" },
  buy: { label: "Buy and sale", help: "Buy now, discounts and deal timers" },
  success: { label: "Success", help: "Ratings, in stock and confirmations" },
  page: { label: "Page background", help: "Behind panels and cards" },
};

/** A row of the six colours as small dots. */
@Component({
  selector: "pc-swatches",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-center", "aria-hidden": "true" },
  template: `@for (k of keys; track k) {<span [class]="dot()" [style.background]="colors()[k]"></span>}`,
})
export class Swatches {
  readonly colors = input.required<ThemeColors>();
  readonly size = input<"sm" | "md">("sm");
  protected readonly keys = EDITABLE_COLORS;
  protected readonly dot = computed(() => cx("rounded-full ring-2 ring-white", this.size() === "md" ? "-ml-1 h-5 w-5 first:ml-0" : "-ml-0.5 h-3.5 w-3.5 first:ml-0"));
}

/* ------------------------------------------------------------------ live preview window */

const DEVICES: { id: "phone" | "tablet" | "desktop"; label: string; width: number; icon: LucideIconData }[] = [
  { id: "phone", label: "Phone", width: 390, icon: Smartphone },
  { id: "tablet", label: "Tablet", width: 820, icon: Tablet },
  { id: "desktop", label: "Computer", width: 1280, icon: Laptop },
];

@Component({
  selector: "pc-theme-preview-window",
  imports: [Icon, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "fixed inset-0 z-[70] flex flex-col bg-ink/80 p-2 sm:p-4", role: "dialog", "aria-modal": "true",
    "[attr.aria-label]": "'Live preview of ' + name()", "data-testid": "theme-live-preview", "(document:keydown.escape)": "close.emit()",
  },
  template: `
    <div class="flex flex-wrap items-center gap-2 rounded-t-xl bg-white px-3 py-2">
      <p class="mr-auto flex items-center gap-2 font-semibold"><svg [pcIcon]="Eye" class="h-4 w-4 text-peacock" /> {{ name() }}: live preview</p>
      <div class="flex rounded-lg bg-mist p-0.5" role="radiogroup" aria-label="Screen size">
        @for (d of devices; track d.id) {
          <button type="button" role="radio" [attr.aria-checked]="device() === d.id" (click)="device.set(d.id)"
            [class]="device() === d.id ? 'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium bg-white text-peacock shadow-sm' : 'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-ink-soft hover:text-ink'">
            <svg [pcIcon]="d.icon" class="h-4 w-4" /><span class="hidden sm:inline">{{ d.label }}</span>
          </button>
        }
      </div>
      <label class="sr-only" for="preview-page">Page</label>
      <select id="preview-page" (change)="page.set($any($event.target).value)" class="h-9 rounded-lg border border-line bg-white px-2 text-sm">
        @for (p of pages(); track p.to) {<option [value]="p.to" [selected]="p.to === page()">{{ p.label }}</option>}
      </select>
      <a [href]="src()" target="_blank" rel="noopener" class="flex h-9 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-peacock hover:bg-mist">
        <svg [pcIcon]="ExternalLink" class="h-4 w-4" /><span class="hidden md:inline">New tab</span>
      </a>
      <button pcButton size="sm" (click)="apply.emit()">{{ applyLabel() }}</button>
      <button #closeBtn type="button" (click)="close.emit()" aria-label="Close the preview" class="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-mist"><svg [pcIcon]="X" class="h-5 w-5" /></button>
    </div>
    <div #stage class="relative flex-1 overflow-hidden rounded-b-xl bg-mist">
      @if (box().w > 0) {
        <div class="absolute left-1/2 top-4 origin-top" [style.width.px]="width()" [style.height.px]="(box().h - 32) / scale()" [style.transform]="'translateX(-50%) scale(' + scale() + ')'">
          @for (s of [safeSrc()]; track src()) {<iframe [src]="s" [title]="name() + ' preview'" class="h-full w-full rounded-lg border-0 bg-white shadow-2xl"></iframe>}
        </div>
      }
    </div>
    <p class="mt-2 text-center text-xs text-white/80">Only you see this preview. Links inside it work; nothing is saved until you apply.</p>
  `,
})
export class ThemePreviewWindow {
  readonly id = input.required<ThemeId>();
  readonly draft = input.required<Draft>();
  readonly applyLabel = input.required<string>();
  readonly close = output<void>();
  readonly apply = output<void>();
  protected readonly Eye = Eye;
  protected readonly ExternalLink = ExternalLink;
  protected readonly X = X;
  protected readonly devices = DEVICES;
  protected readonly device = signal<(typeof DEVICES)[number]["id"]>("desktop");
  protected readonly pages = signal<{ label: string; to: string }[]>([
    { label: "Home", to: "/" }, { label: "Search", to: "/search?q=shoes" }, { label: "Cart", to: "/cart" }, { label: "Sign in", to: "/login" },
  ]);
  protected readonly page = signal("/");
  protected readonly box = signal({ w: 0, h: 0 });
  private readonly stage = viewChild.required<ElementRef<HTMLDivElement>>("stage");
  private readonly closeBtn = viewChild.required<ElementRef<HTMLButtonElement>>("closeBtn");
  protected readonly name = computed(() => THEMES[this.id()].name);
  protected readonly width = computed(() => DEVICES.find((d) => d.id === this.device())!.width);
  protected readonly scale = computed(() => (this.box().w ? Math.min(1, (this.box().w - 32) / this.width()) : 1));
  protected readonly src = computed(() => previewHref(this.id(), this.draft(), this.page()));
  private readonly sanitizer = inject(DomSanitizer);
  protected readonly safeSrc = computed(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.src()));

  constructor() {
    const destroy = inject(DestroyRef);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    destroy.onDestroy(() => { document.body.style.overflow = prev; });
    afterNextRender(() => {
      this.closeBtn().nativeElement.focus();
      const ro = new ResizeObserver(([e]) => this.box.set({ w: e.contentRect.width, h: e.contentRect.height }));
      ro.observe(this.stage().nativeElement);
      destroy.onDestroy(() => ro.disconnect());
    });
    // A category and a product to preview (the first of each).
    void Promise.all([
      api<{ slug: string; name: string }[]>("/api/catalog/categories").catch(() => []),
      api<{ items: { slug: string }[] }>("/api/catalog/products", { query: { page: 1, sort: "popular" } }).catch(() => ({ items: [] as { slug: string }[] })),
    ]).then(([cats, prods]) => {
      const extra: { label: string; to: string }[] = [];
      if (cats[0]) extra.push({ label: "Category", to: `/c/${cats[0].slug}` });
      if (prods.items[0]) extra.push({ label: "Product", to: `/p/${prods.items[0].slug}` });
      this.pages.update((p) => [p[0], p[1], ...extra, ...p.slice(2)]);
    });
  }
}

/* ------------------------------------------------------------------ hex field and layout row */

/** A hex text field that only passes valid colours on (typing "#12" waits until it is complete). */
@Component({
  selector: "pc-hex-field",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<input [value]="text()" [attr.aria-label]="label() + ' hex value'" [attr.aria-invalid]="bad()" spellcheck="false" maxlength="7"
    (input)="onInput($event)" [class]="bad() ? 'h-10 w-24 rounded-md border px-2 font-mono text-sm uppercase border-vermilion' : 'h-10 w-24 rounded-md border px-2 font-mono text-sm uppercase border-line'" />`,
})
export class HexField {
  readonly value = input.required<string>();
  readonly label = input.required<string>();
  readonly valid = output<string>();
  protected readonly text = linkedSignal(() => this.value());
  protected readonly bad = computed(() => !HEX.test(this.text()));
  protected onInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value.trim();
    this.text.set(v);
    if (HEX.test(v)) this.valid.emit(v.toUpperCase());
  }
}

/** One layout option: the theme's own choice, or one of the allowed values. */
@Component({
  selector: "fieldset[pcLayoutRow]",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3" },
  template: `
    <legend class="sr-only">{{ words().label }}</legend>
    <div class="sm:w-40 sm:shrink-0">
      <p class="text-sm font-semibold">{{ words().label }}</p>
      <p class="text-xs text-ink-faint">{{ words().help }}</p>
    </div>
    <div class="flex flex-wrap gap-1" role="radiogroup" [attr.aria-label]="words().label">
      @for (v of choices(); track v) {
        <button type="button" role="radio" [attr.aria-checked]="current() === v" (click)="pick(v)"
          [class]="current() === v ? 'rounded-lg border px-2.5 py-1.5 text-sm border-peacock bg-peacock text-white' : 'rounded-lg border px-2.5 py-1.5 text-sm border-line bg-white hover:border-peacock/60'">
          {{ word(v) }}@if (v === own()) {<span [class]="current() === v ? 'ml-1 text-[11px] text-white/80' : 'ml-1 text-[11px] text-ink-faint'">(theme)</span>}
        </button>
      }
    </div>
  `,
})
export class LayoutRow {
  readonly k = input.required<LayoutKey>();
  readonly id = input.required<ThemeId>();
  readonly draft = input.required<Draft>();
  readonly layoutChange = output<Draft["layout"]>();
  protected readonly own = computed(() => flatLayout(THEMES[this.id()].layout)[this.k()]);
  protected readonly current = computed(() => (this.draft().layout as Record<string, unknown>)[this.k()] ?? this.own());
  protected readonly words = computed(() => LAYOUT_WORDS[this.k()]);
  protected readonly choices = computed(() => LAYOUT_CHOICES[this.k()] as readonly (string | number)[]);
  protected word(v: string | number): string {
    return layoutWord(this.k(), v);
  }
  protected pick(v: string | number): void {
    const next = { ...this.draft().layout } as Record<string, unknown>;
    if (v === this.own()) delete next[this.k()];
    else next[this.k()] = v;
    this.layoutChange.emit(next as Draft["layout"]);
  }
}

/* ------------------------------------------------------------------ the picker */

@Component({
  selector: "pc-theme-editor",
  imports: [Icon, Button, ErrorNote, PageLoader, ThemeMock, Swatches, HexField, LayoutRow, ThemePreviewWindow],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!site() || !brand()) {
      <pc-page-loader />
    } @else {
      <div class="flex flex-col gap-5" data-testid="theme-editor">
        <!-- what shoppers see now -->
        <section class="flex flex-col gap-4 rounded-xl bg-white p-4 sm:flex-row sm:items-center sm:p-5" aria-label="Live theme">
          <div pcThemeMock [theme]="liveTheme()" [brand]="site()!.brand_name" [classicRadius]="site()!.radius" class="w-full shrink-0 rounded-lg ring-1 ring-line sm:w-56"></div>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <p class="text-sm text-ink-soft">Shoppers see</p>
            <p class="font-display text-2xl font-semibold">{{ themes[live()].name }} <span class="ml-1 rounded-full bg-leaf-light px-2 py-0.5 align-middle font-sans text-xs font-bold text-leaf">Live</span></p>
            <p class="text-sm text-ink-soft">{{ livePreset() }} · {{ themes[live()].tagline }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button pcButton variant="secondary" (click)="editing.set(live())" [disabled]="editing() === live()">Customise</button>
          </div>
        </section>

        <!-- gallery -->
        <section aria-labelledby="themes-h" class="flex flex-col gap-3">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="themes-h" class="text-xl font-semibold">Themes</h2>
            <p class="text-sm text-ink-soft">Each theme changes colours, fonts and the layout of every page. Your choices are kept per theme.</p>
          </div>
          <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label="Theme to edit">
            @for (t of gallery(); track t.data.id) {
              <button type="button" role="radio" [attr.aria-checked]="t.selected" (click)="editing.set(t.data.id)" [attr.data-testid]="'theme-card-' + t.data.id"
                [class]="t.selected ? 'pc-lift group flex flex-col overflow-hidden rounded-xl bg-white text-left ring-2 transition-shadow ring-peacock' : 'pc-lift group flex flex-col overflow-hidden rounded-xl bg-white text-left ring-2 transition-shadow ring-transparent hover:ring-line'">
                <div pcThemeMock [theme]="t.theme" [brand]="site()!.brand_name" [classicRadius]="site()!.radius" class="w-full border-b border-line"></div>
                <span class="flex flex-1 flex-col gap-1.5 p-3">
                  <span class="flex items-center gap-2">
                    <span class="font-semibold">{{ t.data.name }}</span>
                    @if (t.data.id === live()) {<span class="rounded-full bg-leaf-light px-2 text-xs font-bold leading-5 text-leaf">Live</span>}
                    @if (t.dirty) {<span class="rounded-full bg-marigold-light px-2 text-xs font-bold leading-5 text-ink">Unsaved</span>}
                    @if (t.selected) {<svg [pcIcon]="Check" class="ml-auto h-4 w-4 text-peacock" />}
                  </span>
                  <span class="text-sm text-ink-soft">{{ t.data.tagline }}</span>
                  <span class="mt-auto flex flex-wrap gap-1 pt-1">
                    @for (b of t.data.bestFor; track b) {<span class="rounded-full bg-mist px-2 py-0.5 text-[11px] font-medium text-ink-soft">{{ b }}</span>}
                  </span>
                </span>
              </button>
            }
          </div>
        </section>

        <!-- editor -->
        <section aria-labelledby="edit-h" class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div class="flex min-w-0 flex-col gap-4">
            <div class="rounded-xl bg-white p-4 sm:p-5">
              <h2 id="edit-h" class="text-xl font-semibold">{{ data().name }}{{ isLive() ? " (live)" : "" }}</h2>
              <p class="mt-1 text-sm text-ink-soft">{{ data().description }}</p>
            </div>

            <div class="rounded-xl bg-white p-4 sm:p-5">
              <h3 class="mb-3 font-semibold">Colour preset</h3>
              <div class="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Colour preset">
                @for (p of presets(); track p.id) {
                  <button type="button" role="radio" [attr.aria-checked]="draft().preset === p.id" [attr.data-testid]="'preset-' + p.id"
                    (click)="update({ preset: p.id, colors: { ...p.colors } })"
                    [class]="draft().preset === p.id ? 'flex items-center gap-3 rounded-lg border-2 px-3 py-2 text-left border-peacock bg-peacock-light' : 'flex items-center gap-3 rounded-lg border-2 px-3 py-2 text-left border-line hover:border-peacock/50'">
                    <pc-swatches [colors]="p.colors" size="md" />
                    <span class="text-sm font-medium">{{ p.name }}</span>
                  </button>
                }
              </div>
            </div>

            <div class="rounded-xl bg-white p-4 sm:p-5">
              <div class="mb-3 flex items-center justify-between gap-2">
                <h3 class="font-semibold">Colours @if (counts().colors > 0) {<span class="text-sm font-normal text-ink-soft">({{ counts().colors }} changed)</span>}</h3>
                @if (counts().colors > 0) {
                  <button type="button" class="flex items-center gap-1 text-sm font-semibold text-peacock hover:underline" (click)="resetColors()">
                    <svg [pcIcon]="RotateCcw" class="h-3.5 w-3.5" /> Reset to the preset
                  </button>
                }
              </div>
              <ul class="flex flex-col divide-y divide-line">
                @for (c of colorRows(); track c.k) {
                  <li class="flex flex-wrap items-center gap-3 py-2.5">
                    <input type="color" [value]="draft().colors[c.k]" [attr.aria-label]="c.label + ' colour'" (input)="setColor(c.k, $any($event.target).value.toUpperCase())"
                      class="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-line bg-white p-1" />
                    <div class="min-w-0 flex-1">
                      <p class="text-sm font-semibold">{{ c.label }}</p>
                      <p class="text-xs text-ink-faint">{{ c.help }}</p>
                    </div>
                    <pc-hex-field [value]="draft().colors[c.k]" [label]="c.label" (valid)="setColor(c.k, $event)" />
                    <span [attr.title]="c.check.ok ? 'Text on this colour is easy to read' : c.check.warning"
                      [class]="c.check.ok ? 'w-16 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold bg-leaf-light text-leaf' : 'w-16 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold bg-marigold-light text-ink'">
                      @if (c.check.ok) {<svg [pcIcon]="Check" class="mr-0.5 inline h-3 w-3" />} @else {<svg [pcIcon]="AlertTriangle" class="mr-0.5 inline h-3 w-3" />}{{ ratio(c.check.ratio) }}
                    </span>
                  </li>
                }
              </ul>
              @if (warnings().length) {
                <ul class="mt-3 flex flex-col gap-1 rounded-lg bg-marigold-light px-3 py-2 text-sm text-ink" role="status">
                  @for (c of warnings(); track c.key) {<li class="flex gap-1.5"><svg [pcIcon]="AlertTriangle" class="mt-0.5 h-4 w-4 shrink-0" />{{ c.warning }}</li>}
                </ul>
              }
            </div>

            <div class="rounded-xl bg-white p-4 sm:p-5">
              <div class="mb-3 flex items-center justify-between gap-2">
                <h3 class="font-semibold">Layout @if (counts().layout > 0) {<span class="text-sm font-normal text-ink-soft">({{ counts().layout }} changed)</span>}</h3>
                @if (counts().layout > 0) {
                  <button type="button" class="flex items-center gap-1 text-sm font-semibold text-peacock hover:underline" (click)="update({ layout: {} })">
                    <svg [pcIcon]="RotateCcw" class="h-3.5 w-3.5" /> Use {{ data().name }}'s layout
                  </button>
                }
              </div>
              <div class="flex flex-col gap-3">
                @for (k of layoutKeys; track k) {<fieldset pcLayoutRow [k]="k" [id]="editing()" [draft]="draft()" (layoutChange)="update({ layout: $event })"></fieldset>}
              </div>
            </div>
          </div>

          <div class="flex min-w-0 flex-col gap-3 xl:sticky xl:top-24 xl:self-start">
            <div class="overflow-hidden rounded-xl bg-white ring-1 ring-line">
              <div pcThemeMock [theme]="theme()" [brand]="site()!.brand_name" [classicRadius]="site()!.radius" size="large"></div>
            </div>
            <p class="text-center text-xs text-ink-faint">A sketch of the home page. Use Live preview to see the real shop.</p>
          </div>
        </section>

        <!-- the actions stay in reach while the long editor scrolls -->
        <div class="sticky bottom-2 z-20 flex flex-col gap-2">
          <pc-error-note [message]="error()" />
          <div class="flex flex-wrap items-center gap-2 rounded-xl bg-white/95 p-3 shadow-[0_-4px_20px_rgba(16,24,40,0.12)] ring-1 ring-line backdrop-blur">
            <p class="mr-auto min-w-0 text-sm">
              <span class="font-semibold">{{ data().name }}</span>
              <span class="text-ink-soft"> · {{ draftPreset() }}{{ dirty() ? " · unsaved changes" : isLive() ? " · live" : "" }}</span>
            </p>
            @if (dirty()) {<button pcButton variant="ghost" (click)="discard()">Discard</button>}
            <button pcButton variant="secondary" (click)="preview.set(true)" data-testid="theme-preview-open"><svg [pcIcon]="Eye" class="h-4 w-4" /> Live preview</button>
            @if (!isLive() && dirty()) {<button pcButton variant="secondary" [loading]="busy()" (click)="save(live())">Save without using it</button>}
            <button pcButton [loading]="busy()" [disabled]="isLive() && !dirty()" (click)="isLive() ? save(live()) : confirm.set(true)" data-testid="theme-apply">{{ applyLabel() }}</button>
          </div>
        </div>

        @if (confirm()) {
          <div class="fixed inset-0 z-[70] flex items-center justify-center bg-ink/60 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-h">
            <div class="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
              <h2 id="confirm-h" class="text-xl font-semibold">Use {{ data().name }} for the shop?</h2>
              <p class="mt-2 text-ink-soft">Shoppers see {{ data().name }} with {{ draftPreset() }} right away. {{ themes[live()].name }} keeps its settings, so you can switch back at any time.</p>
              <div class="mt-4 flex justify-end gap-2">
                <button pcButton variant="ghost" (click)="confirm.set(false)">Cancel</button>
                <button pcButton [loading]="busy()" (click)="save(editing())" data-testid="theme-apply-confirm">Use {{ data().name }}</button>
              </div>
            </div>
          </div>
        }
        @if (preview()) {
          <pc-theme-preview-window [id]="editing()" [draft]="draft()" [applyLabel]="applyLabel()" (close)="closePreview()" (apply)="applyFromPreview()" />
        }
      </div>
    }
  `,
})
export class ThemeEditor {
  private readonly toast = inject(Toast);
  private readonly themeService = inject(ThemeService);
  protected readonly Check = Check;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly RotateCcw = RotateCcw;
  protected readonly Eye = Eye;
  protected readonly themes = THEMES;
  protected readonly layoutKeys = LAYOUT_KEYS;
  protected readonly ratio = ratioText;

  protected readonly site = signal<PickerSite | null>(null);
  protected readonly editing = signal<ThemeId>("classic");
  private readonly drafts = signal<Partial<Record<ThemeId, Draft>>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirm = signal(false);
  protected readonly preview = signal(false);

  protected readonly live = computed<ThemeId>(() => {
    const s = this.site();
    return s && (s.theme as ThemeId) in THEMES ? (s.theme as ThemeId) : "classic";
  });
  protected readonly brand = computed(() => this.site()?.colors);
  private draftOf(id: ThemeId): Draft | null {
    const site = this.site();
    return site ? this.drafts()[id] ?? savedDraft(site, id) : null;
  }
  private readonly dirtyIds = computed(() => {
    const site = this.site();
    const brand = this.brand();
    const drafts = this.drafts();
    return site && brand ? THEME_LIST.map((t) => t.id).filter((id) => drafts[id] && differs(id, drafts[id]!, savedDraft(site, id), brand)) : [];
  });
  protected readonly liveTheme = computed(() => draftTheme(this.site()!, this.live(), savedDraft(this.site()!, this.live())));
  protected readonly livePreset = computed(() => presetName(THEMES[this.live()], savedDraft(this.site()!, this.live()).preset));
  protected readonly gallery = computed(() => THEME_LIST.map((data) => ({
    data, selected: data.id === this.editing(), dirty: this.dirtyIds().includes(data.id), theme: draftTheme(this.site()!, data.id, this.draftOf(data.id)!),
  })));
  protected readonly draft = computed(() => this.draftOf(this.editing())!);
  protected readonly theme = computed(() => draftTheme(this.site()!, this.editing(), this.draft()));
  protected readonly data = computed(() => THEMES[this.editing()]);
  private readonly checks = computed(() => colorChecks(this.draft().colors, this.theme().ink.ink));
  protected readonly colorRows = computed(() => EDITABLE_COLORS.map((k) => ({ k, ...COLOR_LABELS[k], check: this.checks().find((c) => c.key === k)! })));
  protected readonly warnings = computed(() => this.checks().filter((c) => !c.ok));
  protected readonly counts = computed(() => changeCounts(this.editing(), this.draft(), this.brand()!));
  protected readonly dirty = computed(() => this.dirtyIds().includes(this.editing()));
  protected readonly isLive = computed(() => this.editing() === this.live());
  protected readonly presets = computed(() => presetsFor(this.data(), this.brand()!));
  protected readonly draftPreset = computed(() => presetName(this.data(), this.draft().preset));
  protected readonly applyLabel = computed(() => (this.isLive() ? "Save changes" : `Use ${this.data().name}`));

  constructor() {
    api<PickerSite>("/api/admin/storefront/site").then((s) => { this.site.set(s); this.editing.set((s.theme as ThemeId) in THEMES ? (s.theme as ThemeId) : "classic"); }).catch(quietly);
    const warn = (e: BeforeUnloadEvent) => { if (this.dirtyIds().length) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    inject(DestroyRef).onDestroy(() => window.removeEventListener("beforeunload", warn));
  }

  protected update(d: Partial<Draft>): void {
    const id = this.editing();
    const draft = this.draft();
    this.drafts.update((all) => ({ ...all, [id]: { ...draft, ...d } }));
  }

  protected setColor(k: EditableColor, v: string): void {
    this.update({ colors: { ...this.draft().colors, [k]: v } });
  }

  protected resetColors(): void {
    this.update({ colors: { ...this.presets().find((p) => p.id === this.draft().preset)!.colors } });
  }

  protected discard(): void {
    const id = this.editing();
    this.drafts.update((all) => { const next = { ...all }; delete next[id]; return next; });
  }

  protected closePreview(): void {
    this.preview.set(false);
    // the preview cookie is for this browser: clear it so the admin's own shop tabs show the live theme again
    const secure = location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${PREVIEW_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
    this.themeService.refreshPreview();
  }

  protected applyFromPreview(): void {
    this.closePreview();
    if (this.isLive()) void this.save(this.live());
    else this.confirm.set(true);
  }

  protected async save(switchTo: ThemeId): Promise<void> {
    const site = this.site();
    const brand = this.brand();
    if (!site || !brand) return;
    const editing = this.editing();
    const draft = this.draft();
    const live = this.live();
    const isLive = this.isLive();
    const data = this.data();
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<ThemeSaved>("/api/admin/storefront/theme", {
        method: "PUT", body: { theme: switchTo, settings: { [editing]: toSetting(editing, draft, brand) } },
      });
      this.site.set({ ...site, theme: r.theme, theme_settings: r.theme_settings });
      this.drafts.update((all) => { const next = { ...all }; delete next[editing]; return next; });
      this.confirm.set(false);
      this.toast.show(switchTo !== live ? `The shop now uses ${THEMES[switchTo].name}.` : isLive ? "Saved. Shoppers see the change now." : `${data.name} saved. The shop still uses ${THEMES[live].name}.`);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save the theme");
    } finally {
      this.busy.set(false);
    }
  }
}
