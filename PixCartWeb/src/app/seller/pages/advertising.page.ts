/* Placeholder for frontend/src/app/seller/advertising/page.tsx. The module that owns this page replaces this component (keep the file and class name). */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { PageHeader } from "../../shared/portal-shell";

@Component({
  selector: "pc-seller-advertising-page",
  imports: [PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Advertising" sub="Reference: frontend/src/app/seller/advertising/page.tsx" />
    <div class="rounded-xl bg-white p-6 text-ink-soft" data-testid="placeholder-page">This page is ported by its module.</div>
  `,
})
export class SellerAdvertisingPage {}
