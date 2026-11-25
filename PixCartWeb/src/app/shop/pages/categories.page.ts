/* All categories: a card per department with its sub-categories. Port of frontend/src/app/(shop)/categories/page.tsx. */

import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { api } from "../../core/api";
import type { CategoryNode } from "../../core/types";
import { CategoryIcon } from "../../shared/chrome/category-icon";
import { PcLink } from "../../shared/ui/link";
import { ShopRouteSkeleton } from "../../shared/ui/skeletons";

@Component({
  selector: "pc-shop-categories-page",
  imports: [CategoryIcon, PcLink, ShopRouteSkeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (cats(); as list) {
      <div class="flex flex-col gap-3">
        <h1 class="px-1 text-2xl font-semibold">All categories</h1>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          @for (c of list; track c.slug) {
            <section class="rounded-xl bg-white p-4">
              <a [pcLink]="'/c/' + c.slug" class="flex items-center gap-3">
                <span class="flex h-11 w-11 items-center justify-center rounded-full bg-peacock-light text-peacock">
                  <svg [pcCategoryIcon]="c.slug" class="h-6 w-6" />
                </span>
                <span class="font-display text-lg font-semibold">{{ c.name }}</span>
                <span class="ml-auto text-sm text-ink-faint">{{ c.product_count }}</span>
              </a>
              @if (c.children.length > 0) {
                <ul class="mt-3 flex flex-wrap gap-2">
                  @for (s of c.children; track s.slug) {
                    <li>
                      <a [pcLink]="'/c/' + s.slug" class="inline-block rounded-full bg-mist px-3 py-1 text-sm hover:bg-peacock-light hover:text-peacock">{{ s.name }}</a>
                    </li>
                  }
                </ul>
              }
            </section>
          }
        </div>
      </div>
    } @else {
      <pc-shop-route-skeleton />
    }
  `,
})
export class ShopCategoriesPage {
  protected readonly cats = signal<CategoryNode[] | null>(null);
  constructor() {
    api<CategoryNode[]>("/api/catalog/categories").then((c) => this.cats.set(c)).catch(() => this.cats.set([]));
  }
}
