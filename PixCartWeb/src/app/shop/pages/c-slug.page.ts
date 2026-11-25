/* A category's products: the search view for one category. Port of frontend/src/app/(shop)/c/[slug]/page.tsx. */

import { ChangeDetectionStrategy, Component, effect, input } from "@angular/core";
import { setPageTitle } from "../../core/brand";
import { SearchView } from "../browse/search-view";

@Component({
  selector: "pc-shop-c-slug-page",
  imports: [SearchView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-search-view [category]="slug()" />`,
})
export class ShopCSlugPage {
  readonly slug = input.required<string>();
  constructor() {
    effect(() => {
      const name = this.slug().replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      setPageTitle(`${name} online`);
    });
  }
}
