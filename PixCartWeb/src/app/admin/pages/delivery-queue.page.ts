/* Placeholder for frontend/src/app/admin/delivery/queue/page.tsx. The module that owns this page replaces this component (keep the file and class name). */

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { PageHeader } from "../../shared/portal-shell";

@Component({
  selector: "pc-admin-delivery-queue-page",
  imports: [PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <pc-page-header title="Delivery queue" sub="Reference: frontend/src/app/admin/delivery/queue/page.tsx" />
    <div class="rounded-xl bg-white p-6 text-ink-soft" data-testid="placeholder-page">This page is ported by its module.</div>
  `,
})
export class AdminDeliveryQueuePage {}
