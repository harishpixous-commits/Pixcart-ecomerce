/*
 * While a page loads its data: a skeleton in the shape of the page (after a short delay, so quick loads show nothing),
 * never a blank screen or a lone spinner. Pick the shape closest to what is coming. Port of PageLoader in components/ui.tsx:
 * <pc-page-loader variant="page|list|table|detail|form|grid" />.
 */

import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { DetailSkeleton, FormSkeleton, ListSkeleton, PageSkeleton, ProductGridSkeleton, TableSkeleton } from "./skeletons";

@Component({
  selector: "pc-page-loader",
  imports: [DetailSkeleton, FormSkeleton, ListSkeleton, PageSkeleton, ProductGridSkeleton, TableSkeleton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @switch (variant()) {
      @case ("list") {<pc-list-skeleton [title]="true" />}
      @case ("table") {<pc-table-skeleton />}
      @case ("detail") {<pc-detail-skeleton />}
      @case ("form") {<pc-form-skeleton [narrow]="true" />}
      @case ("grid") {<pc-product-grid-skeleton />}
      @default {<pc-page-skeleton />}
    }
  `,
})
export class PageLoader {
  readonly variant = input<"page" | "list" | "table" | "detail" | "form" | "grid">("page");
}
