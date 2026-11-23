/*
 * Compare products: shoppers tick "Compare" on product cards or the product page (up to 4, kept in this browser), a tray
 * at the bottom shows the picks, and /compare puts them side by side. Switched on or off in Admin → Product page.
 * Port of components/compare.tsx: useCompare() → inject(CompareService), <pc-compare-toggle [item]>, <pc-compare-tray>.
 */

import { ChangeDetectionStrategy, Component, Injectable, computed, effect, inject, input, signal } from "@angular/core";
import { Scale, X } from "lucide-angular";
import { RouteState } from "../../core/route-state";
import { SiteService } from "../../core/site";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";
import { PcLink } from "../ui/link";

export type CompareItem = { id: string; slug: string; title: string; image: string };

const KEY = "pc_compare_v1";
export const COMPARE_MAX = 4;
const EMPTY = "[]";

function readRaw(): string {
  try {
    return localStorage.getItem(KEY) ?? EMPTY;
  } catch {
    return EMPTY;
  }
}

function parse(raw: string): CompareItem[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

@Injectable({ providedIn: "root" })
export class CompareService {
  private readonly lists = inject(SiteService).lists;
  private readonly raw = signal(readRaw());
  readonly max = computed(() => this.lists().compare_max);
  readonly items = computed(() => parse(this.raw()).slice(0, this.max()));
  readonly full = computed(() => this.items().length >= this.max());

  constructor() {
    window.addEventListener("storage", (e) => { if (e.key === KEY) this.raw.set(readRaw()); });
  }

  private write(items: CompareItem[], max = COMPARE_MAX) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items.slice(0, max)));
    } catch {
      /* private mode */
    }
    this.raw.set(readRaw());
  }

  has(id: string): boolean {
    return this.items().some((x) => x.id === id);
  }
  toggle(item: CompareItem): void {
    const cur = parse(readRaw());
    const max = this.max();
    this.write(cur.some((x) => x.id === item.id) ? cur.filter((x) => x.id !== item.id) : [...cur, item].slice(-max), max);
  }
  remove(id: string): void {
    this.write(parse(readRaw()).filter((x) => x.id !== id));
  }
  clear(): void {
    this.write([]);
  }
}

/** A small "Compare" checkbox for a product card or the product page. */
@Component({
  selector: "pc-compare-toggle",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (site().features.compare !== false) {
      <label [class]="cls()" data-testid="compare-toggle">
        <input type="checkbox" class="h-3.5 w-3.5 accent-peacock" [checked]="on()" [disabled]="!on() && c.full()" (change)="c.toggle(item())" [attr.aria-label]="'Compare ' + item().title" />
        {{ on() ? "Added to compare" : c.full() ? "Compare (max " + c.max() + ")" : "Add to compare" }}
      </label>
    }
  `,
})
export class CompareToggle {
  readonly item = input.required<CompareItem>();
  readonly extra = input<string>("", { alias: "toggleClass" });
  protected readonly site = inject(SiteService).site;
  protected readonly c = inject(CompareService);
  protected readonly on = computed(() => this.c.items().some((x) => x.id === this.item().id));
  protected readonly cls = computed(() => cx("inline-flex cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-ink-soft", this.extra()));
}

/** The tray at the bottom of the store while products are picked for comparison. */
@Component({
  selector: "pc-compare-tray",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (visible()) {
      <div class="compare-tray fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-30 border-t border-line bg-white/95 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur sm:bottom-0"
        role="region" aria-label="Products to compare" data-testid="compare-tray">
        <div class="mx-auto flex max-w-shop items-center gap-3 px-3 py-2 sm:px-4">
          <svg [pcIcon]="Scale" class="hidden h-5 w-5 shrink-0 text-peacock sm:block" />
          <div class="scroll-x flex min-w-0 flex-1 gap-2 overflow-x-auto">
            @for (x of c.items(); track x.id) {
              <span class="relative flex shrink-0 items-center gap-2 rounded-lg border border-line bg-white py-1 pl-1 pr-6">
                <img [src]="x.image" alt="" class="h-9 w-9 rounded object-contain" />
                <span class="hidden max-w-[140px] truncate text-xs md:block">{{ x.title }}</span>
                <button type="button" (click)="c.remove(x.id)" [attr.aria-label]="'Remove ' + x.title + ' from compare'" class="absolute right-1 top-1 rounded-full p-0.5 hover:bg-mist">
                  <svg [pcIcon]="X" class="h-3.5 w-3.5" />
                </button>
              </span>
            }
          </div>
          <button type="button" (click)="c.clear()" class="shrink-0 text-sm text-ink-soft hover:text-vermilion">Clear</button>
          <a [pcLink]="'/compare?ids=' + ids()" [attr.aria-disabled]="c.items().length < 2"
            [class]="c.items().length < 2 ? 'shrink-0 rounded-full px-4 py-2 text-sm font-semibold pointer-events-none bg-mist text-ink-faint' : 'shrink-0 rounded-full px-4 py-2 text-sm font-semibold bg-peacock text-white hover:bg-peacock-dark'">
            Compare ({{ c.items().length }})
          </a>
        </div>
      </div>
    }
  `,
})
export class CompareTray {
  protected readonly c = inject(CompareService);
  private readonly site = inject(SiteService).site;
  private readonly path = inject(RouteState).pathname;
  protected readonly Scale = Scale;
  protected readonly X = X;
  protected readonly visible = computed(() => this.site().features.compare !== false && this.c.items().length > 0 && !this.path().startsWith("/compare"));
  protected readonly ids = computed(() => this.c.items().map((x) => x.id).join(","));

  constructor() {
    // lets the help button move up so the tray never covers it (see globals.css)
    effect((onCleanup) => {
      if (!this.visible()) return;
      document.body.dataset["compareTray"] = "1";
      onCleanup(() => { delete document.body.dataset["compareTray"]; });
    });
  }
}
