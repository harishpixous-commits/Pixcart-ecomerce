/* Coupons shoppers can use at checkout. Port of frontend/src/app/(shop)/coupons/page.tsx. */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { Check, Copy, Store, Tag } from "lucide-angular";
import { api, quietly } from "../../core/api";
import { date, rupees } from "../../core/format";
import { Icon } from "../../shared/ui/icon";
import { PcLink } from "../../shared/ui/link";
import { Toast } from "../../shared/ui/ui";

type CouponItem = {
  code: string; title: string; terms: string; description: string; source: "platform" | "seller"; seller: string; category: string;
  shop_link: string; min_order_paise: number; first_order_only: boolean; ends_at: string | null;
};

const FILTERS = [["all", "All offers"], ["platform", "Store offers"], ["seller", "Seller offers"]] as const;

@Component({
  selector: "pc-shop-coupons-page",
  imports: [Icon, PcLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <div class="flex flex-col gap-4">
      <header class="rounded-xl bg-white p-4 sm:p-6">
        <h1 class="flex items-center gap-2 text-2xl font-semibold sm:text-3xl"><svg [pcIcon]="Tag" class="h-7 w-7 text-vermilion" /> Coupons</h1>
        <p class="text-ink-soft">Copy a code and apply it at checkout. Store offers work across sellers; seller offers work on that seller's products.</p>
        <div class="mt-3 flex gap-2">
          @for (f of FILTERS; track f[0]) {
            <button type="button" (click)="filter.set(f[0])" [attr.aria-pressed]="filter() === f[0]"
              [class]="filter() === f[0] ? 'rounded-full border px-4 py-1.5 text-sm font-semibold border-peacock bg-peacock text-white' : 'rounded-full border px-4 py-1.5 text-sm font-semibold border-line hover:border-peacock'">{{ f[1] }}</button>
          }
        </div>
      </header>
      @if (!data()) {
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">@for (i of SK; track i) {<div class="skeleton h-44 rounded-xl"></div>}</div>
      } @else if (!data()!.enabled || items().length === 0) {
        <div class="rounded-xl bg-white p-8 text-center">
          <p class="text-lg font-semibold">{{ data()!.enabled ? "No coupons right now" : "Coupons are not available right now" }}</p>
          <p class="mt-1 text-ink-soft">Today's deals still have great prices.</p>
          <a pcLink="/deals" class="mt-3 inline-block rounded-full bg-peacock px-5 py-2 font-semibold text-white">See today's deals</a>
        </div>
      } @else {
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="coupons">
          @for (c of items(); track c.code) {
            <article class="relative flex flex-col gap-2 overflow-hidden rounded-xl border-2 border-dashed border-peacock/30 bg-white p-4">
              <span [class]="c.source === 'seller' ? 'self-start rounded-full px-2.5 py-0.5 text-xs font-semibold bg-marigold-light text-ink' : 'self-start rounded-full px-2.5 py-0.5 text-xs font-semibold bg-peacock-light text-peacock'">
                @if (c.source === "seller") {<span class="inline-flex items-center gap-1"><svg [pcIcon]="Store" class="h-3 w-3" /> Seller offer: {{ c.seller }}</span>} @else {Store offer}
              </span>
              <p class="font-display text-2xl font-bold leading-tight">{{ c.title }}</p>
              <p class="text-sm text-ink-soft">{{ c.description || c.terms || "On eligible products" }}</p>
              <ul class="flex flex-wrap gap-1.5 text-xs text-ink-soft">
                @if (c.min_order_paise > 0) {<li class="rounded bg-mist px-2 py-0.5">Min. order {{ rupees(c.min_order_paise) }}</li>}
                @if (c.first_order_only) {<li class="rounded bg-mist px-2 py-0.5">First order only</li>}
                @if (c.category) {<li class="rounded bg-mist px-2 py-0.5">{{ c.category }}</li>}
                @if (c.ends_at) {<li class="rounded bg-vermilion-light px-2 py-0.5 text-vermilion">Ends {{ date(c.ends_at) }}</li>}
              </ul>
              <div class="mt-auto flex items-center gap-2 pt-2">
                <button type="button" (click)="copy(c.code)" [attr.aria-label]="'Copy code ' + c.code"
                  class="flex flex-1 items-center justify-between rounded-lg border border-dashed border-peacock bg-peacock-light px-3 py-2 font-mono font-semibold text-peacock hover:bg-peacock hover:text-white">
                  {{ c.code }}<svg [pcIcon]="copied() === c.code ? Check : Copy" class="h-4 w-4" />
                </button>
                <a [pcLink]="c.shop_link" class="rounded-lg bg-marigold px-3 py-2 text-sm font-semibold text-ink hover:bg-marigold-dark">Shop now</a>
              </div>
            </article>
          }
        </div>
      }
    </div>
  `,
})
export class ShopCouponsPage {
  private readonly toast = inject(Toast);
  protected readonly Tag = Tag;
  protected readonly Store = Store;
  protected readonly Check = Check;
  protected readonly Copy = Copy;
  protected readonly FILTERS = FILTERS;
  protected readonly SK = [0, 1, 2, 3, 4, 5];
  protected readonly rupees = rupees;
  protected readonly date = date;
  protected readonly data = signal<{ items: CouponItem[]; enabled: boolean } | null>(null);
  protected readonly filter = signal<"all" | "platform" | "seller">("all");
  protected readonly copied = signal("");
  protected readonly items = computed(() => (this.data()?.items ?? []).filter((c) => this.filter() === "all" || c.source === this.filter()));

  constructor() {
    api<{ items: CouponItem[]; enabled: boolean }>("/api/catalog/coupons").then((d) => this.data.set(d)).catch(quietly);
  }

  protected async copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* the code is visible anyway */
    }
    this.copied.set(code);
    this.toast.show(`Code ${code} copied. Apply it at checkout.`);
    setTimeout(() => this.copied.set(""), 2500);
  }
}
