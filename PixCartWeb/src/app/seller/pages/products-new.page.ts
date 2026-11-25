/* A new listing. Port of frontend/src/app/seller/products/new/page.tsx. */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ProductEditor } from "../shared/product-editor";

@Component({
  selector: "pc-seller-products-new-page",
  imports: [ProductEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `<pc-product-editor />`,
})
export class SellerProductsNewPage {}
