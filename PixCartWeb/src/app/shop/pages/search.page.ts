/* Search results. Port of frontend/src/app/(shop)/search/page.tsx (the title "Search" is set on the route). */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { SearchView } from "../browse/search-view";

@Component({
  selector: "pc-shop-search-page",
  imports: [SearchView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-search-view />`,
})
export class ShopSearchPage {}
