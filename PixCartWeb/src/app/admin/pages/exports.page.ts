/* Admin → Exports: every CSV/Excel export the admin can download. Port of frontend/src/app/admin/exports/page.tsx. */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ExportCenter } from "../../shared/portal/export-center";

@Component({
  selector: "pc-admin-exports-page",
  imports: [ExportCenter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `<pc-export-center base="/api/admin/exports" title="Exports" sub="Download orders, GST lines, returns, payouts, catalogue and more as CSV for your accountant or your own analysis." />`,
})
export class AdminExportsPage {}
