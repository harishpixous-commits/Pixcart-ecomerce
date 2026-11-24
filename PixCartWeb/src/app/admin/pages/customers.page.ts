/* Placeholder for frontend/src/app/admin/customers/page.tsx. The module that owns this page replaces this component (keep the file and class name). */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { PageHeader } from "../../shared/portal-shell";

@Component({
  selector: "pc-admin-customers-page",
  imports: [PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Customers" sub="Reference: frontend/src/app/admin/customers/page.tsx" />
    <div class="rounded-xl bg-white p-6 text-ink-soft" data-testid="placeholder-page">This page is ported by its module.</div>
  `,
})
export class AdminCustomersPage {}
