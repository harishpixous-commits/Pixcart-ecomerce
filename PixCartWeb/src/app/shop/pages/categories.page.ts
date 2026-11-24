import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { api } from "../../core/api";
import type { CategoryNode } from "../../core/types";
import { CategoryIcon } from "../../shared/chrome/category-icon";

@Component({
  selector: "pc-shop-categories-page",
  imports: [RouterLink, CategoryIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div class="flex flex-col gap-3">
      <h1 class="px-1 text-2xl font-semibold">All categories</h1>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        @for (category of categories(); track category.slug) {
          <section class="rounded-xl bg-white p-4">
            <a [routerLink]="['/c', category.slug]" class="flex items-center gap-3">
              <span class="flex h-11 w-11 items-center justify-center rounded-full bg-peacock-light text-peacock">
                <svg [pcCategoryIcon]="category.slug" class="h-6 w-6"></svg>
              </span>
              <span class="font-display text-lg font-semibold">{{ category.name }}</span>
              <span class="ml-auto text-sm text-ink-faint">{{ category.product_count }}</span>
            </a>
            @if (category.children.length > 0) {
              <ul class="mt-3 flex flex-wrap gap-2">
                @for (child of category.children; track child.slug) {
                  <li>
                    <a [routerLink]="['/c', child.slug]" class="inline-block rounded-full bg-mist px-3 py-1 text-sm hover:bg-peacock-light hover:text-peacock">{{ child.name }}</a>
                  </li>
                }
              </ul>
            }
          </section>
        }
      </div>
    </div>
  `,
})
export class ShopCategoriesPage {
  readonly categories = signal<CategoryNode[]>([]);

  constructor() {
    // The reference server page treats a catalog failure as an empty category list.
    void api<CategoryNode[]>("/api/catalog/categories").then(
      (categories) => this.categories.set(categories),
      () => this.categories.set([]),
    );
  }
}
