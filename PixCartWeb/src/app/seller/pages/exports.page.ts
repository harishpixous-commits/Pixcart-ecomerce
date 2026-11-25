/* Seller reports and exports. Port of frontend/src/app/seller/exports/page.tsx. */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ExportCenter } from "../../shared/portal/export-center";

@Component({
  selector: "pc-seller-exports-page",
  imports: [ExportCenter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `<pc-export-center base="/api/seller/exports" title="Reports and exports" sub="Download your orders, GST line items for GSTR-1, returns, statement and stock as CSV." />`,
})
export class SellerExportsPage {}
